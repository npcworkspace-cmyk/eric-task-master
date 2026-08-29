#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

function now() {
  return new Date().toISOString();
}

function ago(ms) {
  return new Date(Date.now() - ms).toISOString();
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
    async list() {
      if (control.listFailures > 0) {
        control.listFailures -= 1;
        throw serviceError(503, 'FIXTURE_TRANSIENT', 'Transient fixture read failure');
      }
      return [...tasks.values()].map((value) => structuredClone(value));
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
    async openProfile(id) {
      const ownerId = `profile-open:dashboard-acceptance:${id}`;
      await profileStore.acquireLease(id, ownerId, { pid: process.pid, ttlMs: 60_000 });
      openOwners.set(id, ownerId);
    },
    async closeProfile(id) {
      const ownerId = openOwners.get(id);
      if (ownerId) await profileStore.releaseLease(id, ownerId);
      openOwners.delete(id);
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
        await profileStore.releaseLease(id, ownerId).catch(() => {});
      }
      openOwners.clear();
    }
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
  assets: [
    {
      id: 'pack:news-pack@2.0.0', kind: 'pack', source: 'task-pack', name: 'news-pack', version: '2.0.0',
      title: '新闻采集 Pack', description: '按站点探针、分页与验收流程采集公开新闻。', note: '生产使用',
      lifecycle: 'active', discoverable: true, protected: false, transient: false,
      taskTypes: [{ name: 'news.collect.v2', title: '新闻采集', lifecycle: 'active', discoverable: true }],
      fileCount: 1, sizeBytes: 4_096, installedAt: ago(86_400_000),
      usage: { runCount: 12, successCount: 10, failureCount: 2, activeCount: 1, states: { completed: 10, failed: 2 }, lastUsedAt: now() },
      canEditNote: true, canChangeLifecycle: true, deletable: false, deleteBlockers: ['任务 Codex-抓取新闻 尚未完成安全清理']
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

  control.listFailures = 1;
  const authorization = await jsonRequest(baseUrl, '/v1/dashboard/authorize', {
    method: 'POST', token: manager.token, body: { focusTaskId: 'task_running' }
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  const requestedApiPaths = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith('/v1/')) requestedApiPaths.push(pathname);
  });

  await page.goto(authorization.dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#connection-label').filter({ hasText: '本机 Manager 在线' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.locator('#auth-banner').isHidden(), true);
  assert.equal(await page.locator('[data-view-panel="tasks"]').isVisible(), true);
  assert.equal(await page.locator('.nav-link').count(), 3);
  assert.equal(await page.locator('.task-card').count(), 3);
  await page.locator('[data-task-id="task_running"]').filter({ hasText: 'Codex-抓取新闻-20260826-101500Z' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.taskId), 'task_running');
  checks.push('one-click Owner session, transient GET retry, Tasks default, and deep-link focus');

  for (const forbidden of ['/v1/agents', '/v1/dashboard/summary', '/artifacts', '/timeline', '/commands']) {
    assert.equal(requestedApiPaths.some((value) => value.includes(forbidden)), false, `Unexpected Dashboard request: ${forbidden}`);
  }
  assert.equal(await page.locator('.agent-card, dialog, [data-view-panel="agents"]').count(), 0);
  checks.push('Tasks, Profiles, and Task Pack assets are rendered without Agent or raw artifact APIs');

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
  await page.waitForTimeout(1_150);
  const totalAfter = await runningCard.locator('[data-task-duration="total"]').textContent();
  assert.notEqual(totalAfter, totalBefore);
  const coolingBefore = await page.locator('[data-task-id="task_cooling"] [data-task-duration="cooldown"]').textContent();
  await page.waitForTimeout(1_050);
  const coolingAfter = await page.locator('[data-task-id="task_cooling"] [data-task-duration="cooldown"]').textContent();
  assert.notEqual(coolingAfter, coolingBefore);
  checks.push('progress plus live run, cooldown, and total timers');

  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  const liveAccountCard = page.locator('.profile-card').filter({ hasText: '验收账号' });
  await liveAccountCard.locator('select').selectOption('fast');
  await page.getByRole('button', { name: '任务', exact: true }).click();
  await runningCard.locator('[data-task-behavior="fast"][data-task-behavior-effective="fast"][data-task-behavior-confirmed="true"]').waitFor();
  await runningCard.getByText('Worker 已确认', { exact: false }).waitFor();
  checks.push('task card refreshes from a Worker-confirmed live behavior receipt');

  control.conflictNextPause = true;
  await runningCard.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('#dashboard-message').filter({ hasText: '状态已变化' }).waitFor();
  assert.equal(tasks.get('task_running').state, 'running');

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
  await completedCard.getByRole('heading', { name: '结论', exact: true }).waitFor();
  await completedCard.getByText('没有发现需要人工处理的异常。', { exact: true }).waitFor();
  checks.push('bounded final Agent report renders as readable owner content');
  page.once('dialog', (dialog) => dialog.accept());
  await completedCard.getByRole('button', { name: '删除记录' }).click();
  await completedCard.waitFor({ state: 'detached' });
  assert.equal(tasks.has('task_completed'), false);
  assert.equal(control.deleteRequests, 1);
  assert.match(await page.evaluate(() => document.activeElement?.dataset.focusKey || document.activeElement?.id || ''), /^(?:task:|tasks-title)/u);
  checks.push('settled task record deletion and deterministic focus recovery');

  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'profiles-title');
  await page.getByRole('button', { name: '新建 Profile' }).click();
  assert.equal(await page.locator('#profile-mode').inputValue(), 'human');
  await page.locator('#profile-name').fill('UI 临时');
  await page.locator('#profile-kind').selectOption('ephemeral');
  assert.equal(await page.locator('#profile-mode').inputValue(), 'auto');
  await page.getByRole('button', { name: '创建 Profile' }).click();
  const temporaryCard = page.locator('.profile-card').filter({ hasText: 'UI 临时' });
  await temporaryCard.waitFor();
  assert.equal(await temporaryCard.locator('select').inputValue(), 'auto');
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
  await renamedCard.getByRole('button', { name: '关闭窗口' }).click();
  await renamedCard.getByRole('button', { name: '打开登录窗口' }).waitFor();

  page.once('dialog', (dialog) => dialog.accept());
  await temporaryCard.getByRole('button', { name: '删除' }).click();
  await temporaryCard.waitFor({ state: 'detached' });
  checks.push('Profile defaults, fast/auto/human live control, create, edit, rename, open, close, and delete');

  await page.getByRole('button', { name: 'Task Packs', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'assets-title');
  assert.equal(await page.locator('.asset-card').count(), 4);
  const packCard = page.locator('.asset-card').filter({ hasText: '新闻采集 Pack' });
  await packCard.getByText('Agent 可发现', { exact: true }).waitFor();
  await packCard.getByText('生产使用', { exact: true }).waitFor();
  await packCard.getByText('12', { exact: true }).waitFor();
  await packCard.getByText(/不可删除/u).waitFor();
  await packCard.locator('input[type="checkbox"]').check();
  assert.equal(await page.getByRole('button', { name: '删除', exact: true }).isDisabled(), true);
  await packCard.locator('input[type="checkbox"]').uncheck();

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
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
  checks.push('mobile layout, 44px targets, keyboard focus, and reduced motion');

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
