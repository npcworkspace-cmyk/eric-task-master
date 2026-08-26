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
  deleteRequests: 0
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
    defaultBehavior: 'adaptive',
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
    createdAt: ago(180_000),
    startedAt: ago(170_000),
    finishedAt: ago(20_000),
    updatedAt: ago(20_000),
    currentActivity: { phase: 'completed', status: 'succeeded', updatedAt: ago(20_000) },
    progress: { current: 5, total: 5, message: '全部完成', updatedAt: ago(20_000) },
    timing: { version: 1, cooldownDurationMs: 12_000, activeCooldownStartedAt: null },
    history: [{ attempt: 1, workerStartedAt: ago(170_000), finishedAt: ago(20_000) }],
    cleanup: { browserClosed: true, workerExited: true, leaseReleased: true, settled: true },
    completion: { integrity: 'valid', verifiedAt: ago(20_000) }
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
  assert.equal(await page.locator('.nav-link').count(), 2);
  assert.equal(await page.locator('.task-card').count(), 3);
  await page.locator('[data-task-id="task_running"]').filter({ hasText: 'Codex-抓取新闻-20260826-101500Z' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.taskId), 'task_running');
  checks.push('one-click Owner session, transient GET retry, Tasks default, and deep-link focus');

  for (const forbidden of ['/v1/agents', '/v1/dashboard/summary', '/artifacts', '/timeline', '/commands']) {
    assert.equal(requestedApiPaths.some((value) => value.includes(forbidden)), false, `Unexpected Dashboard request: ${forbidden}`);
  }
  assert.equal(await page.locator('.agent-card, dialog, [data-view-panel="agents"]').count(), 0);
  checks.push('only Tasks and Profiles are rendered and no secondary APIs are fetched');

  const runningCard = page.locator('.task-card[data-task-id="task_running"]');
  await runningCard.getByText('正在提取第 3 批结果').waitFor();
  for (const label of ['Profile', '运行时间', '冷却时间', '总时间']) await runningCard.getByText(label, { exact: true }).waitFor();
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
  await page.locator('#profile-name').fill('UI 临时');
  await page.locator('#profile-kind').selectOption('ephemeral');
  await page.locator('#profile-mode').selectOption('adaptive');
  await page.getByRole('button', { name: '创建 Profile' }).click();
  const temporaryCard = page.locator('.profile-card').filter({ hasText: 'UI 临时' });
  await temporaryCard.waitFor();
  await temporaryCard.locator('select').selectOption('human');
  await temporaryCard.getByText('深度拟人', { exact: true }).first().waitFor();
  await temporaryCard.locator('input[type="checkbox"]').check();

  const accountCard = page.locator('.profile-card').filter({ hasText: '验收账号' });
  page.once('dialog', (dialog) => dialog.accept('主账号'));
  await accountCard.getByRole('button', { name: '改名' }).click();
  const renamedCard = page.locator('.profile-card').filter({ hasText: '主账号' });
  await renamedCard.waitFor();
  await renamedCard.getByRole('button', { name: '打开登录窗口' }).click();
  await renamedCard.getByRole('button', { name: '关闭窗口' }).waitFor();
  await renamedCard.getByRole('button', { name: '关闭窗口' }).click();
  await renamedCard.getByRole('button', { name: '打开登录窗口' }).waitFor();

  page.once('dialog', (dialog) => dialog.accept());
  await temporaryCard.getByRole('button', { name: '删除' }).click();
  await temporaryCard.waitFor({ state: 'detached' });
  checks.push('Profile create, edit, rename, open, close, and delete');

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
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
  checks.push('mobile layout, 44px targets, keyboard focus, and reduced motion');

  const unauthorizedContext = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const unauthorizedPage = await unauthorizedContext.newPage();
  await unauthorizedPage.goto(`${baseUrl}/dashboard`, { waitUntil: 'domcontentloaded' });
  await unauthorizedPage.locator('#auth-banner').waitFor({ state: 'visible' });
  assert.equal(await unauthorizedPage.locator('.task-card').count(), 0);
  assert.equal(await unauthorizedPage.locator('.profile-card').count(), 0);
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
