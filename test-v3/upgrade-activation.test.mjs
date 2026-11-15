import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { VERSION } from '../src/contracts.mjs';
import { removeTestTree } from './test-fs.mjs';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function fixture(t, port) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-activation-'));
  const skill = path.join(root, 'agent', 'eric-task-master');
  const state = path.join(root, 'state');
  await mkdir(path.join(skill, 'scripts'), { recursive: true });
  await mkdir(state);
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: eric-task-master\nmetadata: { version: "4.0.1" }\n---\nold\n');
  await writeFile(path.join(skill, 'LICENSE'), 'old license');
  await writeFile(path.join(skill, 'scripts', 'find-launcher.ps1'), 'old locator');
  const common = ['--state-dir', state, '--port', String(port), '--json'];
  const cli = (args, extraEnvironment = {}) => execute(process.execPath, [CLI, ...args, ...common], {
    cwd: ROOT, windowsHide: true, timeout: 45_000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', ERIC_TASK_MASTER_SKILL_DIR: skill,
      ERIC_TASK_MASTER_AGENT_ID: 'fixture-agent-a', ERIC_TASK_MASTER_AGENT_SKILL_VERSION: '4.0.1', ...extraEnvironment }
  });
  t.after(async () => {
    await cli(['manager', 'stop', '--if-idle']).catch(() => {});
    await removeTestTree(root);
  });
  return { root, skill, state, cli };
}

test('each Agent must reload the automatically refreshed Skill before it can start work', { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, await availablePort());
  await assert.rejects(f.cli(['run', 'unused.mjs', '--detach']), (error) => {
    const result = JSON.parse(error.stderr.trim());
    assert.equal(result.error.code, 'AGENT_SKILL_REFRESH_REQUIRED');
    assert.match(result.nextAction, /not executed/u);
    return true;
  });
  assert.match(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), new RegExp(`version: "${VERSION.replaceAll('.', '\\.')}"`, 'u'));
  const before = JSON.parse((await f.cli(['status'])).stdout.trim());
  assert.equal(before.tasks.total, 0, 'the rejected Agent request did not create a task');
  await assert.rejects(f.cli(['ops', 'start', '--input', '{}'], { ERIC_TASK_MASTER_AGENT_ID: 'fixture-agent-b' }), (error) => {
    assert.equal(JSON.parse(error.stderr.trim()).error.code, 'AGENT_SKILL_REFRESH_REQUIRED');
    return true;
  });
  const loaded = { ERIC_TASK_MASTER_AGENT_SKILL_VERSION: VERSION };
  assert.equal(JSON.parse((await f.cli(['profiles', 'create', 'Agent A'], loaded)).stdout.trim()).profile.name, 'Agent A');
  await assert.rejects(f.cli(['profiles', 'create', 'Agent B'], { ERIC_TASK_MASTER_AGENT_ID: 'fixture-agent-b' }), (error) => {
    assert.equal(JSON.parse(error.stderr.trim()).error.code, 'AGENT_SKILL_REFRESH_REQUIRED');
    return true;
  });
  assert.equal(JSON.parse((await f.cli(['profiles', 'create', 'Agent B'], { ...loaded, ERIC_TASK_MASTER_AGENT_ID: 'fixture-agent-b' })).stdout.trim()).profile.name, 'Agent B');
});

test('new Manager activation proactively synchronizes the selected Skill before reporting ready', { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, await availablePort());
  const upgraded = JSON.parse((await f.cli(['manager', 'start', '--upgrade'])).stdout.trim());
  assert.equal(upgraded.manager.version, VERSION);
  assert.ok(['replaced', 'current'].includes(upgraded.skill.state));
  assert.equal(upgraded.skill.version, VERSION);
  const backupRoot = path.join(path.dirname(f.skill), 'eric-task-master-skill-backups');
  const backups = await readdir(backupRoot);
  assert.equal(backups.length, 1);
  assert.match(await readFile(path.join(backupRoot, backups[0], 'SKILL.md'), 'utf8'), /4\.0\.1/u);
  assert.match(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), new RegExp(`version: "${VERSION.replaceAll('.', '\\.')}"`, 'u'));
  const status = JSON.parse((await f.cli(['manager', 'status'])).stdout.trim());
  assert.equal(status.manager.version, VERSION);
  assert.equal(status.manager.state, 'ready');
});

test('an older busy Manager asks for an explicit choice; a current Manager refreshes Skill without stopping work', async (t) => {
  const requests = [];
  let running = 1;
  let profiles = [];
  let managerVersion = '4.0.1';
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') response.end(JSON.stringify({ service: 'eric-task-master', version: managerVersion, apiVersion: 3, capabilities: ['manager.idle-stop'] }));
    else if (request.url === '/v1/status') response.end(JSON.stringify({ ok: true, tasks: { running, queued: 0 } }));
    else if (request.url === '/v1/profiles') response.end(JSON.stringify({ ok: true, profiles }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const f = await fixture(t, server.address().port);
  await writeFile(path.join(f.state, 'config.json'), JSON.stringify({ managerToken: 'fixture-token-'.repeat(4) }));
  await assert.rejects(f.cli(['manager', 'start', '--upgrade']), (error) => {
    assert.equal(JSON.parse(error.stderr.trim()).error.code, 'MANAGER_UPGRADE_DECISION_REQUIRED');
    return true;
  });
  assert.match(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /4\.0\.1/u);
  running = 0;
  profiles = [{ id: 'profile_open', state: 'open', lease: { kind: 'manual' } }];
  await assert.rejects(f.cli(['manager', 'start', '--upgrade']), (error) => {
    assert.equal(JSON.parse(error.stderr.trim()).error.code, 'MANAGER_UPGRADE_DECISION_REQUIRED');
    return true;
  });
  assert.match(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), /4\.0\.1/u);
  managerVersion = VERSION;
  running = 1;
  profiles = [];
  const synced = JSON.parse((await f.cli(['manager', 'start', '--upgrade'])).stdout.trim());
  assert.equal(synced.skill.state, 'replaced');
  assert.match(await readFile(path.join(f.skill, 'SKILL.md'), 'utf8'), new RegExp(`version: "${VERSION.replaceAll('.', '\\.')}"`, 'u'));
  assert.equal(requests.some((request) => request.includes('/v1/manager/stop')), false);
});
