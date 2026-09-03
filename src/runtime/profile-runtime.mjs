import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROFILE_OPEN_TIMEOUT_MS } from '../contracts.mjs';
import { isProcessAlive, terminateProcessTree } from '../lib/process-tree.mjs';
import { TaskServiceError } from './task-service-error.mjs';

const DEFAULT_WORKER = fileURLToPath(new URL('./profile-worker.mjs', import.meta.url));

function defaultWorkerFactory(workerPath) {
  return fork(workerPath, [], {
    detached: process.platform !== 'win32',
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true
  });
}

function wait(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
  ]).finally(() => clearTimeout(timer));
}

function send(child, message) {
  return new Promise((resolve) => {
    if (!child?.connected) return resolve(false);
    try {
      child.send(message, undefined, undefined, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

export function createProfileRuntime({
  profileStore,
  workerFactory = defaultWorkerFactory,
  workerPath = DEFAULT_WORKER,
  terminateTree = terminateProcessTree,
  processAlive = isProcessAlive,
  leaseTtlMs = 45_000,
  heartbeatTimeoutMs = 35_000,
  openTimeoutMs = PROFILE_OPEN_TIMEOUT_MS,
  closeTimeoutMs = 12_000,
  onProfileAvailable = () => {}
} = {}) {
  if (!profileStore || typeof workerFactory !== 'function') {
    throw new TypeError('profileStore and workerFactory are required');
  }
  const entries = new Map();

  const leaseIdentity = (entry) => ({
    ownerId: entry.ownerId,
    nonce: entry.nonce,
    generation: entry.generation
  });

  function confirmCleanup(profileId, entry) {
    if (!entry.generation) return Promise.resolve(false);
    entry.cleanupTail = entry.cleanupTail.then(() => (
      profileStore.confirmLeaseCleanup(profileId, leaseIdentity(entry))
    ));
    return entry.cleanupTail;
  }

  async function markCleanupError(profileId, entry) {
    if (!entry.generation) return false;
    await entry.cleanupTail.catch(() => {});
    return profileStore.markLeaseError(profileId, leaseIdentity(entry)).catch(() => false);
  }

  async function terminateOwnedTree(profileId, entry) {
    if (entry.terminationPromise) return entry.terminationPromise;
    const attempt = (async () => {
      const terminated = await terminateTree(entry.child.pid, { graceMs: 3_000 }).catch(() => false);
      entry.treeTerminated = terminated === true && !processAlive(entry.child.pid);
      if (entry.treeTerminated) await confirmCleanup(profileId, entry).catch(() => {});
      return entry.treeTerminated;
    })();
    entry.terminationPromise = attempt;
    const result = await attempt;
    if (!result && entry.terminationPromise === attempt) entry.terminationPromise = null;
    return result;
  }

  async function finalize(profileId, entry) {
    if (entry.finalizePromise) return entry.finalizePromise;
    entry.finalizePromise = (async () => {
      clearInterval(entry.watchdog);
      await entry.terminationPromise?.catch(() => {});
      await wait(entry.closedPromise, 500);
      await entry.renewTail.catch(() => {});
      await entry.cleanupTail.catch(() => {});
      if (processAlive(entry.child.pid)) return false;

      const cleanupConfirmed = entry.browserClosed === true || entry.treeTerminated === true;
      let released = !entry.generation;
      if (entry.generation && cleanupConfirmed) {
        await confirmCleanup(profileId, entry);
        released = await profileStore.releaseLease(profileId, leaseIdentity(entry)).catch(() => false);
      } else if (entry.generation) {
        await markCleanupError(profileId, entry);
      }

      if (entries.get(profileId) === entry) entries.delete(profileId);
      if (released) await Promise.resolve(onProfileAvailable(profileId)).catch(() => {});
      return cleanupConfirmed && released;
    })();
    const result = await entry.finalizePromise;
    if (result === false && processAlive(entry.child.pid)) entry.finalizePromise = null;
    return result;
  }

  async function stopEntry(profileId, entry) {
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopPromise = (async () => {
      entry.stopping = true;
      await send(entry.child, { type: 'close' });
      const closedOrExited = await wait(
        Promise.race([entry.closedPromise, entry.exitPromise]),
        closeTimeoutMs
      );
      if (entry.browserClosed === true && processAlive(entry.child.pid)) {
        await wait(entry.exitPromise, 1_000);
      }
      if (
        closedOrExited !== true || entry.browserClosed !== true ||
        processAlive(entry.child.pid)
      ) {
        const terminated = await terminateOwnedTree(profileId, entry);
        if (terminated) await wait(entry.exitPromise, 3_000);
      }

      if (processAlive(entry.child.pid)) {
        await markCleanupError(profileId, entry);
        throw new TaskServiceError(
          'PROFILE_PROCESS_STILL_ALIVE',
          'Profile browser could not be closed; its lease was retained to prevent concurrent use',
          409
        );
      }
      const finalized = await finalize(profileId, entry);
      if (!finalized) {
        throw new TaskServiceError(
          'PROFILE_CLEANUP_UNCONFIRMED',
          'Profile process exited without confirmed browser cleanup; its lease was retained',
          409
        );
      }
      return { status: 'closed', profileId };
    })();
    try {
      return await entry.stopPromise;
    } finally {
      if (entries.get(profileId) === entry) entry.stopPromise = null;
    }
  }

  async function openProfile(identifier) {
    await profileStore.recoverExpiredLeases();
    let profile = await profileStore.get(identifier);
    const existing = entries.get(profile.id);
    if (existing && processAlive(existing.child.pid)) {
      if (existing.stopping || profile.state === 'error') {
        throw new TaskServiceError(
          'PROFILE_PROCESS_STILL_ALIVE',
          'Profile cleanup is incomplete; close it successfully before reopening',
          409
        );
      }
      return { status: 'open', profileId: profile.id, pid: existing.child.pid };
    }
    if (existing) await finalize(profile.id, existing);
    profile = await profileStore.get(profile.id);
    if (profile.lease) {
      throw new TaskServiceError(
        profile.state === 'error' ? 'PROFILE_CLEANUP_UNCONFIRMED' : 'PROFILE_LEASED',
        profile.state === 'error'
          ? 'Profile cleanup is not confirmed'
          : 'Profile is already in use',
        409
      );
    }

    const child = workerFactory(workerPath, 'profile');
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new TaskServiceError('PROFILE_WORKER_START_FAILED', 'Profile worker could not start', 500);
    }
    const ownerId = `profile-open:${profile.id}`;
    const nonce = randomUUID();
    let resolveExit;
    let resolveReady;
    let rejectReady;
    let resolveClosed;
    const entry = {
      child,
      ownerId,
      nonce,
      generation: null,
      lastHeartbeatAt: Date.now(),
      renewTail: Promise.resolve(),
      cleanupTail: Promise.resolve(),
      terminationPromise: null,
      treeTerminated: false,
      browserClosed: null,
      stopping: false,
      finalizePromise: null,
      stopPromise: null,
      exitPromise: new Promise((resolve) => { resolveExit = resolve; }),
      closedPromise: new Promise((resolve) => { resolveClosed = resolve; }),
      readyPromise: new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; })
    };
    // A worker can fail while acquireLease is still pending; observe now, await below.
    entry.readyPromise.catch(() => {});
    entries.set(profile.id, entry);

    child.once('exit', () => {
      resolveExit(true);
      if (!entry.stopping) rejectReady(new TaskServiceError('PROFILE_WORKER_EXITED', 'Profile worker exited', 500));
      void finalize(profile.id, entry);
    });
    child.once('error', () => {
      rejectReady(new TaskServiceError('PROFILE_WORKER_START_FAILED', 'Profile worker could not start', 500));
    });
    child.on('message', async (message) => {
      if (message?.type === 'ready') resolveReady(true);
      if (message?.type === 'error') {
        rejectReady(new TaskServiceError(
          message.error?.code || 'PROFILE_OPEN_FAILED',
          message.error?.message || 'Profile failed to open',
          500,
          message.error?.details
        ));
      }
      if (message?.type === 'closed') {
        entry.browserClosed = message.browserClosed === true;
        if (entry.browserClosed) await confirmCleanup(profile.id, entry).catch(() => false);
        if (typeof message.cleanupId === 'string') {
          await send(entry.child, { type: 'closed_ack', cleanupId: message.cleanupId });
        }
        resolveClosed(true);
      }
      if (message?.type === 'heartbeat') {
        entry.lastHeartbeatAt = Date.now();
        entry.renewTail = entry.renewTail.then(async () => {
          if (entry.stopping || !entry.generation) return;
          const renewed = await profileStore.renewLease(profile.id, {
            ownerId,
            nonce,
            generation: entry.generation,
            ttlMs: leaseTtlMs
          });
          if (!renewed) throw new Error('Profile lease was lost');
        }).catch(() => {
          if (!entry.stopping) void stopEntry(profile.id, entry);
        });
      }
    });

    try {
      const leased = await profileStore.acquireLease(profile.id, {
        ownerId,
        kind: 'manual',
        pid: child.pid,
        nonce,
        ttlMs: leaseTtlMs
      });
      entry.generation = leased.lease.generation;
      if (!(await send(child, { type: 'open', profile: leased }))) {
        throw new TaskServiceError('PROFILE_WORKER_START_FAILED', 'Profile worker did not accept startup', 500);
      }
      entry.watchdog = setInterval(() => {
        if (!entry.stopping && Date.now() - entry.lastHeartbeatAt > heartbeatTimeoutMs) {
          void stopEntry(profile.id, entry);
        }
      }, Math.min(5_000, Math.max(1_000, Math.floor(heartbeatTimeoutMs / 3))));
      entry.watchdog.unref?.();
      const opened = await wait(entry.readyPromise, openTimeoutMs);
      if (opened !== true) throw new TaskServiceError('PROFILE_OPEN_TIMEOUT', 'Profile did not open in time', 504);
      return { status: 'open', profileId: profile.id, pid: child.pid };
    } catch (error) {
      try {
        await stopEntry(profile.id, entry);
      } catch (cleanupError) {
        throw cleanupError;
      }
      throw error;
    }
  }

  async function closeProfile(identifier) {
    await profileStore.recoverExpiredLeases();
    const profile = await profileStore.get(identifier);
    const entry = entries.get(profile.id);
    if (entry) return stopEntry(profile.id, entry);
    if (profile.lease?.kind === 'manual') {
      await profileStore.markLeaseError(profile.id, profile.lease).catch(() => {});
      throw new TaskServiceError(
        'PROFILE_CLEANUP_UNCONFIRMED',
        'This Profile belongs to an earlier Manager session; no process identity can be safely confirmed',
        409
      );
    }
    if (profile.lease) {
      throw new TaskServiceError('PROFILE_LEASED', 'Profile is owned by a running task', 409);
    }
    return { status: 'closed', profileId: profile.id };
  }

  async function closeAll() {
    const results = await Promise.allSettled(
      [...entries.entries()].map(([profileId, entry]) => stopEntry(profileId, entry))
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  function owns(profileId) {
    return entries.has(profileId);
  }

  return Object.freeze({ openProfile, closeProfile, closeAll, owns });
}
