import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../src/runtime/task-worker.mjs', import.meta.url));
const PLAYWRIGHT_MODULE = new URL('../node_modules/playwright/index.mjs', import.meta.url).href;

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

test('real Worker freezes Locator.prototype before Task import and the action FIFO clicks once', {
  timeout: 30_000
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-playwright-prototype-'));
  const modulePath = path.join(root, 'task.mjs');
  const outputDir = path.join(root, 'output');
  const checkpointPath = path.join(root, 'checkpoint.json');
  const pageUrl = `data:text/html,${encodeURIComponent([
    '<!doctype html>',
    '<html><body data-clicks="0">',
    '<button id="target" onclick="document.body.dataset.clicks = String(Number(document.body.dataset.clicks) + 1)">click</button>',
    '</body></html>'
  ].join(''))}`;
  await writeFile(modulePath, [
    `import { chromium } from ${JSON.stringify(PLAYWRIGHT_MODULE)};`,
    'export async function run({ page, action }) {',
    `  await action.goto(${JSON.stringify(pageUrl)});`,
    '  const rawContext = [...chromium._contexts][0];',
    '  const rawPage = rawContext?.pages()[0];',
    '  const locatorPrototype = Object.getPrototypeOf(rawPage?.locator("#target"));',
    '  const pagePrototype = Object.getPrototypeOf(rawPage);',
    '  const channelOwnerPrototype = Object.getPrototypeOf(pagePrototype);',
    '  const eventEmitterPrototype = Object.getPrototypeOf(channelOwnerPrototype);',
    '  const originalClick = locatorPrototype?.click;',
    '  const originalWrapApiCall = channelOwnerPrototype?._wrapApiCall;',
    '  const originalEmit = eventEmitterPrototype?.emit;',
    '  const wrapApiCallDescriptor = Object.getOwnPropertyDescriptor(channelOwnerPrototype, "_wrapApiCall");',
    '  const emitDescriptor = Object.getOwnPropertyDescriptor(eventEmitterPrototype, "emit");',
    '  const replacement = async () => { throw new Error("prototype replacement executed"); };',
    '  let clickAssignmentFailed = false;',
    '  let inheritedAssignmentFailed = false;',
    '  let emitterAssignmentFailed = false;',
    '  try { locatorPrototype.click = replacement; } catch (error) {',
    '    clickAssignmentFailed = error instanceof TypeError;',
    '  }',
    '  try { channelOwnerPrototype._wrapApiCall = replacement; } catch (error) {',
    '    inheritedAssignmentFailed = error instanceof TypeError;',
    '  }',
    '  try { eventEmitterPrototype.emit = replacement; } catch (error) {',
    '    emitterAssignmentFailed = error instanceof TypeError;',
    '  }',
    '  if (!clickAssignmentFailed || !Object.isFrozen(locatorPrototype) || locatorPrototype.click !== originalClick) {',
    '    throw new Error("Locator.prototype.click was replaceable after Task import");',
    '  }',
    '  if (!inheritedAssignmentFailed || wrapApiCallDescriptor?.writable !== false || wrapApiCallDescriptor?.configurable !== false || channelOwnerPrototype._wrapApiCall !== originalWrapApiCall) {',
    '    throw new Error("ChannelOwner.prototype._wrapApiCall was replaceable after Task import");',
    '  }',
    '  if (!emitterAssignmentFailed || emitDescriptor?.writable !== false || emitDescriptor?.configurable !== false || eventEmitterPrototype.emit !== originalEmit) {',
    '    throw new Error("EventEmitter2.prototype.emit was replaceable after Task import");',
    '  }',
    '  await action.click(page.locator("#target"));',
    '  const clicks = await page.locator("body").getAttribute("data-clicks");',
    '  if (clicks !== "1") throw new Error(`expected one FIFO click, received ${clicks}`);',
    '  return {',
    '    summary: "Playwright prototype guard preserved the action FIFO",',
    '    evidence: [{ kind: "message", value: "Locator frozen; inherited dispatch locked; FIFO clicks=1" }]',
    '  };',
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
      taskId: 'task_playwright_prototype_guard',
      modulePath,
      outputDir,
      checkpointPath,
      input: {},
      behavior: 'fast',
      profile: {
        kind: 'ephemeral',
        userDataDir: path.join(root, 'profile'),
        browserEngine: 'chromium',
        headless: true
      },
      heartbeatMs: 1_000,
      timeoutMs: 20_000
    }
  });

  const terminal = await exited;
  assert.deepEqual(terminal, { code: 0, signal: null }, stderr);
  const error = messages.find((message) => message.type === 'error');
  const result = messages.find((message) => message.type === 'result');
  const cleanup = messages.find((message) => message.type === 'cleanup');
  assert.equal(error, undefined, JSON.stringify(error));
  assert.equal(result?.result?.summary, 'Playwright prototype guard preserved the action FIFO');
  assert.deepEqual(result?.result?.evidence, [{
    kind: 'message',
    value: 'Locator frozen; inherited dispatch locked; FIFO clicks=1'
  }]);
  assert.equal(cleanup?.browserClosed, true);
});
