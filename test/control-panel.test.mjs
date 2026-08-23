import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

async function text(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('extension is a minimal Manifest V3 control plane', async () => {
  const manifest = JSON.parse(await text('extension/manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '0.0.1');
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.equal('content_scripts' in manifest, false);
  assert.equal('devtools_page' in manifest, false);
  assert.deepEqual(new Set(manifest.permissions), new Set(['activeTab', 'cookies', 'scripting', 'storage']));
  assert.deepEqual(new Set(manifest.host_permissions), new Set(['http://127.0.0.1/*', 'http://localhost/*']));
  assert.deepEqual(new Set(manifest.optional_host_permissions), new Set(['http://*/*', 'https://*/*']));
});

test('session transfer requires the popup user gesture and stays origin scoped', async () => {
  const source = await text('extension/popup.js');
  assert.match(source, /syncSession\.addEventListener\('click', syncCurrentSite\)/);
  assert.match(source, /chrome\.permissions\.request\(\{ origins:/);
  assert.match(source, /chrome\.cookies\.getAll\(\{ url: activeSite\.url\.href \}\)/);
  assert.match(source, /chrome\.scripting\.executeScript/);
  assert.match(source, /origin: activeSite\.url\.origin/);
  assert.match(source, /hostOnly: Boolean\(cookie\.hostOnly\)/);
  assert.match(source, /session: Boolean\(cookie\.session\)/);
  assert.match(source, /mapped\.expirationDate = cookie\.expirationDate/);
  assert.match(source, /tabUrl: activeSite\.url\.origin/);
  assert.doesNotMatch(source, /登录态已同步并验证/);
  assert.match(source, /\/session`/);
  assert.doesNotMatch(source, /chrome\.storage\.local\.set\(\{[^}]*cookies/is);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
});

test('extension contains no webpage automation surface', async () => {
  const files = await Promise.all([
    text('extension/popup.js'),
    text('extension/service-worker.js'),
    text('extension/manifest.json')
  ]);
  const source = files.join('\n');
  for (const forbidden of [
    /chrome\.debugger/,
    /document\.querySelector\([^)]*\)\.click/,
    /dispatchEvent/,
    /MouseEvent/,
    /KeyboardEvent/,
    /Input\.dispatch/,
    /tabs\.update/,
    /eval\(/,
    /new Function/
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test('popup exposes pairing, profile controls, behavior modes, session sync, and dashboard', async () => {
  const html = await text('extension/popup.html');
  for (const id of [
    'discover-manager',
    'pair-extension',
    'create-profile',
    'profile-list',
    'session-profile',
    'sync-session',
    'open-dashboard'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const mode of ['fast', 'human', 'adaptive']) assert.match(html, new RegExp(`value="${mode}"`));
  assert.match(html, /id="new-profile-headless"/);
  assert.match(html, /<script type="module" src="popup\.js"><\/script>/);
});

test('dashboard manages profiles and tasks with refresh, cancel, and same-origin results', async () => {
  const [html, source] = await Promise.all([
    text('dashboard/index.html'),
    text('dashboard/dashboard.js')
  ]);
  assert.match(html, /id="profiles"/);
  assert.match(html, /id="tasks"/);
  assert.match(html, /id="profile-headless"/);
  assert.match(html, /id="task-result-dialog"/);
  assert.match(source, /request\('\/v1\/profiles'/);
  assert.match(source, /request\('\/v1\/tasks'/);
  assert.match(source, /\/cancel`/);
  assert.match(source, /setInterval\(\(\) => void refresh\(\), 5000\)/);
  assert.match(source, /url\.origin === location\.origin/);
  assert.match(source, /showTaskResult\(task\)/);
  assert.match(source, /sessionStorage\.setItem\(TOKEN_KEY/);
  assert.match(source, /history\.replaceState/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /console\.(?:log|info|debug|warn|error)/);
});
