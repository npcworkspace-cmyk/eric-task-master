import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rm
} from 'node:fs/promises';
import path from 'node:path';

const BACKUP_SCHEMA_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 500_000,
  maxBytes: 100 * 1024 * 1024 * 1024
});

export class StateBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StateBackupError';
    this.code = code;
  }
}

function backupError(code, message) {
  return new StateBackupError(code, message);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function portablePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function validatePortablePath(value) {
  if (
    typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
    value.startsWith('/') || value.includes(':') || path.posix.normalize(value) !== value ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw backupError('STATE_BACKUP_MANIFEST_INVALID', 'Backup manifest contains an unsafe relative path');
  }
  return value;
}

async function statsOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function sha256File(filePath) {
  const handle = await open(filePath, 'r');
  const hash = createHash('sha256');
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return hash.digest('hex');
  } finally {
    await handle.close().catch(() => {});
  }
}

function normalizeLimits(limits = {}) {
  const result = {
    maxFiles: limits.maxFiles ?? DEFAULT_LIMITS.maxFiles,
    maxBytes: limits.maxBytes ?? DEFAULT_LIMITS.maxBytes
  };
  if (!Number.isSafeInteger(result.maxFiles) || result.maxFiles < 1) {
    throw new TypeError('maxFiles must be a positive safe integer');
  }
  if (!Number.isSafeInteger(result.maxBytes) || result.maxBytes < 1) {
    throw new TypeError('maxBytes must be a positive safe integer');
  }
  return result;
}

async function collectTree(root, limits) {
  const entries = [];
  let fileCount = 0;
  let totalBytes = 0;

  async function visit(directory, relativeDirectory = '') {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const relative = relativeDirectory ? path.join(relativeDirectory, child.name) : child.name;
      const portable = portablePath(relative);
      const absolute = path.join(root, relative);
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        throw backupError('STATE_BACKUP_LINK_UNSUPPORTED', `Backup source contains a symbolic link: ${portable}`);
      }
      if (stats.isDirectory()) {
        entries.push({ path: portable, type: 'directory', mode: stats.mode & 0o777 });
        await visit(absolute, relative);
        continue;
      }
      if (!stats.isFile()) {
        throw backupError('STATE_BACKUP_ENTRY_UNSUPPORTED', `Backup source contains an unsupported entry: ${portable}`);
      }
      fileCount += 1;
      totalBytes += stats.size;
      if (fileCount > limits.maxFiles || totalBytes > limits.maxBytes) {
        throw backupError('STATE_BACKUP_LIMIT_EXCEEDED', 'Backup source exceeds the configured file or byte limit');
      }
      entries.push({
        path: portable,
        type: 'file',
        mode: stats.mode & 0o777,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        dev: stats.dev,
        ino: stats.ino
      });
    }
  }

  await visit(root);
  return { entries, fileCount, totalBytes };
}

async function assertManagerStopped(sourceRoot) {
  for (const name of ['.manager.lock', '.manager.lock.recovery']) {
    if (await statsOrNull(path.join(sourceRoot, name))) {
      throw backupError(
        'STATE_BACKUP_MANAGER_ACTIVE',
        'Manager state must be cleanly stopped before backup'
      );
    }
  }
}

async function writeJsonExclusive(filePath, value) {
  const handle = await open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateManifest(manifest) {
  if (
    !manifest || manifest.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.entries) || !Number.isSafeInteger(manifest.fileCount) ||
    !Number.isSafeInteger(manifest.totalBytes)
  ) {
    throw backupError('STATE_BACKUP_MANIFEST_INVALID', 'Backup manifest is malformed or unsupported');
  }
  const seen = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of manifest.entries) {
    validatePortablePath(entry?.path);
    if (seen.has(entry.path)) {
      throw backupError('STATE_BACKUP_MANIFEST_INVALID', 'Backup manifest contains duplicate paths');
    }
    seen.add(entry.path);
    if (entry.type === 'directory') {
      if (!Number.isInteger(entry.mode)) {
        throw backupError('STATE_BACKUP_MANIFEST_INVALID', 'Backup directory metadata is invalid');
      }
      continue;
    }
    if (
      entry.type !== 'file' || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
      typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      !Number.isInteger(entry.mode)
    ) {
      throw backupError('STATE_BACKUP_MANIFEST_INVALID', 'Backup file metadata is invalid');
    }
    fileCount += 1;
    totalBytes += entry.size;
  }
  if (fileCount !== manifest.fileCount || totalBytes !== manifest.totalBytes) {
    throw backupError('STATE_BACKUP_MANIFEST_INVALID', 'Backup manifest totals do not match its entries');
  }
  return manifest;
}

async function copyManifestEntries({ entries, sourceRoot, destinationRoot, verifySourceIdentity = false }) {
  for (const entry of entries.filter((item) => item.type === 'directory')) {
    const target = path.join(destinationRoot, ...entry.path.split('/'));
    await mkdir(target, { recursive: true, mode: entry.mode || 0o700 });
    await chmod(target, entry.mode || 0o700).catch(() => {});
  }
  for (const entry of entries.filter((item) => item.type === 'file')) {
    const segments = entry.path.split('/');
    const source = path.join(sourceRoot, ...segments);
    const target = path.join(destinationRoot, ...segments);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const before = verifySourceIdentity ? await lstat(source) : null;
    await copyFile(source, target);
    await chmod(target, entry.mode || 0o600).catch(() => {});
    const [sourceDigest, targetDigest, after, targetStats] = await Promise.all([
      sha256File(source),
      sha256File(target),
      verifySourceIdentity ? lstat(source) : Promise.resolve(null),
      lstat(target)
    ]);
    if (
      sourceDigest !== targetDigest || targetStats.size !== entry.size ||
      (verifySourceIdentity && (
        before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ))
    ) {
      throw backupError('STATE_BACKUP_SOURCE_CHANGED', `Backup source changed while copying: ${entry.path}`);
    }
    entry.sha256 ||= sourceDigest;
    delete entry.mtimeMs;
    delete entry.dev;
    delete entry.ino;
  }
}

export async function createStateBackup({ sourceDir, backupDir, limits } = {}) {
  if (!sourceDir || !backupDir) throw new TypeError('sourceDir and backupDir are required');
  const sourceRoot = path.resolve(sourceDir);
  const backupRoot = path.resolve(backupDir);
  if (sourceRoot === backupRoot || isInside(sourceRoot, backupRoot) || isInside(backupRoot, sourceRoot)) {
    throw backupError('STATE_BACKUP_PATH_OVERLAP', 'Backup source and destination must be separate directories');
  }
  const sourceStats = await statsOrNull(sourceRoot);
  if (!sourceStats?.isDirectory()) {
    throw backupError('STATE_BACKUP_SOURCE_INVALID', 'Backup source must be an existing directory');
  }
  if (await statsOrNull(backupRoot)) {
    throw backupError('STATE_BACKUP_DESTINATION_EXISTS', 'Backup destination must not already exist');
  }
  await assertManagerStopped(sourceRoot);
  const normalizedLimits = normalizeLimits(limits);
  const collected = await collectTree(sourceRoot, normalizedLimits);
  const payloadRoot = path.join(backupRoot, 'payload');
  try {
    await mkdir(path.dirname(backupRoot), { recursive: true, mode: 0o700 });
    await mkdir(backupRoot, { recursive: false, mode: 0o700 });
    await mkdir(payloadRoot, { recursive: false, mode: 0o700 });
    await copyManifestEntries({
      entries: collected.entries,
      sourceRoot,
      destinationRoot: payloadRoot,
      verifySourceIdentity: true
    });
    const manifest = {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      backupId: `backup_${randomUUID().replaceAll('-', '')}`,
      createdAt: new Date().toISOString(),
      fileCount: collected.fileCount,
      totalBytes: collected.totalBytes,
      entries: collected.entries
    };
    await writeJsonExclusive(path.join(backupRoot, 'manifest.json'), manifest);
    await verifyStateBackup({ backupDir: backupRoot, limits: normalizedLimits });
    return structuredClone(manifest);
  } catch (error) {
    await rm(backupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    throw error;
  }
}

export async function verifyStateBackup({ backupDir, limits } = {}) {
  if (!backupDir) throw new TypeError('backupDir is required');
  const backupRoot = path.resolve(backupDir);
  const payloadRoot = path.join(backupRoot, 'payload');
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(await readFile(path.join(backupRoot, 'manifest.json'), 'utf8')));
  } catch (error) {
    if (error instanceof StateBackupError) throw error;
    throw backupError('STATE_BACKUP_MANIFEST_INVALID', 'Backup manifest cannot be read');
  }
  const normalizedLimits = normalizeLimits(limits);
  if (manifest.fileCount > normalizedLimits.maxFiles || manifest.totalBytes > normalizedLimits.maxBytes) {
    throw backupError('STATE_BACKUP_LIMIT_EXCEEDED', 'Backup exceeds the configured file or byte limit');
  }
  const actual = await collectTree(payloadRoot, normalizedLimits);
  const expectedPaths = manifest.entries.map((entry) => `${entry.type}:${entry.path}`);
  const actualPaths = actual.entries.map((entry) => `${entry.type}:${entry.path}`);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw backupError('STATE_BACKUP_CONTENT_MISMATCH', 'Backup payload paths do not match its manifest');
  }
  for (const entry of manifest.entries.filter((item) => item.type === 'file')) {
    const target = path.join(payloadRoot, ...entry.path.split('/'));
    const stats = await lstat(target);
    if (stats.size !== entry.size || await sha256File(target) !== entry.sha256) {
      throw backupError('STATE_BACKUP_CONTENT_MISMATCH', `Backup payload is corrupted: ${entry.path}`);
    }
  }
  return structuredClone(manifest);
}

export async function restoreStateBackup({ backupDir, destinationDir, limits } = {}) {
  if (!backupDir || !destinationDir) throw new TypeError('backupDir and destinationDir are required');
  const backupRoot = path.resolve(backupDir);
  const destinationRoot = path.resolve(destinationDir);
  if (backupRoot === destinationRoot || isInside(backupRoot, destinationRoot) || isInside(destinationRoot, backupRoot)) {
    throw backupError('STATE_BACKUP_PATH_OVERLAP', 'Backup and restore destination must be separate directories');
  }
  if (await statsOrNull(destinationRoot)) {
    throw backupError('STATE_RESTORE_DESTINATION_EXISTS', 'Restore destination must not already exist');
  }
  const manifest = await verifyStateBackup({ backupDir: backupRoot, limits });
  try {
    await mkdir(path.dirname(destinationRoot), { recursive: true, mode: 0o700 });
    await mkdir(destinationRoot, { recursive: false, mode: 0o700 });
    await copyManifestEntries({
      entries: manifest.entries.map((entry) => ({ ...entry })),
      sourceRoot: path.join(backupRoot, 'payload'),
      destinationRoot,
      verifySourceIdentity: false
    });
    const restored = await collectTree(destinationRoot, normalizeLimits(limits));
    if (
      restored.fileCount !== manifest.fileCount || restored.totalBytes !== manifest.totalBytes ||
      JSON.stringify(restored.entries.map((entry) => `${entry.type}:${entry.path}`)) !==
        JSON.stringify(manifest.entries.map((entry) => `${entry.type}:${entry.path}`))
    ) {
      throw backupError('STATE_RESTORE_CONTENT_MISMATCH', 'Restored state tree does not match the backup manifest');
    }
    for (const entry of manifest.entries.filter((item) => item.type === 'file')) {
      const target = path.join(destinationRoot, ...entry.path.split('/'));
      if (await sha256File(target) !== entry.sha256) {
        throw backupError('STATE_RESTORE_CONTENT_MISMATCH', `Restored file hash does not match: ${entry.path}`);
      }
    }
    return structuredClone(manifest);
  } catch (error) {
    await rm(destinationRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    throw error;
  }
}
