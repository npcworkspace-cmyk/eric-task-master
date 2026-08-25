import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CLI = path.resolve('src/cli.mjs');

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function parseLastJsonLine(stdout) {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

test('CLI safely stages and installs a single-file task module from outside the project', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-cli-module-'));
  const stateDir = path.join(root, 'state');
  const sourcePath = path.join(root, 'external-task.mjs');
  const port = await unusedPort();
  let managerStarted = false;
  t.after(async () => {
    if (managerStarted) {
      await execFileAsync(process.execPath, [
        CLI, 'manager', 'stop', '--state-dir', stateDir, '--port', String(port), '--json'
      ], { windowsHide: true, timeout: 60_000 });
    }
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(sourcePath, [
    'export const meta = { name: "external-fixture", inputSchema: { type: "object" } };',
    'export async function run() { return { summary: "ok", evidence: [] }; }',
    ''
  ].join('\n'));

  const installedRun = await execFileAsync(process.execPath, [
    CLI,
    'task-types', 'install',
    '--type', 'external-fixture',
    '--module', sourcePath,
    '--state-dir', stateDir,
    '--port', String(port),
    '--json'
  ], { windowsHide: true, timeout: 30_000 });
  managerStarted = true;
  const installed = parseLastJsonLine(installedRun.stdout);
  assert.equal(installed.ok, true);
  assert.equal(installed.taskType.name, 'external-fixture');

  const repeatedRun = await execFileAsync(process.execPath, [
    CLI,
    'task-types', 'install',
    '--type', 'external-fixture',
    '--module', sourcePath,
    '--state-dir', stateDir,
    '--port', String(port),
    '--json'
  ], { windowsHide: true, timeout: 30_000 });
  assert.equal(parseLastJsonLine(repeatedRun.stdout).taskType.sha256, installed.taskType.sha256);

  await writeFile(sourcePath, [
    'export const meta = { name: "external-fixture", version: "2" };',
    'export async function run() { return { summary: "changed", evidence: [] }; }',
    ''
  ].join('\n'));
  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI,
      'task-types', 'install',
      '--type', 'external-fixture',
      '--module', sourcePath,
      '--state-dir', stateDir,
      '--port', String(port),
      '--json'
    ], { windowsHide: true, timeout: 30_000 }),
    (error) => parseLastJsonLine(error.stderr).error.code === 'TASK_TYPE_CONFLICT'
  );

  const inboxFiles = await readdir(path.join(stateDir, 'task-inbox'));
  assert.equal(inboxFiles.length, 2);
  assert.ok(inboxFiles.every((file) => /^[a-f0-9]{64}\.mjs$/.test(file)));
  const inboxSources = await Promise.all(inboxFiles.map((file) => (
    readFile(path.join(stateDir, 'task-inbox', file), 'utf8')
  )));
  assert.ok(inboxSources.includes(await readFile(sourcePath, 'utf8')));

  const listRun = await execFileAsync(process.execPath, [
    CLI, 'task-types', 'list', '--agent-id', 'task-module-author', '--agent-name', 'Task module author',
    '--state-dir', stateDir, '--port', String(port), '--json'
  ], { windowsHide: true, timeout: 15_000 });
  const listed = parseLastJsonLine(listRun.stdout);
  assert.ok(listed.taskTypes.some((item) => item.name === 'external-fixture'));
  assert.equal(JSON.stringify(listed).includes(sourcePath), false);
});
