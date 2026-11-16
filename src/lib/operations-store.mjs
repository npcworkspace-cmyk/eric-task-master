import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OperationsJournalStore, prepareOperationsJournalValue } from './operations-journal-store.mjs';
import { OperationsEvidenceStore, validateReplyReference } from './operations-evidence-store.mjs';
import { redactSensitiveValue } from './redaction.mjs';
import { opsError } from './operations-contracts.mjs';

export const operationId = (prefix = 'op') => `${prefix}_${randomUUID().replaceAll('-', '')}`;
// Domain authorization is a permission envelope, never an HTTP Authorization header.
export function safeOperationsValue(value, { depth = 0 } = {}) {
  const transform = (item, reverse = false) => {
    if (Array.isArray(item)) return item.map((child) => transform(child, reverse));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !/^(?:otp|verificationCode|oneTimeCode|passcode|twoFactorCode)$/iu.test(key)).map(([key, child]) => [
      reverse && key === 'operationPermissionEnvelope' ? 'authorization' :
        !reverse && key === 'authorization' && child && typeof child === 'object' && !Array.isArray(child) &&
          typeof child.accountId === 'string' && Number.isSafeInteger(child.version) ? 'operationPermissionEnvelope' : key,
      transform(child, reverse)
    ]));
  };
  return transform(redactSensitiveValue(transform(value), { depth, maxDepth: 30, maxItems: 10001 }), true);
}
const RECORD_COLLECTIONS = ['operations', 'actions', 'commands', 'events', 'records'];
const TERMINAL_COMMANDS = new Set(['confirmed', 'failed', 'stopped']);
const READ_KINDS = new Set(['observe', 'wait', 'screenshot', 'tabs', 'select-tab', 'reconcile']);
const referenceKey = (reference) => `${reference.sha256}:${reference.bytes}`;
const fieldBytes = (name, valueBytes) => Buffer.byteLength(JSON.stringify(name)) + 1 + valueBytes;
const logicalSize = (hotBytes, references) => hotBytes + references.reduce((sum, reference) => sum + fieldBytes('reply', reference.bytes) - fieldBytes('replyRef', Buffer.byteLength(JSON.stringify(reference))), 0);
const assertStructure = (serialized) => {
  if (serialized?.includes('[truncated]') || serialized?.includes('__taskMasterTruncated')) throw opsError('RECORD_TOO_DEEP', 'Record exceeds storage structural limits');
};
export class OperationsStore {
  #safeRecords = new Map();
  #initialized = false; #initializing;
  constructor({ stateDir, now = Date.now, maxBytes = 8 * 1024 * 1024, maxRecords = 10000, retentionMs = 30 * 86400000, journalOptions = {}, evidenceOptions = {} }) {
    this.now = now; this.maxBytes = maxBytes; this.maxRecords = maxRecords; this.retentionMs = retentionMs;
    const { thresholdBytes = 2048, ...evidenceStoreOptions } = evidenceOptions;
    if (!Number.isSafeInteger(thresholdBytes) || thresholdBytes < 1) throw new TypeError('Invalid command reply evidence threshold');
    this.replyThresholdBytes = thresholdBytes;
    this.evidence = new OperationsEvidenceStore(path.join(stateDir, 'evidence'), { ...evidenceStoreOptions, maxBytes });
    this.store = new OperationsJournalStore(path.join(stateDir, 'operations.json'), { version: 1, operations: [], actions: [], commands: [], events: [], records: [] }, { maxBytes, normalizeInitial: safeOperationsValue, ...journalOptions });
  }
  async init() {
    if (this.#initialized) return this;
    this.#initializing ||= this.#load();
    await this.#initializing; this.#initialized = true; return this;
  }
  #references(data) {
    return data.commands.filter((command) => Object.hasOwn(command, 'replyRef')).map((command) => {
      if (!TERMINAL_COMMANDS.has(command.status) || Object.hasOwn(command, 'reply')) throw opsError('OPERATIONS_EVIDENCE_INVALID', 'Only terminal command replies may use one evidence reference', 409);
      return validateReplyReference(command.replyRef, this.maxBytes);
    });
  }
  async #load() {
    await this.evidence.init(); await this.store.init();
    const { references, logicalBytes } = await this.store.project((data) => {
      const references = this.#references(data);
      return { references, logicalBytes: logicalSize(Buffer.byteLength(JSON.stringify(data)), references) };
    });
    if (logicalBytes > this.maxBytes) throw opsError('OPERATIONS_STORAGE_LIMIT', 'Materialized operation evidence exceeds its logical byte limit', 409);
    const verified = new Set();
    try {
      for (const reference of references) if (!verified.has(referenceKey(reference))) {
        await this.evidence.read(reference); verified.add(referenceKey(reference));
      }
    } catch (error) { this.store.fence(); throw error; }
    const migrationNeeded = await this.store.project((data) => data.commands.some((command) =>
      TERMINAL_COMMANDS.has(command.status) && Object.hasOwn(command, 'reply') &&
      Buffer.byteLength(JSON.stringify(command.reply) ?? '') >= this.replyThresholdBytes));
    // Migration retains every logical record; normal retention still runs on
    // subsequent domain updates. Blobs are durable before this reference patch.
    if (migrationNeeded) {
      await this.#update(() => {}, { emergency: true, retainAll: true });
      await this.store.compact();
    }
  }
  async #hydrateCommand(command) {
    const hydrated = structuredClone(command);
    if (!hydrated || typeof hydrated !== 'object' || !Object.hasOwn(hydrated, 'replyRef')) return hydrated;
    try {
      this.#references({ commands: [hydrated] });
      hydrated.reply = await this.evidence.read(hydrated.replyRef);
      delete hydrated.replyRef; return hydrated;
    } catch (error) { this.store.fence(); throw error; }
  }
  async hydrateCommand(command) { await this.init(); await this.store.assertUnchanged(); return this.#hydrateCommand(command); }
  async hydrateCommands(commands) {
    if (!Array.isArray(commands)) throw new TypeError('commands must be an array');
    await this.init(); await this.store.assertUnchanged();
    return this.#hydrateCommands(commands);
  }
  async #hydrateCommands(commands) {
    const results = new Array(commands.length); let cursor = 0;
    const workers = Array.from({ length: Math.min(4, commands.length) }, async () => {
      while (cursor < commands.length) { const index = cursor++; results[index] = await this.#hydrateCommand(commands[index]); }
    });
    const settled = await Promise.allSettled(workers), failure = settled.find((item) => item.status === 'rejected');
    if (failure) throw failure.reason;
    return results;
  }
  async read() {
    await this.init(); const data = await this.store.read();
    data.commands = await this.#hydrateCommands(data.commands); return data;
  }
  // Internal projections deliberately remain hot: a selected cold reply must
  // be hydrated explicitly, never loaded for authorization/scheduler reads.
  async project(selector) { await this.init(); return this.store.project(selector); }
  async readAuthorizationContext(taskId, commandId, payload = null) {
    return this.project((data) => {
      const operation = data.operations.find((item) => item.taskId === taskId);
      const command = operation && data.commands.find((item) => item.operationId === operation.id && item.commandId === commandId);
      const readOnlyControl = payload?.kind === 'control' && payload.effect === false && !payload.actionId && command?.envelope.kind === 'control' && command.envelope.payload?.action === 'acknowledge-dialog';
      const actions = payload && (READ_KINDS.has(payload.kind) || readOnlyControl) ? [] :
        payload && payload.kind !== 'social.reply' ? data.actions.filter((item) => item.operationId === operation?.id) : data.actions;
      return { version: data.version, operations: operation ? [operation] : [],
        commands: command ? [{ operationId: command.operationId, commandId: command.commandId, status: command.status, delivered: command.delivered, envelope: command.envelope }] : [],
        // Cross-operation social duplicates and frequency limits still require
        // the current action evidence, not only this command's local records.
        actions, events: [], records: [] };
    });
  }
  async update(change, options = {}) { await this.init(); return this.#update(change, options); }
  async #update(change, { emergency = false, retainAll = false } = {}) {
    let result, nextSafeRecords;
    try { await this.store.update(async (data) => {
      const previousReferences = new Set(this.#references(data).map(referenceKey));
      const evidenceWrites = new Map();
      result = await change(data);
      if (!retainAll) for (const collection of ['actions', 'commands', 'events', 'records']) {
        data[collection] = data[collection].filter((item) => {
          const terminal = collection === 'events' ? item.state === 'handled' : ['confirmed', 'failed', 'stopped'].includes(item.status);
          return !terminal || this.now() - Date.parse(item.updatedAt || item.createdAt) <= this.retentionMs;
        });
      }
      // Cache only canonical JSON that this instance has already sanitized, not
      // permissions or live state. Any nested edit changes the complete record's
      // JSON; first-load/unseen values still run through the full redactor.
      const envelope = { ...data };
      for (const name of RECORD_COLLECTIONS) envelope[name] = [];
      const bounded = RECORD_COLLECTIONS.every((name) => data[name].length <= 10001);
      const safe = bounded ? safeOperationsValue(envelope) : safeOperationsValue(data);
      nextSafeRecords = new Map();
      const reusedRecords = new WeakSet();
      for (const name of RECORD_COLLECTIONS) {
        if (bounded) safe[name] = data[name].map((record) => {
          const canonical = JSON.stringify(record);
          if (typeof canonical === 'string' && this.#safeRecords.has(canonical)) {
            let cached = this.#safeRecords.get(canonical);
            if (cached && typeof cached === 'object') {
              // Identical records still need distinct identities: otherwise a
              // later draft clone could turn one nested edit into two edits.
              if (reusedRecords.has(cached)) cached = JSON.parse(canonical);
              reusedRecords.add(cached);
            }
            nextSafeRecords.set(canonical, cached);
            return cached;
          }
          const sanitized = safeOperationsValue(record, { depth: 2 });
          let safeCanonical = JSON.stringify(sanitized);
          // Moving a reply out of the hot JSON must not hide truncation/depth
          // failures from the same structural checks used for inline records.
          assertStructure(safeCanonical);
          let stored = typeof safeCanonical === 'string' ? JSON.parse(safeCanonical) : sanitized;
          if (name === 'commands' && TERMINAL_COMMANDS.has(stored?.status) && Object.hasOwn(stored, 'reply')) {
            const prepared = this.evidence.prepare(stored.reply);
            // A replacement reply supersedes its old reference. The old blob
            // remains immutable evidence and is not automatically deleted.
            delete stored.replyRef;
            if (prepared.reference.bytes >= this.replyThresholdBytes) {
              delete stored.reply; stored.replyRef = prepared.reference;
              evidenceWrites.set(referenceKey(prepared.reference), prepared);
            }
            safeCanonical = JSON.stringify(stored);
          }
          if (typeof safeCanonical === 'string') nextSafeRecords.set(safeCanonical, stored);
          return stored;
        });
      }
      const references = this.#references(safe);
      const { serialized, bytes } = prepareOperationsJournalValue(safe);
      assertStructure(serialized);
      const reserve = emergency ? 0 : Math.min(4096, Math.floor(this.maxBytes / 8));
      const logicalBytes = logicalSize(bytes, references);
      if (Object.values(data).some((value) => Array.isArray(value) && value.length > this.maxRecords) || logicalBytes > this.maxBytes - reserve) {
        throw opsError('OPERATIONS_STORAGE_LIMIT', 'Operations storage limit reached; archive confirmed records before continuing', 409);
      }
      try {
        for (const prepared of evidenceWrites.values()) await this.evidence.put(prepared);
        for (const reference of references) if (!previousReferences.has(referenceKey(reference)) && !evidenceWrites.has(referenceKey(reference))) await this.evidence.read(reference);
      } catch (error) { this.store.fence(); throw error; }
      // The envelope and every record above are newly constructed, detached
      // from the updater's draft. The journal need not clone this private tree
      // a second time; the caller's retained draft/result cannot mutate it.
      return safe;
    }, { returnValue: false, detachedResult: true }); } catch (error) {
      if (error.code === 'OPERATIONS_STORAGE_LIMIT' && !emergency) {
        const paused = await this.pauseForCapacity();
        await this.onCapacity?.(paused);
      }
      throw error;
    }
    this.#safeRecords = nextSafeRecords;
    return safeOperationsValue(result);
  }
  async pauseForCapacity() {
    return this.update((data) => {
      data.storageFailure = { code: 'OPERATIONS_STORAGE_LIMIT', at: new Date(this.now()).toISOString(), message: 'Storage capacity reached; automation paused; retain safety evidence and archive confirmed records before resuming' };
      const paused = [];
      for (const operation of data.operations) if (!['stopped', 'revoked', 'failed'].includes(operation.status)) {
        operation.status = 'paused'; paused.push({ id: operation.id, taskId: operation.taskId });
      }
      return paused;
    }, { emergency: true });
  }
  async recover() {
    return this.update((data) => {
      for (const action of data.actions) if (action.status === 'initiated') action.status = action.effect === false ? 'failed' : 'unknown';
      for (const command of data.commands) if (command.status === 'pending') command.status = 'unknown';
      for (const operation of data.operations) if (!['stopped', 'revoked', 'failed'].includes(operation.status)) {
        if (operation.status !== 'paused') operation.status = data.actions.some((action) => action.operationId === operation.id && action.effect !== false && ['initiated', 'unknown'].includes(action.status)) ? 'reconcile-required' : 'running';
        operation.pending = null;
      }
    });
  }
  assertUnchanged() { return this.store.assertUnchanged(); }
  fence() { this.store.fence(); }
}
