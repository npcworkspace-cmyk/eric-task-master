import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

function playwrightCacheRoot() {
  let candidate = path.dirname(chromium.executablePath());
  while (path.dirname(candidate) !== candidate) {
    if (/^chromium-\d+$/.test(path.basename(candidate))) return path.dirname(candidate);
    candidate = path.dirname(candidate);
  }
  throw new Error('Playwright Chromium cache root could not be determined');
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function parseSingleJson(run) {
  assert.equal(run.code, 0, run.stderr || run.stdout);
  const lines = run.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected one JSON result, received: ${run.stdout}`);
  return JSON.parse(lines[0]);
}

test('one fixed connect command accepts, registers, caches, and leaves no browser Profile open', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 180_000
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-connect-flow-'));
  const home = path.join(root, 'fake-home');
  const stateDir = path.join(root, 'manager-state');
  const registrationState = path.join(root, 'registration-state');
  const codexHome = path.join(home, '.codex');
  const port = await freePort();
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, 'config.toml'), 'model = "fixture"\n', 'utf8');
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(home, 'claude-code'),
    HERMES_HOME: path.join(home, 'hermes'),
    WORKBUDDY_HOME: path.join(home, 'workbuddy'),
    PLAYWRIGHT_BROWSERS_PATH: playwrightCacheRoot(),
    PATH: ''
  };
  const common = [
    '--json', '--port', String(port), '--state-dir', stateDir,
    '--home', home, '--registration-state-dir', registrationState
  ];

  t.after(async () => {
    await runCli(['manager', 'stop', '--json', '--port', String(port), '--state-dir', stateDir], env).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const first = parseSingleJson(await runCli(['connect', ...common], env));
  assert.equal(first.ok, true);
  assert.equal(first.manager.startedNow, true);
  assert.equal(first.acceptance.passed, 30);
  assert.equal(first.acceptance.total, 30);
  assert.equal(first.acceptance.cached, undefined);
  assert.match(first.dashboard, new RegExp(`^http://127\\.0\\.0\\.1:${port}/dashboard#code=`));
  assert.equal(first.dashboard.toLowerCase().includes('token'), false);
  assert.equal(first.mcpRegistration.results.filter((item) => item.status === 'registered_pending_restart').length, 1);
  assert.match(first.nextAction, /mcpRegistration\.results/u);
  assert.match(first.nextAction, /needs_adapter/u);
  assert.match(first.nextAction, /--agent-id STABLE_ID/u);
  assert.match(first.acceptance.nextAction, /top-level nextAction/u);
  assert.match(first.acceptance.nextAction, /stable Agent identity/u);

  const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.eric-task-master\]/);
  assert.match(config, /stdio\.mjs/);
  assert.match(config, /mcp/);

  const second = parseSingleJson(await runCli(['connect', ...common], env));
  assert.equal(second.ok, true);
  assert.equal(second.manager.startedNow, false);
  assert.equal(second.acceptance.cached, true);
  assert.equal(second.mcpRegistration.changed, false);
  assert.equal(second.mcpRegistration.results.filter((item) => item.status === 'registered').length, 1);

  const profiles = parseSingleJson(await runCli([
    'profiles', 'list', '--agent-id', 'connect-flow-agent', '--agent-name', 'Connect flow Agent',
    '--json', '--port', String(port), '--state-dir', stateDir
  ], env));
  assert.deepEqual(profiles.profiles, []);

  const stopped = parseSingleJson(await runCli([
    'manager', 'stop', '--json', '--port', String(port), '--state-dir', stateDir
  ], env));
  assert.equal(stopped.stopped, true);
});
