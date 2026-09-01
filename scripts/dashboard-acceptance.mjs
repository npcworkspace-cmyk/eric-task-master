#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createManager } from '../src/manager.mjs';
import { VERSION } from '../src/contracts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const reportPath = process.env.TASKMASTER_DASHBOARD_REPORT
  ? path.resolve(process.env.TASKMASTER_DASHBOARD_REPORT)
  : null;
const screenshotPath = process.env.TASKMASTER_DASHBOARD_SCREENSHOT
  ? path.resolve(process.env.TASKMASTER_DASHBOARD_SCREENSHOT)
  : null;
const profileRecoveryScreenshotPath = process.env.TASKMASTER_PROFILE_RECOVERY_SCREENSHOT
  ? path.resolve(process.env.TASKMASTER_PROFILE_RECOVERY_SCREENSHOT)
  : null;

function now() {
  return new Date().toISOString();
}

function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
}

async function waitForCondition(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function serviceError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function createTaskHarness(profileStore, tasks, control) {
  const openOwners = new Map();

  function task(id) {
    const value = tasks.get(id);
    if (!value) throw serviceError(404, 'TASK_NOT_FOUND', `Task ${id} was not found`);
    return value;
  }

  function assertCommand(value, body) {
    assert.match(body.commandId, /^dashboard:/u);
    if (value.revision !== body.expectedRevision) {
      throw serviceError(409, 'TASK_REVISION_CONFLICT', 'Task revision changed');
    }
  }

  function revise(value, patch) {
    Object.assign(value, patch);
    value.revision += 1;
    value.updatedAt = now();
    return structuredClone(value);
  }

  return {
    async schedulerStatus() {
      const values = [...tasks.values()];
      return {
        running: values.filter((value) => ['running', 'paused', 'cooling_down'].includes(value.state)).length,
        queued: values.filter((value) => value.state === 'queued').length,
        total: values.length
      };
    },
    async list({ limit = 50, cursor = null } = {}) {
      if (control.listFailures > 0) {
        control.listFailures -= 1;
        throw serviceError(503, 'FIXTURE_TRANSIENT', 'Transient fixture read failure');
      }
      const visible = [...tasks.values()].sort((left, right) => (
        String(right.createdAt || '').localeCompare(String(left.createdAt || '')) || right.id.localeCompare(left.id)
      ));
      const cursorIndex = cursor ? visible.findIndex((value) => value.id === cursor) : -1;
      if (cursor && cursorIndex < 0) throw serviceError(400, 'INVALID_TASK_CURSOR', 'Task cursor is invalid');
      const start = cursorIndex + 1;
      const page = visible.slice(start, start + limit);
      return {
        tasks: page.map((value) => structuredClone(value)),
        nextCursor: start + page.length < visible.length ? page.at(-1).id : null
      };
    },
    async listTaskAssets() {
      return { assets: structuredClone(control.assets), total: control.assets.length };
    },
    async applyTaskAssetAction(body) {
      control.assetActions.push({ action: body.action, assetIds: [...body.assetIds], note: body.note });
      const selected = control.assets.filter((asset) => body.assetIds.includes(asset.id));
      if (selected.length !== body.assetIds.length) throw serviceError(404, 'TASK_ASSET_NOT_FOUND', 'Asset not found');
      if (body.action === 'delete' && selected.some((asset) => !asset.deletable)) {
        throw serviceError(409, 'TASK_ASSET_DELETE_BLOCKED', 'Asset is still referenced');
      }
      if (body.action === 'delete') {
        control.assets = control.assets.filter((asset) => !body.assetIds.includes(asset.id));
      } else {
        for (const asset of selected) {
          if (body.action === 'note') asset.note = body.note;
          if (body.action === 'deprecate') {
            asset.lifecycle = 'deprecated';
            asset.discoverable = false;
          }
          if (body.action === 'restore') {
            asset.lifecycle = 'active';
            asset.discoverable = true;
          }
        }
      }
      return { assets: structuredClone(control.assets), total: control.assets.length, changed: selected.length };
    },
    async get(id) {
      return structuredClone(task(id));
    },
    async focusTask(id) {
      control.notificationActions.push({ id, action: 'focus' });
      return structuredClone(task(id));
    },
    async claimUserRequest(id, { requestId }) {
      const value = task(id);
      assert.equal(value.userRequest?.id, requestId);
      control.notificationActions.push({ id, action: 'claim' });
      value.userRequest = { ...value.userRequest, claimedAt: now() };
      return structuredClone(value);
    },
    async continueTask(id, { requestId }) {
      const value = task(id);
      assert.equal(value.userRequest?.id, requestId);
      control.notificationActions.push({ id, action: 'continue' });
      return revise(value, {
        state: 'running',
        userRequest: { ...value.userRequest, continuedAt: now() },
        currentActivity: { phase: 'running', status: 'active', updatedAt: now() },
        health: { status: 'healthy', checkedAt: now() }
      });
    },
    async openProfile(id) {
      const ownerId = `profile-open:dashboard-acceptance:${id}`;
      await profileStore.acquireLease(id, ownerId, { pid: process.pid, ttlMs: 60_000 });
      openOwners.set(id, ownerId);
    },
    async closeProfile(id) {
      const ownerId = openOwners.get(id);
      if (ownerId) {
        const profile = await profileStore.get(id);
        await profileStore.releaseLease(id, ownerId, {
          expectedGeneration: profile.lease.generation
        });
      }
      openOwners.delete(id);
    },
    async forceReleaseProfileLease(id, body) {
      const profile = await profileStore.get(id);
      const released = await profileStore.forceReleaseLease(id, {
        commandId: body.commandId,
        expectedOwnerId: profile.lease.ownerId,
        expectedGeneration: profile.lease.generation,
        expectedUpdatedAt: body.expectedUpdatedAt
      });
      return { profile: released.profile, idempotent: released.idempotent };
    },
    async applyProfileBehavior(id, behavior) {
      control.behaviorChanges.push({ id, behavior });
      const appliedAt = now();
      const taskIds = [];
      for (const value of tasks.values()) {
        if (value.profileId !== id || ['completed', 'failed', 'cancelled'].includes(value.state)) continue;
        value.behavior = behavior;
        value.behaviorState = {
          configured: behavior,
          effective: behavior === 'auto' ? 'fast' : behavior,
          ...(behavior === 'auto'
            ? { auto: { level: 0, label: 'fast', actionsRemaining: 0, signal: null } }
            : {}),
          source: 'worker',
          confirmed: true,
          at: appliedAt
        };
        value.updatedAt = appliedAt;
        taskIds.push(value.id);
      }
      return { profileId: id, behavior, activeApplied: taskIds.length, taskIds };
    },
    async pauseTask(id, body) {
      control.taskActions.push({ id, action: 'pause' });
      const value = task(id);
      if (control.conflictNextPause) {
        control.conflictNextPause = false;
        value.revision += 1;
        value.updatedAt = now();
        throw serviceError(409, 'TASK_REVISION_CONFLICT', 'Fixture changed task revision');
      }
      assertCommand(value, body);
      const history = Array.isArray(value.history) ? structuredClone(value.history) : [];
      if (history.at(-1) && !history.at(-1).finishedAt) history.at(-1).finishedAt = now();
      return revise(value, {
        state: 'paused',
        history,
        currentActivity: { phase: 'paused', status: 'paused', updatedAt: now() },
        health: { status: 'paused', checkedAt: now() }
      });
    },
    async resumePausedTask(id, body) {
      control.taskActions.push({ id, action: 'resume' });
      const value = task(id);
      assertCommand(value, body);
      return revise(value, {
        state: 'running',
        history: [...(value.history || []), { attempt: (value.history?.length || 0) + 1, workerStartedAt: now() }],
        currentActivity: { phase: 'extracting', status: 'active', updatedAt: now() },
        health: { status: 'healthy', checkedAt: now() }
      });
    },
    async terminateTask(id, body) {
      control.taskActions.push({ id, action: 'cancel' });
      const value = task(id);
      assertCommand(value, body);
      const history = Array.isArray(value.history) ? structuredClone(value.history) : [];
      if (history.at(-1) && !history.at(-1).finishedAt) history.at(-1).finishedAt = now();
      return revise(value, {
        state: 'cancelled',
        history,
        finishedAt: now(),
        currentActivity: { phase: 'cancelled', status: 'cancelled', updatedAt: now() },
        cleanup: { browserClosed: true, workerExited: true, leaseReleased: true, settled: true }
      });
    },
    async deleteTask(id, body) {
      control.deleteRequests += 1;
      const value = task(id);
      assertCommand(value, body);
      if (!['completed', 'failed', 'cancelled', 'terminated'].includes(value.state) || value.cleanup?.settled !== true) {
        throw serviceError(409, 'TASK_DELETE_NOT_READY', 'Only settled terminal tasks can be deleted');
      }
      tasks.delete(id);
      return { id, deletedAt: now() };
    },
    async close() {
      for (const [id, ownerId] of openOwners) {
        const profile = await profileStore.get(id).catch(() => null);
        if (profile?.lease?.ownerId === ownerId) {
          await profileStore.releaseLease(id, ownerId, {
            expectedGeneration: profile.lease.generation
          }).catch(() => {});
        }
      }
      openOwners.clear();
    }
  };
}

function createNotificationHarness(control) {
  function publicSettings() {
    const channels = control.notificationSettings.channels;
    return {
      channels: {
        system: {
          enabled: channels.system.enabled,
          configured: true,
          status: channels.system.lastTest?.ok === false ? 'test_failed' : 'ready',
          canOpenSettings: true,
          lastTest: channels.system.lastTest || null
        },
        telegram: {
          enabled: channels.telegram.enabled,
          configured: Boolean(channels.telegram.botToken && channels.telegram.chatId),
          status: channels.telegram.botToken && channels.telegram.chatId
            ? channels.telegram.lastTest?.ok === true ? 'ready' : channels.telegram.lastTest?.ok === false ? 'test_failed' : 'needs_setup'
            : 'needs_setup',
          lastTest: channels.telegram.lastTest || null,
          ...(channels.telegram.chatId ? { maskedTarget: `••••${channels.telegram.chatId.slice(-4)}` } : {})
        },
        feishu: {
          enabled: channels.feishu.enabled,
          configured: Boolean(channels.feishu.webhookUrl),
          status: channels.feishu.webhookUrl
            ? channels.feishu.lastTest?.ok === true ? 'ready' : channels.feishu.lastTest?.ok === false ? 'test_failed' : 'needs_setup'
            : 'needs_setup',
          signingConfigured: Boolean(channels.feishu.signingSecret),
          lastTest: channels.feishu.lastTest || null,
          ...(channels.feishu.webhookUrl ? { maskedTarget: 'open.feishu.cn/••••' } : {})
        }
      }
    };
  }

  function record(id) {
    return control.notifications.find((item) => item.id === id) || null;
  }

  return {
    async init() {},
    async observeTask() {},
    async list() { return structuredClone(control.notifications); },
    async get(id) { return structuredClone(record(id)); },
    async markRead(id) {
      const item = record(id);
      if (item && !item.readAt) item.readAt = now();
      return structuredClone(item);
    },
    async markAllRead() {
      let updated = 0;
      for (const item of control.notifications) {
        if (item.readAt) continue;
        item.readAt = now();
        updated += 1;
      }
      return { updated, readAt: now() };
    },
    async claim(id) {
      const item = record(id);
      if (item?.state === 'active') {
        item.state = 'claimed';
        item.claimedAt = now();
      }
      if (control.degradeNextNotificationSync) {
        control.degradeNextNotificationSync = false;
        throw Object.assign(new Error('simulated notification sidecar persistence failure'), { code: 'EIO' });
      }
      return structuredClone(item);
    },
    async resolveTask(taskId, { requestId } = {}) {
      let resolved = 0;
      for (const item of control.notifications) {
        if (item.taskId !== taskId || (requestId && item.requestId !== requestId) || item.state === 'resolved') continue;
        item.state = 'resolved';
        item.resolvedAt = now();
        resolved += 1;
      }
      return { resolved };
    },
    async getSettings() {
      const readId = ++control.notificationSettingsReadSequence;
      const snapshot = publicSettings();
      const delayMs = control.notificationSettingsReadDelayMs;
      control.notificationSettingsReadsStarted.push(readId);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      control.notificationSettingsReadsCompleted.push(readId);
      return snapshot;
    },
    async updateSettings(body) {
      control.notificationSettingPatches.push(structuredClone(body));
      for (const name of ['system', 'telegram', 'feishu']) {
        if (!body.channels?.[name]) continue;
        control.notificationSettings.channels[name] = {
          ...control.notificationSettings.channels[name],
          ...body.channels[name]
        };
      }
      return publicSettings();
    },
    async testChannel(channel, options = {}) {
      control.notificationTests.push({ channel, ...structuredClone(options) });
      if (control.notificationTestDelayMs) await new Promise((resolve) => setTimeout(resolve, control.notificationTestDelayMs));
      const result = { ok: true, channel, attempts: 1, testedAt: now() };
      control.notificationSettings.channels[channel].lastTest = structuredClone(result);
      return result;
    },
    async openSystemSettings() {
      control.notificationSystemOpens += 1;
      return publicSettings();
    },
    async close() {}
  };
}

async function jsonRequest(baseUrl, pathname, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, `${method} ${pathname}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-dashboard-acceptance-'));
const dataDir = path.join(temporaryRoot, 'state');
const tasks = new Map();
const control = {
  listFailures: 0,
  conflictNextPause: false,
  taskActions: [],
  deleteRequests: 0,
  behaviorChanges: [],
  assetActions: [],
  notificationActions: [],
  notificationSettingPatches: [],
  notificationTests: [],
  notificationTestDelayMs: 0,
  notificationSettingsReadDelayMs: 0,
  notificationSettingsReadSequence: 0,
  notificationSettingsReadsStarted: [],
  notificationSettingsReadsCompleted: [],
  notificationSystemOpens: 0,
  degradeNextNotificationSync: false,
  notificationSettings: {
    channels: {
      system: { enabled: true, lastTest: null },
      telegram: { enabled: true, botToken: 'stored-token', chatId: '1234567890' },
      feishu: { enabled: false, webhookUrl: '', signingSecret: '' }
    }
  },
  notifications: [
    {
      id: 'notice_verify', taskId: 'task_waiting', requestId: 'request_verify', kind: 'human_verification', state: 'active',
      title: '需要人工验证', message: '请完成页面验证', createdAt: ago(90_000), updatedAt: now(), deliveryCount: 3
    },
    {
      id: 'notice_history', taskId: 'task_completed', requestId: 'request_history', kind: 'human_verification', state: 'resolved',
      title: '历史人工验证', message: '用于验收全部标为已读', createdAt: ago(180_000), updatedAt: ago(120_000), deliveryCount: 1
    }
  ],
  assets: [
    {
      id: 'pack:news-pack@2.0.0', kind: 'pack', source: 'task-pack', name: 'news-pack', version: '2.0.0',
      title: '新闻采集 Pack', description: '按站点探针、分页与验收流程采集公开新闻。', note: '生产使用',
      lifecycle: 'active', discoverable: true, protected: false, transient: false,
      taskTypes: [{ name: 'news.collect.v2', title: '新闻采集', lifecycle: 'active', discoverable: true }],
      fileCount: 1, sizeBytes: 4_096, installedAt: ago(86_400_000),
      usage: { runCount: 12, successCount: 10, failureCount: 2, activeCount: 1, states: { completed: 10, failed: 2 }, lastUsedAt: now() },
      canEditNote: true, canChangeLifecycle: true, deletable: false,
      deleteBlockers: ['任务 历史新闻采集 仍可从检查点恢复'],
      blockingTaskCount: 1,
      blockingTasks: [{
        taskId: 'task_pack_blocker', title: '历史新闻采集', state: 'failed',
        blockerCode: 'resume_available', cleanupSettled: true, canDeleteRecord: true
      }]
    },
    {
      id: 'type:campaign-once.v1', kind: 'standalone', source: 'standalone', name: 'campaign-once.v1', version: '1.0.0',
      title: '一次性活动探针', description: '一次性页面结构探测脚本。', note: '',
      lifecycle: 'deprecated', discoverable: false, protected: false, transient: true,
      taskTypes: [{ name: 'campaign-once.v1', title: '一次性活动探针', lifecycle: 'deprecated', discoverable: false }],
      fileCount: 1, sizeBytes: 2_048, installedAt: ago(172_800_000),
      usage: { runCount: 1, successCount: 1, failureCount: 0, activeCount: 0, states: { completed: 1 }, lastUsedAt: ago(86_400_000) },
      canEditNote: true, canChangeLifecycle: true, deletable: true, deleteBlockers: []
    },
    {
      id: 'type:acceptance', kind: 'system', source: 'system', name: 'acceptance', version: '1.0.0',
      title: '系统验收', description: '安装和升级时使用的受保护基础验收能力。', note: '',
      lifecycle: 'active', discoverable: false, protected: true, transient: false,
      taskTypes: [{ name: 'acceptance', title: '系统验收', lifecycle: 'active', discoverable: false }],
      fileCount: 1, sizeBytes: 1_024, installedAt: ago(259_200_000),
      usage: { runCount: 3, successCount: 3, failureCount: 0, activeCount: 0, states: { completed: 3 }, lastUsedAt: ago(3_600_000) },
      canEditNote: true, canChangeLifecycle: false, deletable: false, deleteBlockers: ['系统验收或基础能力受保护']
    },
    {
      id: 'snapshot:abc:fixture', kind: 'orphan', source: 'orphan-snapshot', name: 'old-demo', version: '',
      title: 'old-demo（孤立快照）', description: '没有注册记录或任务引用的遗留文件，可安全清理。', note: '',
      lifecycle: 'retired', discoverable: false, protected: false, transient: false, taskTypes: [],
      fileCount: 1, sizeBytes: 512, installedAt: ago(604_800_000),
      usage: { runCount: 0, successCount: 0, failureCount: 0, activeCount: 0, states: {}, lastUsedAt: null },
      canEditNote: false, canChangeLifecycle: false, deletable: true, deleteBlockers: []
    }
  ]
};
const checks = [];
let manager;
let browser;

async function startManager(port = 0) {
  const next = await createManager({
    port,
    dataDir,
    dashboardDir: DASHBOARD,
    notificationCenterFactory: () => createNotificationHarness(control),
    taskServiceFactory: ({ profileStore }) => createTaskHarness(profileStore, tasks, control)
  });
  await next.start();
  return next;
}

try {
  manager = await startManager();
  const baseUrl = manager.baseUrl;
  const managerPort = manager.address().port;

  const persistent = await manager.profileStore.create({
    name: '验收账号',
    kind: 'persistent',
    browserEngine: 'chrome',
    defaultBehavior: 'human',
    headless: false
  });
  const ephemeral = await manager.profileStore.create({
    name: '验收临时',
    kind: 'ephemeral',
    browserEngine: 'chromium',
    defaultBehavior: 'auto',
    headless: true
  });
  const quarantined = await manager.profileStore.create({
    name: '异常保留账号',
    kind: 'persistent',
    browserEngine: 'chrome',
    defaultBehavior: 'human',
    headless: false
  });
  await writeFile(path.join(quarantined.userDataDir, 'login-state-marker.txt'), 'preserved');
  const quarantinedLease = await manager.profileStore.acquireLease(
    quarantined.id,
    'task:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    { pid: 999_997, ttlMs: 1_000, cleanupRequired: true }
  );
  await manager.profileStore.markCleanupUnknown(
    quarantined.id,
    quarantinedLease.lease.ownerId,
    { expectedGeneration: quarantinedLease.lease.generation }
  );

  tasks.set('task_running', {
    id: 'task_running',
    jobId: 'job_running',
    revision: 1,
    profileId: persistent.id,
    taskType: 'news.collect.v1',
    taskLabel: '抓取新闻',
    displayName: 'Codex-抓取新闻-20260826-101500Z',
    state: 'running',
    behavior: 'human',
    behaviorState: {
      configured: 'human', effective: 'human', source: 'worker', confirmed: true, at: now()
    },
    createdAt: ago(92_000),
    startedAt: ago(84_000),
    updatedAt: now(),
    currentActivity: { phase: 'extracting', status: 'active', updatedAt: now() },
    progress: { current: 3, total: 10, message: '正在提取第 3 批结果', updatedAt: now() },
    health: { status: 'healthy', checkedAt: now() },
    timing: { version: 1, cooldownDurationMs: 7_000, activeCooldownStartedAt: null },
    history: [{ attempt: 1, workerStartedAt: ago(84_000) }],
    cleanup: { browserClosed: false, workerExited: false, leaseReleased: false, settled: false }
  });
  tasks.set('task_cooling', {
    id: 'task_cooling',
    jobId: 'job_cooling',
    revision: 2,
    profileId: ephemeral.id,
    taskType: 'catalog.scan.v1',
    taskLabel: '商品巡检',
    displayName: 'WorkBuddy-商品巡检-20260826-101530Z',
    state: 'cooling_down',
    behavior: 'auto',
    behaviorState: {
      configured: 'auto', effective: 'human',
      auto: { level: 3, label: 'cooldown', actionsRemaining: 6, signal: 'rate_limit' },
      source: 'worker', confirmed: true, at: now()
    },
    createdAt: ago(48_000),
    startedAt: ago(45_000),
    updatedAt: now(),
    currentActivity: { phase: 'cooling_down', status: 'waiting', updatedAt: now() },
    progress: { current: 6, total: 20, message: '站点限流，冷却后自动继续', updatedAt: now() },
    cooldown: { reason: 'rate_limit', resumeAt: new Date(Date.now() + 30_000).toISOString() },
    timing: { version: 1, cooldownDurationMs: 4_000, activeCooldownStartedAt: ago(3_000) },
    history: [{ attempt: 1, workerStartedAt: ago(45_000) }],
    cleanup: { browserClosed: false, workerExited: false, leaseReleased: false, settled: false }
  });
  tasks.set('task_completed', {
    id: 'task_completed',
    jobId: 'job_completed',
    revision: 4,
    profileId: ephemeral.id,
    taskType: 'forms.audit.v1',
    taskLabel: '表单验收',
    displayName: 'Claude-表单验收-20260826-101000Z',
    state: 'completed',
    behavior: 'auto',
    behaviorState: {
      configured: 'auto', effective: 'fast',
      auto: { level: 0, label: 'fast', actionsRemaining: 0, signal: null },
      source: 'worker', confirmed: true, at: ago(20_000)
    },
    createdAt: ago(180_000),
    startedAt: ago(170_000),
    finishedAt: ago(20_000),
    updatedAt: ago(20_000),
    currentActivity: { phase: 'completed', status: 'succeeded', updatedAt: ago(20_000) },
    progress: { current: 5, total: 5, message: '全部完成', updatedAt: ago(20_000) },
    timing: { version: 1, cooldownDurationMs: 12_000, activeCooldownStartedAt: null },
    history: [{ attempt: 1, workerStartedAt: ago(170_000), finishedAt: ago(20_000) }],
    cleanup: { browserClosed: true, workerExited: true, leaseReleased: true, settled: true },
    completion: { integrity: 'valid', verifiedAt: ago(20_000) },
    report: {
      status: 'final',
      title: '表单验收报告',
      summary: '5 项表单检查全部通过。',
      sections: [{ heading: '结论', body: '没有发现需要人工处理的异常。' }]
    }
  });
  tasks.set('task_waiting', {
    id: 'task_waiting',
    jobId: 'job_waiting',
    revision: 3,
    profileId: persistent.id,
    taskType: 'account.verify.v1',
    taskLabel: '账号验证',
    displayName: 'Codex-账号验证-20260826-101545Z',
    state: 'waiting_user',
    behavior: 'human',
    behaviorState: { configured: 'human', effective: 'human', source: 'worker', confirmed: true, at: now() },
    createdAt: ago(96_000),
    startedAt: ago(92_000),
    updatedAt: now(),
    currentActivity: { phase: 'waiting_user', status: 'waiting', updatedAt: now() },
    progress: { current: 4, total: 10, message: '等待人工完成验证', updatedAt: now() },
    userRequest: { id: 'request_verify', kind: 'human_verification', createdAt: ago(90_000) },
    health: { status: 'waiting_user', checkedAt: now() },
    timing: { version: 1, cooldownDurationMs: 0, activeCooldownStartedAt: null },
    history: [{ attempt: 1, workerStartedAt: ago(92_000) }],
    cleanup: { browserClosed: false, workerExited: false, leaseReleased: false, settled: false }
  });

  tasks.set('task_batch_active', {
    id: 'task_batch_active', jobId: 'job_batch_active', revision: 1,
    profileId: ephemeral.id, taskType: 'batch.fixture.v1', taskLabel: '批量取消验收',
    displayName: 'Codex-批量取消验收-20260826-101600Z', state: 'queued', behavior: 'auto',
    createdAt: ago(30_000), updatedAt: now(),
    currentActivity: { phase: 'queued', status: 'waiting', updatedAt: now() },
    progress: { current: 0, total: 1, message: '等待批量操作', updatedAt: now() },
    timing: { version: 1, cooldownDurationMs: 0, activeCooldownStartedAt: null }, history: [],
    cleanup: { browserClosed: false, workerExited: false, leaseReleased: false, settled: false }
  });

  for (let index = 0; index < 102; index += 1) {
    const id = `task_history_${String(index).padStart(2, '0')}`;
    tasks.set(id, {
      id, jobId: `job_history_${index}`, revision: 1,
      profileId: ephemeral.id, taskType: 'history.fixture.v1', taskLabel: `历史任务 ${index + 1}`,
      displayName: `Codex-历史任务-${String(index + 1).padStart(2, '0')}`, state: 'completed', behavior: 'auto',
      createdAt: ago(86_400_000 + index * 60_000), startedAt: ago(86_390_000 + index * 60_000),
      finishedAt: ago(86_380_000 + index * 60_000), updatedAt: ago(86_380_000 + index * 60_000),
      currentActivity: { phase: 'completed', status: 'succeeded', updatedAt: ago(86_380_000 + index * 60_000) },
      progress: { current: 1, total: 1, message: '历史任务已完成', updatedAt: ago(86_380_000 + index * 60_000) },
      timing: { version: 1, cooldownDurationMs: 0, activeCooldownStartedAt: null },
      history: [{ attempt: 1, workerStartedAt: ago(86_390_000 + index * 60_000), finishedAt: ago(86_380_000 + index * 60_000) }],
      cleanup: { browserClosed: true, workerExited: true, leaseReleased: true, settled: true }
    });
  }
  tasks.set('task_pack_blocker', {
    id: 'task_pack_blocker', jobId: 'job_pack_blocker', revision: 2,
    profileId: persistent.id, taskType: 'news.collect.v2', taskLabel: '历史新闻采集',
    displayName: 'Codex-历史新闻采集-20260818-080000Z', state: 'failed', behavior: 'human',
    createdAt: ago(8 * 86_400_000), startedAt: ago(8 * 86_400_000 - 10_000),
    finishedAt: ago(8 * 86_400_000 - 20_000), updatedAt: ago(8 * 86_400_000 - 20_000),
    currentActivity: { phase: 'failed', status: 'failed', updatedAt: ago(8 * 86_400_000 - 20_000) },
    progress: { current: 20, total: 50, message: '可从检查点恢复', updatedAt: ago(8 * 86_400_000 - 20_000) },
    timing: { version: 1, cooldownDurationMs: 0, activeCooldownStartedAt: null },
    history: [{ attempt: 1, workerStartedAt: ago(8 * 86_400_000 - 10_000), finishedAt: ago(8 * 86_400_000 - 20_000) }],
    cleanup: { browserClosed: true, workerExited: true, leaseReleased: true, settled: true },
    supportsResume: true, resumeAvailable: true
  });

  control.listFailures = 1;
  const authorization = await jsonRequest(baseUrl, '/v1/dashboard/authorize', {
    method: 'POST', token: manager.token, body: { focusTaskId: 'task_running' }
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const requestedApiPaths = [];
  const notificationRequestBodies = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/v1/')) requestedApiPaths.push(pathname);
    if (pathname === '/v1/notification-settings' || pathname === '/v1/notification-settings/test') {
      try { notificationRequestBodies.push({ pathname, body: request.postDataJSON() }); } catch {}
    }
  });

  await page.goto(authorization.dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#connection-label').filter({ hasText: '本机 Manager 在线' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.locator('#auth-banner').isHidden(), true);
  assert.equal(await page.locator('[data-view-panel="tasks"]').isVisible(), true);
  assert.equal(await page.locator('.nav-link').count(), 4);
  assert.equal(await page.locator('.task-card').count(), 50);
  assert.equal(await page.locator('#task-load-more').isVisible(), true);
  await page.locator('[data-task-id="task_running"]').filter({ hasText: 'Codex-抓取新闻-20260826-101500Z' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.taskId), 'task_running');
  checks.push('one-click Owner session, transient GET retry, Tasks default, and deep-link focus');

  for (const forbidden of ['/v1/agents', '/v1/dashboard/summary', '/artifacts', '/timeline', '/commands']) {
    assert.equal(requestedApiPaths.some((value) => value.includes(forbidden)), false, `Unexpected Dashboard request: ${forbidden}`);
  }
  assert.equal(await page.locator('.agent-card, dialog, [data-view-panel="agents"]').count(), 0);
  checks.push('Tasks, Profiles, Task Pack assets, and minimal Settings render without Agent or raw artifact APIs');

  await page.locator('#notification-badge').filter({ hasText: '2' }).waitFor();
  await page.getByRole('button', { name: '打开通知', exact: true }).click();
  await page.getByRole('dialog', { name: '通知', exact: true }).waitFor();
  assert.equal(await page.locator('.skip-link').getAttribute('inert'), '');
  assert.equal(await page.locator('.app-header').getAttribute('inert'), '');
  assert.equal(await page.locator('.workspace').getAttribute('inert'), '');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.querySelector('#notification-drawer')?.contains(document.activeElement)), true);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('#notification-drawer')?.contains(document.activeElement)), true);
  }
  const verificationCard = page.locator('.notification-card[data-notification-id="notice_verify"]');
  await verificationCard.getByText('已提醒 3 次', { exact: true }).waitFor();
  await verificationCard.getByRole('button', { name: '标为已读', exact: true }).click();
  await page.locator('#notification-badge').filter({ hasText: '1' }).waitFor();
  await page.getByRole('button', { name: '全部标为已读', exact: true }).click();
  await page.locator('#notification-badge').waitFor({ state: 'hidden' });
  control.degradeNextNotificationSync = true;
  await verificationCard.getByRole('button', { name: '我已接手', exact: true }).click();
  const degradedToast = page.locator('#dashboard-message').filter({
    hasText: '主任务操作已成功，但通知状态暂时同步失败；Manager 会自动重试。'
  });
  await degradedToast.waitFor();
  assert.equal(await degradedToast.evaluate((node) => node.classList.contains('warning')), true);
  await verificationCard.getByRole('button', { name: '我已接手', exact: true }).waitFor({ state: 'detached' });
  assert.deepEqual(control.notificationActions.slice(-2).map((item) => item.action), ['claim', 'focus']);
  await verificationCard.getByRole('button', { name: '打开验证窗口', exact: true }).click();
  await page.locator('#notification-drawer').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.skip-link').getAttribute('inert'), null);
  assert.equal(await page.locator('.app-header').getAttribute('inert'), null);
  assert.equal(control.notificationActions.at(-1).action, 'focus');
  await page.getByRole('button', { name: '打开通知', exact: true }).click();
  await verificationCard.getByRole('button', { name: '验证完成继续', exact: true }).click();
  await page.locator('[data-task-id="task_waiting"] .task-state-running').waitFor();
  assert.equal(control.notificationActions.at(-1).action, 'continue');
  await page.getByRole('button', { name: '关闭通知', exact: true }).click();
  await page.locator('#notification-drawer').waitFor({ state: 'hidden' });
  checks.push('durable notification badge, reminder count, read-all, claim, focus, continue, and degraded-sync warning');

  assert.equal(await page.locator('#notification-drawer #notification-settings-form').count(), 0);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '通知设置', exact: true }).waitFor();
  assert.equal(await page.locator('.setting-card').count(), 3);
  await page.locator('#notification-system-status').filter({ hasText: '已就绪' }).waitFor();
  await page.locator('#notification-telegram-status').filter({ hasText: '待配置或测试' }).waitFor();
  await page.locator('#notification-telegram-status').filter({ hasText: '••••7890' }).waitFor();
  await page.locator('#notification-feishu-status').filter({ hasText: '待配置或测试' }).waitFor();
  assert.equal(await page.locator('#notification-telegram-token').inputValue(), '');
  assert.equal(await page.locator('#notification-telegram-chat').inputValue(), '');
  await page.getByRole('button', { name: '打开系统设置', exact: true }).click();
  await page.locator('#dashboard-message').filter({ hasText: '已打开系统通知设置' }).waitFor();
  assert.equal(control.notificationSystemOpens, 1);
  const feishuTest = page.locator('.setting-card').filter({ hasText: '飞书' }).getByRole('button', { name: '发送测试' });
  assert.equal(await feishuTest.isDisabled(), true);
  await page.locator('#notification-telegram-token').fill('new-bot-token');
  await page.locator('#notification-telegram-chat').fill('99887766');
  await page.locator('#notification-feishu-enabled').check();
  await page.locator('#notification-feishu-webhook').fill('https://open.feishu.cn/open-apis/bot/v2/hook/new-secret');
  await page.locator('#notification-feishu-signing-secret').fill('feishu-signing-secret');
  await new Promise((resolve) => setTimeout(resolve, 2_200));
  assert.equal(await page.locator('#notification-feishu-enabled').isChecked(), true);
  assert.equal(await page.locator('#notification-feishu-webhook').inputValue(), 'https://open.feishu.cn/open-apis/bot/v2/hook/new-secret');
  await page.getByRole('button', { name: '保存通知设置', exact: true }).click();
  await page.locator('#dashboard-message').filter({ hasText: '通知设置已保存' }).waitFor();
  assert.equal(await page.locator('#notification-telegram-token').inputValue(), '');
  assert.equal(await page.locator('#notification-telegram-chat').inputValue(), '');
  assert.equal(await page.locator('#notification-feishu-webhook').inputValue(), '');
  assert.equal(await page.locator('#notification-feishu-signing-secret').inputValue(), '');
  assert.equal(control.notificationSettingPatches.at(-1).channels.telegram.botToken, 'new-bot-token');
  assert.equal(control.notificationSettingPatches.at(-1).channels.feishu.webhookUrl.endsWith('new-secret'), true);
  assert.equal(control.notificationSettingPatches.at(-1).channels.feishu.signingSecret, 'feishu-signing-secret');
  await page.locator('#notification-feishu-status').filter({ hasText: '已启用签名' }).waitFor();
  assert.equal(await feishuTest.isDisabled(), false);
  control.notificationTestDelayMs = 2_400;
  const telegramTest = page.locator('.setting-card').filter({ hasText: 'Telegram' }).getByRole('button', { name: '发送测试' });
  await telegramTest.click();
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal(await telegramTest.isDisabled(), true);
  assert.equal(await page.locator('#notification-settings-save').isDisabled(), true);
  assert.equal(await page.locator('#notification-system-settings').isDisabled(), true);
  assert.equal(await feishuTest.isDisabled(), true);
  assert.equal(await page.locator('.setting-card').filter({ hasText: 'Telegram' }).getByRole('button', { name: '清除凭据' }).isDisabled(), true);
  assert.equal(control.notificationTests.filter((item) => item.channel === 'telegram').length, 1);
  await page.locator('#dashboard-message').filter({ hasText: 'Telegram 测试通知已发送' }).waitFor();
  await page.locator('#notification-telegram-status').filter({ hasText: '已就绪' }).waitFor();
  await page.locator('#notification-telegram-status').filter({ hasText: '最近测试通过' }).waitFor();
  control.notificationTestDelayMs = 0;
  const telegramTestRequest = notificationRequestBodies
    .filter((entry) => entry.pathname === '/v1/notification-settings/test' && entry.body)
    .at(-1);
  assert.deepEqual(telegramTestRequest.body, { channel: 'telegram' });
  assert.equal(JSON.stringify(telegramTestRequest.body).includes('token'), false);
  control.notificationSettingsReadDelayMs = 1_200;
  const settingsReadBeforeRefresh = control.notificationSettingsReadSequence;
  await page.waitForFunction(() => {
    const button = document.querySelector('#refresh-all');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });
  await waitForCondition(
    () => control.notificationSettingsReadSequence > settingsReadBeforeRefresh,
    'the delayed notification-settings read to start'
  );
  const staleSettingsReadId = control.notificationSettingsReadSequence;
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.setting-card').filter({ hasText: 'Telegram' }).getByRole('button', { name: '清除凭据' }).click();
  await page.locator('#dashboard-message').filter({ hasText: 'Telegram 凭据已清除' }).waitFor();
  const clearedTelegram = control.notificationSettingPatches.at(-1).channels.telegram;
  assert.deepEqual(clearedTelegram, { enabled: false, botToken: null, chatId: null });
  await waitForCondition(
    () => control.notificationSettingsReadsCompleted.includes(staleSettingsReadId),
    'the stale notification-settings read to complete'
  );
  control.notificationSettingsReadDelayMs = 0;
  await page.waitForFunction(() => document.querySelector('#refresh-all')?.disabled === false);
  await page.locator('[data-channel-card="telegram"][data-channel-state="unconfigured"]').waitFor();
  assert.match(await page.locator('#notification-telegram-status').textContent(), /待配置或测试/u);
  assert.equal(await page.locator('.setting-card').filter({ hasText: 'Telegram' }).getByRole('button', { name: '发送测试' }).isDisabled(), true);
  assert.equal(await page.locator('.setting-card').filter({ hasText: 'Telegram' }).getByRole('button', { name: '清除凭据' }).isDisabled(), true);
  checks.push('bell-only notification drawer plus three-card masked settings, dirty-state and stale-read protection, channel status, system settings, signed Feishu, serialized tests, and explicit credential clearing');

  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  assert.equal(await page.getAttribute('html', 'lang'), 'en');
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByText('Effective behavior', { exact: true }).first().waitFor();
  await page.getByText('Run time', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser Profiles', exact: true }).waitFor();
  await page.locator('.profile-card').first().getByText('Operation speed', { exact: true }).first().waitFor();
  await page.locator('.profile-card').filter({ hasText: '验收账号' }).getByRole('checkbox', { name: 'Allow extensions' }).waitFor();
  await page.locator('.profile-card').filter({ hasText: '异常保留账号' }).getByRole('button', { name: 'Force-release lease' }).waitFor();
  await page.getByRole('button', { name: 'Task Packs', exact: true }).click();
  await page.getByRole('heading', { name: 'Task Pack assets', exact: true }).waitFor();
  await page.locator('.asset-card').first().getByText('Agent discoverable', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Notification settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open notifications', exact: true }).click();
  await page.getByRole('heading', { name: 'Notifications', exact: true }).waitFor();
  assert.equal(await page.locator('#notification-drawer').getByText('Notification settings', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Close notifications', exact: true }).click();
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  assert.equal(await page.getAttribute('html', 'lang'), 'zh-CN');
  await page.getByRole('button', { name: '任务', exact: true }).click();
  checks.push('complete runtime Chinese and English switching across all four views and notifications');

  const runningCard = page.locator('.task-card[data-task-id="task_running"]');
  await runningCard.getByText('正在提取第 3 批结果').waitFor();
  for (const label of ['Profile', '实际行为', '运行时间', '冷却时间', '总时间']) await runningCard.getByText(label, { exact: true }).waitFor();
  assert.equal(await runningCard.locator('[data-task-behavior]').getAttribute('data-task-behavior'), 'human');
  assert.equal(await runningCard.locator('[data-task-behavior]').getAttribute('data-task-behavior-effective'), 'human');
  assert.equal(await runningCard.locator('[data-task-behavior]').getAttribute('data-task-behavior-confirmed'), 'true');
  await runningCard.getByText(/Worker 已确认/u).waitFor();
  assert.equal((await runningCard.locator('[data-task-duration="run"]').textContent()).includes('—'), false);
  assert.equal((await runningCard.locator('[data-task-duration="cooldown"]').textContent()).includes('—'), false);
  const totalBefore = await runningCard.locator('[data-task-duration="total"]').textContent();
  await page.waitForTimeout(2_150);
  const totalAfter = await runningCard.locator('[data-task-duration="total"]').textContent();
  assert.notEqual(totalAfter, totalBefore);
  const coolingBefore = await page.locator('[data-task-id="task_cooling"] [data-task-duration="cooldown"]').textContent();
  await page.waitForFunction((before) => (
    document.querySelector('[data-task-id="task_cooling"] [data-task-duration="cooldown"]')?.textContent !== before
  ), coolingBefore, { timeout: 3_000 });
  const coolingAfter = await page.locator('[data-task-id="task_cooling"] [data-task-duration="cooldown"]').textContent();
  assert.notEqual(coolingAfter, coolingBefore);
  checks.push('progress plus live run, cooldown, and total timers');

  const coolingCard = page.locator('.task-card[data-task-id="task_cooling"]');
  const skippedHistoryCard = page.locator('.task-card[data-task-id="task_history_02"]');
  await runningCard.locator('.task-selector input').check();
  await coolingCard.locator('.task-selector input').check();
  await skippedHistoryCard.locator('.task-selector input').check();
  await page.getByRole('button', { name: '批量暂停', exact: true }).click();
  await page.locator('#task-batch-feedback .is-success').first().waitFor();
  assert.equal(await page.locator('#task-batch-feedback .is-success').count(), 2);
  assert.equal(await page.locator('#task-batch-feedback .is-skipped').count(), 1);
  assert.equal(tasks.get('task_running').state, 'paused');
  assert.equal(tasks.get('task_cooling').state, 'paused');
  await skippedHistoryCard.locator('.task-selector input').uncheck();
  await page.getByRole('button', { name: '批量恢复', exact: true }).click();
  await page.locator('#task-batch-feedback .is-success').first().waitFor();
  assert.equal(tasks.get('task_running').state, 'running');
  assert.equal(tasks.get('task_cooling').state, 'running');
  await runningCard.locator('.task-selector input').uncheck();
  await coolingCard.locator('.task-selector input').uncheck();

  const batchActiveCard = page.locator('.task-card[data-task-id="task_batch_active"]');
  await batchActiveCard.locator('.task-selector input').check();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '批量取消', exact: true }).click();
  await batchActiveCard.getByRole('button', { name: '删除记录', exact: true }).waitFor();
  assert.equal(tasks.get('task_batch_active').state, 'cancelled');
  await batchActiveCard.locator('.task-selector input').uncheck();

  const batchDeleteCards = ['task_history_00', 'task_history_01'].map((id) => page.locator(`.task-card[data-task-id="${id}"]`));
  for (const card of batchDeleteCards) await card.locator('.task-selector input').check();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '批量删除记录', exact: true }).click();
  for (const card of batchDeleteCards) await card.waitFor({ state: 'detached' });
  assert.equal(tasks.has('task_history_00'), false);
  assert.equal(tasks.has('task_history_01'), false);
  checks.push('task checkboxes plus bounded batch pause, resume, cancel, delete, and per-item success/skip feedback');

  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  const liveAccountCard = page.locator('.profile-card').filter({ hasText: '验收账号' });
  const liveExtensions = liveAccountCard.getByRole('checkbox', { name: '允许扩展运行' });
  const liveBackground = liveAccountCard.getByRole('checkbox', { name: '任务在后台运行' });
  assert.equal(await liveExtensions.isChecked(), true);
  assert.equal(await liveBackground.isDisabled(), true);
  await liveExtensions.uncheck();
  await page.locator('#dashboard-message').filter({ hasText: '扩展设置已保存；下次启动生效' }).waitFor();
  assert.equal((await manager.profileStore.get(persistent.id)).extensionsEnabled, false);
  assert.equal(await liveBackground.isDisabled(), false);
  await liveExtensions.check();
  await page.locator('#dashboard-message').filter({ hasText: '扩展设置已保存；下次启动生效' }).waitFor();
  assert.equal((await manager.profileStore.get(persistent.id)).extensionsEnabled, true);
  assert.equal(await liveBackground.isDisabled(), true);
  await liveAccountCard.locator('select').selectOption('fast');
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await runningCard.locator('[data-task-behavior="fast"][data-task-behavior-effective="fast"][data-task-behavior-confirmed="true"]').waitFor();
  await runningCard.getByText('Worker 已确认', { exact: false }).waitFor();
  checks.push('task card refreshes from a Worker-confirmed live behavior receipt');

  control.conflictNextPause = true;
  await runningCard.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('#dashboard-message').filter({ hasText: '状态已变化' }).waitFor();
  assert.equal(tasks.get('task_running').state, 'running');

  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('[data-task-id="task_running"] button')]
      .find((node) => node.textContent?.trim() === '暂停');
    return Boolean(button && !button.disabled);
  });

  const pauseRequestsBefore = control.taskActions.filter((value) => value.action === 'pause').length;
  await page.locator('[data-task-id="task_running"] button').filter({ hasText: '暂停' }).evaluate((node) => {
    node.click();
    node.click();
  });
  await page.locator('[data-task-id="task_running"] button').filter({ hasText: '恢复' }).waitFor();
  assert.equal(control.taskActions.filter((value) => value.action === 'pause').length, pauseRequestsBefore + 1);
  await page.locator('[data-task-id="task_running"] button').filter({ hasText: '恢复' }).click();
  await page.locator('[data-task-id="task_running"] button').filter({ hasText: '暂停' }).waitFor();
  assert.deepEqual(control.taskActions.slice(-2).map((value) => value.action), ['pause', 'resume']);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-task-id="task_running"] button').filter({ hasText: '取消' }).click();
  await page.locator('[data-task-id="task_running"] button').filter({ hasText: '删除记录' }).waitFor();
  assert.equal(tasks.get('task_running').cleanup.settled, true);
  checks.push('409 refresh, double-submit guard, pause, resume, and cleanup-proved cancel');

  const completedCard = page.locator('.task-card[data-task-id="task_completed"]');
  await completedCard.getByText('查看 Agent 最终报告', { exact: true }).click();
  await completedCard.getByText('表单验收报告', { exact: true }).waitFor();
  await completedCard.getByText('5 项表单检查全部通过。', { exact: true }).waitFor();
  await page.waitForTimeout(2_500);
  assert.equal(await completedCard.locator('details.task-report').getAttribute('open'), '');
  await completedCard.getByRole('heading', { name: '结论', exact: true }).waitFor();
  await completedCard.getByText('没有发现需要人工处理的异常。', { exact: true }).waitFor();
  checks.push('bounded final Agent report renders as readable owner content');
  page.once('dialog', (dialog) => dialog.accept());
  await completedCard.getByRole('button', { name: '删除记录' }).click();
  await completedCard.waitFor({ state: 'detached' });
  assert.equal(tasks.has('task_completed'), false);
  assert.equal(control.deleteRequests, 3);
  assert.match(await page.evaluate(() => document.activeElement?.dataset.focusKey || document.activeElement?.id || ''), /^(?:task:|tasks-title)/u);
  checks.push('settled task record deletion and deterministic focus recovery');

  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'profiles-title');
  const quarantinedCard = page.locator('.profile-card').filter({ hasText: '异常保留账号' });
  if (profileRecoveryScreenshotPath) {
    await mkdir(path.dirname(profileRecoveryScreenshotPath), { recursive: true });
    await quarantinedCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: profileRecoveryScreenshotPath });
  }
  page.once('dialog', (dialog) => dialog.accept());
  await quarantinedCard.getByRole('button', { name: '强制解除租约', exact: true }).click();
  await page.locator('#dashboard-message').filter({ hasText: 'Profile 租约已强制解除' }).waitFor();
  assert.equal((await manager.profileStore.get(quarantined.id)).state, 'idle');
  assert.equal(await readFile(
    path.join(quarantined.userDataDir, 'login-state-marker.txt'),
    'utf8'
  ), 'preserved');
  checks.push('Owner-confirmed persistent Profile lease release preserves browser data and clears only the stale lease');
  await page.getByRole('button', { name: '新建 Profile' }).click();
  assert.equal(await page.locator('#profile-mode').inputValue(), 'human');
  await page.locator('#profile-name').fill('UI 临时');
  await page.locator('#profile-kind').selectOption('ephemeral');
  assert.equal(await page.locator('#profile-mode').inputValue(), 'auto');
  await page.getByRole('button', { name: '创建 Profile' }).click();
  const temporaryCard = page.locator('.profile-card').filter({ hasText: 'UI 临时' });
  await temporaryCard.waitFor();
  assert.equal(await temporaryCard.locator('select').inputValue(), 'auto');
  assert.equal(await temporaryCard.getByRole('checkbox', { name: '允许扩展运行' }).count(), 0);
  await temporaryCard.locator('select').selectOption('human');
  await temporaryCard.getByText('深度拟人', { exact: true }).first().waitFor();
  await temporaryCard.locator('input[type="checkbox"]').check();

  const accountCard = page.locator('.profile-card').filter({ hasText: '验收账号' });
  page.once('dialog', (dialog) => dialog.accept('主账号'));
  await accountCard.getByRole('button', { name: '改名' }).click();
  const renamedCard = page.locator('.profile-card').filter({ hasText: '主账号' });
  await renamedCard.waitFor();
  assert.deepEqual(
    await renamedCard.locator('select option').evaluateAll((options) => options.map((option) => option.value)),
    ['fast', 'auto', 'human']
  );
  await renamedCard.locator('select').selectOption('human');
  await renamedCard.getByText('深度拟人', { exact: true }).first().waitFor();
  assert.deepEqual(control.behaviorChanges.at(-1), { id: persistent.id, behavior: 'human' });
  await renamedCard.getByRole('button', { name: '打开登录窗口' }).click();
  await renamedCard.getByRole('button', { name: '关闭窗口' }).waitFor();
  await renamedCard.getByRole('checkbox', { name: '允许扩展运行' }).uncheck();
  await page.locator('#dashboard-message').filter({ hasText: '当前窗口不会重启，关闭后生效' }).waitFor();
  await renamedCard.getByRole('checkbox', { name: '允许扩展运行' }).check();
  await page.locator('#dashboard-message').filter({ hasText: '当前窗口不会重启，关闭后生效' }).waitFor();
  await renamedCard.getByRole('button', { name: '关闭窗口' }).click();
  await renamedCard.getByRole('button', { name: '打开登录窗口' }).waitFor();

  page.once('dialog', (dialog) => dialog.accept());
  await temporaryCard.getByRole('button', { name: '删除' }).click();
  await temporaryCard.waitFor({ state: 'detached' });
  checks.push('Profile defaults, extension next-launch policy, fast/auto/human live control, create, edit, rename, open, close, and delete');

  await page.getByRole('button', { name: 'Task Packs', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'assets-title');
  assert.equal(await page.locator('.asset-card').count(), 4);
  const packCard = page.locator('.asset-card').filter({ hasText: '新闻采集 Pack' });
  await packCard.getByText('Agent 可发现', { exact: true }).waitFor();
  await packCard.getByText('生产使用', { exact: true }).waitFor();
  await packCard.getByText('12', { exact: true }).waitFor();
  await packCard.getByText(/不可删除/u).waitFor();
  await packCard.getByText('任务仍可从检查点恢复', { exact: true }).waitFor();
  await packCard.getByRole('button', { name: '查看关联任务', exact: true }).click();
  const blockerCard = page.locator('.task-card[data-task-id="task_pack_blocker"]');
  await blockerCard.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.taskId), 'task_pack_blocker');
  assert.equal(new URL(page.url()).searchParams.get('task'), 'task_pack_blocker');
  assert.equal(await page.locator('.task-card').count(), 51);
  const loadMoreTasks = page.getByRole('button', { name: '加载更多任务', exact: true });
  while (await loadMoreTasks.isVisible()) {
    await loadMoreTasks.click();
    await page.waitForFunction(() => {
      const node = document.querySelector('#task-load-more');
      return node?.hidden === true || node?.disabled === false;
    });
  }
  await page.locator('#task-load-more').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.task-card').count(), tasks.size);
  assert.equal(await page.locator('.task-card[data-task-id="task_pack_blocker"]').count(), 1);
  const externallyDeletedHistory = page.locator('.task-card[data-task-id="task_history_03"]');
  tasks.delete('task_history_03');
  await page.locator('#refresh-all').click();
  await externallyDeletedHistory.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.task-card').count(), tasks.size);
  checks.push('Pack blocker deep-link loads and highlights an off-page task; three-page cursors merge without duplicates and explicit refresh reconciles history');
  await page.getByRole('button', { name: 'Task Packs', exact: true }).click();
  const refreshedPackCard = page.locator('.asset-card').filter({ hasText: '新闻采集 Pack' });
  await refreshedPackCard.locator('input[type="checkbox"]').check();
  assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
  await refreshedPackCard.locator('input[type="checkbox"]').uncheck();

  await page.locator('#asset-search').fill('活动');
  assert.equal(await page.locator('.asset-card').count(), 1);
  let campaignCard = page.locator('.asset-card').filter({ hasText: '一次性活动探针' });
  await campaignCard.locator('input[type="checkbox"]').check();
  page.once('dialog', (dialog) => dialog.accept('已复核，可在同类活动复用'));
  await page.getByRole('button', { name: '批量备注' }).click();
  campaignCard = page.locator('.asset-card').filter({ hasText: '一次性活动探针' });
  await campaignCard.getByText('已复核，可在同类活动复用', { exact: true }).waitFor();
  await campaignCard.locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await campaignCard.getByText('Agent 可发现', { exact: true }).waitFor();
  await campaignCard.locator('input[type="checkbox"]').check();
  await page.getByRole('button', { name: '废弃', exact: true }).click();
  await campaignCard.getByText('已废弃', { exact: true }).waitFor();
  await campaignCard.locator('input[type="checkbox"]').check();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await campaignCard.waitFor({ state: 'detached' });

  await page.locator('#asset-search').fill('');
  await page.locator('#asset-filter').selectOption('history');
  assert.equal(await page.locator('.asset-card').count(), 1);
  const orphanCard = page.locator('.asset-card').filter({ hasText: 'old-demo（孤立快照）' });
  await page.locator('#asset-select-all').check();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await orphanCard.waitFor({ state: 'detached' });
  await page.locator('#asset-filter').selectOption('all');
  assert.equal(await page.locator('.asset-card').count(), 2);
  assert.deepEqual(control.assetActions.map((entry) => entry.action), ['note', 'restore', 'deprecate', 'delete', 'delete']);
  checks.push('asset purpose, discovery, usage, notes, search, filters, protected state, and batch lifecycle deletion');

  if (screenshotPath) {
    await page.getByRole('button', { name: '任务', exact: true }).click();
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }

  await manager.stop();
  manager = await startManager(managerPort);
  await page.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.locator('#connection-label').filter({ hasText: '本机 Manager 在线' }).waitFor();
  assert.equal(await page.locator('#auth-banner').isHidden(), true);
  checks.push('fixed bookmark and Owner cookie survive Manager restart');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: '任务', exact: true }).click();
  const mobile = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    taskOverflow: [...document.querySelectorAll('.task-card')].some((node) => node.scrollWidth > node.clientWidth),
    shortTargets: [...document.querySelectorAll('button, a.skip-link')]
      .filter((node) => !node.hidden && getComputedStyle(node).display !== 'none')
      .map((node) => node.getBoundingClientRect().height)
      .filter((height) => height > 0 && height < 44),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
  }));
  assert.equal(mobile.scrollWidth <= mobile.innerWidth, true);
  assert.equal(mobile.taskOverflow, false);
  assert.deepEqual(mobile.shortTargets, []);
  assert.equal(mobile.reducedMotion, true);
  await page.getByRole('button', { name: 'Task Packs', exact: true }).click();
  const assetMobile = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    assetOverflow: [...document.querySelectorAll('.asset-card')].some((node) => node.scrollWidth > node.clientWidth),
    shortTargets: [...document.querySelectorAll('button, select, a.skip-link')]
      .filter((node) => !node.hidden && getComputedStyle(node).display !== 'none')
      .map((node) => node.getBoundingClientRect().height)
      .filter((height) => height > 0 && height < 44)
  }));
  assert.equal(assetMobile.scrollWidth <= assetMobile.innerWidth, true);
  assert.equal(assetMobile.assetOverflow, false);
  assert.deepEqual(assetMobile.shortTargets, []);
  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settingsMobile = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    cardCount: document.querySelectorAll('.setting-card').length,
    cardOverflow: [...document.querySelectorAll('.setting-card')].some((node) => node.scrollWidth > node.clientWidth),
    shortTargets: [...document.querySelectorAll('#view-settings button, #view-settings input:not([type="checkbox"])')]
      .filter((node) => !node.hidden && getComputedStyle(node).display !== 'none')
      .map((node) => node.getBoundingClientRect().height)
      .filter((height) => height > 0 && height < 44)
  }));
  assert.equal(settingsMobile.scrollWidth <= settingsMobile.innerWidth, true);
  assert.equal(settingsMobile.cardCount, 3);
  assert.equal(settingsMobile.cardOverflow, false);
  assert.deepEqual(settingsMobile.shortTargets, []);
  await page.getByRole('button', { name: 'Open notifications', exact: true }).click();
  const englishMobile = await page.evaluate(() => ({
    language: document.documentElement.lang,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
    drawerOverflow: document.querySelector('#notification-drawer').scrollWidth > document.querySelector('#notification-drawer').clientWidth,
    shortTargets: [...document.querySelectorAll('#notification-drawer button, #notification-drawer input:not([type="checkbox"]), #notification-drawer summary')]
      .filter((node) => !node.hidden && getComputedStyle(node).display !== 'none')
      .map((node) => node.getBoundingClientRect().height)
      .filter((height) => height > 0 && height < 44)
  }));
  assert.equal(englishMobile.language, 'en');
  assert.equal(englishMobile.scrollWidth <= englishMobile.innerWidth, true);
  assert.equal(englishMobile.drawerOverflow, false);
  assert.deepEqual(englishMobile.shortTargets, []);
  await page.getByRole('button', { name: 'Close notifications', exact: true }).click();
  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
  checks.push('bilingual mobile tasks, assets, three-card settings, notification drawer, 44px targets, keyboard focus, and reduced motion');

  const unauthorizedContext = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const unauthorizedPage = await unauthorizedContext.newPage();
  await unauthorizedPage.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
  await unauthorizedPage.locator('#auth-banner').waitFor({ state: 'visible' });
  assert.equal(await unauthorizedPage.locator('.task-card').count(), 0);
  assert.equal(await unauthorizedPage.locator('.profile-card').count(), 0);
  assert.equal(await unauthorizedPage.locator('.asset-card').count(), 0);
  await unauthorizedContext.close();
  checks.push('unauthorized browser receives no cached task or Profile data');

  assert.deepEqual(pageErrors, []);
  const report = {
    ok: true,
    version: VERSION,
    browser: 'playwright-chromium',
    checks,
    taskActions: control.taskActions.map((value) => value.action),
    deleteRequests: control.deleteRequests,
    assetActions: control.assetActions.map((value) => value.action),
    pageErrors
  };
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser?.close().catch(() => {});
  await manager?.stop().catch(() => {});
  await rm(temporaryRoot, { recursive: true, force: true });
}
