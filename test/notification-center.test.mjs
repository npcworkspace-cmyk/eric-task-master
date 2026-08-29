import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NotificationCenter } from '../src/lib/notification-center.mjs';

class FakeClock {
  #nextId = 1;
  #timers = new Map();

  constructor(now) {
    this.value = now;
  }

  now = () => this.value;

  setTimer = (callback, delay = 0) => {
    const timer = {
      id: this.#nextId++,
      at: this.value + Math.max(0, Number(delay) || 0),
      callback,
      unref() {}
    };
    this.#timers.set(timer.id, timer);
    return timer;
  };

  clearTimer = (timer) => {
    if (timer?.id) this.#timers.delete(timer.id);
  };

  async advance(milliseconds) {
    this.value += milliseconds;
    await this.runDue();
  }

  async runDue() {
    for (let pass = 0; pass < 20; pass += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      const due = [...this.#timers.values()]
        .filter((timer) => timer.at <= this.value)
        .sort((left, right) => left.at - right.at || left.id - right.id);
      if (!due.length) continue;
      for (const timer of due) {
        if (!this.#timers.delete(timer.id)) continue;
        timer.callback();
      }
    }
  }

  get timerCount() {
    return this.#timers.size;
  }
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-notifications-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clock = options.clock || new FakeClock(Date.parse('2026-08-29T00:00:00.000Z'));
  const filePath = path.join(root, 'notifications.json');
  const systemCalls = [];
  const center = new NotificationCenter({
    filePath,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    systemNotifier: async (payload) => systemCalls.push(payload),
    fetchImpl: async () => ({ ok: true, status: 200 }),
    sleep: async () => {},
    ...options.center
  });
  await center.init();
  t.after(() => center.close());
  return { center, clock, filePath, root, systemCalls };
}

function verificationTask(overrides = {}) {
  return {
    id: 'task_verification_1',
    state: 'waiting_user',
    displayName: 'Sensitive task name',
    userRequest: {
      id: 'handoff_0123456789abcdef0123456789abcdef',
      kind: 'human_verification',
      status: 'pending',
      reason: 'Authorization: Bearer must-not-leak',
      instructions: 'Cookie: secret-cookie'
    },
    ...overrides
  };
}

async function deliverDue(center, clock) {
  await clock.runDue();
  await center.flush();
  await clock.runDue();
}

test('human-verification alerts persist, deliver immediately, and resume at the durable 30-second due time', async (t) => {
  const setup = await fixture(t);
  const created = await setup.center.observeTask(verificationTask());
  assert.equal(created.kind, 'human_verification');
  await deliverDue(setup.center, setup.clock);
  assert.equal(setup.systemCalls.length, 1);
  assert.match(setup.systemCalls[0].targetUrl, /[?&]task=task_verification_1(?:&|$)/u);

  const first = (await setup.center.list())[0];
  assert.equal(first.state, 'active');
  assert.equal(first.deliveryCount, 1);
  assert.equal(first.nextDueAt, '2026-08-29T00:00:30.000Z');

  await setup.clock.advance(29_999);
  await setup.center.flush();
  assert.equal(setup.systemCalls.length, 1);

  await setup.center.close();
  const restartedCalls = [];
  const restarted = new NotificationCenter({
    filePath: setup.filePath,
    now: setup.clock.now,
    setTimer: setup.clock.setTimer,
    clearTimer: setup.clock.clearTimer,
    systemNotifier: async (payload) => restartedCalls.push(payload),
    fetchImpl: async () => ({ ok: true, status: 200 }),
    sleep: async () => {}
  });
  await restarted.init();
  t.after(() => restarted.close());
  assert.equal(setup.clock.timerCount, 0, 'reopened records stay disarmed until the Manager revalidates them');
  await restarted.observeTask(verificationTask());
  await setup.clock.advance(1);
  await deliverDue(restarted, setup.clock);
  assert.equal(restartedCalls.length, 1);
  assert.equal((await restarted.list())[0].deliveryCount, 2);
});

test('repeated observations keep one record and one immediate delivery for the active request', async (t) => {
  const { center, clock, systemCalls } = await fixture(t);
  const [first, second, third] = await Promise.all([
    center.observeTask(verificationTask()),
    center.observeTask(verificationTask()),
    center.observeTask(verificationTask())
  ]);
  assert.equal(first.id, second.id);
  assert.equal(second.id, third.id);
  await deliverDue(center, clock);
  assert.equal((await center.list()).length, 1);
  assert.equal(systemCalls.length, 1);
});

test('deliveries resolve the current Dashboard origin instead of retaining a stale port', async (t) => {
  let dashboardUrl = 'http://127.0.0.1:21001/dashboard';
  const { center, clock, systemCalls } = await fixture(t, {
    center: { dashboardUrl: () => dashboardUrl }
  });
  await center.observeTask(verificationTask());
  await deliverDue(center, clock);
  dashboardUrl = 'http://127.0.0.1:21002/dashboard';
  await center.observeTask(verificationTask({
    id: 'task_verification_2',
    userRequest: {
      ...verificationTask().userRequest,
      id: 'handoff_22222222222222222222222222222222'
    }
  }));
  await deliverDue(center, clock);
  assert.equal(new URL(systemCalls[0].targetUrl).port, '21001');
  assert.equal(new URL(systemCalls[1].targetUrl).port, '21002');
  assert.equal(new URL(systemCalls[1].targetUrl).searchParams.get('task'), 'task_verification_2');
});

test('claim and task-state resolution stop reminders, while non-verification attention states never alert', async (t) => {
  const { center, clock, systemCalls } = await fixture(t);
  const created = await center.observeTask(verificationTask());
  await deliverDue(center, clock);
  assert.equal(systemCalls.length, 1);

  const claimed = await center.claim(created.id);
  assert.equal(claimed.state, 'claimed');
  await clock.advance(90_000);
  await center.flush();
  assert.equal(systemCalls.length, 1);

  const second = verificationTask({
    userRequest: {
      ...verificationTask().userRequest,
      id: 'handoff_abcdef0123456789abcdef0123456789'
    }
  });
  const secondAlert = await center.observeTask(second);
  await deliverDue(center, clock);
  assert.equal(systemCalls.length, 2);
  await center.observeTask({ ...second, state: 'running', userRequest: { ...second.userRequest, status: 'continued' } });
  assert.equal((await center.list()).find((entry) => entry.id === secondAlert.id).state, 'resolved');
  await clock.advance(60_000);
  await center.flush();
  assert.equal(systemCalls.length, 2);

  for (const task of [
    { ...verificationTask(), state: 'failed' },
    { ...verificationTask(), state: 'cooling_down' },
    { ...verificationTask(), state: 'running', health: { status: 'stalled' } },
    { ...verificationTask(), userRequest: { ...verificationTask().userRequest, kind: 'general_question' } }
  ]) {
    await center.observeTask(task);
  }
  await deliverDue(center, clock);
  assert.equal((await center.list({ state: 'active' })).length, 0);
  assert.equal(systemCalls.length, 2);
});

test('an exact claimed verification request resolves after same-task continuation', async (t) => {
  const { center, clock } = await fixture(t);
  const created = await center.observeTask(verificationTask());
  await deliverDue(center, clock);
  assert.equal((await center.claim(created.id)).state, 'claimed');
  assert.equal((await center.get(created.id)).state, 'claimed');

  const outcome = await center.resolveTask(created.taskId, { requestId: created.requestId });
  assert.equal(outcome.resolved, 1);
  const resolved = await center.get(created.id);
  assert.equal(resolved.state, 'resolved');
  assert.ok(resolved.resolvedAt);
});

test('claim waits for an existing delivery and prevents any post-claim reminder tail', async (t) => {
  const clock = new FakeClock(Date.parse('2026-08-29T02:00:00.000Z'));
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  let sends = 0;
  const { center } = await fixture(t, {
    clock,
    center: {
      reminderMs: 1_000,
      deliveryTimeoutMs: 30_000,
      systemNotifier: async () => {
        sends += 1;
        await deliveryGate;
      }
    }
  });
  const created = await center.observeTask(verificationTask());
  await clock.runDue();
  while (sends === 0) await new Promise((resolve) => setImmediate(resolve));

  await clock.advance(1_000);
  assert.equal(clock.timerCount, 1, 'only the delivery deadline may remain while a reminder is in flight');

  let claimSettled = false;
  const claim = center.claim(created.id).then((value) => {
    claimSettled = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(claimSettled, false);
  releaseDelivery();
  assert.equal((await claim).state, 'claimed');
  assert.equal(claimSettled, true);

  await clock.advance(120_000);
  await center.flush();
  assert.equal(sends, 1);
});

test('claim cancels delivery retries that have not started yet', async (t) => {
  let releaseRetry;
  let retryWaiting = false;
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  let sends = 0;
  const { center, clock } = await fixture(t, {
    center: {
      systemNotifier: async () => {
        sends += 1;
        throw Object.assign(new Error('temporary failure'), { code: 'TEMPORARY_FAILURE' });
      },
      sleep: async () => {
        retryWaiting = true;
        await retryGate;
      }
    }
  });
  const created = await center.observeTask(verificationTask());
  await clock.runDue();
  while (!retryWaiting) await new Promise((resolve) => setImmediate(resolve));

  const claim = center.claim(created.id);
  await new Promise((resolve) => setImmediate(resolve));
  releaseRetry();
  assert.equal((await claim).state, 'claimed');
  assert.equal(sends, 1);
});

test('read state is durable and independent from reminder claim or resolution state', async (t) => {
  const { center, clock, filePath, systemCalls } = await fixture(t);
  const first = await center.observeTask(verificationTask());
  const second = await center.observeTask(verificationTask({
    id: 'task_verification_2',
    userRequest: {
      ...verificationTask().userRequest,
      id: 'handoff_99999999999999999999999999999999'
    }
  }));
  await deliverDue(center, clock);
  assert.equal(systemCalls.length, 2);

  const read = await center.markRead(first.id);
  assert.equal(read.state, 'active');
  assert.equal(read.nextDueAt, '2026-08-29T00:00:30.000Z');
  assert.equal((await center.get(first.id)).readAt, read.readAt);
  assert.equal(await center.get('notice_missing'), null);
  const all = await center.markAllRead();
  assert.equal(all.updated, 1);
  assert.ok((await center.get(second.id)).readAt);

  const reopened = new NotificationCenter({
    filePath,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    systemNotifier: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200 }),
    sleep: async () => {}
  });
  await reopened.init();
  t.after(() => reopened.close());
  assert.equal((await reopened.get(first.id)).readAt, read.readAt);
  assert.equal((await reopened.get(first.id)).state, 'active');
});

test('channel settings remain private and public records exclude request secrets and local paths', async (t) => {
  const { center, clock, filePath } = await fixture(t);
  const settings = await center.updateSettings({
    channels: {
      telegram: {
        enabled: true,
        botToken: '123456:telegram-super-secret',
        chatId: '-10099887766'
      },
      feishu: {
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/feishu-super-secret'
      }
    }
  });
  const publicSource = JSON.stringify(settings);
  assert.equal(publicSource.includes('telegram-super-secret'), false);
  assert.equal(publicSource.includes('feishu-super-secret'), false);
  assert.equal(settings.channels.telegram.maskedTarget, '••••7766');
  assert.equal(settings.channels.telegram.status, 'needs_setup', 'configured remote channels are not ready until tested');
  assert.equal(settings.channels.feishu.maskedTarget, 'open.feishu.cn/••••');

  const raw = await readFile(filePath, 'utf8');
  assert.match(raw, /telegram-super-secret/u);
  assert.match(raw, /feishu-super-secret/u);

  await center.observeTask(verificationTask({
    id: 'task_safe_1',
    displayName: 'C:\\Users\\eric\\secret Authorization: Bearer leak-me'
  }));
  await deliverDue(center, clock);
  const recordSource = JSON.stringify((await center.list())[0]);
  assert.equal(recordSource.includes('leak-me'), false);
  assert.equal(recordSource.includes('secret-cookie'), false);
  assert.equal(recordSource.includes('C:\\Users\\eric'), false);
  assert.equal(recordSource.includes('telegram-super-secret'), false);
  assert.equal(recordSource.includes('feishu-super-secret'), false);
});

test('system channel configured state is cached from the notifier capability probe', async (t) => {
  let calls = 0;
  const unavailable = async () => { calls += 1; };
  Object.defineProperty(unavailable, 'configured', { value: false });
  const { center, clock } = await fixture(t, {
    center: { systemNotifier: unavailable }
  });
  const settings = await center.getSettings();
  assert.equal(settings.channels.system.enabled, true);
  assert.equal(settings.channels.system.configured, false);

  await center.observeTask(verificationTask());
  await deliverDue(center, clock);
  assert.equal(calls, 0);
  assert.deepEqual((await center.list())[0].lastDelivery.system, {
    channel: 'system',
    ok: false,
    attempts: 0,
    code: 'CHANNEL_NOT_CONFIGURED'
  });
  assert.equal((await center.list())[0].deliveryCount, 0);
  assert.equal((await center.list())[0].lastDeliveredAt, undefined);
});

test('delivery rechecks the live task and resolves a stale record without sending', async (t) => {
  let eligible = true;
  const { center, clock, systemCalls } = await fixture(t, {
    center: { eligibilityCheck: async () => eligible }
  });
  const notice = await center.observeTask(verificationTask());
  eligible = false;
  await deliverDue(center, clock);
  assert.equal(systemCalls.length, 0);
  assert.equal((await center.get(notice.id)).state, 'resolved');
  assert.equal((await center.get(notice.id)).deliveryCount, 0);
});

test('a temporary eligibility failure keeps the verification active and retries next cycle', async (t) => {
  let checks = 0;
  const { center, clock, systemCalls } = await fixture(t, {
    center: {
      eligibilityCheck: async () => {
        checks += 1;
        if (checks === 1) throw Object.assign(new Error('temporary store failure'), { code: 'EIO' });
        return 'pending';
      }
    }
  });
  const notice = await center.observeTask(verificationTask());
  await deliverDue(center, clock);
  assert.equal(systemCalls.length, 0);
  assert.equal((await center.get(notice.id)).state, 'active');

  await clock.advance(30_000);
  await deliverDue(center, clock);
  assert.equal(systemCalls.length, 1);
  assert.equal((await center.get(notice.id)).deliveryCount, 1);
});

test('eligibility that becomes claimed wins its race with delivery and emits no alert', async (t) => {
  let releaseEligibility;
  const eligibilityGate = new Promise((resolve) => { releaseEligibility = resolve; });
  const { center, clock, systemCalls } = await fixture(t, {
    center: { eligibilityCheck: async () => eligibilityGate }
  });
  const notice = await center.observeTask(verificationTask());
  await clock.runDue();
  releaseEligibility('claimed');
  await deliverDue(center, clock);
  assert.equal(systemCalls.length, 0);
  assert.equal((await center.get(notice.id)).state, 'claimed');
});

test('clearing a channel while eligibility is pending prevents use of stale credentials', async (t) => {
  let releaseEligibility;
  const eligibilityGate = new Promise((resolve) => { releaseEligibility = resolve; });
  const fetchUrls = [];
  const { center, clock } = await fixture(t, {
    center: {
      eligibilityCheck: async () => eligibilityGate,
      fetchImpl: async (url) => {
        fetchUrls.push(String(url));
        return { ok: true, status: 200 };
      }
    }
  });
  await center.updateSettings({
    channels: {
      system: { enabled: false },
      telegram: { enabled: true, botToken: 'old-secret-token', chatId: 'old-chat' }
    }
  });
  await center.observeTask(verificationTask());
  await clock.runDue();
  await center.updateSettings({
    channels: {
      telegram: { enabled: false, botToken: null, chatId: null }
    }
  });
  releaseEligibility('pending');
  await center.flush();
  assert.deepEqual(fetchUrls, []);
});

test('channel retries are bounded and failures stay isolated without exposing endpoints or credentials', async (t) => {
  const clock = new FakeClock(Date.parse('2026-08-29T03:00:00.000Z'));
  const calls = { system: 0, telegram: 0, feishu: 0 };
  const { center } = await fixture(t, {
    clock,
    center: {
      maxAttempts: 3,
      retryDelayMs: 1,
      sleep: async () => {},
      systemNotifier: async () => {
        calls.system += 1;
        const error = new Error('system secret failure');
        error.code = 'SYSTEM_TEMPORARY';
        throw error;
      },
      fetchImpl: async (url) => {
        if (String(url).includes('api.telegram.org')) {
          calls.telegram += 1;
          return calls.telegram < 3 ? { ok: false, status: 503 } : { ok: true, status: 200 };
        }
        calls.feishu += 1;
        return { ok: false, status: 400 };
      }
    }
  });
  await center.updateSettings({
    channels: {
      system: { enabled: true },
      telegram: { enabled: true, botToken: 'bot-secret', chatId: 'chat-secret' },
      feishu: {
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/webhook-secret'
      }
    }
  });
  await center.observeTask(verificationTask());
  await deliverDue(center, clock);
  assert.deepEqual(calls, { system: 3, telegram: 3, feishu: 1 });

  const delivery = (await center.list())[0].lastDelivery;
  assert.deepEqual(delivery.telegram, { channel: 'telegram', ok: true, attempts: 3 });
  assert.equal(delivery.system.ok, false);
  assert.equal(delivery.system.attempts, 3);
  assert.equal(delivery.feishu.ok, false);
  assert.equal(delivery.feishu.attempts, 1);
  assert.equal(delivery.feishu.statusCode, 400);
  const publicSource = JSON.stringify(delivery);
  assert.equal(publicSource.includes('bot-secret'), false);
  assert.equal(publicSource.includes('chat-secret'), false);
  assert.equal(publicSource.includes('webhook-secret'), false);
  assert.equal(publicSource.includes('system secret failure'), false);
});

test('Telegram and Feishu reject HTTP 200 responses whose provider body reports failure', async (t) => {
  const calls = { telegram: 0, feishu: 0 };
  const { center, clock } = await fixture(t, {
    center: {
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async (url) => {
        if (String(url).includes('api.telegram.org')) {
          calls.telegram += 1;
          return {
            ok: true,
            status: 200,
            async json() { return { ok: false, error_code: 400, description: 'private provider detail' }; }
          };
        }
        calls.feishu += 1;
        return {
          ok: true,
          status: 200,
          async json() { return { code: 19024, msg: 'private provider detail' }; }
        };
      }
    }
  });
  await center.updateSettings({
    channels: {
      system: { enabled: false },
      telegram: { enabled: true, botToken: 'test-token', chatId: 'test-chat' },
      feishu: {
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-webhook'
      }
    }
  });
  await center.observeTask(verificationTask());
  await deliverDue(center, clock);

  assert.deepEqual(calls, { telegram: 1, feishu: 1 });
  const delivery = (await center.list())[0].lastDelivery;
  assert.equal(delivery.telegram.ok, false);
  assert.equal(delivery.telegram.code, 'TELEGRAM_PROVIDER_REJECTED');
  assert.equal(delivery.feishu.ok, false);
  assert.equal(delivery.feishu.code, 'FEISHU_PROVIDER_REJECTED');
  assert.equal(JSON.stringify(delivery).includes('private provider detail'), false);
});

test('testChannel uses configured delivery without persisting a notification record', async (t) => {
  const { center } = await fixture(t, {
    center: {
      fetchImpl: async () => ({ ok: true, status: 200 })
    }
  });
  await center.updateSettings({
    channels: {
      telegram: { enabled: false, botToken: 'test-token', chatId: 'test-chat' }
    }
  });
  const result = await center.testChannel('telegram');
  assert.deepEqual(
    { channel: result.channel, ok: result.ok, attempts: result.attempts },
    { channel: 'telegram', ok: true, attempts: 1 }
  );
  assert.deepEqual(await center.list(), []);
  const settings = await center.getSettings();
  assert.equal(settings.channels.telegram.status, 'ready');
  assert.equal(settings.channels.telegram.lastTest.ok, true);
  assert.equal(settings.channels.telegram.lastTest.testedAt, result.testedAt);
});

test('failed provider tests persist a redacted actionable status', async (t) => {
  const { center } = await fixture(t, {
    center: { fetchImpl: async () => ({ ok: false, status: 401 }) }
  });
  await center.updateSettings({
    channels: {
      telegram: { enabled: true, botToken: 'private-token', chatId: 'private-chat' }
    }
  });
  const result = await center.testChannel('telegram');
  assert.deepEqual(
    { ok: result.ok, code: result.code, statusCode: result.statusCode },
    { ok: false, code: 'TELEGRAM_AUTH_REJECTED', statusCode: 401 }
  );
  const settings = await center.getSettings();
  assert.equal(settings.channels.telegram.status, 'test_failed');
  assert.equal(settings.channels.telegram.lastTest.code, 'TELEGRAM_AUTH_REJECTED');
  assert.equal(JSON.stringify(settings).includes('private-token'), false);
  assert.equal(JSON.stringify(settings).includes('private-chat'), false);
});

test('Feishu signing and channel test state persist without exposing credentials', async (t) => {
  let requestBody;
  const { center, filePath, clock } = await fixture(t, {
    center: {
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200, async json() { return { code: 0 }; } };
      }
    }
  });
  await center.updateSettings({
    channels: {
      feishu: {
        enabled: true,
        webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/private-hook',
        signingSecret: 'private-signing-secret'
      }
    }
  });
  const result = await center.testChannel('feishu');
  const timestamp = String(Math.floor(clock.value / 1_000));
  assert.equal(requestBody.timestamp, timestamp);
  assert.equal(
    requestBody.sign,
    createHmac('sha256', `${timestamp}\nprivate-signing-secret`).digest('base64')
  );
  assert.equal(result.ok, true);
  const settings = await center.getSettings();
  assert.equal(settings.channels.feishu.signingConfigured, true);
  assert.equal(settings.channels.feishu.lastTest.ok, true);
  assert.equal(JSON.stringify(settings).includes('private-signing-secret'), false);
  assert.match(await readFile(filePath, 'utf8'), /private-signing-secret/u);
});

test('system capability state and open-settings delegation are stable public settings', async (t) => {
  let opened = 0;
  let initialized = 0;
  const notifier = async () => {};
  notifier.status = () => ({
    state: 'permission_blocked',
    supported: true,
    configured: true,
    canOpenSettings: true,
    code: 'SYSTEM_NOTIFICATION_PERMISSION_BLOCKED'
  });
  notifier.initialize = async () => { initialized += 1; };
  notifier.openSettings = async () => { opened += 1; };
  const { center } = await fixture(t, { center: { systemNotifier: notifier } });
  const settings = await center.getSettings();
  assert.equal(initialized, 1);
  assert.deepEqual(settings.channels.system, {
    enabled: true,
    configured: true,
    status: 'permission_blocked',
    canOpenSettings: true,
    lastTest: null,
    code: 'SYSTEM_NOTIFICATION_PERMISSION_BLOCKED'
  });
  await center.openSystemSettings();
  assert.equal(opened, 1);
});
