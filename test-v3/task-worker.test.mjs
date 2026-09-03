import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTestTree } from './test-fs.mjs';
import { runTaskWorker } from '../src/runtime/task-worker.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('one-file worker can bare-import Playwright and use raw runtime helpers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-worker-'));
  t.after(() => removeTestTree(root));
  const outputDir = path.join(root, 'output');
  await mkdir(outputDir);
  await symlink(
    path.join(PROJECT_ROOT, 'node_modules'),
    path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const modulePath = path.join(root, 'job.mjs');
  await writeFile(modulePath, `
    import { chromium } from 'playwright';
    import { writeFile } from 'node:fs/promises';
    import path from 'node:path';
    export async function run({ input, outputDir, progress, wait, page }) {
      await progress({ current: 1, total: 2, message: 'working' });
      await wait({ reason: 'bounded delay', resumeAfterMs: 5 });
      await writeFile(path.join(outputDir, 'result.json'), JSON.stringify({ value: input.value }));
      return { value: input.value, playwrightAvailable: Boolean(chromium), pageAvailable: Boolean(page) };
    }
  `);

  let closed = false;
  const page = { isClosed: () => false, screenshot: async () => {} };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    browser: () => ({ type: 'fake' }),
    close: async () => { closed = true; }
  };
  const fakePlaywright = {
    chromium: { launchPersistentContext: async () => context }
  };
  const result = await runTaskWorker({
    taskId: 'task_worker_test',
    modulePath,
    profile: { userDataDir: path.join(root, 'profile') },
    input: { value: 42 },
    outputDir,
    outputBudget: {},
    timeoutMs: 5_000
  }, { loadPlaywright: async () => fakePlaywright });

  assert.deepEqual(result, {
    state: 'finished',
    result: { value: 42, playwrightAvailable: true, pageAvailable: true }
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(outputDir, 'result.json'), 'utf8')), { value: 42 });
  assert.equal(closed, true);
});

test('one-file worker also accepts a default exported task function', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-default-worker-'));
  t.after(() => removeTestTree(root));
  const outputDir = path.join(root, 'output');
  await mkdir(outputDir);
  const modulePath = path.join(root, 'job.mjs');
  await writeFile(modulePath, `
    export default async function ({ input, page }) {
      return {
        value: input.value,
        pageAvailable: Boolean(page),
        items: Array.from({ length: 1001 }, (_, index) => index)
      };
    }
  `);
  const page = { isClosed: () => false, screenshot: async () => {} };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    browser: () => null,
    close: async () => {}
  };
  const result = await runTaskWorker({
    taskId: 'task_default_export',
    modulePath,
    profile: { userDataDir: path.join(root, 'profile') },
    input: { value: 7 },
    outputDir,
    outputBudget: {},
    timeoutMs: 5_000
  }, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => context } })
  });
  assert.equal(result.state, 'finished');
  assert.equal(result.result.value, 7);
  assert.equal(result.result.pageAvailable, true);
  assert.equal(result.result.items.length, 1_001);
  assert.deepEqual(result.result.items.at(-1), {
    __taskMasterTruncated: { kind: 'array', includedItems: 1_000, omittedItems: 1 }
  });
});

test('worker returns bounded structured errors and redacts their secrets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-error-worker-'));
  t.after(() => removeTestTree(root));
  const outputDir = path.join(root, 'output');
  await mkdir(outputDir);
  const modulePath = path.join(root, 'job.mjs');
  const secret = 'WORKER_SECRET_909f6a';
  await writeFile(modulePath, `
    export async function run() {
      throw Object.assign(new Error('The upstream operation failed'), {
        code: 'UPSTREAM_REJECTED',
        details: { stage: 'navigate', apiKey: '${secret}' },
        nextAction: 'Retry after token=${secret}'
      });
    }
  `);
  const page = { isClosed: () => false, screenshot: async () => {} };
  const context = {
    pages: () => [page],
    newPage: async () => page,
    browser: () => null,
    close: async () => {}
  };
  const result = await runTaskWorker({
    taskId: 'task_structured_error',
    modulePath,
    profile: { userDataDir: path.join(root, 'profile') },
    input: {},
    outputDir,
    outputBudget: {},
    timeoutMs: 5_000
  }, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => context } })
  });
  assert.equal(result.state, 'error');
  assert.equal(result.error.code, 'UPSTREAM_REJECTED');
  assert.deepEqual(result.error.details, { stage: 'navigate' });
  assert.equal(result.error.nextAction, 'Retry after token=[REDACTED]');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('failure capture falls back to raw CDP and tries another live page', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-error-capture-'));
  t.after(() => removeTestTree(root));
  const outputDir = path.join(root, 'output');
  await mkdir(outputDir);
  const modulePath = path.join(root, 'job.mjs');
  await writeFile(modulePath, `
    export async function run() {
      throw Object.assign(new Error('capture me'), { code: 'CAPTURE_TEST' });
    }
  `);
  const closedPage = { isClosed: () => true };
  const livePage = {
    isClosed: () => false,
    screenshot: async () => { throw new Error('high-level screenshot unavailable'); }
  };
  let detached = false;
  const context = {
    pages: () => [closedPage, livePage],
    newPage: async () => livePage,
    browser: () => null,
    newCDPSession: async (page) => {
      assert.equal(page, livePage);
      return {
        send: async (method) => {
          assert.equal(method, 'Page.captureScreenshot');
          return { data: Buffer.from('png-via-cdp').toString('base64') };
        },
        detach: async () => { detached = true; }
      };
    },
    close: async () => {}
  };
  const result = await runTaskWorker({
    taskId: 'task_capture_fallback',
    modulePath,
    profile: { userDataDir: path.join(root, 'profile') },
    input: {},
    outputDir,
    outputBudget: {},
    timeoutMs: 5_000
  }, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => context } })
  });
  assert.equal(result.state, 'error');
  assert.equal(result.error.code, 'CAPTURE_TEST');
  assert.equal(result.error.screenshot, 'failure.png');
  assert.equal(await readFile(path.join(outputDir, 'failure.png'), 'utf8'), 'png-via-cdp');
  assert.equal(detached, true);
});

test('Chrome launch failures preserve a bounded underlying cause', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-launch-error-'));
  t.after(() => removeTestTree(root));
  const outputDir = path.join(root, 'output');
  await mkdir(outputDir);
  const modulePath = path.join(root, 'job.mjs');
  await writeFile(modulePath, 'export default async function () { return true; }\n');
  const result = await runTaskWorker({
    taskId: 'task_launch_error',
    modulePath,
    profile: { userDataDir: path.join(root, 'profile') },
    input: {},
    outputDir,
    outputBudget: {},
    timeoutMs: 5_000
  }, {
    loadPlaywright: async () => ({
      chromium: {
        launchPersistentContext: async () => {
          throw Object.assign(new Error('spawn failed'), { code: 'EACCES' });
        }
      }
    })
  });
  assert.equal(result.state, 'error');
  assert.equal(result.error.code, 'CHROME_LAUNCH_FAILED');
  assert.deepEqual(result.error.cause, { code: 'EACCES', message: 'spawn failed' });
});
