import { mkdir, open, readFile, rename, rm, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const TRANSIENT_REPLACE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function replaceFileWithRetry(source, destination, {
  replace = rename,
  delay = wait,
  // Antivirus and indexers can briefly retain a Windows sharing lock. Keep
  // replacement atomic and wait at most about 4.1 seconds before surfacing it.
  attempts = 20,
  baseDelayMs = 25
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await replace(source, destination);
      return;
    } catch (error) {
      if (!TRANSIENT_REPLACE_CODES.has(error?.code) || attempt === attempts) throw error;
      await delay(Math.min(250, baseDelayMs * (2 ** (attempt - 1))));
    }
  }
}

function clone(value) {
  return structuredClone(value);
}

function revision(stats) {
  return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(':');
}

async function readStableFile(filePath) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await stat(filePath, { bigint: true });
    const source = await readFile(filePath, 'utf8');
    const after = await stat(filePath, { bigint: true });
    if (revision(before) === revision(after)) return { source, revision: revision(after) };
  }
  throw new JsonStoreConflictError(filePath);
}

export class JsonStoreConflictError extends Error {
  constructor(filePath) {
    super('JSON store changed outside the running Manager');
    this.name = 'JsonStoreConflictError';
    this.code = 'STATE_STORE_EXTERNALLY_MODIFIED';
    this.statusCode = 409;
    this.nextAction = 'Restart the Manager so it reloads the current on-disk state.';
    this.filePath = filePath;
  }
}

export class JsonStore {
  #filePath;
  #defaults;
  #value;
  #revision = null;
  #conflict = null;
  #initialized = false;
  #tail = Promise.resolve();

  constructor(filePath, defaults) {
    if (!filePath) throw new TypeError('filePath is required');
    this.#filePath = filePath;
    this.#defaults = typeof defaults === 'function' ? defaults : () => clone(defaults);
  }

  get filePath() {
    return this.#filePath;
  }

  fence() {
    this.#conflict ||= new JsonStoreConflictError(this.#filePath);
  }

  async init() {
    return this.#enqueue(async () => {
      if (this.#initialized) return;
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      try {
        const snapshot = await readStableFile(this.#filePath);
        this.#value = JSON.parse(snapshot.source);
        this.#revision = snapshot.revision;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new Error(`Could not read JSON store ${this.#filePath}: ${error.message}`, {
            cause: error
          });
        }
        this.#value = clone(this.#defaults());
        await this.#write(this.#value);
      }
      this.#initialized = true;
    });
  }

  async read() {
    await this.init();
    return this.#enqueue(async () => {
      await this.#assertUnchanged();
      return clone(this.#value);
    });
  }

  async assertUnchanged() {
    await this.init();
    return this.#enqueue(async () => {
      await this.#assertUnchanged();
      return true;
    });
  }

  async replace(value) {
    await this.init();
    return this.#enqueue(async () => {
      const next = clone(value);
      await this.#write(next);
      this.#value = next;
      return clone(next);
    });
  }

  async update(updater) {
    if (typeof updater !== 'function') throw new TypeError('updater must be a function');
    await this.init();
    return this.#enqueue(async () => {
      await this.#assertUnchanged();
      const draft = clone(this.#value);
      const returned = await updater(draft);
      const next = returned === undefined ? draft : returned;
      await this.#write(next);
      this.#value = clone(next);
      return clone(next);
    });
  }

  #enqueue(operation) {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  async #write(value) {
    const temporaryPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    const source = `${JSON.stringify(value, null, 2)}\n`;
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(source, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporaryPath, 0o600);
      const staged = await stat(temporaryPath, { bigint: true });
      await replaceFileWithRetry(temporaryPath, this.#filePath, {
        replace: async (sourcePath, destinationPath) => {
          // Windows sharing retries may span seconds; recheck every attempt.
          await this.#assertUnchanged();
          await rename(sourcePath, destinationPath);
        }
      });
      const committed = await stat(this.#filePath, { bigint: true });
      if (staged.dev !== committed.dev || staged.ino !== committed.ino ||
          staged.size !== committed.size || staged.mtimeNs !== committed.mtimeNs) {
        this.#conflict = new JsonStoreConflictError(this.#filePath);
        throw this.#conflict;
      }
      this.#revision = revision(committed);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async #assertUnchanged() {
    if (this.#conflict) throw this.#conflict;
    let currentRevision = null;
    try {
      currentRevision = revision(await stat(this.#filePath, { bigint: true }));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (currentRevision !== this.#revision) {
      this.#conflict = new JsonStoreConflictError(this.#filePath);
      throw this.#conflict;
    }
  }
}
