import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROFILE_OPEN_TIMEOUT_MS } from '../contracts.mjs';
import { isProcessAlive, probeChromeProfileUsage, terminateProcessTree } from '../lib/process-tree.mjs';
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
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish(false), 1_000);
    timer.unref?.();
    try {
      child.send(message, undefined, undefined, (error) => finish(!error));
    } catch {
      finish(false);
    }
  });
}

export function createProfileRuntime({
  profileStore,
  workerFactory = defaultWorkerFactory,
  workerPath = DEFAULT_WORKER,
  terminateTree = terminateProcessTree,
  processAlive = isProcessAlive,
  profileUsageProbe = probeChromeProfileUsage,
  leaseTtlMs = 45_000,
  heartbeatTimeoutMs = 35_000,
  openTimeoutMs = PROFILE_OPEN_TIMEOUT_MS,
  closeTimeoutMs = 12_000,
  cleanupRetryDelayMs = 5_000,
  maximumCleanupAttempts = 3,
  onProfileAvailable = () => {}
} = {}) {
  if (!profileStore || typeof workerFactory !== 'function') {
    throw new TypeError('profileStore and workerFactory are required');
  }
  if (!Number.isSafeInteger(maximumCleanupAttempts) || maximumCleanupAttempts < 1 ||
      !Number.isSafeInteger(cleanupRetryDelayMs) || cleanupRetryDelayMs < 1) {
    throw new TypeError('cleanup retry count and delay must be positive integers');
  }
  const entries = new Map();
  const pendingOpens = new Set();
  const pendingStateWrites = new Set();
  let abandoningState = false;
  let containmentPromise = null;

  function assertCurrentState() {
    if (abandoningState) {
      throw new TaskServiceError('MANAGER_STATE_CHANGED', 'Manager state recovery is in progress', 409);
    }
  }

  function writeState(method, ...args) {
    assertCurrentState();
    const operation = Promise.resolve().then(() => {
      assertCurrentState();
      return profileStore[method](...args);
    });
    pendingStateWrites.add(operation);
    return operation.finally(() => pendingStateWrites.delete(operation));
  }

  const leaseIdentity = (entry) => ({
    ownerId: entry.ownerId,
    nonce: entry.nonce,
    generation: entry.generation
  });

  function confirmCleanup(profileId, entry) {
    if (abandoningState) return Promise.resolve(false);
    if (!entry.generation) return Promise.resolve(false);
    if (entry.cleanupConfirmed) return Promise.resolve(true);
    entry.cleanupTail = entry.cleanupTail.catch(() => {}).then(async () => {
      if (abandoningState) return false;
      if (entry.cleanupConfirmed) return true;
      entry.cleanupConfirmed = await writeState('confirmLeaseCleanup', profileId, leaseIdentity(entry));
      return entry.cleanupConfirmed;
    });
    return entry.cleanupTail;
  }

  async function markCleanupError(profileId, entry) {
    if (abandoningState) return false;
    if (!entry.generation) return false;
    if (entry.cleanupErrorMarked) return true;
    await entry.cleanupTail.catch(() => {});
    if (abandoningState) return false;
    entry.cleanupErrorMarked = await writeState('markLeaseError', profileId, leaseIdentity(entry)).catch(() => false);
    return entry.cleanupErrorMarked;
  }

  async function terminateOwnedTree(profileId, entry) {
    if (entry.terminationPromise) return entry.terminationPromise;
    // Publish the cleanup barrier before termination can synchronously emit exit.
    const attempt = Promise.resolve().then(async () => {
      const terminated = await terminateTree(entry.child.pid, { graceMs: 3_000 }).catch(() => false);
      const usage = terminated === true && !processAlive(entry.child.pid)
        ? await profileUsageProbe(entry.userDataDir).catch(() => 'unknown')
        : 'unknown';
      entry.treeTerminated = terminated === true && !processAlive(entry.child.pid) && usage === 'inactive';
      return entry.treeTerminated;
    });
    entry.terminationPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (!entry.treeTerminated && entry.terminationPromise === attempt) entry.terminationPromise = null;
    }
  }

  async function finalize(profileId, entry) {
    if (abandoningState) return false;
    if (entry.finalizePromise) return entry.finalizePromise;
    const attempt = (async () => {
      clearInterval(entry.watchdog);
      await entry.terminationPromise?.catch(() => {});
      await wait(entry.closedPromise, 500);
      await entry.renewTail.catch(() => {});
      await entry.cleanupTail.catch(() => {});
      if (abandoningState) return false;
      if (processAlive(entry.child.pid)) return false;

      const cleanupConfirmed = entry.browserClosed === true || entry.treeTerminated === true;
      let released = !entry.generation;
      if (entry.generation && cleanupConfirmed) {
        if (await confirmCleanup(profileId, entry)) {
          if (abandoningState) return false;
          released = await writeState('releaseLease', profileId, leaseIdentity(entry)).catch(() => false);
        }
      }
      if (abandoningState) return false;
      if (!released && entry.generation) {
        await markCleanupError(profileId, entry);
      }

      if (released && entries.get(profileId) === entry) {
        clearTimeout(entry.cleanupRetryTimer);
        entries.delete(profileId);
      }
      if (released && !abandoningState) await Promise.resolve(onProfileAvailable(profileId)).catch(() => {});
      return cleanupConfirmed && released;
    })();
    entry.finalizePromise = attempt;
    try {
      return await attempt;
    } finally {
      if (entries.get(profileId) === entry && entry.finalizePromise === attempt) entry.finalizePromise = null;
    }
  }

  async function stopEntry(profileId, entry) {
    if (abandoningState) {
      if (await containEntry(profileId, entry)) return { status: 'closed', profileId };
      throw containmentError();
    }
    if (entry.stopPromise) return entry.stopPromise;
    entry.stopPromise = (async () => {
      entry.stopping = true;
      clearInterval(entry.watchdog);
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
    } catch (error) {
      entry.cleanupError = error;
      await markCleanupError(profileId, entry);
      throw error;
    } finally {
      if (entries.get(profileId) === entry) entry.stopPromise = null;
    }
  }

  function stopInBackground(profileId, entry) {
    if (abandoningState || entries.get(profileId) !== entry || entry.backgroundDisabled || entry.backgroundStop ||
        entry.cleanupRetryTimer || entry.cleanupAttempts >= maximumCleanupAttempts) return;
    entry.cleanupAttempts += 1;
    const attempt = Promise.resolve().then(() => {
      if (!abandoningState) return stopEntry(profileId, entry);
    }).catch(async (error) => {
      entry.cleanupError = error;
      await markCleanupError(profileId, entry);
      if (abandoningState || entries.get(profileId) !== entry || entry.backgroundDisabled ||
          entry.cleanupAttempts >= maximumCleanupAttempts) return;
      entry.cleanupRetryTimer = setTimeout(() => {
        entry.cleanupRetryTimer = null;
        stopInBackground(profileId, entry);
      }, cleanupRetryDelayMs);
      entry.cleanupRetryTimer.unref?.();
    });
    entry.backgroundStop = attempt;
    // EventEmitter and timer callbacks cannot own a rejected cleanup promise.
    // Keep the failure on the entry and in Profile state for manual close retry.
    void attempt.catch((error) => { entry.cleanupError = error; }).finally(() => {
      if (entry.backgroundStop === attempt) entry.backgroundStop = null;
    });
  }

  async function openProfile(identifier) {
    assertCurrentState();
    const operation = openProfileInState(identifier);
    pendingOpens.add(operation);
    try {
      return await operation;
    } finally {
      pendingOpens.delete(operation);
    }
  }

  async function openProfileInState(identifier) {
    await writeState('recoverExpiredLeases');
    assertCurrentState();
    let profile = await profileStore.get(identifier);
    assertCurrentState();
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
    assertCurrentState();
    profile = await profileStore.get(profile.id);
    assertCurrentState();
    if (profile.lease) {
      throw new TaskServiceError(
        profile.state === 'error' ? 'PROFILE_CLEANUP_UNCONFIRMED' : 'PROFILE_LEASED',
        profile.state === 'error'
          ? 'Profile cleanup is not confirmed'
          : 'Profile is already in use',
        409
      );
    }

    assertCurrentState();
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
      userDataDir: profile.userDataDir,
      ownerId,
      nonce,
      generation: null,
      lastHeartbeatAt: Date.now(),
      renewTail: Promise.resolve(),
      cleanupTail: Promise.resolve(),
      cleanupConfirmed: false,
      cleanupAttempts: 0,
      cleanupRetryTimer: null,
      cleanupError: null,
      cleanupErrorMarked: false,
      backgroundStop: null,
      backgroundDisabled: false,
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
    entry.rejectReady = rejectReady;
    // A worker can fail while acquireLease is still pending; observe now, await below.
    entry.readyPromise.catch(() => {});
    entries.set(profile.id, entry);

    child.once('exit', () => {
      resolveExit(true);
      if (!entry.stopping) rejectReady(new TaskServiceError('PROFILE_WORKER_EXITED', 'Profile worker exited', 500));
      if (!entry.stopping) stopInBackground(profile.id, entry);
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
        if (entry.browserClosed && !abandoningState) await confirmCleanup(profile.id, entry).catch(() => false);
        if (typeof message.cleanupId === 'string') {
          await send(entry.child, { type: 'closed_ack', cleanupId: message.cleanupId });
        }
        resolveClosed(true);
      }
      if (message?.type === 'heartbeat') {
        if (abandoningState) return;
        entry.lastHeartbeatAt = Date.now();
        entry.renewTail = entry.renewTail.then(async () => {
          if (abandoningState || entry.stopping || !entry.generation) return;
          const renewed = await writeState('renewLease', profile.id, {
            ownerId,
            nonce,
            generation: entry.generation,
            ttlMs: leaseTtlMs
          });
          if (!renewed) throw new Error('Profile lease was lost');
        }).catch(() => {
          stopInBackground(profile.id, entry);
        });
      }
    });

    try {
      assertCurrentState();
      const leased = await writeState('acquireLease', profile.id, {
        ownerId,
        kind: 'manual',
        pid: child.pid,
        nonce,
        ttlMs: leaseTtlMs
      });
      entry.generation = leased.lease.generation;
      assertCurrentState();
      if (!(await send(child, { type: 'open', profile: leased }))) {
        throw new TaskServiceError('PROFILE_WORKER_START_FAILED', 'Profile worker did not accept startup', 500);
      }
      assertCurrentState();
      entry.watchdog = setInterval(() => {
        if (!entry.stopping && Date.now() - entry.lastHeartbeatAt > heartbeatTimeoutMs) {
          stopInBackground(profile.id, entry);
        }
      }, Math.min(5_000, Math.max(1_000, Math.floor(heartbeatTimeoutMs / 3))));
      entry.watchdog.unref?.();
      const opened = await wait(entry.readyPromise, openTimeoutMs);
      assertCurrentState();
      if (opened !== true) throw new TaskServiceError('PROFILE_OPEN_TIMEOUT', 'Profile did not open in time', 504);
      return { status: 'open', profileId: profile.id, pid: child.pid };
    } catch (error) {
      // Detection only fences state. Explicit recovery owns process containment.
      if (abandoningState) throw error;
      try {
        await stopEntry(profile.id, entry);
      } catch (cleanupError) {
        throw cleanupError;
      }
      throw error;
    }
  }

  async function closeProfile(identifier) {
    assertCurrentState();
    await writeState('recoverExpiredLeases');
    assertCurrentState();
    const profile = await profileStore.get(identifier);
    assertCurrentState();
    const entry = entries.get(profile.id);
    if (entry) {
      clearTimeout(entry.cleanupRetryTimer);
      entry.cleanupRetryTimer = null;
      entry.cleanupAttempts = 0;
      return stopEntry(profile.id, entry);
    }
    if (profile.lease?.kind === 'manual') {
      await writeState('markLeaseError', profile.id, profile.lease).catch(() => {});
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
      [...entries.entries()].map(([profileId, entry]) => {
        entry.backgroundDisabled = true;
        clearTimeout(entry.cleanupRetryTimer);
        entry.cleanupRetryTimer = null;
        return stopEntry(profileId, entry);
      })
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  function beginStateRecovery() {
    abandoningState = true;
    for (const entry of entries.values()) {
      entry.rejectReady(new TaskServiceError('MANAGER_STATE_CHANGED', 'Manager state recovery is in progress', 409));
      entry.backgroundDisabled = true;
      entry.stopping = true;
      clearInterval(entry.watchdog);
      clearTimeout(entry.cleanupRetryTimer);
      entry.cleanupRetryTimer = null;
    }
  }

  function containmentError() {
    return new TaskServiceError(
      'MANAGER_RECOVERY_CONTAINMENT_FAILED',
      'One or more manual Profile operations or processes could not be contained; retry Manager recovery',
      409
    );
  }

  async function containEntry(profileId, entry) {
    if (entry.containmentPromise) return entry.containmentPromise;
    const attempt = (async () => {
      await send(entry.child, { type: 'close' });
      await wait(Promise.race([entry.closedPromise, entry.exitPromise]), closeTimeoutMs);
      if (entry.browserClosed === true && processAlive(entry.child.pid)) {
        await wait(entry.exitPromise, 1_000);
      }
      if (processAlive(entry.child.pid) || entry.browserClosed !== true) {
        const terminated = await terminateOwnedTree(profileId, entry);
        if (terminated) await wait(entry.exitPromise, 3_000);
      }
      if (processAlive(entry.child.pid)) return false;
      // A cleanup acknowledgement belongs to the old runtime. Confirm physical
      // inactivity again before a replacement Manager may use the Profile.
      const inactive = await profileUsageProbe(entry.userDataDir).catch(() => 'unknown') === 'inactive';
      if (inactive && entries.get(profileId) === entry) entries.delete(profileId);
      return inactive;
    })();
    entry.containmentPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (entry.containmentPromise === attempt) entry.containmentPromise = null;
    }
  }

  async function containAllWithoutState() {
    beginStateRecovery();
    if (containmentPromise) return containmentPromise;
    const targets = [...entries.entries()];
    const attempt = (async () => {
      const results = await Promise.allSettled(targets.map(([profileId, entry]) => containEntry(profileId, entry)));
      // Calls already inside a store await cannot be cancelled. Keep recovery
      // pending until they settle; their continuations may no longer spawn or write.
      const settled = await wait(Promise.allSettled([...pendingOpens, ...pendingStateWrites]).then(() => true), closeTimeoutMs);
      if (settled !== true || entries.size || pendingOpens.size || pendingStateWrites.size ||
          results.some((result) => result.status !== 'fulfilled' || result.value !== true)) {
        throw containmentError();
      }
      return { profiles: targets.length };
    })();
    containmentPromise = attempt;
    try {
      return await attempt;
    } finally {
      if (containmentPromise === attempt) containmentPromise = null;
    }
  }

  function owns(profileId) {
    return entries.has(profileId);
  }

  function activeCount() {
    return entries.size + pendingOpens.size + pendingStateWrites.size;
  }

  return Object.freeze({ openProfile, closeProfile, closeAll, beginStateRecovery, containAllWithoutState, owns, activeCount });
}
