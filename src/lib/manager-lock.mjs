import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

const INCOMPLETE_LOCK_GRACE_MS = 5_000;
const MAX_ACQUIRE_ATTEMPTS = 8;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') return true;
    if (error?.code === 'ESRCH') return false;
    return false;
  }
}

export class ManagerLockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ManagerLockError';
    this.code = code;
    this.statusCode = 409;
  }
}

export class ManagerLock {
  #filePath;
  #recoveryPath;
  #recoveryHook;
  #nonce = null;

  constructor(filePath, { recoveryHook = null } = {}) {
    if (recoveryHook !== null && typeof recoveryHook !== 'function') {
      throw new TypeError('recoveryHook must be a function when provided');
    }
    this.#filePath = filePath;
    this.#recoveryPath = `${filePath}.recovery`;
    this.#recoveryHook = recoveryHook;
  }

  async acquire() {
    if (this.#nonce) return;
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
      await this.#assertNoRecoveryInProgress();
      const nonce = randomUUID();
      let handle;
      try {
        handle = await open(this.#filePath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          nonce,
          createdAt: new Date().toISOString()
        })}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        this.#nonce = nonce;
        return;
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
      }

      const existing = await this.#inspect(this.#filePath);
      if (!existing.exists) continue;
      if (existing.owner && processAlive(existing.owner.pid)) {
        throw new ManagerLockError(
          'MANAGER_ALREADY_RUNNING',
          'Another Task Master Manager already owns this state directory'
        );
      }
      if (!existing.owner && Date.now() - existing.stats.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
        throw new ManagerLockError(
          'MANAGER_LOCK_BUSY',
          'Another Task Master Manager is acquiring this state directory'
        );
      }
      await this.#recoveryHook?.({ stage: 'before-recovery-guard' });
      await this.#quarantineStaleLock();
    }
    throw new ManagerLockError(
      'MANAGER_LOCK_BUSY',
      'Task Master could not acquire the Manager state lock'
    );
  }

  async release() {
    if (!this.#nonce) return;
    const ownedNonce = this.#nonce;
    const recoveryNonce = await this.#acquireRecoveryGuard();
    const quarantinePath = `${this.#filePath}.release-${recoveryNonce}`;
    try {
      const existing = await this.#inspect(this.#filePath);
      if (existing.owner?.pid === process.pid && existing.owner?.nonce === ownedNonce) {
        try {
          await rename(this.#filePath, quarantinePath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const moved = await this.#inspect(quarantinePath);
        if (moved.exists) {
          if (this.#sameSnapshot(existing, moved)) {
            await rm(quarantinePath, { force: true });
          } else {
            await this.#restoreMovedFile(this.#filePath, quarantinePath, moved.raw);
          }
        }
      }
    } finally {
      await this.#releaseRecoveryGuard(recoveryNonce);
      this.#nonce = null;
    }
  }

  async #inspect(filePath) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [raw, stats] = await Promise.all([readFile(filePath, 'utf8'), stat(filePath)]);
        let owner = null;
        try {
          owner = JSON.parse(raw);
        } catch {
          // A just-created lock may not have been flushed yet. Its age gate below
          // keeps it from being mistaken for an abandoned lock.
        }
        return { exists: true, raw, stats, owner };
      } catch (error) {
        if (error?.code === 'ENOENT') return { exists: false };
        if (attempt === 2) throw error;
        await delay(25);
      }
    }
    return { exists: false };
  }

  #sameSnapshot(before, after) {
    return before.exists && after.exists &&
      before.raw === after.raw &&
      before.stats.dev === after.stats.dev &&
      before.stats.ino === after.stats.ino &&
      before.stats.size === after.stats.size &&
      before.stats.mtimeMs === after.stats.mtimeMs;
  }

  async #assertNoRecoveryInProgress() {
    const recovery = await this.#inspect(this.#recoveryPath);
    if (!recovery.exists) return;
    if (recovery.owner && processAlive(recovery.owner.pid)) {
      throw new ManagerLockError(
        'MANAGER_LOCK_BUSY',
        'Another Task Master Manager is recovering this state directory'
      );
    }
    if (!recovery.owner && Date.now() - recovery.stats.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
      throw new ManagerLockError(
        'MANAGER_LOCK_BUSY',
        'Another Task Master Manager is establishing the recovery guard'
      );
    }
    await this.#quarantineAbandonedRecoveryGuard(recovery);
  }

  async #acquireRecoveryGuard() {
    const nonce = randomUUID();
    let handle;
    try {
      handle = await open(this.#recoveryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({
        pid: process.pid,
        nonce,
        createdAt: new Date().toISOString()
      })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      return nonce;
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code === 'EEXIST') {
        await this.#assertNoRecoveryInProgress();
        return this.#acquireRecoveryGuard();
      }
      throw error;
    }
  }

  async #releaseRecoveryGuard(nonce) {
    const guard = await this.#inspect(this.#recoveryPath);
    if (!guard.exists) return;
    if (guard.owner?.pid !== process.pid || guard.owner?.nonce !== nonce) {
      throw new ManagerLockError(
        'MANAGER_LOCK_RECOVERY_LOST',
        'Manager lock recovery ownership changed unexpectedly'
      );
    }
    await rm(this.#recoveryPath, { force: true });
  }

  async #restoreMovedFile(targetPath, quarantinePath, raw) {
    let handle;
    try {
      handle = await open(targetPath, 'wx', 0o600);
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await rm(quarantinePath, { force: true }).catch(() => {});
    }
  }

  async #quarantineAbandonedRecoveryGuard(candidate) {
    const quarantinePath = `${this.#recoveryPath}.abandoned-${randomUUID()}`;
    try {
      await rename(this.#recoveryPath, quarantinePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    const moved = await this.#inspect(quarantinePath);
    if (!this.#sameSnapshot(candidate, moved)) {
      if (moved.exists) {
        await this.#restoreMovedFile(this.#recoveryPath, quarantinePath, moved.raw);
      }
      throw new ManagerLockError(
        'MANAGER_LOCK_BUSY',
        'Manager recovery ownership changed while an abandoned guard was being repaired'
      );
    }
    await rm(quarantinePath, { force: true });
  }

  async #quarantineStaleLock() {
    const recoveryNonce = await this.#acquireRecoveryGuard();
    const quarantinePath = `${this.#filePath}.stale-${recoveryNonce}`;
    try {
      const candidate = await this.#inspect(this.#filePath);
      if (!candidate.exists) return;
      if (candidate.owner && processAlive(candidate.owner.pid)) {
        throw new ManagerLockError(
          'MANAGER_ALREADY_RUNNING',
          'Another Task Master Manager already owns this state directory'
        );
      }
      if (!candidate.owner && Date.now() - candidate.stats.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) {
        throw new ManagerLockError(
          'MANAGER_LOCK_BUSY',
          'Another Task Master Manager is acquiring this state directory'
        );
      }

      try {
        await rename(this.#filePath, quarantinePath);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      const moved = await this.#inspect(quarantinePath);
      if (!this.#sameSnapshot(candidate, moved)) {
        if (moved.exists) {
          await this.#restoreMovedFile(this.#filePath, quarantinePath, moved.raw);
        }
        throw new ManagerLockError(
          'MANAGER_LOCK_BUSY',
          'Manager lock changed while stale ownership was being recovered'
        );
      }
      await rm(quarantinePath, { force: true });
    } finally {
      await this.#releaseRecoveryGuard(recoveryNonce);
    }
  }
}
