import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createManager } from '../src/manager.mjs';
import { NotificationCenter } from '../src/lib/notification-center.mjs';

function task(state = 'waiting_user') {
  return {
    id: 'task_verify',
    revision: 4,
    profileId: 'profile_verify',
    taskType: 'verify.fixture.v1',
    taskLabel: '验证测试',
    displayName: 'Codex-验证测试-20260829-120000Z',
    state,
    behavior: 'human',
    createdAt: '2026-08-29T12:00:00.000Z',
    updatedAt: '2026-08-29T12:00:01.000Z',
    progress: { current: 1, total: 2, message: '等待人工验证' },
    health: { status: state, checkedAt: '2026-08-29T12:00:01.000Z' },
    cleanup: { browserClosed: false, workerExited: false, leaseReleased: false, settled: false },
    userRequest: {
      id: `handoff_${'a'.repeat(32)}`,
      kind: 'human_verification',
      reason: '需要点击验证',
      status: state === 'waiting_user' ? 'pending' : 'continued',
      requestedAt: '2026-08-29T12:00:01.000Z'
    }
  };
}

function fakeNotificationCenter() {
  let record = {
    id: 'notice_fixture',
    taskId: 'task_verify',
    requestId: `handoff_${'a'.repeat(32)}`,
    kind: 'human_verification',
    state: 'active',
    title: '需要人工验证',
    message: '请处理验证',
    createdAt: '2026-08-29T12:00:01.000Z',
    updatedAt: '2026-08-29T12:00:01.000Z',
    nextDueAt: '2026-08-29T12:00:31.000Z',
    deliveryCount: 1
  };
  let settings = {
    channels: {
      system: { enabled: true, configured: true, status: 'ready', canOpenSettings: true, lastTest: null },
      telegram: { enabled: false, configured: false, status: 'needs_setup', lastTest: null },
      feishu: { enabled: false, configured: false, status: 'needs_setup', signingConfigured: false, lastTest: null }
    }
  };
  return {
    calls: [],
    failStateSync: false,
    async init() {},
    async observeTask(value) { this.calls.push(['observe', value.id]); },
    async list() { return [structuredClone(record)]; },
    async get(id) { return id === record.id ? structuredClone(record) : null; },
    async claim(id) {
      if (this.failStateSync) throw Object.assign(new Error('notification store unavailable'), { code: 'EIO' });
      this.calls.push(['claim', id]);
      record = { ...record, state: 'claimed', claimedAt: new Date().toISOString(), nextDueAt: null };
      return structuredClone(record);
    },
    async claimTask(taskId, { requestId }) {
      if (record.taskId !== taskId || record.requestId !== requestId) return null;
      return this.claim(record.id);
    },
    async resolveTask(taskId, { requestId } = {}) {
      if (this.failStateSync) throw Object.assign(new Error('notification store unavailable'), { code: 'EIO' });
      this.calls.push(['resolve', taskId, requestId]);
      record = { ...record, state: 'resolved', resolvedAt: new Date().toISOString(), nextDueAt: null };
      return { resolved: 1 };
    },
    async markRead(id) {
      record = { ...record, readAt: new Date().toISOString() };
      return id === record.id ? structuredClone(record) : null;
    },
    async markAllRead() {
      record = { ...record, readAt: new Date().toISOString() };
      return { updated: 1, readAt: record.readAt };
    },
    async getSettings() { return structuredClone(settings); },
    async updateSettings(patch) {
      if (patch?.channels?.telegram?.botToken === 'bad') throw new TypeError('invalid token fixture');
      settings = {
        channels: {
          ...settings.channels,
          system: { ...settings.channels.system, ...patch.channels?.system },
          telegram: patch.channels?.telegram
            ? {
                enabled: patch.channels.telegram.enabled === true,
                configured: Boolean(patch.channels.telegram.botToken),
                status: 'needs_setup',
                lastTest: null
              }
            : settings.channels.telegram,
          feishu: patch.channels?.feishu
            ? {
                enabled: patch.channels.feishu.enabled === true,
                configured: Boolean(patch.channels.feishu.webhookUrl),
                status: 'needs_setup',
                signingConfigured: Boolean(patch.channels.feishu.signingSecret),
                lastTest: null
              }
            : settings.channels.feishu
        }
      };
      return structuredClone(settings);
    },
    async testChannel(channel) { return { channel, ok: true, attempts: 1 }; },
    async openSystemSettings() {
      this.calls.push(['open-system-settings']);
      return structuredClone(settings);
    },
    async close() { this.calls.push(['close']); }
  };
}

async function jsonRequest(baseUrl, pathname, token, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, body: await response.json() };
}

test('Manager exposes durable verification notifications without returning channel secrets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-manager-notifications-'));
  const center = fakeNotificationCenter();
  let current = task();
  const taskCalls = [];
  const taskService = {
    async schedulerStatus() { return {}; },
    async listHumanVerificationRequests() {
      return current.state === 'waiting_user' && ['pending', 'claimed'].includes(current.userRequest?.status)
        ? [structuredClone(current)]
        : [];
    },
    async list() { throw new Error('notification scan must not enumerate full task history'); },
    async focusTask(id) {
      taskCalls.push(['focus', id]);
      const error = new Error('fixture focus failed');
      error.code = 'TASK_FOCUS_UNAVAILABLE';
      throw error;
    },
    async claimUserRequest(id, input) {
      taskCalls.push(['claim', id, input.requestId]);
      current.userRequest.status = 'claimed';
      current.revision += 1;
      return structuredClone(current);
    },
    async continueTask(id, input) {
      taskCalls.push(['continue', id, input.requestId]);
      if (current.userRequest?.kind === 'human_verification' && current.userRequest.status !== 'claimed') {
        throw Object.assign(new Error('Owner claim required'), {
          code: 'USER_HANDOFF_OWNER_CLAIM_REQUIRED', statusCode: 409
        });
      }
      current = task('running');
      return structuredClone(current);
    },
    async close() {}
  };
  const manager = await createManager({
    port: 0,
    dataDir: root,
    taskService,
    notificationCenter: center,
    notificationScanIntervalMs: 60_000
  });
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await manager.start();

  const listed = await jsonRequest(manager.baseUrl, '/v1/notifications', manager.token);
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.activeCount, 1);
  assert.equal(listed.body.notifications[0].kind, 'human_verification');

  const initialSettings = await jsonRequest(manager.baseUrl, '/v1/notification-settings', manager.token);
  assert.equal(initialSettings.response.status, 200);
  assert.equal(initialSettings.body.settings.channels.telegram.lastTest, null);
  assert.equal(initialSettings.body.settings.channels.feishu.signingConfigured, false);

  const saved = await jsonRequest(manager.baseUrl, '/v1/notification-settings', manager.token, {
    method: 'PATCH',
    body: {
      channels: {
        telegram: { enabled: true, botToken: 'secret-value', chatId: '12345' },
        feishu: {
          enabled: true,
          webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/private-hook',
          signingSecret: 'private-signing-secret'
        }
      }
    }
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.settings.channels.telegram.configured, true);
  assert.equal(saved.body.settings.channels.telegram.lastTest, null);
  assert.equal(saved.body.settings.channels.feishu.signingConfigured, true);
  assert.equal(JSON.stringify(saved.body).includes('secret-value'), false);
  assert.equal(JSON.stringify(saved.body).includes('private-hook'), false);
  assert.equal(JSON.stringify(saved.body).includes('private-signing-secret'), false);

  const opened = await jsonRequest(manager.baseUrl, '/v1/notification-settings/open-system-settings', manager.token, {
    method: 'POST'
  });
  assert.equal(opened.response.status, 200);
  assert.equal(opened.body.settings.channels.system.status, 'ready');
  assert.equal(center.calls.some((entry) => entry[0] === 'open-system-settings'), true);

  const bypass = await jsonRequest(manager.baseUrl, '/v1/tasks/task_verify/continue', manager.token, {
    method: 'POST', body: { requestId: current.userRequest.id }
  });
  assert.equal(bypass.response.status, 409);
  assert.equal(bypass.body.code, 'USER_HANDOFF_OWNER_CLAIM_REQUIRED');

  const claim = await jsonRequest(manager.baseUrl, '/v1/notifications/notice_fixture/actions', manager.token, {
    method: 'POST', body: { action: 'claim' }
  });
  assert.equal(claim.response.status, 200);
  assert.equal(claim.body.notification.state, 'claimed');
  assert.equal(claim.body.focus.ok, false);
  assert.equal(claim.body.focus.error.code, 'TASK_FOCUS_UNAVAILABLE');
  assert.deepEqual(taskCalls.slice(-2).map((entry) => entry[0]), ['claim', 'focus']);

  const continued = await jsonRequest(manager.baseUrl, '/v1/tasks/task_verify/continue', manager.token, {
    method: 'POST', body: { requestId: current.userRequest.id }
  });
  assert.equal(continued.response.status, 202);
  const afterContinue = await jsonRequest(manager.baseUrl, '/v1/notifications', manager.token);
  assert.equal(afterContinue.body.notifications[0].state, 'resolved');
  assert.equal(taskCalls.at(-1)[0], 'continue');

  const invalid = await jsonRequest(manager.baseUrl, '/v1/notification-settings', manager.token, {
    method: 'PATCH', body: { channels: { telegram: { enabled: true, botToken: 'bad' } } }
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.code, 'INVALID_NOTIFICATION_REQUEST');
});

test('Manager revalidates persisted notifications before arming delivery after restart', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-manager-stale-notification-'));
  const filePath = path.join(root, 'notifications.json');
  const inertTimer = () => ({ unref() {} });
  const seed = new NotificationCenter({
    filePath,
    systemNotifier: async () => {},
    setTimer: inertTimer,
    clearTimer: () => {},
    fetchImpl: async () => ({ ok: true, status: 200 })
  });
  await seed.init();
  await seed.observeTask(task());
  await seed.close();

  let sends = 0;
  let notificationDashboardUrl;
  const taskService = {
    async schedulerStatus() { return {}; },
    async listHumanVerificationRequests() { return []; },
    async close() {}
  };
  const manager = await createManager({
    port: 0,
    dataDir: root,
    taskService,
    notificationScanIntervalMs: 60_000,
    notificationCenterFactory: async (options) => {
      notificationDashboardUrl = options.dashboardUrl;
      return new NotificationCenter({
        ...options,
        systemNotifier: async () => { sends += 1; },
        fetchImpl: async () => ({ ok: true, status: 200 })
      });
    }
  });
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(sends, 0);
  await manager.start();
  assert.equal(typeof notificationDashboardUrl, 'function');
  assert.equal(notificationDashboardUrl(), manager.dashboardUrl);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(sends, 0);
  const listed = await jsonRequest(manager.baseUrl, '/v1/notifications', manager.token);
  assert.equal(listed.body.notifications[0].state, 'resolved');
});

test('notification sidecar failures never turn successful claim, continue, or cancel into HTTP failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-manager-notification-sidecar-'));
  const center = fakeNotificationCenter();
  center.failStateSync = true;
  let current = task();
  const taskService = {
    async schedulerStatus() { return {}; },
    async listHumanVerificationRequests() {
      return current.state === 'waiting_user' && ['pending', 'claimed'].includes(current.userRequest?.status)
        ? [structuredClone(current)]
        : [];
    },
    async claimUserRequest() {
      current.userRequest.status = 'claimed';
      return structuredClone(current);
    },
    async focusTask() { return { task: structuredClone(current) }; },
    async continueTask() {
      current = task('running');
      return structuredClone(current);
    },
    async cancel() {
      current = task('cancelled');
      return structuredClone(current);
    },
    async close() {}
  };
  const manager = await createManager({
    port: 0,
    dataDir: root,
    taskService,
    notificationCenter: center,
    notificationScanIntervalMs: 60_000
  });
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await manager.start();

  const claimed = await jsonRequest(manager.baseUrl, '/v1/notifications/notice_fixture/actions', manager.token, {
    method: 'POST', body: { action: 'claim' }
  });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.body.task.userRequest.status, 'claimed');
  assert.deepEqual(claimed.body.notificationSync, {
    ok: false, code: 'NOTIFICATION_STATE_SYNC_DEGRADED'
  });

  const continued = await jsonRequest(manager.baseUrl, '/v1/tasks/task_verify/continue', manager.token, {
    method: 'POST', body: { requestId: `handoff_${'a'.repeat(32)}` }
  });
  assert.equal(continued.response.status, 202);
  assert.equal(continued.body.task.state, 'running');
  assert.equal(continued.body.notificationSync.ok, false);

  current = task();
  const cancelled = await jsonRequest(manager.baseUrl, '/v1/tasks/task_verify/cancel', manager.token, {
    method: 'POST', body: {}
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.task.state, 'cancelled');
  assert.equal(cancelled.body.notificationSync.ok, false);
});
