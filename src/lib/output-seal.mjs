import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeOutputBudgetLimits } from './output-budget.mjs';

const OUTPUT_SEAL_VERSION = 1;
const HASH_CHUNK_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export function outputSealLimitsForBudget(input = {}) {
  const budget = normalizeOutputBudgetLimits(input);
  return Object.freeze({
    maxBytes: budget.maxBytes + budget.diagnosticReserveBytes,
    maxFiles: budget.maxFiles + budget.diagnosticReserveFiles,
    maxEntries: budget.maxEntries,
    maxDepth: budget.maxDepth
  });
}

export class OutputSealError extends Error {
  constructor(code, message, { drift } = {}) {
    super(message);
    this.name = 'OutputSealError';
    this.code = code;
    if (drift) this.drift = drift;
  }
}

function normalizeLimits(input = {}) {
  const budget = normalizeOutputBudgetLimits(input);
  return Object.freeze({
    maxBytes: budget.maxBytes,
    maxFiles: budget.maxFiles,
    maxEntries: budget.maxEntries,
    maxDepth: budget.maxDepth
  });
}

function outsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function isPortableRelativePath(value) {
  return typeof value === 'string' && Boolean(value) && !value.includes('\\') && !value.includes('\0') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..') &&
    !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value);
}

function identityOf(stats) {
  return Object.freeze({
    dev: String(stats.dev),
    ino: String(stats.ino),
    birthtimeNs: String(stats.birthtimeNs)
  });
}

function sameIdentity(left, right) {
  return String(left?.dev) === String(right?.dev) && String(left?.ino) === String(right?.ino) &&
    String(left?.birthtimeNs) === String(right?.birthtimeNs);
}

function sameStableMetadata(left, right) {
  return sameIdentity(left, right) && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function relativePathOf(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || outsideRoot(root, candidate)) {
    throw new OutputSealError('TASK_OUTPUT_PATH_ESCAPE', 'Task output attempted to escape its output root');
  }
  const portable = relative.split(path.sep).join('/');
  if (!isPortableRelativePath(portable)) {
    throw new OutputSealError('TASK_OUTPUT_PATH_ESCAPE', 'Task output contained a non-portable relative path');
  }
  return portable;
}

function scanChanged(message = 'Task output changed while its completion snapshot was being captured') {
  return new OutputSealError('TASK_OUTPUT_SCAN_CHANGED', message);
}

function unsafeEntry(relativePath, reason) {
  return new OutputSealError(
    'TASK_OUTPUT_ENTRY_UNSAFE',
    `Task output entry ${JSON.stringify(relativePath)} is unsafe: ${reason}`
  );
}

async function statRealDirectory(candidate, canonicalRoot, { root = false } = {}) {
  let stats;
  try {
    stats = await lstat(candidate, { bigint: true });
  } catch (error) {
    if (root && ['ENOENT', 'ENOTDIR'].includes(error?.code)) {
      throw new OutputSealError('TASK_OUTPUT_ROOT_UNSAFE', 'Task output root must be a real directory');
    }
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw scanChanged();
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    if (root) throw new OutputSealError('TASK_OUTPUT_ROOT_UNSAFE', 'Task output root must be a real directory');
    throw unsafeEntry('', 'directories must be real directories');
  }
  const canonical = await realpath(candidate).catch((error) => {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw scanChanged();
    throw error;
  });
  if (canonicalRoot && outsideRoot(canonicalRoot, canonical)) {
    throw new OutputSealError('TASK_OUTPUT_PATH_ESCAPE', 'Task output attempted to escape its output root');
  }
  return { stats, canonical };
}

async function hashStableFile(candidate, relativePath, before, canonicalRoot, remainingBytes) {
  if (!before.isFile() || before.isSymbolicLink()) {
    throw unsafeEntry(relativePath, 'only regular files are allowed');
  }
  if (before.nlink !== 1n) {
    throw unsafeEntry(relativePath, 'hard-linked files are not allowed');
  }
  if (before.size > BigInt(remainingBytes)) {
    throw new OutputSealError(
      'TASK_OUTPUT_BUDGET_EXCEEDED',
      'Task output exceeded the configured byte limit while sealing completion'
    );
  }

  let handle;
  try {
    const noFollow = Number.isSafeInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(candidate, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameStableMetadata(before, opened)) {
      throw scanChanged(`Task output entry ${JSON.stringify(relativePath)} changed while it was opened`);
    }
    const canonical = await realpath(candidate);
    if (outsideRoot(canonicalRoot, canonical)) {
      throw new OutputSealError('TASK_OUTPUT_PATH_ESCAPE', 'Task output attempted to escape its output root');
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    const expectedBytes = Number(opened.size);
    let position = 0;
    while (position < expectedBytes) {
      const length = Math.min(buffer.length, expectedBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead < 1) {
        throw scanChanged(`Task output entry ${JSON.stringify(relativePath)} changed while it was read`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const afterRead = await handle.stat({ bigint: true });
    const currentPath = await lstat(candidate, { bigint: true });
    if (
      !currentPath.isFile() || currentPath.isSymbolicLink() || currentPath.nlink !== 1n ||
      !sameStableMetadata(opened, afterRead) || !sameStableMetadata(opened, currentPath)
    ) {
      throw scanChanged(`Task output entry ${JSON.stringify(relativePath)} changed while it was hashed`);
    }
    return Object.freeze({
      relativePath,
      sizeBytes: expectedBytes,
      sha256: hash.digest('hex')
    });
  } catch (error) {
    if (error instanceof OutputSealError) throw error;
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) throw scanChanged();
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function stablePathOrder(left, right) {
  return left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
}

async function verifyRecordedPaths(directoryRecords, fileRecords) {
  for (const record of directoryRecords) {
    let current;
    try {
      current = await lstat(record.path, { bigint: true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw scanChanged();
      throw error;
    }
    if (!current.isDirectory() || current.isSymbolicLink() || !sameStableMetadata(record.stats, current)) {
      throw scanChanged('Task output directory structure changed while completion was being sealed');
    }
    const canonical = await realpath(record.path);
    if (canonical !== record.canonical) throw scanChanged('Task output directory identity changed while completion was being sealed');
  }
  for (const record of fileRecords) {
    let current;
    try {
      current = await lstat(record.path, { bigint: true });
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw scanChanged();
      throw error;
    }
    if (
      !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
      !sameStableMetadata(record.stats, current)
    ) {
      throw scanChanged(`Task output entry ${JSON.stringify(record.relativePath)} changed during completion sealing`);
    }
  }
}

export async function snapshotOutputTree({ root, limits: suppliedLimits } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('output seal root is required');
  const limits = normalizeLimits(suppliedLimits);
  const resolvedRoot = path.resolve(root);
  const initialRoot = await statRealDirectory(resolvedRoot, null, { root: true });
  const canonicalRoot = initialRoot.canonical;
  const rootRecord = { path: resolvedRoot, ...initialRoot };
  const directoryRecords = [rootRecord];
  const directoryByPath = new Map([[resolvedRoot, rootRecord]]);
  const fileRecords = [];
  const entries = [];
  const pending = [{ directory: resolvedRoot, depth: 0 }];
  let scannedEntries = 0;
  let bytes = 0;

  try {
    while (pending.length) {
      const { directory, depth } = pending.pop();
      if (depth > limits.maxDepth) {
        throw new OutputSealError(
          'TASK_OUTPUT_SCAN_LIMIT_EXCEEDED',
          'Task output directory depth exceeded the bounded completion scanner limit'
        );
      }
      const knownDirectory = directoryByPath.get(directory);
      if (!knownDirectory) throw scanChanged();
      const beforeOpen = await statRealDirectory(directory, canonicalRoot);
      if (
        beforeOpen.canonical !== knownDirectory.canonical ||
        !sameStableMetadata(knownDirectory.stats, beforeOpen.stats)
      ) {
        throw scanChanged('Task output directory changed before it could be scanned');
      }

      let handle;
      try {
        handle = await opendir(directory);
        for await (const directoryEntry of handle) {
          scannedEntries += 1;
          if (scannedEntries > limits.maxEntries) {
            throw new OutputSealError(
              'TASK_OUTPUT_SCAN_LIMIT_EXCEEDED',
              'Task output contained too many entries for bounded completion sealing'
            );
          }
          const candidate = path.resolve(directory, directoryEntry.name);
          const relativePath = relativePathOf(resolvedRoot, candidate);
          let stats;
          try {
            stats = await lstat(candidate, { bigint: true });
          } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes(error?.code)) throw scanChanged();
            throw error;
          }
          if (stats.isSymbolicLink()) throw unsafeEntry(relativePath, 'symbolic links are not allowed');
          if (stats.isDirectory()) {
            const child = await statRealDirectory(candidate, canonicalRoot);
            if (!sameStableMetadata(stats, child.stats)) throw scanChanged();
            const childRecord = { path: candidate, relativePath, ...child };
            directoryRecords.push(childRecord);
            directoryByPath.set(candidate, childRecord);
            pending.push({ directory: candidate, depth: depth + 1 });
            continue;
          }
          if (!stats.isFile()) throw unsafeEntry(relativePath, 'only regular files and directories are allowed');
          if (entries.length >= limits.maxFiles) {
            throw new OutputSealError(
              'TASK_OUTPUT_BUDGET_EXCEEDED',
              'Task output exceeded the configured file limit while sealing completion'
            );
          }
          const entry = await hashStableFile(
            candidate,
            relativePath,
            stats,
            canonicalRoot,
            limits.maxBytes - bytes
          );
          entries.push(entry);
          bytes += entry.sizeBytes;
          fileRecords.push({ path: candidate, relativePath, stats });
        }
      } finally {
        await handle?.close().catch(() => {});
      }
    }

    await verifyRecordedPaths(directoryRecords, fileRecords);
  } catch (error) {
    if (error instanceof OutputSealError || error instanceof TypeError) throw error;
    throw new OutputSealError('TASK_OUTPUT_SCAN_FAILED', 'Task output could not be sealed safely');
  }

  entries.sort(stablePathOrder);
  const directories = directoryRecords
    .slice(1)
    .map((record) => record.relativePath)
    .sort();
  return Object.freeze({
    version: OUTPUT_SEAL_VERSION,
    rootIdentity: identityOf(initialRoot.stats),
    files: entries.length,
    bytes,
    directories: Object.freeze(directories),
    entries: Object.freeze(entries)
  });
}

function validateSnapshot(snapshot, name) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new TypeError(`${name} must be an output seal snapshot`);
  }
  if (snapshot.version !== OUTPUT_SEAL_VERSION) {
    throw new TypeError(`${name}.version must be ${OUTPUT_SEAL_VERSION}`);
  }
  if (
    !snapshot.rootIdentity || typeof snapshot.rootIdentity !== 'object' ||
    typeof snapshot.rootIdentity.dev !== 'string' || typeof snapshot.rootIdentity.ino !== 'string' ||
    typeof snapshot.rootIdentity.birthtimeNs !== 'string'
  ) {
    throw new TypeError(`${name}.rootIdentity is invalid`);
  }
  if (!Number.isSafeInteger(snapshot.files) || snapshot.files < 0 || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 0) {
    throw new TypeError(`${name} counters are invalid`);
  }
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length !== snapshot.files) {
    throw new TypeError(`${name}.entries does not match its file count`);
  }
  if (!Array.isArray(snapshot.directories)) throw new TypeError(`${name}.directories is invalid`);
  let previousDirectory = null;
  for (const relativePath of snapshot.directories) {
    if (!isPortableRelativePath(relativePath)) throw new TypeError(`${name}.directories contains an unsafe path`);
    if (previousDirectory !== null && relativePath <= previousDirectory) {
      throw new TypeError(`${name}.directories must have unique paths in stable order`);
    }
    previousDirectory = relativePath;
  }
  let previous = null;
  let bytes = 0;
  for (const entry of snapshot.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`${name}.entries is invalid`);
    const relativePath = entry.relativePath;
    if (!isPortableRelativePath(relativePath)) {
      throw new TypeError(`${name} contains an unsafe relative path`);
    }
    if (previous !== null && relativePath <= previous) {
      throw new TypeError(`${name}.entries must have unique paths in stable order`);
    }
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !SHA256.test(entry.sha256 || '')) {
      throw new TypeError(`${name} contains invalid file metadata`);
    }
    previous = relativePath;
    bytes += entry.sizeBytes;
  }
  if (bytes !== snapshot.bytes) throw new TypeError(`${name}.bytes does not match its entries`);
}

export function compareOutputSnapshots(expected, actual) {
  validateSnapshot(expected, 'expected');
  validateSnapshot(actual, 'actual');
  const drift = [];
  if (!sameIdentity(expected.rootIdentity, actual.rootIdentity)) {
    drift.push(Object.freeze({
      kind: 'root_identity_changed',
      expected: expected.rootIdentity,
      actual: actual.rootIdentity
    }));
  }

  const expectedDirectories = new Set(expected.directories);
  const actualDirectories = new Set(actual.directories);
  const allDirectories = [...new Set([...expectedDirectories, ...actualDirectories])].sort();
  for (const relativePath of allDirectories) {
    if (!expectedDirectories.has(relativePath)) {
      drift.push(Object.freeze({ kind: 'directory_added', relativePath }));
    } else if (!actualDirectories.has(relativePath)) {
      drift.push(Object.freeze({ kind: 'directory_removed', relativePath }));
    }
  }

  const expectedByPath = new Map(expected.entries.map((entry) => [entry.relativePath, entry]));
  const actualByPath = new Map(actual.entries.map((entry) => [entry.relativePath, entry]));
  const allPaths = [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort();
  for (const relativePath of allPaths) {
    const before = expectedByPath.get(relativePath);
    const after = actualByPath.get(relativePath);
    if (!before) {
      drift.push(Object.freeze({ kind: 'added', relativePath, actual: after }));
    } else if (!after) {
      drift.push(Object.freeze({ kind: 'removed', relativePath, expected: before }));
    } else if (before.sizeBytes !== after.sizeBytes || before.sha256 !== after.sha256) {
      const fields = [];
      if (before.sizeBytes !== after.sizeBytes) fields.push('sizeBytes');
      if (before.sha256 !== after.sha256) fields.push('sha256');
      drift.push(Object.freeze({
        kind: 'modified',
        relativePath,
        fields: Object.freeze(fields),
        expected: before,
        actual: after
      }));
    }
  }
  return Object.freeze({ changed: drift.length > 0, drift: Object.freeze(drift) });
}

function describeDrift(drift) {
  const descriptions = drift.slice(0, 8).map((entry) => {
    if (entry.kind === 'root_identity_changed') return 'output root identity changed';
    if (entry.kind === 'directory_added') return `directory ${JSON.stringify(entry.relativePath)} added`;
    if (entry.kind === 'directory_removed') return `directory ${JSON.stringify(entry.relativePath)} removed`;
    if (entry.kind === 'modified') {
      return `${JSON.stringify(entry.relativePath)} modified (${entry.fields.join(', ')})`;
    }
    return `${JSON.stringify(entry.relativePath)} ${entry.kind}`;
  });
  if (drift.length > descriptions.length) descriptions.push(`and ${drift.length - descriptions.length} more change(s)`);
  return descriptions.join('; ');
}

export function assertOutputTreeUnchanged(expected, actual) {
  const comparison = compareOutputSnapshots(expected, actual);
  if (!comparison.changed) return actual;
  throw new OutputSealError(
    'TASK_OUTPUT_CHANGED_AFTER_COMPLETION',
    `Task output changed after completion: ${describeDrift(comparison.drift)}`,
    { drift: comparison.drift }
  );
}

export async function createOutputSeal({ root, limits } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('output seal root is required');
  const resolvedRoot = path.resolve(root);
  const normalizedLimits = normalizeLimits(limits);
  const initial = await snapshotOutputTree({ root: resolvedRoot, limits: normalizedLimits });
  return Object.freeze({
    version: OUTPUT_SEAL_VERSION,
    snapshot: initial,
    async verify() {
      const current = await snapshotOutputTree({ root: resolvedRoot, limits: normalizedLimits });
      assertOutputTreeUnchanged(initial, current);
      return current;
    }
  });
}
