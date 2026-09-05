import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDesktopNotificationSender, createVerificationNotifier,
  NOTIFICATION_APP_ID, runNotificationCommand
} from '../src/lib/desktop-notifications.mjs';

const BASE = Date.parse('2026-09-05T12:00:00Z');
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

class Clock {
  time = BASE;
  sequence = 0;
  timers = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advance(milliseconds) {
    const end = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()].filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

function task(overrides = {}) {
  return {
    id: 'task_1', name: 'Example', state: 'waiting',
    waiting: { id: 'wait_1', kind: 'verification', startedAt: new Date(BASE).toISOString() },
    ...overrides
  };
}

function setup(extra = {}) {
  const clock = new Clock();
  const sent = [];
  const notifier = createVerificationNotifier({
    now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    notify: (payload) => { sent.push({ at: clock.now() - BASE, ...payload }); }, ...extra
  });
  return { clock, sent, notifier };
}

test('verification sends immediately and every 30 seconds, exactly 40 times before 20 minutes', async () => {
  const { clock, sent, notifier } = setup();
  const current = task();
  notifier.observeTask(current);
  await flush();
  assert.deepEqual(sent.map(({ at }) => at), [0]);
  for (let index = 0; index < 8; index++) notifier.observeTask(current);
  await clock.advance(29_999);
  assert.equal(sent.length, 1);
  await clock.advance(1);
  assert.equal(sent.length, 2);
  await clock.advance(20 * 60_000 - 30_000);
  assert.deepEqual(sent.map(({ at }) => at), Array.from({ length: 40 }, (_, index) => index * 30_000));
  assert.equal(new Set(sent.map(({ tag }) => tag)).size, 1);
  assert.equal(sent.at(-1).expiresAt, new Date(BASE + 20 * 60_000).toISOString());
  assert.equal(clock.timers.size, 0);
  notifier.observeTask(current);
  await clock.advance(10 * 60_000);
  assert.equal(sent.length, 40);
  notifier.close();
});

test('actual resume, automatic pause, stop, deletion and close each cancel reminders', async () => {
  for (const action of ['resume', 'pause', 'stopping', 'stopped', 'finished', 'failed', 'delete', 'close']) {
    const { clock, sent, notifier } = setup();
    const current = task();
    notifier.observeTask(current);
    await flush();
    const staleCallback = [...clock.timers.values()][0].callback;
    if (action === 'delete') notifier.remove(current.id);
    else if (action === 'close') notifier.close();
    else if (action === 'pause') notifier.observeTask({ ...current, waiting: { ...current.waiting, automaticPaused: true } });
    else notifier.observeTask({ ...current, state: action === 'resume' ? 'running' : action });
    staleCallback();
    await clock.advance(25 * 60_000);
    assert.equal(sent.length, 1, action);
    assert.equal(clock.timers.size, 0, action);
  }
});

test('resume request does not stop reminders until execution state actually changes', async () => {
  const { clock, sent, notifier } = setup();
  const current = task();
  notifier.observeTask(current);
  await flush();
  notifier.observeTask({ ...current, resumeRequestedAt: new Date(clock.now()).toISOString() });
  await clock.advance(30_000);
  assert.equal(sent.length, 2);
  notifier.observeTask({ ...current, state: 'running', waiting: null });
  await clock.advance(30_000);
  assert.equal(sent.length, 2);
});

test('a new wait for the same task has a new identity and invalidates old callbacks', async () => {
  const { clock, sent, notifier } = setup();
  const first = task();
  notifier.observeTask(first);
  await flush();
  const staleCallback = [...clock.timers.values()][0].callback;
  await clock.advance(10_000);
  notifier.observeTask(task({ waiting: {
    ...first.waiting, id: 'wait_2', startedAt: new Date(clock.now()).toISOString()
  } }));
  staleCallback();
  await flush();
  assert.deepEqual(sent.map(({ waitId }) => waitId), ['wait_1', 'wait_2']);
  assert.notEqual(sent[0].tag, sent[1].tag);
  await clock.advance(30_000);
  assert.deepEqual(sent.map(({ at }) => at), [0, 10_000, 40_000]);
  notifier.close();
});

test('notification and logging errors never escape and retry only on normal ticks', async () => {
  const attempts = [];
  const errors = [];
  const { clock, notifier } = setup({
    notify: () => { attempts.push(clock.now()); throw new Error('not installed'); },
    onError: (error, metadata) => { errors.push([error.message, metadata]); throw new Error('logger failed'); }
  });
  assert.doesNotThrow(() => notifier.observeTask(task()));
  await flush();
  assert.equal(attempts.length, 1);
  await clock.advance(30_000);
  assert.equal(attempts.length, 2);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors[0][1], { taskId: 'task_1', waitId: 'wait_1' });
  notifier.close();
});

test('a slow sender cannot overlap and cancellation aborts the native command', async () => {
  const sends = [];
  let finish;
  const { clock, notifier } = setup({ notify: (_payload, { signal }) => {
    sends.push(signal);
    return new Promise((resolve) => { finish = resolve; });
  } });
  notifier.observeTask(task());
  await flush();
  await clock.advance(90_000);
  assert.equal(sends.length, 1);
  finish();
  await flush();
  await clock.advance(30_000);
  assert.equal(sends.length, 2);
  notifier.remove('task_1');
  assert.equal(sends[1].aborted, true);
  finish();
  await clock.advance(30_000);
  assert.equal(sends.length, 2);
});

test('a cancelled wait cannot start its pending first notification', async () => {
  const { sent, notifier, clock } = setup();
  notifier.observeTask(task());
  notifier.remove('task_1');
  await flush();
  assert.equal(sent.length, 0);
  assert.equal(clock.timers.size, 0);
});

test('deadline comes from wait start and works without screenshots or probe events', async () => {
  const { clock, sent, notifier } = setup();
  await clock.advance(19 * 60_000 + 15_000);
  notifier.observeTask(task());
  await flush();
  await clock.advance(60_000);
  assert.deepEqual(sent.map(({ at }) => at), [1_155_000, 1_170_000]);
  assert.equal(clock.timers.size, 0);
});

test('ordinary waits are ignored and notification text excludes webpage data and secrets', async () => {
  const { sent, notifier } = setup();
  notifier.observeTask(task({ waiting: { id: 'wait_1', reason: 'manual' } }));
  await flush();
  assert.equal(sent.length, 0);
  const current = task({ name: 'Example token=super-secret\n next' });
  current.waiting.data = { screenshot: 'PRIVATE_PAGE_CONTENT' };
  notifier.observeTask(current);
  await flush();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].body, /super-secret|PRIVATE_PAGE_CONTENT|\n/);
  assert.match(sent[0].body, /REDACTED/);
  notifier.close();
});

test('Windows sends safe encoded data, registers once, and requests repeat popups', async () => {
  const calls = [];
  const sender = createDesktopNotificationSender({ platform: 'win32', runCommand: async (...args) => calls.push(args) });
  const payload = {
    title: 'Task Master', body: '"; $(whoami); ` calc.exe <tag>',
    tag: '1234567890123456', expiresAt: new Date(BASE + 30_000).toISOString()
  };
  await sender(payload);
  await sender(payload);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.ok(calls[0][1].includes('Hidden'));
  assert.equal(calls[0][2].timeoutMs, 10_000);
  const firstScript = Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le');
  const secondScript = Buffer.from(calls[1][1].at(-1), 'base64').toString('utf16le');
  assert.ok(firstScript.includes(NOTIFICATION_APP_ID));
  assert.match(firstScript, /New-ItemProperty/);
  assert.doesNotMatch(secondScript, /New-ItemProperty/);
  assert.match(firstScript, /SuppressPopup = \$false/);
  assert.match(firstScript, /CreateTextNode/);
  assert.doesNotMatch(firstScript, /get_Setting|\.Setting/);
  assert.ok(!firstScript.includes(payload.body));
  const envelope = firstScript.match(/FromBase64String\('([^']+)'\)/)[1];
  const decoded = JSON.parse(Buffer.from(envelope, 'base64').toString('utf8'));
  for (const [key, value] of Object.entries(payload)) assert.equal(decoded[key], value);
  assert.equal(decoded.executable, process.execPath);
  assert.match(decoded.cliPath, /src[\\/]cli\.mjs$/);
});

test('macOS and Linux receive text as process arguments, never executable source', async () => {
  for (const platform of ['darwin', 'linux']) {
    const calls = [];
    const sender = createDesktopNotificationSender({ platform, runCommand: async (...args) => calls.push(args) });
    const payload = { title: '--dangerous', body: '"; execute script', tag: 'safe-tag' };
    assert.deepEqual(await sender(payload), { submitted: true, platform });
    assert.deepEqual(calls[0][1].slice(-2), [payload.title, payload.body]);
    if (platform === 'darwin') assert.ok(!calls[0][1][1].includes(payload.body));
    else assert.equal(calls[0][1].at(-3), '--');
  }
});

test('unsupported hosts and already cancelled sends do not spawn helpers', async () => {
  let calls = 0;
  const unsupported = createDesktopNotificationSender({ platform: 'other', runCommand: () => calls++ });
  assert.deepEqual(await unsupported({}), { submitted: false, reason: 'unsupported-platform' });
  const sender = createDesktopNotificationSender({ platform: 'win32', runCommand: () => calls++ });
  assert.deepEqual(await sender({}, { signal: AbortSignal.abort() }), { submitted: false, reason: 'cancelled' });
  assert.equal(calls, 0);
});

test('native notification helpers have a finite command timeout', async () => {
  await assert.rejects(runNotificationCommand(process.execPath,
    ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 50 }),
  (error) => error.killed === true || error.signal === 'SIGKILL');
});
