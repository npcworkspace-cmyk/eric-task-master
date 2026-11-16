import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revision = (value) => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
const invalid = (message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code: 'OPERATIONS_EVIDENCE_INVALID', statusCode: 409 });

export function validateReplyReference(reference, maxBytes = 8 * 1024 * 1024) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference) ||
      Object.keys(reference).sort().join(',') !== 'bytes,sha256,version' || reference.version !== 1 ||
      typeof reference.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(reference.sha256) ||
      !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > maxBytes) {
    throw invalid('Command reply evidence reference is invalid');
  }
  return reference;
}

// Immutable canonical payloads, not an authorization cache. A reference is
// committed only after the file has been created, synchronized and closed.
export class OperationsEvidenceStore {
  constructor(directory, { maxBytes = 8 * 1024 * 1024, fault = async () => {} } = {}) {
    this.directory = directory; this.maxBytes = maxBytes; this.fault = fault;
  }
  async init() { await mkdir(this.directory, { recursive: true, mode: 0o700 }); return this; }
  filePath(reference) { validateReplyReference(reference, this.maxBytes); return path.join(this.directory, `${reference.sha256}.json`); }
  prepare(value) {
    const canonical = JSON.stringify(value);
    if (typeof canonical !== 'string') throw invalid('Command reply evidence must be JSON');
    const bytes = Buffer.from(canonical);
    if (bytes.length > this.maxBytes) throw Object.assign(new Error('Command reply exceeds the logical operation storage limit'), { code: 'OPERATIONS_STORAGE_LIMIT', statusCode: 409 });
    const reference = { version: 1, sha256: digest(bytes), bytes: bytes.length };
    validateReplyReference(reference, this.maxBytes);
    return { reference, bytes };
  }
  async read(reference) {
    const file = this.filePath(reference);
    try {
      const before = await lstat(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.size !== BigInt(reference.bytes)) throw invalid('Command reply evidence length or file type is invalid');
      const bytes = await readFile(file), after = await lstat(file, { bigint: true });
      if (revision(before) !== revision(after) || bytes.length !== reference.bytes || digest(bytes) !== reference.sha256) throw invalid('Command reply evidence changed or failed its content hash');
      return JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error.code === 'OPERATIONS_EVIDENCE_INVALID') throw error;
      throw invalid('Command reply evidence is missing or unreadable', error);
    }
  }
  async put(prepared) {
    const { reference, bytes } = prepared;
    validateReplyReference(reference, this.maxBytes);
    if (!Buffer.isBuffer(bytes) || bytes.length !== reference.bytes || digest(bytes) !== reference.sha256) throw invalid('Prepared command reply evidence does not match its reference');
    await this.init();
    const destination = this.filePath(reference), temporary = path.join(this.directory, `.${reference.sha256}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes); await this.fault('beforeEvidenceSync'); await handle.sync();
      await this.fault('beforeEvidenceClose'); await handle.close(); handle = null;
      await this.fault('beforeEvidenceLink');
      try { await link(temporary, destination); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      // Existing content-addressed files are never overwritten or trusted by
      // their filename alone. Reopen and sync the final name before any WAL ref.
      await this.read(reference);
      handle = await open(destination, 'r+'); await handle.sync(); await handle.close(); handle = null;
      await this.fault('afterEvidenceCommit');
      return reference;
    } finally {
      await handle?.close();
      // Only this attempt's private temporary file is removed. Immutable files,
      // including unreferenced crash leftovers, are never automatically pruned.
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
