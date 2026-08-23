import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBehaviorMode, TERMINAL_TASK_STATES } from '../contracts.mjs';

const TASK_WORKER = fileURLToPath(new URL('./task-worker.mjs', import.meta.url));
const PROFILE_WORKER = fileURLToPath(new URL('./profile-worker.mjs', import.meta.url));
const IMPORT_WORKER = fileURLToPath(new URL('./import-session-worker.mjs', import.meta.url));
const LEASE_TTL_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 65_000;
const DIAGNOSTIC_GRACE_MS = 15_000;

export class TaskServiceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'TaskServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function sanitizeError(error, fallbackCode = 'TASK_FAILED') {
  return {
    code: error?.code || fallbackCode,
    message: String(error?.message || 'Task failed').slice(0, 2_000),
    ...(error?.screenshot ? { screenshot: error.screenshot } : {})
  };
}

function defaultWorkerFactory(workerPath) {
  return fork(workerPath, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    windowsHide: true
  });
}

function send(child, message) {
  if (!child?.connected) return false;
  try {
    child.send(message, undefined, undefined, () => {});
    return true;
  } catch {
    return false;
  }
}

async function atomicJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function publicRecord(task) {
  const {
    leaseOwner: _leaseOwner,
    leaseHeld: _leaseHeld,
    workerPid: _workerPid,
    ...safe
  } = task;
  return clone(safe);
}

function taskId() {
  return `task_${randomUUID().replaceAll('-', '')}`;
}

export function createTaskService({
  stateDir,
  profileStore,
  workerFactory = defaultWorkerFactory,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  diagnosticGraceMs = DIAGNOSTIC_GRACE_MS
} = {}) {
  if (!stateDir) throw new TypeError('stateDir is required');
  if (!profileStore?.get || !profileStore?.acquireLease || !profileStore?.releaseLease) {
    throw new TypeError('profileStore with get/acquireLease/releaseLease is required');
  }

  const root = path.resolve(stateDir);
  const tasks = new Map();
  const children = new Map();
  const openProfiles = new Map();
  const persistChains = new Map();
  const ready = initialize();

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('task_')) continue;
      const filePath = path.join(root, entry.name, 'task.json');
      let task;
      try {
        task = JSON.parse(await readFile(filePath, 'utf8'));
      } catch {
        continue;
      }
      if (!task || task.id !== entry.name || typeof task.profileId !== 'string') continue;
      const cleanupComplete = Boolean(task.cleanup?.workerExited && task.cleanup?.leaseReleased);
      if (!TERMINAL_TASK_STATES.has(task.state) || !cleanupComplete) {
        task.state = 'failed';
        task.error = {
          code: 'TASK_INTERRUPTED_BY_MANAGER_RESTART',
          message: 'Manager restarted before task cleanup completed; inspect the checkpoint before resuming.'
        };
        task.progress = {
          ...(task.progress || { current: 0, total: null }),
          message: 'Interrupted by Manager restart; checkpoint preserved'
        };
        task.cleanup = { ...(task.cleanup || {}), managerRestartObserved: true };
        task.finishedAt ||= nowIso();
        task.updatedAt = nowIso();
        task.leaseHeld = false;
        await atomicJson(filePath, task);
      }
      tasks.set(task.id, task);
    }
  }

  function persist(task) {
    const taskRoot = path.join(root, task.id);
    const filePath = path.join(taskRoot, 'task.json');
    const previous = persistChains.get(task.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => mkdir(taskRoot, { recursive: true, mode: 0o700 }))
      .then(() => atomicJson(filePath, task));
    persistChains.set(task.id, next);
    return next;
  }

  function update(task, patch) {
    Object.assign(task, patch, { updatedAt: nowIso() });
    void persist(task);
    return task;
  }

  async function releaseTaskLease(task) {
    if (!task.leaseHeld) {
      task.cleanup.leaseReleased = true;
      return;
    }
    task.leaseHeld = false;
    try {
      await profileStore.releaseLease(task.profileId, task.leaseOwner);
      task.cleanup.leaseReleased = true;
    } catch (error) {
      task.cleanup.leaseReleaseError = sanitizeError(error, 'LEASE_RELEASE_FAILED');
    }
    update(task, { cleanup: task.cleanup });
  }

  async function finalizeTask(task, exitCode, signal) {
    const entry = children.get(task.id);
    if (entry?.finalized) return;
    if (entry) {
      entry.finalized = true;
      clearInterval(entry.watchdog);
      clearTimeout(entry.forceKillTimer);
    }
    children.delete(task.id);
    task.cleanup.workerExited = true;
    task.cleanup.exitCode = exitCode;
    task.cleanup.exitSignal = signal || null;
    if (!TERMINAL_TASK_STATES.has(task.state)) {
      update(task, {
        state: 'failed',
        error: { code: 'TASK_WORKER_EXITED', message: 'Task worker exited before reporting a terminal state' }
      });
    }
    await releaseTaskLease(task);
    task.cleanup.settled = true;
    update(task, { finishedAt: task.finishedAt || nowIso(), cleanup: task.cleanup });
    entry?.resolveExit?.();
  }

  function scheduleForcedStop(task, entry) {
    clearTimeout(entry.forceKillTimer);
    entry.forceKillTimer = setTimeout(() => {
      if (entry.child.exitCode === null) entry.child.kill('SIGTERM');
    }, diagnosticGraceMs);
    entry.forceKillTimer.unref?.();
  }

  function attachTaskWorker(task, child) {
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const entry = {
      child,
      finalized: false,
      diagnoseAt: 0,
      forceKillTimer: null,
      watchdog: null,
      exitPromise,
      resolveExit
    };
    children.set(task.id, entry);

    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'heartbeat') {
        entry.diagnoseAt = 0;
        clearTimeout(entry.forceKillTimer);
        entry.forceKillTimer = null;
        update(task, {
          heartbeatAt: message.at || nowIso(),
          ...(message.progress ? { progress: clone(message.progress) } : {})
        });
        void profileStore.acquireLease(task.profileId, task.leaseOwner, {
          pid: child.pid,
          ttlMs: LEASE_TTL_MS
        }).catch((error) => {
          if (TERMINAL_TASK_STATES.has(task.state)) return;
          update(task, { state: 'failed', error: sanitizeError(error, 'LEASE_RENEWAL_FAILED') });
          send(child, { type: 'cancel' });
          scheduleForcedStop(task, entry);
        });
        return;
      }
      if (message.type === 'progress' && message.progress) {
        update(task, { progress: clone(message.progress), heartbeatAt: message.at || nowIso() });
        return;
      }
      if (message.type === 'state' && typeof message.state === 'string') {
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          update(task, {
            state: message.state,
            ...(TERMINAL_TASK_STATES.has(message.state) ? { finishedAt: nowIso() } : {})
          });
        }
        return;
      }
      if (message.type === 'checkpoint') {
        update(task, { checkpoint: { path: message.path, savedAt: message.savedAt } });
        return;
      }
      if (message.type === 'screenshot') {
        update(task, { lastScreenshot: { path: message.path, reason: message.reason, at: nowIso() } });
        return;
      }
      if (message.type === 'result') {
        update(task, { result: clone(message.result) });
        return;
      }
      if (message.type === 'error') {
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          update(task, {
            state: message.state === 'cancelled' ? 'cancelled' : 'failed',
            error: sanitizeError(message.error),
            finishedAt: nowIso()
          });
        }
        return;
      }
      if (message.type === 'cleanup') {
        task.cleanup.browserClosed = Boolean(message.browserClosed);
        update(task, { cleanup: task.cleanup });
      }
    });

    child.once('error', (error) => {
      if (!TERMINAL_TASK_STATES.has(task.state)) {
        update(task, { state: 'failed', error: sanitizeError(error, 'TASK_WORKER_SPAWN_FAILED') });
      }
      void finalizeTask(task, null, null);
    });
    child.once('exit', (code, signal) => void finalizeTask(task, code, signal));

    entry.watchdog = setInterval(() => {
      if (TERMINAL_TASK_STATES.has(task.state)) return;
      const heartbeatAge = Date.now() - Date.parse(task.heartbeatAt);
      if (heartbeatAge <= heartbeatTimeoutMs) return;
      if (!entry.diagnoseAt) {
        entry.diagnoseAt = Date.now();
        update(task, {
          progress: {
            ...task.progress,
            message: 'Worker heartbeat delayed; capturing diagnostics'
          }
        });
        send(child, {
          type: 'diagnose',
          reason: 'heartbeat-timeout',
          outputDir: task.outputDir
        });
        return;
      }
      if (Date.now() - entry.diagnoseAt >= diagnosticGraceMs) {
        update(task, {
          state: 'failed',
          error: { code: 'TASK_HEARTBEAT_TIMEOUT', message: 'Task worker stopped reporting heartbeats' },
          finishedAt: nowIso()
        });
        send(child, { type: 'cancel' });
        scheduleForcedStop(task, entry);
      }
    }, Math.min(5_000, Math.max(100, Math.floor(heartbeatTimeoutMs / 3))));
    entry.watchdog.unref?.();
  }

  async function create(body = {}) {
    await ready;
    if (typeof body.profileId !== 'string' || !body.profileId) {
      throw new TaskServiceError('PROFILE_REQUIRED', 'profileId is required');
    }
    if (typeof body.modulePath !== 'string' || !body.modulePath) {
      throw new TaskServiceError('TASK_MODULE_REQUIRED', 'modulePath is required');
    }
    const modulePath = path.resolve(body.modulePath);
    try {
      const moduleStats = await stat(modulePath);
      if (!moduleStats.isFile()) throw new Error();
    } catch {
      throw new TaskServiceError('TASK_MODULE_NOT_FOUND', 'Task module was not found', 404);
    }

    const profile = await profileStore.get(body.profileId);
    const behavior = body.behavior || profile.defaultBehavior || 'fast';
    if (!isBehaviorMode(behavior)) {
      throw new TaskServiceError('INVALID_BEHAVIOR_MODE', 'behavior must be fast, human, or adaptive');
    }
    if (body.timeoutMs !== undefined && (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1_000)) {
      throw new TaskServiceError('INVALID_TASK_TIMEOUT', 'timeoutMs must be an integer of at least 1000');
    }

    const id = taskId();
    const taskRoot = path.join(root, id);
    const outputDir = path.join(taskRoot, 'output');
    const checkpointPath = path.join(taskRoot, 'checkpoint.json');
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const task = {
      id,
      profileId: body.profileId,
      behavior,
      state: 'queued',
      progress: { current: 0, total: null, message: 'Queued' },
      heartbeatAt: nowIso(),
      outputDir,
      checkpoint: null,
      result: null,
      error: null,
      cleanup: { browserClosed: false, leaseReleased: false, workerExited: false, settled: false },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      leaseOwner: `task:${id}`,
      leaseHeld: false
    };
    tasks.set(id, task);
    await persist(task);
    update(task, { state: 'acquiring_profile' });

    try {
      await profileStore.acquireLease(task.profileId, task.leaseOwner, {
        pid: process.pid,
        ttlMs: LEASE_TTL_MS
      });
      task.leaseHeld = true;
    } catch (error) {
      update(task, { state: 'failed', error: sanitizeError(error, 'PROFILE_LEASE_FAILED'), finishedAt: nowIso() });
      await releaseTaskLease(task);
      task.cleanup.browserClosed = true;
      task.cleanup.workerExited = true;
      task.cleanup.settled = true;
      update(task, { cleanup: task.cleanup });
      return publicRecord(task);
    }

    let child;
    try {
      child = workerFactory(TASK_WORKER, 'task');
      attachTaskWorker(task, child);
      update(task, { state: 'starting_browser', startedAt: nowIso(), workerPid: child.pid });
      await profileStore.acquireLease(task.profileId, task.leaseOwner, {
        pid: child.pid,
        ttlMs: LEASE_TTL_MS
      });
      send(child, {
        type: 'start',
        config: {
          taskId: id,
          profile,
          modulePath,
          input: body.input ?? {},
          behavior,
          outputDir,
          checkpointPath,
          heartbeatMs: 20_000,
          ...(body.timeoutMs ? { timeoutMs: body.timeoutMs } : {})
        }
      });
    } catch (error) {
      update(task, { state: 'failed', error: sanitizeError(error, 'TASK_WORKER_SPAWN_FAILED'), finishedAt: nowIso() });
      child?.kill?.('SIGTERM');
      await releaseTaskLease(task);
      if (!child) {
        task.cleanup.browserClosed = true;
        task.cleanup.workerExited = true;
        task.cleanup.settled = true;
        update(task, { cleanup: task.cleanup });
      }
    }
    return publicRecord(task);
  }

  async function list() {
    await ready;
    return [...tasks.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicRecord);
  }

  async function get(id) {
    await ready;
    const task = tasks.get(id);
    if (!task) throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    return publicRecord(task);
  }

  async function cancel(id) {
    await ready;
    const task = tasks.get(id);
    if (!task) throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    if (TERMINAL_TASK_STATES.has(task.state)) return publicRecord(task);
    update(task, {
      state: 'cancelled',
      progress: { ...task.progress, message: 'Cancellation requested' },
      finishedAt: nowIso()
    });
    const entry = children.get(id);
    if (entry) {
      send(entry.child, { type: 'cancel' });
      scheduleForcedStop(task, entry);
    } else {
      await releaseTaskLease(task);
      task.cleanup.browserClosed = true;
      task.cleanup.workerExited = true;
      task.cleanup.settled = true;
      update(task, { cleanup: task.cleanup });
    }
    return publicRecord(task);
  }

  async function importSession(profileId, bundle) {
    await ready;
    const profile = await profileStore.get(profileId);
    if (profile.state !== 'idle' || profile.lease) {
      throw new TaskServiceError('PROFILE_IN_USE', 'Target profile must be idle before session import', 409);
    }
    const ownerId = `session-import:${randomUUID().replaceAll('-', '')}`;
    await profileStore.acquireLease(profileId, ownerId, { pid: process.pid, ttlMs: 120_000 });
    let child;
    try {
      child = workerFactory(IMPORT_WORKER, 'session-import');
      await profileStore.acquireLease(profileId, ownerId, { pid: child.pid, ttlMs: 120_000 });
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new TaskServiceError('SESSION_IMPORT_TIMEOUT', 'Session import timed out', 504));
        }, 90_000);
        const done = (callback) => (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback(value);
        };
        child.once('error', done(reject));
        child.once('exit', done(() => reject(
          new TaskServiceError('SESSION_IMPORT_EXITED', 'Session import worker exited before returning a result', 500)
        )));
        child.on('message', (message) => {
          if (message?.type === 'result') done(resolve)(message.result);
          if (message?.type === 'error') done(reject)(Object.assign(new Error(message.error?.message), message.error));
        });
        send(child, { type: 'import', config: { profile, bundle } });
      });
      return {
        status: result.status === 'verified' ? 'verified' : 'partial',
        cookieCount: Number(result.cookieCount) || 0,
        localStorageCount: Number(result.localStorageCount) || 0,
        sessionCookieRetentionHours: Number(result.sessionCookieRetentionHours) || 0,
        verification: typeof result.verification === 'string'
          ? result.verification
          : 'storage_imported_not_login_verified',
        message: result.status === 'verified'
          ? 'Session was imported and verified'
          : 'Session material was imported; account login still requires site-level verification'
      };
    } finally {
      child?.kill?.('SIGTERM');
      await profileStore.releaseLease(profileId, ownerId).catch(() => {});
      bundle = null;
    }
  }

  async function openProfile(profileId) {
    await ready;
    const existing = openProfiles.get(profileId);
    if (existing) return { status: 'open', profileId, pid: existing.child.pid };
    const ownerId = `profile-open:${profileId}`;
    const profile = await profileStore.get(profileId);
    await profileStore.acquireLease(profileId, ownerId, { pid: process.pid, ttlMs: 5 * 60_000 });
    const child = workerFactory(PROFILE_WORKER, 'profile-open');
    const entry = { child, ownerId, released: false, renewal: null, lastHeartbeatAt: Date.now() };
    openProfiles.set(profileId, entry);

    const release = async () => {
      if (entry.released) return;
      entry.released = true;
      clearInterval(entry.renewal);
      openProfiles.delete(profileId);
      await profileStore.releaseLease(profileId, ownerId).catch(() => {});
    };
    child.once('exit', () => void release());
    child.once('error', () => void release());
    child.on('message', (message) => {
      if (message?.type === 'heartbeat') entry.lastHeartbeatAt = Date.now();
    });

    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new TaskServiceError('PROFILE_OPEN_TIMEOUT', 'Profile did not open in time', 504)), 30_000);
        child.on('message', (message) => {
          if (message?.type === 'ready') {
            clearTimeout(timer);
            resolve(message);
          }
          if (message?.type === 'error') {
            clearTimeout(timer);
            reject(Object.assign(new Error(message.error?.message), message.error));
          }
        });
        send(child, { type: 'open', profile });
      });
      void result;
      await profileStore.acquireLease(profileId, ownerId, { pid: child.pid, ttlMs: 5 * 60_000 });
      entry.renewal = setInterval(() => {
        if (Date.now() - entry.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
          send(child, { type: 'close' });
          child.kill?.('SIGTERM');
          return;
        }
        void profileStore.acquireLease(profileId, ownerId, { pid: child.pid, ttlMs: 5 * 60_000 })
          .catch(() => send(child, { type: 'close' }));
      }, 20_000);
      entry.renewal.unref?.();
      return { status: 'open', profileId, pid: child.pid };
    } catch (error) {
      send(child, { type: 'close' });
      child.kill?.('SIGTERM');
      await release();
      throw error;
    }
  }

  async function closeProfile(profileId) {
    const entry = openProfiles.get(profileId);
    if (!entry) return { status: 'closed', profileId };
    send(entry.child, { type: 'close' });
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.child.kill('SIGTERM');
        resolve();
      }, 10_000);
      entry.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!entry.released) {
      entry.released = true;
      clearInterval(entry.renewal);
      openProfiles.delete(profileId);
      await profileStore.releaseLease(profileId, entry.ownerId).catch(() => {});
    }
    return { status: 'closed', profileId };
  }

  async function close() {
    await ready;
    const exitingWorkers = [...children.values()].map((entry) => entry.exitPromise);
    await Promise.allSettled([
      ...[...tasks.values()]
        .filter((task) => !TERMINAL_TASK_STATES.has(task.state))
        .map((task) => cancel(task.id)),
      ...[...openProfiles.keys()].map(closeProfile)
    ]);
    if (exitingWorkers.length > 0) {
      await Promise.race([
        Promise.allSettled(exitingWorkers),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, diagnosticGraceMs + 5_000);
          timer.unref?.();
        })
      ]);
    }
    while (true) {
      const pending = [...persistChains.entries()];
      await Promise.allSettled(pending.map(([, promise]) => promise));
      if (pending.every(([id, promise]) => persistChains.get(id) === promise)) break;
    }
  }

  return Object.freeze({ list, create, get, cancel, importSession, openProfile, closeProfile, close });
}
