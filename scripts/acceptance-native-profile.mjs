#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createNativeChrome } from '../src/runtime/native-chrome.mjs';
import { launchChromeProfile } from '../src/runtime/browser-engine.mjs';
import { probeChromeProfileUsage } from '../src/lib/process-tree.mjs';
import { cleanManagedPath } from '../src/lib/space-cleanup.mjs';
import { VERSION } from '../src/contracts.mjs';

// Only a disposable local fixture is visited. No user accounts or installed Profiles are used.
const directory = await mkdtemp(path.join(os.tmpdir(), 'Task Master native profile '));
const profile = { userDataDir: directory };
let acknowledge;
const stored = new Promise((resolve) => { acknowledge = resolve; });
const server = http.createServer((request, response) => {
  if (request.url === '/stored') { acknowledge(); response.end('ok'); return; }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>Native Profile acceptance</title><p>Isolated local fixture</p>'
    + '<script>if (!localStorage.getItem("native-profile-proof")) {'
    + 'localStorage.setItem("native-profile-proof", "preserved"); fetch("/stored"); }</script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let native;
let automated;
let failure;
const report = { ok: false, version: VERSION, isolatedProfile: true, checks: [] };
try {
  native = await createNativeChrome(profile, { initialUrl: url });
  await native.ready();
  let timer;
  try {
    await Promise.race([stored, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native fixture did not load')), 30_000); })]);
  } finally { clearTimeout(timer); }
  report.checks.push('ordinary Chrome opens a local fixture and stores localStorage without a debugging connection');
  assert.equal(await native.close(), true, 'Native browser close was not confirmed');
  assert.equal(await probeChromeProfileUsage(directory), 'inactive');
  native = null;
  report.checks.push('native browser completely exits before automation can reuse the directory');
  automated = await launchChromeProfile({ chromium }, profile);
  const page = automated.pages()[0] || await automated.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.evaluate(() => localStorage.getItem('native-profile-proof')), 'preserved');
  report.checks.push('Playwright reopens the same Profile and reads native-created localStorage');
  // Synthetic login state only: never access a real user's Google account.
  await automated.addCookies([{
    name: 'acceptance_login', value: 'synthetic', url,
    expires: Math.floor(Date.now() / 1000) + 3600
  }]);
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('acceptance-login', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('state', 'readwrite');
        transaction.objectStore('state').put('preserved', 'login');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
  });
  await automated.close();
  automated = null;
  assert.equal(await probeChromeProfileUsage(directory), 'inactive');
  const fixtureCache = path.join(directory, 'Default', 'Cache');
  await mkdir(fixtureCache, { recursive: true });
  await writeFile(path.join(fixtureCache, 'cleanup-fixture'), 'disposable');
  let cleanedBytes = 0;
  for (const cache of ['Cache', 'Code Cache', 'GPUCache']) {
    const result = await cleanManagedPath({ root: directory, relativePath: `Default/${cache}`, preview: false });
    assert.deepEqual(result.failed, []);
    cleanedBytes += result.bytes;
  }
  assert.ok(cleanedBytes >= 10);
  automated = await launchChromeProfile({ chromium }, profile);
  const restored = automated.pages()[0] || await automated.newPage();
  await restored.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(await restored.evaluate(() => localStorage.getItem('native-profile-proof')), 'preserved');
  assert.ok((await automated.cookies(url)).some((cookie) => cookie.name === 'acceptance_login' && cookie.value === 'synthetic'));
  assert.equal(await restored.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('acceptance-login', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('state').objectStore('state').get('login');
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  })), 'preserved');
  report.checks.push('cache deletion preserves persistent cookies, localStorage and IndexedDB across real Chrome restarts');
} catch (error) { failure = error; }
finally {
  if (automated) await automated.close().catch((error) => { failure ||= error; });
  if (native && !(await native.close())) failure ||= new Error('Native Chrome cleanup is unconfirmed');
  report.profileInactive = await probeChromeProfileUsage(directory) === 'inactive';
  await new Promise((resolve) => server.close(resolve));
  if (report.profileInactive) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else failure ||= new Error('Profile still belongs to a Chrome process; temporary data was preserved');
  report.ok = !failure;
  if (failure) report.error = failure.message;
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/native-profile-acceptance.json', `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report)}\n`);
if (failure) throw failure;
