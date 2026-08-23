import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { startManager } from '../src/manager.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

async function api(manager, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(new URL(pathname, manager.baseUrl), {
    method,
    headers: {
      Authorization: `Bearer ${manager.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload;
}

async function poll(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition was not reached; last=${JSON.stringify(last)}`);
}

async function startSessionFixture() {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end('<!doctype html><meta charset="utf-8"><title>Session fixture</title>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.2', resolve);
  });
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.2:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

test('the real MV3 panel pairs, manages a Playwright Profile, and opens a scoped Dashboard', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 180_000
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-extension-real-'));
  const fixture = await startSessionFixture();
  let manager;
  let browser;
  t.after(async () => {
    await browser?.close().catch(() => {});
    const profiles = manager
      ? await api(manager, '/v1/profiles').catch(() => ({ profiles: [] }))
      : { profiles: [] };
    for (const profile of profiles.profiles || []) {
      await api(manager, `/v1/profiles/${encodeURIComponent(profile.id)}/close`, { method: 'POST' }).catch(() => {});
      await api(manager, `/v1/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' }).catch(() => {});
    }
    await manager?.stop().catch(() => {});
    await fixture.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });
  manager = await startManager({
    host: '127.0.0.1',
    port: 0,
    dataDir: path.join(root, 'manager'),
    dashboardDir: path.join(ROOT, 'dashboard'),
    taskServiceFactory(taskOptions) {
      return createTaskService(taskOptions);
    }
  });

  const permissionPattern = 'http://127.0.0.2/*';
  const extensionPath = path.join(root, 'extension-under-test');
  const extensionProfilePath = path.join(root, 'extension-profile');
  await cp(path.join(ROOT, 'extension'), extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const initialManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  initialManifest.host_permissions.push(permissionPattern);
  await writeFile(manifestPath, `${JSON.stringify(initialManifest, null, 2)}\n`);
  browser = await chromium.launchPersistentContext(extensionProfilePath, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  let [worker] = browser.serviceWorkers();
  if (!worker) worker = await browser.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  assert.match(extensionId, /^[a-p]{32}$/);
  const authorization = await api(manager, '/v1/pair/authorize', { method: 'POST', body: {} });
  let popup = await browser.newPage();
  const popupErrors = [];
  popup.on('pageerror', (error) => popupErrors.push(error.message));
  popup.on('console', (message) => {
    if (message.type() === 'error') popupErrors.push(message.text());
  });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#manager-origin').fill(manager.baseUrl);
  await popup.getByRole('button', { name: '保存', exact: true }).click();
  try {
    await poll(async () => (await popup.locator('#connection-label').textContent())?.includes('已发现'));
  } catch (error) {
    const diagnostics = await popup.evaluate(async (errors) => ({
      label: document.querySelector('#connection-label')?.textContent,
      message: document.querySelector('#status-message')?.textContent,
      stored: await chrome.storage.local.get(['managerOrigin']),
      errors
    }), popupErrors).catch((failure) => ({ inspectionError: failure.message, errors: popupErrors }));
    error.message += ` diagnostics=${JSON.stringify(diagnostics)}`;
    throw error;
  }
  await popup.locator('#pairing-code').fill(authorization.pairingCode);
  await popup.getByRole('button', { name: '配对', exact: true }).click();
  try {
    await poll(async () => (await popup.locator('#status-message').textContent()) === '配对成功');
  } catch (error) {
    error.message += ` pairing=${JSON.stringify({
      label: await popup.locator('#connection-label').textContent(),
      message: await popup.locator('#status-message').textContent(),
      errors: popupErrors
    })}`;
    throw error;
  }
  const trustedStorage = await popup.evaluate(() => chrome.storage.local.get([
    'extensionToken',
    'trustedManagerIdentity'
  ]));
  assert.equal(typeof trustedStorage.extensionToken, 'string');
  assert.equal(
    trustedStorage.trustedManagerIdentity.fingerprint,
    authorization.pairingCode.split('.')[2]
  );
  assert.equal(trustedStorage.trustedManagerIdentity.origin, manager.baseUrl);

  const profileName = '真实扩展验收 Profile';
  await popup.locator('#new-profile-name').fill(profileName);
  await popup.locator('#new-profile-mode').selectOption('adaptive');
  await popup.locator('#new-profile-headless').check();
  await popup.getByRole('button', { name: '创建', exact: true }).click();
  let row = popup.locator('.profile-row').filter({ hasText: profileName });
  await row.waitFor();
  let profile = await poll(async () => {
    const list = await api(manager, '/v1/profiles');
    return list.profiles.find((item) => item.name === profileName);
  });
  assert.equal(profile.defaultBehavior, 'adaptive');
  assert.equal(profile.headless, true);

  // Seed a different account into the destination Profile so the transfer
  // proves replacement rather than a merge into an empty profile.
  const internalProfile = await manager.profileStore.get(profile.id);
  const destinationSeed = await chromium.launchPersistentContext(internalProfile.userDataDir, {
    channel: 'chromium',
    headless: true
  });
  const destinationSeedPage = destinationSeed.pages()[0] || await destinationSeed.newPage();
  await destinationSeedPage.goto(`${fixture.origin}/destination-seed`);
  await destinationSeedPage.evaluate(() => {
    document.cookie = 'old_account=old-cookie-value; Path=/; Max-Age=3600; SameSite=Lax';
    document.cookie = 'old_path=old-path-value; Path=/private; Max-Age=3600; SameSite=Lax';
    localStorage.setItem('old-account', 'old-storage-value');
    localStorage.setItem('stale-account', 'stale-storage-value');
  });
  await destinationSeed.close();

  // Headless Chromium cannot confirm an optional-host permission prompt from
  // an action popup. The isolated extension copy starts with the fixture host
  // required, then is relaunched after that host is downgraded to its existing
  // optional permission. Chromium retains the user-equivalent grant and the
  // production sync must revoke it. Production source files are not changed.
  await browser.close();
  browser = null;
  const optionalManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  optionalManifest.host_permissions = optionalManifest.host_permissions
    .filter((pattern) => pattern !== permissionPattern);
  await writeFile(manifestPath, `${JSON.stringify(optionalManifest, null, 2)}\n`);
  browser = await chromium.launchPersistentContext(extensionProfilePath, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  [worker] = browser.serviceWorkers();
  if (!worker) worker = await browser.waitForEvent('serviceworker');
  assert.equal(new URL(worker.url()).host, extensionId);
  popup = await browser.newPage();
  popup.on('pageerror', (error) => popupErrors.push(error.message));
  popup.on('console', (message) => {
    if (message.type() === 'error') popupErrors.push(message.text());
  });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await poll(async () => (await popup.locator('#connection-label').textContent()) === '已连接');
  row = popup.locator('.profile-row').filter({ hasText: profileName });
  await row.waitFor();
  assert.equal(await popup.evaluate(
    (pattern) => chrome.permissions.contains({ origins: [pattern] }),
    permissionPattern
  ), true);

  // This is an ordinary HTTP tab in the extension browser. The real popup
  // uses chrome.cookies, chrome.scripting, identity verification, and Manager
  // session import; only the invisible permission prompt was pre-authorized.
  const sourceSite = await browser.newPage();
  await sourceSite.goto(`${fixture.origin}/private/source-account`);
  await sourceSite.evaluate(() => {
    document.cookie = 'new_account=new-cookie-value; Path=/; SameSite=Lax';
    document.cookie = 'new_path=new-path-cookie-value; Path=/private; SameSite=Lax';
    localStorage.clear();
    localStorage.setItem('new-account', 'new-storage-value');
  });
  await sourceSite.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await poll(async () => (await popup.locator('#connection-label').textContent()) === '已连接');
  try {
    await poll(async () => (await popup.locator('#current-origin').textContent()) === fixture.origin);
  } catch (error) {
    error.message += ` activeSite=${JSON.stringify(await popup.evaluate(async () => ({
      text: document.querySelector('#current-origin')?.textContent,
      tabs: await chrome.tabs.query({ active: true, currentWindow: true })
    })))}`;
    throw error;
  }
  await popup.locator('#session-profile').selectOption(profile.id);
  assert.equal(await popup.evaluate(
    (pattern) => chrome.permissions.contains({ origins: [pattern] }),
    permissionPattern
  ), true);
  await popup.getByRole('button', { name: '授权并同步当前网站', exact: true }).click();
  await poll(async () => (await popup.locator('#status-message').textContent())?.includes('登录态已导入'), 60_000);
  assert.equal(await popup.evaluate(
    (pattern) => chrome.permissions.contains({ origins: [pattern] }),
    permissionPattern
  ), false);
  profile = await manager.profileStore.get(profile.id);
  assert.equal(profile.state, 'idle');
  assert.equal(profile.lease, null);

  const destinationVerify = await chromium.launchPersistentContext(internalProfile.userDataDir, {
    channel: 'chromium',
    headless: true
  });
  const destinationVerifyPage = destinationVerify.pages()[0] || await destinationVerify.newPage();
  await destinationVerifyPage.goto(`${fixture.origin}/verify`);
  const destinationCookies = (await destinationVerify.cookies()).filter((cookie) => (
    cookie.domain === '127.0.0.2'
  ));
  const destinationStorage = await destinationVerifyPage.evaluate(() => Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index);
      return [key, localStorage.getItem(key)];
    })
  ));
  assert.deepEqual(
    destinationCookies.map((cookie) => [cookie.name, cookie.value, cookie.path]).sort(),
    [
      ['new_account', 'new-cookie-value', '/'],
      ['new_path', 'new-path-cookie-value', '/private']
    ]
  );
  assert.deepEqual(destinationStorage, { 'new-account': 'new-storage-value' });
  await destinationVerify.close();

  await row.locator('select').selectOption('human');
  profile = await poll(async () => {
    const list = await api(manager, '/v1/profiles');
    const current = list.profiles.find((item) => item.id === profile.id);
    return current?.defaultBehavior === 'human' ? current : null;
  });

  await row.getByRole('button', { name: '打开', exact: true }).click();
  await poll(async () => {
    const list = await api(manager, '/v1/profiles');
    return list.profiles.find((item) => item.id === profile.id)?.state === 'open';
  }, 30_000);
  await row.getByRole('button', { name: '关闭', exact: true }).click();
  await poll(async () => {
    const list = await api(manager, '/v1/profiles');
    return list.profiles.find((item) => item.id === profile.id)?.state === 'idle';
  }, 30_000);

  const dashboardPromise = browser.waitForEvent('page');
  await popup.getByRole('button', { name: /打开任务 Dashboard/ }).click();
  const dashboard = await dashboardPromise;
  await dashboard.waitForLoadState('domcontentloaded');
  await poll(async () => (await dashboard.locator('#connection-label').textContent()) === '本机 Manager 已连接');
  assert.equal(new URL(dashboard.url()).hash, '');
  assert.equal(await dashboard.locator('#profile-count').textContent(), '1');
  const dashboardCard = dashboard.locator('.profile-card').filter({ hasText: profileName });
  await dashboardCard.waitFor();
  dashboard.once('dialog', (dialog) => dialog.accept());
  await dashboardCard.getByRole('button', { name: '删除', exact: true }).click();
  await poll(async () => (await api(manager, '/v1/profiles')).profiles.length === 0);

  await browser.close();
  browser = null;
  assert.deepEqual((await api(manager, '/v1/profiles')).profiles, []);
});
