#!/usr/bin/env node
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManager } from '../src/manager.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { TERMINAL_TASK_STATES, VERSION } from '../src/contracts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function api(baseUrl, pathname, {
  method = 'GET', body, token, timeoutMs = 15_000, headers: extraHeaders = {}
} = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload.error || payload;
    throw Object.assign(new Error(detail.message || `HTTP ${response.status}`), {
      code: detail.code || `HTTP_${response.status}`
    });
  }
  return payload;
}

async function fixtureServer() {
  const html = await readFile(resolve(ROOT, 'test', 'fixtures', 'acceptance.html'));
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  };
}

async function waitForTask(baseUrl, token, id, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    ({ task } = await api(baseUrl, `/v1/tasks/${encodeURIComponent(id)}`, { token }));
    if (
      TERMINAL_TASK_STATES.has(task.state) &&
      task.cleanup?.settled
    ) return task;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw Object.assign(new Error(`Task ${id} did not finish cleanup`), { code: 'ACCEPTANCE_TASK_TIMEOUT', task });
}

function evidenceMap(tasks) {
  const map = new Map();
  for (const task of tasks) {
    for (const item of task.result?.evidence || []) {
      if (!map.has(item.kind)) map.set(item.kind, []);
      map.get(item.kind).push(item);
    }
  }
  return map;
}

export async function runAcceptance({ baseUrl, token } = {}) {
  if (!baseUrl || !token) throw new TypeError('runAcceptance requires baseUrl and token');
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  const fixture = await fixtureServer();
  let profile;
  const tasks = [];
  try {
    const health = await api(baseUrl, '/v1/health');
    add('manager health', health.ok && health.service === 'eric-task-master');
    add('version contract', health.version === VERSION && health.apiVersion === 1, health.version);

    const manifest = JSON.parse(await readFile(resolve(ROOT, 'extension', 'manifest.json'), 'utf8'));
    add('extension manifest', manifest.manifest_version === 3 && manifest.version === VERSION);
    const manifestText = JSON.stringify(manifest);
    add(
      'extension control-only boundary',
      !manifestText.includes('debugger') && !manifestText.includes('devtools') && !manifest.content_scripts
    );

    ({ profile } = await api(baseUrl, '/v1/profiles', {
      method: 'POST',
      token,
      body: {
        name: `Acceptance ${Date.now()}`,
        defaultBehavior: 'fast',
        headless: true
      }
    }));
    add('isolated profile creation', profile?.id && profile.state === 'idle' && profile.headless === true);

    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
    const challenge = await api(baseUrl, '/v1/pair/challenge', {
      headers: { Origin: extensionOrigin }
    });
    const paired = await api(baseUrl, '/v1/pair/extension', {
      method: 'POST',
      headers: { Origin: extensionOrigin },
      body: { challenge: challenge.challenge, name: 'Acceptance extension' }
    });
    add('extension challenge pairing', typeof paired.token === 'string' && paired.token.length >= 32);

    const fixtureOrigin = new URL(fixture.url).origin;
    const secretMarker = 'secret-must-not-echo';
    const imported = await api(baseUrl, `/v1/profiles/${encodeURIComponent(profile.id)}/session`, {
      method: 'POST',
      token: paired.token,
      headers: { Origin: extensionOrigin },
      timeoutMs: 60_000,
      body: {
        origin: fixtureOrigin,
        cookies: [{
          name: 'taskmaster_imported',
          value: 'accepted',
          domain: '127.0.0.1',
          path: '/',
          hostOnly: true,
          session: true,
          httpOnly: false,
          secure: false,
          sameSite: 'lax'
        }, {
          name: 'taskmaster_private_marker',
          value: secretMarker,
          domain: '127.0.0.1',
          path: '/',
          hostOnly: true,
          session: true,
          httpOnly: true,
          secure: false,
          sameSite: 'lax'
        }],
        localStorage: [{ name: 'taskmaster_imported', value: 'accepted' }],
        source: { extensionId: 'ignored-by-manager', tabUrl: fixtureOrigin }
      }
    });
    add(
      'session bridge privacy and import',
      imported.status === 'partial' &&
      imported.verification === 'storage_imported_not_login_verified' &&
      imported.cookieCount === 2 &&
      imported.localStorageCount === 1 &&
      imported.sessionCookieRetentionHours === 12 &&
      !JSON.stringify(imported).includes(secretMarker)
    );

    const modulePath = resolve(ROOT, 'examples', 'tasks', 'acceptance-task.mjs');
    const uploadPath = resolve(ROOT, 'test', 'fixtures', 'upload.txt');
    for (const behavior of ['fast', 'human', 'adaptive']) {
      const created = await api(baseUrl, '/v1/tasks', {
        method: 'POST',
        token,
        body: {
          profileId: profile.id,
          modulePath,
          behavior,
          timeoutMs: 90_000,
          input: { url: fixture.url, uploadPath, expectedSession: true }
        }
      });
      const task = await waitForTask(baseUrl, token, created.task.id);
      tasks.push(task);
      add(
        `${behavior} behavior task`,
        task.state === 'completed',
        task.error ? `${task.error.code}: ${task.error.message}` : undefined
      );
    }

    const evidence = evidenceMap(tasks);
    const allTrue = (kind) => evidence.get(kind)?.length === 3 && evidence.get(kind).every((item) => item.ok);
    add('navigation', allTrue('navigation'));
    add('text input', allTrue('input'));
    add('click and select', allTrue('checkbox') && allTrue('select'));
    add('file upload', allTrue('upload'));
    add('cookie and local storage', allTrue('cookie') && allTrue('localStorage'));
    add(
      'imported session persisted',
      allTrue('session-import-cookie') && allTrue('session-import-storage')
    );
    add('file download', allTrue('download'));
    add('screenshot fallback primitive', allTrue('screenshot'));
    add(
      'progress and heartbeat',
      tasks.every((task) => task.progress?.current === 9 && task.progress?.total === 9 && task.heartbeatAt)
    );
    add(
      'checkpoint and compact evidence',
      tasks.every((task) => task.checkpoint?.path && task.result?.evidence?.length >= 10)
    );

    for (const task of tasks) {
      const report = task.result?.evidence?.find((item) => item.kind === 'report')?.value;
      if (report) await access(report);
      const screenshot = join(task.outputDir, 'acceptance.png');
      const download = join(task.outputDir, 'taskmaster-fixture.txt');
      if ((await stat(screenshot)).size === 0 || (await stat(download)).size === 0) {
        throw new Error(`Empty artifact for ${task.id}`);
      }
    }

    await api(baseUrl, `/v1/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE', token });
    const remaining = await api(baseUrl, '/v1/profiles', { token });
    add(
      'browser and profile cleanup',
      tasks.every((task) => task.cleanup?.browserClosed && task.cleanup?.leaseReleased && task.cleanup?.workerExited && task.cleanup?.settled) &&
      !remaining.profiles.some((item) => item.id === profile.id)
    );
    profile = null;
  } catch (error) {
    add('acceptance execution', false, `${error.code || 'ERROR'}: ${error.message}`);
  } finally {
    if (profile?.id) {
      await api(baseUrl, `/v1/profiles/${encodeURIComponent(profile.id)}/close`, { method: 'POST', token }).catch(() => {});
      await api(baseUrl, `/v1/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE', token }).catch(() => {});
    }
    await fixture.close();
  }

  const passed = checks.filter((check) => check.passed).length;
  const result = {
    ok: passed === checks.length,
    version: VERSION,
    passed,
    total: checks.length,
    checks,
    checkedAt: new Date().toISOString(),
    nextAction: passed === checks.length
      ? 'List profiles, then ask for the browser task.'
      : 'Read the first failed check, correct that cause, and rerun the same acceptance command.'
  };
  return result;
}

async function directRun() {
  const stateDir = await mkdtemp(join(tmpdir(), 'eric-task-master-acceptance-'));
  let manager;
  try {
    manager = await startManager({
      host: '127.0.0.1',
      port: 0,
      dataDir: stateDir,
      dashboardDir: resolve(ROOT, 'dashboard'),
      taskServiceFactory({ profileStore, stateDir: tasksDir }) {
        return createTaskService({ profileStore, stateDir: tasksDir });
      }
    });
    const result = await runAcceptance({ baseUrl: manager.baseUrl, token: manager.token });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await manager?.stop().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  directRun().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: { code: error.code || 'ACCEPTANCE_CRASHED', message: error.message },
      nextAction: 'Install Playwright Chromium and rerun npm run acceptance.'
    })}\n`);
    process.exitCode = 1;
  });
}
