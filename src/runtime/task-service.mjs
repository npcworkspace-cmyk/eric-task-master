import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTerminalTask, publicProfile, publicTask } from '../contracts.mjs';
import { JsonStore } from '../lib/json-store.mjs';
import { isProcessAlive, probeChromeProfileUsage, terminateProcessTree } from '../lib/process-tree.mjs';
import { cleanManagedPath } from '../lib/space-cleanup.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';
import { ProfileStoreError } from '../lib/profile-store.mjs';
import { createProfileRuntime } from './profile-runtime.mjs';
import { TaskServiceError } from './task-service-error.mjs';

export { TaskServiceError } from './task-service-error.mjs';

const TASK_WORKER = fileURLToPath(new URL('./task-worker.mjs', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TASK_ID = /^task_[a-f0-9]{32}$/u;
const MAX_EVENTS = 1_000;
const MAX_MODULE_BYTES = 16 * 1024 * 1024;
const LEASE_TTL_MS = 45_000;
const HEARTBEAT_TIMEOUT_MS = 35_000;

function nowIso(now) {
  return new Date(now()).toISOString();
}

function clone(value) {
  return structuredClone(value);
}

function defaultWorkerFactory(workerPath) {
  return fork(workerPath, [], {
    detached: process.platform !== 'win32',
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  });
}

function waitFor(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function send(child, message) {
  return new Promise((resolve) => {
    if (!child?.connected) return resolve(false);
    const timer = setTimeout(() => resolve(false), 1_000);
    timer.unref?.();
    const finish = (accepted) => { clearTimeout(timer); resolve(accepted); };
    try {
      child.send(message, undefined, undefined, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

function normalizeLabel(value, modulePath) {
  const fallback = path.basename(modulePath, path.extname(modulePath));
  const label = String(value ?? fallback).trim();
  if (!label || label.length > 160 || /[\u0000-\u001f\u007f]/u.test(label)) {
    throw new TaskServiceError('INVALID_TASK_LABEL', 'Task label must contain 1-160 visible characters');
  }
  return label;
}

function normalizeError(error, fallbackCode = 'TASK_FAILED') {
  const normalized = {
    code: String(error?.code || fallbackCode).replace(/[^A-Z0-9_]/giu, '_').slice(0, 100),
    message: redactSensitiveText(error?.message || 'Task failed').slice(0, 4_000),
    ...(error?.details === undefined ? {} : {
      details: boundedErrorValue(error.details)
    }),
    ...(error?.nextAction === undefined ? {} : {
      nextAction: redactSensitiveText(String(error.nextAction)).slice(0, 2_000)
    }),
    ...(error?.cause ? {
      cause: {
        code: String(error.cause.code || 'ERROR').replace(/[^A-Z0-9_]/giu, '_').slice(0, 100),
        message: redactSensitiveText(error.cause.message || 'Underlying operation failed').slice(0, 2_000)
      }
    } : {})
  };
  return normalized;
}

function boundedErrorValue(value) {
  const redacted = redactSensitiveValue(value, { maxDepth: 8, maxItems: 200 });
  try {
    if (Buffer.byteLength(JSON.stringify(redacted)) <= 64 * 1024) return redacted;
  } catch {
    // Fall through to a bounded diagnostic below.
  }
  return { warning: 'Error details exceeded 64 KiB and were omitted.' };
}

function jsonClone(value, field = 'value') {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    throw new TaskServiceError('INVALID_JSON_VALUE', `${field} must be JSON serializable`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function taskRootPath(root, taskId) {
  if (!TASK_ID.test(taskId)) throw new TaskServiceError('TASK_NOT_FOUND', 'Task was not found', 404);
  const candidate = path.resolve(root, taskId);
  const relative = path.relative(path.resolve(root), candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TaskServiceError('TASK_PATH_INVALID', 'Task path is invalid', 500);
  }
  return candidate;
}

function publicEvent(event) {
  return {
    sequence: event.sequence,
    type: event.type,
    at: event.at,
    ...(event.data === undefined ? {} : { data: redactSensitiveValue(event.data) })
  };
}

export function createTaskService({
  stateDir,
  profileStore,
  workerFactory = defaultWorkerFactory,
  profileWorkerFactory = defaultWorkerFactory,
  terminateTree = terminateProcessTree,
  processAlive = isProcessAlive,
  profileUsageProbe = probeChromeProfileUsage,
  now = Date.now,
  maxConcurrentTasks = 8,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  leaseTtlMs = LEASE_TTL_MS,
  reaperIntervalMs = 5_000,
  stopWaitMs = 12_000,
  terminationWaitMs = 3_000,
  resumeWaitMs = 5_000,
  progressFlushMs = 1_000,
  verificationNotifier = null
} = {}) {
  if (!stateDir || !profileStore) throw new TypeError('stateDir and profileStore are required');
  if (!Number.isInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 64) {
    throw new TypeError('maxConcurrentTasks must be an integer from 1 to 64');
  }
  if (!Number.isInteger(reaperIntervalMs) || reaperIntervalMs < 10) {
    throw new TypeError('reaperIntervalMs must be an integer of at least 10');
  }
  if (!Number.isInteger(stopWaitMs) || stopWaitMs < 10 || !Number.isInteger(terminationWaitMs) || terminationWaitMs < 10) {
    throw new TypeError('stopWaitMs and terminationWaitMs must be integers of at least 10');
  }

  const root = path.resolve(stateDir);
  const store = new JsonStore(path.join(root, 'tasks.json'), { version: 1, tasks: [], tombstones: [] });
  const tasks = new Map();
  const children = new Map();
  const tombstones = new Map();
  const tombstoneCleanup = new Map();
  const deletingProfiles = new Set();
  const profileOperations = new Set();
  const cleaningTasks = new Set();
  const pendingProgress = new Set();
  let progressTimer = null;
  let cleanupPromise = null;
  let mutationTail = Promise.resolve();
  let closing = false;
  let closePromise = null;
  let reaper = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

  const serialize = (operation) => {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.catch(() => {});
    return result;
  };

  const persist = () => store.replace({
    version: 1,
    // Input exists only in this live Manager long enough to start the Worker.
    // A restarted Manager cannot resume an in-process module, so persisting
    // API keys or passwords provides no recovery value and creates exposure.
    tasks: [...tasks.values()].map((task) => ({ ...task, input: null })),
    tombstones: [...tombstones.values()]
  });

  function flushProgress(task) {
    if (pendingProgress.delete(task.id)) appendEvent(task, 'progress', task.progress);
  }

  function scheduleProgressFlush() {
    if (progressTimer || closing) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      void serialize(async () => {
        if (!pendingProgress.size) return;
        for (const id of pendingProgress) {
          const task = tasks.get(id);
          if (task) flushProgress(task);
          else pendingProgress.delete(id);
        }
        await persist();
      }).catch(() => {});
    }, progressFlushMs);
    progressTimer.unref?.();
  }

  function observeNotification(task) {
    try { verificationNotifier?.observeTask(task); } catch { /* Notifications never gate task state. */ }
  }

  const appendEvent = (task, type, data) => {
    if (type !== 'progress') flushProgress(task);
    task.eventSequence = (task.eventSequence || 0) + 1;
    const event = {
      sequence: task.eventSequence,
      type,
      at: nowIso(now),
      ...(data === undefined ? {} : { data: redactSensitiveValue(data) })
    };
    task.events ||= [];
    task.events.push(event);
    if (task.events.length > MAX_EVENTS) task.events.splice(0, task.events.length - MAX_EVENTS);
    task.updatedAt = event.at;
    return event;
  };

  const findTask = (id) => {
    const task = tasks.get(id);
    if (!task) throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    return task;
  };

  const profileRuntime = createProfileRuntime({
    profileStore,
    workerFactory: profileWorkerFactory,
    terminateTree,
    processAlive,
    leaseTtlMs,
    heartbeatTimeoutMs,
    onProfileAvailable: () => schedule()
  });

  async function initialize() {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await store.init();
      const data = await store.read();
      for (const record of Array.isArray(data.tombstones) ? data.tombstones : []) {
        if (!record || !TASK_ID.test(record.id || '') || typeof record.profileId !== 'string') continue;
        tombstones.set(record.id, {
          id: record.id,
          profileId: record.profileId,
          deletedAt: record.deletedAt || nowIso(now)
        });
      }
      for (const record of Array.isArray(data.tasks) ? data.tasks : []) {
        if (!record || !TASK_ID.test(record.id || '')) continue;
        if (tombstones.has(record.id)) continue;
        record.outputDir = path.join(taskRootPath(root, record.id), 'output');
        record.events = Array.isArray(record.events) ? record.events.slice(-MAX_EVENTS) : [];
        record.eventSequence = Number.isSafeInteger(record.eventSequence)
          ? record.eventSequence
          : record.events.at(-1)?.sequence ?? 0;
        if (!isTerminalTask(record)) {
          // A persisted numeric PID is not an owned process handle. It may
          // have been reused after a crash, so a new Manager must never kill
          // it. The Profile lease stays quarantined unless prior cleanup proof
          // exists in ProfileStore.
          record.state = 'error';
          record.error = {
            code: 'MANAGER_RESTARTED',
            message: 'Manager restarted while this task was running; partial output was preserved.'
          };
          record.finishedAt = nowIso(now);
          record.waiting = null;
          appendEvent(record, 'task.error', record.error);
          const profile = await profileStore.get(record.profileId).catch(() => null);
          if (profile?.lease?.taskId === record.id) {
            await profileStore.markLeaseError(profile.id, profile.lease).catch(() => {});
          }
        }
        await disposeStagedModule(record);
        delete record.workerPid;
        delete record.lease;
        tasks.set(record.id, record);
      }
      await profileStore.recoverExpiredLeases();
      await persist();
      for (const id of tombstones.keys()) void cleanupTombstone(id);
      reaper = setInterval(() => {
      for (const [taskId, entry] of children) {
          if (!entry.finalized && !processAlive(entry.child.pid)) {
            void finalizeTask(taskId, entry, entry.child.exitCode, entry.child.signalCode).catch(() => {});
          } else if (!entry.finalized && entry.stopRequested) {
            void containTaskWorker(taskId, entry, {
              code: 'TASK_TERMINATION_RETRY',
              message: 'Retrying termination of the owned task process tree.'
            }).catch(() => {});
          }
        }
        void profileStore.recoverExpiredLeases().then((recovered) => {
          if (recovered.length) void schedule();
          for (const id of tombstones.keys()) void cleanupTombstone(id);
        }).catch(() => {});
      }, reaperIntervalMs);
      reaper.unref?.();
      readyResolve();
      void schedule();
    } catch (error) {
      readyReject(error);
    }
  }
  void initialize();

  async function stageModule(sourcePath, taskRoot, sourceBytes = null) {
    const resolved = path.resolve(sourcePath);
    const stats = sourceBytes === null ? await lstat(resolved).catch(() => null) : null;
    if (sourceBytes === null && (!stats?.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > MAX_MODULE_BYTES)) {
      throw new TaskServiceError(
        'TASK_MODULE_INVALID',
        `Task module must be one regular .mjs file no larger than ${MAX_MODULE_BYTES} bytes`
      );
    }
    if (path.extname(resolved).toLowerCase() !== '.mjs') {
      throw new TaskServiceError('TASK_MODULE_INVALID', 'Task module must use the .mjs extension');
    }
    const destination = path.join(taskRoot, 'task.mjs');
    if (sourceBytes === null) await copyFile(resolved, destination);
    else await writeFile(destination, sourceBytes, { mode: 0o600, flag: 'wx' });
    const bytes = sourceBytes ?? await readFile(destination);
    const moduleSha256 = createHash('sha256').update(bytes).digest('hex');

    // Make the bundled Playwright package resolvable for a copied one-file
    // task. Scripts do not need this link when they use runtime.playwright.
    const bundledModules = path.join(PROJECT_ROOT, 'node_modules');
    const taskModules = path.join(taskRoot, 'node_modules');
    if (!existsSync(path.join(bundledModules, 'playwright'))) {
      throw new TaskServiceError(
        'PLAYWRIGHT_RUNTIME_UNAVAILABLE',
        'The bundled Playwright runtime is not installed',
        500
      );
    }
    try {
      await symlink(
        bundledModules,
        taskModules,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch (error) {
      throw new TaskServiceError(
        'TASK_MODULE_STAGE_FAILED',
        `Could not expose Playwright to the disposable task: ${error.message}`,
        500
      );
    }
    return {
      sourcePath: resolved,
      modulePath: destination,
      moduleName: path.basename(resolved),
      moduleSha256
    };
  }

  async function removeModuleLink(modulePath) {
    if (!modulePath) return;
    const taskModules = path.join(path.dirname(modulePath), 'node_modules');
    const stats = await lstat(taskModules).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!stats) return;
    if (!stats.isSymbolicLink()) {
      throw new TaskServiceError(
        'TASK_MODULE_LINK_INVALID',
        'Disposable task node_modules is not a managed link',
        500
      );
    }
    await unlink(taskModules);
  }

  async function disposeStagedModule(task) {
    if (!task) return;
    if (task.modulePath) {
      const expected = path.join(taskRootPath(root, task.id), 'task.mjs');
      const modulePath = path.resolve(task.modulePath);
      if (modulePath === expected) {
        await rm(modulePath, { force: true }).catch(() => {});
        await removeModuleLink(modulePath).catch(() => {});
      }
    }
    task.modulePath = null;
    task.input = null;
  }

  async function cleanupTombstone(id) {
    if (!tombstones.has(id) || children.has(id)) return false;
    if (tombstoneCleanup.has(id)) return tombstoneCleanup.get(id);
    const attempt = (async () => {
      const record = tombstones.get(id);
      if (!record || children.has(id)) return false;
      const profile = await profileStore.get(record.profileId).catch(() => null);
      if (profile?.lease?.taskId === id) return false;

      const taskRoot = taskRootPath(root, id);
      const modulePath = path.join(taskRoot, 'task.mjs');
      await removeModuleLink(modulePath);
      await rm(modulePath, { force: true });
      await rm(taskRoot, { recursive: true, force: true });
      return serialize(async () => {
        if (children.has(id)) return false;
        const current = tombstones.get(id);
        if (!current) return true;
        const currentProfile = await profileStore.get(current.profileId).catch(() => null);
        if (currentProfile?.lease?.taskId === id) return false;
        tombstones.delete(id);
        await persist();
        return true;
      });
    })();
    tombstoneCleanup.set(id, attempt);
    try {
      return await attempt;
    } finally {
      if (tombstoneCleanup.get(id) === attempt) tombstoneCleanup.delete(id);
    }
  }

  function activeProfileIds() {
    return new Set([...children.values()].map((entry) => entry.profileId));
  }

  const leaseIdentity = (entry) => ({
    ownerId: entry.ownerId,
    nonce: entry.nonce,
      generation: entry.generation
  });

  function confirmEntryCleanup(entry) {
    if (!entry.generation) return Promise.resolve(false);
    if (entry.cleanupConfirmed) return Promise.resolve(true);
    entry.cleanupTail = entry.cleanupTail.catch(() => {}).then(async () => {
      if (entry.cleanupConfirmed) return true;
      entry.cleanupConfirmed = await profileStore.confirmLeaseCleanup(entry.profileId, leaseIdentity(entry));
      return entry.cleanupConfirmed;
    });
    return entry.cleanupTail;
  }

  async function markEntryCleanupError(entry) {
    if (!entry.generation) return false;
    await entry.cleanupTail.catch(() => {});
    return profileStore.markLeaseError(entry.profileId, leaseIdentity(entry)).catch(() => false);
  }

  async function terminateOwnedTask(entry) {
    if (entry.terminationPromise) return entry.terminationPromise;
    const attempt = Promise.resolve().then(async () => {
      const terminated = await terminateTree(entry.child.pid, { graceMs: 3_000 }).catch(() => false);
      const usage = terminated === true && !processAlive(entry.child.pid)
        ? await profileUsageProbe(entry.userDataDir).catch(() => 'unknown')
        : 'unknown';
      entry.treeTerminated = terminated === true && !processAlive(entry.child.pid) && usage === 'inactive';
      if (entry.treeTerminated) await confirmEntryCleanup(entry).catch(() => {});
      return entry.treeTerminated;
    });
    entry.terminationPromise = attempt;
    const result = await attempt;
    if (!result && entry.terminationPromise === attempt) entry.terminationPromise = null;
    return result;
  }

  async function schedule() {
    if (closing) return;
    await ready;
    return serialize(async () => {
      if (closing) return;
      await profileStore.recoverExpiredLeases();
      const occupied = activeProfileIds();
      for (const task of tasks.values()) {
        if (children.size >= maxConcurrentTasks) break;
        if (
          task.state !== 'queued' || occupied.has(task.profileId) ||
          deletingProfiles.has(task.profileId) || profileOperations.has(task.profileId)
        ) continue;
        const profile = await profileStore.get(task.profileId).catch(() => null);
        if (!profile) {
          task.state = 'error';
          task.error = {
            code: 'PROFILE_NOT_FOUND',
            message: 'The task Profile no longer exists; the disposable module was removed.'
          };
          task.finishedAt = nowIso(now);
          appendEvent(task, 'task.error', task.error);
          await disposeStagedModule(task);
          await persist();
          continue;
        }
        if (profile.state === 'error') {
          // An unconfirmed dead Worker remains fenced until its lease TTL.
          // ProfileStore's reaper will release it automatically after expiry;
          // keep already-queued work waiting instead of destroying it early.
          if (profile.lease) continue;
          task.state = 'error';
          task.error = {
            code: 'PROFILE_CLEANUP_UNCONFIRMED',
            message: 'Profile cleanup is not confirmed; task was not started.'
          };
          task.finishedAt = nowIso(now);
          appendEvent(task, 'task.error', task.error);
          await disposeStagedModule(task);
          await persist();
          continue;
        }
        if (profile.lease || profile.state !== 'idle') continue;
        occupied.add(task.profileId);
        await launchTask(task, profile).catch(async (error) => {
          task.state = 'error';
          task.error = normalizeError(error, 'TASK_START_FAILED');
          task.finishedAt = nowIso(now);
          appendEvent(task, 'task.error', task.error);
          await disposeStagedModule(task);
          await persist();
        });
      }
    });
  }

  async function launchTask(task, profile) {
    const child = workerFactory(TASK_WORKER, 'task');
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new TaskServiceError('TASK_WORKER_START_FAILED', 'Task worker could not start', 500);
    }
    const ownerId = `task:${task.id}`;
    const nonce = randomUUID();
    let resolveExit;
    let resolveCleanup;
    const entry = {
      child,
      userDataDir: profile.userDataDir,
      pendingResumes: new Map(),
      profileId: profile.id,
      ownerId,
      nonce,
      generation: null,
      lastHeartbeatAt: Date.now(),
      stopRequested: false,
      terminalState: null,
      browserClosed: null,
      treeTerminated: false,
      cleanupTail: Promise.resolve(),
      terminationPromise: null,
      containmentPromise: null,
      finalized: false,
      finalizePromise: null,
      renewTail: Promise.resolve(),
      exitPromise: new Promise((resolve) => { resolveExit = resolve; }),
      cleanupPromise: new Promise((resolve) => { resolveCleanup = resolve; }),
      resolveCleanup
    };
    children.set(task.id, entry);

    // Task code is unrestricted and may accidentally print cookies or tokens.
    // Drain process output to prevent pipe backpressure, but never persist its
    // body. Diagnostics must use structured progress/emit/error or artifacts.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on('message', (message) => void handleWorkerMessage(task.id, entry, message).catch(() => {
      void containTaskWorker(task.id, entry, {
        code: 'TASK_STATE_UPDATE_FAILED', message: 'Task state could not be recorded; stopping this worker.'
      }).catch(() => {});
    }));
    child.once('error', (error) => {
      void recordWorkerEvent(task.id, 'worker.error', normalizeError(error, 'TASK_WORKER_ERROR')).catch(() => {});
    });
    child.once('exit', (code, signal) => {
      resolveExit(true);
      for (const pending of entry.pendingResumes.values()) {
        pending.resolveAck({ accepted: false, reason: 'TASK_WORKER_EXITED' });
        if (entry.observedResumeWaitId !== pending.waitId) pending.resolveResumed(false);
      }
      void finalizeTask(task.id, entry, code, signal).catch(() => {});
    });

    try {
      const leased = await profileStore.acquireLease(profile.id, {
        ownerId,
        kind: 'task',
        taskId: task.id,
        pid: child.pid,
        nonce,
        ttlMs: leaseTtlMs
      });
      entry.generation = leased.lease.generation;
      task.state = 'running';
      task.startedAt ||= nowIso(now);
      task.heartbeatAt = nowIso(now);
      task.workerPid = child.pid;
      task.error = null;
      appendEvent(task, 'task.started', { pid: child.pid });
      await persist();
      const accepted = await send(child, {
        type: 'start',
        config: {
          taskId: task.id,
          profile: leased,
          modulePath: task.modulePath,
          input: clone(task.input),
          outputDir: task.outputDir,
          outputBudget: task.outputBudget,
          timeoutMs: task.timeoutMs
        }
      });
      if (!accepted) throw new TaskServiceError('TASK_WORKER_START_FAILED', 'Task worker did not accept startup', 500);
      task.input = null;
      entry.watchdog = setInterval(() => {
        if (!entry.finalized && Date.now() - entry.lastHeartbeatAt > heartbeatTimeoutMs) {
          void failUnresponsiveTask(task.id, entry).catch(() => {});
        }
      }, Math.min(5_000, Math.max(1_000, Math.floor(heartbeatTimeoutMs / 3))));
      entry.watchdog.unref?.();
    } catch (error) {
      entry.stopRequested = true;
      entry.terminalState = 'error';
      await send(child, { type: 'stop' });
      const terminated = await terminateOwnedTask(entry);
      if (!terminated) await markEntryCleanupError(entry);
      throw error;
    }
  }

  async function recordWorkerEvent(taskId, type, data) {
    await serialize(async () => {
      const task = tasks.get(taskId);
      if (!task) return;
      appendEvent(task, type, data);
      await persist();
    });
  }

  async function handleWorkerMessage(taskId, entry, message) {
    if (message?.type === 'resume_ack') {
      if (children.get(taskId) === entry) entry.pendingResumes.get(message.requestId)?.resolveAck(message);
      return;
    }
    if (message?.type === 'resumed' && children.get(taskId) === entry && !entry.stopRequested &&
        tasks.get(taskId)?.waiting?.id === message.waitId) entry.observedResumeWaitId = message.waitId;
    let cleanupFailed = message?.type === 'cleanup' && message.browserClosed !== true;
    if (message?.type === 'cleanup' && children.get(taskId) === entry && !entry.finalized) {
      entry.browserClosed = message.browserClosed === true;
      entry.cleanupFailed = cleanupFailed;
      entry.resolveCleanup(true);
      if (entry.browserClosed) await confirmEntryCleanup(entry).catch(() => false);
      if (typeof message.cleanupId === 'string') {
        await send(entry.child, { type: 'cleanup_ack', cleanupId: message.cleanupId });
      }
    }
    await serialize(async () => {
      const task = tasks.get(taskId);
      if (!task || children.get(taskId) !== entry || entry.finalized) return;
      const timestamp = nowIso(now);
      if (message?.type === 'heartbeat') {
        entry.lastHeartbeatAt = Date.now();
        task.heartbeatAt = timestamp;
        entry.renewTail = entry.renewTail.then(async () => {
          if (entry.finalized || !entry.generation) return;
          const renewed = await profileStore.renewLease(entry.profileId, {
            ownerId: entry.ownerId,
            nonce: entry.nonce,
            generation: entry.generation,
            ttlMs: leaseTtlMs
          });
          if (!renewed) throw new Error('Profile lease was lost');
        }).catch(() => { void failUnresponsiveTask(taskId, entry).catch(() => {}); });
        // Liveness is cheap in-memory state; lease renewal persists separately.
        return;
      } else if (message?.type === 'progress') {
        task.progress = {
          current: Number.isFinite(message.progress?.current) ? Math.max(0, message.progress.current) : 0,
          total: Number.isFinite(message.progress?.total) ? Math.max(0, message.progress.total) : null,
          message: redactSensitiveText(String(message.progress?.message ?? '')).slice(0, 1_000),
          ...(typeof message.progress?.phase === 'string'
            ? { phase: redactSensitiveText(message.progress.phase).slice(0, 64) }
            : {})
        };
        pendingProgress.add(task.id);
        scheduleProgressFlush();
        return;
      } else if (message?.type === 'waiting') {
        if (entry.stopRequested) return;
        task.state = 'waiting';
        task.waiting = redactSensitiveValue(jsonClone(message.waiting, 'waiting'));
        appendEvent(task, 'task.waiting', task.waiting);
      } else if (message?.type === 'resumed') {
        if (entry.stopRequested || task.state !== 'waiting' || task.waiting?.id !== message.waitId) return;
        task.state = 'running';
        task.waiting = null;
        appendEvent(task, 'task.resumed', { waitId: message.waitId ?? null });
      } else if (message?.type === 'event') {
        const probe = message.event;
        if (probe?.type === 'verification.probe' && task.state === 'waiting' &&
            task.waiting?.id === probe.waitId && !task.waiting.automaticPaused) {
          Object.assign(task.waiting, redactSensitiveValue({
            probeId: probe.probeId,
            probe: probe.probe,
            maximumProbes: probe.maximumProbes,
            screenshot: probe.screenshot ?? null,
            screenshotPath: probe.screenshotPath ?? null,
            needsAgentDecision: probe.needsAgentDecision !== false,
            automaticProbesComplete: probe.automaticProbesComplete === true,
            nextProbeAt: probe.nextProbeAt ?? null
          }));
        }
        if (probe?.type === 'verification.paused' && task.state === 'waiting' &&
            task.waiting?.id === probe.waitId) {
          Object.assign(task.waiting, {
            automaticPaused: true, pausedAt: probe.pausedAt ?? timestamp,
            needsAgentDecision: false, automaticProbesComplete: true, nextProbeAt: null
          });
        }
        appendEvent(task, 'task.event', message.event);
      } else if (message?.type === 'result') {
        task.result = redactSensitiveValue(message.result);
        appendEvent(task, 'task.result', task.result);
      } else if (message?.type === 'error') {
        entry.terminalState = message.state === 'stopped' ? 'stopped' : 'error';
        task.error = normalizeError(message.error, entry.terminalState === 'stopped' ? 'TASK_STOPPED' : 'TASK_FAILED');
        if (message.error?.screenshot) task.failureScreenshot = message.error.screenshot;
        appendEvent(task, `task.${entry.terminalState}`, task.error);
      } else if (message?.type === 'state') {
        if (['finished', 'stopped', 'error'].includes(message.state)) entry.terminalState = message.state;
      } else if (message?.type === 'cleanup') {
        cleanupFailed = entry.cleanupFailed;
      }
      task.updatedAt = timestamp;
      observeNotification(task);
      await persist();
      if (message?.type === 'resumed') {
        for (const pending of entry.pendingResumes.values()) {
          if (pending.waitId === message.waitId) pending.resolveResumed(true);
        }
      }
    });
    if (cleanupFailed) {
      await containTaskWorker(taskId, entry, {
        code: 'TASK_BROWSER_CLOSE_FAILED',
        message: 'Browser cleanup failed; Manager is terminating the owned process tree.',
        details: message.details
      });
    }
  }

  async function containTaskWorker(taskId, entry, {
    code = 'TASK_TERMINATION_REQUIRED',
    message = 'Manager is terminating the owned task process tree.',
    details
  } = {}) {
    if (entry.finalized) return true;
    if (entry.containmentPromise) return entry.containmentPromise;
    const attempt = (async () => {
      entry.stopRequested = true;
      entry.terminalState = 'error';
      await serialize(async () => {
        const task = tasks.get(taskId);
        if (!task) return;
        task.state = 'stopping';
        task.error = normalizeError({ code, message, ...(details ? { details } : {}) });
        observeNotification(task);
        appendEvent(task, 'task.stopping', task.error);
        await persist();
      });

      await send(entry.child, { type: 'stop' });
      if (!(await waitFor(entry.exitPromise, 1_000)) && processAlive(entry.child.pid)) {
        const terminated = await terminateOwnedTask(entry);
        if (terminated) await waitFor(entry.exitPromise, 3_000);
      }

      if (processAlive(entry.child.pid)) {
        await markEntryCleanupError(entry);
        await serialize(async () => {
          const task = tasks.get(taskId);
          if (!task) return;
          task.state = 'stopping';
          task.error = {
            code: 'TASK_PROCESS_STILL_ALIVE',
            message: 'Task process tree could not be terminated; Profile lease was retained.'
          };
          appendEvent(task, 'task.cleanup_failed', task.error);
          await persist();
        });
        return false;
      }

      if (!entry.finalized) {
        await finalizeTask(taskId, entry, entry.child.exitCode, entry.child.signalCode);
      }
      return entry.finalized === true && (entry.browserClosed === true || entry.treeTerminated === true);
    })();
    entry.containmentPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (!entry.finalized && entry.containmentPromise === attempt) entry.containmentPromise = null;
    }
  }

  async function failUnresponsiveTask(taskId, entry) {
    if (entry.finalized) return;
    await containTaskWorker(taskId, entry, {
      code: 'TASK_HEARTBEAT_TIMEOUT',
      message: 'Task worker stopped responding; Manager is terminating it.'
    });
  }

  async function finalizeTask(taskId, entry, exitCode, exitSignal) {
    if (entry.finalizePromise) return entry.finalizePromise;
    const attempt = serialize(async () => {
      if (entry.finalized) return true;
      clearInterval(entry.watchdog);
      await entry.terminationPromise?.catch(() => {});
      await waitFor(entry.cleanupPromise, 500);
      await entry.renewTail.catch(() => {});
      await entry.cleanupTail.catch(() => {});
      if (processAlive(entry.child.pid)) return false;

      const cleanupConfirmed = entry.browserClosed === true || entry.treeTerminated === true;
      let released = !entry.generation;
      if (entry.generation && cleanupConfirmed) {
        await confirmEntryCleanup(entry);
        released = await profileStore.releaseLease(
          entry.profileId,
          leaseIdentity(entry)
        ).catch(() => false);
      } else if (entry.generation) {
        await markEntryCleanupError(entry);
      }

      entry.finalized = true;
      const task = tasks.get(taskId);
      if (!task) {
        children.delete(taskId);
        setImmediate(() => void cleanupTombstone(taskId));
        return true;
      }
      children.delete(taskId);
      delete task.workerPid;
      task.waiting = null;
      verificationNotifier?.remove(taskId);
      task.finishedAt ||= nowIso(now);
      if (!cleanupConfirmed || !released) {
        task.state = 'error';
        task.error = {
          code: 'TASK_CLEANUP_UNCONFIRMED',
          message: 'Task process exited without confirmed browser cleanup; Profile lease was retained.'
        };
        appendEvent(task, 'task.error', task.error);
      } else if (entry.terminalState === 'finished') {
        task.state = 'finished';
        task.error = null;
        appendEvent(task, 'task.finished', { outputAvailable: true });
      } else if (entry.terminalState === 'error') {
        task.state = 'error';
        task.error ||= {
          code: 'TASK_WORKER_EXITED',
          message: `Task worker exited unexpectedly (${exitSignal || (exitCode ?? 'unknown')}).`
        };
        appendEvent(task, 'task.error', task.error);
      } else if (entry.stopRequested || entry.terminalState === 'stopped') {
        task.state = 'stopped';
        task.error ||= { code: 'TASK_STOPPED', message: 'Task stopped' };
        appendEvent(task, 'task.stopped', { outputAvailable: true });
      } else {
        task.state = 'error';
        task.error ||= {
          code: 'TASK_WORKER_EXITED',
          message: `Task worker exited unexpectedly (${exitSignal || (exitCode ?? 'unknown')}).`
        };
        appendEvent(task, 'task.error', task.error);
      }
      // The disposable code snapshot is never an asset. Results and output
      // files remain readable until the task itself is deleted.
      await disposeStagedModule(task);
      await persist();
      void schedule();
      return true;
    });
    entry.finalizePromise = attempt;
    try {
      return await attempt;
    } finally {
      if (!entry.finalized && entry.finalizePromise === attempt) entry.finalizePromise = null;
    }
  }

  async function create(body = {}) {
    await ready;
    if (closing) throw new TaskServiceError('MANAGER_STOPPING', 'Manager is stopping', 503);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TaskServiceError('INVALID_TASK', 'Task request must be an object');
    }
    const allowed = new Set(['modulePath', 'profileId', 'label', 'input', 'timeoutMs', 'outputBudget', 'requestKey']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) throw new TaskServiceError('INVALID_TASK', `Unsupported fields: ${unknown.join(', ')}`);
    if (typeof body.modulePath !== 'string' || !body.modulePath) {
      throw new TaskServiceError('TASK_MODULE_REQUIRED', 'modulePath is required');
    }
    if (body.requestKey !== undefined && (typeof body.requestKey !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(body.requestKey))) {
      throw new TaskServiceError('INVALID_REQUEST_KEY', 'requestKey must contain 1-160 letters, digits, dots, underscores, colons or hyphens');
    }
    if (body.timeoutMs !== undefined && body.timeoutMs !== null && (
      !Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1_000 || body.timeoutMs > 30 * 24 * 60 * 60_000
    )) {
      throw new TaskServiceError('INVALID_TASK_TIMEOUT', 'timeoutMs must be 1000-2592000000 or null');
    }

    return serialize(async () => {
      if (closing) throw new TaskServiceError('MANAGER_STOPPING', 'Manager is stopping', 503);
      let requestKeyHash;
      let requestFingerprint;
      let sourceBytes = null;
      if (body.requestKey !== undefined) {
        const sourcePath = path.resolve(body.modulePath);
        const sourceStats = await lstat(sourcePath).catch(() => null);
        if (!sourceStats?.isFile() || sourceStats.isSymbolicLink() || sourceStats.size < 1 || sourceStats.size > MAX_MODULE_BYTES) {
          throw new TaskServiceError('TASK_MODULE_INVALID', 'Request source must be a regular task module within the size limit');
        }
        sourceBytes = await readFile(sourcePath);
        if (sourceBytes.length < 1 || sourceBytes.length > MAX_MODULE_BYTES) {
          throw new TaskServiceError('INVALID_MODULE', 'Task module must be a non-empty file within the module size limit', 400);
        }
        const moduleSha256 = createHash('sha256').update(sourceBytes).digest('hex');
        requestKeyHash = createHash('sha256').update(body.requestKey).digest('hex');
        requestFingerprint = createHash('sha256').update(canonicalJson(jsonClone({
          moduleSha256, profileId: body.profileId ?? null, input: body.input ?? {},
          label: normalizeLabel(body.label, body.modulePath), timeoutMs: body.timeoutMs ?? null,
          outputBudget: body.outputBudget ?? {}
        }))).digest('hex');
        const previous = [...tasks.values()].find((task) => task.requestKeyHash === requestKeyHash);
        if (previous) {
          if (previous.requestFingerprint !== requestFingerprint) {
            throw new TaskServiceError('TASK_REQUEST_CONFLICT', 'requestKey already belongs to a different task request', 409);
          }
          return publicTask(previous);
        }
      }
      await profileStore.recoverExpiredLeases();
      const profile = body.profileId
        ? await profileStore.get(body.profileId)
        : await profileStore.getDefault();
      if (!profile) {
        throw new TaskServiceError(
          'DEFAULT_PROFILE_REQUIRED',
          'Create a Chrome Profile and set it as default before running a task',
          409
        );
      }
      if (deletingProfiles.has(profile.id)) {
        throw new TaskServiceError('PROFILE_DELETING', 'Profile is being deleted', 409);
      }
      if (profile.state === 'deleting') {
        throw new TaskServiceError('PROFILE_DELETING', 'Profile is being deleted', 409);
      }
      if (profile.state === 'error') {
        throw new TaskServiceError(
          'PROFILE_CLEANUP_UNCONFIRMED',
          'Profile cleanup is not confirmed; it cannot accept a new task',
          409
        );
      }
      const id = `task_${randomUUID().replaceAll('-', '')}`;
      const taskRoot = taskRootPath(root, id);
      const outputDir = path.join(taskRoot, 'output');
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      let staged;
      try {
        staged = await stageModule(body.modulePath, taskRoot, sourceBytes);
      } catch (error) {
        await rm(taskRoot, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      const timestamp = nowIso(now);
      const task = {
        id,
        label: normalizeLabel(body.label, body.modulePath),
        profileId: profile.id,
        profileName: profile.name,
        moduleName: staged.moduleName,
        modulePath: staged.modulePath,
        moduleSha256: staged.moduleSha256,
        ...(requestKeyHash ? { requestKeyHash, requestFingerprint } : {}),
        input: jsonClone(body.input ?? {}, 'input'),
        timeoutMs: body.timeoutMs ?? null,
        outputBudget: body.outputBudget === undefined ? {} : jsonClone(body.outputBudget, 'outputBudget'),
        outputDir,
        state: 'queued',
        progress: { current: 0, total: null, message: 'Queued' },
        waiting: null,
        result: null,
        error: null,
        eventSequence: 0,
        events: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        finishedAt: null,
        heartbeatAt: null
      };
      appendEvent(task, 'task.created', { moduleName: task.moduleName, profileId: profile.id });
      tasks.set(id, task);
      await persist();
      void schedule();
      return publicTask(task);
    });
  }

  async function list() {
    await ready;
    await mutationTail;
    return [...tasks.values()]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map(publicTask);
  }

  async function get(id) {
    await ready;
    await mutationTail;
    return publicTask(findTask(id));
  }

  async function events(id, { after = 0, limit = 200 } = {}) {
    await ready;
    await mutationTail;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TaskServiceError('INVALID_EVENT_CURSOR', 'after and limit are invalid');
    }
    const task = findTask(id);
    const first = task.events[0]?.sequence ?? task.eventSequence + 1;
    const selected = task.events.filter((event) => event.sequence > after).slice(0, limit);
    return {
      task: publicTask(task),
      events: selected.map(publicEvent),
      truncated: after < first - 1,
      nextAfter: selected.at(-1)?.sequence ?? after
    };
  }

  async function resume(id, value = null, { probeId, waitId } = {}) {
    await ready;
    for (const reference of [probeId, waitId]) {
      if (reference !== undefined && (typeof reference !== 'string' || !reference.trim() || reference.length > 160)) {
        throw new TaskServiceError('INVALID_TASK_RESUME', 'Resume waitId and probeId must be non-empty strings');
      }
    }
    const target = await serialize(async () => {
      const task = findTask(id);
      if (task.state !== 'waiting') {
        throw new TaskServiceError(
          'TASK_NOT_WAITING',
          `Task cannot resume from state ${task.state}`,
          409
        );
      }
      if (waitId !== undefined && waitId !== task.waiting?.id) {
        throw new TaskServiceError('TASK_WAIT_MISMATCH', 'The task is no longer in that wait', 409);
      }
      if (probeId !== undefined && probeId !== task.waiting?.probeId) {
        throw new TaskServiceError('TASK_PROBE_MISMATCH', 'The verification probe is no longer current', 409);
      }
      if (probeId !== undefined && task.waiting?.automaticPaused) {
        throw new TaskServiceError('TASK_VERIFICATION_PAUSED', 'Verification waiting reached 20 minutes; resume manually without --probe', 409);
      }
      const current = children.get(id);
      if (!current) throw new TaskServiceError('TASK_NOT_RUNNING', 'Waiting task has no live worker', 409);
      if (current.pendingResumes.size) throw new TaskServiceError('TASK_RESUME_PENDING', 'A resume request is already awaiting the Worker response', 409);
      appendEvent(task, 'task.resume_requested', {
        waitId: task.waiting?.id,
        ...(probeId === undefined ? {} : { probeId })
      });
      await persist();
      const requestId = randomUUID();
      let resolveAck;
      let resolveResumed;
      const ack = new Promise((resolve) => { resolveAck = resolve; });
      const resumed = new Promise((resolve) => { resolveResumed = resolve; });
      current.pendingResumes.set(requestId, { waitId: task.waiting?.id, resolveAck, resolveResumed });
      return { entry: current, waitId: task.waiting?.id, requestId, ack, resumed };
    });
    const deadline = Date.now() + resumeWaitMs;
    try {
      const delivered = await waitFor(send(target.entry.child, {
        type: 'resume', requestId: target.requestId, waitId: target.waitId,
        ...(probeId === undefined ? {} : { probeId }), value: jsonClone(value, 'resume value')
      }), Math.max(1, deadline - Date.now()));
      if (!delivered) throw new TaskServiceError('TASK_RESUME_FAILED', 'Worker did not receive the resume request', 409);
      const ack = await waitFor(target.ack, Math.max(1, deadline - Date.now()));
      if (!ack) throw new TaskServiceError('TASK_RESUME_UNCONFIRMED', 'Worker did not confirm the resume request; inspect current task state before retrying', 409);
      if (ack.accepted !== true) {
        throw new TaskServiceError(ack.reason || 'TASK_RESUME_REJECTED', 'Worker rejected the resume request; task state was preserved', 409);
      }
      if (!(await waitFor(target.resumed, Math.max(1, deadline - Date.now())))) {
        throw new TaskServiceError('TASK_RESUME_UNCONFIRMED', 'Worker accepted resume but has not confirmed running; inspect current task state', 409);
      }
      return get(id);
    } finally {
      target.entry.pendingResumes.delete(target.requestId);
    }
  }

  async function stop(id) {
    await ready;
    const marked = await serialize(async () => {
      const task = findTask(id);
      if (isTerminalTask(task) && !children.has(id)) return { task, entry: null };
      if (task.state === 'queued') {
        task.state = 'stopped';
        task.error = { code: 'TASK_STOPPED', message: 'Task stopped before it started' };
        task.finishedAt = nowIso(now);
        await disposeStagedModule(task);
        appendEvent(task, 'task.stopped', { outputAvailable: true });
        await persist();
        return { task, entry: null };
      }
      const entry = children.get(id);
      if (!entry) {
        task.state = 'error';
        task.error = { code: 'TASK_WORKER_MISSING', message: 'Task worker is missing; partial output was preserved.' };
        task.finishedAt = nowIso(now);
        appendEvent(task, 'task.error', task.error);
        const profile = await profileStore.get(task.profileId).catch(() => null);
        if (profile?.lease?.taskId === task.id) {
          await profileStore.markLeaseError(profile.id, profile.lease).catch(() => {});
        }
        await persist();
        return { task, entry: null };
      }
      entry.stopRequested = true;
      task.state = 'stopping';
      verificationNotifier?.remove(task.id);
      appendEvent(task, 'task.stopping');
      await persist();
      return { task, entry };
    });
    if (!marked.entry) return publicTask(marked.task);
    await send(marked.entry.child, { type: 'stop' });
    await waitFor(marked.entry.exitPromise, stopWaitMs);
    if (processAlive(marked.entry.child.pid)) {
      await terminateOwnedTask(marked.entry);
      await waitFor(marked.entry.exitPromise, terminationWaitMs);
    }
    if (processAlive(marked.entry.child.pid)) {
      await markEntryCleanupError(marked.entry);
      throw new TaskServiceError(
        'TASK_PROCESS_STILL_ALIVE',
        'Task process tree could not be terminated; Profile lease was retained',
        409
      );
    }
    if (!marked.entry.finalized && !processAlive(marked.entry.child.pid)) {
      await finalizeTask(id, marked.entry, marked.entry.child.exitCode, marked.entry.child.signalCode);
    }
    if (!marked.entry.finalized) {
      throw new TaskServiceError(
        'TASK_CLEANUP_UNCONFIRMED',
        'Task cleanup could not be confirmed; Profile lease was retained',
        409
      );
    }
    return get(id);
  }

  async function deleteTask(id) {
    await ready;
    const retired = await serialize(async () => {
      if (cleaningTasks.has(id)) {
        throw new TaskServiceError('TASK_CLEANUP_ACTIVE', 'Task files are being cleaned; retry after cleanup', 409);
      }
      const task = tasks.get(id);
      if (!task) return { entry: children.get(id) ?? null };
      const entry = children.get(id) ?? null;
      if (entry) entry.stopRequested = true;
      tasks.delete(id);
      pendingProgress.delete(id);
      verificationNotifier?.remove(id);
      tombstones.set(id, {
        id,
        profileId: task.profileId,
        deletedAt: nowIso(now)
      });
      await persist();
      return { entry };
    });

    // Public deletion is unconditional. Cleanup remains conservative: an
    // unconfirmed Worker/Chrome keeps the Profile fenced and the private
    // tombstone is retried by the reaper until process death is proven.
    if (retired.entry && !retired.entry.finalized) {
      await send(retired.entry.child, { type: 'stop' });
      await waitFor(retired.entry.exitPromise, stopWaitMs);
      if (processAlive(retired.entry.child.pid)) {
        await terminateOwnedTask(retired.entry);
        await waitFor(retired.entry.exitPromise, terminationWaitMs);
      }
      if (processAlive(retired.entry.child.pid)) {
        await markEntryCleanupError(retired.entry);
      } else if (!retired.entry.finalized) {
        await finalizeTask(id, retired.entry, retired.entry.child.exitCode, retired.entry.child.signalCode);
      }
    }
    await cleanupTombstone(id).catch(() => false);
    return { deleted: true, id };
  }

  async function listArtifacts(id, { offset = 0, limit = 10_000 } = {}) {
    await ready;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TaskServiceError('INVALID_ARTIFACT_OFFSET', 'Artifact offset must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new TaskServiceError('INVALID_ARTIFACT_LIMIT', 'Artifact limit must be an integer from 1 to 10000');
    }
    const task = findTask(id);
    const outputRoot = path.resolve(task.outputDir);
    const files = [];
    const pending = [outputRoot];
    let seen = 0;
    while (pending.length && files.length <= limit) {
      const directory = pending.pop();
      const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error?.code === 'ENOENT') return [];
        throw error;
      });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      const directories = [];
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          directories.push(candidate);
        } else if (entry.isFile() && !entry.isSymbolicLink()) {
          if (seen >= offset && files.length <= limit) {
            const stats = await lstat(candidate);
            files.push({
              path: path.relative(outputRoot, candidate).split(path.sep).join('/'),
              size: stats.size,
              updatedAt: stats.mtime.toISOString()
            });
          }
          seen += 1;
          if (files.length > limit) break;
        }
      }
      for (let index = directories.length - 1; index >= 0; index -= 1) {
        pending.push(directories[index]);
      }
    }
    const truncated = files.length > limit;
    if (truncated) files.pop();
    return {
      artifacts: files,
      offset,
      count: files.length,
      truncated,
      nextOffset: truncated ? offset + files.length : null
    };
  }

  async function readArtifact(id, relativePath, { offset = 0, maxBytes = 256 * 1024 } = {}) {
    await ready;
    const task = findTask(id);
    if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) {
      throw new TaskServiceError('INVALID_ARTIFACT_PATH', 'Artifact path is invalid');
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
      throw new TaskServiceError('INVALID_ARTIFACT_RANGE', 'Artifact range is invalid');
    }
    const rootPath = path.resolve(task.outputDir);
    const candidate = path.resolve(rootPath, relativePath);
    const relative = path.relative(rootPath, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new TaskServiceError('INVALID_ARTIFACT_PATH', 'Artifact path escapes the task output directory');
    }
    const stats = await lstat(candidate).catch(() => null);
    if (!stats?.isFile() || stats.isSymbolicLink()) {
      throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
    }
    const length = Math.max(0, Math.min(maxBytes, stats.size - offset));
    const buffer = Buffer.alloc(length);
    const handle = await open(candidate, 'r');
    try {
      if (length) await handle.read(buffer, 0, length, offset);
    } finally {
      await handle.close();
    }
    return {
      path: relative.split(path.sep).join('/'),
      offset,
      size: stats.size,
      nextOffset: offset + length,
      eof: offset + length >= stats.size,
      encoding: 'base64',
      data: buffer.toString('base64')
    };
  }

  async function listProfiles() {
    await ready;
    const snapshot = await profileStore.snapshot();
    return snapshot.profiles.map((profile) => publicProfile(profile, snapshot.defaultProfileId));
  }

  async function createProfile(body) {
    await ready;
    if (closing) throw new TaskServiceError('MANAGER_STOPPING', 'Manager is stopping', 503);
    return serialize(async () => {
      if (closing) throw new TaskServiceError('MANAGER_STOPPING', 'Manager is stopping', 503);
      const profile = await profileStore.create(body);
      const snapshot = await profileStore.snapshot();
      return publicProfile(profile, snapshot.defaultProfileId);
    });
  }

  async function updateProfile(identifier, patch) {
    await ready;
    return serialize(async () => {
      const current = await profileStore.get(identifier);
      if (deletingProfiles.has(current.id)) {
        throw new TaskServiceError('PROFILE_DELETING', 'Profile is being deleted', 409);
      }
      const profile = await profileStore.update(current.id, patch);
      const snapshot = await profileStore.snapshot();
      return publicProfile(profile, snapshot.defaultProfileId);
    });
  }

  async function openProfile(identifier) {
    await ready;
    if (closing) throw new TaskServiceError('MANAGER_STOPPING', 'Manager is stopping', 503);
    const profile = await serialize(async () => {
      if (closing) throw new TaskServiceError('MANAGER_STOPPING', 'Manager is stopping', 503);
      const current = await profileStore.get(identifier);
      if (deletingProfiles.has(current.id)) {
        throw new TaskServiceError('PROFILE_DELETING', 'Profile is being deleted', 409);
      }
      if (profileOperations.has(current.id)) {
        throw new TaskServiceError('PROFILE_OPERATION_ACTIVE', 'Another Profile operation is active', 409);
      }
      profileOperations.add(current.id);
      return current;
    });
    try {
      return await profileRuntime.openProfile(profile.id);
    } finally {
      await serialize(async () => { profileOperations.delete(profile.id); });
      void schedule();
    }
  }

  async function closeProfile(identifier) {
    await ready;
    const profile = await serialize(async () => {
      const current = await profileStore.get(identifier);
      if (deletingProfiles.has(current.id)) {
        throw new TaskServiceError('PROFILE_DELETING', 'Profile is being deleted', 409);
      }
      if (profileOperations.has(current.id)) {
        throw new TaskServiceError('PROFILE_OPERATION_ACTIVE', 'Another Profile operation is active', 409);
      }
      profileOperations.add(current.id);
      return current;
    });
    try {
      return await profileRuntime.closeProfile(profile.id);
    } finally {
      await serialize(async () => { profileOperations.delete(profile.id); });
      void schedule();
    }
  }

  async function deleteProfile(identifier) {
    await ready;
    const profile = await serialize(async () => {
      const current = await profileStore.get(identifier).catch((error) => {
        if (error?.code === 'PROFILE_NOT_FOUND') return null;
        throw error;
      });
      if (!current) return null;
      if (deletingProfiles.has(current.id)) {
        throw new TaskServiceError('PROFILE_DELETING', 'Profile is already being deleted', 409);
      }
      if (profileOperations.has(current.id)) {
        throw new TaskServiceError('PROFILE_OPERATION_ACTIVE', 'Another Profile operation is active', 409);
      }
      deletingProfiles.add(current.id);
      return current;
    });
    if (!profile) return { deleted: true, id: String(identifier) };
    try {
      const relatedTasks = [...tasks.values()].filter((task) => (
        task.profileId === profile.id && (!isTerminalTask(task) || children.has(task.id))
      ));
      for (const task of relatedTasks) await stop(task.id);
      let current = await profileStore.get(profile.id);
      if (current.lease?.kind === 'manual') {
        await profileRuntime.closeProfile(profile.id);
        current = await profileStore.get(profile.id);
      }
      if (current.lease) {
        throw new TaskServiceError(
          'PROFILE_CLEANUP_UNCONFIRMED',
          'Profile cleanup is not confirmed; its data and lease were retained',
          409
        );
      }
      const removed = await serialize(() => profileStore.remove(profile.id));
      return { deleted: true, profile: publicProfile(removed) };
    } finally {
      deletingProfiles.delete(profile.id);
    }
  }

  async function cleanup(options = {}) {
    await ready;
    const allowed = ['browser-cache', 'temporary-files', 'task-output'];
    if (!options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some((key) => !['categories', 'preview'].includes(key))) {
      throw new TaskServiceError('INVALID_CLEANUP_OPTIONS', 'Cleanup accepts only categories and preview');
    }
    const { categories = allowed.slice(0, 2), preview = true } = options;
    if (!Array.isArray(categories) || categories.length > 3 ||
        categories.some((id) => !allowed.includes(id)) || new Set(categories).size !== categories.length ||
        typeof preview !== 'boolean') {
      throw new TaskServiceError('INVALID_CLEANUP_OPTIONS', 'Select known cleanup categories and a boolean preview');
    }
    if (closing) throw new TaskServiceError('MANAGER_STOPPING', 'Manager is stopping', 503);
    if (cleanupPromise) throw new TaskServiceError('CLEANUP_BUSY', 'Another space cleanup is active; retry shortly', 409);

    const attempt = (async () => {
      const result = {
        preview, bytes: 0, files: 0, skipped: [], failed: [],
        categories: categories.map((id) => ({ id, bytes: 0, files: 0 }))
      };
      const clean = async (categoryId, subject, rootPath, relativePath, linkOnly = false) => {
        const parent = await lstat(path.dirname(rootPath)).catch(() => null);
        if (!parent?.isDirectory() || parent.isSymbolicLink()) {
          const issue = { path: relativePath, reason: 'MANAGED_DIRECTORY_UNSAFE' };
          result.failed.push({ ...subject, ...issue });
          return { bytes: 0, files: 0, skipped: [], failed: [issue] };
        }
        if (categoryId === 'temporary-files' && !linkOnly) {
          const staged = await lstat(path.join(rootPath, relativePath)).catch(() => null);
          if (staged && !staged.isFile() && !staged.isSymbolicLink()) {
            const issue = { path: relativePath, reason: 'STAGED_MODULE_NOT_FILE' };
            result.failed.push({ ...subject, ...issue });
            return { bytes: 0, files: 0, skipped: [], failed: [issue] };
          }
        }
        const value = await cleanManagedPath({ root: rootPath, relativePath, preview, linkOnly }).catch((error) => ({
          bytes: 0, files: 0, skipped: [],
          failed: [{ path: relativePath, reason: error.code || 'CLEANUP_IO_ERROR' }]
        }));
        const category = result.categories.find((item) => item.id === categoryId);
        category.bytes += value.bytes;
        category.files += value.files;
        result.bytes += value.bytes;
        result.files += value.files;
        for (const key of ['skipped', 'failed']) {
          result[key].push(...value[key].map((item) => ({ ...subject, ...item })));
        }
        return value;
      };
      if (categories.includes('browser-cache')) {
        for (const candidate of await profileStore.list()) {
          const subject = { kind: 'profile', id: candidate.id, name: candidate.name };
          const profile = await serialize(async () => {
            const current = await profileStore.get(candidate.id).catch(() => null);
            if (!current || current.state !== 'idle' || current.lease ||
                activeProfileIds().has(candidate.id) || deletingProfiles.has(candidate.id) ||
                profileOperations.has(candidate.id)) return null;
            profileOperations.add(candidate.id);
            return current;
          });
          if (!profile) {
            result.skipped.push({ ...subject, reason: 'PROFILE_BUSY' });
            continue;
          }
          try {
            const usage = await profileUsageProbe(profile.userDataDir).catch(() => 'unknown');
            if (usage !== 'inactive') {
              result.skipped.push({ ...subject, reason: usage === 'active' ? 'BROWSER_OPEN' : 'BROWSER_USAGE_UNKNOWN' });
              continue;
            }
            // Only disposable Chrome caches. Never sweep *Cache*, site storage,
            // extension data, cookies, preferences, or the userDataDir itself.
            for (const cache of ['Cache', 'Code Cache', 'GPUCache']) {
              await clean('browser-cache', subject, profile.userDataDir, `Default/${cache}`);
            }
          } finally {
            await serialize(() => { profileOperations.delete(profile.id); });
            void schedule();
          }
        }
      }
      if (categories.includes('temporary-files') || categories.includes('task-output')) {
        for (const candidate of [...tasks.values()]) {
          const subject = { kind: 'task', id: candidate.id, name: candidate.label };
          const task = await serialize(async () => {
            const current = tasks.get(candidate.id);
            const profile = current ? await profileStore.get(current.profileId).catch(() => null) : null;
            if (!current || !isTerminalTask(current) || children.has(current.id) ||
                profile?.lease?.taskId === current.id) return null;
            cleaningTasks.add(current.id);
            return current;
          });
          if (!task) {
            result.skipped.push({ ...subject, reason: 'TASK_ACTIVE_OR_CLEANUP_UNCONFIRMED' });
            continue;
          }
          try {
            const taskRoot = taskRootPath(root, task.id);
            if (categories.includes('temporary-files')) {
              await clean('temporary-files', subject, taskRoot, 'task.mjs');
              await clean('temporary-files', subject, taskRoot, 'node_modules', true);
            }
            if (categories.includes('task-output')) {
              const value = await clean('task-output', subject, taskRoot, 'output');
              if (!preview) await serialize(async () => {
                if (!value.failed.length && !value.skipped.length) task.outputClearedAt = nowIso(now);
                appendEvent(task, 'task.output_cleaned', {
                  bytes: value.bytes, files: value.files,
                  skipped: value.skipped.length, failed: value.failed.length
                });
                await persist();
              });
            }
          } finally {
            await serialize(() => { cleaningTasks.delete(task.id); });
          }
        }
      }
      return result;
    })();
    cleanupPromise = attempt;
    try {
      return await attempt;
    } finally {
      cleanupPromise = null;
    }
  }

  async function status() {
    await ready;
    const taskList = await list();
    return {
      state: closing ? 'stopping' : 'ready',
      tasks: {
        total: taskList.length,
        running: taskList.filter((task) => ['running', 'waiting', 'stopping'].includes(task.state)).length,
        queued: taskList.filter((task) => task.state === 'queued').length
      },
      profiles: (await listProfiles()).length
    };
  }

  async function prepareIdleStop() {
    await ready;
    await serialize(async () => {
      const profiles = await profileStore.list();
      if (children.size || profileOperations.size || cleanupPromise || deletingProfiles.size ||
          [...tasks.values()].some((task) => !isTerminalTask(task)) ||
          profiles.some((profile) => profile.lease || !['idle'].includes(profile.state))) {
        throw new TaskServiceError('MANAGER_BUSY', 'Manager has active tasks, Profiles or cleanup; maintenance was not started', 409);
      }
      closing = true;
    });
  }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    try {
      closePromise = (async () => {
        clearInterval(reaper);
        clearTimeout(progressTimer);
        verificationNotifier?.close();
        await ready.catch(() => {});
        await cleanupPromise?.catch(() => {});
        const activeIds = [...children.keys()];
        const taskResults = await Promise.allSettled(activeIds.map(async (id) => {
          if (!tombstones.has(id)) return stop(id);
          await deleteTask(id);
          const entry = children.get(id);
          if (entry && processAlive(entry.child.pid)) {
            throw new TaskServiceError(
              'TASK_PROCESS_STILL_ALIVE',
              'Deleted task process tree is still alive; Manager shutdown was stopped',
              409
            );
          }
          return true;
        }));
        let profileFailure = null;
        try {
          await profileRuntime.closeAll();
        } catch (error) {
          profileFailure = error;
        }
        await mutationTail;
        await serialize(async () => {
          for (const id of pendingProgress) {
            const task = tasks.get(id);
            if (task) flushProgress(task);
          }
          await persist();
        });
        await Promise.allSettled([...tombstones.keys()].map((id) => cleanupTombstone(id)));
        const taskFailure = taskResults.find((result) => result.status === 'rejected');
        if (taskFailure || profileFailure) {
          throw new TaskServiceError(
            'MANAGER_CLEANUP_FAILED',
            taskFailure?.reason?.message || profileFailure?.message || 'Manager cleanup failed',
            500
          );
        }
      })();
      return await closePromise;
    } catch (error) {
      closePromise = null;
      throw error;
    }
  }

  return Object.freeze({
    status,
    list,
    get,
    events,
    create,
    resume,
    stop,
    deleteTask,
    listArtifacts,
    readArtifact,
    listProfiles,
    createProfile,
    updateProfile,
    openProfile,
    closeProfile,
    deleteProfile,
    cleanup,
    prepareIdleStop,
    close
  });
}
