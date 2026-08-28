import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { redactPublicText } from './redaction.mjs';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const ALLOWED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_REQUEST_ID = /^req_[0-9a-f]{24}$/u;
const MAX_LINE_SLOP = 4 * 1024;

function boundedText(value, maxLength) {
  return redactPublicText(String(value ?? '')).slice(0, maxLength);
}

function normalizedPathname(value) {
  const source = String(value ?? '').split(/[?#]/u, 1)[0];
  return source.startsWith('/') && /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(source)
    ? source.slice(0, 512)
    : '/';
}

function normalizeEvent(value, now) {
  const entry = {
    at: new Date(now()).toISOString(),
    level: ALLOWED_LEVELS.has(value?.level) ? value.level : 'info',
    component: 'manager',
    event: boundedText(value?.event || 'event', 80)
  };
  if (SAFE_REQUEST_ID.test(value?.requestId ?? '')) entry.requestId = value.requestId;
  if (/^(?:GET|POST|PATCH|DELETE|OPTIONS|HEAD)$/u.test(value?.method ?? '')) entry.method = value.method;
  if (value?.pathname !== undefined) entry.pathname = normalizedPathname(value.pathname);
  if (Number.isInteger(value?.statusCode) && value.statusCode >= 100 && value.statusCode <= 599) {
    entry.statusCode = value.statusCode;
  }
  if (SAFE_CODE.test(value?.code ?? '')) entry.code = value.code;
  if (Number.isFinite(value?.durationMs) && value.durationMs >= 0) {
    entry.durationMs = Math.min(86_400_000, Math.round(value.durationMs));
  }
  if (value?.message !== undefined) entry.message = boundedText(value.message, 512);
  if (value?.version !== undefined) entry.version = boundedText(value.version, 32);
  if (Number.isInteger(value?.pid) && value.pid > 0) entry.pid = value.pid;
  if (Number.isInteger(value?.port) && value.port >= 0 && value.port <= 65_535) entry.port = value.port;
  if (value?.state !== undefined) entry.state = boundedText(value.state, 40);
  return entry;
}

function sameFile(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function validateLogStats(details, maxBytes) {
  const links = typeof details.nlink === 'bigint' ? Number(details.nlink) : details.nlink;
  const size = typeof details.size === 'bigint' ? Number(details.size) : details.size;
  if (!details.isFile() || details.isSymbolicLink?.() || links !== 1) {
    throw new Error('Operational journal must be a private regular file');
  }
  if (!Number.isSafeInteger(size) || size > maxBytes + MAX_LINE_SLOP) {
    throw new Error('Operational journal exceeded its bounded size');
  }
}

export class OperationalJournal {
  #directory;
  #filePath;
  #maxBytes;
  #maxFiles;
  #now;
  #ready;
  #queue = Promise.resolve();

  constructor({ stateDir, maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES, now = Date.now } = {}) {
    if (typeof stateDir !== 'string' || !stateDir) throw new TypeError('stateDir is required');
    if (!Number.isInteger(maxBytes) || maxBytes < 256) throw new TypeError('maxBytes must be at least 256');
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10) {
      throw new TypeError('maxFiles must be an integer from 1 to 10');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.#directory = join(resolve(stateDir), 'logs');
    this.#filePath = join(this.#directory, 'manager-events.jsonl');
    this.#maxBytes = maxBytes;
    this.#maxFiles = maxFiles;
    this.#now = now;
    this.#ready = mkdir(this.#directory, { recursive: true, mode: 0o700 })
      .then(async () => {
        const details = await lstat(this.#directory);
        if (!details.isDirectory() || details.isSymbolicLink()) {
          throw new Error('Operational journal directory must be a private directory');
        }
        await chmod(this.#directory, 0o700).catch(() => {});
      });
  }

  async append(value) {
    const line = `${JSON.stringify(normalizeEvent(value, this.#now))}\n`;
    const operation = this.#queue.then(async () => {
      await this.#ready;
      const current = await this.#stats(this.#filePath);
      const currentSize = current ? Number(current.size) : 0;
      if (current && currentSize > 0 && currentSize + Buffer.byteLength(line) > this.#maxBytes) {
        await this.#rotate();
      }
      const handle = await this.#openForAppend();
      try {
        await handle.writeFile(line, 'utf8');
        await handle.chmod(0o600).catch(() => {});
      } finally {
        await handle.close().catch(() => {});
      }
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #stats(filePath) {
    const details = await lstat(filePath, { bigint: true }).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (details) validateLogStats(details, this.#maxBytes);
    return details;
  }

  async #openForAppend() {
    let before = await this.#stats(this.#filePath);
    let handle;
    try {
      handle = await open(this.#filePath, before ? 'a' : 'ax', 0o600);
    } catch (error) {
      if (before || error?.code !== 'EEXIST') throw error;
      before = await this.#stats(this.#filePath);
      if (!before) throw error;
      handle = await open(this.#filePath, 'a', 0o600);
    }
    try {
      const opened = await handle.stat({ bigint: true });
      validateLogStats(opened, this.#maxBytes);
      if (before && !sameFile(before, opened)) throw new Error('Operational journal changed while opening');
      const current = await this.#stats(this.#filePath);
      if (!current || !sameFile(opened, current)) throw new Error('Operational journal path changed while opening');
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  async #rotate() {
    if (this.#maxFiles === 1) {
      await rm(this.#filePath, { force: true });
      return;
    }
    for (let index = this.#maxFiles - 1; index >= 1; index -= 1) {
      const destination = join(this.#directory, `manager-events.${index}.jsonl`);
      const source = index === 1
        ? this.#filePath
        : join(this.#directory, `manager-events.${index - 1}.jsonl`);
      await rm(destination, { force: true });
      await rename(source, destination).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }

  async readRecent({ limit = 50, level, code } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new TypeError('limit must be an integer from 1 to 500');
    }
    await this.#queue;
    await this.#ready;
    const paths = [];
    for (let index = this.#maxFiles - 1; index >= 1; index -= 1) {
      paths.push(join(this.#directory, `manager-events.${index}.jsonl`));
    }
    paths.push(this.#filePath);
    const entries = [];
    for (const filePath of paths) {
      const source = await this.#readSafe(filePath);
      for (const line of source.split(/\r?\n/u)) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line);
          const timestamp = Date.parse(entry?.at);
          if (!Number.isFinite(timestamp)) continue;
          const normalized = normalizeEvent(entry, () => timestamp);
          if (level && normalized.level !== level) continue;
          if (code && normalized.code !== code) continue;
          entries.push(normalized);
        } catch {
          // Ignore one damaged diagnostic line; operational logs must not block recovery.
        }
      }
    }
    return entries.slice(-limit);
  }

  async #readSafe(filePath) {
    const before = await this.#stats(filePath);
    if (!before) return '';
    const handle = await open(filePath, 'r');
    try {
      const opened = await handle.stat({ bigint: true });
      validateLogStats(opened, this.#maxBytes);
      const current = await this.#stats(filePath);
      if (!sameFile(before, opened) || !current || !sameFile(opened, current)) {
        throw new Error('Operational journal changed while reading');
      }
      return await handle.readFile('utf8');
    } finally {
      await handle.close().catch(() => {});
    }
  }

  get relativePath() {
    return 'logs/manager-events.jsonl';
  }
}

export const OPERATIONAL_JOURNAL_DEFAULTS = Object.freeze({
  maxBytes: DEFAULT_MAX_BYTES,
  maxFiles: DEFAULT_MAX_FILES
});
