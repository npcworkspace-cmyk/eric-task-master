import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isBehaviorMode } from '../contracts.mjs';
import { JsonStore } from './json-store.mjs';

const DEFAULT_LEASE_TTL_MS = 60_000;

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

function ensureBrowserChannel(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,40}$/.test(value)) {
    throw new ProfileStoreError(
      'INVALID_BROWSER_CHANNEL',
      'browserChannel must be a simple browser channel name'
    );
  }
  return value;
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

  constructor({ filePath, profilesRoot, now = () => Date.now(), processAlive = isProcessAlive }) {
    if (!profilesRoot) throw new TypeError('profilesRoot is required');
    this.#store = new JsonStore(filePath, { version: 1, profiles: [] });
    this.#profilesRoot = profilesRoot;
    this.#now = now;
    this.#processAlive = processAlive;
  }

  async init() {
    await mkdir(this.#profilesRoot, { recursive: true, mode: 0o700 });
    await this.#store.init();
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

  async create(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ProfileStoreError('INVALID_PROFILE', 'Profile input must be an object');
    }
    const allowed = new Set(['name', 'defaultBehavior', 'headless', 'browserChannel']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new ProfileStoreError(
        'INVALID_PROFILE_CREATE',
        `Unsupported profile fields: ${unknown.join(', ')}`
      );
    }
    const {
      name,
      defaultBehavior = 'fast',
      headless = false,
      browserChannel: requestedBrowserChannel = null
    } = input;
    const normalizedName = normalizeName(name);
    ensureBehaviorMode(defaultBehavior);
    ensureHeadless(headless);
    const browserChannel = ensureBrowserChannel(requestedBrowserChannel);
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
          userDataDir,
          defaultBehavior,
          headless,
          browserChannel,
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
    const allowed = new Set(['name', 'defaultBehavior', 'headless', 'browserChannel']);
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
    if ('browserChannel' in patch) {
      patch = { ...patch, browserChannel: ensureBrowserChannel(patch.browserChannel) };
    }
    let updated;
    await this.#store.update((data) => {
      const profile = findProfile(data, profileId);
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
    let removed;
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
    let moved = false;
    try {
      await rename(expectedPath, tombstonePath);
      moved = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await this.#store.update((data) => {
      const index = data.profiles.findIndex((item) => item.id === profileId);
      if (index === -1) {
        throw new ProfileStoreError('PROFILE_NOT_FOUND', `Profile ${profileId} was not found`, 404);
      }
      const profile = data.profiles[index];
      if (profile.lease || profile.state !== 'idle') {
        throw new ProfileStoreError(
          'PROFILE_IN_USE',
          `Profile ${profileId} must be idle before it can be removed`,
          409
        );
      }
      [removed] = data.profiles.splice(index, 1);
    }).catch(async (error) => {
      if (moved) await rename(tombstonePath, expectedPath).catch(() => {});
      throw error;
    });
    if (moved) await rm(tombstonePath, { recursive: true, force: true });
    return structuredClone(removed);
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

    const existing = await this.get(profileId);
    if (existing.lease && existing.lease.ownerId !== ownerId) {
      const expired = Date.parse(existing.lease.expiresAt) <= this.#now();
      const alive = await this.#processAlive(existing.lease.pid);
      if (!expired || alive) {
        throw new ProfileStoreError(
          'PROFILE_LEASED',
          `Profile ${profileId} is leased by ${existing.lease.ownerId}`,
          409
        );
      }
    }

    let leased;
    await this.#store.update((data) => {
      const profile = findProfile(data, profileId);
      if (profile.lease && profile.lease.ownerId !== ownerId) {
        // A competing acquisition may have won after the liveness check.
        if (profile.lease.ownerId !== existing.lease?.ownerId) {
          throw new ProfileStoreError(
            'PROFILE_LEASED',
            `Profile ${profileId} was leased concurrently`,
            409
          );
        }
      }
      const nowMs = this.#now();
      profile.lease = {
        ownerId,
        pid,
        acquiredAt: profile.lease?.ownerId === ownerId
          ? profile.lease.acquiredAt
          : new Date(nowMs).toISOString(),
        heartbeatAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + ttlMs).toISOString()
      };
      profile.state = ownerId.startsWith('profile-open:') ? 'open' : 'leased';
      profile.updatedAt = new Date(nowMs).toISOString();
      profile.lastUsedAt = new Date(nowMs).toISOString();
      leased = profile;
    });
    return structuredClone(leased);
  }

  async releaseLease(profileId, ownerId) {
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
      profile.state = 'idle';
      profile.lease = null;
      profile.updatedAt = new Date(this.#now()).toISOString();
      released = true;
    });
    return released;
  }

  async recoverExpiredLeases() {
    const snapshot = await this.#store.read();
    const recoverable = [];
    for (const profile of snapshot.profiles) {
      if (!profile.lease || Date.parse(profile.lease.expiresAt) > this.#now()) continue;
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
        profile.updatedAt = new Date(this.#now()).toISOString();
      }
    });
    return recoverable.map((item) => item.id);
  }
}
