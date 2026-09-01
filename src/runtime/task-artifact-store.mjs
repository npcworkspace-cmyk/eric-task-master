import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { callerIdentity, canAccess } from './task-record-policy.mjs';
import { TaskServiceError } from './task-service-error.mjs';

export const MAX_ARTIFACTS = 100;
export const MAX_ARTIFACT_CHUNK_BYTES = 48 * 1024;

const ARTIFACT_MIME_TYPES = Object.freeze({
  '.csv': 'text/csv',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.jsonl': 'application/x-ndjson',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp'
});

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function artifactId(taskIdValue, relativePath) {
  return `artifact_${createHash('sha256')
    .update(taskIdValue)
    .update('\0')
    .update(relativePath)
    .digest('hex')
    .slice(0, 32)}`;
}

export function declaredArtifactFiles(task) {
  const evidence = Array.isArray(task.result?.evidence) ? task.result.evidence : [];
  const seen = new Set();
  const files = [];
  for (const item of evidence) {
    if (
      !item ||
      item.kind !== 'artifact' ||
      item.agentVisible === false ||
      typeof item.file !== 'string' ||
      !item.file ||
      item.file.includes('\0') ||
      path.isAbsolute(item.file)
    ) continue;
    const normalized = path.normalize(item.file);
    if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
    if (files.length >= MAX_ARTIFACTS) break;
  }
  return files;
}

function artifactMimeType(filePath) {
  return ARTIFACT_MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isTextMimeType(mimeType) {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/x-ndjson',
    'image/svg+xml'
  ].includes(mimeType);
}

export function createTaskArtifactStore({
  root,
  getTask,
  awaitReady,
  awaitTaskPersistence,
  reconcileTaskForRead,
  normalizeDiagnosticHistory,
  artifactValidationHook = null
}) {
  if (!root || typeof getTask !== 'function' || typeof awaitReady !== 'function') {
    throw new TypeError('Task artifact store requires root, getTask, and awaitReady');
  }
  const artifactDigestCache = new Map();

  function artifactDeclarations(task, { includeUnverifiedResult = false } = {}) {
    const resultVerified = task.state === 'completed' && task.completion?.integrity !== 'invalid' &&
      typeof task.completion?.verifiedAt === 'string';
    const results = resultVerified || includeUnverifiedResult
      ? declaredArtifactFiles(task).map((relativePath) => ({ relativePath, kind: 'result' }))
      : [];
    normalizeDiagnosticHistory(task);
    const diagnosticAttempts = [
      ...task.diagnosticHistory,
      {
        attempt: task.attempt,
        screenshot: task.lastScreenshot?.attempt === task.attempt ? task.lastScreenshot : null,
        observation: task.lastObservation?.attempt === task.attempt ? task.lastObservation : null
      }
    ];
    const byAttempt = new Map();
    for (const entry of diagnosticAttempts) {
      if (entry?.screenshot || entry?.observation) byAttempt.set(entry.attempt, entry);
    }
    const diagnostics = [];
    const addDiagnostic = (pointer, kind, attempt, historical) => {
      if (typeof pointer?.path !== 'string') return;
      const relativePath = path.relative(task.outputDir, pointer.path);
      if (
        !relativePath || path.isAbsolute(relativePath) || relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        diagnostics.some((item) => item.relativePath === relativePath) ||
        results.some((item) => item.relativePath === relativePath)
      ) return;
      diagnostics.push({ relativePath, kind, attempt, historical });
    };
    for (const entry of [...byAttempt.values()].sort((left, right) => right.attempt - left.attempt)) {
      const historical = entry.attempt !== task.attempt;
      addDiagnostic(entry.observation, 'diagnostic-observation', entry.attempt, historical);
      addDiagnostic(entry.screenshot, 'diagnostic-screenshot', entry.attempt, historical);
    }
    return [...diagnostics, ...results].slice(0, MAX_ARTIFACTS).map(({ relativePath, kind, attempt, historical }) => ({
      id: artifactId(task.id, relativePath),
      relativePath,
      name: `${historical ? `attempt-${attempt}-` : ''}${path.basename(relativePath)}`.slice(0, 255),
      kind,
      mimeType: artifactMimeType(relativePath),
      agentVisible: true
    }));
  }

  function sameFileIdentity(left, right) {
    return typeof left?.dev === 'bigint' && typeof left?.ino === 'bigint' &&
      typeof right?.dev === 'bigint' && typeof right?.ino === 'bigint' &&
      left.ino > 0n && right.ino > 0n &&
      left.dev === right.dev && left.ino === right.ino;
  }

  function sameStableArtifactMetadata(left, right) {
    return sameFileIdentity(left, right) &&
      left.size === right.size && left.mtimeNs === right.mtimeNs &&
      left.ctimeNs === right.ctimeNs && left.birthtimeNs === right.birthtimeNs;
  }

  function cacheableArtifactMetadata(stats) {
    return typeof stats?.ctimeNs === 'bigint' && stats.ctimeNs > 0n;
  }

  async function hashOpenFile(handle, sizeBytes) {
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, sizeBytes)));
    let offset = 0;
    while (offset < sizeBytes) {
      const length = Math.min(buffer.length, sizeBytes - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) throw new Error('artifact ended while hashing');
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return digest.digest('hex');
  }

  function artifactDigestKey(task, declaration, stats, expectedDigest) {
    if (!cacheableArtifactMetadata(stats)) return null;
    return [
      task.id,
      task.attempt,
      declaration.id,
      expectedDigest,
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs,
      stats.ctimeNs,
      stats.birthtimeNs
    ].join(':');
  }

  function cacheArtifactDigest(task, declaration, stats, digest, expectedDigest = digest) {
    const key = artifactDigestKey(task, declaration, stats, expectedDigest);
    if (!key) return digest;
    artifactDigestCache.delete(key);
    artifactDigestCache.set(key, digest);
    while (artifactDigestCache.size > 1_024) {
      artifactDigestCache.delete(artifactDigestCache.keys().next().value);
    }
    return digest;
  }

  async function cachedArtifactDigest(task, declaration, handle, stats, expectedDigest) {
    const key = artifactDigestKey(task, declaration, stats, expectedDigest);
    const cached = artifactDigestCache.get(key);
    if (cached) {
      artifactDigestCache.delete(key);
      artifactDigestCache.set(key, cached);
      return cached;
    }
    const digest = await hashOpenFile(handle, Number(stats.size));
    const afterHash = await handle.stat({ bigint: true });
    if (!sameStableArtifactMetadata(stats, afterHash)) {
      throw new TaskServiceError(
        'ARTIFACT_INTEGRITY_FAILED',
        'Completed task evidence changed while being verified',
        409
      );
    }
    try {
      await assertArtifactPathIdentity(task, declaration, stats);
    } catch {
      throw new TaskServiceError(
        'ARTIFACT_INTEGRITY_FAILED',
        'Completed task evidence path changed after verification',
        409
      );
    }
    if (digest !== expectedDigest) {
      throw new TaskServiceError(
        'ARTIFACT_INTEGRITY_FAILED',
        'Completed task evidence changed after verification',
        409
      );
    }
    return cacheArtifactDigest(task, declaration, afterHash, digest, expectedDigest);
  }

  async function validatedOutputRoot(task) {
    const canonicalStateRoot = await realpath(root);
    const taskRoot = path.join(root, task.id);
    const taskRootStats = await lstat(taskRoot);
    if (!taskRootStats.isDirectory() || taskRootStats.isSymbolicLink()) {
      throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
    }
    const canonicalTaskRoot = await realpath(taskRoot);
    if (!inside(canonicalStateRoot, canonicalTaskRoot)) {
      throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
    }
    const outputRootStats = await lstat(task.outputDir);
    if (!outputRootStats.isDirectory() || outputRootStats.isSymbolicLink()) {
      throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
    }
    const canonicalOutputRoot = await realpath(task.outputDir);
    if (!inside(canonicalTaskRoot, canonicalOutputRoot)) {
      throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
    }
    return canonicalOutputRoot;
  }

  async function assertArtifactPathIdentity(task, declaration, expectedStats) {
    const candidate = path.resolve(task.outputDir, declaration.relativePath);
    const canonicalOutputRoot = await validatedOutputRoot(task);
    const [current, canonical] = await Promise.all([
      lstat(candidate, { bigint: true }),
      realpath(candidate)
    ]);
    if (!inside(canonicalOutputRoot, canonical)) throw new Error('artifact path escaped output');
    const canonicalStats = await lstat(canonical, { bigint: true });
    if (
      !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
      !canonicalStats.isFile() || canonicalStats.isSymbolicLink() || canonicalStats.nlink !== 1n ||
      !sameStableArtifactMetadata(expectedStats, current) ||
      !sameStableArtifactMetadata(expectedStats, canonicalStats)
    ) throw new Error('artifact path changed while being verified');
  }

  async function openValidatedArtifact(task, declaration, { verifyCompletionAnchor = true } = {}) {
    let handle;
    try {
      const resolvedOutputRoot = path.resolve(task.outputDir);
      const candidate = path.resolve(resolvedOutputRoot, declaration.relativePath);
      if (!inside(resolvedOutputRoot, candidate)) {
        throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
      }
      const canonicalOutputRoot = await validatedOutputRoot(task);
      const before = await lstat(candidate, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.ino <= 0n) {
        throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
      }
      await artifactValidationHook?.({ stage: 'after-lstat', taskId: task.id, candidate });

      handle = await open(candidate, 'r');
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() || opened.nlink !== 1n || opened.ino <= 0n ||
        opened.size > BigInt(Number.MAX_SAFE_INTEGER) || !sameStableArtifactMetadata(before, opened)
      ) {
        throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
      }
      const canonical = await realpath(candidate);
      if (!inside(canonicalOutputRoot, canonical)) {
        throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
      }
      const [current, canonicalStats] = await Promise.all([
        lstat(candidate, { bigint: true }),
        lstat(canonical, { bigint: true })
      ]);
      if (
        !current.isFile() || current.isSymbolicLink() || current.nlink !== 1n ||
        !canonicalStats.isFile() || canonicalStats.isSymbolicLink() || canonicalStats.nlink !== 1n ||
        !sameStableArtifactMetadata(opened, current) ||
        !sameStableArtifactMetadata(opened, canonicalStats)
      ) {
        throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
      }
      await artifactValidationHook?.({ stage: 'after-validation', taskId: task.id, candidate });
      if (
        verifyCompletionAnchor && declaration.kind === 'result' &&
        Array.isArray(task.completion?.artifacts)
      ) {
        const anchor = task.completion.artifacts.find((item) => item?.artifactId === declaration.id);
        if (
          !anchor || !Number.isSafeInteger(anchor.sizeBytes) || anchor.sizeBytes !== Number(opened.size) ||
          typeof anchor.sha256 !== 'string' ||
          anchor.sha256 !== await cachedArtifactDigest(task, declaration, handle, opened, anchor.sha256)
        ) {
          throw new TaskServiceError('ARTIFACT_INTEGRITY_FAILED', 'Completed task evidence changed after verification', 409);
        }
        const afterHash = await handle.stat({ bigint: true });
        if (!sameStableArtifactMetadata(opened, afterHash)) {
          throw new TaskServiceError('ARTIFACT_INTEGRITY_FAILED', 'Completed task evidence changed while being verified', 409);
        }
        try {
          await assertArtifactPathIdentity(task, declaration, opened);
        } catch {
          throw new TaskServiceError('ARTIFACT_INTEGRITY_FAILED', 'Completed task evidence path changed after verification', 409);
        }
      }
      const { relativePath: _relativePath, ...publicDeclaration } = declaration;
      return {
        handle,
        stats: opened,
        artifact: { ...publicDeclaration, sizeBytes: Number(opened.size) }
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof TaskServiceError) throw error;
      throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
    }
  }

  async function collectArtifacts(task) {
    const artifacts = [];
    for (const declaration of artifactDeclarations(task)) {
      let opened;
      try {
        opened = await openValidatedArtifact(task, declaration);
        artifacts.push(opened.artifact);
      } catch (error) {
        if (error?.code === 'ARTIFACT_INTEGRITY_FAILED') throw error;
      } finally {
        await opened?.handle.close().catch(() => {});
      }
    }
    return artifacts;
  }

  async function listArtifacts(id, suppliedCaller = {}) {
    await awaitReady();
    const caller = callerIdentity(suppliedCaller);
    const task = getTask(id);
    if (!task || task.deletedAt || !canAccess(task, caller)) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    await awaitTaskPersistence(id);
    await reconcileTaskForRead(task);
    await awaitTaskPersistence(id);
    if (task.completion?.integrity === 'invalid') {
      throw new TaskServiceError('ARTIFACT_INTEGRITY_FAILED', 'Completed task evidence changed after verification', 409);
    }
    return collectArtifacts(task);
  }

  async function readArtifact(id, requestedArtifactId, options = {}, suppliedCaller = {}) {
    await awaitReady();
    const caller = callerIdentity(suppliedCaller);
    const task = getTask(id);
    if (!task || task.deletedAt || !canAccess(task, caller)) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    await awaitTaskPersistence(id);
    await reconcileTaskForRead(task);
    await awaitTaskPersistence(id);
    if (task.completion?.integrity === 'invalid') {
      throw new TaskServiceError('ARTIFACT_INTEGRITY_FAILED', 'Completed task evidence changed after verification', 409);
    }
    if (typeof requestedArtifactId !== 'string' || !/^artifact_[a-f0-9]{32}$/.test(requestedArtifactId)) {
      throw new TaskServiceError('INVALID_ARTIFACT_ID', 'Artifact ID is invalid');
    }
    const offset = options.offset ?? 0;
    const maxBytes = options.maxBytes ?? MAX_ARTIFACT_CHUNK_BYTES;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TaskServiceError('INVALID_ARTIFACT_OFFSET', 'Artifact offset must be a non-negative integer');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ARTIFACT_CHUNK_BYTES) {
      throw new TaskServiceError(
        'INVALID_ARTIFACT_LIMIT',
        `Artifact maxBytes must be from 1 to ${MAX_ARTIFACT_CHUNK_BYTES}`
      );
    }
    const declaration = artifactDeclarations(task).find((candidate) => candidate.id === requestedArtifactId);
    if (!declaration) {
      throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
    }

    let opened;
    try {
      opened = await openValidatedArtifact(task, declaration);
      const { handle, stats, artifact } = opened;
      const sizeBytes = Number(stats.size);
      if (offset > sizeBytes) {
        throw new TaskServiceError('ARTIFACT_OFFSET_OUT_OF_RANGE', 'Artifact offset exceeds its size', 416);
      }
      const requestedBytes = Math.min(maxBytes, sizeBytes - offset);
      const buffer = Buffer.alloc(requestedBytes);
      const { bytesRead } = requestedBytes
        ? await handle.read(buffer, 0, requestedBytes, offset)
        : { bytesRead: 0 };
      const afterRead = await handle.stat({ bigint: true });
      if (!afterRead.isFile() || afterRead.nlink !== 1n || !sameStableArtifactMetadata(stats, afterRead)) {
        const anchoredResult = declaration.kind === 'result' && Array.isArray(task.completion?.artifacts);
        throw new TaskServiceError(
          anchoredResult ? 'ARTIFACT_INTEGRITY_FAILED' : 'ARTIFACT_NOT_FOUND',
          anchoredResult
            ? 'Completed task evidence changed while it was being read'
            : 'Artifact changed while it was being read',
          anchoredResult ? 409 : 404
        );
      }
      let consumed = bytesRead;
      let encoding = 'base64';
      let chunk = buffer.subarray(0, bytesRead).toString('base64');
      if (isTextMimeType(artifact.mimeType)) {
        for (let trim = 0; trim <= Math.min(3, bytesRead); trim += 1) {
          const candidate = buffer.subarray(0, bytesRead - trim);
          if (candidate.length === 0 && bytesRead > 0) continue;
          try {
            chunk = new TextDecoder('utf-8', { fatal: true }).decode(candidate);
            consumed = candidate.length;
            encoding = 'utf8';
            break;
          } catch {
            // Back up to a UTF-8 boundary; arbitrary offsets fall back to bounded base64.
          }
        }
      }
      const nextOffset = offset + consumed;
      return {
        artifact,
        offset,
        nextOffset,
        eof: nextOffset >= sizeBytes,
        encoding,
        chunk
      };
    } finally {
      await opened?.handle.close().catch(() => {});
    }
  }

  return Object.freeze({
    artifactDeclarations,
    assertArtifactPathIdentity,
    cacheArtifactDigest,
    collectArtifacts,
    hashOpenFile,
    listArtifacts,
    openValidatedArtifact,
    readArtifact,
    sameFileIdentity,
    sameStableArtifactMetadata
  });
}
