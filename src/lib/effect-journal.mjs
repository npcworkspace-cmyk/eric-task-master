import { lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';

const MAX_INSPECTION_BYTES = 64 * 1024 * 1024;
const STATES = new Set(['started', 'succeeded', 'failed']);
const SAFE_OPERATIONS = new Set(['goto', 'click', 'fill', 'type', 'hover', 'scroll', 'custom']);

export class EffectJournalError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'EffectJournalError';
    this.code = code;
  }
}

function safeOperation(operation) {
  return SAFE_OPERATIONS.has(operation) ? operation : 'custom';
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function sameFile(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function validateJournalStats(details) {
  const links = typeof details.nlink === 'bigint' ? Number(details.nlink) : details.nlink;
  const size = typeof details.size === 'bigint' ? Number(details.size) : details.size;
  if (!details.isFile() || details.isSymbolicLink?.() || links !== 1) {
    throw new EffectJournalError(
      'TASK_EFFECT_JOURNAL_UNSAFE',
      'Task effect journal must be a private regular file'
    );
  }
  if (size > MAX_INSPECTION_BYTES) {
    throw new EffectJournalError(
      'TASK_EFFECT_JOURNAL_TOO_LARGE',
      'Task effect journal exceeded its bounded internal size'
    );
  }
}

async function replayJournal(handle, details) {
  const size = typeof details.size === 'bigint' ? Number(details.size) : details.size;
  if (size === 0) return { lastSequence: 0, pending: new Map() };
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  let lastSequence = 0;
  const pending = new Map();
  for (const line of buffer.subarray(0, offset).toString('utf8').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !STATES.has(value.state)) continue;
      lastSequence = Math.max(lastSequence, value.sequence);
      if (value.state === 'started') {
        pending.set(value.sequence, safeOperation(value.operation));
      } else {
        pending.delete(value.sequence);
      }
    } catch {
      // A torn final append is ignored; earlier durable records remain authoritative.
    }
  }
  return { lastSequence, pending };
}

export async function createEffectJournal({ filePath, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('effect journal filePath is required');
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let before = null;
  try {
    before = await lstat(filePath, { bigint: true });
    validateJournalStats(before);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let handle;
  try {
    handle = await open(filePath, before ? 'a+' : 'ax+', 0o600);
  } catch (error) {
    if (before || error.code !== 'EEXIST') throw error;
    before = await lstat(filePath, { bigint: true });
    validateJournalStats(before);
    handle = await open(filePath, 'a+', 0o600);
  }
  const opened = await handle.stat({ bigint: true });
  try {
    validateJournalStats(opened);
    if (before && !sameFile(before, opened)) {
      throw new EffectJournalError(
        'TASK_EFFECT_JOURNAL_CHANGED',
        'Task effect journal changed while it was being opened'
      );
    }
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
  const replayed = await replayJournal(handle, opened);
  let sequence = replayed.lastSequence;
  let writeTail = Promise.resolve();
  const operations = replayed.pending;
  const carriedPending = new Set(operations.keys());
  let accepting = true;
  let closed = false;

  async function append(record) {
    if (!accepting) {
      throw new EffectJournalError(
        'TASK_EFFECT_JOURNAL_FAILED',
        'Task effect journal is closed; inspect the last known action before retrying'
      );
    }
    const operation = writeTail.then(async () => {
      if (closed) throw new Error('effect journal is closed');
      const encoded = `${JSON.stringify(record)}\n`;
      const current = await handle.stat({ bigint: true });
      validateJournalStats(current);
      if (!sameFile(opened, current)) throw new Error('effect journal identity changed');
      const currentPath = await lstat(filePath, { bigint: true });
      validateJournalStats(currentPath);
      if (!sameFile(opened, currentPath)) throw new Error('effect journal path changed');
      if (Number(current.size) + Buffer.byteLength(encoded) > MAX_INSPECTION_BYTES) {
        throw new Error('effect journal size limit reached');
      }
      await handle.writeFile(encoded, 'utf8');
    });
    writeTail = operation.catch(() => {});
    try {
      await operation;
    } catch (cause) {
      throw new EffectJournalError(
        'TASK_EFFECT_JOURNAL_FAILED',
        'Task effect journal could not be persisted; inspect the last known action before retrying',
        cause
      );
    }
  }

  async function record({ state, operation, sequence: suppliedSequence } = {}) {
    if (!STATES.has(state)) throw new TypeError('effect state must be started, succeeded, or failed');
    let durableSequence = suppliedSequence;
    if (state === 'started') {
      if (operations.size > 0) {
        throw new EffectJournalError(
          'TASK_EFFECT_OUTCOME_UNKNOWN',
          'A prior browser action has no verified outcome; inspect current state before any new action'
        );
      }
      durableSequence = ++sequence;
      operations.set(durableSequence, safeOperation(operation));
    } else if (!Number.isSafeInteger(durableSequence) || durableSequence < 1) {
      throw new TypeError('terminal effect records require their started sequence');
    }
    const normalizedOperation = operations.get(durableSequence) || safeOperation(operation);
    await append({
      sequence: durableSequence,
      operation: normalizedOperation,
      state,
      at: now()
    });
    if (state !== 'started') operations.delete(durableSequence);
    return durableSequence;
  }

  function pending() {
    return Object.freeze([...operations.entries()]
      .filter(([effectSequence]) => carriedPending.has(effectSequence))
      .map(([effectSequence, operation]) => Object.freeze({
        sequence: effectSequence,
        operation,
        state: 'started'
      }))
      .sort((left, right) => left.sequence - right.sequence));
  }

  async function resolveUnknown(effectSequence, observedOutcome) {
    if (!Number.isSafeInteger(effectSequence) || effectSequence < 1) {
      throw new TypeError('effect sequence must be a positive integer');
    }
    if (!['observed_succeeded', 'observed_not_applied'].includes(observedOutcome)) {
      throw new TypeError('observed outcome must be observed_succeeded or observed_not_applied');
    }
    if (!carriedPending.has(effectSequence) || !operations.has(effectSequence)) {
      throw new EffectJournalError(
        'TASK_EFFECT_NOT_PENDING',
        'Only an effect carried from a previous attempt can be resolved explicitly'
      );
    }
    const operation = operations.get(effectSequence);
    await record({
      state: observedOutcome === 'observed_succeeded' ? 'succeeded' : 'failed',
      operation,
      sequence: effectSequence
    });
    carriedPending.delete(effectSequence);
    return Object.freeze({ sequence: effectSequence, operation, observedOutcome });
  }

  async function close() {
    if (closed) return;
    accepting = false;
    await writeTail.catch(() => {});
    closed = true;
    await handle.close();
  }

  async function assertSettled() {
    await writeTail;
    if (operations.size > 0) {
      throw new EffectJournalError(
        'TASK_EFFECT_OUTCOME_UNKNOWN',
        'A browser action has no terminal effect record; inspect current state before any retry'
      );
    }
  }

  return Object.freeze({ record, pending, resolveUnknown, assertSettled, close });
}

export async function inspectEffectJournal(filePath, { maxBytes = MAX_INSPECTION_BYTES } = {}) {
  const before = await lstat(filePath, { bigint: true });
  validateJournalStats(before);
  if (Number(before.size) > maxBytes) {
    throw new EffectJournalError(
      'TASK_EFFECT_JOURNAL_TOO_LARGE',
      'Task effect journal is too large for bounded inspection'
    );
  }
  const pending = new Map();
  let lastSequence = 0;
  let records = 0;
  const handle = await open(filePath, 'r');
  let source;
  try {
    const opened = await handle.stat({ bigint: true });
    validateJournalStats(opened);
    if (!sameFile(before, opened)) {
      throw new EffectJournalError('TASK_EFFECT_JOURNAL_CHANGED', 'Task effect journal changed during inspection');
    }
    const size = Number(opened.size);
    if (size > maxBytes) {
      throw new EffectJournalError('TASK_EFFECT_JOURNAL_TOO_LARGE', 'Task effect journal is too large for bounded inspection');
    }
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    source = buffer.subarray(0, offset).toString('utf8');
    const after = await lstat(filePath, { bigint: true });
    validateJournalStats(after);
    if (!sameFile(opened, after)) {
      throw new EffectJournalError('TASK_EFFECT_JOURNAL_CHANGED', 'Task effect journal changed during inspection');
    }
  } finally {
    await handle.close();
  }
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(value.sequence) || value.sequence < 1 || !STATES.has(value.state)) continue;
    records += 1;
    lastSequence = Math.max(lastSequence, value.sequence);
    if (value.state === 'started') {
      pending.set(value.sequence, {
        sequence: value.sequence,
        operation: safeOperation(value.operation),
        state: 'started',
        at: safeTimestamp(value.at)
      });
    } else {
      pending.delete(value.sequence);
    }
  }
  return Object.freeze({
    records,
    lastSequence,
    pending: Object.freeze([...pending.values()].sort((left, right) => left.sequence - right.sequence))
  });
}
