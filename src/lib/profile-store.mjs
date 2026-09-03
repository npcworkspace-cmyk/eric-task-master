import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { JsonStore } from './json-store.mjs';
import {
  isProcessAlive as defaultProcessAlive,
  probeChromeProfileUsage as defaultProfileUsageProbe
} from './process-tree.mjs';

const PROFILE_ID = /^profile_[a-f0-9]{32}$/u;
const DELETION_ID = /^delete_[a-f0-9]{32}$/u;
const DEFAULT_LEASE_TTL_MS = 45_000;

export class ProfileStoreError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ProfileStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function normalizeName(value) {
  if (typeof value !== 'string') {
    throw new ProfileStoreError('INVALID_PROFILE_NAME', 'Profile name is required');
  }
  const name = value.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new ProfileStoreError(
      'INVALID_PROFILE_NAME',
      'Profile name must contain 1-80 visible characters'
    );
  }
  return name;
}

function safeProfilePath(root, profileId, recordedPath = null) {
  if (!PROFILE_ID.test(profileId)) {
    throw new ProfileStoreError('INVALID_PROFILE_ID', 'Profile ID is invalid');
  }
  const expected = path.resolve(root, profileId);
  if (recordedPath !== null && path.resolve(recordedPath) !== expected) {
    throw new ProfileStoreError('INVALID_PROFILE_PATH', 'Profile data path is invalid', 500);
  }
  const relative = path.relative(path.resolve(root), expected);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ProfileStoreError('INVALID_PROFILE_PATH', 'Profile data path is invalid', 500);
  }
  return expected;
}

function safeDeletionPath(root, profileId, deletionId, recordedPath = null) {
  if (!PROFILE_ID.test(profileId) || !DELETION_ID.test(deletionId)) {
    throw new ProfileStoreError('INVALID_PROFILE_DELETION', 'Profile deletion record is invalid', 500);
  }
  const expected = path.resolve(root, `.deleting-${profileId}-${deletionId}`);
  if (recordedPath !== null && path.resolve(recordedPath) !== expected) {
    throw new ProfileStoreError('INVALID_PROFILE_DELETION', 'Profile deletion path is invalid', 500);
  }
  const relative = path.relative(path.resolve(root), expected);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ProfileStoreError('INVALID_PROFILE_DELETION', 'Profile deletion path is invalid', 500);
  }
  return expected;
}

function findProfile(data, identifier) {
  const key = String(identifier ?? '').trim();
  const profile = data.profiles.find((item) => (
    item.id === key || item.name.toLowerCase() === key.toLowerCase()
  ));
  if (!profile) throw new ProfileStoreError('PROFILE_NOT_FOUND', `Profile ${key || '(empty)'} was not found`, 404);
  return profile;
}

function validLease(lease) {
  return Boolean(
    lease && typeof lease === 'object' &&
    typeof lease.ownerId === 'string' && lease.ownerId &&
    ['task', 'manual'].includes(lease.kind) &&
    (
      (Number.isSafeInteger(lease.pid) && lease.pid > 0) ||
      (lease.identityUntrusted === true && lease.pid === null)
    ) &&
    typeof lease.nonce === 'string' && lease.nonce.length >= 8 &&
    Number.isSafeInteger(lease.generation) && lease.generation >= 1 &&
    Number.isFinite(Date.parse(lease.expiresAt))
  );
}

function sameLease(lease, { ownerId, nonce, generation } = {}) {
  return Boolean(
    lease && lease.ownerId === ownerId && lease.nonce === nonce &&
    lease.generation === generation
  );
}

export class ProfileStore {
  #store;
  #profilesRoot;
  #now;
  #processAlive;
  #profileUsageProbe;

  constructor({
    filePath,
    profilesRoot,
    now = Date.now,
    processAlive = defaultProcessAlive,
    profileUsageProbe = defaultProfileUsageProbe
  } = {}) {
    if (!filePath || !profilesRoot) throw new TypeError('filePath and profilesRoot are required');
    if (
      typeof now !== 'function' || typeof processAlive !== 'function' ||
      typeof profileUsageProbe !== 'function'
    ) {
      throw new TypeError('now, processAlive, and profileUsageProbe must be functions');
    }
    this.#store = new JsonStore(filePath, {
      version: 1, defaultProfileId: null, profiles: [], deletions: []
    });
    this.#profilesRoot = path.resolve(profilesRoot);
    this.#now = now;
    this.#processAlive = processAlive;
    this.#profileUsageProbe = profileUsageProbe;
  }

  async init() {
    await mkdir(this.#profilesRoot, { recursive: true, mode: 0o700 });
    await this.#store.init();
    await this.#store.update((data) => {
      const source = Array.isArray(data.profiles) ? data.profiles : [];
      const migrated = [];
      const names = new Set();
      for (const candidate of source) {
        // v3 has one Profile kind. Old ephemeral records are intentionally not
        // adopted because they never represented durable login state.
        if (!candidate || candidate.kind === 'ephemeral' || !PROFILE_ID.test(candidate.id || '')) continue;
        let name;
        try {
          name = normalizeName(candidate.name);
          safeProfilePath(this.#profilesRoot, candidate.id, candidate.userDataDir);
        } catch {
          continue;
        }
        if (names.has(name.toLowerCase())) continue;
        names.add(name.toLowerCase());
        const lease = validLease(candidate.lease)
          ? {
              ownerId: candidate.lease.ownerId,
              kind: candidate.lease.ownerId.startsWith('profile-open:') ? 'manual' : 'task',
              taskId: /^task:(task_[a-f0-9]{32})$/u.exec(candidate.lease.ownerId)?.[1] ?? null,
              pid: candidate.lease.pid,
              nonce: candidate.lease.nonce || `legacy-${candidate.lease.generation}`,
              generation: candidate.lease.generation,
              acquiredAt: candidate.lease.acquiredAt,
              heartbeatAt: candidate.lease.heartbeatAt || candidate.lease.acquiredAt,
              expiresAt: candidate.lease.expiresAt,
              ...(candidate.lease.identityUntrusted === true ? { identityUntrusted: true } : {}),
              ...(typeof candidate.lease.cleanupConfirmedAt === 'string'
                ? { cleanupConfirmedAt: candidate.lease.cleanupConfirmedAt }
                : {})
            }
          : candidate.lease
            ? {
                ownerId: `legacy-quarantine:${candidate.id}`,
                kind: 'task',
                taskId: /^task:(task_[a-f0-9]{32})$/u.exec(String(candidate.lease.ownerId || ''))?.[1] ?? null,
                pid: Number.isSafeInteger(candidate.lease.pid) && candidate.lease.pid > 0
                  ? candidate.lease.pid
                  : null,
                nonce: `legacy-${randomUUID().replaceAll('-', '')}`,
                generation: Number.isSafeInteger(candidate.lease.generation) && candidate.lease.generation >= 1
                  ? candidate.lease.generation
                  : 1,
                acquiredAt: candidate.lease.acquiredAt || nowIso(this.#now),
                heartbeatAt: candidate.lease.heartbeatAt || candidate.lease.acquiredAt || nowIso(this.#now),
                expiresAt: candidate.lease.expiresAt || nowIso(this.#now),
                identityUntrusted: true
              }
            : null;
        migrated.push({
          id: candidate.id,
          name,
          userDataDir: safeProfilePath(this.#profilesRoot, candidate.id),
          state: lease
            ? (lease.identityUntrusted === true || candidate.state === 'error'
                ? 'error'
                : (lease.kind === 'manual' ? 'open' : 'leased'))
            : 'idle',
          lease,
          leaseGeneration: Number.isSafeInteger(candidate.leaseGeneration)
            ? Math.max(0, candidate.leaseGeneration)
            : lease?.generation ?? 0,
          createdAt: candidate.createdAt || nowIso(this.#now),
          updatedAt: candidate.updatedAt || nowIso(this.#now),
          lastUsedAt: candidate.lastUsedAt || null
        });
      }
      data.version = 1;
      data.profiles = migrated;
      data.deletions = (Array.isArray(data.deletions) ? data.deletions : []).filter((record) => {
        try {
          safeProfilePath(this.#profilesRoot, record.profileId, record.userDataDir);
          safeDeletionPath(this.#profilesRoot, record.profileId, record.id, record.tombstonePath);
          return true;
        } catch {
          return false;
        }
      });
      data.defaultProfileId = migrated.some((item) => item.id === data.defaultProfileId)
        ? data.defaultProfileId
        : migrated[0]?.id ?? null;
    });
    await this.#recoverPendingDeletions();
    await this.recoverExpiredLeases();
  }

  async #recoverPendingDeletions() {
    const data = await this.#store.read();
    for (const record of Array.isArray(data.deletions) ? data.deletions : []) {
      const sourcePath = safeProfilePath(this.#profilesRoot, record.profileId, record.userDataDir);
      const tombstonePath = safeDeletionPath(
        this.#profilesRoot,
        record.profileId,
        record.id,
        record.tombstonePath
      );
      const [source, tombstone] = await Promise.all([
        lstat(sourcePath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error)),
        lstat(tombstonePath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error))
      ]);
      if (source && tombstone) {
        throw new ProfileStoreError(
          'PROFILE_DELETE_RECOVERY_AMBIGUOUS',
          'Both the Profile and its deletion tombstone exist; cleanup stopped safely',
          500
        );
      }
      if (source) await rename(sourcePath, tombstonePath);
      await this.#store.update((draft) => {
        const current = draft.profiles.find((profile) => profile.id === record.profileId);
        if (current?.lease) {
          throw new ProfileStoreError(
            'PROFILE_LEASED',
            `Profile ${current.name} became active during deletion recovery`,
            409
          );
        }
        draft.profiles = draft.profiles.filter((profile) => profile.id !== record.profileId);
        if (draft.defaultProfileId === record.profileId) {
          draft.defaultProfileId = draft.profiles[0]?.id ?? null;
        }
      });
      await rm(tombstonePath, { recursive: true, force: true });
      await this.#store.update((draft) => {
        draft.deletions = (Array.isArray(draft.deletions) ? draft.deletions : [])
          .filter((deletion) => deletion.id !== record.id);
      });
    }
  }

  async snapshot() {
    return this.#store.read();
  }

  async list() {
    return (await this.#store.read()).profiles;
  }

  async get(identifier) {
    const data = await this.#store.read();
    return structuredClone(findProfile(data, identifier));
  }

  async getDefault() {
    const data = await this.#store.read();
    if (!data.defaultProfileId) return null;
    return structuredClone(findProfile(data, data.defaultProfileId));
  }

  async create({ name } = {}) {
    const normalizedName = normalizeName(name);
    const id = `profile_${randomUUID().replaceAll('-', '')}`;
    const userDataDir = safeProfilePath(this.#profilesRoot, id);
    await mkdir(userDataDir, { recursive: false, mode: 0o700 });
    try {
      let created;
      await this.#store.update((data) => {
        if (data.profiles.some((item) => item.name.toLowerCase() === normalizedName.toLowerCase())) {
          throw new ProfileStoreError('PROFILE_NAME_EXISTS', `Profile ${normalizedName} already exists`, 409);
        }
        const timestamp = nowIso(this.#now);
        created = {
          id,
          name: normalizedName,
          userDataDir,
          state: 'idle',
          lease: null,
          leaseGeneration: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastUsedAt: null
        };
        data.profiles.push(created);
        data.defaultProfileId ||= id;
      });
      return structuredClone(created);
    } catch (error) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async update(identifier, patch = {}) {
    const allowed = new Set(['name', 'isDefault']);
    const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new ProfileStoreError('INVALID_PROFILE_PATCH', `Unsupported fields: ${unknown.join(', ')}`);
    }
    let updated;
    await this.#store.update((data) => {
      const profile = findProfile(data, identifier);
      if (profile.state === 'deleting') {
        throw new ProfileStoreError('PROFILE_DELETING', `Profile ${profile.name} is being deleted`, 409);
      }
      if (Object.hasOwn(patch, 'name')) {
        const name = normalizeName(patch.name);
        if (data.profiles.some((item) => item.id !== profile.id && item.name.toLowerCase() === name.toLowerCase())) {
          throw new ProfileStoreError('PROFILE_NAME_EXISTS', `Profile ${name} already exists`, 409);
        }
        profile.name = name;
      }
      if (patch.isDefault === true) data.defaultProfileId = profile.id;
      if (patch.isDefault === false && data.defaultProfileId === profile.id) {
        throw new ProfileStoreError('DEFAULT_PROFILE_REQUIRED', 'Choose another default Profile first', 409);
      }
      profile.updatedAt = nowIso(this.#now);
      updated = profile;
    });
    return structuredClone(updated);
  }

  async acquireLease(identifier, { ownerId, kind, taskId = null, pid, nonce, ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
    if (typeof ownerId !== 'string' || !ownerId || !['task', 'manual'].includes(kind)) {
      throw new ProfileStoreError('INVALID_LEASE', 'Lease owner and kind are required');
    }
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof nonce !== 'string' || nonce.length < 8) {
      throw new ProfileStoreError('INVALID_LEASE', 'Lease process identity is invalid');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 2_000) {
      throw new ProfileStoreError('INVALID_LEASE', 'Lease ttlMs must be at least 2000');
    }

    const existing = await this.get(identifier);
    if (existing.state === 'deleting') {
      throw new ProfileStoreError('PROFILE_DELETING', `Profile ${existing.name} is being deleted`, 409);
    }
    if (existing.lease) {
      throw new ProfileStoreError(
        existing.state === 'error' ? 'PROFILE_CLEANUP_UNCONFIRMED' : 'PROFILE_LEASED',
        existing.state === 'error'
          ? `Profile ${existing.name} cleanup is not confirmed`
          : `Profile ${existing.name} is already in use`,
        409
      );
    }

    let leased;
    await this.#store.update((data) => {
      const profile = findProfile(data, existing.id);
      if (JSON.stringify(profile.lease) !== JSON.stringify(existing.lease)) {
        throw new ProfileStoreError('PROFILE_LEASED', `Profile ${profile.name} lease changed`, 409);
      }
      const timestamp = nowIso(this.#now);
      const generation = Math.max(0, profile.leaseGeneration || 0) + 1;
      profile.leaseGeneration = generation;
      profile.lease = {
        ownerId,
        kind,
        taskId: kind === 'task' ? taskId : null,
        pid,
        nonce,
        generation,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt: new Date(this.#now() + ttlMs).toISOString()
      };
      profile.state = kind === 'manual' ? 'open' : 'leased';
      profile.lastUsedAt = timestamp;
      profile.updatedAt = timestamp;
      leased = profile;
    });
    return structuredClone(leased);
  }

  async renewLease(identifier, { ownerId, nonce, generation, ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
    let renewed = false;
    await this.#store.update((data) => {
      const profile = findProfile(data, identifier);
      if (
        !profile.lease || profile.lease.ownerId !== ownerId || profile.lease.nonce !== nonce ||
        profile.lease.generation !== generation
      ) return;
      const timestamp = nowIso(this.#now);
      profile.lease.heartbeatAt = timestamp;
      profile.lease.expiresAt = new Date(this.#now() + ttlMs).toISOString();
      profile.updatedAt = timestamp;
      renewed = true;
    });
    return renewed;
  }

  async confirmLeaseCleanup(identifier, { ownerId, nonce, generation } = {}) {
    let confirmed = false;
    await this.#store.update((data) => {
      const profile = findProfile(data, identifier);
      if (!sameLease(profile.lease, { ownerId, nonce, generation })) return;
      profile.lease.cleanupConfirmedAt ||= nowIso(this.#now);
      profile.updatedAt = nowIso(this.#now);
      confirmed = true;
    });
    return confirmed;
  }

  async markLeaseError(identifier, { ownerId, nonce, generation } = {}) {
    let marked = false;
    await this.#store.update((data) => {
      const profile = findProfile(data, identifier);
      if (!sameLease(profile.lease, { ownerId, nonce, generation })) return;
      profile.state = 'error';
      profile.updatedAt = nowIso(this.#now);
      marked = true;
    });
    return marked;
  }

  async releaseLease(identifier, { ownerId, nonce, generation } = {}) {
    let released = false;
    await this.#store.update((data) => {
      const profile = findProfile(data, identifier);
      if (!profile.lease) {
        released = true;
        return;
      }
      if (!profile.lease.cleanupConfirmedAt) {
        throw new ProfileStoreError(
          'PROFILE_CLEANUP_UNCONFIRMED',
          `Profile ${profile.name} cleanup is not confirmed`,
          409
        );
      }
      if (
        profile.lease.ownerId !== ownerId || profile.lease.nonce !== nonce ||
        profile.lease.generation !== generation
      ) {
        throw new ProfileStoreError('LEASE_OWNER_MISMATCH', `Profile ${profile.name} lease changed`, 409);
      }
      profile.lease = null;
      profile.state = 'idle';
      profile.updatedAt = nowIso(this.#now);
      released = true;
    });
    return released;
  }

  async recoverExpiredLeases() {
    const data = await this.#store.read();
    const recoverable = new Map();
    for (const profile of data.profiles) {
      const lease = profile.lease;
      if (!lease) continue;
      if (lease.identityUntrusted === true) {
        const usage = await this.#profileUsageProbe(profile.userDataDir).catch(() => 'unknown');
        if (usage === false || usage === 'inactive') {
          recoverable.set(profile.id, {
            ownerId: lease.ownerId,
            nonce: lease.nonce,
            generation: lease.generation
          });
        }
        continue;
      }
      if (this.#processAlive(lease.pid)) continue;
      if (lease.cleanupConfirmedAt) {
        recoverable.set(profile.id, {
          ownerId: lease.ownerId,
          nonce: lease.nonce,
          generation: lease.generation
        });
        continue;
      }
      if (Date.parse(lease.expiresAt) > this.#now()) continue;
      const usage = await this.#profileUsageProbe(profile.userDataDir).catch(() => 'unknown');
      if (usage === false || usage === 'inactive') {
        recoverable.set(profile.id, {
          ownerId: lease.ownerId,
          nonce: lease.nonce,
          generation: lease.generation
        });
      }
    }
    const recoveredIds = [];
    await this.#store.update((draft) => {
      for (const profile of draft.profiles) {
        if (!profile.lease) continue;
        const identity = recoverable.get(profile.id);
        if (
          identity && sameLease(profile.lease, identity) &&
          (
            profile.lease.identityUntrusted === true ||
            (
              !this.#processAlive(profile.lease.pid) && (
                profile.lease.cleanupConfirmedAt || Date.parse(profile.lease.expiresAt) <= this.#now()
              )
            )
          )
        ) {
          profile.lease = null;
          profile.state = 'idle';
          profile.updatedAt = nowIso(this.#now);
          recoveredIds.push(profile.id);
        } else if (
          profile.lease.identityUntrusted === true ||
          (!profile.lease.cleanupConfirmedAt && !this.#processAlive(profile.lease.pid))
        ) {
          profile.state = 'error';
          profile.updatedAt = nowIso(this.#now);
        }
      }
    });
    return recoveredIds;
  }

  async remove(identifier) {
    const profile = await this.get(identifier);
    if (profile.state === 'deleting') {
      await this.#recoverPendingDeletions();
      return profile;
    }
    if (profile.lease || profile.state !== 'idle') {
      throw new ProfileStoreError('PROFILE_LEASED', `Profile ${profile.name} is still in use`, 409);
    }
    const profilePath = safeProfilePath(this.#profilesRoot, profile.id, profile.userDataDir);
    const deletionId = `delete_${randomUUID().replaceAll('-', '')}`;
    const tombstonePath = safeDeletionPath(this.#profilesRoot, profile.id, deletionId);
    await this.#store.update((data) => {
      const current = findProfile(data, profile.id);
      if (current.lease || current.state !== 'idle') {
        throw new ProfileStoreError('PROFILE_LEASED', `Profile ${current.name} is still in use`, 409);
      }
      current.state = 'deleting';
      current.updatedAt = nowIso(this.#now);
      data.deletions ||= [];
      data.deletions.push({
        id: deletionId,
        profileId: profile.id,
        userDataDir: profilePath,
        tombstonePath,
        createdAt: nowIso(this.#now)
      });
    });
    await this.#recoverPendingDeletions();
    return profile;
  }
}
