import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../src/runtime/task-worker.mjs', import.meta.url));

test('real Playwright worker enforces output budget, captures evidence, and exits cleanly', {
  timeout: 30_000
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-real-output-budget-'));
  const modulePath = path.join(root, 'task.mjs');
  const outputDir = path.join(root, 'output');
  const checkpointPath = path.join(root, 'checkpoint.json');
  await writeFile(modulePath, [
    "import { writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    'export async function run({ outputDir, progress }) {',
    "  await writeFile(path.join(outputDir, 'too-large.bin'), Buffer.alloc(4096));",
    "  await progress({ current: 1, total: 1, message: 'must fail at budget gate' });",
    "  return { summary: 'must not complete', evidence: [] };",
    '}',
    ''
  ].join('\n'));

  const child = fork(WORKER, [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true
  });
  let stderr = '';
  let closed = false;
  const messages = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('message', (message) => messages.push(message));
  t.after(async () => {
    if (!closed) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  });

  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  child.send({
    type: 'start',
    config: {
      taskId: 'task_real_output_budget',
      modulePath,
      outputDir,
      checkpointPath,
      input: {},
      behavior: 'fast',
      profile: {
        userDataDir: path.join(root, 'profile'),
        browserEngine: 'chromium',
        headless: true
      },
      heartbeatMs: 1_000,
      timeoutMs: 20_000,
      outputBudget: {
        maxBytes: 1024,
        maxFiles: 10,
        maxEntries: 20,
        maxDepth: 8,
        diagnosticReserveBytes: 4 * 1024 * 1024,
        diagnosticReserveFiles: 2,
        checkIntervalMs: 50
      }
    }
  });

  const terminal = await exited;
  assert.deepEqual(terminal, { code: 0, signal: null }, stderr);
  const error = messages.find((message) => message.type === 'error');
  const cleanup = messages.find((message) => message.type === 'cleanup');
  const screenshot = messages.find((message) => message.type === 'screenshot');
  assert.equal(error?.error?.code, 'TASK_OUTPUT_BUDGET_EXCEEDED');
  assert.equal(cleanup?.browserClosed, true);
  assert.equal(typeof screenshot?.path, 'string');
  await access(screenshot.path);
  assert.equal((await readFile(path.join(outputDir, 'too-large.bin'))).length, 4096);
  assert.equal(messages.some((message) => message.type === 'result'), false);
});
