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
const profilesScreenshotPath = screenshotPath
  ? path.join(
      path.dirname(screenshotPath),
      `${path.basename(screenshotPath, path.extname(screenshotPath))}-profiles${path.extname(screenshotPath) || '.png'}`
    )
  : null;
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
  defaultChanges: []
};

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
    ['/dashboard/dashboard.js', 'dashboard.js']
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
    if (body.isDefault !== true) {
      json(response, 400, { error: { code: 'INVALID_PROFILE_PATCH', message: 'Only isDefault is supported' } });
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
  await page.getByRole('heading', { name: '任务进度', exact: true }).waitFor();
  await page.locator('.task-card').first().waitFor();
  assert.equal(await page.locator('.task-card').count(), 3);
  assert.match(await page.locator('#task-count-chip').textContent(), /2 个运行中/u);
  assert.match(await page.locator('.task-card').filter({ hasText: 'Collect 20 pages' }).textContent(), /7\s*\/\s*20/u);
  assert.match(await page.locator('.task-card').filter({ hasText: 'Review open-ended feed' }).textContent(), /已处理 31/u);
  assert.equal(await page.locator('.task-card.is-targeted').count(), 1);
  checks.push('fixed Dashboard URL loads Tasks first, deep-links one task, and renders bounded and open-ended progress');

  const rejectApi = (route) => route.abort('connectionrefused');
  await page.route('**/v1/**', rejectApi);
  await page.locator('#refresh-all').click();
  await page.locator('#offline-banner:not(.hidden)').waitFor();
  assert.equal(await page.locator('.task-card').count(), 3);
  await page.unroute('**/v1/**', rejectApi);
  await page.locator('#retry-offline').click();
  await page.locator('#offline-banner').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.task-card').count(), 3);
  checks.push('a temporary Manager outage keeps the last task state and recovers in place');

  const runningCard = page.locator('.task-card').filter({ hasText: 'Collect 20 pages' });
  await runningCard.getByRole('button', { name: '停止', exact: true }).evaluate((node) => {
    node.click();
    node.click();
  });
  await waitUntil(() => tasks.get('task_running')?.state === 'stopped', 'task stop');
  await runningCard.getByRole('button', { name: '恢复', exact: true }).waitFor();
  assert.equal(calls.taskActions.filter((entry) => entry.id === 'task_running' && entry.action === 'stop').length, 1);
  await runningCard.getByRole('button', { name: '恢复', exact: true }).click();
  await waitUntil(() => tasks.get('task_running')?.state === 'running', 'task resume');
  await runningCard.getByRole('button', { name: '停止', exact: true }).waitFor();
  assert.deepEqual(calls.taskActions.filter((entry) => entry.id === 'task_running').map((entry) => entry.action), ['stop', 'resume']);
  checks.push('task stop and resume are idempotent at the UI boundary and retain current progress');

  const waitingCard = page.locator('.task-card').filter({ hasText: 'Review open-ended feed' });
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
  const researchCard = page.locator('.profile-card').filter({ hasText: 'Research' });
  await researchCard.waitFor();
  assert.deepEqual(calls.profileCreates.at(-1), { name: 'Research' });
  assert.equal(Object.keys(calls.profileCreates.at(-1)).length, 1);

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

  const allowedApi = /^\/v1\/(?:status|tasks(?:\/[^/]+(?:\/actions)?)?|profiles(?:\/[^/]+(?:\/actions)?)?)$/u;
  const unexpectedApi = calls.requests.filter((entry) => entry.pathname.startsWith('/v1/') && !allowedApi.test(entry.pathname));
  assert.deepEqual(unexpectedApi, []);
  assert.deepEqual(pageErrors, []);
  checks.push('Dashboard uses only status, task, and Profile APIs and raises no page errors');

  const report = {
    ok: true,
    version: packageJson.version,
    browser: 'playwright-chromium',
    checks,
    taskActions: calls.taskActions,
    taskDeletes: calls.taskDeletes,
    profileActions: calls.profileActions,
    profileDeletes: calls.profileDeletes,
    screenshots: screenshotPath ? { tasks: screenshotPath, profiles: profilesScreenshotPath } : null,
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
