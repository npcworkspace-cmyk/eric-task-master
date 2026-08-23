import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { runSessionImport } from '../src/runtime/import-session-worker.mjs';

let nextPid = 40_000;
const ADMIN = Object.freeze({ role: 'manager-admin', clientId: 'manager-admin' });

class FakeWorker extends EventEmitter {
  constructor(onSend) {
    super();
    this.pid = nextPid += 1;
    this.connected = true;
    this.exitCode = null;
    this.onSend = onSend;
  }

  send(message, _handle, _options, callback) {
    this.onSend?.(message, this);
    callback?.();
  }

  finish(code = 0, signal = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.connected = false;
    this.emit('exit', code, signal);
  }

  kill(signal = 'SIGTERM') {
    this.finish(0, signal);
    return true;
  }
}

function fakeProfileStore(root) {
  const profile = {
    id: 'profile_test',
    name: 'Test',
    userDataDir: path.join(root, 'profile'),
    defaultBehavior: 'fast',
    state: 'idle',
    lease: null
  };
  const events = [];
  return {
    profile,
    events,
    async get(id) {
      if (id !== profile.id) throw new Error('not found');
      return structuredClone(profile);
    },
    async acquireLease(id, ownerId, options) {
      if (id !== profile.id) throw new Error('not found');
      if (profile.lease && profile.lease.ownerId !== ownerId) throw new Error('leased');
      profile.lease = { ownerId, pid: options.pid };
      profile.state = ownerId.startsWith('profile-open:') ? 'open' : 'leased';
      events.push(['acquire', ownerId, options.pid]);
      return structuredClone(profile);
    },
    async releaseLease(id, ownerId) {
      if (id !== profile.id) throw new Error('not found');
      if (profile.lease?.ownerId === ownerId) {
        profile.lease = null;
        profile.state = 'idle';
        events.push(['release', ownerId]);
        return true;
      }
      return false;
    }
  };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

test('task service isolates work in a child, tracks progress, and releases its lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  let workerKind;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    workerFactory(_workerPath, kind) {
      workerKind = kind;
      return new FakeWorker((message, child) => {
        if (message.type !== 'start') return;
        setImmediate(() => {
          child.emit('message', { type: 'heartbeat', at: new Date().toISOString() });
          child.emit('message', { type: 'state', state: 'running' });
          child.emit('message', { type: 'progress', progress: { current: 1, total: 1, message: 'Done' } });
          child.emit('message', { type: 'result', result: { summary: 'Done', evidence: [] } });
          child.emit('message', { type: 'state', state: 'completed' });
          child.emit('message', { type: 'cleanup', browserClosed: true });
          child.finish(0);
        });
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);

  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'task-service-isolation',
    input: { secretNotReturned: 'value' }
  }, ADMIN);
  assert.equal(workerKind, 'task');
  assert.equal(created.profileId, 'profile_test');
  assert.equal('leaseOwner' in created, false);
  assert.equal('workerPid' in created, false);
  assert.equal('input' in created, false);

  const completed = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.state === 'completed' && current.cleanup.settled ? current : null;
  });
  assert.equal(completed.progress.current, 1);
  assert.equal(completed.cleanup.browserClosed, true);
  assert.equal(completed.cleanup.settled, true);
  assert.equal(store.profile.state, 'idle');
  assert.ok(store.events.some((event) => event[0] === 'release'));
  await service.close();
});

test('cancellation is terminal and still releases the profile lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    diagnosticGraceMs: 25,
    workerFactory() {
      return new FakeWorker((message, child) => {
        if (message.type === 'start') {
          setImmediate(() => child.emit('message', { type: 'heartbeat', at: new Date().toISOString() }));
        }
        if (message.type === 'cancel') {
          setImmediate(() => {
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish(0);
          });
        }
      });
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);

  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'fixture',
    idempotencyKey: 'task-service-cancellation'
  }, ADMIN);
  const cancelled = await service.cancel(created.id, ADMIN);
  assert.equal(cancelled.state, 'cancelled');
  const cleaned = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.cleanup.settled ? current : null;
  });
  assert.equal(cleaned.state, 'cancelled');
  assert.equal(cleaned.cleanup.settled, true);
  assert.equal(store.profile.state, 'idle');
  await service.close();
});

test('session import response never echoes cookie or localStorage values', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'session-import');
      return new FakeWorker((message, child) => {
        if (message.type !== 'import') return;
        setImmediate(() => child.emit('message', {
          type: 'result',
          result: {
            status: 'partial',
            cookieCount: 1,
            localStorageCount: 1,
            verification: 'storage_replaced_not_login_verified'
          }
        }));
      });
    }
  });
  const result = await service.importSession('profile_test', {
    origin: 'https://example.test',
    cookies: [{ name: 'session', value: 'cookie-secret' }],
    localStorage: [{ name: 'token', value: 'storage-secret' }],
    source: { extensionId: 'fixture', tabUrl: 'https://example.test/' }
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.cookieCount, 1);
  assert.equal(result.localStorageCount, 1);
  assert.equal(result.verification, 'storage_replaced_not_login_verified');
  assert.doesNotMatch(JSON.stringify(result), /cookie-secret|storage-secret/);
  assert.equal(store.profile.state, 'idle');
  await service.close();
});

test('session import timeout requests rollback before releasing the Profile lease', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-import-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  const messages = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    sessionImportTimeoutMs: 20,
    sessionImportRollbackGraceMs: 100,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'session-import');
      return new FakeWorker((message, child) => {
        messages.push(message.type);
        if (message.type === 'cancel') {
          setImmediate(() => child.emit('message', {
            type: 'error',
            error: { code: 'SESSION_IMPORT_CANCELLED', message: 'Session import was cancelled' }
          }));
        }
      });
    }
  });

  await assert.rejects(service.importSession('profile_test', {
    origin: 'https://example.test',
    cookies: [{ name: 'session', value: 'cookie-secret' }],
    localStorage: [{ name: 'token', value: 'storage-secret' }],
    source: { extensionId: 'fixture', tabUrl: 'https://example.test/' }
  }), { code: 'SESSION_IMPORT_TIMEOUT' });
  assert.deepEqual(messages, ['import', 'cancel']);
  assert.equal(store.profile.state, 'idle');
  await service.close();
});

test('session import worker maps Chrome state into a persistent context without a state file', async () => {
  const calls = [];
  const sourceCookies = [{
    name: 'persistent',
    value: 'secret',
    domain: '.example.test',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'no_restriction',
    expirationDate: 2_000_000_000
  }, {
    name: 'session',
    value: 'temporary-secret',
    domain: '.example.test',
    path: '/',
    session: true,
    httpOnly: true,
    secure: true,
    sameSite: 'lax'
  }];
  let currentUrl = 'about:blank';
  let storedCookies = [];
  let storedEntries = [];
  const page = {
    async route() {},
    async unroute() {},
    async goto(url, options) {
      currentUrl = url;
      calls.push(['goto', url, options]);
    },
    url() { return currentUrl; },
    async evaluate(_callback, entries) {
      if (Array.isArray(entries)) {
        storedEntries = structuredClone(entries);
        calls.push(['evaluate-write', entries.length]);
        return entries.length;
      }
      calls.push(['evaluate-read', storedEntries.length]);
      return structuredClone(storedEntries);
    }
  };
  const context = {
    pages() { return [page]; },
    async addCookies(cookies) {
      calls.push(['cookies', cookies]);
      storedCookies = cookies.map((cookie) => ({
        ...cookie,
        domain: cookie.domain || new URL(cookie.url).hostname,
        path: cookie.path || new URL(cookie.url).pathname || '/',
        expires: cookie.expires ?? -1,
        sameSite: cookie.sameSite || 'Lax'
      }));
    },
    async clearCookies() { storedCookies = []; },
    async cookies() { return structuredClone(storedCookies); },
    async close() { calls.push(['close']); }
  };
  const result = await runSessionImport({
    profile: { userDataDir: 'fixture-profile' },
    bundle: {
      origin: 'https://www.example.test',
      cookies: sourceCookies,
      localStorage: [{ name: 'state', value: 'private' }],
      source: { extensionId: 'fixture', tabUrl: 'https://www.example.test/account' }
    }
  }, {
    loadPlaywright: async () => ({
      chromium: {
        async launchPersistentContext(userDataDir, options) {
          calls.push(['launch', userDataDir, options]);
          return context;
        }
      }
    })
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.verification, 'storage_replaced_not_login_verified');
  assert.equal(result.cookieCount, 2);
  assert.equal(result.localStorageCount, 1);
  const importedCookies = calls.find((item) => item[0] === 'cookies')[1];
  const importedCookie = importedCookies.find((cookie) => cookie.name === 'persistent');
  assert.equal(importedCookie.sameSite, 'None');
  assert.equal(importedCookie.expires, 2_000_000_000);
  const importedSessionCookie = importedCookies.find((cookie) => cookie.name === 'session');
  const twelveHoursFromNow = Math.floor(Date.now() / 1_000) + 12 * 60 * 60;
  assert.ok(Math.abs(importedSessionCookie.expires - twelveHoursFromNow) <= 2);
  assert.equal(result.sessionCookieRetentionHours, 12);
  assert.equal(calls.find((item) => item[0] === 'launch')[2].headless, true);
  assert.equal(calls.find((item) => item[0] === 'launch')[2].serviceWorkers, 'block');
  assert.deepEqual(storedEntries, [{ name: 'state', value: 'private' }]);
  assert.equal(calls.at(-1)[0], 'close');
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
});

test('manual profile window holds one lease until it closes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-open-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = fakeProfileStore(root);
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    workerFactory(_workerPath, kind) {
      assert.equal(kind, 'profile-open');
      return new FakeWorker((message, child) => {
        if (message.type === 'open') setImmediate(() => child.emit('message', { type: 'ready' }));
        if (message.type === 'close') setImmediate(() => child.finish(0));
      });
    }
  });

  const opened = await service.openProfile('profile_test');
  assert.equal(opened.status, 'open');
  assert.equal(store.profile.state, 'open');
  assert.match(store.profile.lease.ownerId, /^profile-open:manager-admin:profile_test:[a-f0-9]{32}$/);

  const closed = await service.closeProfile('profile_test');
  assert.equal(closed.status, 'closed');
  assert.equal(store.profile.state, 'idle');
  assert.equal(store.profile.lease, null);
  await service.close();
});

test('task history survives Manager restart and interrupted work is fail-closed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const completed = {
    id: 'task_completed',
    profileId: 'profile_test',
    state: 'completed',
    progress: { current: 1, total: 1, message: 'Done' },
    cleanup: { browserClosed: true, leaseReleased: true, workerExited: true },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    leaseHeld: false,
    leaseOwner: 'task:task_completed'
  };
  const interrupted = {
    id: 'task_interrupted',
    profileId: 'profile_test',
    state: 'running',
    progress: { current: 3, total: 10, message: 'Working' },
    cleanup: { browserClosed: false, leaseReleased: false, workerExited: false },
    checkpoint: { path: path.join(stateDir, 'task_interrupted', 'checkpoint.json') },
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:01.000Z',
    leaseHeld: true,
    leaseOwner: 'task:task_interrupted'
  };
  for (const task of [completed, interrupted]) {
    const taskDir = path.join(stateDir, task.id);
    await mkdir(taskDir, { recursive: true });
    await writeFile(path.join(taskDir, 'task.json'), JSON.stringify(task));
  }

  const service = createTaskService({ stateDir, profileStore: fakeProfileStore(root) });
  const page = await service.list({ caller: ADMIN });
  assert.equal(page.tasks.length, 2);
  assert.equal((await service.get('task_completed', ADMIN)).state, 'completed');
  const recovered = await service.get('task_interrupted', ADMIN);
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.error.code, 'TASK_INTERRUPTED_BY_MANAGER_RESTART');
  assert.equal(recovered.cleanup.managerRestartObserved, true);
  assert.equal(recovered.checkpoint.ref, 'taskmaster://tasks/task_interrupted/checkpoint');
  await service.close();
});

test('real Chromium executes the full acceptance task and cleans up', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1'
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-real-browser-'));
  const fixture = await readFile(path.resolve('test/fixtures/acceptance.html'));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fixture);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const store = fakeProfileStore(root);
  store.profile.headless = true;
  const service = createTaskService({ stateDir: path.join(root, 'state'), profileStore: store });
  const address = server.address();
  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'acceptance',
    idempotencyKey: 'legacy-real-browser-acceptance',
    input: {
      url: `http://127.0.0.1:${address.port}/acceptance`,
      uploadPath: path.resolve('test/fixtures/upload.txt')
    },
    behavior: 'fast',
    timeoutMs: 60_000
  }, ADMIN);
  const terminal = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return ['completed', 'failed', 'cancelled'].includes(current.state) && current.cleanup.settled
      ? current
      : null;
  }, 60_000);

  assert.equal(terminal.state, 'completed', JSON.stringify(terminal.error));
  assert.match(terminal.result.summary, /acceptance passed/i);
  assert.equal(terminal.cleanup.browserClosed, true);
  const artifacts = await service.listArtifacts(terminal.id, ADMIN);
  const reportArtifact = artifacts.find((artifact) => artifact.name === 'acceptance.json');
  assert.ok(reportArtifact);
  const reportChunk = await service.readArtifact(
    terminal.id,
    reportArtifact.id,
    { offset: 0, maxBytes: 48 * 1024 },
    ADMIN
  );
  assert.equal(reportChunk.encoding, 'utf8');
  assert.equal(reportChunk.eof, true);
  const report = JSON.parse(reportChunk.chunk);
  assert.equal(report.passed, true);
  assert.ok(report.evidence.every((item) => item.ok));
  await service.close();
});

test('a timed-out module cannot outlive its child or keep the Profile leased', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 60_000
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-timeout-boundary-'));
  const modulePath = path.join(root, 'never-settles.mjs');
  await writeFile(modulePath, [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    'export async function run({ outputDir }) {',
    "  const tickPath = path.join(outputDir, 'ticks.txt');",
    '  let ticks = 1;',
    '  writeFileSync(tickPath, String(ticks));',
    "  setInterval(() => { ticks += 1; writeFileSync(tickPath, String(ticks)); }, 25);",
    '  await new Promise(() => {});',
    '}',
    ''
  ].join('\n'));
  const store = fakeProfileStore(root);
  store.profile.headless = true;
  const service = createTaskService({
    stateDir: path.join(root, 'state'),
    profileStore: store,
    allowedTaskRoots: [root],
    seedTaskTypes: [],
    diagnosticGraceMs: 250
  });
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await service.installTaskType({ name: 'never-settles', modulePath }, ADMIN);
  const created = await service.create({
    profileId: 'profile_test',
    taskType: 'never-settles',
    idempotencyKey: 'timeout-process-boundary',
    timeoutMs: 1_000
  }, ADMIN);
  const terminal = await waitFor(async () => {
    const current = await service.get(created.id, ADMIN);
    return current.cleanup?.settled ? current : null;
  }, 30_000);
  assert.equal(terminal.state, 'failed');
  assert.equal(terminal.error.code, 'TASK_TIMEOUT');
  assert.equal(terminal.cleanup.browserClosed, true);
  assert.equal(terminal.cleanup.workerExited, true);
  assert.equal(store.profile.lease, null);

  const tickPath = path.join(root, 'state', created.id, 'output', 'ticks.txt');
  const atCleanup = Number(await readFile(tickPath, 'utf8'));
  assert.ok(atCleanup > 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(Number(await readFile(tickPath, 'utf8')), atCleanup);
});
