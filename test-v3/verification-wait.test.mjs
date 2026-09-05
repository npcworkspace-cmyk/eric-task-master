import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { runTaskWorker, resumeTaskWorker, acknowledgeTaskWorkerResume } from '../src/runtime/task-worker.mjs';
import { removeTestTree } from './test-fs.mjs';

const PROBE_INTERVAL_MS = 5 * 60_000;
const CLOCK_START = 1_750_000_000_000;
const SCREENSHOT = Buffer.from('fake-verification-png');
const TASK_SOURCE = `
  export async function run({ input, wait, emit, signal, context }) {
    const delay = (ms) => new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal.addEventListener('abort', abort, { once: true });
    });
    if (input.beforeMs) {
      await emit({ phase: 'before-delay' });
      await delay(input.beforeMs);
    }
    const results = [];
    for (const options of input.waits ?? [{ reason: 'verification' }]) {
      const value = await wait({ ...options,
        ...(input.targetPage === undefined ? {} : { page: context.pages()[input.targetPage] })
      });
      results.push(value);
      await emit({ phase: 'continued', value });
    }
    if (input.afterMs) await delay(input.afterMs);
    return results;
  }
`;

async function eventually(predicate, label) {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${label}`);
    await nextTurn();
  }
}

async function fixture(t, {
  input = {}, timeoutMs = null, screenshot, newCDPSession, workerOptions = {}, pageCount = 1,
  outputBudget = {}, diagnosticFiles = [], outputFiles = []
} = {}) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const root = await mkdtemp(path.join(temporaryRoot, 'taskmaster-verification-'));
  let controller;
  let running;
  let done = false;
  t.after(async () => {
    controller?.abort();
    if (running) {
      await eventually(() => done, 'worker cleanup');
      await running;
    }
    t.mock.timers.reset();
    const relative = path.relative(temporaryRoot, path.resolve(root));
    assert.ok(relative.startsWith('taskmaster-verification-') && !relative.includes(path.sep),
      'cleanup must remain inside the newly created temporary directory');
    await removeTestTree(root);
  });
  const modulePath = path.join(root, 'job.mjs');
  await writeFile(modulePath, TASK_SOURCE);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: CLOCK_START });
  const messages = [];
  const captures = [];
  let closeCount = 0;
  let cdpAttempts = 0;
  const closedPages = new Set();
  const pages = Array.from({ length: pageCount }, (_, pageIndex) => ({
    isClosed: () => closeCount > 0 || closedPages.has(pageIndex),
    screenshot: async (options) => {
      captures.push({ at: Date.now(), options, pageIndex });
      return screenshot ? screenshot(options) : SCREENSHOT;
    }
  }));
  const context = {
    pages: () => pages,
    newPage: async () => pages[0],
    browser: () => ({ fake: true }),
    newCDPSession: async (targetPage) => {
      cdpAttempts += 1;
      if (newCDPSession) return newCDPSession(targetPage);
      throw new Error('fake CDP screenshot unavailable');
    },
    close: async () => { closeCount += 1; }
  };
  controller = new AbortController();
  const outputDir = path.join(root, 'output');
  if (outputFiles.length) {
    await mkdir(outputDir);
    for (const [index, bytes] of outputFiles.entries()) {
      await writeFile(path.join(outputDir, `existing-${index}.txt`), bytes);
    }
  }
  if (diagnosticFiles.length) {
    await mkdir(path.join(outputDir, 'screenshots'), { recursive: true });
    for (const [index, bytes] of diagnosticFiles.entries()) {
      await writeFile(path.join(outputDir, 'screenshots', `${CLOCK_START}-existing-${index}.png`), bytes);
    }
  }
  running = runTaskWorker({
    taskId: path.basename(root), modulePath, outputDir, input,
    profile: { userDataDir: path.join(root, 'profile') }, outputBudget, timeoutMs
  }, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => context } }),
    sendMessage: (message) => messages.push(message), signal: controller.signal, ...workerOptions
  }).finally(() => { done = true; });
  const state = {
    root, outputDir, controller, running, messages, captures,
    closePage: (pageIndex) => closedPages.add(pageIndex),
    get done() { return done; },
    get closeCount() { return closeCount; },
    get cdpAttempts() { return cdpAttempts; },
    get waits() { return messages.filter((message) => message.type === 'waiting').map((message) => message.waiting); },
    get probes() { return messages.filter((message) => message.event?.type === 'verification.probe').map((message) => message.event); },
    get pauses() { return messages.filter((message) => message.event?.type === 'verification.paused').map((message) => message.event); },
    get heartbeats() { return messages.filter((message) => message.type === 'heartbeat'); },
    get continued() { return messages.filter((message) => message.event?.phase === 'continued'); }
  };
  await eventually(() => input.beforeMs
    ? messages.some((message) => message.event?.phase === 'before-delay')
    : state.waits.length > 0 || done, 'task startup');
  await nextTurn();
  return state;
}

async function probe(t, state, number) {
  t.mock.timers.tick(PROBE_INTERVAL_MS);
  await eventually(() => state.probes.length === number, `verification probe ${number}`);
  return state.probes.at(-1);
}

test('verification probes at 5/10/15/20 minutes, then pauses automatically with Chrome and heartbeat alive', async (t) => {
  const state = await fixture(t);
  const waiting = state.waits[0];
  assert.equal(waiting.kind, 'verification');
  assert.equal(waiting.probeIntervalMs, PROBE_INTERVAL_MS);
  assert.equal(waiting.maximumProbes, 4);
  assert.equal(waiting.automaticPaused, false);
  assert.equal(waiting.pauseAfterMs, 4 * PROBE_INTERVAL_MS);
  assert.equal(Date.parse(waiting.pauseAt), CLOCK_START + 4 * PROBE_INTERVAL_MS);
  assert.equal(Date.parse(waiting.nextProbeAt), CLOCK_START + PROBE_INTERVAL_MS);
  for (let number = 1; number <= 4; number += 1) {
    const event = await probe(t, state, number);
    assert.equal(event.waitId, waiting.id);
    assert.equal(event.probe, number);
    assert.equal(event.maximumProbes, 4);
    assert.equal(event.needsAgentDecision, number < 4);
    assert.equal(event.automaticProbesComplete, number === 4);
    assert.equal(state.captures[number - 1].at, CLOCK_START + number * PROBE_INTERVAL_MS);
    assert.equal(event.nextProbeAt, number === 4 ? null
      : new Date(CLOCK_START + (number + 1) * PROBE_INTERVAL_MS).toISOString());
    assert.equal(event.screenshotPath, path.join(state.outputDir, event.screenshot));
    assert.deepEqual(await readFile(event.screenshotPath), SCREENSHOT);
  }
  assert.equal(new Set(state.probes.map((event) => event.probeId)).size, 4);
  assert.equal(state.pauses.length, 1);
  assert.equal(state.pauses[0].waitId, waiting.id);
  assert.equal(state.pauses[0].automaticPaused, true);
  assert.equal(Date.parse(state.pauses[0].pausedAt), CLOCK_START + 4 * PROBE_INTERVAL_MS);
  const heartbeats = state.heartbeats.length;
  t.mock.timers.tick(2 * PROBE_INTERVAL_MS);
  await nextTurn();
  assert.equal(state.probes.length, 4, 'no fifth probe without an Agent decision');
  assert.equal(state.captures.length, 4);
  assert.ok(state.heartbeats.length > heartbeats);
  assert.equal(state.done, false);
  assert.equal(state.closeCount, 0);
  assert.equal(state.continued.length, 0);
  assert.equal(state.messages.some((message) => message.type === 'resumed'), false);
});

test('failed verification screenshots remain unknown and never finish or resume the task', async (t) => {
  const state = await fixture(t, { screenshot: async () => { throw new Error('capture unavailable'); } });
  for (let number = 1; number <= 4; number += 1) {
    const event = await probe(t, state, number);
    assert.equal(event.screenshot, null);
    assert.equal(event.screenshotPath, null);
    assert.equal(event.needsAgentDecision, number < 4);
  }
  assert.equal(state.cdpAttempts, 4);
  assert.equal(state.done, false);
  assert.equal(state.closeCount, 0);
  assert.equal(state.continued.length, 0);
  const last = state.probes.at(-1);
  assert.equal(resumeTaskWorker({ verified: true }, { waitId: last.waitId, probeId: last.probeId }), false);
  assert.equal(resumeTaskWorker({ verified: true }, { waitId: last.waitId }), true);
  assert.deepEqual(await state.running, { state: 'finished', result: [{ verified: true }] });
});

for (const targetPage of [undefined, 1]) {
  test(`verification captures ${targetPage === undefined ? 'the original runtime page' : 'the explicitly selected page'}, not the newest unrelated tab`, async (t) => {
    const state = await fixture(t, { input: { targetPage }, pageCount: 3 });
    const event = await probe(t, state, 1);
    assert.ok(event.screenshot);
    assert.deepEqual(state.captures.map((capture) => capture.pageIndex), [targetPage ?? 0]);
    assert.equal(state.closeCount, 0);
    assert.equal(state.continued.length, 0);
  });
}

test('a closed verification target produces an unknown screenshot without switching to another tab', async (t) => {
  const state = await fixture(t, { input: { targetPage: 1 }, pageCount: 3 });
  state.closePage(1);
  const event = await probe(t, state, 1);
  assert.equal(event.screenshot, null);
  assert.equal(event.screenshotPath, null);
  assert.equal(state.captures.length, 0);
  assert.equal(state.cdpAttempts, 0);
  assert.equal(state.done, false);
  assert.equal(state.closeCount, 0);
});

test('an exhausted diagnostic reserve yields four unknown probes without exiting or resuming', async (t) => {
  const state = await fixture(t, {
    outputBudget: { diagnosticReserveFiles: 1, diagnosticReserveBytes: SCREENSHOT.length },
    diagnosticFiles: [SCREENSHOT]
  });
  for (let number = 1; number <= 4; number += 1) {
    const event = await probe(t, state, number);
    assert.equal(event.screenshot, null);
    assert.equal(event.screenshotPath, null);
    assert.equal(event.needsAgentDecision, number < 4);
  }
  assert.equal(state.captures.length, 0);
  assert.equal(state.done, false);
  assert.equal(state.closeCount, 0);
  assert.equal(state.continued.length, 0);
  assert.deepEqual(await readFile(path.join(state.outputDir, 'screenshots', `${CLOCK_START}-existing-0.png`)), SCREENSHOT);
});

test('a full output entry budget never creates a screenshot directory or kills the waiting worker', async (t) => {
  const state = await fixture(t, {
    outputBudget: { maxFiles: 1, maxEntries: 1 }, outputFiles: ['preserved task output']
  });
  for (let number = 1; number <= 4; number += 1) {
    const event = await probe(t, state, number);
    assert.equal(event.screenshot, null);
    assert.equal(event.screenshotPath, null);
    assert.deepEqual(await readdir(state.outputDir), ['existing-0.txt']);
    assert.equal(state.done, false);
  }
  const heartbeats = state.heartbeats.length;
  t.mock.timers.tick(PROBE_INTERVAL_MS);
  await nextTurn();
  assert.deepEqual(await readdir(state.outputDir), ['existing-0.txt']);
  assert.equal(await readFile(path.join(state.outputDir, 'existing-0.txt'), 'utf8'), 'preserved task output');
  assert.equal(state.captures.length, 0);
  assert.equal(state.probes.length, 4);
  assert.ok(state.heartbeats.length > heartbeats);
  assert.equal(state.done, false);
  assert.equal(state.closeCount, 0);
  assert.equal(state.continued.length, 0);
  assert.equal(state.messages.some((message) => message.type === 'error'), false);
});

test('a CDP session arriving after screenshot timeout detaches once without sending a request', async (t) => {
  let finishSession;
  let detachCount = 0;
  let sendCount = 0;
  const state = await fixture(t, {
    screenshot: async () => { throw new Error('Playwright screenshot unavailable'); },
    newCDPSession: () => new Promise((resolve) => { finishSession = resolve; })
  });
  t.mock.timers.tick(PROBE_INTERVAL_MS);
  await eventually(() => finishSession, 'delayed CDP session');
  t.mock.timers.tick(10_000);
  await eventually(() => state.probes.length === 1, 'timed-out screenshot probe');
  assert.equal(state.probes[0].screenshot, null);
  finishSession({
    send: async () => { sendCount += 1; return { data: SCREENSHOT.toString('base64') }; },
    detach: async () => { detachCount += 1; }
  });
  await eventually(() => detachCount === 1, 'late CDP session detach');
  await nextTurn();
  assert.equal(sendCount, 0);
  assert.equal(state.done, false);
  assert.equal(state.closeCount, 0);
  assert.equal(state.continued.length, 0);
  state.controller.abort();
  assert.equal((await state.running).state, 'stopped');
  assert.equal(detachCount, 1);
  assert.equal(sendCount, 0);
  assert.equal(state.closeCount, 1);
});

for (const resumeAtProbe of [1, 4]) {
  test(`an explicit matching resume after probe ${resumeAtProbe} continues exactly once`, async (t) => {
    const state = await fixture(t);
    for (let number = 1; number <= resumeAtProbe; number += 1) await probe(t, state, number);
    const last = state.probes.at(-1);
    assert.equal(resumeTaskWorker('verified', {
      waitId: last.waitId, ...(resumeAtProbe < 4 ? { probeId: last.probeId } : {})
    }), true);
    assert.deepEqual(await state.running, { state: 'finished', result: ['verified'] });
    assert.equal(state.continued.length, 1);
    assert.equal(state.closeCount, 1);
    assert.equal(resumeTaskWorker('duplicate', { waitId: last.waitId, probeId: last.probeId }), false);
    const heartbeatCount = state.heartbeats.length;
    t.mock.timers.tick(2 * PROBE_INTERVAL_MS);
    assert.equal(state.probes.length, resumeAtProbe);
    assert.equal(state.captures.length, resumeAtProbe);
    assert.equal(state.heartbeats.length, heartbeatCount);
  });
}

test('stale wait and probe IDs cannot resume the current verification wait', async (t) => {
  const state = await fixture(t, { input: { waits: [{ reason: 'verification' }, { reason: 'verification' }] } });
  const first = await probe(t, state, 1);
  const second = await probe(t, state, 2);
  assert.equal(resumeTaskWorker('stale-probe', { waitId: second.waitId, probeId: first.probeId }), false);
  assert.equal(resumeTaskWorker('stale-wait', { waitId: 'wait_obsolete', probeId: second.probeId }), false);
  assert.equal(state.continued.length, 0);
  assert.equal(resumeTaskWorker('first', { waitId: second.waitId, probeId: second.probeId }), true);
  await eventually(() => state.waits.length === 2, 'second verification wait');
  await nextTurn();
  assert.notEqual(state.waits[1].id, first.waitId);
  assert.equal(resumeTaskWorker('old-wait', { waitId: first.waitId, probeId: second.probeId }), false);
  assert.equal(resumeTaskWorker('old-probe', { waitId: state.waits[1].id, probeId: second.probeId }), false);
  assert.equal(state.continued.length, 1);
  assert.equal(resumeTaskWorker('second', { waitId: state.waits[1].id }), true);
  assert.deepEqual(await state.running, { state: 'finished', result: ['first', 'second'] });
});

test('the last published probe remains resumable while the next screenshot is pending', async (t) => {
  let captureNumber = 0;
  let finishScreenshot;
  const state = await fixture(t, { screenshot: () => {
    captureNumber += 1;
    if (captureNumber === 2) return new Promise((resolve) => { finishScreenshot = resolve; });
    return SCREENSHOT;
  } });
  const first = await probe(t, state, 1);
  t.mock.timers.tick(PROBE_INTERVAL_MS);
  await eventually(() => finishScreenshot, 'second screenshot startup');
  assert.equal(state.probes.length, 1);
  assert.equal(resumeTaskWorker('cleared', { waitId: first.waitId, probeId: first.probeId }), true);
  finishScreenshot(SCREENSHOT);
  assert.deepEqual(await state.running, { state: 'finished', result: ['cleared'] });
  assert.equal(state.probes.length, 1, 'resuming invalidates the unfinished observation');
  assert.equal(state.continued.length, 1);
});

test('the 20-minute pause is emitted while the final screenshot is still pending', async (t) => {
  let captureNumber = 0;
  let finishScreenshot;
  const state = await fixture(t, { screenshot: () => {
    captureNumber += 1;
    if (captureNumber === 4) return new Promise((resolve) => { finishScreenshot = resolve; });
    return SCREENSHOT;
  } });
  for (let number = 1; number <= 3; number += 1) await probe(t, state, number);
  const lastPublished = state.probes.at(-1);
  t.mock.timers.tick(PROBE_INTERVAL_MS);
  await eventually(() => finishScreenshot, 'fourth screenshot startup');
  assert.equal(state.probes.length, 3);
  assert.equal(state.pauses.length, 1);
  assert.equal(state.closeCount, 0);
  const acknowledgements = [];
  assert.equal(acknowledgeTaskWorkerResume({
    requestId: 'request_after_pause', waitId: lastPublished.waitId, probeId: lastPublished.probeId
  }, (message) => acknowledgements.push(message)), false);
  assert.equal(acknowledgements[0].reason, 'TASK_VERIFICATION_PAUSED');
  finishScreenshot(SCREENSHOT);
  await eventually(() => state.probes.length === 4, 'fourth diagnostic publication');
  assert.equal(state.probes[3].needsAgentDecision, false);
  assert.equal(state.probes[3].automaticPaused, true);
  assert.equal(acknowledgeTaskWorkerResume({
    requestId: 'manual_resume', waitId: lastPublished.waitId, value: 'manual'
  }, (message) => acknowledgements.push(message)), true);
  assert.deepEqual(acknowledgements[1], {
    type: 'resume_ack', requestId: 'manual_resume', accepted: true, waitId: lastPublished.waitId
  });
  assert.deepEqual(await state.running, { state: 'finished', result: ['manual'] });
  assert.equal(state.messages.filter((message) => message.type === 'resumed').length, 1);
});

test('resume acknowledgements distinguish stale commands from accepted execution', async (t) => {
  const state = await fixture(t);
  const first = await probe(t, state, 1);
  const acknowledgements = [];
  const ack = (message) => acknowledgements.push(message);
  assert.equal(acknowledgeTaskWorkerResume({ requestId: 'bad_wait', waitId: 'obsolete' }, ack), false);
  assert.equal(acknowledgements.at(-1).reason, 'TASK_WAIT_MISMATCH');
  assert.equal(acknowledgeTaskWorkerResume({
    requestId: 'bad_probe', waitId: first.waitId, probeId: 'obsolete'
  }, ack), false);
  assert.equal(acknowledgements.at(-1).reason, 'TASK_PROBE_MISMATCH');
  assert.equal(acknowledgeTaskWorkerResume({
    requestId: 'accepted', waitId: first.waitId, probeId: first.probeId, value: 'go'
  }, ack), true);
  assert.equal(acknowledgements.at(-1).accepted, true);
  assert.equal(acknowledgeTaskWorkerResume({ requestId: 'duplicate', waitId: first.waitId }, ack), false);
  assert.equal(acknowledgements.at(-1).reason, 'TASK_NOT_WAITING');
  assert.deepEqual(await state.running, { state: 'finished', result: ['go'] });
  assert.equal(state.continued.length, 1);
});

test('stop cancels verification, closes Chrome, and prevents all later probes and heartbeats', async (t) => {
  const state = await fixture(t);
  const first = await probe(t, state, 1);
  state.controller.abort();
  const result = await state.running;
  assert.equal(result.state, 'stopped');
  assert.equal(result.error.code, 'TASK_STOPPED');
  assert.equal(state.closeCount, 1);
  const heartbeatCount = state.heartbeats.length;
  t.mock.timers.tick(4 * PROBE_INTERVAL_MS);
  await nextTurn();
  assert.equal(state.captures.length, 1);
  assert.equal(state.probes.length, 1);
  assert.equal(state.heartbeats.length, heartbeatCount);
  assert.equal(state.continued.length, 0);
  assert.equal(resumeTaskWorker(null, { waitId: first.waitId, probeId: first.probeId }), false);
});

test('stop during an in-flight screenshot publishes no late probe and does not resume', async (t) => {
  let finishScreenshot;
  const state = await fixture(t, { screenshot: () => new Promise((resolve) => { finishScreenshot = resolve; }) });
  t.mock.timers.tick(PROBE_INTERVAL_MS);
  await eventually(() => finishScreenshot, 'in-flight screenshot');
  state.controller.abort();
  assert.equal((await state.running).state, 'stopped');
  finishScreenshot(SCREENSHOT);
  await nextTurn();
  t.mock.timers.tick(4 * PROBE_INTERVAL_MS);
  await nextTurn();
  assert.equal(state.probes.length, 0);
  assert.equal(state.continued.length, 0);
  assert.equal(state.cdpAttempts, 0, 'an aborted capture must not start CDP fallback');
  assert.equal(state.closeCount, 1);
});

test('verification freezes timeout and restores only the unspent execution budget', async (t) => {
  const state = await fixture(t, { timeoutMs: 1_000, input: { beforeMs: 300, afterMs: 900 } });
  t.mock.timers.tick(300);
  await eventually(() => state.waits.length === 1, 'verification wait after active execution');
  await nextTurn();
  for (let number = 1; number <= 4; number += 1) await probe(t, state, number);
  assert.equal(state.done, false, 'verification time must not consume the timeout');
  const last = state.probes.at(-1);
  assert.equal(resumeTaskWorker(true, { waitId: last.waitId }), true);
  await eventually(() => state.continued.length === 1, 'execution after verification');
  await nextTurn();
  t.mock.timers.tick(699);
  await nextTurn();
  assert.equal(state.done, false);
  t.mock.timers.tick(1);
  const result = await state.running;
  assert.equal(result.state, 'error');
  assert.equal(result.error.code, 'TASK_TIMEOUT');
  assert.equal(state.closeCount, 1);
});

test('a task without timeout can resume after verification and continue untimed work', async (t) => {
  const state = await fixture(t, { input: { afterMs: 2 * PROBE_INTERVAL_MS } });
  await probe(t, state, 1);
  assert.equal(resumeTaskWorker('done', { waitId: state.waits[0].id }), true);
  await eventually(() => state.continued.length === 1, 'untimed resumed work');
  await nextTurn();
  t.mock.timers.tick(2 * PROBE_INTERVAL_MS);
  assert.deepEqual(await state.running, { state: 'finished', result: ['done'] });
  assert.equal(state.probes.length, 1);
});

test('ordinary timed waits still resume automatically and do not schedule verification probes', async (t) => {
  const state = await fixture(t, { timeoutMs: 1_000, input: { waits: [{ reason: 'bounded delay', resumeAfterMs: 200 }] } });
  assert.equal(state.waits[0].kind, undefined);
  assert.equal(state.waits[0].resumeAfterMs, 200);
  t.mock.timers.tick(199);
  await nextTurn();
  assert.equal(state.continued.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await state.running, { state: 'finished', result: [null] });
  assert.equal(state.probes.length, 0);
  assert.equal(state.captures.length, 0);
});

test('ordinary manual waits retain their timeout and accept an explicit resume', async (t) => {
  const state = await fixture(t, { timeoutMs: 1_000, input: { waits: [{ reason: 'user choice' }], afterMs: 800 } });
  t.mock.timers.tick(300);
  assert.equal(resumeTaskWorker('choice'), true);
  await eventually(() => state.continued.length === 1, 'ordinary resumed work');
  await nextTurn();
  t.mock.timers.tick(700);
  const result = await state.running;
  assert.equal(result.state, 'error');
  assert.equal(result.error.code, 'TASK_TIMEOUT');
  assert.equal(state.probes.length, 0);
});

test('ordinary waits can time out while waiting and verification cannot override its cadence', async (t) => {
  await t.test('ordinary waiting consumes timeout', async (subtest) => {
    const state = await fixture(subtest, { timeoutMs: 1_000, input: { waits: [{ reason: 'manual' }] } });
    subtest.mock.timers.tick(1_000);
    const result = await state.running;
    assert.equal(result.state, 'error');
    assert.equal(result.error.code, 'TASK_TIMEOUT');
    assert.equal(state.continued.length, 0);
    assert.equal(state.probes.length, 0);
  });
  await t.test('verification does not accept resumeAfterMs', async (subtest) => {
    const state = await fixture(subtest, { input: { waits: [{ reason: 'verification', resumeAfterMs: 1 }] } });
    const result = await state.running;
    assert.equal(result.state, 'error');
    assert.match(result.error.message, /cannot set resumeAfterMs/u);
    assert.equal(state.waits.length, 0);
    assert.equal(state.continued.length, 0);
    assert.equal(state.probes.length, 0);
  });
});
