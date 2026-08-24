import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBehaviorMode, publicTask, TERMINAL_TASK_STATES } from '../contracts.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';
import { TaskTypeRegistry } from '../lib/task-type-registry.mjs';

const TASK_WORKER = fileURLToPath(new URL('./task-worker.mjs', import.meta.url));
const PROFILE_WORKER = fileURLToPath(new URL('./profile-worker.mjs', import.meta.url));
const IMPORT_WORKER = fileURLToPath(new URL('./import-session-worker.mjs', import.meta.url));
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
const MAX_ATTEMPTS = 100;
const RESUME_KEY_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;
const HANDOFF_ID_PATTERN = /^handoff_[a-f0-9]{32}$/;

export const TASK_SERVICE_DEADLINES = Object.freeze({
  profileOpenMs: 30_000,
  profileCloseMs: 10_000,
  sessionImportMs: 90_000,
  sessionImportRollbackGraceMs: 15_000
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

function clone(value) {
  return structuredClone(value);
}

function callerIdentity(caller = {}) {
  if (caller.role === 'manager-admin') {
    return { role: 'manager-admin', clientId: caller.clientId || 'manager-admin' };
  }
  if (caller.role === 'agent' && typeof caller.clientId === 'string' && caller.clientId) {
    return { role: 'agent', clientId: caller.clientId };
  }
  throw new TaskServiceError('TASK_ACCESS_DENIED', 'Task operation is not allowed for this caller', 403);
}

function profileCallerIdentity(caller = {}) {
  if (
    ['manager-admin', 'agent', 'extension'].includes(caller.role) &&
    typeof caller.clientId === 'string' && caller.clientId
  ) {
    return { role: caller.role, clientId: caller.clientId };
  }
  throw new TaskServiceError('PROFILE_ACCESS_DENIED', 'Profile operation is not allowed for this caller', 403);
}

function canAccess(task, caller) {
  return caller.role === 'manager-admin' || task.ownerClientId === caller.clientId;
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

async function atomicJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function publicRecord(task) {
  return clone(publicTask(task));
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
  diagnosticGraceMs = DIAGNOSTIC_GRACE_MS,
  progressStallMs = PROGRESS_STALL_MS,
  progressFailureMs = PROGRESS_FAILURE_MS,
  maxConcurrentTasks = 4,
  maxQueuedTasks = 100,
  sessionImportTimeoutMs = TASK_SERVICE_DEADLINES.sessionImportMs,
  sessionImportRollbackGraceMs = TASK_SERVICE_DEADLINES.sessionImportRollbackGraceMs,
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
  if (!Number.isFinite(sessionImportTimeoutMs) || sessionImportTimeoutMs <= 0) {
    throw new TypeError('sessionImportTimeoutMs must be positive');
  }
  if (!Number.isFinite(sessionImportRollbackGraceMs) || sessionImportRollbackGraceMs <= 0) {
    throw new TypeError('sessionImportRollbackGraceMs must be positive');
  }

  const root = path.resolve(stateDir);
  const tasks = new Map();
  const children = new Map();
  const openProfiles = new Map();
  const openingProfiles = new Map();
  const persistChains = new Map();
  const registry = taskTypeRegistry || new TaskTypeRegistry({
    filePath: taskTypesFile || path.join(path.dirname(root), 'task-types.json'),
    snapshotRoot: taskTypesRoot || path.join(path.dirname(root), 'task-types'),
    allowedRoots: allowedTaskRoots,
    seedTypes: seedTaskTypes
  });
  let createTail = Promise.resolve();
  let queueTail = Promise.resolve();
  let closing = false;
  const ready = initialize();
  void ready.then(() => scheduleQueuedTasks()).catch(() => {});

  function normalizeAttemptHistory(task) {
    task.attempt = Number.isSafeInteger(task.attempt) && task.attempt >= 1
      ? Math.min(task.attempt, MAX_ATTEMPTS)
      : 1;
    task.history = Array.isArray(task.history)
      ? task.history.filter((entry) => (
        entry && typeof entry === 'object' &&
        Number.isSafeInteger(entry.attempt) && entry.attempt >= 1 && entry.attempt <= MAX_ATTEMPTS
      )).slice(-MAX_ATTEMPTS)
      : [];
  }

  function beginAttemptHistory(task, { resumed = false, checkpointSavedAt = null } = {}) {
    normalizeAttemptHistory(task);
    const startedAt = nowIso();
    task.history.push({
      attempt: task.attempt,
      resumed,
      startedAt,
      ...(checkpointSavedAt ? { checkpointSavedAt } : {})
    });
    task.history = task.history.slice(-MAX_ATTEMPTS);
    return startedAt;
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

  async function reconcileInterruptedCleanup(task) {
    if (task.cleanup?.settled === true) return true;
    if (task.cleanup?.managerRestartObserved !== true) return false;
    if (await processAlive(task.workerPid)) return false;
    let profile;
    try {
      profile = await profileStore.get(task.profileId);
    } catch {
      return false;
    }
    if (profile?.lease?.ownerId === task.leaseOwner) {
      // The recorded Worker is gone and this interrupted task still owns the
      // lease. Release it directly instead of waiting for an unrelated Profile
      // open or another Manager restart to run expiry recovery.
      try {
        await profileStore.releaseLease(task.profileId, task.leaseOwner);
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
      settled: true,
      managerRestartObserved: true
    };
    return true;
  }

  async function initialize() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await registry.list();
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
      normalizeAttemptHistory(task);
      const cleanupComplete = Boolean(task.cleanup?.workerExited && task.cleanup?.leaseReleased);
      const safelyQueued = task.state === 'queued' && !task.startedAt && !task.workerPid && task.leaseHeld !== true;
      if ((!TERMINAL_TASK_STATES.has(task.state) && !safelyQueued) || (!safelyQueued && !cleanupComplete)) {
        task.state = 'failed';
        task.error = {
          code: 'TASK_INTERRUPTED_BY_MANAGER_RESTART',
          message: 'Manager restarted before task cleanup completed; inspect the checkpoint before resuming.'
        };
        task.progress = {
          ...(task.progress || { current: 0, total: null }),
          message: 'Interrupted by Manager restart; checkpoint preserved'
        };
        task.cleanup = { ...(task.cleanup || {}), managerRestartObserved: true };
        task.finishedAt ||= nowIso();
        task.updatedAt = nowIso();
        task.leaseHeld = false;
        await reconcileInterruptedCleanup(task);
        finishAttemptHistory(task);
        await atomicJson(filePath, task);
      }
      tasks.set(task.id, task);
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
      const reason = activeProfiles.has(task.profileId)
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
    for (const task of queuedTasks()) {
      if (capacity <= 0) break;
      if (activeProfiles.has(task.profileId)) continue;
      let profile;
      try {
        profile = await profileStore.get(task.profileId);
      } catch (error) {
        task.state = 'failed';
        task.health = { status: 'failed', checkedAt: nowIso() };
        task.error = sanitizeError(error, 'PROFILE_NOT_FOUND');
        task.finishedAt = nowIso();
        task.cleanup = { browserClosed: true, leaseReleased: true, workerExited: true, settled: true };
        finishAttemptHistory(task);
        await persist(task);
        continue;
      }
      if (profile.state !== 'idle' && profile.lease?.ownerId !== task.leaseOwner) continue;
      task.queuePosition = null;
      task.queueReason = null;
      await persist(task);
      await launchTaskAttempt(task, profile);
      if (children.has(task.id)) {
        activeProfiles.add(task.profileId);
        capacity -= 1;
      }
    }
    await updateQueueMetadata();
  }

  function scheduleQueuedTasks() {
    if (closing) return Promise.resolve();
    const operation = queueTail.then(drainQueue);
    queueTail = operation.catch(() => {});
    return operation;
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
    Object.assign(task, patch, { updatedAt: nowIso() });
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
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.kind !== 'string' || !item.kind) {
        throw completionGateFailure('Task result evidence must contain bounded objects with a kind');
      }
      if (item.kind !== 'artifact' || item.agentVisible === false) continue;
      if (item.agentVisible !== undefined && item.agentVisible !== true) {
        throw completionGateFailure('Declared artifact visibility must be a boolean');
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
    if (!Array.isArray(task.result.evidence) || task.result.evidence.length > 1_000) {
      throw completionGateFailure('Task result evidence must be a bounded array');
    }
    if (task.cleanup?.browserClosed !== true) {
      throw completionGateFailure('Task browser cleanup was not confirmed');
    }
    if (task.cleanup?.workerExited !== true || task.cleanup?.leaseReleased !== true) {
      throw completionGateFailure('Task worker and Profile lease cleanup were not confirmed');
    }

    const required = requiredArtifactPaths(task);
    for (const relativePath of required) {
      const declaration = artifactDeclarations(task).find((item) => (
        item.kind === 'result' && item.relativePath === relativePath
      ));
      if (!declaration) throw completionGateFailure('A declared agent-visible artifact is invalid');
      let opened;
      try {
        opened = await openValidatedArtifact(task, declaration);
      } catch {
        throw completionGateFailure('A declared agent-visible artifact is missing or unstable');
      } finally {
        await opened?.handle.close().catch(() => {});
      }
    }
    return { verifiedAt: nowIso(), artifactCount: required.length };
  }

  async function releaseTaskLease(task) {
    if (!task.leaseHeld) {
      task.cleanup.leaseReleased = true;
      return;
    }
    task.leaseHeld = false;
    try {
      await profileStore.releaseLease(task.profileId, task.leaseOwner);
      task.cleanup.leaseReleased = true;
    } catch (error) {
      task.cleanup.leaseReleaseError = sanitizeError(error, 'LEASE_RELEASE_FAILED');
    }
    await update(task, { cleanup: task.cleanup });
  }

  async function finalizeTask(task, exitCode, signal) {
    const entry = children.get(task.id);
    if (!entry && task.cleanup?.workerExited === true) return;
    if (entry?.finalized) return;
    if (entry) {
      entry.finalized = true;
      clearInterval(entry.watchdog);
      clearTimeout(entry.forceKillTimer);
      clearTimeout(entry.hardKillTimer);
    }
    children.delete(task.id);
    task.cleanup.workerExited = true;
    task.cleanup.exitCode = exitCode;
    task.cleanup.exitSignal = signal || null;
    await awaitTaskPersistence(task.id);
    const claimedCompletion = task.completionClaimed === true || task.state === 'verifying';
    if (!claimedCompletion && !TERMINAL_TASK_STATES.has(task.state)) {
      await update(task, {
        state: 'failed',
        error: { code: 'TASK_WORKER_EXITED', message: 'Task worker exited before reporting a terminal state' }
      });
    }
    await releaseTaskLease(task);
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
    task.cleanup.settled = true;
    task.finishedAt ||= nowIso();
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
    entry?.resolveExit?.();
    void scheduleQueuedTasks().catch(() => {});
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
      }, Math.max(250, Math.min(5_000, diagnosticGraceMs)));
      entry.hardKillTimer.unref?.();
    }, diagnosticGraceMs);
    entry.forceKillTimer.unref?.();
  }

  function attachTaskWorker(task, child) {
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
      resolveExit
    };
    children.set(task.id, entry);

    child.on('message', (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'heartbeat') {
        if (TERMINAL_TASK_STATES.has(task.state)) {
          scheduleForcedStop(task, entry);
          return;
        }
        entry.diagnoseAt = 0;
        clearTimeout(entry.forceKillTimer);
        entry.forceKillTimer = null;
        void update(task, {
          heartbeatAt: message.at || nowIso(),
          ...(message.progress ? { progress: clone(message.progress) } : {})
        }).catch(() => {});
        void profileStore.acquireLease(task.profileId, task.leaseOwner, {
          pid: child.pid,
          ttlMs: LEASE_TTL_MS
        }).catch((error) => {
          if (TERMINAL_TASK_STATES.has(task.state)) return;
          void update(task, { state: 'failed', error: sanitizeError(error, 'LEASE_RENEWAL_FAILED') }).catch(() => {});
          send(child, { type: 'cancel' });
          scheduleForcedStop(task, entry);
        });
        return;
      }
      if (message.type === 'progress' && message.progress) {
        entry.stallDiagnoseAt = 0;
        const at = message.at || nowIso();
        const healthStatus = task.state === 'waiting_user'
          ? 'waiting_user'
          : task.state === 'cooling_down'
            ? 'cooling_down'
            : 'healthy';
        void update(task, {
          progress: clone(message.progress),
          progressAt: at,
          heartbeatAt: at,
          health: { status: healthStatus, checkedAt: at }
        }).catch(() => {});
        return;
      }
      if (message.type === 'waiting_user' && message.request) {
        const request = message.request;
        if (
          typeof request.id !== 'string' || !HANDOFF_ID_PATTERN.test(request.id) ||
          typeof request.reason !== 'string' || !request.reason.trim()
        ) return;
        void update(task, {
          state: 'waiting_user',
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
                ? { health: { status: 'healthy', checkedAt: nowIso() } }
                : {}),
            ...(terminal ? { finishedAt: nowIso() } : {})
          }).catch(() => {});
        }
        if (terminal) scheduleForcedStop(task, entry);
        return;
      }
      if (message.type === 'checkpoint') {
        void update(task, { checkpoint: { path: message.path, savedAt: message.savedAt } }).catch(() => {});
        return;
      }
      if (message.type === 'screenshot') {
        void update(task, { lastScreenshot: { path: message.path, reason: message.reason, at: nowIso() } }).catch(() => {});
        return;
      }
      if (message.type === 'observation') {
        void update(task, { lastObservation: { path: message.path, reason: message.reason, at: nowIso() } }).catch(() => {});
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
          void update(task, {
            state: message.state === 'cancelled' ? 'cancelled' : 'failed',
            error: sanitizeError(message.error),
            finishedAt: nowIso()
          }).catch(() => {});
        }
        scheduleForcedStop(task, entry);
        return;
      }
      if (message.type === 'cleanup') {
        task.cleanup.browserClosed = Boolean(message.browserClosed);
        void update(task, { cleanup: task.cleanup }).catch(() => {});
      }
    });

    child.once('error', (error) => {
      if (!TERMINAL_TASK_STATES.has(task.state)) {
        void update(task, { state: 'failed', error: sanitizeError(error, 'TASK_WORKER_SPAWN_FAILED') }).catch(() => {});
      }
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
        void finalizeTask(task, null, null);
        return;
      }
      send(child, { type: 'cancel' });
      scheduleForcedStop(task, entry);
    });
    child.once('exit', (code, signal) => void finalizeTask(task, code, signal));
    child.once('close', (code, signal) => void finalizeTask(task, code, signal));

    entry.watchdog = setInterval(() => {
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
            finishedAt: nowIso()
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
          finishedAt: nowIso()
        }).catch(() => {});
        send(child, { type: 'cancel' });
        scheduleForcedStop(task, entry);
      }
    }, Math.min(
      5_000,
      Math.max(100, Math.floor(Math.min(heartbeatTimeoutMs, progressStallMs) / 3))
    ));
    entry.watchdog.unref?.();
  }

  async function launchTaskAttempt(task, profile) {
    await update(task, { state: 'acquiring_profile' });
    try {
      await profileStore.acquireLease(task.profileId, task.leaseOwner, {
        pid: process.pid,
        ttlMs: LEASE_TTL_MS
      });
      task.leaseHeld = true;
    } catch (error) {
      task.state = 'failed';
      task.error = sanitizeError(error, 'PROFILE_LEASE_FAILED');
      task.finishedAt = nowIso();
      await releaseTaskLease(task);
      task.cleanup.browserClosed = true;
      task.cleanup.workerExited = true;
      task.cleanup.settled = true;
      finishAttemptHistory(task);
      await update(task, {
        state: task.state,
        error: task.error,
        finishedAt: task.finishedAt,
        cleanup: task.cleanup,
        history: task.history
      });
      return;
    }

    let child;
    try {
      child = workerFactory(TASK_WORKER, 'task');
      attachTaskWorker(task, child);
      await update(task, { state: 'starting_browser', startedAt: nowIso(), workerPid: child.pid });
      await profileStore.acquireLease(task.profileId, task.leaseOwner, {
        pid: child.pid,
        ttlMs: LEASE_TTL_MS
      });
      send(child, {
        type: 'start',
        config: {
          taskId: task.id,
          profile,
          modulePath: task.modulePath,
          input: clone(task.input),
          behavior: task.behavior,
          outputDir: task.outputDir,
          checkpointPath: path.join(root, task.id, 'checkpoint.json'),
          heartbeatMs: 20_000,
          ...(task.timeoutMs ? { timeoutMs: task.timeoutMs } : {})
        }
      });
    } catch (error) {
      await update(task, {
        state: 'failed',
        error: sanitizeError(error, 'TASK_WORKER_SPAWN_FAILED'),
        finishedAt: nowIso()
      });
      child?.kill?.('SIGTERM');
      await releaseTaskLease(task);
      if (!child) {
        task.cleanup.browserClosed = true;
        task.cleanup.workerExited = true;
        task.cleanup.settled = true;
        finishAttemptHistory(task);
        await update(task, { cleanup: task.cleanup, history: task.history });
      }
    }
  }

  async function create(body = {}, caller = {}) {
    const operation = createTail.then(() => createSerialized(body, caller));
    createTail = operation.catch(() => {});
    return operation;
  }

  async function createSerialized(body = {}, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    const allowed = new Set([
      'profileId',
      'taskType',
      'input',
      'behavior',
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

    const profile = await profileStore.get(body.profileId);
    const taskType = await registry.resolve(body.taskType);
    const behavior = body.behavior || profile.defaultBehavior || 'fast';
    if (!isBehaviorMode(behavior)) {
      throw new TaskServiceError('INVALID_BEHAVIOR_MODE', 'behavior must be fast, human, or adaptive');
    }
    if (
      body.timeoutMs !== undefined &&
      (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1_000 || body.timeoutMs > MAX_TASK_TIMEOUT_MS)
    ) {
      throw new TaskServiceError('INVALID_TASK_TIMEOUT', 'timeoutMs must be an integer from 1000 to 86400000');
    }
    const input = body.input ?? {};
    validateTaskInput(input, taskType.inputSchema);
    const hash = requestHash({
      profileId: body.profileId,
      taskType: body.taskType,
      taskTypeSha256: taskType.sha256,
      behavior,
      timeoutMs: body.timeoutMs ?? null,
      input
    });
    const existing = [...tasks.values()].find((task) => (
      task.ownerClientId === caller.clientId && task.idempotencyKey === body.idempotencyKey
    ));
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new TaskServiceError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency key is already bound to a different task request',
          409
        );
      }
      return publicRecord(existing);
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
      modulePath: taskType.modulePath,
      ownerClientId: caller.clientId,
      idempotencyKey: body.idempotencyKey,
      requestHash: hash,
      behavior,
      input: clone(input),
      timeoutMs: body.timeoutMs ?? null,
      attempt: 1,
      history: [],
      resumeKeys: [],
      state: 'queued',
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

  async function verifyResumeCheckpoint(task) {
    const expected = path.join(root, task.id, 'checkpoint.json');
    if (
      typeof task.checkpoint?.path !== 'string' ||
      path.resolve(task.checkpoint.path) !== path.resolve(expected)
    ) {
      throw new TaskServiceError('TASK_CHECKPOINT_INVALID', 'Task checkpoint is unavailable or invalid', 409);
    }
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
        typeof record.savedAt !== 'string' || !record.savedAt || !Object.hasOwn(record, 'data')
      ) throw new Error('invalid checkpoint record');
      return { savedAt: record.savedAt, sha256: createHash('sha256').update(source).digest('hex') };
    } catch {
      throw new TaskServiceError('TASK_CHECKPOINT_INVALID', 'Task checkpoint is unavailable or unstable', 409);
    } finally {
      await handle?.close().catch(() => {});
    }
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
    const operation = createTail.then(() => resumeSerialized(id, body, caller));
    createTail = operation.catch(() => {});
    return operation;
  }

  async function resumeSerialized(id, body = {}, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || task.ownerClientId !== caller.clientId) {
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
    const keyHash = requestHash({ taskId: task.id, ownerClientId: task.ownerClientId, resumeKey: body.resumeKey });
    task.resumeKeys = Array.isArray(task.resumeKeys) ? task.resumeKeys : [];
    if (task.resumeKeys.some((entry) => entry?.keyHash === keyHash)) return publicRecord(task);
    if (task.state !== 'failed') {
      throw new TaskServiceError('TASK_NOT_RESUMABLE', 'Only a failed terminal task can be resumed explicitly', 409);
    }
    if (task.cleanup?.settled !== true && task.cleanup?.managerRestartObserved === true) {
      if (await reconcileInterruptedCleanup(task)) await update(task, { cleanup: task.cleanup });
    }
    if (task.cleanup?.settled !== true) {
      throw new TaskServiceError('TASK_CLEANUP_NOT_SETTLED', 'Task cleanup must settle before resume', 409);
    }
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
    const profile = await profileStore.get(task.profileId);

    task.attempt += 1;
    task.resumeKeys.push({ keyHash, attempt: task.attempt, requestedAt: nowIso() });
    task.resumeKeys = task.resumeKeys.slice(-MAX_ATTEMPTS);
    task.state = 'queued';
    task.progress = {
      current: Number(task.progress?.current) || 0,
      total: Number.isFinite(task.progress?.total) ? task.progress.total : null,
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
    task.progressAt = nowIso();
    task.health = { status: 'healthy', checkedAt: nowIso() };
    task.behaviorState = {
      configured: task.behavior,
      effective: task.behavior === 'adaptive' ? 'fast' : task.behavior,
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
    return {
      tasks: page.map(publicRecord),
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
    await awaitTaskPersistence(id);
    return publicRecord(task);
  }

  async function getInternal(id) {
    await ready;
    const task = tasks.get(id);
    if (!task) throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    await awaitTaskPersistence(id);
    return clone(task);
  }

  function artifactDeclarations(task) {
    const declarations = declaredArtifactFiles(task).map((relativePath) => ({
      relativePath,
      kind: 'result'
    }));
    if (typeof task.lastScreenshot?.path === 'string') {
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
    if (typeof task.lastObservation?.path === 'string') {
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

  async function openValidatedArtifact(task, declaration) {
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
      } catch {
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
    if (TERMINAL_TASK_STATES.has(task.state)) return publicRecord(task);
    await update(task, {
      state: 'cancelled',
      health: { status: 'cancelled', checkedAt: nowIso() },
      progress: { ...task.progress, message: 'Cancellation requested' },
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
      task.cleanup.settled = true;
      finishAttemptHistory(task);
      await update(task, { cleanup: task.cleanup, history: task.history });
    }
    void scheduleQueuedTasks().catch(() => {});
    return publicRecord(task);
  }

  async function continueTask(id, body = {}, suppliedCaller = {}) {
    await ready;
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
    if (!entry || !send(entry.child, { type: 'continue', requestId, note: body.note || '' })) {
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
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError('TASK_TYPE_INSTALL_FORBIDDEN', 'Only Manager admin can install task types', 403);
    }
    return registry.install(input);
  }

  async function installTaskPack(input = {}, suppliedCaller = {}) {
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

  async function importSession(profileId, bundle) {
    await ready;
    const profile = await profileStore.get(profileId);
    if ((profile.kind || 'persistent') === 'ephemeral') {
      throw new TaskServiceError(
        'EPHEMERAL_PROFILE_SESSION_UNSUPPORTED',
        'Ephemeral Profiles never accept or retain browser sessions',
        409
      );
    }
    if (profile.state !== 'idle' || profile.lease) {
      throw new TaskServiceError('PROFILE_IN_USE', 'Target profile must be idle before session import', 409);
    }
    const ownerId = `session-import:${randomUUID().replaceAll('-', '')}`;
    await profileStore.acquireLease(profileId, ownerId, { pid: process.pid, ttlMs: 120_000 });
    let child;
    try {
      child = workerFactory(IMPORT_WORKER, 'session-import');
      await profileStore.acquireLease(profileId, ownerId, { pid: child.pid, ttlMs: 120_000 });
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        let timeoutRequested = false;
        let hardStopTimer;
        const timer = setTimeout(() => {
          timeoutRequested = true;
          send(child, { type: 'cancel' });
          hardStopTimer = setTimeout(() => {
            child.kill('SIGKILL');
            done(reject)(new TaskServiceError(
              'SESSION_IMPORT_ROLLBACK_FAILED',
              'Session import timed out and rollback could not be confirmed',
              500
            ));
          }, sessionImportRollbackGraceMs);
        }, sessionImportTimeoutMs);
        const done = (callback) => (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          clearTimeout(hardStopTimer);
          callback(value);
        };
        child.once('error', done(reject));
        child.once('exit', done(() => reject(new TaskServiceError(
          timeoutRequested ? 'SESSION_IMPORT_ROLLBACK_FAILED' : 'SESSION_IMPORT_EXITED',
          timeoutRequested
            ? 'Session import timed out and rollback could not be confirmed'
            : 'Session import worker exited before returning a result',
          500
        ))));
        child.on('message', (message) => {
          if (message?.type === 'result') done(resolve)(message.result);
          if (message?.type === 'error') {
            if (timeoutRequested && message.error?.code !== 'SESSION_IMPORT_ROLLBACK_FAILED') {
              done(reject)(new TaskServiceError('SESSION_IMPORT_TIMEOUT', 'Session import timed out', 504));
            } else {
              done(reject)(Object.assign(new Error(message.error?.message), message.error));
            }
          }
        });
        send(child, { type: 'import', config: { profile, bundle } });
      });
      return {
        status: result.status === 'verified' ? 'verified' : 'partial',
        cookieCount: Number(result.cookieCount) || 0,
        localStorageCount: Number(result.localStorageCount) || 0,
        sessionCookieRetentionHours: Number(result.sessionCookieRetentionHours) || 0,
        verification: typeof result.verification === 'string'
          ? result.verification
          : 'storage_replaced_not_login_verified',
        message: result.status === 'verified'
          ? 'Session was imported and verified'
          : 'Session material was imported; account login still requires site-level verification'
      };
    } finally {
      child?.kill?.('SIGTERM');
      await profileStore.releaseLease(profileId, ownerId).catch(() => {});
      bundle = null;
    }
  }

  async function openProfile(
    profileId,
    suppliedCaller = { role: 'manager-admin', clientId: 'manager-admin' }
  ) {
    await ready;
    const caller = profileCallerIdentity(suppliedCaller);
    const existing = openProfiles.get(profileId);
    if (existing) {
      if (caller.role !== 'manager-admin' && existing.ownerClientId !== caller.clientId) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is open for another client', 409);
      }
      return { status: 'open', profileId, pid: existing.child.pid };
    }
    const pending = openingProfiles.get(profileId);
    if (pending) {
      if (caller.role !== 'manager-admin' && pending.ownerClientId !== caller.clientId) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is opening for another client', 409);
      }
      return pending.promise;
    }
    const operation = openProfileSingle(profileId, caller.clientId);
    openingProfiles.set(profileId, { promise: operation, ownerClientId: caller.clientId });
    try {
      return await operation;
    } finally {
      if (openingProfiles.get(profileId)?.promise === operation) openingProfiles.delete(profileId);
    }
  }

  async function openProfileSingle(profileId, ownerClientId) {
    const ownerId = `profile-open:${ownerClientId}:${profileId}:${randomUUID().replaceAll('-', '')}`;
    const profile = await profileStore.get(profileId);
    if ((profile.kind || 'persistent') === 'ephemeral') {
      throw new TaskServiceError(
        'EPHEMERAL_PROFILE_OPEN_UNSUPPORTED',
        'Ephemeral Profiles are created only for task-scoped browser contexts',
        409
      );
    }
    await profileStore.acquireLease(profileId, ownerId, { pid: process.pid, ttlMs: 5 * 60_000 });
    const child = workerFactory(PROFILE_WORKER, 'profile-open');
    const entry = {
      child,
      ownerId,
      ownerClientId,
      released: false,
      renewal: null,
      lastHeartbeatAt: Date.now()
    };
    openProfiles.set(profileId, entry);

    const release = async () => {
      if (entry.released) return;
      entry.released = true;
      clearInterval(entry.renewal);
      openProfiles.delete(profileId);
      await profileStore.releaseLease(profileId, ownerId).catch(() => {});
    };
    child.once('exit', () => void release());
    child.once('error', () => void release());
    child.on('message', (message) => {
      if (message?.type === 'heartbeat') entry.lastHeartbeatAt = Date.now();
    });

    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new TaskServiceError('PROFILE_OPEN_TIMEOUT', 'Profile did not open in time', 504)),
          TASK_SERVICE_DEADLINES.profileOpenMs
        );
        child.on('message', (message) => {
          if (message?.type === 'ready') {
            clearTimeout(timer);
            resolve(message);
          }
          if (message?.type === 'error') {
            clearTimeout(timer);
            reject(Object.assign(new Error(message.error?.message), message.error));
          }
        });
        send(child, { type: 'open', profile });
      });
      void result;
      await profileStore.acquireLease(profileId, ownerId, { pid: child.pid, ttlMs: 5 * 60_000 });
      entry.renewal = setInterval(() => {
        if (Date.now() - entry.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
          send(child, { type: 'close' });
          child.kill?.('SIGTERM');
          return;
        }
        void profileStore.acquireLease(profileId, ownerId, { pid: child.pid, ttlMs: 5 * 60_000 })
          .catch(() => send(child, { type: 'close' }));
      }, 20_000);
      entry.renewal.unref?.();
      return { status: 'open', profileId, pid: child.pid };
    } catch (error) {
      send(child, { type: 'close' });
      child.kill?.('SIGTERM');
      await release();
      throw error;
    }
  }

  async function closeProfile(
    profileId,
    suppliedCaller = { role: 'manager-admin', clientId: 'manager-admin' }
  ) {
    const caller = profileCallerIdentity(suppliedCaller);
    const pending = openingProfiles.get(profileId);
    if (pending) {
      if (caller.role !== 'manager-admin' && pending.ownerClientId !== caller.clientId) {
        throw new TaskServiceError('PROFILE_IN_USE', 'Profile is opening for another client', 409);
      }
      await pending.promise.catch(() => {});
    }
    const entry = openProfiles.get(profileId);
    if (!entry) {
      void scheduleQueuedTasks().catch(() => {});
      return { status: 'closed', profileId };
    }
    if (caller.role !== 'manager-admin' && entry.ownerClientId !== caller.clientId) {
      throw new TaskServiceError('PROFILE_IN_USE', 'Profile is open for another client', 409);
    }
    send(entry.child, { type: 'close' });
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.child.kill('SIGTERM');
        resolve();
      }, TASK_SERVICE_DEADLINES.profileCloseMs);
      entry.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (!entry.released) {
      entry.released = true;
      clearInterval(entry.renewal);
      openProfiles.delete(profileId);
      await profileStore.releaseLease(profileId, entry.ownerId).catch(() => {});
    }
    void scheduleQueuedTasks().catch(() => {});
    return { status: 'closed', profileId };
  }

  async function close() {
    await ready;
    closing = true;
    const exitingWorkers = [...children.values()].map((entry) => entry.exitPromise);
    await Promise.allSettled([
      ...[...tasks.values()]
        .filter((task) => !TERMINAL_TASK_STATES.has(task.state))
        .map((task) => cancel(task.id, { role: 'manager-admin', clientId: 'manager-admin' })),
      ...[...openProfiles.keys()].map((profileId) => closeProfile(
        profileId,
        { role: 'manager-admin', clientId: 'manager-admin' }
      ))
    ]);
    if (exitingWorkers.length > 0) {
      await Promise.race([
        Promise.allSettled(exitingWorkers),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, diagnosticGraceMs + 5_000);
          timer.unref?.();
        })
      ]);
    }
    while (true) {
      const pending = [...persistChains.entries()];
      await Promise.allSettled(pending.map(([, promise]) => promise));
      if (pending.every(([id, promise]) => persistChains.get(id) === promise)) break;
    }
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
    importSession,
    openProfile,
    closeProfile,
    close
  });
}
