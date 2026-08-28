import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { link, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationalJournal } from '../src/lib/operational-journal.mjs';

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, '..');
const CLI = join(ROOT, 'src', 'cli.mjs');

test('doctor reports one bounded redacted recovery state without starting a Manager or browser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-doctor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const home = join(root, 'home');
  const journal = new OperationalJournal({ stateDir });
  await journal.append({
    level: 'error',
    component: 'mcp',
    event: 'request.failed',
    method: 'POST',
    pathname: '/v1/tasks?token=LEAK42',
    code: 'TASK_INPUT_SCHEMA_FAILED',
    message: 'Bad field token=LEAK42 C:\\private\\task.json'
  });

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI, 'doctor', '--json', '--port', '19945', '--state-dir', stateDir,
    '--registration-state-dir', join(root, 'registration'), '--home', home
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      WORKBUDDY_HOME: join(home, '.workbuddy'),
      HERMES_HOME: join(home, '.hermes')
    }
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'manager_unavailable');
  assert.equal(result.diagnostics.log, 'logs/manager-events.jsonl');
  assert.equal(result.diagnostics.recentErrors[0].code, 'TASK_INPUT_SCHEMA_FAILED');
  assert.equal(JSON.stringify(result).includes('LEAK42'), false);
  assert.equal(JSON.stringify(result).includes('C:\\private'), false);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.match(result.nextAction, /fixed connect command/u);
});

test('doctor reports an unsafe linked journal without reading or exposing its content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-doctor-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const home = join(root, 'home');
  const logs = join(stateDir, 'logs');
  const outside = join(root, 'outside.jsonl');
  await mkdir(logs, { recursive: true });
  await writeFile(outside, '{"message":"DO_NOT_READ"}\n');
  await link(outside, join(logs, 'manager-events.jsonl'));

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    CLI, 'doctor', '--json', '--port', '19945', '--state-dir', stateDir,
    '--registration-state-dir', join(root, 'registration'), '--home', home
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, '.codex'),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      WORKBUDDY_HOME: join(home, '.workbuddy'),
      HERMES_HOME: join(home, '.hermes')
    }
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.deepEqual(result.diagnostics.recentErrors, []);
  assert.equal(result.diagnostics.error.code, 'OPERATIONAL_JOURNAL_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('DO_NOT_READ'), false);
});
