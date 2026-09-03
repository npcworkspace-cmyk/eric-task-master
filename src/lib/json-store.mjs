import { mkdir, open, readFile, rename, rm, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const TRANSIENT_REPLACE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function replaceFileWithRetry(source, destination, {
  replace = rename,
  delay = wait,
  attempts = 8,
  baseDelayMs = 8
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

export class JsonStore {
  #filePath;
  #defaults;
  #value;
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

  async init() {
    return this.#enqueue(async () => {
      if (this.#initialized) return;
      await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
      try {
        const source = await readFile(this.#filePath, 'utf8');
        this.#value = JSON.parse(source);
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
    return this.#enqueue(async () => clone(this.#value));
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
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await replaceFileWithRetry(temporaryPath, this.#filePath);
      await chmod(this.#filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }
}
