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

  function assertRevision(value, expectedRevision) {
    if (value.revision !== expectedRevision) {
      throw serviceError(409, 'TASK_REVISION_CONFLICT', 'Task revision changed');
    }
  }

  function event(value, type, message) {
    value.timeline ??= [];
    value.timeline.push({
      id: `event_${value.timeline.length + 1}`,
      sequence: value.timeline.length + 1,
      type,
      message,
      createdAt: now()
    });
    value.updatedAt = now();
  }

  function revise(value, patch) {
    Object.assign(value, patch);
    value.revision += 1;
    value.updatedAt = now();
    return structuredClone(value);
  }

  return {
    async schedulerStatus() {
      if (control.summaryFailures > 0) {
        control.summaryFailures -= 1;
        throw serviceError(503, 'FIXTURE_TRANSIENT', 'Transient fixture read failure');
      }
      const values = [...tasks.values()];
      return {
        running: values.filter((value) => ['running', 'paused', 'pause_requested'].includes(value.state)).length,
        queued: values.filter((value) => value.state === 'queued').length,
        total: values.length
      };
    },
    async list() {
      return [...tasks.values()].map((value) => structuredClone(value));
    },
    async get(id) {
      return structuredClone(task(id));
    },
    async listArtifacts(id) {
      task(id);
      return id === 'task_completed'
        ? [{ id: 'artifact_report', name: 'report.json', mimeType: 'application/json', sizeBytes: 512 }]
        : [];
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
      const value = task(id);
      if (control.denyNextPause) {
        control.denyNextPause = false;
        throw serviceError(403, 'FIXTURE_DENIED', 'Fixture denied this pause');
      }
      if (control.conflictNextPause) {
        control.conflictNextPause = false;
        value.revision += 1;
        event(value, 'fixture.concurrent', 'A concurrent update changed the revision');
        throw serviceError(409, 'TASK_REVISION_CONFLICT', 'Fixture changed task revision');
      }
      assertRevision(value, body.expectedRevision);
      event(value, 'task.paused', 'Owner paused the task');
      return revise(value, { state: 'paused', health: { status: 'paused', checkedAt: now() } });
    },
    async resumePausedTask(id, body) {
      const value = task(id);
      assertRevision(value, body.expectedRevision);
      event(value, 'task.resumed', 'Owner resumed the task');
      return revise(value, {
        state: 'running',
        currentActivity: { phase: 'extracting', status: 'active', updatedAt: now() },
        health: { status: 'healthy', checkedAt: now() }
      });
    },
    async terminateTask(id, body) {
      const value = task(id);
      assertRevision(value, body.expectedRevision);
      event(value, 'task.cancelled', 'Owner terminated the task after cleanup');
      return revise(value, {
        state: 'cancelled',
        finishedAt: now(),
        cleanup: { browserClosed: true, workerExited: true, leaseReleased: true, settled: true }
      });
    },
    async submitTaskCommand(id, body) {
      const value = task(id);
      assertRevision(value, body.expectedRevision);
      value.commands ??= [];
      value.commands.push({
        commandId: body.commandId,
        kind: body.kind,
        status: 'pending',
        expectedRevision: body.expectedRevision,
        payload: { message: body.message },
        createdAt: now(),
        updatedAt: now()
      });
      control.commands.push({ taskId: id, kind: body.kind, message: body.message });
      event(value, 'command.created', body.message);
      return revise(value, {});
    },
    async continueTask(id, body) {
      const value = task(id);
      if (value.state !== 'waiting_user') throw serviceError(409, 'TASK_NOT_WAITING', 'Task is not waiting');
      if (body.requestId && body.requestId !== value.userRequest?.id) {
        throw serviceError(409, 'TASK_REQUEST_MISMATCH', 'Request ID changed');
      }
      control.continuations.push({ taskId: id, note: body.note });
      event(value, 'task.continued', body.note || 'Continued');
      return revise(value, {
        state: 'running',
        userRequest: null,
        currentActivity: { phase: 'navigating', status: 'active', updatedAt: now() },
        health: { status: 'healthy', checkedAt: now() }
      });
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

async function expectText(locator, text) {
  await locator.filter({ hasText: text }).first().waitFor({ state: 'visible' });
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-dashboard-acceptance-'));
const dataDir = path.join(temporaryRoot, 'state');
const tasks = new Map();
const control = {
  summaryFailures: 1,
  denyNextPause: false,
  conflictNextPause: false,
  commands: [],
  continuations: []
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
    name: 'Acceptance Account',
    kind: 'persistent',
    browserEngine: 'chrome',
    defaultBehavior: 'human',
    headless: false
  });
  const ephemeral = await manager.profileStore.create({
    name: 'Acceptance Temporary',
    kind: 'ephemeral',
    browserEngine: 'chromium',
    defaultBehavior: 'adaptive',
    headless: true
  });

  for (const [clientId, name, connectionId] of [
    ['agent-alpha', 'Alpha Agent', 'acceptance-alpha'],
    ['agent-beta', 'Beta Agent', 'acceptance-beta']
  ]) {
    await jsonRequest(baseUrl, '/v1/agents/issue', {
      method: 'POST',
      token: manager.token,
      body: { clientId, name, connectionId }
    });
  }

  const startedAt = now();
  const longReportToken = 'R'.repeat(12_000);
  tasks.set('task_running', {
    id: 'task_running', jobId: 'job_running', revision: 1,
    profileId: persistent.id, taskType: 'ui.running', ownerRole: 'agent', ownerClientId: 'agent-alpha', ownerAgentName: 'Alpha Agent',
    state: 'running', createdAt: startedAt, startedAt,
    currentActivity: { phase: 'extracting', status: 'active', updatedAt: startedAt },
    progress: { current: 3, total: 10, message: '正在提取第 3 批结果', updatedAt: startedAt },
    health: { status: 'healthy', checkedAt: startedAt },
    cleanup: { browserClosed: false, workerExited: false, leaseReleased: false, settled: false },
    timeline: [{ id: 'event_running', sequence: 1, type: 'task.started', message: '浏览器任务已开始', createdAt: startedAt }],
    commands: []
  });
  tasks.set('task_waiting', {
    id: 'task_waiting', jobId: 'job_waiting', revision: 1,
    profileId: ephemeral.id, taskType: 'ui.waiting', ownerRole: 'agent', ownerClientId: 'agent-beta', ownerAgentName: 'Beta Agent',
    state: 'waiting_user', createdAt: startedAt, startedAt,
    currentActivity: { phase: 'waiting_user', status: 'waiting', updatedAt: startedAt },
    progress: { current: 1, total: 2, message: '等待确认下一步', updatedAt: startedAt },
    health: { status: 'waiting_user', checkedAt: startedAt },
    userRequest: { id: 'request_waiting', reason: '请选择继续方向', instructions: '回复下一步指令', requestedAt: startedAt },
    cleanup: { browserClosed: false, workerExited: false, leaseReleased: false, settled: false },
    timeline: []
  });
  tasks.set('task_completed', {
    id: 'task_completed', jobId: 'job_completed', revision: 4,
    profileId: ephemeral.id, taskType: 'ui.completed', ownerRole: 'agent', ownerClientId: 'agent-alpha', ownerAgentName: 'Alpha Agent',
    state: 'completed', createdAt: startedAt, startedAt, finishedAt: now(),
    currentActivity: { phase: 'completed', status: 'succeeded', updatedAt: now() },
    progress: { current: 5, total: 5, message: '全部完成', updatedAt: now() },
    health: { status: 'completed', checkedAt: now() },
    cleanup: { browserClosed: true, workerExited: true, leaseReleased: true, settled: true },
    completion: { integrity: 'valid', verifiedAt: now() },
    result: { summary: '已处理 5 个页面', evidence: [{ kind: 'count', value: 5 }] },
    report: {
      reportId: 'report_completed', status: 'final', title: '验收任务最终报告',
      summary: '面板应首先展示这份人类可读报告，而不是代码或日志。',
      sections: [
        { heading: '结果', body: '**5/5** 页面完成，并保留了可审计证据。' },
        { heading: '长文本换行验收', body: longReportToken }
      ],
      author: { role: 'agent', clientId: 'agent-alpha', name: 'Alpha Agent' }, publishedAt: now()
    },
    timeline: [{ id: 'event_done', sequence: 1, type: 'report.published', message: '最终报告已发布', createdAt: now() }]
  });

  const authorization = await jsonRequest(baseUrl, '/v1/dashboard/authorize', {
    method: 'POST', token: manager.token, body: { focusTaskId: 'task_completed' }
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  let agentActionRequests = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (/\/v1\/agents\/[^/]+\/actions$/u.test(new URL(request.url()).pathname)) agentActionRequests += 1;
  });
  await page.goto(authorization.dashboardUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#connection-label').filter({ hasText: '本机 Manager 在线' }).waitFor();
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.locator('#auth-banner').isHidden(), true);
  checks.push('one-click cookie bootstrap and transient GET retry');

  await page.getByRole('button', { name: '关闭任务详情' }).click();

  for (const [name, panel] of [['总览', 'overview'], ['Agents', 'agents'], ['Profiles', 'profiles'], ['任务', 'tasks']]) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.locator(`[data-view-panel="${panel}"]`).waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), `${panel}-title`);
  }
  checks.push('all four navigation areas move focus to the active heading');

  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  assert.equal(await page.locator('.agent-card').count(), 2);
  const alphaCard = page.locator('.agent-card').filter({ hasText: 'Alpha Agent' });
  const revokeBox = await alphaCard.getByRole('button', { name: '撤销接入' }).boundingBox();
  assert.ok(revokeBox);
  page.once('dialog', (dialog) => dialog.accept());
  await alphaCard.getByRole('button', { name: '撤销接入' }).click();
  const restoreButton = alphaCard.getByRole('button', { name: '恢复接入' });
  await restoreButton.waitFor();
  assert.equal(await restoreButton.isDisabled(), true);
  await page.mouse.click(revokeBox.x + revokeBox.width / 2, revokeBox.y + revokeBox.height / 2);
  await page.waitForTimeout(120);
  assert.equal(agentActionRequests, 1);
  await page.waitForFunction(() => {
    const card = [...document.querySelectorAll('.agent-card')].find((node) => node.textContent.includes('Alpha Agent'));
    const button = [...(card?.querySelectorAll('button') || [])].find((node) => node.textContent.includes('恢复接入'));
    return Boolean(button && !button.disabled);
  });
  page.once('dialog', (dialog) => dialog.accept());
  await alphaCard.getByRole('button', { name: '恢复接入' }).click();
  await alphaCard.getByRole('button', { name: '撤销接入' }).waitFor();
  assert.equal(agentActionRequests, 2);
  checks.push('Agent revoke, double-click suppression, explicit restore, and final state');

  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await page.getByRole('button', { name: '新建 Profile' }).click();
  await page.locator('#profile-name').fill('UI Temporary');
  await page.locator('#profile-kind').selectOption('ephemeral');
  await page.locator('#profile-mode').selectOption('adaptive');
  await page.getByRole('button', { name: '创建 Profile' }).click();
  const temporaryCard = page.locator('.profile-card').filter({ hasText: 'UI Temporary' });
  await temporaryCard.waitFor();
  await page.locator('#profile-create-panel').waitFor({ state: 'hidden' });
  const modeFocusKey = await temporaryCard.locator('select').getAttribute('data-focus-key');
  await temporaryCard.locator('select').focus();
  await temporaryCard.locator('select').selectOption('human');
  await expectText(temporaryCard, '深度拟人');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey || document.activeElement?.tagName), modeFocusKey);
  const headlessFocusKey = await temporaryCard.locator('input[type="checkbox"]').getAttribute('data-focus-key');
  await temporaryCard.locator('input[type="checkbox"]').focus();
  await temporaryCard.locator('input[type="checkbox"]').check();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.focusKey || document.activeElement?.tagName), headlessFocusKey);

  const accountCard = page.locator('.profile-card').filter({ hasText: 'Acceptance Account' });
  page.once('dialog', (dialog) => dialog.accept('Account Primary'));
  await accountCard.getByRole('button', { name: '改名' }).click();
  const renamedCard = page.locator('.profile-card').filter({ hasText: 'Account Primary' });
  await renamedCard.waitFor();
  await page.getByRole('button', { name: '新建 Profile' }).click();
  await page.locator('#profile-name').fill('Account Primary');
  await page.getByRole('button', { name: '创建 Profile' }).click();
  await page.locator('#profiles-error').filter({ hasText: '名称已存在' }).waitFor();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await renamedCard.getByRole('button', { name: '打开登录窗口' }).click();
  await expectText(renamedCard, '人工打开');
  await renamedCard.getByRole('button', { name: '关闭窗口' }).click();
  await expectText(renamedCard, '空闲');

  page.once('dialog', (dialog) => dialog.accept());
  await temporaryCard.getByRole('button', { name: '删除' }).click();
  await temporaryCard.waitFor({ state: 'detached' });
  checks.push('Profile CRUD, preserved control focus, actionable conflicts, open, close, and delete');

  await page.getByRole('button', { name: '任务', exact: true }).click();
  await page.locator('[data-task-id="task_completed"] button').filter({ hasText: 'ui.completed' }).first().click();
  await page.locator('#task-report').filter({ hasText: '面板应首先展示这份人类可读报告' }).waitFor();
  assert.equal(await page.locator('details.developer-details').getAttribute('open'), null);
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  checks.push('report-first completed task detail');

  await page.locator('[data-task-id="task_running"] button').filter({ hasText: 'ui.running' }).first().click();
  control.denyNextPause = true;
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('#task-detail-error').filter({ hasText: '没有权限' }).waitFor();
  assert.equal(await page.locator('#auth-banner').isHidden(), true);

  control.conflictNextPause = true;
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('#task-detail-error').filter({ hasText: '状态已变化' }).waitFor();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('#task-detail-meta').filter({ hasText: '已暂停' }).waitFor();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.locator('#task-detail-meta').filter({ hasText: '执行中' }).waitFor();

  await page.getByRole('button', { name: '询问 Agent' }).click();
  await page.locator('#command-text').fill('目前完成了多少？');
  await page.getByRole('button', { name: '发送给 Agent' }).click();
  await page.getByRole('button', { name: '修改任务' }).click();
  await page.locator('#command-text').fill('把最终报告增加限制说明');
  await page.getByRole('button', { name: '发送修改要求' }).click();
  assert.deepEqual(control.commands.map((command) => command.kind), ['ask', 'modify']);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '终止', exact: true }).click();
  await page.locator('#task-detail-meta').filter({ hasText: '已终止' }).waitFor();
  assert.equal(tasks.get('task_running').cleanup.settled, true);
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  checks.push('403, 409, pause, resume, ask, modify, and cleanup-proved terminate');

  await page.locator('[data-task-id="task_waiting"] button').filter({ hasText: 'ui.waiting' }).first().click();
  await page.getByRole('button', { name: '提供指令' }).click();
  await page.locator('#command-text').fill('继续执行第二阶段');
  await page.getByRole('button', { name: '回复并继续任务' }).click();
  await page.locator('#task-detail-meta').filter({ hasText: '执行中' }).waitFor();
  assert.equal(control.continuations[0].note, '继续执行第二阶段');
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  checks.push('waiting-user same-task continuation');

  await page.locator('#task-search').fill('ui.completed');
  assert.equal(await page.locator('.task-card').count(), 1);
  await page.locator('#task-search').fill('');
  await page.locator('#task-agent-filter').selectOption('agent-alpha');
  assert.equal(await page.locator('.task-card').count(), 2);
  await page.locator('#task-agent-filter').selectOption('');
  await page.locator('#task-state-filter').selectOption('completed');
  assert.equal(await page.locator('.task-card').count(), 1);
  await page.locator('#task-state-filter').selectOption('');
  checks.push('task search and filters');

  await page.getByRole('button', { name: '总览', exact: true }).click();
  await page.locator('#recent-reports').filter({ hasText: '验收任务最终报告' }).waitFor();
  if (screenshotPath) {
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
  const taskLayout = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    workspaceWidth: document.querySelector('.workspace')?.scrollWidth,
    workspaceClientWidth: document.querySelector('.workspace')?.clientWidth,
    taskOverflow: [...document.querySelectorAll('.task-card')]
      .some((node) => node.scrollWidth > node.clientWidth),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
  }));
  assert.equal(taskLayout.innerWidth, 390);
  assert.equal(taskLayout.scrollWidth <= taskLayout.innerWidth, true);
  assert.equal(taskLayout.workspaceWidth <= taskLayout.workspaceClientWidth, true);
  assert.equal(taskLayout.taskOverflow, false);
  assert.equal(taskLayout.reducedMotion, true);
  await page.locator('[data-task-id="task_completed"] button').filter({ hasText: 'ui.completed' }).first().click();
  await page.locator('#task-report').filter({ hasText: longReportToken.slice(0, 200) }).waitFor();
  const reportLayout = await page.evaluate(() => {
    const dialog = document.querySelector('#task-detail-dialog');
    const report = document.querySelector('#task-report');
    const longParagraph = [...document.querySelectorAll('#task-report p')]
      .find((node) => node.textContent.length >= 12_000);
    return {
      dialogFits: dialog.scrollWidth <= dialog.clientWidth,
      reportFits: report.scrollWidth <= report.clientWidth,
      longParagraphFits: Boolean(longParagraph && longParagraph.scrollWidth <= longParagraph.clientWidth),
      longParagraphLength: longParagraph?.textContent.length || 0
    };
  });
  assert.deepEqual(reportLayout, {
    dialogFits: true,
    reportFits: true,
    longParagraphFits: true,
    longParagraphLength: 12_000
  });
  await page.getByRole('button', { name: '关闭任务详情' }).click();

  await page.setViewportSize({ width: 768, height: 900 });
  const navigationTargets = await page.locator('.nav-link').evaluateAll((nodes) => (
    nodes.map((node) => node.getBoundingClientRect().height)
  ));
  assert.equal(navigationTargets.every((height) => height >= 44), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
  checks.push('mobile tasks, long reports, 44px navigation, keyboard focus, and reduced motion');

  assert.equal((await page.locator('#task-report').textContent()).includes(longReportToken.slice(0, 200)), true);

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '退出控制台' }).click();
  await page.locator('#auth-banner').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#connection-label').textContent(), '需要建立 Owner 会话');
  assert.equal(await page.locator('.task-card').count(), 0);
  assert.equal(await page.locator('.profile-card').count(), 0);
  assert.equal(await page.locator('.agent-card').count(), 0);
  assert.equal((await page.locator('#task-report').textContent()).includes('面板应首先展示'), false);
  assert.equal(await page.locator('#developer-diagnostics').textContent(), '');
  checks.push('logout revokes the Owner session, clears cached Owner data, and leaves tasks running');

  assert.deepEqual(pageErrors, []);
  const report = {
    ok: true,
    version: VERSION,
    browser: 'playwright-chromium',
    checks,
    taskCommands: control.commands.length,
    continuations: control.continuations.length,
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
