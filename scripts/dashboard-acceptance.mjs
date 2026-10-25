#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(ROOT, 'dashboard');
const reportPath = process.env.TASKMASTER_DASHBOARD_REPORT
  ? path.resolve(process.env.TASKMASTER_DASHBOARD_REPORT)
  : null;
const screenshotPath = process.env.TASKMASTER_DASHBOARD_SCREENSHOT
  ? path.resolve(process.env.TASKMASTER_DASHBOARD_SCREENSHOT)
  : null;
const activeTasksScreenshotPath = screenshotPath
  ? path.join(path.dirname(screenshotPath), `${path.basename(screenshotPath, path.extname(screenshotPath))}-active.png`)
  : null;
const profilesScreenshotPath = screenshotPath
  ? path.join(
      path.dirname(screenshotPath),
      `${path.basename(screenshotPath, path.extname(screenshotPath))}-profiles${path.extname(screenshotPath) || '.png'}`
    )
  : null;
const cleanupScreenshotPaths = screenshotPath ? Object.fromEntries(['desktop', 'mobile', 'result'].map((view) => [view,
  path.join(path.dirname(screenshotPath), `${path.basename(screenshotPath, path.extname(screenshotPath))}-cleanup-${view}.png`)
])) : null;
const packageJson = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

function now() {
  return new Date().toISOString();
}

function ago(milliseconds) {
  return new Date(Date.now() - milliseconds).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function bodyFrom(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  return 'text/javascript; charset=utf-8';
}

function taskFixture(id, values = {}) {
  return {
    id,
    title: values.title || id,
    state: values.state || 'running',
    profileId: values.profileId || 'profile_work',
    profileName: values.profileName || 'Work',
    createdAt: values.createdAt || ago(120_000),
    startedAt: values.startedAt || ago(115_000),
    updatedAt: values.updatedAt || ago(2_000),
    progress: values.progress || { current: 1, total: 10, message: 'Working' },
    ...values
  };
}

const tasks = new Map([
  ['task_running', taskFixture('task_running', {
    title: 'Collect 20 pages',
    progress: { current: 7, total: 20, message: 'Reading page 8' }
  })],
  ['task_waiting', taskFixture('task_waiting', {
    title: 'Review open-ended feed',
    state: 'waiting',
    canResume: true,
    profileId: 'profile_busy',
    profileName: 'Busy',
    progress: { current: 31, message: 'Waiting before the next request' }
  })],
  ['task_finished', taskFixture('task_finished', {
    title: 'Finished sample',
    state: 'finished',
    endedAt: ago(15_000),
    progress: { current: 4, total: 4, message: 'All four items written' }
  })]
]);

let profiles = [
  {
    id: 'profile_work',
    name: 'Work',
    isDefault: true,
    state: 'closed',
    createdAt: ago(86_400_000),
    updatedAt: ago(120_000),
    lastUsedAt: ago(120_000)
  },
  {
    id: 'profile_busy',
    name: 'Busy',
    isDefault: false,
    state: 'in_use',
    createdAt: ago(3_600_000),
    updatedAt: ago(2_000),
    lastUsedAt: ago(2_000)
  }
];

const calls = {
  requests: [],
  taskActions: [],
  taskDeletes: [],
  profileActions: [],
  profileDeletes: [],
  profileCreates: [],
  profileRenames: [],
  defaultChanges: [],
  cleanup: []
};
const cleanupBehavior = {
  failPreview: false, failExecution: false, partial: false, historicalOutputPresent: true,
  summary: undefined, holdNext: null
};
let cleanupOperationSequence = 0;
const cleanupSizes = { 'browser-cache': 1024 * 1024, 'temporary-files': 64 * 1024, 'task-output': 5 * 1024 * 1024 };

function taskById(id) {
  const task = tasks.get(id);
  if (!task) return null;
  return task;
}

function profileById(id) {
  return profiles.find((profile) => profile.id === id) || null;
}

async function handler(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  calls.requests.push({ method: request.method, pathname });

  const staticFiles = new Map([
    ['/dashboard', 'index.html'],
    ['/dashboard/', 'index.html'],
    ['/dashboard/index.html', 'index.html'],
    ['/dashboard/styles.css', 'styles.css'],
    ['/dashboard/dashboard.js', 'dashboard.js'],
    ['/dashboard/npc-logo.svg', 'npc-logo.svg'],
    ['/dashboard/npc-mark.svg', 'npc-mark.svg']
  ]);
  if (request.method === 'GET' && staticFiles.has(pathname)) {
    const relative = staticFiles.get(pathname);
    const source = await readFile(path.join(DASHBOARD, relative));
    response.writeHead(200, {
      'content-type': contentType(relative),
      'cache-control': 'no-store'
    });
    response.end(source);
    return;
  }

  if (request.method === 'GET' && pathname === '/v1/status') {
    json(response, 200, {
      ok: true,
      version: packageJson.version,
      ...(cleanupBehavior.summary === undefined ? {} : { cleanup: clone(cleanupBehavior.summary) }),
      defaultProfileId: profiles.find((profile) => profile.isDefault)?.id || null
    });
    return;
  }
  if (request.method === 'GET' && pathname === '/v1/tasks') {
    json(response, 200, { tasks: clone([...tasks.values()]) });
    return;
  }
  if (request.method === 'GET' && pathname === '/v1/profiles') {
    json(response, 200, {
      profiles: clone(profiles),
      defaultProfileId: profiles.find((profile) => profile.isDefault)?.id || null
    });
    return;
  }

  if (request.method === 'POST' && pathname === '/v1/cleanup') {
    const body = await bodyFrom(request);
    calls.cleanup.push(clone(body));
    assert.deepEqual(Object.keys(body).sort(), ['categories', 'preview']);
    assert.ok(Array.isArray(body.categories) && body.categories.length > 0);
    assert.ok(body.categories.every((category) => Object.hasOwn(cleanupSizes, category)));
    if (body.preview && cleanupBehavior.failPreview) {
      cleanupBehavior.failPreview = false;
      json(response, 409, { error: { code: 'CLEANUP_BUSY', message: 'Cleanup is busy. Retry preview.' } });
      return;
    }
    if (!body.preview && cleanupBehavior.failExecution) {
      cleanupBehavior.failExecution = false;
      json(response, 500, { error: { code: 'CLEANUP_FAILED', message: 'Fixture cleanup interrupted.' } });
      return;
    }
    const categories = body.categories.map((id) => ({
      id, bytes: cleanupSizes[id] / (body.preview ? 1 : 2), files: body.preview ? 4 : 2
    }));
    const report = {
      ok: true, preview: body.preview,
      bytes: categories.reduce((total, category) => total + category.bytes, 0),
      files: categories.reduce((total, category) => total + category.files, 0), categories,
      skipped: [
        { kind: 'task', id: 'task_waiting', name: 'Review open-ended feed', reason: 'TASK_ACTIVE_OR_CLEANUP_UNCONFIRMED' },
        { kind: 'profile', id: 'profile_busy', name: 'Busy', reason: 'PROFILE_BUSY' }
      ],
      failed: cleanupBehavior.partial ? [{ kind: 'task', id: 'task_finished', name: 'Finished sample', reason: 'File is busy' }] : []
    };
    const held = cleanupBehavior.holdNext;
    if (held && held.preview === body.preview) {
      cleanupBehavior.holdNext = null;
      const summary = {
        id: `cleanup_fixture_${++cleanupOperationSequence}`, state: 'running', preview: body.preview,
        categories: clone(body.categories), phase: 'profiles', current: 0, total: 3,
        files: 0, bytes: 0, skipped: 0, failed: 0, startedAt: now(), finishedAt: null
      };
      cleanupBehavior.summary = summary;
      report.operationId = summary.id;
      if (held.disconnect) {
        // Lose an already-started response, not the connection before headers
        // (Chromium may transparently retry that transport-level failure).
        response.writeHead(200, { 'content-type': 'application/json' });
        response.flushHeaders();
        response.write('{"ok":');
        await new Promise((resolve) => setTimeout(resolve, 20));
        response.destroy();
      }
      await held.gate;
      Object.assign(summary, {
        state: 'finished', phase: 'done', current: summary.total,
        files: report.files, bytes: report.bytes, skipped: report.skipped.length,
        failed: report.failed.length, finishedAt: now()
      });
      if (!body.preview && body.categories.includes('task-output')) cleanupBehavior.historicalOutputPresent = false;
      if (held.disconnect) return;
    } else if (!body.preview && body.categories.includes('task-output')) cleanupBehavior.historicalOutputPresent = false;
    json(response, 200, report);
    return;
  }

  const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)$/u);
  if (request.method === 'GET' && taskMatch) {
    const task = taskById(taskMatch[1]);
    if (!task) json(response, 404, { error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
    else json(response, 200, { task: clone(task) });
    return;
  }

  const taskActionMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/actions$/u);
  if (request.method === 'POST' && taskActionMatch) {
    const task = taskById(taskActionMatch[1]);
    if (!task) {
      json(response, 404, { error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } });
      return;
    }
    const body = await bodyFrom(request);
    calls.taskActions.push({ id: task.id, action: body.action });
    if (body.action === 'stop') {
      task.state = 'stopped';
      task.canResume = true;
      task.progress.message = 'Stopped after the current unit';
    } else if (body.action === 'resume') {
      task.state = 'running';
      task.canResume = false;
      task.progress.message = 'Continuing from saved progress';
    } else {
      json(response, 400, { error: { code: 'INVALID_ACTION', message: 'Unsupported task action' } });
      return;
    }
    task.updatedAt = now();
    json(response, 200, { task: clone(task) });
    return;
  }

  if (request.method === 'DELETE' && taskMatch) {
    const task = taskById(taskMatch[1]);
    if (!task) {
      json(response, 200, { deleted: true, id: taskMatch[1] });
      return;
    }
    const live = !['finished', 'stopped', 'error'].includes(task.state);
    calls.taskDeletes.push({ id: task.id, stoppedLiveTask: live });
    tasks.delete(task.id);
    json(response, 200, { deleted: true, id: task.id, stoppedLiveTask: live });
    return;
  }

  if (request.method === 'POST' && pathname === '/v1/profiles') {
    const body = await bodyFrom(request);
    if (!body.name?.trim()) {
      json(response, 400, { error: { code: 'INVALID_PROFILE_NAME', message: 'Profile name is required' } });
      return;
    }
    const id = `profile_${profiles.length + 1}`;
    const profile = {
      id,
      name: body.name.trim(),
      isDefault: profiles.length === 0,
      state: 'closed',
      createdAt: now(),
      updatedAt: now(),
      lastUsedAt: null
    };
    profiles.push(profile);
    calls.profileCreates.push(clone(body));
    json(response, 201, { profile: clone(profile) });
    return;
  }

  const profileMatch = pathname.match(/^\/v1\/profiles\/([^/]+)$/u);
  if (request.method === 'PATCH' && profileMatch) {
    const profile = profileById(profileMatch[1]);
    if (!profile) {
      json(response, 404, { error: { code: 'PROFILE_NOT_FOUND', message: 'Profile not found' } });
      return;
    }
    const body = await bodyFrom(request);
    if (typeof body.name === 'string') {
      const name = body.name.trim();
      if (!name || name.length > 80) {
        json(response, 400, { error: { code: 'INVALID_PROFILE_NAME', message: 'A name of 1–80 characters is required' } });
        return;
      }
      if (profiles.some((candidate) => candidate.id !== profile.id && candidate.name.toLowerCase() === name.toLowerCase())) {
        json(response, 409, { error: { code: 'PROFILE_NAME_EXISTS', message: 'Profile name already exists' } });
        return;
      }
      profile.name = name;
      profile.updatedAt = now();
      calls.profileRenames.push({ id: profile.id, name });
      json(response, 200, { profile: clone(profile) });
      return;
    }
    if (body.isDefault !== true) {
      json(response, 400, { error: { code: 'INVALID_PROFILE_PATCH', message: 'Only name and isDefault are supported' } });
      return;
    }
    for (const candidate of profiles) candidate.isDefault = candidate.id === profile.id;
    calls.defaultChanges.push(profile.id);
    json(response, 200, { profile: clone(profile) });
    return;
  }

  const profileActionMatch = pathname.match(/^\/v1\/profiles\/([^/]+)\/actions$/u);
  if (request.method === 'POST' && profileActionMatch) {
    const profile = profileById(profileActionMatch[1]);
    if (!profile) {
      json(response, 404, { error: { code: 'PROFILE_NOT_FOUND', message: 'Profile not found' } });
      return;
    }
    const body = await bodyFrom(request);
    if (!['open', 'close'].includes(body.action)) {
      json(response, 400, { error: { code: 'INVALID_ACTION', message: 'Unsupported Profile action' } });
      return;
    }
    profile.state = body.action === 'open' ? 'open' : 'closed';
    profile.updatedAt = now();
    calls.profileActions.push({ id: profile.id, action: body.action });
    json(response, 200, { profile: clone(profile) });
    return;
  }

  if (request.method === 'DELETE' && profileMatch) {
    const profile = profileById(profileMatch[1]);
    if (!profile) {
      json(response, 200, { deleted: true, id: profileMatch[1] });
      return;
    }
    const busy = profile.state === 'in_use';
    for (const task of [...tasks.values()]) {
      if (task.profileId === profile.id) tasks.delete(task.id);
    }
    profiles = profiles.filter((candidate) => candidate.id !== profile.id);
    if (profile.isDefault && profiles.length) profiles[0].isDefault = true;
    calls.profileDeletes.push({ id: profile.id, stoppedLiveTask: busy });
    json(response, 200, { deleted: true, id: profile.id, stoppedLiveTask: busy });
    return;
  }

  json(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitUntil(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function checkCurrentTasks(page, checks) {
  const originals = new Map([...tasks].map(([id, task]) => [id, clone(task)]));
  const deletesBefore = calls.taskDeletes.length;
  const baseUrl = new URL(page.url()).origin;
  try {
    for (const state of ['queued', 'stopping', 'stopped', 'error']) {
      const id = `task_${state}_visibility`;
      tasks.set(id, taskFixture(id, { state }));
    }
    await page.locator('#refresh-all').click();
    await page.locator('[data-task-id="task_queued_visibility"] .npc-chip').getByText('排队中', { exact: true }).waitFor();
    assert.equal(await page.locator('.task-card').count(), 4);
    assert.equal(await page.locator('#task-count-chip').textContent(), '4 个任务');
    for (const id of ['task_finished', 'task_stopped_visibility', 'task_error_visibility']) {
      assert.equal(await page.locator(`[data-task-id="${id}"]`).count(), 0);
    }
    tasks.get('task_running').state = 'finished';
    await page.locator('[data-task-id="task_running"]').waitFor({ state: 'detached' });
    assert.equal(tasks.has('task_running'), true, 'automatic removal must not delete the record or its output');
    tasks.get('task_waiting').state = 'stopped';
    tasks.get('task_queued_visibility').state = 'finished';
    tasks.get('task_stopping_visibility').state = 'error';
    await page.locator('#tasks .empty-state').getByText('当前没有进行中的任务。', { exact: true }).waitFor();
    assert.equal(await page.locator('.task-card').count(), 0);
    assert.equal(await page.locator('#task-count-chip').textContent(), '0 个任务');
    await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
    await page.getByRole('heading', { name: 'Current tasks', exact: true }).waitFor();
    assert.equal(await page.locator('#tasks .empty-state').textContent(), 'No active tasks.');
    await page.goto(`${baseUrl}/dashboard?task=task_finished`);
    await page.getByText('No active tasks.', { exact: true }).waitFor();
    assert.equal(await page.locator('.task-card').count(), 0, 'a completed deep link must not restore a history card');
    assert.equal(calls.taskDeletes.length, deletesBefore);
    checks.push('only current tasks appear; finished, stopped and failed tasks leave automatically, counts reach zero, and completed deep links never restore history or delete stored output');
  } finally {
    tasks.clear();
    for (const [id, task] of originals) tasks.set(id, task);
    const chineseToggle = page.getByRole('button', { name: '切换到中文', exact: true });
    if (await chineseToggle.count()) await chineseToggle.click();
    await page.goto(`${baseUrl}/dashboard?task=task_running`);
    await page.locator('[data-task-id="task_running"]').waitFor();
  }
}

async function checkVerificationPause(page, checks) {
  const original = clone(tasks.get('task_waiting'));
  const actionsBefore = calls.taskActions.length;
  const deletesBefore = calls.taskDeletes.length;
  const card = page.locator('.task-card').filter({ hasText: 'Review open-ended feed' });
  try {
    tasks.get('task_waiting').waiting = {
      id: 'wait_dashboard_verification', kind: 'verification', reason: 'verification',
      startedAt: ago(60_000), automaticPaused: false
    };
    await page.locator('#refresh-all').click();
    await card.locator('.task-activity').getByText('等待人工验证，系统每30秒提醒；20分钟后自动暂停并停止提醒。', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: '恢复', exact: true }).isEnabled(), true);

    Object.assign(tasks.get('task_waiting').waiting, {
      startedAt: ago(20 * 60_000), automaticPaused: true,
      pausedAt: now(), needsAgentDecision: false, nextProbeAt: null
    });
    await page.locator('#refresh-all').click();
    await card.locator('.npc-chip').getByText('已自动暂停', { exact: true }).waitFor();
    assert.equal(await card.locator('.task-activity').textContent(),
      '等待验证已满20分钟，系统提醒已停止；浏览器现场保留，可手动恢复或停止任务。');
    assert.equal(await card.getByRole('button', { name: '恢复', exact: true }).isEnabled(), true);
    assert.equal(await card.getByRole('button', { name: '停止', exact: true }).isEnabled(), true);
    assert.match(await card.textContent(), /已处理 31/u);
    assert.equal(await page.locator('.task-card').count(), 2);
    assert.equal(calls.taskActions.length, actionsBefore);
    assert.equal(calls.taskDeletes.length, deletesBefore);
    tasks.get('task_waiting').state = 'stopping';
    await page.locator('#refresh-all').click();
    await card.locator('.npc-chip').getByText('正在停止', { exact: true }).waitFor();
    await card.locator('.npc-chip').getByText('已自动暂停', { exact: true }).waitFor({ state: 'hidden' });
    assert.doesNotMatch(await card.locator('.task-activity').textContent(), /等待验证已满20分钟|系统提醒已停止/u);
    checks.push('verification shows 30-second reminders, then an automatic-pause label and stopped-reminder copy with resume/stop enabled; stopping clears stale automatic-pause text');
  } finally {
    tasks.set('task_waiting', original);
    await page.locator('#refresh-all').click();
    await card.locator('.task-activity').getByText(original.progress.message, { exact: true }).waitFor();
  }
}

async function checkCleanup(page, checks) {
  const dialog = page.getByRole('dialog', { name: '清理空间', exact: true });
  const confirm = page.locator('#confirm-cleanup');
  const output = page.locator('[name="cleanup-category"][value="task-output"]');
  const defaults = ['browser-cache', 'temporary-files'];
  await page.getByRole('button', { name: '清理空间', exact: true }).click();
  await dialog.waitFor();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  assert.deepEqual(calls.cleanup.at(-1), { categories: defaults, preview: true });
  assert.equal(await output.isChecked(), false);
  assert.equal(await page.locator('[name="cleanup-category"]:checked').count(), 2);
  assert.match(await page.locator('#cleanup-safety').textContent(), /保留登录状态和扩展/u);
  assert.match(await page.locator('#cleanup-summary').textContent(), /预计可释放.*1\.1 MB/u);
  assert.match(await page.locator('#cleanup-details').textContent(), /已跳过 2 项/u);
  assert.equal(calls.cleanup.some((entry) => !entry.preview), false);
  if (cleanupScreenshotPaths) {
    await mkdir(path.dirname(cleanupScreenshotPaths.desktop), { recursive: true });
    await page.screenshot({ path: cleanupScreenshotPaths.desktop, fullPage: true });
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#open-cleanup').evaluate((node) => node === document.activeElement), true);
  checks.push('cleanup opens as a keyboard-closeable dialog; cache and temporary files default on, historical output defaults off');

  // Hold an older preview so rapid changes cannot authorize a stale selection.
  let releasePreview;
  const heldPreview = new Promise((resolve) => { releasePreview = resolve; });
  let previewHeld = false;
  const holdPreview = async (route) => {
    if (route.request().postDataJSON().preview && !previewHeld) {
      previewHeld = true;
      await heldPreview;
    }
    await route.continue();
  };
  await page.route('**/v1/cleanup', holdPreview);
  await page.locator('#open-cleanup').click();
  await waitUntil(() => previewHeld, 'held cleanup preview');
  await output.check();
  await page.locator('[name="cleanup-category"][value="browser-cache"]').uncheck();
  assert.equal(await confirm.isDisabled(), true);
  releasePreview();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  assert.deepEqual(calls.cleanup.at(-1), { categories: ['temporary-files', 'task-output'], preview: true });
  assert.match(await page.locator('#cleanup-summary').textContent(), /5\.1 MB/u);
  await page.unroute('**/v1/cleanup', holdPreview);
  await page.keyboard.press('Escape');
  checks.push('rapid selection changes serialize previews and only the latest matching preview enables cleanup');

  await page.locator('#open-cleanup').click();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  const executionsBefore = calls.cleanup.filter((entry) => !entry.preview).length;
  await confirm.evaluate((node) => { node.click(); node.click(); });
  await page.locator('#cleanup-summary').getByText('已清理文件大小', { exact: true }).waitFor();
  assert.equal(calls.cleanup.filter((entry) => !entry.preview).length, executionsBefore + 1);
  assert.deepEqual(calls.cleanup.at(-1), { categories: defaults, preview: false });
  assert.equal(cleanupBehavior.historicalOutputPresent, true);
  assert.match(await page.locator('#cleanup-summary').textContent(), /544 KB.*4 个文件/u);
  assert.equal(await confirm.isDisabled(), true);
  await page.keyboard.press('Escape');
  checks.push('one explicit confirmation sends one fresh non-preview request and reports actual bytes/files while preserving historical output');

  cleanupBehavior.failPreview = true;
  await page.locator('#open-cleanup').click();
  await page.locator('#cleanup-error:not(.hidden)').waitFor();
  assert.equal(await confirm.isDisabled(), true);
  assert.match(await page.locator('#cleanup-error').textContent(), /已有清理或预览正在进行/u);
  assert.doesNotMatch(await page.locator('#cleanup-summary').textContent(), /请至少选择一项/u);
  await page.locator('#retry-cleanup').click();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  cleanupBehavior.failExecution = true;
  const failureRequestsBefore = calls.cleanup.filter((entry) => !entry.preview).length;
  await confirm.click();
  await page.locator('#cleanup-error').getByText(/清理结果未确认/u).waitFor();
  assert.equal(calls.cleanup.filter((entry) => !entry.preview).length, failureRequestsBefore + 1);
  assert.equal(await confirm.isDisabled(), true);
  await page.locator('#retry-cleanup').click();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  cleanupBehavior.partial = true;
  await output.check();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  await confirm.click();
  await page.locator('#cleanup-summary').getByText('已清理文件大小', { exact: true }).waitFor();
  assert.equal(cleanupBehavior.historicalOutputPresent, false);
  assert.deepEqual(calls.cleanup.at(-1), { categories: [...defaults, 'task-output'], preview: false });
  assert.match(await page.locator('#cleanup-summary').textContent(), /部分项目未清理/u);
  assert.match(await page.locator('#cleanup-details').textContent(), /1 项未能清理.*Finished sample.*File is busy/u);
  if (cleanupScreenshotPaths) await page.screenshot({ path: cleanupScreenshotPaths.result, fullPage: true });
  await page.keyboard.press('Escape');
  cleanupBehavior.partial = false;
  checks.push('busy-preview and failed-cleanup retries require a new preview; opted-in output cleanup shows partial failures and skips truthfully');

  await page.locator('#language-toggle').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Clean up space', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  assert.equal(await page.getByRole('dialog', { name: 'Clean up space', exact: true }).count(), 1);
  assert.equal(await output.isChecked(), false);
  assert.match(await page.locator('#cleanup-safety').textContent(), /Login state and extensions are preserved/u);
  assert.match(await confirm.textContent(), /Clean selected/u);
  const layout = await page.locator('#cleanup-dialog').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: innerWidth, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      height: innerHeight, overflow: node.scrollWidth > node.clientWidth };
  });
  assert.ok(layout.left >= 0 && layout.right <= layout.width && layout.top >= 0 && layout.bottom <= layout.height);
  assert.equal(layout.overflow, false);
  const actionBounds = await confirm.boundingBox();
  assert.ok(actionBounds.y >= layout.top && actionBounds.y + actionBounds.height <= layout.bottom,
    'mobile confirmation must be fully visible without scrolling');
  assert.equal(await confirm.evaluate((node) => getComputedStyle(node).color), 'rgb(9, 9, 9)');
  assert.equal(await page.locator('.cleanup-option').evaluateAll((nodes) => nodes.every((node) => node.getBoundingClientRect().height >= 44)), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#cleanup-dialog').evaluate((node) => node.contains(document.activeElement)), true);
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
  if (cleanupScreenshotPaths) await page.screenshot({ path: cleanupScreenshotPaths.mobile, fullPage: true });
  await page.keyboard.press('Escape');
  await page.locator('#language-toggle').click();
  await page.setViewportSize({ width: 1440, height: 960 });
  checks.push('cleanup has translated English labels, contained keyboard focus, and a bounded scrollable mobile dialog');
}

async function checkSlowCleanup(page, checks) {
  const confirm = page.locator('#confirm-cleanup');
  const summary = page.locator('#cleanup-summary');
  const errors = page.locator('#cleanup-error');
  const requestCount = () => calls.cleanup.length;
  const deletionCount = () => calls.cleanup.filter((entry) => !entry.preview).length;
  const refreshStatus = async () => {
    await page.locator('#refresh-all').evaluate((node) => node.click());
    await page.waitForFunction(() => !document.querySelector('#refresh-all').disabled);
  };
  const holdNext = (preview, disconnect = false) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    cleanupBehavior.holdNext = { preview, disconnect, gate };
    return release;
  };

  // Advance browser time instead of making the suite wait over a minute.
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let release = holdNext(true);
  await page.locator('#open-cleanup').click();
  await waitUntil(() => cleanupBehavior.summary?.state === 'running', 'slow preview starts');
  await refreshStatus();
  assert.match(await summary.textContent(), /正在估算.*已检查 0 \/ 3 项/u);
  const slowPreviewRequests = requestCount();
  await page.clock.fastForward(65_000);
  assert.equal(await errors.isVisible(), false, 'preview must not be aborted at 60 seconds');
  assert.equal(await confirm.isDisabled(), true);
  assert.equal(requestCount(), slowPreviewRequests);
  release();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);

  release = holdNext(false);
  let releaseReply;
  let replyReceived = false;
  const heldReply = new Promise((resolve) => { releaseReply = resolve; });
  const holdReply = async (route) => {
    const response = await route.fetch();
    replyReceived = true;
    await heldReply;
    await route.fulfill({ response });
  };
  await page.route('**/v1/cleanup', holdReply);
  const deletionsBefore = deletionCount();
  await confirm.evaluate((node) => { node.click(); node.click(); });
  await waitUntil(() => cleanupBehavior.summary?.state === 'running' && !cleanupBehavior.summary.preview, 'slow deletion starts');
  await refreshStatus();
  await page.clock.fastForward(65_000);
  assert.equal(await errors.isVisible(), false, 'cleanup must not be aborted at 60 seconds');
  assert.match(await summary.textContent(), /正在清理.*已检查 0 \/ 3 项/u);
  assert.equal(deletionCount(), deletionsBefore + 1);
  const runningRequests = requestCount();
  await page.locator('#close-cleanup').click();
  await page.locator('#open-cleanup').click();
  assert.equal(requestCount(), runningRequests, 'reopening a running cleanup never posts another request');
  assert.equal(await confirm.isDisabled(), true);
  Object.assign(cleanupBehavior.summary, { phase: 'tasks', current: 2, files: 4, bytes: 4096, skipped: 1 });
  await refreshStatus();
  assert.match(await summary.textContent(), /已检查 2 \/ 3 项.*任务文件.*4 KB.*4 个文件.*已跳过 1 项/u);
  release();
  await waitUntil(() => replyReceived, 'completed deletion response is held');
  await refreshStatus();
  assert.match(await summary.textContent(), /后台操作摘要/u);
  assert.equal(await confirm.isDisabled(), true);
  releaseReply();
  await summary.getByText('已清理文件大小', { exact: true }).waitFor();
  await page.locator('#cleanup-details').getByText(/Review open-ended feed/u).waitFor();
  await page.unroute('**/v1/cleanup', holdReply);
  assert.equal(await confirm.isDisabled(), true);
  checks.push('preview and deletion survive 65 seconds of browser time; progress remains visible and reopening sends no duplicate POST');

  // A busy response belongs to the existing operation, not another retry loop.
  cleanupBehavior.summary = {
    ...cleanupBehavior.summary, id: 'cleanup_external', state: 'running', phase: 'tasks',
    preview: false, current: 1, finishedAt: null
  };
  cleanupBehavior.failPreview = true;
  await page.locator('#retry-cleanup').click();
  await waitUntil(() => !cleanupBehavior.failPreview, 'busy preview response');
  await refreshStatus();
  assert.match(await summary.textContent(), /正在清理.*已检查 1 \/ 3 项/u);
  assert.equal(await confirm.isDisabled(), true);
  const busyRequests = requestCount();
  await page.clock.fastForward(10_000);
  assert.equal(requestCount(), busyRequests, 'polling a busy cleanup never retries the POST');
  Object.assign(cleanupBehavior.summary, { state: 'finished', phase: 'done', current: 3, finishedAt: now() });
  await refreshStatus();
  assert.match(await summary.textContent(), /后台操作摘要/u);
  assert.equal(await confirm.isDisabled(), true, 'a status summary is not a matching preview');
  checks.push('CLEANUP_BUSY hands off to existing status progress; completion never authorizes deletion or retries a POST');

  await page.locator('#retry-cleanup').click();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  cleanupBehavior.failPreview = true;
  await page.locator('[name="cleanup-category"][value="task-output"]').check();
  await errors.waitFor({ state: 'visible' });
  assert.equal(await page.locator('[name="cleanup-category"]:checked').count(), 3);
  assert.doesNotMatch(await summary.textContent(), /请至少选择一项/u);
  await page.locator('#retry-cleanup').click();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  cleanupBehavior.partial = true;
  release = holdNext(false, true);
  const disconnectedDeletions = deletionCount();
  await confirm.click();
  await waitUntil(() => cleanupBehavior.summary?.state === 'running', 'disconnected cleanup starts');
  await refreshStatus();
  assert.match(await summary.textContent(), /正在清理/u);
  assert.equal(await confirm.isDisabled(), true);
  await page.clock.resume();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await refreshStatus();
  const reconnectRequests = requestCount();
  await page.locator('#open-cleanup').click();
  assert.match(await summary.textContent(), /正在清理.*历史截图、下载和结果/u);
  assert.equal(requestCount(), reconnectRequests, 'a new page observes the live operation without replaying it');
  assert.equal(await confirm.isDisabled(), true);
  release();
  await waitUntil(() => cleanupBehavior.summary?.state === 'finished', 'disconnected cleanup finishes');
  await refreshStatus();
  assert.match(await summary.textContent(), /已清理文件大小.*已跳过 2 项.*1 项未能清理.*部分项目未清理.*后台操作摘要/u);
  assert.equal(deletionCount(), disconnectedDeletions + 1);
  assert.equal(await confirm.isDisabled(), true);
  checks.push('a lost deletion response and full page reload recover the same operation, disclose partial counts, and never replay deletion');
  await page.locator('#close-cleanup').click();
  cleanupBehavior.partial = false;
  cleanupBehavior.summary = null;
}

async function checkCleanupStatusRace(page, checks) {
  const summary = page.locator('#cleanup-summary');
  const confirm = page.locator('#confirm-cleanup');
  await page.locator('#open-cleanup').click();
  const runRace = async (action, expected) => {
    let release;
    let captured = false;
    const held = new Promise((resolve) => { release = resolve; });
    cleanupBehavior.summary = {
      id: `cleanup_stale_${calls.cleanup.length}`, state: 'running', preview: false,
      categories: ['task-output'], phase: 'tasks', current: 9, total: 99,
      files: 123, bytes: 123, skipped: 0, failed: 0, startedAt: now(), finishedAt: null
    };
    const holdStatus = async (route) => {
      const response = await route.fetch();
      captured = true;
      await held;
      await route.fulfill({ response });
    };
    await page.route('**/v1/status', holdStatus);
    try {
      await page.locator('#refresh-all').evaluate((node) => node.click());
      await waitUntil(() => captured, 'old status snapshot is held');
      cleanupBehavior.summary = null;
      await action();
      await summary.getByText(expected, { exact: true }).waitFor();
      release();
      await page.waitForFunction(() => !document.querySelector('#refresh-all').disabled);
      assert.doesNotMatch(await summary.textContent(), /9 \/ 99/u);
      await summary.getByText(expected, { exact: true }).waitFor();
    } finally {
      release();
      await page.unroute('**/v1/status', holdStatus);
    }
  };
  await runRace(() => page.locator('#retry-cleanup').click(), '预计可释放');
  assert.equal(await confirm.isDisabled(), false, 'delayed old status cannot clear a newer matching preview');
  await runRace(() => confirm.click(), '已清理文件大小');
  assert.equal(await confirm.isDisabled(), true);
  await page.locator('#close-cleanup').click();
  checks.push('a delayed old status cannot overwrite a newer preview or deletion result; a finished summary can hand off to its detailed POST response');
}

async function checkNewerCleanupStatus(page, checks) {
  const summary = page.locator('#cleanup-summary');
  const confirm = page.locator('#confirm-cleanup');
  await page.locator('#open-cleanup').click();
  await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
  for (const preview of [true, false]) {
    let release;
    let captured = false;
    let delivered = false;
    const held = new Promise((resolve) => { release = resolve; });
    const holdResponse = async (route) => {
      const response = await route.fetch();
      captured = true;
      await held;
      await route.fulfill({ response });
      delivered = true;
    };
    cleanupBehavior.holdNext = { preview, gate: Promise.resolve() };
    await page.route('**/v1/cleanup', holdResponse);
    try {
      if (preview) await page.locator('[name="cleanup-category"][value="task-output"]').check();
      else await confirm.click();
      await waitUntil(() => captured, 'older POST response is held');
      cleanupBehavior.summary = {
        ...cleanupBehavior.summary, id: `cleanup_newer_${preview}`, state: 'running', preview: false,
        categories: ['task-output'], phase: 'tasks', current: 8, total: 10, finishedAt: null
      };
      await page.locator('#refresh-all').evaluate((node) => node.click());
      await page.waitForFunction(() => !document.querySelector('#refresh-all').disabled);
      assert.match(await summary.textContent(), /已检查 8 \/ 10 项/u);
      release();
      await waitUntil(() => delivered, 'older POST response is delivered');
      assert.match(await summary.textContent(), /已检查 8 \/ 10 项/u);
      assert.equal(await confirm.isDisabled(), true);
      assert.equal(await page.locator('#cleanup-error').isVisible(), false);
    } finally {
      release();
      await page.unroute('**/v1/cleanup', holdResponse);
    }
    Object.assign(cleanupBehavior.summary, { state: 'finished', phase: 'done', current: 10, finishedAt: now() });
    await page.locator('#refresh-all').evaluate((node) => node.click());
    await page.waitForFunction(() => !document.querySelector('#refresh-all').disabled);
    if (preview) {
      cleanupBehavior.summary = null;
      await page.locator('#retry-cleanup').click();
      await page.waitForFunction(() => !document.querySelector('#confirm-cleanup').disabled);
    }
  }
  await page.locator('#close-cleanup').click();
  cleanupBehavior.summary = null;
  checks.push('a newer operation observed through status survives an older preview or deletion POST response without errors or enabled deletion');
}

const server = http.createServer((request, response) => {
  void handler(request, response).catch((error) => {
    json(response, 500, { error: { code: 'FIXTURE_FAILURE', message: error.message } });
  });
});

let browser;
const checks = [];
const pageErrors = [];

try {
  const baseUrl = await listen(server);
  browser = await chromium.launch({
    channel: process.env.TASKMASTER_BROWSER_CHANNEL || 'chrome',
    headless: true
  });
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 960 },
    reducedMotion: 'reduce'
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${baseUrl}/dashboard?task=task_running`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '当前任务', exact: true }).waitFor();
  const brand = page.locator('img.npc-brand-mark');
  assert.equal(await brand.getAttribute('alt'), 'NPC');
  await brand.evaluate((image) => image.decode());
  assert.equal(await brand.evaluate((image) => image.naturalWidth / image.naturalHeight), 3);
  const favicon = await page.locator('link[rel="icon"]').getAttribute('href');
  const faviconResponse = await page.request.get(new URL(favicon, baseUrl).href);
  assert.equal(faviconResponse.status(), 200);
  assert.match(faviconResponse.headers()['content-type'], /image\/svg\+xml/u);
  checks.push('NPC vector logo and compact favicon load locally without external image dependencies');
  assert.equal(context.pages().length, 1, 'Website navigation never opens automatically');
  await context.route('https://www.npctech.site/**', (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<title>NPC website fixture</title>'
  }));
  for (const selector of ['.brand', '.website-link']) {
    const link = page.locator(selector);
    assert.equal(await link.getAttribute('href'), 'https://www.npctech.site/');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.match(await link.getAttribute('rel'), /noopener/u);
    const panelUrl = page.url();
    const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await popup.waitForLoadState('domcontentloaded');
    assert.equal(popup.url(), 'https://www.npctech.site/');
    assert.equal(page.url(), panelUrl, 'Website link keeps the current task panel open');
    await popup.close();
  }
  await context.unroute('https://www.npctech.site/**');
  checks.push('NPC website button and Logo open one new tab only when clicked and preserve the task panel');
  for (const width of [390, 768, 981, 1024, 1100, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    const overlap = await page.locator('.brand, .primary-nav, .header-actions').evaluateAll((nodes) => {
      const rects = nodes.map((node) => node.getBoundingClientRect());
      return rects.some((a, i) => rects.slice(i + 1).some((b) =>
        a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1));
    });
    assert.equal(overlap, false, `Header controls overlap at ${width}px`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  checks.push('Logo, website navigation and task controls do not overlap from phone through tablet and desktop widths');
  await page.locator('.task-card').first().waitFor();
  assert.equal(await page.locator('.task-card').count(), 2);
  assert.equal(await page.locator('#task-count-chip').textContent(), '2 个任务');
  assert.match(await page.locator('.task-card').filter({ hasText: 'Collect 20 pages' }).textContent(), /7\s*\/\s*20/u);
  assert.match(await page.locator('.task-card').filter({ hasText: 'Review open-ended feed' }).textContent(), /已处理 31/u);
  assert.equal(await page.locator('.task-card.is-targeted').count(), 1);
  checks.push('fixed Dashboard URL loads Tasks first, deep-links one task, and renders bounded and open-ended progress');
  await checkCurrentTasks(page, checks);
  if (activeTasksScreenshotPath) {
    await mkdir(path.dirname(activeTasksScreenshotPath), { recursive: true });
    await page.screenshot({ path: activeTasksScreenshotPath, fullPage: true });
  }
  await checkVerificationPause(page, checks);
  await checkCleanup(page, checks);
  await checkSlowCleanup(page, checks);
  await checkCleanupStatusRace(page, checks);
  await checkNewerCleanupStatus(page, checks);

  const rejectApi = (route) => route.abort('connectionrefused');
  await page.route('**/v1/**', rejectApi);
  await page.locator('#refresh-all').click();
  await page.locator('#offline-banner:not(.hidden)').waitFor();
  assert.equal(await page.locator('.task-card').count(), 2);
  // Hold successful responses until the visible Retry action is clicked.
  // Otherwise background polling can recover between unroute() and click(),
  // hide the banner, and make this test wait for a button that correctly left.
  let restoreNetwork;
  const networkRestored = new Promise((resolve) => { restoreNetwork = resolve; });
  const holdRecovery = async (route) => { await networkRestored; await route.continue(); };
  await page.route('**/v1/**', holdRecovery);
  await page.unroute('**/v1/**', rejectApi);
  try {
    await page.locator('#retry-offline').click();
  } finally {
    restoreNetwork();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await page.locator('#offline-banner').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.task-card').count(), 2);
  checks.push('a temporary Manager outage keeps the last task state and recovers in place');

  const runningCard = page.locator('.task-card').filter({ hasText: 'Collect 20 pages' });
  await runningCard.getByRole('button', { name: '停止', exact: true }).evaluate((node) => {
    node.click();
    node.click();
  });
  await waitUntil(() => tasks.get('task_running')?.state === 'stopped', 'task stop');
  await runningCard.waitFor({ state: 'detached' });
  assert.equal(calls.taskActions.filter((entry) => entry.id === 'task_running' && entry.action === 'stop').length, 1);
  const waitingCard = page.locator('.task-card').filter({ hasText: 'Review open-ended feed' });
  await waitingCard.getByRole('button', { name: '恢复', exact: true }).evaluate((node) => {
    node.click();
    node.click();
  });
  await waitUntil(() => tasks.get('task_waiting')?.state === 'running', 'task resume');
  await waitingCard.locator('.npc-chip').getByText('运行中', { exact: true }).waitFor();
  assert.equal(calls.taskActions.filter((entry) => entry.id === 'task_waiting' && entry.action === 'resume').length, 1);
  assert.match(await waitingCard.textContent(), /已处理 31/u);
  checks.push('stop removes its ended card and waiting-task resume retains progress; both commands remain idempotent at the UI boundary');

  page.once('dialog', (dialog) => dialog.accept());
  await waitingCard.getByRole('button', { name: '删除', exact: true }).click();
  await waitUntil(() => !tasks.has('task_waiting'), 'live task deletion');
  await waitingCard.waitFor({ state: 'detached' });
  assert.deepEqual(calls.taskDeletes.at(-1), { id: 'task_waiting', stoppedLiveTask: true });
  checks.push('deleting a live task is one atomic Owner action and removes the card');

  await page.getByRole('button', { name: 'Profiles', exact: true }).click();
  await page.getByRole('heading', { name: '浏览器 Profiles', exact: true }).waitFor();
  assert.equal(await page.locator('.profile-card').count(), 2);
  assert.equal(await page.locator('.npc-chip-default').count(), 1);

  await page.getByRole('button', { name: '新建 Profile', exact: true }).click();
  await page.locator('#profile-name').fill('Research');
  await page.getByRole('button', { name: '创建 Profile', exact: true }).click();
  const researchCard = page.locator('.profile-card[data-profile-id="profile_3"]');
  await researchCard.waitFor();
  assert.deepEqual(calls.profileCreates.at(-1), { name: 'Research' });
  assert.equal(Object.keys(calls.profileCreates.at(-1)).length, 1);

  const renameButton = researchCard.getByRole('button', { name: '改名', exact: true });
  const renameRequestsBefore = calls.requests.filter((entry) => entry.method === 'PATCH').length;
  for (const name of [null, '   ', 'Research', 'x'.repeat(81)]) {
    const dialogEvent = page.waitForEvent('dialog');
    const click = renameButton.click();
    const dialog = await dialogEvent;
    assert.equal(dialog.type(), 'prompt');
    assert.equal(dialog.defaultValue(), 'Research');
    assert.match(dialog.message(), /新的 Profile 名称/u);
    if (name === null) await dialog.dismiss();
    else await dialog.accept(name);
    await click;
  }
  assert.equal(calls.requests.filter((entry) => entry.method === 'PATCH').length, renameRequestsBefore);
  assert.equal(await page.locator('.profile-card[data-profile-id="profile_busy"]').getByRole('button', { name: '改名', exact: true }).isDisabled(), true);

  let finishRename;
  const pendingRename = new Promise((resolve) => { finishRename = resolve; });
  const holdRename = async (route) => {
    if (route.request().method() === 'PATCH') await pendingRename;
    await route.continue();
  };
  await page.route('**/v1/profiles/profile_3', holdRename);
  page.once('dialog', (dialog) => dialog.accept('  Research renamed  '));
  await renameButton.click();
  assert.equal(await renameButton.isDisabled(), true);
  await renameButton.evaluate((node) => node.click());
  finishRename();
  await waitUntil(() => profileById('profile_3')?.name === 'Research renamed', 'Profile rename');
  await researchCard.getByRole('heading', { name: 'Research renamed', exact: true }).waitFor();
  await page.unroute('**/v1/profiles/profile_3', holdRename);
  assert.deepEqual(calls.profileRenames, [{ id: 'profile_3', name: 'Research renamed' }]);
  assert.equal(profileById('profile_3').state, 'closed');
  assert.match(await page.locator('#dashboard-message').textContent(), /Profile 已改名/u);
  checks.push('Profile rename trims names, preserves identity, ignores cancel/empty/unchanged/overlong input, and disables busy or pending actions');

  await researchCard.getByRole('button', { name: '设为默认', exact: true }).click();
  await waitUntil(() => profileById('profile_3')?.isDefault === true, 'default Profile change');
  assert.equal(profiles.filter((profile) => profile.isDefault).length, 1);
  await researchCard.getByRole('button', { name: '打开', exact: true }).click();
  await waitUntil(() => profileById('profile_3')?.state === 'open', 'Profile open');
  await researchCard.getByRole('button', { name: '关闭', exact: true }).click();
  await waitUntil(() => profileById('profile_3')?.state === 'closed', 'Profile close');
  assert.deepEqual(calls.profileActions.filter((entry) => entry.id === 'profile_3').map((entry) => entry.action), ['open', 'close']);
  checks.push('Profile creation accepts only a name; default, open, and close update through minimal actions');

  page.once('dialog', (dialog) => dialog.accept());
  await researchCard.getByRole('button', { name: '删除', exact: true }).click();
  await waitUntil(() => !profileById('profile_3'), 'default Profile deletion');
  assert.equal(profiles.filter((profile) => profile.isDefault).length, 1);
  assert.equal(profiles[0].isDefault, true);

  const busyCard = page.locator('.profile-card').filter({ hasText: 'Busy' });
  page.once('dialog', (dialog) => dialog.accept());
  await busyCard.getByRole('button', { name: '删除', exact: true }).click();
  await waitUntil(() => !profileById('profile_busy'), 'busy Profile deletion');
  assert.deepEqual(calls.profileDeletes.at(-1), { id: 'profile_busy', stoppedLiveTask: true });
  checks.push('Profile deletion covers default reassignment and synchronous cleanup of a busy Profile');

  await page.getByRole('button', { name: 'Switch to English', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser Profiles', exact: true }).waitFor();
  const englishRename = page.locator('.profile-card[data-profile-id="profile_work"]').getByRole('button', { name: 'Rename', exact: true });
  const englishDialogEvent = page.waitForEvent('dialog');
  const englishClick = englishRename.click();
  const englishDialog = await englishDialogEvent;
  assert.match(englishDialog.message(), /new Profile name/u);
  assert.equal(englishDialog.defaultValue(), 'Work');
  await englishDialog.accept('Work renamed');
  await englishClick;
  await page.getByRole('heading', { name: 'Work renamed', exact: true }).waitFor();
  assert.match(await page.locator('#dashboard-message').textContent(), /Profile renamed/u);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    shortTargets: [...document.querySelectorAll('button, input')]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden';
      })
      .filter((node) => node.getBoundingClientRect().height < 43.5)
      .map((node) => node.id || node.textContent.trim())
  }));
  assert.equal(mobile.scrollWidth <= mobile.width, true);
  assert.deepEqual(mobile.shortTargets, []);
  assert.ok(await page.locator('.brand').evaluate((node) => node.getBoundingClientRect().height >= 44));
  assert.equal(await page.locator('.website-link').textContent(), 'NPC Site ↗');
  if (screenshotPath) {
    await page.screenshot({ path: path.join(path.dirname(screenshotPath), 'panel-mobile.png'), fullPage: true });
  }
  await page.keyboard.press('Tab');
  assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
  checks.push('Chinese and English layouts remain keyboard-accessible with 44px targets and no mobile overflow');

  await page.getByRole('button', { name: '切换到中文', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 960 });
  if (screenshotPath) {
    await mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: profilesScreenshotPath, fullPage: true });
  }
  await page.getByRole('button', { name: '任务', exact: true }).click();
  if (screenshotPath) {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }

  const allowedApi = /^\/v1\/(?:status|cleanup|tasks(?:\/[^/]+(?:\/actions)?)?|profiles(?:\/[^/]+(?:\/actions)?)?)$/u;
  const unexpectedApi = calls.requests.filter((entry) => entry.pathname.startsWith('/v1/') && !allowedApi.test(entry.pathname));
  assert.deepEqual(unexpectedApi, []);
  assert.deepEqual(pageErrors, []);
  checks.push('Dashboard uses only status, task, Profile, and cleanup APIs and raises no page errors');

  const report = {
    ok: true,
    version: packageJson.version,
    browser: 'playwright-chromium',
    checks,
    taskActions: calls.taskActions,
    taskDeletes: calls.taskDeletes,
    profileActions: calls.profileActions,
    profileRenames: calls.profileRenames,
    profileDeletes: calls.profileDeletes,
    cleanupRequests: calls.cleanup,
    screenshots: screenshotPath ? { tasks: screenshotPath, activeTasks: activeTasksScreenshotPath, profiles: profilesScreenshotPath, cleanup: cleanupScreenshotPaths } : null,
    pageErrors
  };
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const failure = {
    ok: false,
    version: packageJson.version,
    browser: 'playwright-chromium',
    checks,
    pageErrors,
    error: { name: error.name, message: error.message, stack: error.stack }
  };
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
  }
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await closeServer(server).catch(() => {});
}
