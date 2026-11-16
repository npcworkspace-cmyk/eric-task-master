import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { JsonStore, JsonStoreConflictError, replaceFileWithRetry } from './json-store.mjs';
import { validateReplyReference } from './operations-evidence-store.mjs';

const FORMAT = 'eric-task-master-operations-v3';
const PREVIOUS_FORMAT = 'eric-task-master-operations-v2';
const COLLECTIONS = ['operations', 'actions', 'commands', 'events', 'records'];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revision = (value) => value ? [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':') : null;
const clone = (value) => structuredClone(value);
const signed = (body) => ({ ...body, checksum: hash(body) });
const invalid = (message) => Object.assign(new Error(message), { code: 'OPERATIONS_JOURNAL_INVALID', statusCode: 409 });
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const keyAllowed = (key) => typeof key === 'string' && !['__proto__', 'prototype', 'constructor'].includes(key);
async function fileStat(file) { try { return await stat(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

const preparedValues = new WeakMap(), immutableValues = new WeakSet();
function makeImmutable(value, visiting = new WeakSet()) {
  if (!value || typeof value !== 'object' || immutableValues.has(value)) return;
  if (visiting.has(value)) throw new TypeError('Operation transaction must not contain cycles');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && prototype !== Array.prototype) throw new TypeError('Operation transaction must contain plain data');
  visiting.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value === 'function') throw new TypeError('Operation transaction must not contain accessors or functions');
    makeImmutable(descriptor.value, visiting);
  }
  visiting.delete(value); Object.freeze(value); immutableValues.add(value);
}
// The proof is registered privately against an immutable value identity. A
// caller cannot supply stale canonical text/byte counts to bypass validation.
export function prepareOperationsJournalValue(value) {
  const known = preparedValues.get(value);
  if (known) return known;
  makeImmutable(value);
  const serialized = JSON.stringify(value), proof = Object.freeze({ serialized, bytes: Buffer.byteLength(serialized) });
  preparedValues.set(value, proof); return proof;
}

function validateValue(value, maxBytes) {
  if (!value || typeof value !== 'object' || value.version !== 1 || !COLLECTIONS.every((name) => Array.isArray(value[name]) && value[name].length <= 10001)) throw invalid('Operation state has an unsupported schema');
  const hotBytes = preparedValues.get(value)?.bytes ?? Buffer.byteLength(JSON.stringify(value));
  let logicalBytes = hotBytes;
  for (const command of value.commands) if (Object.hasOwn(command, 'replyRef')) {
    if (!['confirmed', 'failed', 'stopped'].includes(command.status) || Object.hasOwn(command, 'reply')) throw invalid('Cold evidence belongs only to terminal command replies');
    const reference = validateReplyReference(command.replyRef, maxBytes);
    logicalBytes += reference.bytes - Buffer.byteLength(JSON.stringify(reference)) - 3; // replyRef -> reply key length
  }
  if (Math.max(hotBytes, logicalBytes) > maxBytes) throw Object.assign(new Error('Operation state exceeds its materialized byte limit'), { code: 'OPERATIONS_STORAGE_LIMIT', statusCode: 409 });
}
function diff(previous, next) {
  const patch = { fields: [], unset: [], collections: {} };
  for (const key of Object.keys(previous)) if (!COLLECTIONS.includes(key) && !Object.hasOwn(next, key)) patch.unset.push(key);
  for (const [key, value] of Object.entries(next)) if (!COLLECTIONS.includes(key) && JSON.stringify(value) !== JSON.stringify(previous[key])) patch.fields.push([key, value]);
  for (const name of COLLECTIONS) {
    const set = [];
    for (let index = 0; index < next[name].length; index++) if (next[name][index] !== previous[name][index] && JSON.stringify(next[name][index]) !== JSON.stringify(previous[name][index])) set.push([index, next[name][index]]);
    if (set.length || previous[name].length !== next[name].length) patch.collections[name] = { length: next[name].length, set };
  }
  return patch;
}
function apply(value, patch) {
  if (!patch || !Array.isArray(patch.fields) || !Array.isArray(patch.unset) || !patch.collections || typeof patch.collections !== 'object' || Object.keys(patch).some((key) => !['fields', 'unset', 'collections'].includes(key))) throw invalid('Journal patch is malformed');
  for (const key of patch.unset) { if (!keyAllowed(key) || COLLECTIONS.includes(key)) throw invalid('Journal field deletion is invalid'); delete value[key]; }
  for (const entry of patch.fields) {
    if (!Array.isArray(entry) || entry.length !== 2 || !keyAllowed(entry[0]) || COLLECTIONS.includes(entry[0])) throw invalid('Journal field assignment is invalid');
    Object.defineProperty(value, entry[0], { value: entry[1], enumerable: true, configurable: true, writable: true });
  }
  for (const [name, change] of Object.entries(patch.collections)) {
    if (!COLLECTIONS.includes(name) || !change || !integer(change.length) || change.length > 10001 || !Array.isArray(change.set) || Object.keys(change).some((key) => !['length', 'set'].includes(key))) throw invalid('Journal record patch is invalid');
    const seen = new Set();
    for (const entry of change.set) {
      if (!Array.isArray(entry) || entry.length !== 2 || !integer(entry[0]) || entry[0] >= change.length || seen.has(entry[0])) throw invalid('Journal record index is invalid');
      seen.add(entry[0]); value[name][entry[0]] = entry[1];
    }
    value[name].length = change.length;
    for (let index = 0; index < change.length; index++) if (!Object.hasOwn(value[name], index)) throw invalid('Journal record patch creates a sparse collection');
  }
}

export class OperationsJournalStore {
  #snapshot; #defaults; #value; #seq = 0; #head; #storeId; #journalRevision = null; #journalBytes = 0;
  #initialized = false; #initializing; #tail = Promise.resolve(); #conflict; #options;
  constructor(filePath, defaults, { normalizeInitial = (value) => value, compactBytes = 1024 * 1024, maxJournalBytes = 16 * 1024 * 1024, maxBytes = 8 * 1024 * 1024, fault = async () => {} } = {}) {
    this.filePath = filePath; this.journalPath = path.join(path.dirname(filePath), 'operations.journal.jsonl'); this.legacyPath = path.join(path.dirname(filePath), 'operations.legacy-v1.json');
    if (!integer(compactBytes) || compactBytes < 1 || !integer(maxJournalBytes) || maxJournalBytes < 512 || !integer(maxBytes) || maxBytes < 1) throw new TypeError('Invalid operation journal limits');
    this.#defaults = defaults; this.#options = { normalizeInitial, compactBytes, maxJournalBytes, maxBytes, fault };
    this.#snapshot = new JsonStore(filePath, () => this.#envelope(normalizeInitial(clone(defaults)), randomUUID(), 0, undefined, false));
  }
  #envelope(value, storeId = this.#storeId, seq = this.#seq, headHash = this.#head || hash({ storeId, value }), journalReady = true) {
    return signed({ format: FORMAT, storeId, seq, headHash, journalReady, value });
  }
  fence() { this.#conflict ||= new JsonStoreConflictError(this.filePath); this.#snapshot.fence(); }
  async init() {
    if (this.#initialized) return this;
    this.#initializing ||= this.#load();
    await this.#initializing; this.#initialized = true; return this;
  }
  async #load() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const existing = await fileStat(this.filePath);
    if (existing && existing.size > BigInt(this.#options.maxBytes * 32 + 4096)) throw invalid('Operation snapshot exceeds its file-size bound');
    await this.#snapshot.init(); let snapshot = await this.#snapshot.read();
    if (snapshot.format === undefined) {
      validateValue(snapshot, this.#options.maxBytes);
      const original = await readFile(this.filePath); await this.#snapshot.assertUnchanged();
      try { await copyFile(this.filePath, this.legacyPath, constants.COPYFILE_EXCL); }
      catch (error) { if (error.code !== 'EEXIST' || !original.equals(await readFile(this.legacyPath))) throw invalid('Legacy operation backup already exists with different bytes'); }
      const retained = await open(this.legacyPath, 'r+');
      try { await retained.sync(); } finally { await retained.close(); }
      if (!original.equals(await readFile(this.legacyPath))) throw invalid('Legacy operation backup does not preserve the original bytes');
      await this.#snapshot.assertUnchanged();
      snapshot = this.#envelope(this.#options.normalizeInitial(snapshot), randomUUID(), 0, undefined, false);
      await this.#snapshot.replace(snapshot);
    }
    const { checksum, ...body } = snapshot;
    if (![FORMAT, PREVIOUS_FORMAT].includes(body.format) || typeof body.storeId !== 'string' || !body.storeId || !integer(body.seq) || !digest(body.headHash) || typeof body.journalReady !== 'boolean' || checksum !== hash(body) || Object.keys(body).sort().join(',') !== 'format,headHash,journalReady,seq,storeId,value') throw invalid('Operation snapshot checksum or format is invalid');
    validateValue(body.value, this.#options.maxBytes);
    this.#value = body.value; this.#seq = body.seq; this.#head = body.headHash; this.#storeId = body.storeId;
    const journalStats = await fileStat(this.journalPath);
    if (!journalStats) {
      if (body.journalReady || this.#seq !== 0) throw invalid('Operation journal is missing after initialization');
      await this.#resetJournal(); await this.#snapshot.replace(this.#envelope(this.#value)); return;
    }
    if (journalStats.size > BigInt(this.#options.maxJournalBytes)) throw invalid('Operation journal exceeds its byte bound');
    const bytes = await readFile(this.journalPath), after = await fileStat(this.journalPath);
    if (revision(journalStats) !== revision(after)) throw new JsonStoreConflictError(this.journalPath);
    this.#journalRevision = revision(after); this.#journalBytes = bytes.length;
    const completeEnd = bytes.lastIndexOf(10) + 1;
    if (!completeEnd) throw invalid('Operation journal has no complete header');
    const lines = bytes.subarray(0, completeEnd).toString('utf8').split('\n'); lines.pop();
    let header; try { header = JSON.parse(lines.shift()); } catch { throw invalid('Operation journal header is malformed'); }
    const { checksum: headerChecksum, ...headerBody } = header;
    if (headerBody.format !== 1 || headerBody.storeId !== this.#storeId || !integer(headerBody.baseSeq) || headerBody.baseSeq > this.#seq || !digest(headerBody.baseHash) || headerChecksum !== hash(headerBody) || Object.keys(headerBody).sort().join(',') !== 'baseHash,baseSeq,format,storeId') throw invalid('Operation journal header does not bind this snapshot');
    let sequence = headerBody.baseSeq, head = headerBody.baseHash, matched = sequence === this.#seq && head === this.#head;
    for (const line of lines) {
      let entry; try { entry = JSON.parse(line); } catch { throw invalid('A complete journal entry is malformed'); }
      const { checksum: entryChecksum, ...entryBody } = entry;
      if (entryBody.storeId !== this.#storeId || !integer(entryBody.seq) || entryBody.seq !== sequence + 1 || entryBody.previousHash !== head || entryChecksum !== hash(entryBody) || Object.keys(entryBody).sort().join(',') !== 'patch,previousHash,seq,storeId') throw invalid('Operation journal sequence or checksum is invalid');
      sequence = entryBody.seq; head = entryChecksum;
      if (sequence === this.#seq) matched = head === this.#head;
      if (sequence > body.seq) { apply(this.#value, entryBody.patch); validateValue(this.#value, this.#options.maxBytes); }
    }
    if (!matched) throw invalid('Operation journal does not reach the committed snapshot head');
    this.#seq = sequence; this.#head = head;
    if (!body.journalReady && this.#seq !== 0) throw invalid('Uninitialized journal contains operation entries');
    if (completeEnd !== bytes.length) {
      const quarantine = `${this.journalPath}.torn-${randomUUID()}`, handle = await open(quarantine, 'wx', 0o600);
      try { await handle.writeFile(bytes.subarray(completeEnd)); await handle.sync(); } finally { await handle.close(); }
      await this.#assertUnchanged(); const journal = await open(this.journalPath, 'r+');
      try { await journal.truncate(completeEnd); await journal.sync(); } finally { await journal.close(); }
      const repaired = await fileStat(this.journalPath); this.#journalRevision = revision(repaired); this.#journalBytes = completeEnd;
    }
    if (body.format !== FORMAT) await this.#compact();
    else if (!body.journalReady) await this.#snapshot.replace(this.#envelope(this.#value));
  }
  #enqueue(operation) { const result = this.#tail.then(operation, operation); this.#tail = result.catch(() => {}); return result; }
  async #assertUnchanged() {
    if (this.#conflict) throw this.#conflict;
    await this.#snapshot.assertUnchanged();
    if (revision(await fileStat(this.journalPath)) !== this.#journalRevision) { this.fence(); throw this.#conflict; }
  }
  async assertUnchanged() { await this.init(); return this.#enqueue(async () => { await this.#assertUnchanged(); return true; }); }
  async read() { await this.init(); return this.#enqueue(async () => { await this.#assertUnchanged(); return clone(this.#value); }); }
  // Internal selectors are trusted code, never user-supplied JSON or callbacks.
  // Copy only their result while retaining the same live on-disk fences.
  async project(selector) {
    if (typeof selector !== 'function') throw new TypeError('selector must be a function');
    await this.init();
    return this.#enqueue(async () => { await this.#assertUnchanged(); return clone(selector(this.#value)); });
  }
  async replace(value) { return this.update(() => this.#options.normalizeInitial(clone(value))); }
  async update(updater, { returnValue = true, detachedResult = false } = {}) {
    if (typeof updater !== 'function') throw new TypeError('updater must be a function');
    await this.init();
    return this.#enqueue(async () => {
      await this.#assertUnchanged(); const draft = clone(this.#value), returned = await updater(draft);
      // Only the sanitizing OperationsStore uses detachedResult: it constructs
      // a new graph that was never exposed to its external update callback.
      const next = detachedResult && returned !== undefined ? returned : clone(returned === undefined ? draft : returned);
      validateValue(next, this.#options.maxBytes);
      const patch = diff(this.#value, next);
      if (patch.fields.length || patch.unset.length || Object.keys(patch.collections).length) {
        if (!integer(this.#seq + 1)) throw invalid('Operation journal sequence limit reached');
        const entry = signed({ storeId: this.#storeId, seq: this.#seq + 1, previousHash: this.#head, patch });
        const line = Buffer.from(`${JSON.stringify(entry)}\n`);
        if (line.length + 512 > this.#options.maxJournalBytes) throw Object.assign(new Error('Operation journal entry exceeds its byte limit'), { code: 'OPERATIONS_STORAGE_LIMIT', statusCode: 409 });
        if (this.#journalBytes + line.length > Math.min(this.#options.compactBytes, this.#options.maxJournalBytes)) await this.#compact();
        await this.#append(line); this.#seq = entry.seq; this.#head = entry.checksum; this.#value = next;
      }
      return returnValue ? clone(this.#value) : undefined;
    });
  }
  async #append(line) {
    let handle;
    try {
      await this.#assertUnchanged(); handle = await open(this.journalPath, 'a');
      if (revision(await handle.stat({ bigint: true })) !== this.#journalRevision) throw new JsonStoreConflictError(this.journalPath);
      await handle.writeFile(line); await this.#options.fault('beforeAppendSync'); await handle.sync();
      const committed = await handle.stat({ bigint: true }), live = await fileStat(this.journalPath);
      if (committed.size !== BigInt(this.#journalBytes + line.length) || revision(committed) !== revision(live)) throw new JsonStoreConflictError(this.journalPath);
      await this.#snapshot.assertUnchanged(); this.#journalRevision = revision(live); this.#journalBytes += line.length;
    } catch (error) { this.fence(); throw error; }
    finally {
      let closeFailure;
      try { if (handle) await this.#options.fault('beforeAppendClose'); } catch (error) { closeFailure = error; }
      try { await handle?.close(); } catch (error) { closeFailure ||= error; }
      if (closeFailure) { this.fence(); throw closeFailure; }
    }
  }
  async #resetJournal() {
    const header = signed({ format: 1, storeId: this.#storeId, baseSeq: this.#seq, baseHash: this.#head });
    const bytes = Buffer.from(`${JSON.stringify(header)}\n`), temporary = `${this.journalPath}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
      await replaceFileWithRetry(temporary, this.journalPath, { replace: async (from, to) => { await this.#assertUnchanged(); await rename(from, to); } });
      this.#journalRevision = revision(await fileStat(this.journalPath)); this.#journalBytes = bytes.length;
    } finally { await handle?.close(); await rm(temporary, { force: true }).catch(() => {}); }
  }
  async #compact() {
    try {
      await this.#assertUnchanged(); await this.#snapshot.replace(this.#envelope(this.#value));
      await this.#options.fault('afterSnapshotCommit'); await this.#options.fault('beforeJournalReset'); await this.#resetJournal();
    } catch (error) { this.fence(); throw error; }
  }
  async compact() { await this.init(); return this.#enqueue(() => this.#compact()); }
}
