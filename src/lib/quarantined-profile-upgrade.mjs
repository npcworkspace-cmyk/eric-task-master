import { lstat, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { ManagerLock } from './manager-lock.mjs';
import { isProcessAlive, ProfileStore } from './profile-store.mjs';

const PROFILE_ID_PATTERN = /^profile_[a-f0-9]{32}$/u;
const TASK_ID_PATTERN = /^task_[a-f0-9]{32}$/u;
const LEGACY_INTERRUPTION_CODES = new Set([
  'TASK_INTERRUPTED_BY_MANAGER_RESTART',
  'TASK_CANCEL_CLEANUP_UNCONFIRMED'
]);

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function sameManagerRecord(actual, expected) {
  return actual?.pid === expected?.pid &&
    actual?.version === expected?.version &&
    actual?.baseUrl === expected?.baseUrl;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function atomicJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function pathMissing(filePath) {
  try {
    await lstat(filePath);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function recoverableDiscardedTask(task, profileIds) {
  return TASK_ID_PATTERN.test(task?.id || '') &&
    profileIds.has(task?.profileId) &&
    task.leaseOwner === `task:${task.id}` &&
    task.leaseHeld === true &&
    task.cleanup?.settled !== true &&
    task.cleanup?.managerRestartObserved === true &&
    ['failed', 'cancelled'].includes(task.state) &&
    LEGACY_INTERRUPTION_CODES.has(task.error?.code);
}

async function settleDiscardedProfileTasks({
  stateDir,
  profileIds,
  processAlive = isProcessAlive
}) {
  const requested = new Set(profileIds);
  if (requested.size === 0) return 0;
  let entries;
  try {
    entries = await readdir(join(stateDir, 'tasks'), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) continue;
    const taskFile = join(stateDir, 'tasks', entry.name, 'task.json');
    let task;
    try {
      task = await readJson(taskFile);
    } catch {
      continue;
    }
    if (task?.id !== entry.name || !recoverableDiscardedTask(task, requested)) continue;
    if (await processAlive(task.workerPid)) continue;
    if (!(await pathMissing(join(stateDir, 'profiles', task.profileId)))) continue;
    const recoveredAt = new Date().toISOString();
    task.leaseHeld = false;
    task.cleanup = {
      ...(task.cleanup || {}),
      browserClosed: true,
      leaseReleased: true,
      workerExited: true,
      settled: true,
      quarantinedProfileDiscardRecovered: true,
      quarantinedProfileDiscardRecoveredAt: recoveredAt
    };
    delete task.cleanup.leaseReleaseError;
    task.updatedAt = recoveredAt;
    await atomicJson(taskFile, task);
    recovered += 1;
  }
  return recovered;
}

function inProfilesRoot(profilesRoot, profileId, userDataDir) {
  if (!PROFILE_ID_PATTERN.test(profileId)) return false;
  const expectedPath = resolve(profilesRoot, profileId);
  return resolve(userDataDir || '') === expectedPath &&
    expectedPath.startsWith(`${resolve(profilesRoot)}${sep}`);
}

export async function inspectQuarantinedEphemeralUpgrade({
  stateDir,
  publicProfiles,
  processAlive = isProcessAlive
}) {
  if (!Array.isArray(publicProfiles)) {
    return { eligible: false, profileIds: [], reason: 'public-profile-summary-invalid' };
  }
  const publicBlocked = publicProfiles.filter((profile) => profile?.state !== 'idle');
  if (publicBlocked.length === 0) return { eligible: true, profileIds: [] };

  let data;
  try {
    data = await readJson(join(stateDir, 'profiles.json'));
  } catch {
    return { eligible: false, profileIds: [], reason: 'private-profile-store-unreadable' };
  }
  if (!Array.isArray(data?.profiles)) {
    return { eligible: false, profileIds: [], reason: 'private-profile-store-invalid' };
  }

  const privateBlocked = data.profiles.filter((profile) => profile?.state !== 'idle');
  const publicIds = new Set(publicBlocked.map((profile) => profile?.id));
  if (
    publicIds.size !== publicBlocked.length ||
    privateBlocked.length !== publicBlocked.length ||
    privateBlocked.some((profile) => !publicIds.has(profile?.id))
  ) {
    return { eligible: false, profileIds: [], reason: 'profile-summary-mismatch' };
  }

  const profilesRoot = join(stateDir, 'profiles');
  for (const profile of privateBlocked) {
    const structurallyDisposable = profile.kind === 'ephemeral' &&
      profile.state === 'error' &&
      profile.lease?.cleanupRequired === true &&
      /^task:/u.test(profile.lease.ownerId || '') &&
      typeof profile.cleanupUnknownAt === 'string' &&
      inProfilesRoot(profilesRoot, profile.id, profile.userDataDir);
    if (!structurallyDisposable) {
      return { eligible: false, profileIds: [], reason: 'profile-not-disposable' };
    }
    if (await processAlive(profile.lease.pid)) {
      return { eligible: false, profileIds: [], reason: 'profile-owner-alive' };
    }
    let entries;
    try {
      entries = await readdir(resolve(profilesRoot, profile.id));
    } catch {
      return { eligible: false, profileIds: [], reason: 'profile-directory-unreadable' };
    }
    if (entries.length !== 0) {
      return { eligible: false, profileIds: [], reason: 'profile-directory-not-empty' };
    }
  }
  return {
    eligible: true,
    profileIds: privateBlocked.map((profile) => profile.id)
  };
}

async function waitForProcessExit(pid, processAlive, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (await processAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  return true;
}

async function removeMatchingProof(filePath, expected, { required = false } = {}) {
  let current;
  try {
    current = await readJson(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT' && !required) return;
    throw error;
  }
  if (!sameManagerRecord(current, expected)) {
    throw Object.assign(new Error('Manager process proof changed during quarantined Profile recovery'), {
      code: 'MANAGER_RECOVERY_PROOF_MISMATCH'
    });
  }
  await rm(filePath, { force: true });
}

export async function discardQuarantinedProfilesAfterShutdown({
  stateDir,
  profileIds,
  expectedManager,
  processAlive = isProcessAlive
}) {
  if (!Array.isArray(profileIds) || profileIds.length === 0) return 0;
  if (!(await waitForProcessExit(expectedManager?.pid, processAlive))) {
    throw Object.assign(new Error(
      `Older Manager process ${expectedManager?.pid || 'unknown'} did not exit; quarantined Profiles were preserved`
    ), { code: 'MANAGER_RECOVERY_PROCESS_ALIVE' });
  }

  const managerLock = new ManagerLock(join(stateDir, '.manager.lock'));
  await managerLock.acquire();
  try {
    const publicProfiles = profileIds.map((id) => ({ id, state: 'error' }));
    const inspection = await inspectQuarantinedEphemeralUpgrade({
      stateDir,
      publicProfiles,
      processAlive
    });
    if (
      !inspection.eligible ||
      inspection.profileIds.length !== profileIds.length ||
      inspection.profileIds.some((id) => !profileIds.includes(id))
    ) {
      throw Object.assign(new Error(
        'Quarantined Profile evidence changed after Manager shutdown; Profiles were preserved'
      ), { code: 'PROFILE_RECOVERY_EVIDENCE_CHANGED' });
    }

    const pidFile = join(stateDir, 'manager.json');
    let currentPidRecord = null;
    try {
      currentPidRecord = await readJson(pidFile);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (currentPidRecord && !sameManagerRecord(currentPidRecord, expectedManager)) {
      throw Object.assign(new Error('Manager PID proof changed before quarantined Profile recovery'), {
        code: 'MANAGER_RECOVERY_PROOF_MISMATCH'
      });
    }

    const store = new ProfileStore({
      filePath: join(stateDir, 'profiles.json'),
      profilesRoot: join(stateDir, 'profiles'),
      processAlive
    });
    await store.init();
    for (const profileId of profileIds) {
      await store.remove(profileId, { discardQuarantinedEphemeral: true });
    }

    await settleDiscardedProfileTasks({ stateDir, profileIds, processAlive });

    if (currentPidRecord) await removeMatchingProof(pidFile, expectedManager, { required: true });
    await removeMatchingProof(
      join(stateDir, 'manager-shutdown-failure.json'),
      expectedManager
    );
    return profileIds.length;
  } finally {
    await managerLock.release();
  }
}

export async function recoverLegacyDiscardedQuarantineTasksAfterShutdown({
  stateDir,
  expectedManager,
  processAlive = isProcessAlive
}) {
  if (!(await waitForProcessExit(expectedManager?.pid, processAlive))) return 0;
  const managerLock = new ManagerLock(join(stateDir, '.manager.lock'));
  await managerLock.acquire();
  try {
    const pidFile = join(stateDir, 'manager.json');
    const failureFile = join(stateDir, 'manager-shutdown-failure.json');
    let currentPidRecord;
    let failure;
    try {
      [currentPidRecord, failure] = await Promise.all([
        readJson(pidFile),
        readJson(failureFile)
      ]);
    } catch (error) {
      if (error?.code === 'ENOENT') return 0;
      throw error;
    }
    if (
      !sameManagerRecord(currentPidRecord, expectedManager) ||
      !sameManagerRecord(failure, expectedManager) ||
      failure?.error?.code !== 'SERVICE_SHUTDOWN_UNCONFIRMED'
    ) return 0;

    const profiles = await readJson(join(stateDir, 'profiles.json'));
    if (!Array.isArray(profiles?.profiles)) return 0;
    const retainedProfileIds = new Set(profiles.profiles.map((profile) => profile?.id));
    const taskEntries = await readdir(join(stateDir, 'tasks'), { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const missingProfileIds = new Set();
    for (const entry of taskEntries) {
      if (!entry.isDirectory() || !TASK_ID_PATTERN.test(entry.name)) continue;
      let task;
      try {
        task = await readJson(join(stateDir, 'tasks', entry.name, 'task.json'));
      } catch {
        continue;
      }
      if (
        task?.id !== entry.name ||
        !PROFILE_ID_PATTERN.test(task?.profileId || '') ||
        retainedProfileIds.has(task.profileId) ||
        task.cleanup?.managerRestartObserved !== true ||
        task.cleanup?.settled === true ||
        task.leaseHeld !== true ||
        task.leaseOwner !== `task:${task.id}` ||
        !['failed', 'cancelled'].includes(task.state) ||
        !LEGACY_INTERRUPTION_CODES.has(task.error?.code) ||
        await processAlive(task.workerPid) ||
        !(await pathMissing(join(stateDir, 'profiles', task.profileId)))
      ) continue;
      missingProfileIds.add(task.profileId);
    }
    const recovered = await settleDiscardedProfileTasks({
      stateDir,
      profileIds: [...missingProfileIds],
      processAlive
    });
    if (recovered === 0) return 0;
    await removeMatchingProof(pidFile, expectedManager, { required: true });
    await removeMatchingProof(failureFile, expectedManager, { required: true });
    return recovered;
  } finally {
    await managerLock.release();
  }
}
