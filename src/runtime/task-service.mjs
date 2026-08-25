import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBehaviorMode, publicTask, TERMINAL_TASK_STATES } from '../contracts.mjs';
import { normalizeAgentName } from '../lib/agent-token.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';
import { isReservedAgentClientId } from '../lib/principal.mjs';
import { TaskTypeRegistry } from '../lib/task-type-registry.mjs';
import { removeCleanupReceipt, verifyCleanupReceipt } from '../lib/cleanup-receipt.mjs';

const TASK_WORKER = fileURLToPath(new URL('./task-worker.mjs', import.meta.url));
const PROFILE_WORKER = fileURLToPath(new URL('./profile-worker.mjs', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ACCEPTANCE_TASK = fileURLToPath(new URL('../../examples/tasks/acceptance-task.mjs', import.meta.url));
const READ_PAGE_TASK = fileURLToPath(new URL('../../examples/tasks/read-page-task.mjs', import.meta.url));
const OBSERVE_PAGE_TASK = fileURLToPath(new URL('../../examples/tasks/observe-page-task.mjs', import.meta.url));
const DURABLE_DELAY_TASK = fileURLToPath(new URL('../../examples/tasks/durable-delay-task.mjs', import.meta.url));
const HANDOFF_ACCEPTANCE_TASK = fileURLToPath(new URL('../../examples/tasks/handoff-acceptance-task.mjs', import.meta.url));
const LEASE_TTL_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 65_000;
const DIAGNOSTIC_GRACE_MS = 15_000;
const PROGRESS_STALL_MS = 2 * 60_000;
const PROGRESS_FAILURE_MS = 10 * 60_000;
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_ARTIFACTS = 100;
const MAX_ARTIFACT_CHUNK_BYTES = 48 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTICS_MANIFEST_BYTES = 64 * 1024;
const SAFE_EVIDENCE_KINDS = new Set(['artifact', 'count', 'hash', 'message', 'note', 'url']);
const MAX_ATTEMPTS = 100;
const RESUME_KEY_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;
const HANDOFF_ID_PATTERN = /^handoff_[a-f0-9]{32}$/;
const PROFILE_CLEANUP_QUEUE_REASON = 'Waiting for confirmed Profile cleanup';
const PROFILE_BUSY_QUEUE_REASON = 'Waiting for Profile to become idle';
const CLEANUP_RECONCILE_INTERVAL_MS = 2_000;
const CLEANUP_RECONCILE_GRACE_MS = 60_000;
const PROGRESS_PHASE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const WORKER_ACTIVITY_PHASES = new Set(['navigating', 'clicking', 'typing', 'hovering', 'scrolling', 'working']);
const WORKER_ACTIVITY_STATUSES = new Set(['active', 'succeeded', 'unknown']);
const LIFECYCLE_ACTIVITY_STATUS = Object.freeze({
  queued: 'waiting',
  acquiring_profile: 'active',
  starting_browser: 'active',
  running: 'active',
  waiting_user: 'waiting',
  cooling_down: 'waiting',
  recovering: 'active',
  verifying: 'active',
  cleaning_up: 'active',
  completed: 'succeeded',
  failed: 'unknown',
  cancelled: 'cancelled'
});

function resolveProfileBehavior(profile) {
  const behavior = profile.kind === 'persistent'
    ? 'human'
    : (profile.defaultBehavior ?? 'adaptive');
  if (!isBehaviorMode(behavior)) {
    throw new TaskServiceError(
      'INVALID_PROFILE_BEHAVIOR',
      'Profile behavior must be fast, human, or adaptive'
    );
  }
  return behavior;
}

export const TASK_SERVICE_DEADLINES = Object.freeze({
  workerCleanupGraceMs: 30_000,
  workerHardKillGraceMs: 5_000,
  profileOpenMs: 30_000,
  profileCloseMs: 25_000,
  profileKillGraceMs: 5_000
});

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

export class TaskServiceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'TaskServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function lifecycleActivity(phase, at = nowIso()) {
  return {
    phase,
    status: LIFECYCLE_ACTIVITY_STATUS[phase] || 'active',
    updatedAt: at
  };
}

function workerActivity(value) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    !WORKER_ACTIVITY_PHASES.has(value.phase) ||
    !WORKER_ACTIVITY_STATUSES.has(value.status)
  ) return null;
  return { phase: value.phase, status: value.status, updatedAt: nowIso() };
}

function clone(value) {
  return structuredClone(value);
}

function callerIdentity(caller = {}) {
  if (caller.role === 'manager-admin') {
    return { role: 'manager-admin', clientId: caller.clientId || 'manager-admin' };
  }
  if (
    caller.role === 'agent' && typeof caller.clientId === 'string' && caller.clientId &&
    !isReservedAgentClientId(caller.clientId)
  ) {
    let agentName;
    try {
      agentName = normalizeAgentName(caller.agentName ?? caller.clientId);
    } catch {
      throw new TaskServiceError('TASK_ACCESS_DENIED', 'Agent display identity is invalid', 403);
    }
    return { role: 'agent', clientId: caller.clientId, agentName };
  }
  throw new TaskServiceError('TASK_ACCESS_DENIED', 'Task operation is not allowed for this caller', 403);
}

function profileCallerIdentity(caller = {}) {
  if (
    ['manager-admin', 'agent'].includes(caller.role) &&
    typeof caller.clientId === 'string' && caller.clientId &&
    !(caller.role === 'agent' && isReservedAgentClientId(caller.clientId))
  ) {
    return { role: caller.role, clientId: caller.clientId };
  }
  throw new TaskServiceError('PROFILE_ACCESS_DENIED', 'Profile operation is not allowed for this caller', 403);
}

function canAccess(task, caller) {
  return caller.role === 'manager-admin' || (
    caller.role === 'agent' && task.ownerRole === 'agent' && task.ownerClientId === caller.clientId
  );
}

function isTaskOwner(task, caller) {
  return task.ownerRole === caller.role && task.ownerClientId === caller.clientId;
}

function isSamePrincipal(entry, caller) {
  return entry?.ownerRole === caller.role && entry?.ownerClientId === caller.clientId;
}

function canUseProfile(profile, caller) {
  if (caller.role === 'manager-admin') return true;
  if (caller.role !== 'agent') return false;
  return profile?.ownerClientId === caller.clientId || (profile?.access || 'shared') === 'shared';
}

function requireProfileUse(profile, caller) {
  if (!canUseProfile(profile, caller)) {
    throw new TaskServiceError(
      'PROFILE_ACCESS_DENIED',
      'This Agent is not authorized to use this Profile',
      403
    );
  }
  return profile;
}

function taskLeaseAccess(task) {
  return task.ownerRole === 'manager-admin'
    ? {}
    : { authorizedClientId: task.ownerClientId };
}

function taskTypeMatchesDomain(taskType, domain) {
  if (!domain) return true;
  const candidate = domain.trim().toLowerCase();
  return (taskType.domains || []).some((registered) => (
    registered === candidate ||
    (registered.startsWith('*.') && candidate.endsWith(registered.slice(1)))
  ));
}

function filterTaskTypes(taskTypes, filters = {}) {
  const query = typeof filters.query === 'string' ? filters.query.trim().toLowerCase() : '';
  const domain = typeof filters.domain === 'string' ? filters.domain.trim().toLowerCase() : '';
  const intent = typeof filters.intent === 'string' ? filters.intent.trim().toLowerCase() : '';
  if (query.length > 120 || domain.length > 253 || intent.length > 80) {
    throw new TaskServiceError('INVALID_TASK_TYPE_FILTER', 'Task type filters exceed their bounded length');
  }
  return taskTypes.filter((taskType) => {
    const searchable = [
      taskType.id,
      taskType.name,
      taskType.title,
      taskType.description,
      ...(taskType.tags || []),
      ...(taskType.intents || [])
    ].filter(Boolean).join(' ').toLowerCase();
    return (!query || searchable.includes(query)) &&
      (!intent || (taskType.intents || []).includes(intent)) &&
      taskTypeMatchesDomain(taskType, domain);
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function inputSchemaError(location, message) {
  throw new TaskServiceError(
    'TASK_INPUT_SCHEMA_FAILED',
    `Task input ${location} ${message}`,
    400
  );
}

function validateTaskInput(value, schema, location = '$', depth = 0) {
  if (!schema || typeof schema !== 'object') return;
  if (depth > 20) inputSchemaError(location, 'is nested too deeply');
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    inputSchemaError(location, 'is not one of the allowed values');
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = value === null
      ? 'null'
      : Array.isArray(value)
        ? 'array'
        : Number.isInteger(value)
          ? 'integer'
          : typeof value === 'number'
            ? 'number'
            : typeof value;
    const matches = types.includes(actual) || (actual === 'integer' && types.includes('number'));
    if (!matches) inputSchemaError(location, `must be ${types.join(' or ')}`);
  }
  if (typeof value === 'string') {
    if (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength) {
      inputSchemaError(location, `must contain at least ${schema.minLength} characters`);
    }
    if (Number.isSafeInteger(schema.maxLength) && value.length > schema.maxLength) {
      inputSchemaError(location, `must contain at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern, 'u')).test(value)) {
      inputSchemaError(location, 'does not match the required pattern');
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) inputSchemaError(location, `must be at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) inputSchemaError(location, `must be at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) inputSchemaError(location, `must contain at least ${schema.minItems} items`);
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) inputSchemaError(location, `must contain at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => validateTaskInput(item, schema.items, `${location}[${index}]`, depth + 1));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) inputSchemaError(`${location}.${key}`, 'is required');
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateTaskInput(item, properties[key], `${location}.${key}`, depth + 1);
      } else if (schema.additionalProperties === false) {
        inputSchemaError(`${location}.${key}`, 'is not supported');
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateTaskInput(item, schema.additionalProperties, `${location}.${key}`, depth + 1);
      }
    }
  }
}

function requestHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function encodeCursor(task) {
  return Buffer.from(JSON.stringify({ id: task.id }), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (typeof value !== 'string' || !value || value.length > 512) {
    throw new TaskServiceError('INVALID_TASK_CURSOR', 'Task cursor is invalid');
  }
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!decoded || typeof decoded.id !== 'string' || !/^task_[a-f0-9]{32}$/.test(decoded.id)) throw new Error();
    return decoded.id;
  } catch {
    throw new TaskServiceError('INVALID_TASK_CURSOR', 'Task cursor is invalid');
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function artifactId(taskIdValue, relativePath) {
  return `artifact_${createHash('sha256')
    .update(taskIdValue)
    .update('\0')
    .update(relativePath)
    .digest('hex')
    .slice(0, 32)}`;
}

function declaredArtifactFiles(task) {
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

function sanitizeError(error, fallbackCode = 'TASK_FAILED') {
  return {
    code: redactSensitiveText(error?.code || fallbackCode).slice(0, 200),
    message: redactSensitiveText(error?.message || 'Task failed').slice(0, 2_000),
    ...(error?.screenshot ? { screenshot: redactSensitiveText(error.screenshot) } : {})
  };
}

function terminalProgress(task, state = task.state) {
  const current = Number.isFinite(Number(task.progress?.current))
    ? Math.max(0, Number(task.progress.current))
    : 0;
  const total = task.progress?.total === null || task.progress?.total === undefined
    ? null
    : Number(task.progress.total);
  return {
    current: state === 'completed' && Number.isFinite(total) ? total : current,
    total: Number.isFinite(total) ? total : null,
    message: state === 'completed'
      ? 'Completed'
      : state === 'cancelled'
        ? 'Cancelled'
        : 'Failed'
  };
}

function defaultWorkerFactory(workerPath) {
  return fork(workerPath, [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
    windowsHide: true
  });
}

function send(child, message) {
  if (!child?.connected) return false;
  try {
    child.send(message, undefined, undefined, () => {});
    return true;
  } catch {
    return false;
  }
}

export function sendChildMessageConfirmed(child, message) {
  return new Promise((resolve) => {
    if (!child?.connected || typeof child.send !== 'function') {
      resolve(false);
      return;
    }
    try {
      // child.send() returning false means backpressure, not rejection. Only
      // its callback confirms that the command entered the IPC channel.
      child.send(message, undefined, undefined, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

async function atomicJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function publicRecord(task) {
  const record = publicTask(task);
  if (Array.isArray(record.result?.evidence)) {
    record.result.evidence = record.result.evidence.map((item) => {
      if (
        item?.kind !== 'artifact' || typeof item.file !== 'string' ||
        item.agentVisible === false
      ) return item;
      const normalized = path.normalize(item.file);
      return {
        kind: 'artifact',
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
        artifactId: artifactId(task.id, normalized)
      };
    });
  }
  return clone(record);
}

function taskId() {
  return `task_${randomUUID().replaceAll('-', '')}`;
}

function defaultProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function createTaskService({
  stateDir,
  profileStore,
  workerFactory = defaultWorkerFactory,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  profileLeaseRenewalMs = 20_000,
  diagnosticGraceMs = DIAGNOSTIC_GRACE_MS,
  workerCleanupGraceMs = TASK_SERVICE_DEADLINES.workerCleanupGraceMs,
  workerHardKillGraceMs = TASK_SERVICE_DEADLINES.workerHardKillGraceMs,
  progressStallMs = PROGRESS_STALL_MS,
  progressFailureMs = PROGRESS_FAILURE_MS,
  maxConcurrentTasks = 4,
  maxQueuedTasks = 100,
  cleanupReconcileIntervalMs = CLEANUP_RECONCILE_INTERVAL_MS,
  cleanupReconcileGraceMs = CLEANUP_RECONCILE_GRACE_MS,
  taskTypeRegistry,
  taskTypesFile,
  taskTypesRoot,
  allowedTaskRoots = [PROJECT_ROOT],
  artifactValidationHook = null,
  processAlive = defaultProcessAlive,
  seedTaskTypes = [
    { name: 'acceptance', modulePath: ACCEPTANCE_TASK },
    { name: 'read-page', modulePath: READ_PAGE_TASK },
    { name: 'observe-page', modulePath: OBSERVE_PAGE_TASK },
    { name: 'handoff-acceptance', modulePath: HANDOFF_ACCEPTANCE_TASK },
    { name: 'durable-delay', modulePath: DURABLE_DELAY_TASK }
  ]
} = {}) {
  if (!stateDir) throw new TypeError('stateDir is required');
  if (!profileStore?.get || !profileStore?.acquireLease || !profileStore?.releaseLease) {
    throw new TypeError('profileStore with get/acquireLease/releaseLease is required');
  }
  if (artifactValidationHook !== null && typeof artifactValidationHook !== 'function') {
    throw new TypeError('artifactValidationHook must be a function when provided');
  }
  if (typeof processAlive !== 'function') throw new TypeError('processAlive must be a function');
  if (!Number.isFinite(workerCleanupGraceMs) || workerCleanupGraceMs <= 0) {
    throw new TypeError('workerCleanupGraceMs must be positive');
  }
  if (!Number.isFinite(workerHardKillGraceMs) || workerHardKillGraceMs <= 0) {
    throw new TypeError('workerHardKillGraceMs must be positive');
  }
  if (!Number.isFinite(profileLeaseRenewalMs) || profileLeaseRenewalMs < 10) {
    throw new TypeError('profileLeaseRenewalMs must be at least 10');
  }
  if (!Number.isFinite(progressStallMs) || progressStallMs < 1_000) {
    throw new TypeError('progressStallMs must be at least 1000');
  }
  if (!Number.isFinite(progressFailureMs) || progressFailureMs <= progressStallMs) {
    throw new TypeError('progressFailureMs must be greater than progressStallMs');
  }
  if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1 || maxConcurrentTasks > 32) {
    throw new TypeError('maxConcurrentTasks must be an integer from 1 to 32');
  }
  if (!Number.isSafeInteger(maxQueuedTasks) || maxQueuedTasks < 1 || maxQueuedTasks > 10_000) {
    throw new TypeError('maxQueuedTasks must be an integer from 1 to 10000');
  }
  if (!Number.isFinite(cleanupReconcileIntervalMs) || cleanupReconcileIntervalMs <= 0) {
    throw new TypeError('cleanupReconcileIntervalMs must be positive');
  }
  if (!Number.isFinite(cleanupReconcileGraceMs) || cleanupReconcileGraceMs <= 0) {
    throw new TypeError('cleanupReconcileGraceMs must be positive');
  }

  const root = path.resolve(stateDir);
  const cleanupReceiptsRoot = path.join(path.dirname(root), 'cleanup-receipts');
  const tasks = new Map();
  const children = new Map();
  const openProfiles = new Map();
  const openingProfiles = new Map();
  const persistChains = new Map();
  const cleanupReconcileTails = new Map();
  const artifactDigestCache = new Map();
  const finalizationFailures = new Map();
  const registry = taskTypeRegistry || new TaskTypeRegistry({
    filePath: taskTypesFile || path.join(path.dirname(root), 'task-types.json'),
    snapshotRoot: taskTypesRoot || path.join(path.dirname(root), 'task-types'),
    allowedRoots: allowedTaskRoots,
    seedTypes: seedTaskTypes
  });
  let createTail = Promise.resolve();
  let queueTail = Promise.resolve();
  let cleanupReconcileTimer = null;
  let closing = false;
  let closePromise;
  const ready = initialize();
  void ready.then(() => scheduleQueuedTasks()).catch(() => {});

  function requireServiceOpen() {
    if (closing) {
      throw new TaskServiceError(
        'SERVICE_CLOSING',
        'Task service is stopping and accepts no new operations',
        503
      );
    }
  }

  function taskCleanupReceiptPath(task) {
    return path.join(root, task.id, `cleanup-attempt-${task.attempt}.json`);
  }

  function profileCleanupReceiptPath(ownerId) {
    const digest = createHash('sha256').update(ownerId).digest('hex');
    return path.join(cleanupReceiptsRoot, `profile-${digest}.json`);
  }

  function legacySessionCleanupReceiptPath(ownerId) {
    const digest = createHash('sha256').update(ownerId).digest('hex');
    return path.join(cleanupReceiptsRoot, `session-${digest}.json`);
  }

  async function verifyTaskCleanupReceipt(task) {
    return verifyCleanupReceipt(taskCleanupReceiptPath(task), {
      kind: 'task',
      taskId: task.id,
      attempt: task.attempt,
      workerPid: task.workerPid
    });
  }

  async function markCleanupUnknown(profileId, ownerId) {
    if (typeof profileStore.markCleanupUnknown !== 'function') return;
    await profileStore.markCleanupUnknown(profileId, ownerId).catch(() => {});
  }

  async function reconcileProfileCleanup(profile) {
    const lease = profile?.lease;
    if (!lease || !/^profile-open:/u.test(lease.ownerId || '')) return false;
    if (await processAlive(lease.pid)) return false;
    const receiptPath = profileCleanupReceiptPath(lease.ownerId);
    const confirmed = await verifyCleanupReceipt(receiptPath, {
      kind: 'profile',
      profileId: profile.id,
      ownerId: lease.ownerId,
      workerPid: lease.pid
    });
    if (!confirmed) {
      await markCleanupUnknown(profile.id, lease.ownerId);
      return false;
    }
    if (!(await profileStore.releaseLease(profile.id, lease.ownerId, { cleanupConfirmed: true }))) {
      await markCleanupUnknown(profile.id, lease.ownerId);
      return false;
    }
    await removeCleanupReceipt(receiptPath).catch(() => {});
    return true;
  }

  async function reconcileLegacySessionCleanup(profile) {
    const lease = profile?.lease;
    if (!lease || !/^session-import:/u.test(lease.ownerId || '')) return false;
    if (await processAlive(lease.pid)) return false;
    const receiptPath = legacySessionCleanupReceiptPath(lease.ownerId);
    const confirmed = await verifyCleanupReceipt(receiptPath, {
      kind: 'session',
      profileId: profile.id,
      ownerId: lease.ownerId,
      workerPid: lease.pid
    });
    if (!confirmed) {
      await markCleanupUnknown(profile.id, lease.ownerId);
      return false;
    }
    if (!(await profileStore.releaseLease(profile.id, lease.ownerId, { cleanupConfirmed: true }))) {
      await markCleanupUnknown(profile.id, lease.ownerId);
      return false;
    }
    await removeCleanupReceipt(receiptPath).catch(() => {});
    return true;
  }

  async function reconcileProfileCleanups() {
    if (typeof profileStore.list !== 'function') return;
    const profiles = await profileStore.list();
    for (const profile of profiles) {
      await reconcileProfileCleanup(profile);
      await reconcileLegacySessionCleanup(profile);
    }
  }

  async function reconcileTaskCleanup(profile) {
    const lease = profile?.lease;
    if (!lease || !/^task:/u.test(lease.ownerId || '')) return false;
    const task = tasks.get(lease.ownerId.slice('task:'.length));
    if (!task || await processAlive(lease.pid)) return false;
    const reconciled = await reconcileTaskCleanupReceipt(task);
    task.updatedAt = nowIso();
    await persist(task);
    return reconciled;
  }

  async function reconcileAnyCleanup(profile) {
    if (!profile?.id) return profile;
    const profileId = profile.id;
    const previous = cleanupReconcileTails.get(profileId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const current = await profileStore.get(profileId);
      if (!current?.lease) return current;
      const ownerId = current.lease.ownerId || '';
      // Task leases created before cleanupRequired became durable are still
      // recoverable when their task-bound receipt proves browser cleanup.
      if (current.lease.cleanupRequired !== true && !/^task:/u.test(ownerId)) return current;
      if (/^profile-open:/u.test(ownerId)) await reconcileProfileCleanup(current);
      else if (/^session-import:/u.test(ownerId)) await reconcileLegacySessionCleanup(current);
      else if (/^task:/u.test(ownerId)) await reconcileTaskCleanup(current);
      return profileStore.get(profileId);
    });
    cleanupReconcileTails.set(profileId, operation);
    try {
      return await operation;
    } finally {
      if (cleanupReconcileTails.get(profileId) === operation) cleanupReconcileTails.delete(profileId);
    }
  }

  function normalizeAttemptHistory(task) {
    task.attempt = Number.isSafeInteger(task.attempt) && task.attempt >= 1
      ? Math.min(task.attempt, MAX_ATTEMPTS)
      : 1;
    task.history = Array.isArray(task.history)
      ? task.history.filter((entry) => (
        entry && typeof entry === 'object' &&
        Number.isSafeInteger(entry.attempt) && entry.attempt >= 1 && entry.attempt <= MAX_ATTEMPTS
      )).slice(-MAX_ATTEMPTS).map((entry) => {
        const normalized = { ...entry };
        if (!isBehaviorMode(normalized.behavior)) delete normalized.behavior;
        return normalized;
      })
      : [];
  }

  function beginAttemptHistory(task, { resumed = false, checkpointSavedAt = null } = {}) {
    normalizeAttemptHistory(task);
    const startedAt = nowIso();
    task.history.push({
      attempt: task.attempt,
      resumed,
      startedAt,
      ...(isBehaviorMode(task.behavior) ? { behavior: task.behavior } : {}),
      ...(checkpointSavedAt ? { checkpointSavedAt } : {})
    });
    task.history = task.history.slice(-MAX_ATTEMPTS);
    return startedAt;
  }

  function setAttemptHistoryBehavior(task, behavior) {
    normalizeAttemptHistory(task);
    const record = [...task.history].reverse().find((entry) => entry.attempt === task.attempt);
    if (record && isBehaviorMode(behavior)) record.behavior = behavior;
  }

  function finishAttemptHistory(task) {
    normalizeAttemptHistory(task);
    let record = [...task.history].reverse().find((entry) => entry.attempt === task.attempt);
    if (!record) {
      record = { attempt: task.attempt, resumed: task.attempt > 1, startedAt: task.startedAt || task.createdAt || nowIso() };
      task.history.push(record);
    }
    record.finishedAt ||= task.finishedAt || nowIso();
    record.state = task.state;
    if (typeof task.error?.code === 'string') record.errorCode = task.error.code;
  }

  async function reconcileTaskCleanupReceipt(task, { workerExitConfirmed = false } = {}) {
    if (task.cleanup?.settled === true) return true;
    if (!workerExitConfirmed && await processAlive(task.workerPid)) return false;
    task.cleanup = {
      ...(task.cleanup || {}),
      workerExited: true
    };
    if (!(await verifyTaskCleanupReceipt(task))) {
      await markCleanupUnknown(task.profileId, task.leaseOwner);
      return false;
    }
    let profile;
    try {
      profile = await profileStore.get(task.profileId);
    } catch {
      return false;
    }
    if (profile?.lease?.ownerId === task.leaseOwner) {
      try {
        await profileStore.releaseLease(task.profileId, task.leaseOwner, { cleanupConfirmed: true });
        profile = await profileStore.get(task.profileId);
      } catch {
        return false;
      }
      if (profile?.lease?.ownerId === task.leaseOwner) return false;
    }
    task.leaseHeld = false;
    task.cleanup = {
      ...(task.cleanup || {}),
      browserClosed: true,
      leaseReleased: true,
      workerExited: true,
      settled: true
    };
    // Persist the durable settled state before consuming its only crash proof.
    // If persistence fails, the receipt remains available to the next Manager.
    await persist(task);
    await removeCleanupReceipt(taskCleanupReceiptPath(task)).catch(() => {});
    return true;
  }

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(cleanupReceiptsRoot, { recursive: true, mode: 0o700 });
    await registry.list();
    await reconcileProfileCleanups();
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('task_')) continue;
      const filePath = path.join(root, entry.name, 'task.json');
      let task;
      try {
        task = JSON.parse(await readFile(filePath, 'utf8'));
      } catch {
        continue;
      }
      if (!task || task.id !== entry.name || typeof task.profileId !== 'string') continue;
      task.ownerRole = task.ownerRole === 'manager-admin' || task.ownerRole === 'agent'
        ? task.ownerRole
        : typeof task.ownerClientId !== 'string' || ['manager-admin', 'dashboard'].includes(task.ownerClientId)
          ? 'manager-admin'
          : 'agent';
      if (task.ownerRole === 'agent') {
        try {
          task.ownerAgentName = normalizeAgentName(task.ownerAgentName ?? task.ownerClientId);
        } catch {
          task.ownerAgentName = task.ownerClientId;
        }
      }
      normalizeAttemptHistory(task);
      task.supportsResume = task.supportsResume === true;
      task.cleanup = {
        browserClosed: false,
        leaseReleased: false,
        workerExited: false,
        settled: false,
        ...(task.cleanup || {})
      };
      // Never trust a stale persisted `settled` bit on its own.
      refreshCleanupSettled(task);
      const safelyQueued = task.state === 'queued' && !task.startedAt && !task.workerPid && task.leaseHeld !== true;
      tasks.set(task.id, task);
      await recoverDiagnosticsPointers(task);
      if (!safelyQueued) {
        if (task.cleanup.settled !== true) {
          task.cleanup.managerRestartObserved = true;
          await reconcileTaskCleanupReceipt(task);
          refreshCleanupSettled(task);
        }

        const claimedCompletion = task.state === 'verifying' || task.state === 'completed' ||
          (task.completionClaimed === true && !TERMINAL_TASK_STATES.has(task.state));
        if (claimedCompletion && task.result && task.cleanup.settled === true) {
          try {
            task.completion = await verifyCompletionGate(task);
            task.state = 'completed';
            task.error = null;
          } catch (error) {
            task.state = 'failed';
            task.error = sanitizeError(error, 'TASK_COMPLETION_INTEGRITY_FAILED');
            task.completion = {
              ...(task.completion || {}),
              integrity: 'invalid',
              invalidAt: nowIso()
            };
          }
        } else if (claimedCompletion) {
          task.state = 'failed';
          task.error = {
            code: 'TASK_RESTART_COMPLETION_UNVERIFIED',
            message: 'Manager restart recovery could not re-verify the claimed completion and cleanup evidence.'
          };
        } else if (!TERMINAL_TASK_STATES.has(task.state)) {
          task.state = 'failed';
          task.error = {
            code: 'TASK_INTERRUPTED_BY_MANAGER_RESTART',
            message: 'Manager restarted before task cleanup completed; inspect the checkpoint before resuming.'
          };
        }

        if (TERMINAL_TASK_STATES.has(task.state)) {
          task.progress = terminalProgress(task, task.state);
          task.finishedAt ||= nowIso();
          task.health = { status: task.state, checkedAt: nowIso() };
          finishAttemptHistory(task);
        }
      }
      await refreshResumeCheckpointState(task);
      task.currentActivity = lifecycleActivity(task.state);
      task.updatedAt = nowIso();
      await atomicJson(filePath, task);
      if (task.cleanup.settled === true) {
        await removeCleanupReceipt(taskCleanupReceiptPath(task)).catch(() => {});
      }
    }
  }

  function queuedTasks() {
    return [...tasks.values()]
      .filter((task) => task.state === 'queued')
      .sort((left, right) => (
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      ));
  }

  async function updateQueueMetadata() {
    const queued = queuedTasks();
    const activeProfiles = new Set(
      [...children.keys()].map((id) => tasks.get(id)?.profileId).filter(Boolean)
    );
    const writes = [];
    queued.forEach((task, index) => {
      const reason = [PROFILE_CLEANUP_QUEUE_REASON, PROFILE_BUSY_QUEUE_REASON].includes(task.queueReason)
        ? task.queueReason
        : activeProfiles.has(task.profileId)
        ? 'Waiting for the Profile lease'
        : children.size >= maxConcurrentTasks
          ? 'Waiting for an execution slot'
          : 'Ready to start';
      if (task.queuePosition !== index + 1 || task.queueReason !== reason) {
        task.queuePosition = index + 1;
        task.queueReason = reason;
        task.updatedAt = nowIso();
        writes.push(persist(task));
      }
    });
    await Promise.all(writes);
  }

  async function drainQueue() {
    let capacity = Math.max(0, maxConcurrentTasks - children.size);
    if (capacity === 0) {
      await updateQueueMetadata();
      return;
    }
    const activeProfiles = new Set(
      [...children.keys()].map((id) => tasks.get(id)?.profileId).filter(Boolean)
    );
    let cleanupBlocked = false;
    let profileBlocked = false;
    for (const task of queuedTasks()) {
      if (capacity <= 0) break;
      if (activeProfiles.has(task.profileId)) continue;
      let profile;
      try {
        profile = await profileStore.get(task.profileId);
        profile = await reconcileAnyCleanup(profile);
      } catch (error) {
        task.state = 'failed';
        task.currentActivity = lifecycleActivity('failed');
        task.health = { status: 'failed', checkedAt: nowIso() };
        task.error = sanitizeError(error, 'PROFILE_NOT_FOUND');
        task.finishedAt = nowIso();
        task.cleanup = { browserClosed: true, leaseReleased: true, workerExited: true, settled: true };
        finishAttemptHistory(task);
        await persist(task);
        continue;
      }
      const taskCaller = { role: task.ownerRole, clientId: task.ownerClientId };
      if (!canUseProfile(profile, taskCaller)) {
        task.state = 'failed';
        task.currentActivity = lifecycleActivity('failed');
        task.health = { status: 'failed', checkedAt: nowIso() };
        task.error = {
          code: 'PROFILE_ACCESS_REVOKED',
          message: 'Profile access was revoked before the queued task started'
        };
        task.finishedAt = nowIso();
        task.cleanup = { browserClosed: true, leaseReleased: true, workerExited: true, settled: true };
        finishAttemptHistory(task);
        await persist(task);
        continue;
      }
      const activeLeaseOwner = profile.lease?.ownerId || '';
      const openProfileEntry = openProfiles.get(task.profileId);
      const knownLiveProfileOwner = openProfileEntry?.exited !== true &&
        openProfileEntry?.ownerId === activeLeaseOwner;
      const leaseProcessAlive = Number.isSafeInteger(profile.lease?.pid) && profile.lease.pid > 0
        ? await processAlive(profile.lease.pid)
        : false;
      if (
        profile.state !== 'idle' && profile.lease?.ownerId !== task.leaseOwner &&
        (knownLiveProfileOwner || leaseProcessAlive)
      ) {
        profileBlocked = true;
        task.queueReason = PROFILE_BUSY_QUEUE_REASON;
        task.health = { status: 'queued', checkedAt: nowIso() };
        await persist(task);
        continue;
      }
      if (profile.state === 'error' || profile.lease?.cleanupRequired === true) {
        task.cleanupBlockedAt ||= nowIso();
        const cleanupGraceElapsed = Date.now() - Date.parse(task.cleanupBlockedAt) >= cleanupReconcileGraceMs;
        if (!cleanupGraceElapsed) {
          cleanupBlocked = true;
          task.queueReason = PROFILE_CLEANUP_QUEUE_REASON;
          task.health = { status: 'blocked', checkedAt: nowIso() };
          await persist(task);
          continue;
        }
        task.state = 'failed';
        task.currentActivity = lifecycleActivity('failed');
        task.health = { status: 'failed', checkedAt: nowIso() };
        task.error = {
          code: 'PROFILE_CLEANUP_UNCONFIRMED',
          message: 'Profile browser cleanup remained unconfirmed after the reconciliation grace period'
        };
        task.finishedAt = nowIso();
        task.queuePosition = null;
        task.queueReason = null;
        task.cleanup = { browserClosed: true, leaseReleased: true, workerExited: true, settled: true };
        delete task.cleanupBlockedAt;
        finishAttemptHistory(task);
        await persist(task);
        continue;
      }
      if (profile.state !== 'idle' && profile.lease?.ownerId !== task.leaseOwner) {
        profileBlocked = true;
        task.queueReason = PROFILE_BUSY_QUEUE_REASON;
        task.health = { status: 'queued', checkedAt: nowIso() };
        await persist(task);
        continue;
      }
      // Profile reads and reconciliation yield. A concurrent cancel must win
      // over this stale queue snapshot and must never be resurrected here.
      if (task.state !== 'queued') continue;
      delete task.cleanupBlockedAt;
      task.queuePosition = null;
      task.queueReason = null;
      task.health = { status: 'healthy', checkedAt: nowIso() };
      await persist(task);
      await launchTaskAttempt(task);
      if (children.has(task.id)) {
        activeProfiles.add(task.profileId);
        capacity -= 1;
      }
    }
    await updateQueueMetadata();
    if (cleanupBlocked || profileBlocked) scheduleCleanupReconciliation();
  }

  function scheduleQueuedTasks() {
    if (closing) return Promise.resolve();
    const operation = queueTail.then(drainQueue);
    queueTail = operation.catch(() => {});
    return operation;
  }

  function scheduleCleanupReconciliation() {
    if (closing || cleanupReconcileTimer) return;
    cleanupReconcileTimer = setTimeout(() => {
      cleanupReconcileTimer = null;
      void scheduleQueuedTasks().catch(() => {});
    }, cleanupReconcileIntervalMs);
    cleanupReconcileTimer.unref?.();
  }

  function persist(task) {
    const taskRoot = path.join(root, task.id);
    const filePath = path.join(taskRoot, 'task.json');
    const previous = persistChains.get(task.id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => mkdir(taskRoot, { recursive: true, mode: 0o700 }))
      .then(() => atomicJson(filePath, task));
    persistChains.set(task.id, next);
    return next;
  }

  function update(task, patch) {
    const activity = Object.hasOwn(patch, 'currentActivity') || typeof patch.state !== 'string'
      ? null
      : lifecycleActivity(patch.state);
    Object.assign(task, patch, ...(activity ? [{ currentActivity: activity }] : []), { updatedAt: nowIso() });
    return persist(task).then(() => task);
  }

  async function awaitTaskPersistence(id) {
    while (true) {
      const pending = persistChains.get(id);
      if (!pending) return;
      await pending;
      if (persistChains.get(id) === pending) return;
    }
  }

  function completionGateFailure(message) {
    return new TaskServiceError('TASK_COMPLETION_GATE_FAILED', message, 409);
  }

  function requiredArtifactPaths(task) {
    const evidence = task.result.evidence;
    const required = [];
    const seen = new Set();
    for (const item of evidence) {
      if (
        !item || typeof item !== 'object' || Array.isArray(item) ||
        !SAFE_EVIDENCE_KINDS.has(item.kind)
      ) {
        throw completionGateFailure('Task result evidence contains an unsupported kind');
      }
      if (
        item.label !== undefined &&
        (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 128)
      ) {
        throw completionGateFailure('Task result evidence labels must be bounded non-empty strings');
      }
      if (item.kind === 'url') {
        try {
          const url = new URL(item.value);
          if (!['http:', 'https:'].includes(url.protocol) || item.value.length > 4_096) throw new Error();
        } catch {
          throw completionGateFailure('URL evidence must contain one bounded HTTP(S) URL');
        }
        continue;
      }
      if (item.kind === 'count') {
        if (typeof item.value !== 'number' || !Number.isFinite(item.value) || item.value < 0) {
          throw completionGateFailure('Count evidence must contain a non-negative finite number');
        }
        continue;
      }
      if (item.kind === 'hash') {
        if (typeof item.value !== 'string' || !/^[a-f0-9]{32,128}$/iu.test(item.value)) {
          throw completionGateFailure('Hash evidence must contain 32-128 hexadecimal characters');
        }
        continue;
      }
      if (item.kind === 'message' || item.kind === 'note') {
        if (typeof item.value !== 'string' || !item.value.trim() || item.value.length > 1_024) {
          throw completionGateFailure('Message evidence must contain bounded non-empty text');
        }
        continue;
      }
      if (item.agentVisible === false) {
        throw completionGateFailure('Completion evidence artifacts must be Agent-visible');
      }
      if (item.agentVisible !== undefined && item.agentVisible !== true) {
        throw completionGateFailure('Declared artifact visibility must be true when provided');
      }
      if (
        typeof item.file !== 'string' || !item.file || item.file.includes('\0') ||
        path.isAbsolute(item.file)
      ) {
        throw completionGateFailure('Agent-visible artifacts must use relative output filenames');
      }
      const normalized = path.normalize(item.file);
      if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
        throw completionGateFailure('Agent-visible artifacts must remain inside the task output directory');
      }
      if (!seen.has(normalized)) {
        seen.add(normalized);
        required.push(normalized);
      }
      if (required.length > MAX_ARTIFACTS) {
        throw completionGateFailure(`Task result declares more than ${MAX_ARTIFACTS} agent-visible artifacts`);
      }
    }
    return required;
  }

  async function verifyCompletionGate(task) {
    if (!task.result || typeof task.result !== 'object' || Array.isArray(task.result)) {
      throw completionGateFailure('Task worker did not return a result object');
    }
    if (typeof task.result.summary !== 'string' || !task.result.summary.trim() || task.result.summary.length > 4_000) {
      throw completionGateFailure('Task result must include a bounded non-empty summary');
    }
    if (
      !Array.isArray(task.result.evidence) ||
      task.result.evidence.length < 1 || task.result.evidence.length > 32
    ) {
      throw completionGateFailure('Task result evidence must contain 1-32 verifiable items');
    }
    if (task.cleanup?.browserClosed !== true) {
      throw completionGateFailure('Task browser cleanup was not confirmed');
    }
    if (task.cleanup?.workerExited !== true || task.cleanup?.leaseReleased !== true) {
      throw completionGateFailure('Task worker and Profile lease cleanup were not confirmed');
    }
    const progressCurrent = Number(task.progress?.current);
    const progressTotal = task.progress?.total === null || task.progress?.total === undefined
      ? null
      : Number(task.progress.total);
    if (
      !Number.isFinite(progressCurrent) || progressCurrent < 0 ||
      (progressTotal !== null && (!Number.isFinite(progressTotal) || progressTotal < 0 || progressCurrent !== progressTotal))
    ) {
      throw completionGateFailure('Task progress must reach its declared total before completion');
    }

    const required = requiredArtifactPaths(task);
    const artifactAnchors = [];
    const reverifyExistingAnchors = task.state === 'completed';
    for (const relativePath of required) {
      const declaration = artifactDeclarations(task, { includeUnverifiedResult: true }).find((item) => (
        item.kind === 'result' && item.relativePath === relativePath
      ));
      if (!declaration) throw completionGateFailure('A declared agent-visible artifact is invalid');
      let opened;
      try {
        opened = await openValidatedArtifact(task, declaration, {
          verifyCompletionAnchor: reverifyExistingAnchors
        });
        if (reverifyExistingAnchors) {
          const existing = task.completion?.artifacts?.find((item) => item?.artifactId === declaration.id);
          if (!existing) throw new Error('completion anchor missing');
          artifactAnchors.push(existing);
        } else {
          const sha256 = await hashOpenFile(opened.handle, Number(opened.stats.size));
          cacheArtifactDigest(task, declaration, opened.stats, sha256);
          artifactAnchors.push({
            artifactId: declaration.id,
            sizeBytes: Number(opened.stats.size),
            sha256
          });
        }
        const afterHash = await opened.handle.stat({ bigint: true });
        if (
          !sameFileIdentity(opened.stats, afterHash) ||
          opened.stats.size !== afterHash.size || opened.stats.mtimeNs !== afterHash.mtimeNs
        ) throw new Error('artifact changed while hashing');
        await assertArtifactPathIdentity(task, declaration, opened.stats);
      } catch {
        throw completionGateFailure('A declared agent-visible artifact is missing or unstable');
      } finally {
        await opened?.handle.close().catch(() => {});
      }
    }
    return { verifiedAt: nowIso(), artifactCount: required.length, artifacts: artifactAnchors };
  }

  function refreshCleanupSettled(task) {
    task.cleanup.settled = Boolean(
      task.cleanup.browserClosed === true &&
      task.cleanup.workerExited === true &&
      task.cleanup.leaseReleased === true
    );
    return task.cleanup.settled;
  }

  async function taskLeaseIsAbsent(task) {
    try {
      const profile = await profileStore.get(task.profileId);
      return profile?.lease?.ownerId !== task.leaseOwner;
    } catch {
      return false;
    }
  }

  async function releaseTaskLease(task) {
    let released = !task.leaseHeld && await taskLeaseIsAbsent(task);
    try {
      if (!released) {
        released = await profileStore.releaseLease(task.profileId, task.leaseOwner, {
          cleanupConfirmed: task.cleanup.browserClosed === true
        }) === true;
        if (!released) released = await taskLeaseIsAbsent(task);
      }
    } catch (error) {
      released = await taskLeaseIsAbsent(task);
      if (!released) {
        task.cleanup.leaseReleaseError = sanitizeError(error, 'LEASE_RELEASE_FAILED');
      }
    }
    if (released) {
      task.leaseHeld = false;
      task.cleanup.leaseReleased = true;
      delete task.cleanup.leaseReleaseError;
    } else {
      task.leaseHeld = true;
      task.cleanup.leaseReleased = false;
      task.cleanup.leaseReleaseError ||= {
        code: 'LEASE_RELEASE_FAILED',
        message: 'Profile lease release could not be confirmed'
      };
      await markCleanupUnknown(task.profileId, task.leaseOwner);
    }
    await update(task, { cleanup: task.cleanup });
    return released;
  }

  async function finalizeTask(task, exitCode, signal) {
    const entry = children.get(task.id);
    if (!entry && task.cleanup?.workerExited === true) return;
    if (entry?.finalized) return;
    if (entry) {
      entry.finalized = true;
      entry.attached = false;
      clearInterval(entry.watchdog);
      clearTimeout(entry.forceKillTimer);
      clearTimeout(entry.hardKillTimer);
    }
    children.delete(task.id);
    task.cleanup.workerExited = true;
    task.cleanup.exitCode = exitCode;
    task.cleanup.exitSignal = signal || null;
    // A heartbeat renewal that started before finalization may still be queued
    // inside ProfileStore. Drain it before the one authoritative release so a
    // late renewal cannot resurrect a completed task's lease.
    await entry?.leaseRenewalTail?.catch(() => {});
    await awaitTaskPersistence(task.id);
    const claimedCompletion = task.completionClaimed === true || task.state === 'verifying';
    if (!claimedCompletion && !TERMINAL_TASK_STATES.has(task.state)) {
      await update(task, {
        state: 'failed',
        error: { code: 'TASK_WORKER_EXITED', message: 'Task worker exited before reporting a terminal state' }
      });
    }
    if (task.cleanup?.browserClosed === true) {
      await releaseTaskLease(task);
    } else if (!(await reconcileTaskCleanupReceipt(task, { workerExitConfirmed: true }))) {
      await markCleanupUnknown(task.profileId, task.leaseOwner);
    }
    if (claimedCompletion && task.state === 'verifying') {
      try {
        task.completion = await verifyCompletionGate(task);
        task.state = 'completed';
        task.error = null;
      } catch (error) {
        task.state = 'failed';
        task.error = sanitizeError(error, 'TASK_COMPLETION_GATE_FAILED');
      }
    }
    refreshCleanupSettled(task);
    task.finishedAt ||= nowIso();
    if (TERMINAL_TASK_STATES.has(task.state)) task.progress = terminalProgress(task, task.state);
    task.health = { status: task.state, checkedAt: nowIso() };
    finishAttemptHistory(task);
    await update(task, {
      state: task.state,
      error: task.error,
      finishedAt: task.finishedAt,
      cleanup: task.cleanup,
      health: task.health,
      history: task.history,
      ...(task.completion ? { completion: task.completion } : {})
    });
    if (task.cleanup.settled === true) {
      await removeCleanupReceipt(taskCleanupReceiptPath(task)).catch(() => {});
    }
    entry?.resolveExit?.();
    void scheduleQueuedTasks().catch(() => {});
  }

  async function settleTaskWorkerExit(task, entry, exitCode, signal) {
    try {
      await finalizeTask(task, exitCode, signal);
    } catch (error) {
      finalizationFailures.set(task.id, sanitizeError(error, 'TASK_FINALIZATION_PERSIST_FAILED'));
      entry.finalized = true;
      entry.attached = false;
      children.delete(task.id);
      task.state = 'failed';
      task.currentActivity = lifecycleActivity('failed');
      task.error = {
        code: 'TASK_FINALIZATION_PERSIST_FAILED',
        message: 'Task worker exited, but its durable terminal state could not be confirmed.'
      };
      task.cleanup = { ...(task.cleanup || {}), settled: false };
      task.progress = terminalProgress(task, 'failed');
      task.health = { status: 'failed', checkedAt: nowIso() };
      await markCleanupUnknown(task.profileId, task.leaseOwner);
      await persist(task).catch(() => {});
    } finally {
      entry.resolveExit?.();
      void scheduleQueuedTasks().catch(() => {});
    }
  }

  function scheduleForcedStop(task, entry) {
    if (entry.finalized || entry.child.exitCode !== null || entry.forceKillTimer || entry.hardKillTimer) return;
    entry.forceKillTimer = setTimeout(() => {
      entry.forceKillTimer = null;
      if (entry.child.exitCode !== null) return;
      try {
        entry.child.kill('SIGTERM');
      } catch {
        // The child may already be exiting; its exit/close event owns finalization.
      }
      if (entry.finalized || entry.child.exitCode !== null) return;
      entry.hardKillTimer = setTimeout(() => {
        entry.hardKillTimer = null;
        if (entry.child.exitCode === null) {
          try {
            entry.child.kill('SIGKILL');
          } catch {
            // The close event remains the source of truth for cleanup and lease release.
          }
        }
      }, workerHardKillGraceMs);
      entry.hardKillTimer.unref?.();
    }, workerCleanupGraceMs);
    entry.forceKillTimer.unref?.();
  }

  function attachTaskWorker(task, child) {
    if (
      !child ||
      typeof child.on !== 'function' ||
      typeof child.once !== 'function' ||
      typeof child.send !== 'function' ||
      typeof child.kill !== 'function'
    ) {
      throw new TaskServiceError('TASK_WORKER_INVALID', 'Task worker could not be initialized', 500);
    }
    let resolveExit;
    const exitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    const entry = {
      child,
      finalized: false,
      diagnoseAt: 0,
      stallDiagnoseAt: 0,
      forceKillTimer: null,
      hardKillTimer: null,
      watchdog: null,
      exitPromise,
      resolveExit,
      leaseRenewalTail: Promise.resolve(),
      attached: false
    };

    try {
      child.on('message', (message) => {
      if (!entry.attached) return;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'heartbeat') {
        if (TERMINAL_TASK_STATES.has(task.state)) {
          scheduleForcedStop(task, entry);
          return;
        }
        entry.diagnoseAt = 0;
        clearTimeout(entry.forceKillTimer);
        entry.forceKillTimer = null;
        void update(task, { heartbeatAt: nowIso() }).catch(() => {});
        const renewal = entry.leaseRenewalTail.then(async () => {
          if (!entry.attached || entry.finalized) return;
          await profileStore.acquireLease(task.profileId, task.leaseOwner, {
            pid: child.pid,
            ttlMs: LEASE_TTL_MS,
            cleanupRequired: true,
            ...taskLeaseAccess(task)
          });
        });
        entry.leaseRenewalTail = renewal.catch((error) => {
          if (entry.finalized || TERMINAL_TASK_STATES.has(task.state)) return;
          void update(task, { state: 'failed', error: sanitizeError(error, 'LEASE_RENEWAL_FAILED') }).catch(() => {});
          send(child, { type: 'cancel' });
          scheduleForcedStop(task, entry);
        });
        return;
      }
      if (message.type === 'progress' && message.progress) {
        if (task.state === 'verifying' || TERMINAL_TASK_STATES.has(task.state)) return;
        const current = Number(message.progress.current);
        const total = message.progress.total === null ? null : Number(message.progress.total);
        const progressMessage = typeof message.progress.message === 'string'
          ? redactSensitiveText(message.progress.message).slice(0, 500)
          : '';
        const phase = message.progress.phase;
        const previousCurrent = Number(task.progress?.current) || 0;
        const previousTotal = task.progress?.total === null || task.progress?.total === undefined
          ? null
          : Number(task.progress.total);
        if (
          !Number.isFinite(current) || current < 0 || current < previousCurrent ||
          (total !== null && (!Number.isFinite(total) || total < current)) ||
          (previousTotal !== null && (total === null || total < previousTotal)) ||
          !progressMessage.trim() ||
          (phase !== undefined && (typeof phase !== 'string' || !PROGRESS_PHASE_PATTERN.test(phase)))
        ) {
          void update(task, {
            state: 'failed',
            error: {
              code: 'TASK_PROGRESS_INVALID',
              message: 'Task worker reported invalid or backwards progress'
            },
            finishedAt: nowIso(),
            progress: terminalProgress(task, 'failed'),
            health: { status: 'failed', checkedAt: nowIso() }
          }).catch(() => {});
          send(child, { type: 'cancel' });
          scheduleForcedStop(task, entry);
          return;
        }
        const advanced = current > previousCurrent;
        if (advanced) entry.stallDiagnoseAt = 0;
        // Timestamp worker feedback at receipt. Worker-controlled strings must
        // never become public activity or freshness fields.
        const at = nowIso();
        const healthStatus = task.state === 'waiting_user'
          ? 'waiting_user'
          : task.state === 'cooling_down'
            ? 'cooling_down'
            : 'healthy';
        void update(task, {
          progress: { current, total, message: progressMessage, ...(phase === undefined ? {} : { phase }) },
          heartbeatAt: at,
          ...(advanced ? {
            progressAt: at,
            health: { status: healthStatus, checkedAt: at }
          } : {})
        }).catch(() => {});
        return;
      }
      if (message.type === 'activity') {
        const currentActivity = workerActivity(message.activity);
        if (currentActivity && task.state !== 'verifying' && !TERMINAL_TASK_STATES.has(task.state)) {
          void update(task, { currentActivity }).catch(() => {});
        }
        return;
      }
      if (message.type === 'waiting_user' && message.request) {
        const request = message.request;
        if (
          typeof request.id !== 'string' || !HANDOFF_ID_PATTERN.test(request.id) ||
          typeof request.reason !== 'string' || !request.reason.trim()
        ) return;
        const diagnostics = message.diagnostics && typeof message.diagnostics === 'object'
          ? message.diagnostics
          : {};
        const screenshot = diagnostics.screenshot;
        const observation = diagnostics.observation;
        void update(task, {
          state: 'waiting_user',
          ...(typeof screenshot?.path === 'string' && screenshot.path ? {
            lastScreenshot: {
              path: screenshot.path,
              reason: typeof screenshot.reason === 'string' ? screenshot.reason : 'waiting-user',
              at: nowIso(),
              attempt: task.attempt
            }
          } : {}),
          ...(typeof observation?.path === 'string' && observation.path ? {
            lastObservation: {
              path: observation.path,
              reason: typeof observation.reason === 'string' ? observation.reason : 'waiting-user',
              at: nowIso(),
              attempt: task.attempt
            }
          } : {}),
          userRequest: {
            id: request.id,
            reason: redactSensitiveText(request.reason).slice(0, 500),
            ...(typeof request.instructions === 'string'
              ? { instructions: redactSensitiveText(request.instructions).slice(0, 2_000) }
              : {}),
            requestedAt: request.requestedAt || nowIso(),
            expiresAt: request.expiresAt || null,
            screenshotAvailable: request.screenshotAvailable === true,
            status: 'pending'
          },
          progress: {
            ...task.progress,
            message: `Waiting for a new instruction: ${redactSensitiveText(request.reason).slice(0, 300)}`
          },
          health: { status: 'waiting_user', checkedAt: nowIso() }
        }).catch(() => {});
        return;
      }
      if (message.type === 'state' && typeof message.state === 'string') {
        const terminal = TERMINAL_TASK_STATES.has(message.state);
        const resumedFromCooldown = task.state === 'cooling_down' && message.state === 'running';
        if (resumedFromCooldown) entry.stallDiagnoseAt = 0;
        if (message.state === 'completed') {
          if (!TERMINAL_TASK_STATES.has(task.state)) {
            void update(task, {
              state: 'verifying',
              completionClaimed: true,
              progress: { ...task.progress, message: 'Verifying result and cleanup' }
            }).catch(() => {});
          }
          scheduleForcedStop(task, entry);
          return;
        }
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          void update(task, {
            state: message.state,
            ...(message.state === 'cooling_down'
              ? { health: { status: 'cooling_down', checkedAt: nowIso() } }
              : message.state === 'running' || message.state === 'recovering'
                ? {
                    health: { status: 'healthy', checkedAt: nowIso() },
                    ...(resumedFromCooldown ? { progressAt: nowIso() } : {})
                  }
                : {}),
            ...(terminal ? {
              finishedAt: nowIso(),
              progress: terminalProgress(task, message.state)
            } : {})
          }).catch(() => {});
        }
        if (terminal) scheduleForcedStop(task, entry);
        return;
      }
      if (message.type === 'checkpoint') {
        void update(task, {
          checkpoint: {
            path: message.path,
            attempt: message.attempt,
            savedAt: message.savedAt,
            sha256: message.sha256,
            sizeBytes: message.sizeBytes
          },
          resumeCheckpointValid: false
        }).catch(() => {});
        return;
      }
      if (message.type === 'screenshot') {
        void update(task, {
          lastScreenshot: { path: message.path, reason: message.reason, at: nowIso(), attempt: task.attempt }
        }).catch(() => {});
        return;
      }
      if (message.type === 'observation') {
        void update(task, {
          lastObservation: { path: message.path, reason: message.reason, at: nowIso(), attempt: task.attempt }
        }).catch(() => {});
        return;
      }
      if (message.type === 'behavior' && message.behavior) {
        void update(task, { behaviorState: clone(message.behavior) }).catch(() => {});
        return;
      }
      if (message.type === 'cooldown' && message.cooldown) {
        const record = message.cooldown;
        if (
          ['active', 'completed'].includes(record.status) &&
          typeof record.resumeAt === 'string' &&
          typeof record.reason === 'string'
        ) {
          void update(task, {
            cooldown: {
              status: record.status,
              durationMs: Number(record.durationMs) || 0,
              resumeAt: record.resumeAt,
              reason: redactSensitiveText(record.reason).slice(0, 160),
              updatedAt: nowIso()
            }
          }).catch(() => {});
        }
        return;
      }
      if (message.type === 'result') {
        void update(task, { result: clone(redactSensitiveValue(message.result)) }).catch(() => {});
        return;
      }
      if (message.type === 'error') {
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          const nextState = message.state === 'cancelled' ? 'cancelled' : 'failed';
          void update(task, {
            state: nextState,
            error: sanitizeError(message.error),
            finishedAt: nowIso(),
            progress: terminalProgress(task, nextState)
          }).catch(() => {});
        }
        scheduleForcedStop(task, entry);
        return;
      }
      if (message.type === 'cleanup') {
        task.cleanup.browserClosed = Boolean(message.browserClosed);
        void update(task, {
          cleanup: task.cleanup,
          currentActivity: lifecycleActivity('cleaning_up')
        }).catch(() => {});
      }
    });

      child.once('error', (error) => {
      if (!entry.attached) return;
      if (!TERMINAL_TASK_STATES.has(task.state)) {
        void update(task, {
          state: 'failed',
          error: sanitizeError(error, 'TASK_WORKER_SPAWN_FAILED'),
          progress: terminalProgress(task, 'failed')
        }).catch(() => {});
      }
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        void settleTaskWorkerExit(task, entry, null, null);
        return;
      }
      send(child, { type: 'cancel' });
      scheduleForcedStop(task, entry);
    });
      child.once('exit', (code, signal) => {
        if (entry.attached) void settleTaskWorkerExit(task, entry, code, signal);
      });
      child.once('close', (code, signal) => {
        if (entry.attached) void settleTaskWorkerExit(task, entry, code, signal);
      });

      entry.watchdog = setInterval(() => {
      if (!entry.attached) return;
      if (TERMINAL_TASK_STATES.has(task.state)) {
        scheduleForcedStop(task, entry);
        return;
      }
      const heartbeatAge = Date.now() - Date.parse(task.heartbeatAt);
      if (heartbeatAge > heartbeatTimeoutMs) {
        if (!entry.diagnoseAt) {
          entry.diagnoseAt = Date.now();
          void update(task, {
            progress: {
              ...task.progress,
              message: 'Worker heartbeat delayed; capturing diagnostics'
            }
          }).catch(() => {});
          send(child, {
            type: 'diagnose',
            reason: 'heartbeat-timeout',
            outputDir: task.outputDir
          });
          return;
        }
        if (Date.now() - entry.diagnoseAt >= diagnosticGraceMs) {
          void update(task, {
            state: 'failed',
            health: { status: 'failed', checkedAt: nowIso() },
            error: { code: 'TASK_HEARTBEAT_TIMEOUT', message: 'Task worker stopped reporting heartbeats' },
            finishedAt: nowIso(),
            progress: terminalProgress(task, 'failed')
          }).catch(() => {});
          send(child, { type: 'cancel' });
          scheduleForcedStop(task, entry);
        }
        return;
      }

      const progressSensitive = ['starting_browser', 'running', 'recovering'].includes(task.state);
      if (!progressSensitive) return;
      const progressAge = Date.now() - Date.parse(task.progressAt || task.startedAt || task.createdAt);
      if (progressAge <= progressStallMs) return;
      if (!entry.stallDiagnoseAt) {
        entry.stallDiagnoseAt = Date.now();
        void update(task, {
          health: {
            status: 'stalled',
            since: task.progressAt || task.startedAt || task.createdAt,
            checkedAt: nowIso(),
            diagnosticRequested: true
          },
          progress: {
            ...task.progress,
            message: 'No task progress reported; capturing diagnostics'
          }
        }).catch(() => {});
        send(child, {
          type: 'diagnose',
          reason: 'progress-stalled',
          outputDir: task.outputDir
        });
        return;
      }
      if (progressAge >= progressFailureMs) {
        void update(task, {
          state: 'failed',
          health: { status: 'failed', checkedAt: nowIso() },
          error: {
            code: 'TASK_PROGRESS_STALLED',
            message: 'Task remained live but did not report meaningful progress before the stall deadline'
          },
          finishedAt: nowIso(),
          progress: terminalProgress(task, 'failed')
        }).catch(() => {});
        send(child, { type: 'cancel' });
        scheduleForcedStop(task, entry);
      }
    }, Math.min(
      5_000,
      Math.max(100, Math.floor(Math.min(heartbeatTimeoutMs, progressStallMs) / 3))
    ));
      entry.watchdog.unref?.();
      entry.attached = true;
      children.set(task.id, entry);
      return entry;
    } catch (error) {
      entry.attached = false;
      clearInterval(entry.watchdog);
      throw error;
    }
  }

  async function launchTaskAttempt(task) {
    if (task.state !== 'queued') return;
    const acquiringAt = nowIso();
    await update(task, {
      state: 'acquiring_profile',
      progress: { current: 0, total: null, message: 'Acquiring Profile' },
      progressAt: acquiringAt,
      heartbeatAt: acquiringAt,
      health: { status: 'healthy', checkedAt: acquiringAt }
    });
    let child;
    let entry;
    let startSent = false;
    let failureCode = 'TASK_WORKER_SPAWN_FAILED';
    try {
      if (task.state === 'cancelled') {
        throw new TaskServiceError('TASK_LAUNCH_CANCELLED', 'Queued task was cancelled before worker launch', 409);
      }
      const cleanupReceiptPath = taskCleanupReceiptPath(task);
      await rm(cleanupReceiptPath, { force: true });
      child = workerFactory(TASK_WORKER, 'task');
      entry = attachTaskWorker(task, child);
      if (task.state === 'cancelled') {
        throw new TaskServiceError('TASK_LAUNCH_CANCELLED', 'Queued task was cancelled before Profile acquisition', 409);
      }
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        throw new TaskServiceError('TASK_WORKER_SPAWN_FAILED', 'Task worker has no valid process ID', 500);
      }
      failureCode = 'PROFILE_LEASE_FAILED';
      const leasedProfile = await profileStore.acquireLease(task.profileId, task.leaseOwner, {
        pid: child.pid,
        ttlMs: LEASE_TTL_MS,
        cleanupRequired: true,
        ...taskLeaseAccess(task)
      });
      task.leaseHeld = true;
      if (task.state === 'cancelled') {
        throw new TaskServiceError('TASK_LAUNCH_CANCELLED', 'Queued task was cancelled before browser startup', 409);
      }
      failureCode = 'TASK_WORKER_START_FAILED';
      const startingAt = nowIso();
      const behavior = resolveProfileBehavior(leasedProfile);
      setAttemptHistoryBehavior(task, behavior);
      await update(task, {
        state: 'starting_browser',
        startedAt: startingAt,
        workerPid: child.pid,
        behavior,
        behaviorState: {
          configured: behavior,
          effective: behavior === 'adaptive' ? 'fast' : behavior,
          at: startingAt
        },
        history: task.history,
        progress: { current: 0, total: null, message: 'Starting browser' },
        progressAt: startingAt,
        heartbeatAt: startingAt,
        health: { status: 'healthy', checkedAt: startingAt }
      });
      if (task.state === 'cancelled') {
        throw new TaskServiceError('TASK_LAUNCH_CANCELLED', 'Queued task was cancelled before its start command', 409);
      }
      startSent = await sendChildMessageConfirmed(child, {
        type: 'start',
        config: {
          taskId: task.id,
          profile: leasedProfile,
          modulePath: task.modulePath,
          input: clone(task.input),
          behavior,
          outputDir: task.outputDir,
          checkpointPath: path.join(root, task.id, 'checkpoint.json'),
          ...(task.resumeInput ? { resumeCheckpoint: clone(task.resumeInput) } : {}),
          cleanupReceiptPath,
          attempt: task.attempt,
          heartbeatMs: 20_000,
          ...(task.timeoutMs ? { timeoutMs: task.timeoutMs } : {})
        }
      });
      if (!startSent) {
        throw new TaskServiceError('TASK_WORKER_START_FAILED', 'Task worker did not accept its start command', 500);
      }
    } catch (error) {
      const hasWorkerPid = Number.isSafeInteger(child?.pid) && child.pid > 0;
      if (task.state !== 'cancelled') {
        await update(task, {
          state: 'failed',
          error: sanitizeError(error, failureCode),
          progress: terminalProgress(task, 'failed'),
          finishedAt: nowIso(),
          ...(hasWorkerPid ? { workerPid: child.pid, startedAt: task.startedAt || nowIso() } : {})
        });
      }
      if (!startSent) {
        task.cleanup.browserClosed = true;
        await releaseTaskLease(task);
      }
      try {
        child?.kill?.('SIGKILL');
      } catch {
        // Startup never reached the task module; durable cleanup state remains fail-closed below.
      }
      if (entry) {
        if (!(await waitForEntry(entry.exitPromise, workerHardKillGraceMs))) {
          if (!(await processAlive(child.pid))) {
            await finalizeTask(task, child.exitCode, 'SIGKILL');
          } else {
            scheduleForcedStop(task, entry);
          }
        }
      } else {
        task.cleanup.workerExited = !Number.isSafeInteger(child?.pid) || child.pid <= 0 ||
          child.exitCode !== null || !(await processAlive(child.pid));
        refreshCleanupSettled(task);
        finishAttemptHistory(task);
        await update(task, { cleanup: task.cleanup, history: task.history });
      }
    }
  }

  async function create(body = {}, caller = {}) {
    requireServiceOpen();
    const operation = createTail.then(() => createSerialized(body, caller));
    createTail = operation.catch(() => {});
    return operation;
  }

  async function createSerialized(body = {}, suppliedCaller = {}) {
    await ready;
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    const allowed = new Set([
      'profileId',
      'taskType',
      'input',
      'timeoutMs',
      'idempotencyKey'
    ]);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new TaskServiceError('INVALID_TASK_CREATE', `Unsupported task fields: ${unknown.join(', ')}`);
    }
    if (typeof body.profileId !== 'string' || !body.profileId) {
      throw new TaskServiceError('PROFILE_REQUIRED', 'profileId is required');
    }
    if (typeof body.taskType !== 'string' || !body.taskType) {
      throw new TaskServiceError('TASK_TYPE_REQUIRED', 'taskType is required');
    }
    if (
      typeof body.idempotencyKey !== 'string' ||
      !/^[a-zA-Z0-9._:-]{1,128}$/.test(body.idempotencyKey)
    ) {
      throw new TaskServiceError(
        'IDEMPOTENCY_KEY_REQUIRED',
        'idempotencyKey must contain 1-128 letters, numbers, dots, underscores, colons, or hyphens'
      );
    }

    const profile = requireProfileUse(await profileStore.get(body.profileId), caller);
    const taskType = await registry.resolve(body.taskType);
    const behavior = resolveProfileBehavior(profile);
    if (
      body.timeoutMs !== undefined &&
      (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1_000 || body.timeoutMs > MAX_TASK_TIMEOUT_MS)
    ) {
      throw new TaskServiceError('INVALID_TASK_TIMEOUT', 'timeoutMs must be an integer from 1000 to 86400000');
    }
    const input = body.input ?? {};
    validateTaskInput(input, taskType.inputSchema);
    const hashInput = {
      profileId: body.profileId,
      taskType: body.taskType,
      taskTypeSha256: taskType.sha256,
      supportsResume: taskType.supportsResume === true,
      timeoutMs: body.timeoutMs ?? null,
      input
    };
    const hash = requestHash(hashInput);
    const existing = [...tasks.values()].find((task) => (
      isTaskOwner(task, caller) && task.idempotencyKey === body.idempotencyKey
    ));
    if (existing) {
      const legacyHash = existing.requestHashVersion === undefined
        ? requestHash({ ...hashInput, behavior: existing.behavior })
        : null;
      if (existing.requestHash !== hash && existing.requestHash !== legacyHash) {
        throw new TaskServiceError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency key is already bound to a different task request',
          409
        );
      }
      return readPublicRecord(existing);
    }
    if (queuedTasks().length >= maxQueuedTasks) {
      throw new TaskServiceError('TASK_QUEUE_FULL', 'Task queue reached its configured capacity', 429);
    }

    const id = taskId();
    const taskRoot = path.join(root, id);
    const outputDir = path.join(taskRoot, 'output');
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const task = {
      id,
      profileId: body.profileId,
      taskType: taskType.name,
      taskTypeSha256: taskType.sha256,
      supportsResume: taskType.supportsResume === true,
      modulePath: taskType.modulePath,
      ownerRole: caller.role,
      ownerClientId: caller.clientId,
      ...(caller.role === 'agent' ? { ownerAgentName: caller.agentName } : {}),
      idempotencyKey: body.idempotencyKey,
      requestHash: hash,
      requestHashVersion: 2,
      behavior,
      input: clone(input),
      timeoutMs: body.timeoutMs ?? null,
      attempt: 1,
      history: [],
      resumeKeys: [],
      state: 'queued',
      currentActivity: lifecycleActivity('queued'),
      progress: { current: 0, total: null, message: 'Queued' },
      progressAt: nowIso(),
      heartbeatAt: nowIso(),
      health: { status: 'healthy', checkedAt: nowIso() },
      behaviorState: {
        configured: behavior,
        effective: behavior === 'adaptive' ? 'fast' : behavior,
        at: nowIso()
      },
      cooldown: null,
      outputDir,
      checkpoint: null,
      resumeInput: null,
      resumeCheckpointValid: false,
      result: null,
      error: null,
      cleanup: { browserClosed: false, leaseReleased: false, workerExited: false, settled: false },
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
      leaseOwner: `task:${id}`,
      leaseHeld: false
    };
    beginAttemptHistory(task);
    tasks.set(id, task);
    await persist(task);
    await scheduleQueuedTasks();
    await awaitTaskPersistence(id);
    return publicRecord(task);
  }

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

  async function recoverDiagnosticsPointers(task) {
    const diagnostics = await inspectDiagnosticsManifest(task);
    if (!diagnostics) return false;
    let changed = false;
    for (const [manifestKey, taskKey] of [
      ['screenshot', 'lastScreenshot'],
      ['observation', 'lastObservation']
    ]) {
      const candidate = diagnostics[manifestKey];
      if (!candidate) continue;
      const existingAt = Date.parse(task[taskKey]?.at || '');
      if (!task[taskKey] || Number.isNaN(existingAt) || Date.parse(candidate.at) > existingAt) {
        task[taskKey] = candidate;
        changed = true;
      }
    }
    return changed;
  }

  async function refreshResumeCheckpointState(task) {
    if (
      task.supportsResume !== true || task.state !== 'failed' ||
      task.cleanup?.settled !== true
    ) {
      task.resumeCheckpointValid = false;
      task.resumeCheckpointError = null;
      return false;
    }
    try {
      // A resumed attempt may durably replace checkpoint.json and then lose its
      // IPC notification. An older pointer must not hide that newer, valid
      // generation; inspectResumeCheckpoint still requires the current attempt.
      const checkpoint = task.checkpoint === null || task.checkpoint === undefined ||
        task.checkpoint.attempt !== task.attempt
        ? await inspectResumeCheckpoint(task)
        : await verifyResumeCheckpoint(task);
      const { source: _source, ...pointer } = checkpoint;
      task.checkpoint = pointer;
      task.resumeCheckpointValid = true;
      task.resumeCheckpointError = null;
      return true;
    } catch (error) {
      task.resumeCheckpointValid = false;
      task.resumeCheckpointError = sanitizeError(error, 'TASK_CHECKPOINT_INVALID');
      return false;
    }
  }

  async function recoverResumeCheckpointPointer(task) {
    if (task.checkpoint?.attempt === task.attempt) return false;
    let checkpoint;
    try {
      checkpoint = await inspectResumeCheckpoint(task);
    } catch {
      return false;
    }
    const { source: _source, ...pointer } = checkpoint;
    task.checkpoint = pointer;
    task.resumeCheckpointValid = true;
    await update(task, { checkpoint: task.checkpoint, resumeCheckpointValid: true });
    return true;
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

  async function resume(id, body = {}, caller = {}) {
    requireServiceOpen();
    const operation = createTail.then(() => resumeSerialized(id, body, caller));
    createTail = operation.catch(() => {});
    return operation;
  }

  async function resumeSerialized(id, body = {}, suppliedCaller = {}) {
    await ready;
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || !isTaskOwner(task, caller)) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'resumeKey')) {
      throw new TaskServiceError('INVALID_TASK_RESUME', 'Resume accepts only resumeKey');
    }
    if (typeof body.resumeKey !== 'string' || !RESUME_KEY_PATTERN.test(body.resumeKey)) {
      throw new TaskServiceError(
        'RESUME_KEY_REQUIRED',
        'resumeKey must contain 8-128 letters, numbers, dots, underscores, colons, or hyphens'
      );
    }
    const keyHash = requestHash({
      taskId: task.id,
      ownerRole: task.ownerRole,
      ownerClientId: task.ownerClientId,
      resumeKey: body.resumeKey
    });
    task.resumeKeys = Array.isArray(task.resumeKeys) ? task.resumeKeys : [];
    if (task.resumeKeys.some((entry) => entry?.keyHash === keyHash)) return readPublicRecord(task);
    if (task.state !== 'failed') {
      throw new TaskServiceError('TASK_NOT_RESUMABLE', 'Only a failed terminal task can be resumed explicitly', 409);
    }
    if (task.supportsResume !== true) {
      throw new TaskServiceError('TASK_NOT_RESUMABLE', 'This task type does not support checkpoint resume', 409);
    }
    await reconcileTaskForRead(task);
    await awaitTaskPersistence(task.id);
    if (task.cleanup?.settled !== true) {
      throw new TaskServiceError('TASK_CLEANUP_NOT_SETTLED', 'Task cleanup must settle before resume', 409);
    }
    await recoverResumeCheckpointPointer(task);
    if (!task.checkpoint) {
      throw new TaskServiceError('TASK_CHECKPOINT_REQUIRED', 'Task has no checkpoint to resume', 409);
    }
    normalizeAttemptHistory(task);
    if (task.attempt >= MAX_ATTEMPTS) {
      throw new TaskServiceError('TASK_ATTEMPT_LIMIT_REACHED', `Task cannot exceed ${MAX_ATTEMPTS} attempts`, 409);
    }
    await verifyResumeContext(task);
    await verifyResumeModule(task);
    const checkpoint = await verifyResumeCheckpoint(task);
    const resumeInput = await createResumeInput(task, checkpoint);
    const profile = requireProfileUse(await profileStore.get(task.profileId), caller);
    const behavior = resolveProfileBehavior(profile);

    task.attempt += 1;
    task.resumeKeys.push({ keyHash, attempt: task.attempt, requestedAt: nowIso() });
    task.resumeKeys = task.resumeKeys.slice(-MAX_ATTEMPTS);
    task.state = 'queued';
    task.currentActivity = lifecycleActivity('queued');
    task.progress = {
      current: 0,
      total: null,
      message: `Resume attempt ${task.attempt} queued from checkpoint`
    };
    task.heartbeatAt = nowIso();
    task.result = null;
    task.error = null;
    task.completion = null;
    task.completionClaimed = false;
    task.cleanup = { browserClosed: false, leaseReleased: false, workerExited: false, settled: false };
    task.startedAt = null;
    task.finishedAt = null;
    task.workerPid = null;
    task.leaseHeld = false;
    task.lastScreenshot = null;
    task.lastObservation = null;
    await rm(path.join(root, task.id, 'diagnostics.json'), { force: true });
    task.resumeCheckpointValid = true;
    task.resumeInput = resumeInput;
    task.progressAt = nowIso();
    task.health = { status: 'healthy', checkedAt: nowIso() };
    task.behavior = behavior;
    task.behaviorState = {
      configured: behavior,
      effective: behavior === 'adaptive' ? 'fast' : behavior,
      at: nowIso()
    };
    task.cooldown = null;
    beginAttemptHistory(task, { resumed: true, checkpointSavedAt: checkpoint.savedAt });
    await persist(task);
    await scheduleQueuedTasks();
    await awaitTaskPersistence(task.id);
    return publicRecord(task);
  }

  async function list({ caller: suppliedCaller = {}, limit = 50, cursor = null } = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TaskServiceError('INVALID_TASK_LIMIT', 'Task list limit must be from 1 to 100');
    }
    await Promise.all([...tasks.keys()].map(awaitTaskPersistence));
    const visible = [...tasks.values()]
      .filter((task) => canAccess(task, caller))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      ));
    let start = 0;
    if (cursor) {
      const cursorId = decodeCursor(cursor);
      const index = visible.findIndex((task) => task.id === cursorId);
      if (index === -1) throw new TaskServiceError('INVALID_TASK_CURSOR', 'Task cursor is invalid');
      start = index + 1;
    }
    const page = visible.slice(start, start + limit);
    const records = await Promise.all(page.map(readPublicRecord));
    return {
      tasks: records,
      nextCursor: start + limit < visible.length ? encodeCursor(page.at(-1)) : null
    };
  }

  async function get(id, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || !canAccess(task, caller)) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    return readPublicRecord(task);
  }

  async function readPublicRecord(task) {
    await awaitTaskPersistence(task.id);
    await reconcileTaskForRead(task);
    await awaitTaskPersistence(task.id);
    // Finalization may make cleanup settled while the first reconciliation is
    // awaiting an older persistence generation. Re-check that exact terminal
    // transition before publishing a record so `cleanup.settled: true` can
    // never be paired with a stale false `resumeAvailable` value.
    if (
      task.supportsResume === true && task.state === 'failed' && task.checkpoint &&
      task.cleanup?.settled === true && task.resumeCheckpointValid !== true
    ) {
      await reconcileTaskForRead(task);
      await awaitTaskPersistence(task.id);
    }
    return publicRecord(task);
  }

  async function reconcileTaskForRead(task) {
    let changed = await recoverDiagnosticsPointers(task);
    if (taskCleanupNeedsReconciliation(task)) {
      try {
        const profile = await profileStore.get(task.profileId);
        await reconcileAnyCleanup(profile);
      } catch {
        // The persisted task remains explicitly unsettled; callers can time out
        // and retry without receiving a false completion.
      }
    }
    const previousResumeState = task.resumeCheckpointValid;
    const previousCheckpoint = JSON.stringify(task.checkpoint);
    const previousResumeError = JSON.stringify(task.resumeCheckpointError || null);
    await refreshResumeCheckpointState(task);
    changed ||= previousResumeState !== task.resumeCheckpointValid ||
      previousCheckpoint !== JSON.stringify(task.checkpoint) ||
      previousResumeError !== JSON.stringify(task.resumeCheckpointError || null);
    if (task.state === 'completed' && task.completion?.integrity !== 'invalid') {
      try {
        await verifyCompletionGate(task);
      } catch {
        const invalidAt = nowIso();
        task.state = 'failed';
        task.currentActivity = lifecycleActivity('failed');
        task.error = {
          code: 'TASK_COMPLETION_INTEGRITY_FAILED',
          message: 'Previously verified completion evidence is missing, changed, or unstable.'
        };
        task.completion = { ...(task.completion || {}), integrity: 'invalid', invalidAt };
        task.progress = terminalProgress(task, 'failed');
        task.health = { status: 'failed', checkedAt: invalidAt };
        finishAttemptHistory(task);
        changed = true;
      }
    }
    if (changed) await persist(task);
  }

  function taskCleanupNeedsReconciliation(task) {
    return task.cleanup?.settled !== true && (
      task.cleanup?.workerExited === true || task.cleanup?.managerRestartObserved === true
    );
  }

  async function getInternal(id) {
    await ready;
    const task = tasks.get(id);
    if (!task) throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    await awaitTaskPersistence(id);
    return clone(task);
  }

  function artifactDeclarations(task, { includeUnverifiedResult = false } = {}) {
    const resultVerified = task.state === 'completed' && task.completion?.integrity !== 'invalid' &&
      typeof task.completion?.verifiedAt === 'string';
    const declarations = resultVerified || includeUnverifiedResult
      ? declaredArtifactFiles(task).map((relativePath) => ({ relativePath, kind: 'result' }))
      : [];
    if (task.lastScreenshot?.attempt === task.attempt && typeof task.lastScreenshot?.path === 'string') {
      const relativePath = path.relative(task.outputDir, task.lastScreenshot.path);
      if (
        relativePath &&
        !path.isAbsolute(relativePath) &&
        relativePath !== '..' &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !declarations.some((item) => item.relativePath === relativePath)
      ) {
        // A diagnostic screenshot is the last-resort evidence for an Agent. Reserve
        // capacity for it even when a task declares the maximum number of outputs.
        declarations.unshift({ relativePath, kind: 'diagnostic-screenshot' });
      }
    }
    if (task.lastObservation?.attempt === task.attempt && typeof task.lastObservation?.path === 'string') {
      const relativePath = path.relative(task.outputDir, task.lastObservation.path);
      if (
        relativePath &&
        !path.isAbsolute(relativePath) &&
        relativePath !== '..' &&
        !relativePath.startsWith(`..${path.sep}`) &&
        !declarations.some((item) => item.relativePath === relativePath)
      ) {
        declarations.unshift({ relativePath, kind: 'diagnostic-observation' });
      }
    }
    return declarations.slice(0, MAX_ARTIFACTS).map(({ relativePath, kind }) => ({
      id: artifactId(task.id, relativePath),
      relativePath,
      name: path.basename(relativePath).slice(0, 255),
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

  function artifactDigestKey(task, declaration, stats) {
    return [
      task.id,
      declaration.id,
      stats.dev,
      stats.ino,
      stats.size,
      stats.mtimeNs
    ].join(':');
  }

  function cacheArtifactDigest(task, declaration, stats, digest) {
    const key = artifactDigestKey(task, declaration, stats);
    artifactDigestCache.delete(key);
    artifactDigestCache.set(key, digest);
    while (artifactDigestCache.size > 1_024) {
      artifactDigestCache.delete(artifactDigestCache.keys().next().value);
    }
    return digest;
  }

  async function cachedArtifactDigest(task, declaration, handle, stats) {
    const key = artifactDigestKey(task, declaration, stats);
    const cached = artifactDigestCache.get(key);
    if (cached) {
      artifactDigestCache.delete(key);
      artifactDigestCache.set(key, cached);
      return cached;
    }
    return cacheArtifactDigest(
      task,
      declaration,
      stats,
      await hashOpenFile(handle, Number(stats.size))
    );
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
      !sameFileIdentity(expectedStats, current) || !sameFileIdentity(expectedStats, canonicalStats) ||
      expectedStats.size !== current.size || expectedStats.mtimeNs !== current.mtimeNs
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
        opened.size > BigInt(Number.MAX_SAFE_INTEGER) || !sameFileIdentity(before, opened)
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
        !sameFileIdentity(opened, current) || !sameFileIdentity(opened, canonicalStats)
      ) {
        throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact was not found', 404);
      }
      await artifactValidationHook?.({ stage: 'after-validation', taskId: task.id, candidate });
      if (
        verifyCompletionAnchor && declaration.kind === 'result' &&
        Array.isArray(task.completion?.artifacts)
      ) {
        const anchor = Array.isArray(task.completion?.artifacts)
          ? task.completion.artifacts.find((item) => item?.artifactId === declaration.id)
          : null;
        if (
          !anchor || !Number.isSafeInteger(anchor.sizeBytes) || anchor.sizeBytes !== Number(opened.size) ||
          typeof anchor.sha256 !== 'string' ||
          anchor.sha256 !== await cachedArtifactDigest(task, declaration, handle, opened)
        ) {
          throw new TaskServiceError('ARTIFACT_INTEGRITY_FAILED', 'Completed task evidence changed after verification', 409);
        }
        const afterHash = await handle.stat({ bigint: true });
        if (
          !sameFileIdentity(opened, afterHash) || opened.size !== afterHash.size || opened.mtimeNs !== afterHash.mtimeNs
        ) {
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
        // Missing or unstable declared artifacts are omitted rather than exposing a partial path.
      } finally {
        await opened?.handle.close().catch(() => {});
      }
    }
    return artifacts;
  }

  async function listArtifacts(id, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || !canAccess(task, caller)) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    await awaitTaskPersistence(id);
    await reconcileTaskForRead(task);
    await awaitTaskPersistence(id);
    if (task.completion?.integrity === 'invalid') {
      throw new TaskServiceError('ARTIFACT_INTEGRITY_FAILED', 'Completed task evidence changed after verification', 409);
    }
    const artifacts = await collectArtifacts(task);
    return artifacts;
  }

  async function readArtifact(id, requestedArtifactId, options = {}, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || !canAccess(task, caller)) {
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
      if (
        !afterRead.isFile() || afterRead.nlink !== 1n ||
        !sameFileIdentity(stats, afterRead) ||
        afterRead.size !== stats.size || afterRead.mtimeNs !== stats.mtimeNs
      ) {
        throw new TaskServiceError('ARTIFACT_NOT_FOUND', 'Artifact changed while it was being read', 404);
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

  async function cancel(id, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || !canAccess(task, caller)) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    if (TERMINAL_TASK_STATES.has(task.state)) return readPublicRecord(task);
    await update(task, {
      state: 'cancelled',
      health: { status: 'cancelled', checkedAt: nowIso() },
      progress: terminalProgress(task, 'cancelled'),
      finishedAt: nowIso()
    });
    const entry = children.get(id);
    if (entry) {
      send(entry.child, { type: 'cancel' });
      scheduleForcedStop(task, entry);
    } else {
      await releaseTaskLease(task);
      task.cleanup.browserClosed = true;
      task.cleanup.workerExited = true;
      refreshCleanupSettled(task);
      finishAttemptHistory(task);
      await update(task, { cleanup: task.cleanup, history: task.history });
    }
    void scheduleQueuedTasks().catch(() => {});
    return publicRecord(task);
  }

  async function continueTask(id, body = {}, suppliedCaller = {}) {
    await ready;
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || !canAccess(task, caller)) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    const allowed = new Set(['requestId', 'note']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new TaskServiceError('INVALID_TASK_CONTINUE', `Unsupported continue fields: ${unknown.join(', ')}`);
    }
    if (task.state !== 'waiting_user' || task.userRequest?.status !== 'pending') {
      throw new TaskServiceError('TASK_NOT_WAITING_USER', 'Task is not waiting for a new instruction', 409);
    }
    const requestId = body.requestId || task.userRequest.id;
    if (!HANDOFF_ID_PATTERN.test(requestId) || requestId !== task.userRequest.id) {
      throw new TaskServiceError('USER_HANDOFF_MISMATCH', 'Handoff request ID does not match the live task', 409);
    }
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2_000)) {
      throw new TaskServiceError('INVALID_TASK_CONTINUE', 'note must contain at most 2000 characters');
    }
    const entry = children.get(id);
    if (!entry || !(await sendChildMessageConfirmed(entry.child, {
      type: 'continue', requestId, note: body.note || ''
    }))) {
      throw new TaskServiceError('TASK_WORKER_UNAVAILABLE', 'Task worker is unavailable for continuation', 409);
    }
    task.userRequest = {
      ...task.userRequest,
      status: 'continued',
      continuedAt: nowIso(),
      ...(body.note?.trim() ? { note: redactSensitiveText(body.note).slice(0, 2_000) } : {})
    };
    await update(task, {
      state: 'recovering',
      userRequest: task.userRequest,
      progress: { ...task.progress, message: 'New instruction received; verifying live page state' },
      progressAt: nowIso(),
      health: { status: 'healthy', checkedAt: nowIso() }
    });
    return publicRecord(task);
  }

  async function installTaskType(input, suppliedCaller = {}) {
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_TYPE_INSTALL_FORBIDDEN', 'Only Manager admin can install task types', 403);
    }
    return registry.install(input);
  }

  async function installTaskPack(input = {}, suppliedCaller = {}) {
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_PACK_INSTALL_FORBIDDEN', 'Only Manager admin can install Task Packs', 403);
    }
    const allowed = new Set(['name', 'version', 'title', 'description', 'modules']);
    const unknown = Object.keys(input).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new TaskServiceError('INVALID_TASK_PACK', `Unsupported Task Pack fields: ${unknown.join(', ')}`);
    }
    if (
      typeof input.name !== 'string' || !/^[a-z][a-z0-9._-]{0,79}$/.test(input.name) ||
      typeof input.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input.version)
    ) {
      throw new TaskServiceError('INVALID_TASK_PACK', 'Task Pack name or semantic version is invalid');
    }
    if (!Array.isArray(input.modules) || input.modules.length < 1 || input.modules.length > 64) {
      throw new TaskServiceError('INVALID_TASK_PACK', 'Task Pack must contain 1 to 64 modules');
    }
    const modules = input.modules.map((item) => {
      if (
        !item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).some((key) => !['name', 'modulePath'].includes(key)) ||
        typeof item.name !== 'string' || typeof item.modulePath !== 'string'
      ) {
        throw new TaskServiceError('INVALID_TASK_PACK', 'Every Task Pack module must contain name and modulePath');
      }
      return { name: item.name, modulePath: item.modulePath };
    });
    const taskTypes = await registry.installBatch(modules, {
      pack: { name: input.name, version: input.version }
    });
    return {
      name: input.name,
      version: input.version,
      ...(typeof input.title === 'string' ? { title: input.title.slice(0, 120) } : {}),
      ...(typeof input.description === 'string' ? { description: input.description.slice(0, 2_000) } : {}),
      taskTypes
    };
  }

  async function listTaskTypes(filters = {}, suppliedCaller = undefined) {
    const legacyCaller = suppliedCaller === undefined && (filters.role || filters.clientId);
    const caller = legacyCaller ? filters : suppliedCaller;
    callerIdentity(caller || {});
    const requestedFilters = legacyCaller ? {} : filters;
    const taskTypes = filterTaskTypes(await registry.listSummaries(), requestedFilters);
    return { taskTypes, total: taskTypes.length };
  }

  async function describeTaskType(name, suppliedCaller = {}) {
    callerIdentity(suppliedCaller);
    if (typeof name !== 'string' || !name) {
      throw new TaskServiceError('TASK_TYPE_REQUIRED', 'Task type is required');
    }
    return registry.describe(name);
  }

  async function openProfile(
    profileId,
    suppliedCaller = { role: 'manager-admin', clientId: 'manager-admin' }
  ) {
    await ready;
    requireServiceOpen();
    const caller = profileCallerIdentity(suppliedCaller);
    let requestedProfile = requireProfileUse(await profileStore.get(profileId), caller);
    requestedProfile = await reconcileAnyCleanup(requestedProfile);
    requireProfileUse(requestedProfile, caller);
    if (/^session-import:/u.test(requestedProfile.lease?.ownerId || '')) {
      throw new TaskServiceError(
        'LEGACY_SESSION_IMPORT_CLEANUP_UNCONFIRMED',
        'A legacy session import has no trusted cleanup proof; this Profile remains quarantined',
        409
      );
    }
    const existing = openProfiles.get(profileId);
    if (existing) {
      if (caller.role !== 'manager-admin' && !isSamePrincipal(existing, caller)) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is open for another client', 409);
      }
      if (!existing.exited) {
        return { status: 'open', profileId, pid: existing.child.pid };
      }
      // Never report a dead manual worker as an open browser. A valid cleanup
      // receipt permits the old entry to release and a new worker to start;
      // missing or invalid proof keeps the Profile quarantined explicitly.
      await existing.cleanupReportPromise;
      if (!(await existing.release())) {
        await markCleanupUnknown(profileId, existing.ownerId);
        throw new TaskServiceError(
          'PROFILE_CLEANUP_UNCONFIRMED',
          'The previous Profile browser exited without confirmed cleanup; the Profile remains blocked',
          409
        );
      }
      requestedProfile = await reconcileAnyCleanup(await profileStore.get(profileId));
      requireProfileUse(requestedProfile, caller);
    }
    const pending = openingProfiles.get(profileId);
    if (pending) {
      if (caller.role !== 'manager-admin' && !isSamePrincipal(pending, caller)) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is opening for another client', 409);
      }
      return pending.promise;
    }
    const operation = openProfileSingle(profileId, caller);
    openingProfiles.set(profileId, {
      promise: operation,
      ownerRole: caller.role,
      ownerClientId: caller.clientId
    });
    try {
      return await operation;
    } finally {
      if (openingProfiles.get(profileId)?.promise === operation) openingProfiles.delete(profileId);
    }
  }

  async function openProfileSingle(profileId, caller) {
    const ownerRole = caller.role;
    const ownerClientId = caller.clientId;
    const leaseAccess = caller.role === 'agent' ? { authorizedClientId: caller.clientId } : {};
    const ownerId = `profile-open:${ownerClientId}:${profileId}:${randomUUID().replaceAll('-', '')}`;
    const profile = await profileStore.get(profileId);
    if ((profile.kind || 'persistent') === 'ephemeral') {
      throw new TaskServiceError(
        'EPHEMERAL_PROFILE_OPEN_UNSUPPORTED',
        'Ephemeral Profiles are created only for task-scoped browser contexts',
        409
      );
    }
    const cleanupReceiptPath = profileCleanupReceiptPath(ownerId);
    let child;
    try {
      await rm(cleanupReceiptPath, { force: true });
      child = workerFactory(PROFILE_WORKER, 'profile-open');
      if (
        !child ||
        typeof child.once !== 'function' ||
        typeof child.on !== 'function' ||
        typeof child.send !== 'function' ||
        typeof child.kill !== 'function'
      ) {
        throw new TaskServiceError('PROFILE_WORKER_INVALID', 'Profile worker could not be initialized', 500);
      }
    } catch (error) {
      child?.kill?.('SIGKILL');
      throw error;
    }
    let resolveExit;
    let resolveCleanupReport;
    const entry = {
      child,
      ownerId,
      ownerRole,
      ownerClientId,
      released: false,
      exited: false,
      cleanupReported: false,
      cleanupConfirmed: false,
      browserStartSent: false,
      spawnFailed: false,
      renewal: null,
      renewalTail: Promise.resolve(),
      closing: false,
      lastHeartbeatAt: Date.now(),
      cleanupReceiptPath,
      exitPromise: new Promise((resolve) => { resolveExit = resolve; }),
      cleanupReportPromise: new Promise((resolve) => { resolveCleanupReport = resolve; }),
      releasePromise: null
    };
    openProfiles.set(profileId, entry);

    const release = async () => {
      if (entry.released) return true;
      if (!entry.exited || !entry.cleanupConfirmed) return false;
      if (entry.releasePromise) return entry.releasePromise;
      entry.releasePromise = (async () => {
        entry.closing = true;
        clearInterval(entry.renewal);
        await entry.renewalTail.catch(() => {});
        let released = await profileStore.releaseLease(profileId, ownerId, { cleanupConfirmed: true });
        if (released !== true) {
          const current = await profileStore.get(profileId);
          released = current?.lease?.ownerId !== ownerId;
        }
        if (!released) return false;
        await removeCleanupReceipt(cleanupReceiptPath).catch(() => {});
        entry.released = true;
        if (openProfiles.get(profileId) === entry) openProfiles.delete(profileId);
        void scheduleQueuedTasks().catch(() => {});
        return true;
      })().catch(() => false);
      const released = await entry.releasePromise;
      if (!released) entry.releasePromise = null;
      return released;
    };
    entry.release = release;
    const confirmCleanup = async (browserClosed) => {
      if (entry.cleanupReported) return entry.cleanupReportPromise;
      entry.cleanupReported = true;
      entry.cleanupConfirmed = browserClosed === true &&
        await verifyCleanupReceipt(cleanupReceiptPath, {
          kind: 'profile',
          profileId,
          ownerId,
          workerPid: child.pid
        });
      resolveCleanupReport();
      await release();
      return entry.cleanupConfirmed;
    };
    try {
      child.once('exit', (code, signal) => {
        entry.exited = true;
        entry.exitCode = code;
        entry.exitSignal = signal || null;
        resolveExit();
        // A private, identity-bound receipt remains authoritative when the
        // child exits after closing Chromium but its final IPC message is lost.
        // `closed` normally arrives before `exit`. In that ordering the first
        // cleanup confirmation cannot release the lease yet, so the exit edge
        // must always retry the idempotent release after confirmation settles.
        void confirmCleanup(true).then(() => release());
      });
      child.once('error', () => {
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
          entry.spawnFailed = true;
          entry.exited = true;
          entry.cleanupReported = true;
          entry.cleanupConfirmed = true;
          resolveCleanupReport();
          resolveExit();
          void release();
        }
      });
      child.on('message', (message) => {
        if (message?.type === 'heartbeat') entry.lastHeartbeatAt = Date.now();
        if (message?.type === 'closed' && !entry.cleanupReported) {
          void confirmCleanup(message.browserClosed === true);
        }
      });
    } catch (error) {
      if (openProfiles.get(profileId) === entry) openProfiles.delete(profileId);
      try {
        child.kill('SIGKILL');
      } catch {
        // The worker never received a browser-start command and owns no Profile lease.
      }
      throw error;
    }

    try {
      await profileStore.acquireLease(profileId, ownerId, {
        pid: child.pid,
        ttlMs: 5 * 60_000,
        cleanupRequired: true,
        ...leaseAccess
      });
      if (entry.exited) {
        throw new TaskServiceError('PROFILE_OPEN_FAILED', 'Profile worker exited before browser startup', 500);
      }
      let openTimer;
      const openResult = new Promise((resolve, reject) => {
        openTimer = setTimeout(
          () => reject(new TaskServiceError('PROFILE_OPEN_TIMEOUT', 'Profile did not open in time', 504)),
          TASK_SERVICE_DEADLINES.profileOpenMs
        );
        child.on('message', (message) => {
          if (message?.type === 'ready') {
            clearTimeout(openTimer);
            resolve(message);
          }
          if (message?.type === 'error') {
            clearTimeout(openTimer);
            reject(Object.assign(new Error(message.error?.message), message.error));
          }
        });
      });
      openResult.catch(() => {});
      entry.browserStartSent = await sendChildMessageConfirmed(child, {
        type: 'open',
        profile,
        cleanupReceiptPath,
        cleanupReceipt: { kind: 'profile', profileId, ownerId }
      });
      if (!entry.browserStartSent) {
        clearTimeout(openTimer);
        throw new TaskServiceError('PROFILE_OPEN_SEND_FAILED', 'Profile worker is unavailable', 500);
      }
      const result = await openResult;
      void result;
      if (entry.exited) throw new TaskServiceError('PROFILE_OPEN_FAILED', 'Profile worker exited while opening', 500);
      entry.renewal = setInterval(() => {
        if (entry.closing || entry.released) return;
        if (Date.now() - entry.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
          void closeProfile(profileId, { role: 'manager-admin', clientId: 'manager-admin' }).catch(() => {});
          return;
        }
        const renewal = entry.renewalTail.then(async () => {
          if (entry.closing || entry.released) return;
          await profileStore.acquireLease(profileId, ownerId, {
            pid: child.pid,
            ttlMs: 5 * 60_000,
            cleanupRequired: true,
            ...leaseAccess
          });
        });
        entry.renewalTail = renewal.catch(() => {
          if (!entry.closing && !entry.released) send(child, { type: 'close' });
        });
      }, profileLeaseRenewalMs);
      entry.renewal.unref?.();
      return { status: 'open', profileId, pid: child.pid };
    } catch (error) {
      if (!entry.browserStartSent) {
        if (!entry.exited) {
          child.kill?.('SIGKILL');
          await waitForEntry(entry.exitPromise, TASK_SERVICE_DEADLINES.profileKillGraceMs);
        }
        entry.cleanupReported = true;
        entry.cleanupConfirmed = entry.exited;
        resolveCleanupReport();
        if (!(await entry.release())) await markCleanupUnknown(profileId, ownerId);
      } else {
        send(child, { type: 'close' });
        await shutdownProfileEntry(profileId, entry);
      }
      throw error;
    }
  }

  async function waitForEntry(promise, timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        promise.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function shutdownProfileEntry(profileId, entry) {
    send(entry.child, { type: 'close' });
    await waitForEntry(
      Promise.allSettled([entry.cleanupReportPromise, entry.exitPromise]),
      TASK_SERVICE_DEADLINES.profileCloseMs
    );
    if (!entry.exited) {
      entry.child.kill?.('SIGTERM');
      await waitForEntry(entry.exitPromise, TASK_SERVICE_DEADLINES.profileKillGraceMs);
    }
    if (!entry.exited) {
      entry.child.kill?.('SIGKILL');
      await waitForEntry(entry.exitPromise, TASK_SERVICE_DEADLINES.profileKillGraceMs);
    }
    if (await entry.release()) return true;
    await markCleanupUnknown(profileId, entry.ownerId);
    return false;
  }

  async function closeProfile(
    profileId,
    suppliedCaller = { role: 'manager-admin', clientId: 'manager-admin' }
  ) {
    await ready;
    const caller = profileCallerIdentity(suppliedCaller);
    requireProfileUse(await profileStore.get(profileId), caller);
    const pending = openingProfiles.get(profileId);
    if (pending) {
      if (caller.role !== 'manager-admin' && !isSamePrincipal(pending, caller)) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is opening for another client', 409);
      }
      await pending.promise.catch(() => {});
    }
    const entry = openProfiles.get(profileId);
    if (!entry) {
      let profile = await profileStore.get(profileId);
      profile = await reconcileAnyCleanup(profile);
      if (profile.lease || profile.state !== 'idle') {
        throw new TaskServiceError(
          'PROFILE_CLEANUP_UNCONFIRMED',
          'Profile browser cleanup could not be confirmed; the Profile remains blocked',
          409
        );
      }
      void scheduleQueuedTasks().catch(() => {});
      return { status: 'closed', profileId };
    }
    if (caller.role !== 'manager-admin' && !isSamePrincipal(entry, caller)) {
      throw new TaskServiceError('PROFILE_IN_USE', 'Profile is open for another client', 409);
    }
    if (!(await shutdownProfileEntry(profileId, entry))) {
      throw new TaskServiceError(
        'PROFILE_CLEANUP_UNCONFIRMED',
        'Profile browser cleanup could not be confirmed; the Profile remains blocked',
        409
      );
    }
    void scheduleQueuedTasks().catch(() => {});
    return { status: 'closed', profileId };
  }

  async function interruptTaskForShutdown(task) {
    if (task.state === 'queued' || TERMINAL_TASK_STATES.has(task.state)) return;
    await update(task, {
      state: 'failed',
      error: {
        code: 'TASK_INTERRUPTED_BY_MANAGER_SHUTDOWN',
        message: 'Manager shutdown interrupted this attempt; inspect its checkpoint before explicit resume.'
      },
      progress: terminalProgress(task, 'failed'),
      finishedAt: nowIso(),
      health: { status: 'failed', checkedAt: nowIso() }
    });
    const entry = children.get(task.id);
    if (entry) {
      send(entry.child, { type: 'cancel' });
      scheduleForcedStop(task, entry);
    }
  }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearTimeout(cleanupReconcileTimer);
    cleanupReconcileTimer = null;
    closePromise = (async () => {
      await ready;
      // Let an already-running queue drain reach a stable claim boundary.
      // `closing` prevents any subsequent drain from launching more work.
      await queueTail.catch(() => {});
      const exitingWorkers = [...children.values()].map((entry) => entry.exitPromise);
      const shutdownResults = await Promise.allSettled([
        ...[...tasks.values()]
          .filter((task) => task.state !== 'queued' && !TERMINAL_TASK_STATES.has(task.state))
          .map((task) => interruptTaskForShutdown(task)),
        ...[...openProfiles.keys()].map((profileId) => closeProfile(
          profileId,
          { role: 'manager-admin', clientId: 'manager-admin' }
        ))
      ]);
      if (exitingWorkers.length > 0) {
        await Promise.race([
          Promise.allSettled(exitingWorkers),
          new Promise((resolve) => {
            const timer = setTimeout(resolve, workerCleanupGraceMs + workerHardKillGraceMs + 1_000);
            timer.unref?.();
          })
        ]);
      }
      while (true) {
        const pending = [...persistChains.entries()];
        await Promise.allSettled(pending.map(([, promise]) => promise));
        if (pending.every(([id, promise]) => persistChains.get(id) === promise)) break;
      }

      const forcedExits = [];
      for (const [taskId, entry] of children) {
        const task = tasks.get(taskId);
        if (task) await markCleanupUnknown(task.profileId, task.leaseOwner);
        forcedExits.push(entry.exitPromise);
        entry.child.kill?.('SIGKILL');
      }
      if (forcedExits.length > 0) {
        await Promise.race([
          Promise.allSettled(forcedExits),
          new Promise((resolve) => setTimeout(resolve, workerHardKillGraceMs))
        ]);
        while (true) {
          const pending = [...persistChains.entries()];
          await Promise.allSettled(pending.map(([, promise]) => promise));
          if (pending.every(([id, promise]) => persistChains.get(id) === promise)) break;
        }
      }
      const profiles = typeof profileStore.list === 'function' ? await profileStore.list() : [];
      const cleanupUnconfirmed = profiles.some((profile) => (
        profile.state === 'error' || profile.lease?.cleanupRequired === true
      ));
      const taskCleanupUnconfirmed = [...tasks.values()].some((task) => (
        task.leaseHeld === true ||
        (TERMINAL_TASK_STATES.has(task.state) && task.startedAt && task.cleanup?.settled !== true)
      ));
      if (
        shutdownResults.some((result) => result.status === 'rejected') ||
        children.size > 0 ||
        openProfiles.size > 0 ||
        cleanupUnconfirmed ||
        taskCleanupUnconfirmed ||
        finalizationFailures.size > 0
      ) {
        throw new TaskServiceError(
          'SERVICE_SHUTDOWN_UNCONFIRMED',
          'Task service stopped accepting work, but browser cleanup could not be fully confirmed',
          500
        );
      }
      return { clean: true };
    })();
    return closePromise;
  }

  async function schedulerStatus() {
    await ready;
    return {
      active: children.size,
      queued: queuedTasks().length,
      waitingUser: [...tasks.values()].filter((task) => task.state === 'waiting_user').length,
      stalled: [...tasks.values()].filter((task) => task.health?.status === 'stalled').length,
      maxConcurrent: maxConcurrentTasks,
      maxQueued: maxQueuedTasks
    };
  }

  return Object.freeze({
    schedulerStatus,
    list,
    create,
    get,
    getInternal,
    listArtifacts,
    readArtifact,
    cancel,
    continueTask,
    resume,
    installTaskType,
    installTaskPack,
    listTaskTypes,
    describeTaskType,
    openProfile,
    closeProfile,
    close
  });
}
