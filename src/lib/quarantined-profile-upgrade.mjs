import { readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ManagerLock } from './manager-lock.mjs';
import { isProcessAlive, ProfileStore } from './profile-store.mjs';

const PROFILE_ID_PATTERN = /^profile_[a-f0-9]{32}$/u;

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
  return { eligible: true, profileIds: privateBlocked.map((profile) => profile.id) };
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
