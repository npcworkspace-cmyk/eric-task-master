import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TaskServiceError } from './task-service-error.mjs';

const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTICS_MANIFEST_BYTES = 64 * 1024;

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sameFileIdentity(left, right) {
  return typeof left?.dev === 'bigint' && typeof left?.ino === 'bigint' &&
    typeof right?.dev === 'bigint' && typeof right?.ino === 'bigint' &&
    left.ino > 0n && right.ino > 0n &&
    left.dev === right.dev && left.ino === right.ino;
}

export function createTaskCheckpointStore({ root }) {
  if (!root) throw new TypeError('Task checkpoint store requires root');
  async function inspectResumeCheckpoint(task) {
    const expected = path.join(root, task.id, 'checkpoint.json');
    let handle;
    try {
      const before = await lstat(expected, { bigint: true });
      if (
        !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
        before.size <= 0n || before.size > BigInt(MAX_CHECKPOINT_BYTES)
      ) throw new Error('invalid checkpoint');
      handle = await open(expected, 'r');
      const opened = await handle.stat({ bigint: true });
      if (!sameFileIdentity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
        throw new Error('checkpoint changed');
      }
      const source = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!sameFileIdentity(opened, after) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs) {
        throw new Error('checkpoint changed');
      }
      const record = JSON.parse(source.toString('utf8'));
      if (
        !record || typeof record !== 'object' || Array.isArray(record) ||
        record.taskId !== task.id || record.attempt !== task.attempt ||
        typeof record.savedAt !== 'string' || Number.isNaN(Date.parse(record.savedAt)) ||
        !Object.hasOwn(record, 'data')
      ) throw new Error('invalid checkpoint record');
      return {
        path: expected,
        attempt: record.attempt,
        savedAt: record.savedAt,
        sha256: createHash('sha256').update(source).digest('hex'),
        sizeBytes: source.byteLength,
        source
      };
    } catch {
      throw new TaskServiceError('TASK_CHECKPOINT_INVALID', 'Task checkpoint is unavailable or unstable', 409);
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function inspectDiagnosticFile(task, entry, kind) {
    if (
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      typeof entry.relativePath !== 'string' || !entry.relativePath || entry.relativePath.includes('\0') ||
      path.isAbsolute(entry.relativePath) ||
      typeof entry.reason !== 'string' || !entry.reason.trim() || entry.reason.length > 64 ||
      typeof entry.at !== 'string' || Number.isNaN(Date.parse(entry.at))
    ) return null;
    const relativePath = path.normalize(entry.relativePath);
    if (
      relativePath === '.' || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) ||
      (kind === 'screenshot' && !['.png', '.jpg', '.jpeg'].includes(path.extname(relativePath).toLowerCase())) ||
      (kind === 'observation' && path.extname(relativePath).toLowerCase() !== '.json')
    ) return null;
    const candidate = path.resolve(task.outputDir, relativePath);
    if (!inside(path.resolve(task.outputDir), candidate)) return null;
    let handle;
    try {
      const before = await lstat(candidate, { bigint: true });
      if (
        !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
        before.size <= 0n || before.size > BigInt(64 * 1024 * 1024)
      ) return null;
      const outputRoot = await realpath(task.outputDir);
      const canonicalCandidate = await realpath(candidate);
      if (!inside(outputRoot, canonicalCandidate)) return null;
      handle = await open(candidate, 'r');
      const opened = await handle.stat({ bigint: true });
      if (!sameFileIdentity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
        return null;
      }
      return { path: candidate, reason: entry.reason, at: entry.at };
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function inspectDiagnosticsManifest(task) {
    const manifestPath = path.join(root, task.id, 'diagnostics.json');
    let handle;
    try {
      const before = await lstat(manifestPath, { bigint: true });
      if (
        !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
        before.size <= 0n || before.size > BigInt(MAX_DIAGNOSTICS_MANIFEST_BYTES)
      ) return null;
      handle = await open(manifestPath, 'r');
      const opened = await handle.stat({ bigint: true });
      if (!sameFileIdentity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
        return null;
      }
      const record = JSON.parse((await handle.readFile()).toString('utf8'));
      const after = await handle.stat({ bigint: true });
      if (
        !sameFileIdentity(opened, after) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs ||
        record?.version !== 2 || record.taskId !== task.id || record.attempt !== task.attempt
      ) return null;
      const screenshot = await inspectDiagnosticFile(task, record.screenshot, 'screenshot');
      const observation = await inspectDiagnosticFile(task, record.observation, 'observation');
      if (screenshot) screenshot.attempt = record.attempt;
      if (observation) observation.attempt = record.attempt;
      return screenshot || observation ? { screenshot, observation } : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }


  async function verifyResumeCheckpoint(task) {
    const expected = path.join(root, task.id, 'checkpoint.json');
    if (
      typeof task.checkpoint?.path !== 'string' ||
      path.resolve(task.checkpoint.path) !== path.resolve(expected)
    ) {
      throw new TaskServiceError('TASK_CHECKPOINT_INVALID', 'Task checkpoint is unavailable or invalid', 409);
    }
    const current = await inspectResumeCheckpoint(task);
    if (
      (typeof task.checkpoint.sha256 === 'string' && task.checkpoint.sha256 !== current.sha256) ||
      (Number.isSafeInteger(task.checkpoint.sizeBytes) && task.checkpoint.sizeBytes !== current.sizeBytes) ||
      (typeof task.checkpoint.savedAt === 'string' && task.checkpoint.savedAt !== current.savedAt)
    ) {
      throw new TaskServiceError('TASK_CHECKPOINT_INVALID', 'Task checkpoint changed after it was recorded', 409);
    }
    return current;
  }

  async function createResumeInput(task, checkpoint) {
    const targetAttempt = task.attempt + 1;
    const source = checkpoint.source;
    if (!Buffer.isBuffer(source)) {
      throw new TaskServiceError('TASK_CHECKPOINT_INVALID', 'Task checkpoint could not be frozen for resume', 409);
    }
    const snapshotPath = path.join(
      root,
      task.id,
      `resume-input-attempt-${targetAttempt}-${randomUUID()}.json`
    );
    let handle;
    try {
      handle = await open(snapshotPath, 'wx', 0o600);
      await handle.writeFile(source);
      await handle.sync();
    } catch {
      throw new TaskServiceError('TASK_CHECKPOINT_INVALID', 'Task checkpoint could not be frozen for resume', 409);
    } finally {
      await handle?.close().catch(() => {});
    }
    return {
      path: snapshotPath,
      sourceAttempt: task.attempt,
      targetAttempt,
      savedAt: checkpoint.savedAt,
      sha256: checkpoint.sha256,
      sizeBytes: checkpoint.sizeBytes
    };
  }

  async function verifyResumeModule(task) {
    if (typeof task.modulePath !== 'string' || typeof task.taskTypeSha256 !== 'string') {
      throw new TaskServiceError('TASK_RESUME_CONTEXT_MISSING', 'Task module snapshot metadata is unavailable', 409);
    }
    try {
      const before = await lstat(task.modulePath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('invalid module');
      const source = await readFile(task.modulePath);
      const after = await lstat(task.modulePath, { bigint: true });
      if (
        !sameFileIdentity(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
        createHash('sha256').update(source).digest('hex') !== task.taskTypeSha256
      ) throw new Error('module changed');
    } catch {
      throw new TaskServiceError('TASK_MODULE_CHANGED', 'Task module snapshot changed or is unavailable', 409);
    }
  }

  async function verifyResumeContext(task) {
    if (!Object.hasOwn(task, 'input') || !task.input || typeof task.input !== 'object' || Array.isArray(task.input)) {
      throw new TaskServiceError('TASK_RESUME_CONTEXT_MISSING', 'Task input required for resume is unavailable', 409);
    }
    if (
      task.timeoutMs !== null && task.timeoutMs !== undefined &&
      (!Number.isSafeInteger(task.timeoutMs) || task.timeoutMs < 1_000)
    ) {
      throw new TaskServiceError('TASK_RESUME_CONTEXT_MISSING', 'Task timeout required for resume is invalid', 409);
    }
    const expectedOutput = path.join(root, task.id, 'output');
    if (typeof task.outputDir !== 'string' || path.resolve(task.outputDir) !== path.resolve(expectedOutput)) {
      throw new TaskServiceError('TASK_RESUME_CONTEXT_MISSING', 'Task output context required for resume is unavailable', 409);
    }
    const outputStats = await lstat(expectedOutput).catch(() => null);
    if (!outputStats?.isDirectory() || outputStats.isSymbolicLink()) {
      throw new TaskServiceError('TASK_RESUME_CONTEXT_MISSING', 'Task output context required for resume is unavailable', 409);
    }
  }

  return Object.freeze({
    createResumeInput,
    inspectResumeCheckpoint,
    readDiagnosticsPointers: inspectDiagnosticsManifest,
    verifyResumeCheckpoint,
    verifyResumeContext,
    verifyResumeModule
  });
}

