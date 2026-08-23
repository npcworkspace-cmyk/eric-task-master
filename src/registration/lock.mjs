import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function identity(metadata) {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs].join(':');
}

function busy() {
  return Object.assign(new Error('Another Task Master registration transaction is still running'), {
    code: 'REGISTRATION_LOCK_TIMEOUT'
  });
}

function invalidLock(message, code = 'INVALID_REGISTRATION_LOCK') {
  return Object.assign(new Error(message), { code });
}

async function readLockFile(filePath) {
  const metadata = await lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!metadata) return null;
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw invalidLock(`Registration lock path is not a regular file: ${filePath}`);
  }
  const source = await readFile(filePath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (source === null) return null;
  const after = await lstat(filePath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!after || identity(after) !== identity(metadata)) return null;
  return { metadata: after, identity: identity(after), source };
}

async function writeOwnerFile(filePath, owner) {
  let handle;
  let created = false;
  try {
    handle = await open(filePath, 'wx', 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    return true;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (created) await rm(filePath, { force: true }).catch(() => {});
    if (error?.code === 'EEXIST' && !created) return false;
    throw error;
  }
}

export class RegistrationLock {
  #filePath;
  #recoveryPath;
  #timeoutMs;
  #removeFile;
  #nonce = null;

  constructor(filePath, { timeoutMs = DEFAULT_TIMEOUT_MS, removeFile = rm } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 5 * 60_000) {
      throw new TypeError('registration lock timeout must be from 0 to 300000 milliseconds');
    }
    this.#filePath = filePath;
    this.#recoveryPath = `${filePath}.recovery`;
    this.#timeoutMs = timeoutMs;
    this.#removeFile = removeFile;
  }

  async acquire() {
    if (this.#nonce) return;
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.#timeoutMs;
    while (true) {
      if (await this.#recoveryInProgress()) {
        if (Date.now() >= deadline) throw busy();
        await delay(POLL_MS);
        continue;
      }

      const nonce = randomUUID();
      const owner = { pid: process.pid, nonce, createdAt: new Date().toISOString() };
      if (await writeOwnerFile(this.#filePath, owner)) {
        this.#nonce = nonce;
        return;
      }

      await this.#recoverStaleLock();
      if (Date.now() >= deadline) throw busy();
      await delay(POLL_MS);
    }
  }

  async #recoveryInProgress() {
    const recovery = await readLockFile(this.#recoveryPath);
    if (!recovery) return false;
    let owner;
    try {
      owner = JSON.parse(recovery.source);
    } catch {
      throw invalidLock(
        `Registration recovery guard is unreadable; inspect and remove it manually: ${this.#recoveryPath}`,
        'REGISTRATION_RECOVERY_GUARD_STALE'
      );
    }
    if (!processAlive(owner.pid)) {
      throw invalidLock(
        `Registration recovery guard owner is gone; inspect and remove it manually: ${this.#recoveryPath}`,
        'REGISTRATION_RECOVERY_GUARD_STALE'
      );
    }
    return true;
  }

  async #recoverStaleLock() {
    const recoveryNonce = randomUUID();
    const recoveryOwner = {
      pid: process.pid,
      nonce: recoveryNonce,
      createdAt: new Date().toISOString()
    };
    if (!await writeOwnerFile(this.#recoveryPath, recoveryOwner)) return false;
    try {
      const candidate = await readLockFile(this.#filePath);
      if (!candidate) return true;
      let owner = null;
      try {
        owner = JSON.parse(candidate.source);
      } catch {
        if (Date.now() - candidate.metadata.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return false;
      }
      if (owner && processAlive(owner.pid)) return false;

      const current = await readLockFile(this.#filePath);
      if (!current || current.identity !== candidate.identity || current.source !== candidate.source) return false;
      await this.#removeFile(this.#filePath);
      return true;
    } finally {
      await this.#releaseOwnedFile(this.#recoveryPath, recoveryNonce, 'REGISTRATION_RECOVERY_GUARD_RELEASE_FAILED');
    }
  }

  async #releaseOwnedFile(filePath, nonce, failureCode) {
    try {
      const current = await readLockFile(filePath);
      if (!current) {
        throw invalidLock(`Owned registration lock disappeared before release: ${filePath}`, failureCode);
      }
      const owner = JSON.parse(current.source);
      if (owner.pid !== process.pid || owner.nonce !== nonce) {
        throw invalidLock(`Registration lock ownership changed before release: ${filePath}`, failureCode);
      }
      const latest = await readLockFile(filePath);
      if (!latest || latest.identity !== current.identity || latest.source !== current.source) {
        throw invalidLock(`Registration lock changed while it was being released: ${filePath}`, failureCode);
      }
      await this.#removeFile(filePath);
    } catch (error) {
      if (error?.code === failureCode) throw error;
      throw Object.assign(new Error(`Could not release registration lock ${filePath}: ${error.message}`), {
        code: failureCode,
        cause: error
      });
    }
  }

  async release() {
    if (!this.#nonce) return;
    await this.#releaseOwnedFile(this.#filePath, this.#nonce, 'REGISTRATION_LOCK_RELEASE_FAILED');
    this.#nonce = null;
  }
}
