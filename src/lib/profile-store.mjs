import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isBehaviorMode, isBrowserEngine, isProfileKind } from '../contracts.mjs';
import { JsonStore } from './json-store.mjs';

const DEFAULT_LEASE_TTL_MS = 60_000;
const PROFILE_ACCESS = new Set(['private', 'shared']);
const CLIENT_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/u;

export class ProfileStoreError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ProfileStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function normalizeName(value) {
  if (typeof value !== 'string') {
    throw new ProfileStoreError('INVALID_PROFILE_NAME', 'Profile name must be a string');
  }
  const name = value.trim();
  if (!name || name.length > 80) {
    throw new ProfileStoreError(
      'INVALID_PROFILE_NAME',
      'Profile name must contain 1 to 80 characters'
    );
  }
  return name;
}

function ensureBehaviorMode(value) {
  if (!isBehaviorMode(value)) {
    throw new ProfileStoreError(
      'INVALID_BEHAVIOR_MODE',
      'Behavior mode must be fast, human, or adaptive'
    );
  }
  return value;
}

function ensureHeadless(value) {
  if (typeof value !== 'boolean') {
    throw new ProfileStoreError('INVALID_HEADLESS', 'headless must be a boolean');
  }
  return value;
}

function ensureProfileKind(value) {
  if (!isProfileKind(value)) {
    throw new ProfileStoreError(
      'INVALID_PROFILE_KIND',
      'Profile kind must be persistent or ephemeral'
    );
  }
  return value;
}

function ensureBrowserEngine(value) {
  if (!isBrowserEngine(value)) {
    throw new ProfileStoreError(
      'INVALID_BROWSER_ENGINE',
      'browserEngine must be chrome or chromium'
    );
  }
  return value;
}

function migrateBrowserEngine(profile, { allowLegacyChannel }) {
  if (!allowLegacyChannel) {
    if (profile.browserEngine === undefined || Object.hasOwn(profile, 'browserChannel')) {
      throw new ProfileStoreError(
        'PROFILE_ENGINE_MIGRATION_REQUIRED',
        `Profile ${profile.id || '[unknown]'} has invalid browser engine metadata for this store version`,
        409
      );
    }
    profile.browserEngine = ensureBrowserEngine(profile.browserEngine);
    return;
  }
  if (profile.browserEngine !== undefined && !Object.hasOwn(profile, 'browserChannel')) {
    profile.browserEngine = ensureBrowserEngine(profile.browserEngine);
    return;
  }
  const legacyChannel = profile.browserChannel;
  let migratedEngine;
  if (legacyChannel === undefined || legacyChannel === null || legacyChannel === '' || legacyChannel === 'chromium') {
    migratedEngine = 'chromium';
  } else if (legacyChannel === 'chrome') {
    migratedEngine = 'chrome';
  } else {
    throw new ProfileStoreError(
      'PROFILE_ENGINE_MIGRATION_REQUIRED',
      `Profile ${profile.id || '[unknown]'} uses unsupported legacy browser channel ${String(legacyChannel)}`,
      409
    );
  }
  if (profile.browserEngine !== undefined && profile.browserEngine !== migratedEngine) {
    throw new ProfileStoreError(
      'PROFILE_ENGINE_MIGRATION_REQUIRED',
      `Profile ${profile.id || '[unknown]'} has conflicting browser engine metadata`,
      409
    );
  }
  profile.browserEngine = ensureBrowserEngine(profile.browserEngine ?? migratedEngine);
  delete profile.browserChannel;
}

function migrateProfileBehavior(profile) {
  if (profile.kind === 'persistent') {
    profile.defaultBehavior = 'human';
    return;
  }
  if (profile.defaultBehavior === undefined || profile.defaultBehavior === null || profile.defaultBehavior === '') {
    profile.defaultBehavior = 'adaptive';
    return;
  }
  profile.defaultBehavior = ensureBehaviorMode(profile.defaultBehavior);
}

function ensureProfileAccess(value) {
  if (!PROFILE_ACCESS.has(value)) {
    throw new ProfileStoreError('INVALID_PROFILE_ACCESS', 'Profile access must be private or shared');
  }
  return value;
}

function ensureOwnerClientId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !CLIENT_ID_PATTERN.test(value)) {
    throw new ProfileStoreError('INVALID_PROFILE_OWNER', 'Profile ownerClientId is invalid');
  }
  return value;
}

function requireLeaseAccess(profile, authorizedClientId) {
  if (
    authorizedClientId &&
    profile.ownerClientId !== authorizedClientId &&
    (profile.access || 'shared') !== 'shared'
  ) {
    throw new ProfileStoreError(
      'PROFILE_ACCESS_DENIED',
      'This Agent is not authorized to use this Profile',
      403
    );
  }
}

function findProfile(data, profileId) {
  const profile = data.profiles.find((item) => item.id === profileId);
  if (!profile) {
    throw new ProfileStoreError('PROFILE_NOT_FOUND', `Profile ${profileId} was not found`, 404);
  }
  return profile;
}

export class ProfileStore {
  #store;
  #profilesRoot;
  #now;
  #processAlive;
  #renamePath;
  #removePath;

  constructor({
    filePath,
    profilesRoot,
    now = () => Date.now(),
    processAlive = isProcessAlive,
    renamePath = rename,
    removePath = rm
  }) {
    if (!profilesRoot) throw new TypeError('profilesRoot is required');
    this.#store = new JsonStore(filePath, { version: 3, profiles: [] });
    this.#profilesRoot = profilesRoot;
    this.#now = now;
    this.#processAlive = processAlive;
    this.#renamePath = renamePath;
    this.#removePath = removePath;
  }

  async init() {
    await mkdir(this.#profilesRoot, { recursive: true, mode: 0o700 });
    await this.#store.init();
    // v0.x Profile records predate explicit persistence semantics. Preserve
    // their existing browser state by migrating them to persistent Profiles.
    await this.#store.update((data) => {
      if (data.version !== undefined && ![1, 2, 3].includes(data.version)) {
        throw new ProfileStoreError(
          'PROFILE_STORE_VERSION_UNSUPPORTED',
          `Profile store version ${String(data.version)} is unsupported`,
          409
        );
      }
      const allowLegacyChannel = data.version === undefined || data.version === 1;
      for (const profile of data.profiles) {
        profile.kind ||= 'persistent';
        ensureProfileKind(profile.kind);
        migrateBrowserEngine(profile, { allowLegacyChannel });
        migrateProfileBehavior(profile);
        profile.ownerClientId ??= null;
        profile.access ||= 'shared';
        if (
          profile.lease &&
          /^(?:task:|profile-open:|session-import:)/u.test(profile.lease.ownerId || '') &&
          profile.lease.cleanupRequired === undefined
        ) {
          profile.lease.cleanupRequired = true;
        }
      }
      data.version = 3;
    });
    await this.#recoverInterruptedDeletions();
    await this.recoverExpiredLeases();
  }

  async list() {
    const data = await this.#store.read();
    return data.profiles;
  }

  async get(profileId) {
    const data = await this.#store.read();
    return structuredClone(findProfile(data, profileId));
  }

  async create(input = {}, ownership = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ProfileStoreError('INVALID_PROFILE', 'Profile input must be an object');
    }
    const allowed = new Set(['name', 'kind', 'defaultBehavior', 'headless', 'browserEngine']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new ProfileStoreError(
        'INVALID_PROFILE_CREATE',
        `Unsupported profile fields: ${unknown.join(', ')}`
      );
    }
    const {
      name,
      kind = 'persistent',
      defaultBehavior: requestedBehavior,
      headless = false,
      browserEngine: requestedBrowserEngine
    } = input;
    const normalizedName = normalizeName(name);
    ensureProfileKind(kind);
    const defaultBehavior = ensureBehaviorMode(
      requestedBehavior ?? (kind === 'persistent' ? 'human' : 'adaptive')
    );
    if (kind === 'persistent' && defaultBehavior !== 'human') {
      throw new ProfileStoreError(
        'PERSISTENT_BEHAVIOR_FIXED',
        'Persistent Profiles always use human behavior'
      );
    }
    ensureHeadless(headless);
    const browserEngine = ensureBrowserEngine(
      requestedBrowserEngine ?? (kind === 'persistent' ? 'chrome' : 'chromium')
    );
    const ownerClientId = ensureOwnerClientId(ownership.ownerClientId);
    const access = ensureProfileAccess(ownership.access ?? (ownerClientId ? 'private' : 'shared'));
    const now = new Date(this.#now()).toISOString();
    const profileId = `profile_${randomUUID().replaceAll('-', '')}`;
    const userDataDir = join(this.#profilesRoot, profileId);
    await mkdir(userDataDir, { recursive: false, mode: 0o700 });

    try {
      let created;
      await this.#store.update((data) => {
        if (data.profiles.some((item) => item.name.toLowerCase() === normalizedName.toLowerCase())) {
          throw new ProfileStoreError(
            'PROFILE_NAME_EXISTS',
            `A profile named ${normalizedName} already exists`,
            409
          );
        }
        created = {
          id: profileId,
          name: normalizedName,
          kind,
          userDataDir,
          defaultBehavior,
          headless,
          browserEngine,
          ownerClientId,
          access,
          state: 'idle',
          lease: null,
          createdAt: now,
          updatedAt: now,
          lastUsedAt: null
        };
        data.profiles.push(created);
      });
      return structuredClone(created);
    } catch (error) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async update(profileId, patch = {}) {
    const allowed = new Set(['name', 'defaultBehavior', 'headless', 'access']);
    const unknown = Object.keys(patch).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new ProfileStoreError(
        'INVALID_PROFILE_PATCH',
        `Unsupported profile fields: ${unknown.join(', ')}`
      );
    }
    if ('name' in patch) patch = { ...patch, name: normalizeName(patch.name) };
    if ('defaultBehavior' in patch) {
      patch = { ...patch, defaultBehavior: ensureBehaviorMode(patch.defaultBehavior) };
    }
    if ('headless' in patch) patch = { ...patch, headless: ensureHeadless(patch.headless) };
    if ('access' in patch) patch = { ...patch, access: ensureProfileAccess(patch.access) };
    let updated;
    await this.#store.update((data) => {
      const profile = findProfile(data, profileId);
      if (profile.kind === 'persistent' && 'defaultBehavior' in patch) {
        throw new ProfileStoreError(
          'PERSISTENT_BEHAVIOR_FIXED',
          'Persistent Profile behavior cannot be changed'
        );
      }
      if (
        patch.access === 'private' &&
        (profile.access || 'shared') !== 'private' &&
        (profile.lease || profile.state !== 'idle')
      ) {
        throw new ProfileStoreError(
          'PROFILE_IN_USE',
          `Profile ${profileId} must be idle before shared access can be revoked`,
          409
        );
      }
      if (
        patch.name &&
        data.profiles.some(
          (item) => item.id !== profileId && item.name.toLowerCase() === patch.name.toLowerCase()
        )
      ) {
        throw new ProfileStoreError(
          'PROFILE_NAME_EXISTS',
          `A profile named ${patch.name} already exists`,
          409
        );
      }
      Object.assign(profile, patch, { updatedAt: new Date(this.#now()).toISOString() });
      updated = profile;
    });
    return structuredClone(updated);
  }

  async remove(profileId) {
    const profile = await this.get(profileId);
    if (profile.lease || profile.state !== 'idle') {
      throw new ProfileStoreError(
        'PROFILE_IN_USE',
        `Profile ${profileId} must be idle before it can be removed`,
        409
      );
    }
    const expectedPath = resolve(this.#profilesRoot, profileId);
    const resolvedRoot = resolve(this.#profilesRoot);
    if (
      !/^profile_[a-f0-9]{32}$/.test(profileId) ||
      resolve(profile.userDataDir) !== expectedPath ||
      !expectedPath.startsWith(`${resolvedRoot}\\`) && !expectedPath.startsWith(`${resolvedRoot}/`)
    ) {
      throw new ProfileStoreError(
        'INVALID_PROFILE_PATH',
        `Profile ${profileId} has an invalid data path`,
        500
      );
    }
    const tombstonePath = resolve(this.#profilesRoot, `.deleting-${profileId}-${randomUUID()}`);
    const tombstoneName = tombstonePath.slice(resolve(this.#profilesRoot).length + 1);
    const deletionOwner = `profile-delete:${randomUUID().replaceAll('-', '')}`;
    let removed = profile;
    let moved = false;
    let movedPhasePersisted = false;
    try {
      await this.#store.update((data) => {
        const current = findProfile(data, profileId);
        if (current.lease || current.state !== 'idle') {
          throw new ProfileStoreError(
            'PROFILE_IN_USE',
            `Profile ${profileId} must be idle before it can be removed`,
            409
          );
        }
        const nowMs = this.#now();
        current.state = 'deleting';
        current.lease = {
          ownerId: deletionOwner,
          pid: process.pid,
          acquiredAt: new Date(nowMs).toISOString(),
          heartbeatAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + 5 * 60_000).toISOString()
        };
        current.deletion = {
          tombstoneName,
          startedAt: new Date(nowMs).toISOString(),
          phase: 'prepared'
        };
        current.updatedAt = new Date(nowMs).toISOString();
      });
      await this.#renamePath(expectedPath, tombstonePath);
      moved = true;
      await this.#store.update((data) => {
        const current = findProfile(data, profileId);
        if (
          current.state !== 'deleting' ||
          current.lease?.ownerId !== deletionOwner ||
          current.deletion?.tombstoneName !== tombstoneName
        ) {
          throw new ProfileStoreError('PROFILE_DELETE_RACE', 'Profile deletion state changed concurrently', 409);
        }
        current.deletion.phase = 'moved';
        current.updatedAt = new Date(this.#now()).toISOString();
      });
      movedPhasePersisted = true;
      try {
        await this.#removePath(tombstonePath, { recursive: true, force: true });
      } catch (error) {
        throw new ProfileStoreError(
          'PROFILE_DELETE_IO_FAILED',
          `Profile ${profileId} data could not be removed: ${error?.message || 'filesystem error'}`,
          500
        );
      }
      if (await this.#pathStats(tombstonePath)) {
        throw new ProfileStoreError(
          'PROFILE_DELETE_IO_FAILED',
          `Profile ${profileId} data still exists after deletion`,
          500
        );
      }
      await this.#store.update((data) => {
        const index = data.profiles.findIndex((item) => item.id === profileId);
        if (index === -1) {
          throw new ProfileStoreError('PROFILE_NOT_FOUND', `Profile ${profileId} was not found`, 404);
        }
        const current = data.profiles[index];
        if (
          current.state !== 'deleting' ||
          current.lease?.ownerId !== deletionOwner ||
          current.deletion?.tombstoneName !== tombstoneName ||
          current.deletion?.phase !== 'moved'
        ) {
          throw new ProfileStoreError('PROFILE_DELETE_RACE', 'Profile deletion state changed concurrently', 409);
        }
        [removed] = data.profiles.splice(index, 1);
      });
    } catch (error) {
      if (!movedPhasePersisted && moved) {
        await this.#renamePath(tombstonePath, expectedPath).catch(() => {});
      }
      if (!movedPhasePersisted) {
        const expectedExists = Boolean(await this.#pathStats(expectedPath));
        const tombstoneExists = Boolean(await this.#pathStats(tombstonePath));
        await this.#store.update((data) => {
          const current = data.profiles.find((item) => item.id === profileId);
          if (current?.lease?.ownerId !== deletionOwner) return;
          current.state = expectedExists && !tombstoneExists ? 'idle' : 'error';
          current.lease = null;
          if (expectedExists && !tombstoneExists) delete current.deletion;
          current.updatedAt = new Date(this.#now()).toISOString();
        }).catch(() => {});
      }
      throw error;
    }
    return structuredClone(removed);
  }

  async #recoverInterruptedDeletions() {
    const snapshot = await this.#store.read();
    for (const profile of snapshot.profiles) {
      if (!profile.deletion?.tombstoneName) continue;
      const expectedPath = resolve(this.#profilesRoot, profile.id);
      const tombstonePath = resolve(this.#profilesRoot, profile.deletion.tombstoneName);
      const valid = /^profile_[a-f0-9]{32}$/.test(profile.id) &&
        /^\.deleting-profile_[a-f0-9]{32}-[a-f0-9-]{36}$/.test(profile.deletion.tombstoneName) &&
        tombstonePath.startsWith(`${resolve(this.#profilesRoot)}${sep}`);
      if (!valid) {
        await this.#store.update((data) => {
          const current = data.profiles.find((item) => item.id === profile.id);
          if (current?.deletion?.tombstoneName === profile.deletion.tombstoneName) {
            current.state = 'error';
            current.lease = null;
          }
        });
        continue;
      }
      const expectedExists = Boolean(await this.#pathStats(expectedPath));
      const tombstoneExists = Boolean(await this.#pathStats(tombstonePath));
      if (profile.deletion.phase === 'moved') {
        if (!expectedExists && tombstoneExists) {
          try {
            await this.#removePath(tombstonePath, { recursive: true, force: true });
          } catch (error) {
            throw new ProfileStoreError(
              'PROFILE_DELETE_RECOVERY_FAILED',
              `Profile ${profile.id} tombstone could not be removed: ${error?.message || 'filesystem error'}`,
              500
            );
          }
        }
        const canonicalAfter = Boolean(await this.#pathStats(expectedPath));
        const tombstoneAfter = Boolean(await this.#pathStats(tombstonePath));
        if (!canonicalAfter && !tombstoneAfter) {
          await this.#store.update((data) => {
            const index = data.profiles.findIndex((item) => item.id === profile.id);
            if (index === -1) return;
            const current = data.profiles[index];
            if (
              current.deletion?.tombstoneName === profile.deletion.tombstoneName &&
              current.deletion?.phase === 'moved'
            ) {
              data.profiles.splice(index, 1);
            }
          });
          continue;
        }
        if (canonicalAfter && !tombstoneAfter) {
          await this.#markDeletionRecovered(profile);
          continue;
        }
        await this.#markDeletionError(profile);
        continue;
      }

      let recovered = expectedExists && !tombstoneExists;
      if (!expectedExists && tombstoneExists) {
        await this.#renamePath(tombstonePath, expectedPath);
        recovered = true;
      }
      if (recovered) await this.#markDeletionRecovered(profile);
      else await this.#markDeletionError(profile);
    }
    await this.#recoverOrphanTombstones();
  }

  async #pathStats(filePath) {
    try {
      return await lstat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #markDeletionRecovered(profile) {
    await this.#store.update((data) => {
      const current = data.profiles.find((item) => item.id === profile.id);
      if (current?.deletion?.tombstoneName !== profile.deletion.tombstoneName) return;
      current.state = 'idle';
      current.lease = null;
      delete current.deletion;
      current.updatedAt = new Date(this.#now()).toISOString();
    });
  }

  async #markDeletionError(profile) {
    await this.#store.update((data) => {
      const current = data.profiles.find((item) => item.id === profile.id);
      if (current?.deletion?.tombstoneName !== profile.deletion.tombstoneName) return;
      current.state = 'error';
      current.lease = null;
      current.updatedAt = new Date(this.#now()).toISOString();
    });
  }

  async #recoverOrphanTombstones() {
    const entries = await readdir(this.#profilesRoot, { withFileTypes: true });
    for (const entry of entries) {
      const match = /^\.deleting-(profile_[a-f0-9]{32})-[a-f0-9-]{36}$/.exec(entry.name);
      if (!match) continue;
      const tombstonePath = resolve(this.#profilesRoot, entry.name);
      const tombstoneStats = await this.#pathStats(tombstonePath);
      if (!tombstoneStats) continue;
      if (!tombstoneStats.isDirectory() || tombstoneStats.isSymbolicLink()) {
        throw new ProfileStoreError(
          'PROFILE_DELETE_RECOVERY_FAILED',
          `Profile deletion tombstone ${entry.name} is not a regular directory`,
          500
        );
      }
      const data = await this.#store.read();
      const profile = data.profiles.find((item) => item.id === match[1]);
      if (profile?.deletion?.tombstoneName === entry.name) continue;
      const expectedPath = resolve(this.#profilesRoot, match[1]);
      const expectedExists = Boolean(await this.#pathStats(expectedPath));
      if (profile && !expectedExists) {
        await this.#renamePath(tombstonePath, expectedPath);
        await this.#store.update((currentData) => {
          const current = currentData.profiles.find((item) => item.id === profile.id);
          if (!current || current.deletion) return;
          current.state = 'idle';
          current.lease = null;
          current.updatedAt = new Date(this.#now()).toISOString();
        });
        continue;
      }
      try {
        await this.#removePath(tombstonePath, { recursive: true, force: true });
      } catch (error) {
        throw new ProfileStoreError(
          'PROFILE_DELETE_RECOVERY_FAILED',
          `Orphan Profile tombstone ${entry.name} could not be removed: ${error?.message || 'filesystem error'}`,
          500
        );
      }
      if (await this.#pathStats(tombstonePath)) {
        throw new ProfileStoreError(
          'PROFILE_DELETE_RECOVERY_FAILED',
          `Orphan Profile tombstone ${entry.name} still exists after cleanup`,
          500
        );
      }
    }
  }

  async acquireLease(profileId, ownerId, options = {}) {
    if (typeof ownerId !== 'string' || !ownerId.trim()) {
      throw new ProfileStoreError('INVALID_LEASE_OWNER', 'Lease ownerId is required');
    }
    const pid = options.pid ?? process.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new ProfileStoreError('INVALID_LEASE_PID', 'Lease pid must be a positive integer');
    }
    const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000) {
      throw new ProfileStoreError('INVALID_LEASE_TTL', 'Lease ttlMs must be at least 1000');
    }
    if (options.cleanupRequired !== undefined && typeof options.cleanupRequired !== 'boolean') {
      throw new ProfileStoreError('INVALID_LEASE_CLEANUP', 'Lease cleanupRequired must be a boolean');
    }
    const authorizedClientId = options.authorizedClientId === undefined
      ? null
      : ensureOwnerClientId(options.authorizedClientId);

    const existing = await this.get(profileId);
    requireLeaseAccess(existing, authorizedClientId);
    if (existing.state === 'deleting' || existing.deletion) {
      throw new ProfileStoreError('PROFILE_IN_USE', `Profile ${profileId} is being deleted`, 409);
    }
    if (existing.state === 'error') {
      throw new ProfileStoreError(
        'PROFILE_CLEANUP_UNCONFIRMED',
        `Profile ${profileId} is blocked because browser cleanup was not confirmed`,
        409
      );
    }
    if (existing.lease && existing.lease.ownerId !== ownerId) {
      const expired = Date.parse(existing.lease.expiresAt) <= this.#now();
      const alive = await this.#processAlive(existing.lease.pid);
      if (!expired || alive || existing.lease.cleanupRequired === true) {
        throw new ProfileStoreError(
          existing.lease.cleanupRequired === true && expired && !alive
            ? 'PROFILE_CLEANUP_UNCONFIRMED'
            : 'PROFILE_LEASED',
          existing.lease.cleanupRequired === true && expired && !alive
            ? `Profile ${profileId} cleanup is not confirmed`
            : `Profile ${profileId} is leased by ${existing.lease.ownerId}`,
          409
        );
      }
    }

    let leased;
    await this.#store.update((data) => {
      const profile = findProfile(data, profileId);
      requireLeaseAccess(profile, authorizedClientId);
      if (!isDeepStrictEqual(profile.lease, existing.lease)) {
        throw new ProfileStoreError(
          'PROFILE_LEASED',
          `Profile ${profileId} lease changed concurrently`,
          409
        );
      }
      const nowMs = this.#now();
      profile.lease = {
        ownerId,
        pid,
        acquiredAt: profile.lease?.ownerId === ownerId
          ? profile.lease.acquiredAt
          : new Date(nowMs).toISOString(),
        heartbeatAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString(),
        cleanupRequired: options.cleanupRequired === true || profile.lease?.cleanupRequired === true
      };
      profile.state = ownerId.startsWith('profile-open:') ? 'open' : 'leased';
      profile.updatedAt = new Date(nowMs).toISOString();
      profile.lastUsedAt = new Date(nowMs).toISOString();
      leased = profile;
    });
    return structuredClone(leased);
  }

  async releaseLease(profileId, ownerId, options = {}) {
    if (options.cleanupConfirmed !== undefined && typeof options.cleanupConfirmed !== 'boolean') {
      throw new ProfileStoreError('INVALID_CLEANUP_PROOF', 'cleanupConfirmed must be a boolean');
    }
    let released = false;
    await this.#store.update((data) => {
      const profile = findProfile(data, profileId);
      if (!profile.lease) return;
      if (profile.lease.ownerId !== ownerId) {
        throw new ProfileStoreError(
          'LEASE_OWNER_MISMATCH',
          `Profile ${profileId} is leased by another owner`,
          409
        );
      }
      if (profile.lease.cleanupRequired === true && options.cleanupConfirmed !== true) {
        throw new ProfileStoreError(
          'CLEANUP_PROOF_REQUIRED',
          `Profile ${profileId} requires confirmed browser cleanup before lease release`,
          409
        );
      }
      profile.state = 'idle';
      profile.lease = null;
      delete profile.cleanupUnknownAt;
      profile.updatedAt = new Date(this.#now()).toISOString();
      released = true;
    });
    return released;
  }

  async markCleanupUnknown(profileId, ownerId) {
    let marked = false;
    await this.#store.update((data) => {
      const profile = findProfile(data, profileId);
      if (!profile.lease || profile.lease.ownerId !== ownerId) return;
      profile.state = 'error';
      profile.lease.cleanupRequired = true;
      profile.cleanupUnknownAt = new Date(this.#now()).toISOString();
      profile.updatedAt = profile.cleanupUnknownAt;
      marked = true;
    });
    return marked;
  }

  async recoverExpiredLeases() {
    const snapshot = await this.#store.read();
    const recoverable = [];
    for (const profile of snapshot.profiles) {
      if (!profile.lease || Date.parse(profile.lease.expiresAt) > this.#now()) continue;
      if (profile.lease.cleanupRequired === true) continue;
      if (!(await this.#processAlive(profile.lease.pid))) {
        recoverable.push({
          id: profile.id,
          ownerId: profile.lease.ownerId,
          pid: profile.lease.pid,
          expiresAt: profile.lease.expiresAt
        });
      }
    }
    if (!recoverable.length) return [];

    await this.#store.update((data) => {
      for (const profile of data.profiles) {
        const expected = recoverable.find((item) => item.id === profile.id);
        if (!expected || !profile.lease) continue;
        if (
          profile.lease.ownerId !== expected.ownerId ||
          profile.lease.pid !== expected.pid ||
          profile.lease.expiresAt !== expected.expiresAt
        ) continue;
        profile.state = 'idle';
        profile.lease = null;
        delete profile.cleanupUnknownAt;
        profile.updatedAt = new Date(this.#now()).toISOString();
      }
    });
    return recoverable.map((item) => item.id);
  }
}
