import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { removeCleanupReceipt, verifyCleanupReceipt } from '../lib/cleanup-receipt.mjs';
import {
  isSamePrincipal,
  profileCallerIdentity,
  requireProfileUse
} from './task-record-policy.mjs';
import { TaskServiceError } from './task-service-error.mjs';

export function createProfileRuntime({
  profileStore,
  workerFactory,
  profileWorkerPath,
  profileLeaseRenewalMs,
  heartbeatTimeoutMs,
  deadlines,
  awaitReady,
  requireServiceOpen,
  reconcileAnyCleanup,
  markCleanupUnknown,
  profileCleanupReceiptPath,
  send,
  sendChildMessageConfirmed,
  scheduleQueuedTasks
}) {
  if (
    !profileStore || typeof workerFactory !== 'function' || !profileWorkerPath || !deadlines ||
    typeof awaitReady !== 'function' || typeof requireServiceOpen !== 'function' ||
    typeof reconcileAnyCleanup !== 'function' || typeof markCleanupUnknown !== 'function' ||
    typeof profileCleanupReceiptPath !== 'function' || typeof send !== 'function' ||
    typeof sendChildMessageConfirmed !== 'function' || typeof scheduleQueuedTasks !== 'function'
  ) {
    throw new TypeError('Profile runtime dependencies are incomplete');
  }

  const openProfiles = new Map();
  const openingProfiles = new Map();
  async function openProfile(
    profileId,
    suppliedCaller = { role: 'manager-admin', clientId: 'manager-admin' }
  ) {
    await awaitReady();
    requireServiceOpen();
    const caller = profileCallerIdentity(suppliedCaller);
    let requestedProfile = requireProfileUse(await profileStore.get(profileId), caller);
    requestedProfile = await reconcileAnyCleanup(requestedProfile);
    requireProfileUse(requestedProfile, caller);
    if (/^session-import:/u.test(requestedProfile.lease?.ownerId || '')) {
      throw new TaskServiceError(
        'LEGACY_SESSION_IMPORT_CLEANUP_UNCONFIRMED',
        'A legacy session import has no trusted cleanup proof; this Profile remains quarantined',
        409
      );
    }
    const existing = openProfiles.get(profileId);
    if (existing) {
      if (caller.role !== 'manager-admin' && !isSamePrincipal(existing, caller)) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is open for another client', 409);
      }
      if (!existing.exited) {
        return { status: 'open', profileId, pid: existing.child.pid };
      }
      // Never report a dead manual worker as an open browser. A valid cleanup
      // receipt permits the old entry to release and a new worker to start;
      // missing or invalid proof keeps the Profile quarantined explicitly.
      await existing.cleanupReportPromise;
      if (!(await existing.release())) {
        await markCleanupUnknown(profileId, existing.ownerId, existing.leaseGeneration);
        throw new TaskServiceError(
          'PROFILE_CLEANUP_UNCONFIRMED',
          'The previous Profile browser exited without confirmed cleanup; the Profile remains blocked',
          409
        );
      }
      requestedProfile = await reconcileAnyCleanup(await profileStore.get(profileId));
      requireProfileUse(requestedProfile, caller);
    }
    const pending = openingProfiles.get(profileId);
    if (pending) {
      if (caller.role !== 'manager-admin' && !isSamePrincipal(pending, caller)) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is opening for another client', 409);
      }
      return pending.promise;
    }
    const operation = openProfileSingle(profileId, caller);
    openingProfiles.set(profileId, {
      promise: operation,
      ownerRole: caller.role,
      ownerClientId: caller.clientId
    });
    try {
      return await operation;
    } finally {
      if (openingProfiles.get(profileId)?.promise === operation) openingProfiles.delete(profileId);
    }
  }

  async function openProfileSingle(profileId, caller) {
    const ownerRole = caller.role;
    const ownerClientId = caller.clientId;
    const leaseAccess = caller.role === 'agent' ? { authorizedClientId: caller.clientId } : {};
    const ownerId = `profile-open:${ownerClientId}:${profileId}:${randomUUID().replaceAll('-', '')}`;
    const profile = await profileStore.get(profileId);
    if ((profile.kind || 'persistent') === 'ephemeral') {
      throw new TaskServiceError(
        'EPHEMERAL_PROFILE_OPEN_UNSUPPORTED',
        'Ephemeral Profiles are created only for task-scoped browser contexts',
        409
      );
    }
    const cleanupReceiptPath = profileCleanupReceiptPath(ownerId);
    let child;
    try {
      await rm(cleanupReceiptPath, { force: true });
      child = workerFactory(profileWorkerPath, 'profile-open');
      if (
        !child ||
        typeof child.once !== 'function' ||
        typeof child.on !== 'function' ||
        typeof child.send !== 'function' ||
        typeof child.kill !== 'function'
      ) {
        throw new TaskServiceError('PROFILE_WORKER_INVALID', 'Profile worker could not be initialized', 500);
      }
    } catch (error) {
      child?.kill?.('SIGKILL');
      throw error;
    }
    let resolveExit;
    let resolveCleanupReport;
    const entry = {
      child,
      ownerId,
      ownerRole,
      ownerClientId,
      released: false,
      exited: false,
      cleanupReported: false,
      cleanupConfirmed: false,
      browserStartSent: false,
      spawnFailed: false,
      renewal: null,
      renewalTail: Promise.resolve(),
      closing: false,
      lastHeartbeatAt: Date.now(),
      cleanupReceiptPath,
      leaseGeneration: null,
      exitPromise: new Promise((resolve) => { resolveExit = resolve; }),
      cleanupReportPromise: new Promise((resolve) => { resolveCleanupReport = resolve; }),
      releasePromise: null
    };
    openProfiles.set(profileId, entry);

    const release = async () => {
      if (entry.released) return true;
      if (!entry.exited || !entry.cleanupConfirmed) return false;
      if (entry.releasePromise) return entry.releasePromise;
      entry.releasePromise = (async () => {
        entry.closing = true;
        clearInterval(entry.renewal);
        await entry.renewalTail.catch(() => {});
        let released = await profileStore.releaseLease(profileId, ownerId, {
          cleanupConfirmed: true,
          ...(Number.isSafeInteger(entry.leaseGeneration)
            ? { expectedGeneration: entry.leaseGeneration }
            : {})
        });
        if (released !== true) {
          const current = await profileStore.get(profileId);
          released = current?.lease?.ownerId !== ownerId;
        }
        if (!released) return false;
        await removeCleanupReceipt(cleanupReceiptPath).catch(() => {});
        entry.released = true;
        if (openProfiles.get(profileId) === entry) openProfiles.delete(profileId);
        void scheduleQueuedTasks().catch(() => {});
        return true;
      })().catch(() => false);
      const released = await entry.releasePromise;
      if (!released) entry.releasePromise = null;
      return released;
    };
    entry.release = release;
    const confirmCleanup = async (browserClosed) => {
      if (entry.cleanupReported) return entry.cleanupReportPromise;
      entry.cleanupReported = true;
      entry.cleanupConfirmed = browserClosed === true &&
        await verifyCleanupReceipt(cleanupReceiptPath, {
          kind: 'profile',
          profileId,
          ownerId,
          workerPid: child.pid
        });
      resolveCleanupReport();
      await release();
      return entry.cleanupConfirmed;
    };
    try {
      child.once('exit', (code, signal) => {
        entry.exited = true;
        entry.exitCode = code;
        entry.exitSignal = signal || null;
        resolveExit();
        // A private, identity-bound receipt remains authoritative when the
        // child exits after closing Chromium but its final IPC message is lost.
        // `closed` normally arrives before `exit`. In that ordering the first
        // cleanup confirmation cannot release the lease yet, so the exit edge
        // must always retry the idempotent release after confirmation settles.
        void confirmCleanup(true).then(() => release());
      });
      child.once('error', () => {
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
          entry.spawnFailed = true;
          entry.exited = true;
          entry.cleanupReported = true;
          entry.cleanupConfirmed = true;
          resolveCleanupReport();
          resolveExit();
          void release();
        }
      });
      child.on('message', (message) => {
        if (message?.type === 'heartbeat') entry.lastHeartbeatAt = Date.now();
        if (message?.type === 'closed' && !entry.cleanupReported) {
          void confirmCleanup(message.browserClosed === true);
        }
      });
    } catch (error) {
      if (openProfiles.get(profileId) === entry) openProfiles.delete(profileId);
      try {
        child.kill('SIGKILL');
      } catch {
        // The worker never received a browser-start command and owns no Profile lease.
      }
      throw error;
    }

    try {
      const leasedProfile = await profileStore.acquireLease(profileId, ownerId, {
        pid: child.pid,
        ttlMs: 5 * 60_000,
        cleanupRequired: true,
        ...leaseAccess
      });
      entry.leaseGeneration = leasedProfile.lease?.generation ?? null;
      if (entry.exited) {
        throw new TaskServiceError('PROFILE_OPEN_FAILED', 'Profile worker exited before browser startup', 500);
      }
      let openTimer;
      const openResult = new Promise((resolve, reject) => {
        openTimer = setTimeout(
          () => reject(new TaskServiceError('PROFILE_OPEN_TIMEOUT', 'Profile did not open in time', 504)),
          deadlines.profileOpenMs
        );
        child.on('message', (message) => {
          if (message?.type === 'ready') {
            clearTimeout(openTimer);
            resolve(message);
          }
          if (message?.type === 'error') {
            clearTimeout(openTimer);
            reject(Object.assign(new Error(message.error?.message), message.error));
          }
        });
      });
      openResult.catch(() => {});
      entry.browserStartSent = await sendChildMessageConfirmed(child, {
        type: 'open',
        profile,
        cleanupReceiptPath,
        cleanupReceipt: { kind: 'profile', profileId, ownerId }
      });
      if (!entry.browserStartSent) {
        clearTimeout(openTimer);
        throw new TaskServiceError('PROFILE_OPEN_SEND_FAILED', 'Profile worker is unavailable', 500);
      }
      const result = await openResult;
      void result;
      if (entry.exited) throw new TaskServiceError('PROFILE_OPEN_FAILED', 'Profile worker exited while opening', 500);
      entry.renewal = setInterval(() => {
        if (entry.closing || entry.released) return;
        if (Date.now() - entry.lastHeartbeatAt > heartbeatTimeoutMs) {
          void closeProfile(profileId, { role: 'manager-admin', clientId: 'manager-admin' }).catch(() => {});
          return;
        }
        const renewal = entry.renewalTail.then(async () => {
          if (entry.closing || entry.released) return;
          await profileStore.acquireLease(profileId, ownerId, {
            pid: child.pid,
            ttlMs: 5 * 60_000,
            cleanupRequired: true,
            ...(Number.isSafeInteger(entry.leaseGeneration)
              ? { expectedGeneration: entry.leaseGeneration }
              : {}),
            ...leaseAccess
          });
        });
        entry.renewalTail = renewal.catch(() => {
          if (!entry.closing && !entry.released) send(child, { type: 'close' });
        });
      }, profileLeaseRenewalMs);
      entry.renewal.unref?.();
      return { status: 'open', profileId, pid: child.pid };
    } catch (error) {
      if (!entry.browserStartSent) {
        if (!entry.exited) {
          child.kill?.('SIGKILL');
          await waitForEntry(entry.exitPromise, deadlines.profileKillGraceMs);
        }
        entry.cleanupReported = true;
        entry.cleanupConfirmed = entry.exited;
        resolveCleanupReport();
        if (!(await entry.release())) await markCleanupUnknown(profileId, ownerId, entry.leaseGeneration);
      } else {
        send(child, { type: 'close' });
        await shutdownProfileEntry(profileId, entry);
      }
      throw error;
    }
  }

  async function waitForEntry(promise, timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function shutdownProfileEntry(profileId, entry) {
    send(entry.child, { type: 'close' });
    await waitForEntry(
      Promise.allSettled([entry.cleanupReportPromise, entry.exitPromise]),
      deadlines.profileCloseMs
    );
    if (!entry.exited) {
      entry.child.kill?.('SIGTERM');
      await waitForEntry(entry.exitPromise, deadlines.profileKillGraceMs);
    }
    if (!entry.exited) {
      entry.child.kill?.('SIGKILL');
      await waitForEntry(entry.exitPromise, deadlines.profileKillGraceMs);
    }
    if (await entry.release()) return true;
    await markCleanupUnknown(profileId, entry.ownerId, entry.leaseGeneration);
    return false;
  }

  async function closeProfile(
    profileId,
    suppliedCaller = { role: 'manager-admin', clientId: 'manager-admin' }
  ) {
    await awaitReady();
    const caller = profileCallerIdentity(suppliedCaller);
    requireProfileUse(await profileStore.get(profileId), caller);
    const pending = openingProfiles.get(profileId);
    if (pending) {
      if (caller.role !== 'manager-admin' && !isSamePrincipal(pending, caller)) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is opening for another client', 409);
      }
      await pending.promise.catch(() => {});
    }
    const entry = openProfiles.get(profileId);
    if (!entry) {
      let profile = await profileStore.get(profileId);
      profile = await reconcileAnyCleanup(profile);
      if (profile.lease || profile.state !== 'idle') {
        throw new TaskServiceError(
          'PROFILE_CLEANUP_UNCONFIRMED',
          'Profile browser cleanup could not be confirmed; the Profile remains blocked',
          409
        );
      }
      void scheduleQueuedTasks().catch(() => {});
      return { status: 'closed', profileId };
    }
    if (caller.role !== 'manager-admin' && !isSamePrincipal(entry, caller)) {
      throw new TaskServiceError('PROFILE_IN_USE', 'Profile is open for another client', 409);
    }
    if (!(await shutdownProfileEntry(profileId, entry))) {
      throw new TaskServiceError(
        'PROFILE_CLEANUP_UNCONFIRMED',
        'Profile browser cleanup could not be confirmed; the Profile remains blocked',
        409
      );
    }
    void scheduleQueuedTasks().catch(() => {});
    return { status: 'closed', profileId };
  }


  function isKnownLiveLease(profileId, ownerId) {
    const entry = openProfiles.get(profileId);
    return Boolean(entry && entry.exited !== true && entry.ownerId === ownerId);
  }

  function hasOpenProfiles() {
    return openProfiles.size > 0 || openingProfiles.size > 0;
  }

  async function closeAllProfiles() {
    const profileIds = [...openProfiles.keys()];
    return Promise.all(profileIds.map((profileId) => closeProfile(
      profileId,
      { role: 'manager-admin', clientId: 'manager-admin' }
    )));
  }

  return Object.freeze({
    closeAllProfiles,
    closeProfile,
    hasOpenProfiles,
    isKnownLiveLease,
    openProfile
  });
}
