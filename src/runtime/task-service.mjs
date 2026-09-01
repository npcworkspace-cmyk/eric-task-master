import { fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBehaviorMode, normalizeBehaviorMode, publicTask, TERMINAL_TASK_STATES } from '../contracts.mjs';
import { normalizeAgentName } from '../lib/agent-token.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';
import { TaskTypeRegistry } from '../lib/task-type-registry.mjs';
import { readCleanupReceipt, removeCleanupReceipt, verifyCleanupReceipt } from '../lib/cleanup-receipt.mjs';
import { FULL_HUMAN_INTERACTION_CONTRACT } from '../lib/interaction-contract.mjs';
import {
  assertOutputTreeUnchanged,
  outputSealLimitsForBudget,
  snapshotOutputTree
} from '../lib/output-seal.mjs';
import { sanitizePublicTaskFailure } from '../lib/public-task-failure.mjs';
import { TaskServiceError } from './task-service-error.mjs';
import { createTaskAssetManager } from './task-asset-manager.mjs';
import { createTaskCheckpointStore } from './task-checkpoint-store.mjs';
import { createProfileRuntime } from './profile-runtime.mjs';
import {
  artifactId,
  createTaskArtifactStore,
  declaredArtifactFiles,
  inside,
  MAX_ARTIFACTS
} from './task-artifact-store.mjs';
import {
  appendTimeline,
  boundedText,
  buildTaskDisplayName,
  callerIdentity,
  canAccess,
  canUseProfile,
  clone,
  COMMAND_ID_PATTERN,
  decodeCursor,
  encodeCursor,
  isTaskOwner,
  legacyExternalCostUnsupportedError,
  MAX_TASK_COMMANDS,
  migrateLegacyExternalCostState,
  normalizeTaskCoordination,
  normalizeTaskLabel,
  normalizeTaskTiming,
  requestHash,
  requireCoordinationBody,
  requireProfileUse,
  taskActor,
  taskLeaseAccess,
  validateTaskInput
} from './task-record-policy.mjs';

export { TaskServiceError } from './task-service-error.mjs';

const TASK_WORKER = fileURLToPath(new URL('./task-worker.mjs', import.meta.url));
const PROFILE_WORKER = fileURLToPath(new URL('./profile-worker.mjs', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ACCEPTANCE_TASK = fileURLToPath(new URL('../../examples/tasks/acceptance-task.mjs', import.meta.url));
const READ_PAGE_TASK = fileURLToPath(new URL('../../examples/tasks/read-page-task.mjs', import.meta.url));
const OBSERVE_PAGE_TASK = fileURLToPath(new URL('../../examples/tasks/observe-page-task.mjs', import.meta.url));
const SURFACE_PROBE_TASK = fileURLToPath(new URL('../../examples/tasks/surface-probe-task.mjs', import.meta.url));
const DURABLE_DELAY_TASK = fileURLToPath(new URL('../../examples/tasks/durable-delay-task.mjs', import.meta.url));
const HANDOFF_ACCEPTANCE_TASK = fileURLToPath(new URL('../../examples/tasks/handoff-acceptance-task.mjs', import.meta.url));
const LEASE_TTL_MS = 60_000;
const HEARTBEAT_TIMEOUT_MS = 65_000;
const DIAGNOSTIC_GRACE_MS = 15_000;
const PROGRESS_STALL_MS = 2 * 60_000;
const PROGRESS_FAILURE_MS = 10 * 60_000;
const MAX_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const BEHAVIOR_APPLY_TIMEOUT_MS = 5_000;
const FOCUS_APPLY_TIMEOUT_MS = 5_000;
const HANDOFF_CONTINUE_TIMEOUT_MS = 5_000;
const OUTPUT_SEAL_LIMITS = outputSealLimitsForBudget();
const SAFE_EVIDENCE_KINDS = new Set(['artifact', 'count', 'hash', 'message', 'note', 'url']);
const MAX_ATTEMPTS = 100;
const MAX_DIAGNOSTIC_ATTEMPTS = 16;
const RESUME_KEY_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;
const HANDOFF_ID_PATTERN = /^handoff_[a-f0-9]{32}$/;
const PROFILE_CLEANUP_QUEUE_REASON = 'Waiting for confirmed Profile cleanup';
const PROFILE_BUSY_QUEUE_REASON = 'Waiting for Profile to become idle';
const CLEANUP_RECONCILE_INTERVAL_MS = 2_000;
const CLEANUP_RECONCILE_GRACE_MS = 60_000;
const PROGRESS_PHASE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const WORKER_ACTIVITY_PHASES = new Set(['navigating', 'clicking', 'typing', 'hovering', 'scrolling', 'working']);
const WORKER_ACTIVITY_STATUSES = new Set(['active', 'succeeded', 'unknown']);
const REPORT_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;
const COMMAND_STATUSES = new Set(['pending', 'delivered', 'acknowledged', 'applied', 'rejected']);
const AGENT_COMMAND_KINDS = new Set(['ask', 'modify']);
const LIFECYCLE_ACTIVITY_STATUS = Object.freeze({
  queued: 'waiting',
  pause_requested: 'waiting',
  paused: 'waiting',
  cancel_requested: 'cancelled',
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
  const behavior = normalizeBehaviorMode(
    profile.defaultBehavior ?? (profile.kind === 'persistent' ? 'human' : 'auto'),
    { allowLegacy: true }
  );
  if (!isBehaviorMode(behavior)) {
    throw new TaskServiceError(
      'INVALID_PROFILE_BEHAVIOR',
      'Profile behavior must be fast, auto, or human'
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

function nowIso() {
  return new Date().toISOString();
}

function initialBehaviorState(behavior, at = nowIso()) {
  return {
    configured: behavior,
    effective: behavior === 'auto' ? 'fast' : behavior,
    ...(behavior === 'auto'
      ? { auto: { level: 0, label: 'fast', actionsRemaining: 0, signal: null } }
      : {}),
    source: 'profile',
    confirmed: false,
    at
  };
}

function workerBehaviorState(value, expectedBehavior) {
  const configured = normalizeBehaviorMode(value?.configured, { allowLegacy: true });
  if (configured !== expectedBehavior) return null;
  const effective = ['fast', 'cautious', 'human'].includes(value?.effective)
    ? value.effective
    : expectedBehavior === 'auto' ? 'fast' : expectedBehavior;
  const rawAuto = value?.auto ?? value?.adaptive;
  const auto = configured === 'auto' && rawAuto && typeof rawAuto === 'object'
    ? {
        level: Number.isInteger(rawAuto.level) && rawAuto.level >= 0 && rawAuto.level <= 3 ? rawAuto.level : 0,
        label: ['fast', 'cautious', 'guarded', 'cooldown'].includes(rawAuto.label) ? rawAuto.label : 'fast',
        actionsRemaining: Number.isInteger(rawAuto.actionsRemaining) && rawAuto.actionsRemaining >= 0
          ? Math.min(rawAuto.actionsRemaining, 1_000)
          : 0,
        signal: typeof rawAuto.signal === 'string' ? rawAuto.signal.slice(0, 64) : null
      }
    : null;
  return {
    configured,
    effective,
    ...(auto ? { auto } : {}),
    source: 'worker',
    confirmed: true,
    at: nowIso()
  };
}

function restoredBehaviorState(value, expectedBehavior) {
  const state = workerBehaviorState(value, expectedBehavior);
  if (!state) return null;
  const confirmed = value?.source === 'worker' && value?.confirmed === true;
  return {
    ...state,
    source: confirmed ? 'worker' : 'profile',
    confirmed,
    at: typeof value?.at === 'string' && value.at.length <= 64 ? value.at : nowIso()
  };
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

function sanitizeError(error, fallbackCode = 'TASK_FAILED') {
  const publicFailure = sanitizePublicTaskFailure(error?.publicFailure);
  return {
    code: redactSensitiveText(error?.code || fallbackCode).slice(0, 200),
    message: redactSensitiveText(error?.message || 'Task failed').slice(0, 2_000),
    ...(publicFailure ? { publicFailure } : {}),
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
  requireWorkerOutputSeal = workerFactory === defaultWorkerFactory,
  heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
  profileLeaseRenewalMs = 20_000,
  diagnosticGraceMs = DIAGNOSTIC_GRACE_MS,
  workerCleanupGraceMs = TASK_SERVICE_DEADLINES.workerCleanupGraceMs,
  workerHardKillGraceMs = TASK_SERVICE_DEADLINES.workerHardKillGraceMs,
  progressStallMs = PROGRESS_STALL_MS,
  progressFailureMs = PROGRESS_FAILURE_MS,
  behaviorApplyTimeoutMs = BEHAVIOR_APPLY_TIMEOUT_MS,
  handoffContinueTimeoutMs = HANDOFF_CONTINUE_TIMEOUT_MS,
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
    { name: 'surface-probe', modulePath: SURFACE_PROBE_TASK, discoverable: true },
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
  if (typeof requireWorkerOutputSeal !== 'boolean') {
    throw new TypeError('requireWorkerOutputSeal must be boolean');
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
  if (!Number.isFinite(behaviorApplyTimeoutMs) || behaviorApplyTimeoutMs < 100 || behaviorApplyTimeoutMs > 30_000) {
    throw new TypeError('behaviorApplyTimeoutMs must be between 100 and 30000');
  }
  if (!Number.isFinite(handoffContinueTimeoutMs) || handoffContinueTimeoutMs < 100 || handoffContinueTimeoutMs > 30_000) {
    throw new TypeError('handoffContinueTimeoutMs must be between 100 and 30000');
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
  const persistChains = new Map();
  const controlChains = new Map();
  const behaviorApplyChains = new Map();
  const cleanupReconcileTails = new Map();
  const finalizationFailures = new Map();
  const startupQuarantineOwners = new Set();
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
  const {
    artifactDeclarations,
    assertArtifactPathIdentity,
    cacheArtifactDigest,
    collectArtifacts,
    hashOpenFile,
    listArtifacts,
    openValidatedArtifact,
    readArtifact,
    sameStableArtifactMetadata
  } = createTaskArtifactStore({
    root,
    getTask: (id) => tasks.get(id),
    awaitReady: () => ready,
    awaitTaskPersistence,
    reconcileTaskForRead,
    normalizeDiagnosticHistory,
    artifactValidationHook
  });
  const {
    createResumeInput,
    inspectResumeCheckpoint,
    readDiagnosticsPointers,
    verifyResumeCheckpoint,
    verifyResumeContext,
    verifyResumeModule
  } = createTaskCheckpointStore({ root });
  const {
    closeAllProfiles,
    closeProfile,
    hasOpenProfiles,
    isKnownLiveLease,
    openProfile
  } = createProfileRuntime({
    profileStore,
    workerFactory,
    profileWorkerPath: PROFILE_WORKER,
    profileLeaseRenewalMs,
    heartbeatTimeoutMs,
    deadlines: TASK_SERVICE_DEADLINES,
    awaitReady: () => ready,
    requireServiceOpen,
    reconcileAnyCleanup,
    markCleanupUnknown,
    profileCleanupReceiptPath,
    send,
    sendChildMessageConfirmed,
    scheduleQueuedTasks
  });
  const {
    applyTaskAssetAction,
    deprecateTaskType,
    describeTaskType,
    installTaskPack,
    installTaskType,
    listTaskAssets,
    listTaskPacks,
    listTaskTypes,
    maintainTaskAssets,
    restoreTaskType,
    retireTransientTaskType
  } = createTaskAssetManager({
    registry,
    tasks,
    children,
    finalizationFailures,
    awaitReady: () => ready,
    requireServiceOpen,
    serializeMutation: serializeTaskMutation,
    refreshResumeCheckpointState,
    persist
  });
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

  function serializeTaskMutation(operation) {
    const serialized = createTail.then(operation);
    createTail = serialized.catch(() => {});
    return serialized;
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

  async function readTaskCleanupReceipt(task) {
    return readCleanupReceipt(taskCleanupReceiptPath(task), {
      kind: 'task',
      taskId: task.id,
      attempt: task.attempt,
      workerPid: task.workerPid
    });
  }

  async function verifyTaskCleanupReceipt(task) {
    return Boolean(await readTaskCleanupReceipt(task));
  }

  async function markCleanupUnknown(profileId, ownerId, leaseGeneration = null) {
    if (typeof profileStore.markCleanupUnknown !== 'function') return;
    await profileStore.markCleanupUnknown(profileId, ownerId, {
      ...(Number.isSafeInteger(leaseGeneration) ? { expectedGeneration: leaseGeneration } : {})
    }).catch(() => {});
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
      await markCleanupUnknown(profile.id, lease.ownerId, lease.generation);
      return false;
    }
    if (!(await profileStore.releaseLease(profile.id, lease.ownerId, {
      cleanupConfirmed: true,
      ...(Number.isSafeInteger(lease.generation) ? { expectedGeneration: lease.generation } : {})
    }))) {
      await markCleanupUnknown(profile.id, lease.ownerId, lease.generation);
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
      await markCleanupUnknown(profile.id, lease.ownerId, lease.generation);
      return false;
    }
    if (!(await profileStore.releaseLease(profile.id, lease.ownerId, {
      cleanupConfirmed: true,
      ...(Number.isSafeInteger(lease.generation) ? { expectedGeneration: lease.generation } : {})
    }))) {
      await markCleanupUnknown(profile.id, lease.ownerId, lease.generation);
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
        const behavior = normalizeBehaviorMode(normalized.behavior, { allowLegacy: true });
        if (behavior) normalized.behavior = behavior;
        else delete normalized.behavior;
        return normalized;
      })
      : [];
  }

  function normalizeDiagnosticHistory(task) {
    task.diagnosticHistory = Array.isArray(task.diagnosticHistory)
      ? task.diagnosticHistory.filter((entry) => (
        entry && typeof entry === 'object' &&
        Number.isSafeInteger(entry.attempt) && entry.attempt >= 1 && entry.attempt <= MAX_ATTEMPTS
      )).slice(-MAX_DIAGNOSTIC_ATTEMPTS).map((entry) => {
        const normalizePointer = (pointer) => (
          pointer && typeof pointer === 'object' &&
          typeof pointer.path === 'string' && pointer.path &&
          pointer.attempt === entry.attempt
            ? { ...pointer, attempt: entry.attempt }
            : null
        );
        return {
          attempt: entry.attempt,
          screenshot: normalizePointer(entry.screenshot),
          observation: normalizePointer(entry.observation)
        };
      }).filter((entry) => entry.screenshot || entry.observation)
      : [];
  }

  function archiveAttemptDiagnostics(task) {
    normalizeDiagnosticHistory(task);
    const screenshot = task.lastScreenshot?.attempt === task.attempt
      ? { ...task.lastScreenshot }
      : null;
    const observation = task.lastObservation?.attempt === task.attempt
      ? { ...task.lastObservation }
      : null;
    if (!screenshot && !observation) return;
    const archived = { attempt: task.attempt, screenshot, observation };
    const existing = task.diagnosticHistory.findIndex((entry) => entry.attempt === task.attempt);
    if (existing === -1) task.diagnosticHistory.push(archived);
    else task.diagnosticHistory[existing] = archived;
    task.diagnosticHistory = task.diagnosticHistory.slice(-MAX_DIAGNOSTIC_ATTEMPTS);
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

  function markAttemptWorkerStarted(task, startedAt) {
    normalizeAttemptHistory(task);
    const record = [...task.history].reverse().find((entry) => entry.attempt === task.attempt);
    if (record) record.workerStartedAt ||= startedAt;
  }

  function finishAttemptHistory(task) {
    normalizeAttemptHistory(task);
    let record = [...task.history].reverse().find((entry) => entry.attempt === task.attempt);
    if (!record) {
      record = { attempt: task.attempt, resumed: task.attempt > 1, startedAt: task.startedAt || task.createdAt || nowIso() };
      task.history.push(record);
    }
    record.finishedAt ||= task.finishedAt || nowIso();
    const timing = normalizeTaskTiming(task);
    const activeCooldownStartedAt = timing?.activeCooldownStartedAt;
    if (timing && activeCooldownStartedAt && timing.lastCooldownStartedAt !== activeCooldownStartedAt) {
      const startedAt = Date.parse(activeCooldownStartedAt);
      const finishedAt = Date.parse(record.finishedAt);
      const resumeAt = Date.parse(task.cooldown?.resumeAt);
      const boundedFinishedAt = Number.isFinite(resumeAt) && Number.isFinite(finishedAt)
        ? Math.min(finishedAt, resumeAt)
        : finishedAt;
      if (Number.isFinite(startedAt) && Number.isFinite(boundedFinishedAt)) {
        timing.cooldownDurationMs += Math.max(0, boundedFinishedAt - startedAt);
      }
      timing.lastCooldownStartedAt = activeCooldownStartedAt;
      timing.activeCooldownStartedAt = null;
      if (task.cooldown?.status === 'active') task.cooldown.status = 'interrupted';
    }
    record.state = task.state;
    if (typeof task.error?.code === 'string') record.errorCode = task.error.code;
  }

  async function reconcileTaskCleanupReceipt(task, { workerExitConfirmed = false } = {}) {
    if (task.cleanup?.settled === true) return true;
    if (!workerExitConfirmed && await processAlive(task.workerPid)) return false;
    const receipt = await readTaskCleanupReceipt(task);
    if (!receipt) {
      await markCleanupUnknown(task.profileId, task.leaseOwner, task.leaseGeneration);
      return false;
    }
    if (!task.checkpointSeal && task.supportsResume === true) {
      await sealAttemptCheckpoint(task, {
        expectedCheckpoint: Object.hasOwn(receipt, 'checkpoint')
          ? receipt.checkpoint
          : task.checkpoint,
        checkpointKnownAbsent: Object.hasOwn(receipt, 'checkpoint') && receipt.checkpoint === null
      });
    }
    task.cleanup = {
      ...(task.cleanup || {}),
      workerExited: true
    };
    let profile;
    try {
      profile = await profileStore.get(task.profileId);
    } catch {
      return false;
    }
    if (profile?.lease?.ownerId === task.leaseOwner) {
      try {
        await profileStore.releaseLease(task.profileId, task.leaseOwner, {
          cleanupConfirmed: true,
          ...(Number.isSafeInteger(profile.lease?.generation)
            ? { expectedGeneration: profile.lease.generation }
            : {})
        });
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
    if (typeof profileStore.list === 'function') {
      const startupProfiles = await profileStore.list();
      for (const profile of startupProfiles) {
        if (
          profile.state === 'error' &&
          profile.lease?.cleanupRequired === true &&
          /^task:/u.test(profile.lease.ownerId || '') &&
          !(await processAlive(profile.lease.pid))
        ) {
          startupQuarantineOwners.add(profile.lease.ownerId);
        }
      }
    }
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
      normalizeDiagnosticHistory(task);
      normalizeTaskCoordination(task);
      task.behavior = normalizeBehaviorMode(task.behavior, { allowLegacy: true }) || 'human';
      const configuredBehavior = normalizeBehaviorMode(task.behaviorState?.configured, { allowLegacy: true });
      task.behaviorState = restoredBehaviorState(
        task.behaviorState,
        configuredBehavior || task.behavior
      ) || initialBehaviorState(task.behavior);
      task.interactionContract = task.interactionContract === FULL_HUMAN_INTERACTION_CONTRACT
        ? FULL_HUMAN_INTERACTION_CONTRACT
        : null;
      if (!task.taskLabel) task.taskLabel = normalizeTaskLabel(undefined, task.taskType);
      if (!task.displayName) task.displayName = buildTaskDisplayName(task);
      normalizeTaskTiming(task);
      task.supportsResume = task.supportsResume === true;
      // Output seals were introduced after older terminal records already
      // existed. Preserve those records, while every task created or resumed
      // by this runtime opts into the fail-closed completion boundary.
      task.outputSealRequired = task.outputSealRequired === true;
      if (!task.outputSealRequired) {
        task.outputSeal = null;
        task.outputSealError = null;
      }
      const legacyExternalCost = migrateLegacyExternalCostState(task);
      task.checkpointSeal = task.checkpointSeal &&
        task.checkpointSeal.attempt === task.attempt &&
        typeof task.checkpointSeal.sealedAt === 'string' &&
        !Number.isNaN(Date.parse(task.checkpointSeal.sealedAt))
        ? task.checkpointSeal
        : null;
      task.cleanup = {
        browserClosed: false,
        leaseReleased: false,
        workerExited: false,
        settled: false,
        ...(task.cleanup || {})
      };
      task.leaseGeneration = Number.isSafeInteger(task.leaseGeneration) && task.leaseGeneration >= 1
        ? task.leaseGeneration
        : null;
      if (task.leaseHeld === true && task.leaseGeneration === null) {
        try {
          const leasedProfile = await profileStore.get(task.profileId);
          if (
            leasedProfile.lease?.ownerId === task.leaseOwner &&
            Number.isSafeInteger(leasedProfile.lease.generation) &&
            leasedProfile.lease.generation >= 1
          ) {
            task.leaseGeneration = leasedProfile.lease.generation;
          }
        } catch {
          // The existing recovery path below remains fail-closed when the
          // Profile record is missing or unreadable.
        }
      }
      // Never trust a stale persisted `settled` bit on its own.
      refreshCleanupSettled(task);
      const wasTerminallySettled = (
        TERMINAL_TASK_STATES.has(task.state) && task.cleanup.settled === true
      );
      const safelyQueued = (
        task.state === 'queued' ||
        (task.state === 'paused' && task.pauseContext?.previousState === 'queued')
      ) && !task.startedAt && !task.workerPid && task.leaseHeld !== true;
      tasks.set(task.id, task);
      await recoverDiagnosticsPointers(task);
      if (
        legacyExternalCost.paid && (
          !TERMINAL_TASK_STATES.has(task.state) ||
          (task.state === 'failed' && legacyExternalCost.wasResumable)
        )
      ) {
        if (safelyQueued) {
          task.leaseHeld = false;
          task.cleanup = {
            browserClosed: true,
            leaseReleased: true,
            workerExited: true,
            settled: true
          };
        } else if (task.cleanup.settled !== true) {
          task.cleanup.managerRestartObserved = true;
          await reconcileTaskCleanupReceipt(task);
          refreshCleanupSettled(task);
        }
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          task.state = 'failed';
          task.result = null;
          task.completion = null;
          task.completionClaimed = false;
        }
        task.error = legacyExternalCostUnsupportedError();
        task.progress = terminalProgress(task, 'failed');
        task.finishedAt ||= nowIso();
        task.health = { status: 'failed', checkedAt: nowIso() };
        finishAttemptHistory(task);
        await refreshResumeCheckpointState(task);
        task.currentActivity = lifecycleActivity('failed');
        task.updatedAt = nowIso();
        await atomicJson(filePath, task);
        if (task.cleanup.settled === true) {
          await removeCleanupReceipt(taskCleanupReceiptPath(task)).catch(() => {});
        }
        continue;
      }
      if (!safelyQueued) {
        if (task.cleanup.settled !== true) {
          task.cleanup.managerRestartObserved = true;
          await reconcileTaskCleanupReceipt(task);
          refreshCleanupSettled(task);
        }

        const claimedCompletion = task.state === 'verifying' || task.state === 'completed' ||
          (task.completionClaimed === true && !TERMINAL_TASK_STATES.has(task.state));
        if (task.cancelRequestedAt && task.cleanup.settled === true) {
          task.state = 'cancelled';
          task.error = null;
          if (task.cancelCommandId) {
            markCommandStatus(task, task.cancelCommandId, 'applied', {
              message: 'Cancellation cleanup confirmed during Manager recovery'
            });
          }
          appendTimeline(task, 'task.cancelled', {
            commandId: task.cancelCommandId || null,
            status: 'applied',
            message: 'Cancellation cleanup confirmed during Manager recovery'
          });
        } else if (task.cancelRequestedAt) {
          task.state = 'failed';
          task.error = {
            code: 'TASK_CANCEL_CLEANUP_UNCONFIRMED',
            message: 'Manager restarted before cancellation cleanup could be confirmed.'
          };
        } else if (claimedCompletion && task.result && task.cleanup.settled === true) {
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
      if (wasTerminallySettled && !task.checkpointSeal) {
        // Legacy terminal records may migrate only an already-persisted exact
        // pointer. A bare checkpoint file is never adopted after terminal.
        await sealAttemptCheckpoint(task, { allowDiskRecovery: false });
      }
      await refreshResumeCheckpointState(task);
      task.currentActivity = lifecycleActivity(task.state);
      task.updatedAt = nowIso();
      await atomicJson(filePath, task);
      if (task.cleanup.settled === true) {
        await removeCleanupReceipt(taskCleanupReceiptPath(task)).catch(() => {});
      }
    }
    await maintainTaskAssets().catch(() => {});
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
      const knownLiveProfileOwner = isKnownLiveLease(task.profileId, activeLeaseOwner);
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

  function requireTaskAccess(id, caller, { ownerOnly = false } = {}) {
    const task = tasks.get(id);
    if (!task || task.deletedAt || !(ownerOnly ? isTaskOwner(task, caller) : canAccess(task, caller))) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    normalizeTaskCoordination(task);
    return task;
  }

  function existingCommand(task, commandId, payloadHash) {
    const command = task.commands.find((entry) => entry.commandId === commandId);
    if (!command) return null;
    if (command.payloadHash !== payloadHash) {
      throw new TaskServiceError(
        'TASK_COMMAND_ID_CONFLICT',
        'commandId is already bound to a different task command',
        409
      );
    }
    return command;
  }

  function requireTaskRevision(task, expectedRevision) {
    if (task.revision !== expectedRevision) {
      throw new TaskServiceError(
        'TASK_REVISION_CONFLICT',
        `Task revision changed; expected ${expectedRevision}, current ${task.revision}`,
        409
      );
    }
  }

  function addCommand(task, {
    commandId,
    kind,
    expectedRevision,
    actor,
    payload = null,
    status = 'pending'
  }) {
    normalizeTaskCoordination(task);
    const payloadHash = requestHash({ kind, payload });
    const duplicate = existingCommand(task, commandId, payloadHash);
    if (duplicate) return { command: duplicate, duplicate: true };
    requireTaskRevision(task, expectedRevision);
    const at = nowIso();
    const command = {
      commandId,
      kind,
      expectedRevision,
      payloadHash,
      status,
      actor: clone(actor),
      ...(payload ? { payload: clone(payload) } : {}),
      createdAt: at,
      updatedAt: at
    };
    task.commands.push(command);
    task.commands = task.commands.slice(-MAX_TASK_COMMANDS);
    task.revision += 1;
    appendTimeline(task, `command.${kind}`, {
      actor,
      commandId,
      status,
      message: payload?.message || ''
    });
    return { command, duplicate: false };
  }

  function markCommandStatus(task, commandId, status, { actor = null, message = '' } = {}) {
    if (!COMMAND_STATUSES.has(status)) return null;
    normalizeTaskCoordination(task);
    const command = task.commands.find((entry) => entry.commandId === commandId);
    if (!command) return null;
    if (command.status === status) return command;
    command.status = status;
    command.updatedAt = nowIso();
    if (message) command.response = redactSensitiveText(message).slice(0, 2_000);
    appendTimeline(task, `command.${status}`, {
      actor,
      commandId,
      status,
      message
    });
    return command;
  }

  function publicCommand(command) {
    const { payloadHash: _payloadHash, ...safe } = command;
    return clone(safe);
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
    if (task.userRequest?.status === 'pending') {
      throw completionGateFailure('Task cannot complete while a user handoff is still pending');
    }
    if (task.cooldown?.status === 'active') {
      throw completionGateFailure('Task cannot complete while a cooldown is still active');
    }
    let outputTree = task.completion?.outputTree || null;
    if (task.outputSealRequired === true && task.state === 'completed') {
      if (
        outputTree?.version !== 1 || !Number.isSafeInteger(outputTree.files) || outputTree.files < 0 ||
        !Number.isSafeInteger(outputTree.bytes) || outputTree.bytes < 0 ||
        !Number.isSafeInteger(outputTree.directories) || outputTree.directories < 0
      ) {
        throw new TaskServiceError(
          'TASK_OUTPUT_SEAL_MISSING',
          'Completed task has no verified output-tree seal',
          409
        );
      }
    } else if (task.outputSealRequired === true) {
      if (task.outputSealError) {
        throw new TaskServiceError(
          task.outputSealError.code || 'TASK_OUTPUT_SEAL_FAILED',
          task.outputSealError.message || 'Task output could not be sealed at the completion boundary',
          409
        );
      }
      if (!task.outputSeal) {
        throw new TaskServiceError(
          'TASK_OUTPUT_SEAL_MISSING',
          'Task output was not sealed at the completion boundary',
          409
        );
      }
      const currentOutput = await snapshotOutputTree({ root: task.outputDir, limits: OUTPUT_SEAL_LIMITS });
      assertOutputTreeUnchanged(task.outputSeal, currentOutput);
      outputTree = Object.freeze({
        version: currentOutput.version,
        files: currentOutput.files,
        bytes: currentOutput.bytes,
        directories: currentOutput.directories.length
      });
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
          const afterHash = await opened.handle.stat({ bigint: true });
          if (!sameStableArtifactMetadata(opened.stats, afterHash)) {
            throw new Error('artifact changed while hashing');
          }
          await assertArtifactPathIdentity(task, declaration, afterHash);
          // Seed the cache only after the hash and both handle/path stability
          // checks succeed. A raced or mismatched digest is never cacheable.
          cacheArtifactDigest(task, declaration, afterHash, sha256, sha256);
          artifactAnchors.push({
            artifactId: declaration.id,
            sizeBytes: Number(afterHash.size),
            sha256
          });
        }
        if (reverifyExistingAnchors) {
          const afterHash = await opened.handle.stat({ bigint: true });
          if (!sameStableArtifactMetadata(opened.stats, afterHash)) {
            throw new Error('artifact changed while hashing');
          }
          await assertArtifactPathIdentity(task, declaration, afterHash);
        }
      } catch {
        throw completionGateFailure('A declared agent-visible artifact is missing or unstable');
      } finally {
        await opened?.handle.close().catch(() => {});
      }
    }
    return {
      verifiedAt: nowIso(),
      artifactCount: required.length,
      artifacts: artifactAnchors,
      ...(outputTree ? { outputTree } : {})
    };
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
          cleanupConfirmed: task.cleanup.browserClosed === true,
          ...(Number.isSafeInteger(task.leaseGeneration)
            ? { expectedGeneration: task.leaseGeneration }
            : {})
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
      await markCleanupUnknown(task.profileId, task.leaseOwner, task.leaseGeneration);
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
      for (const request of entry.behaviorRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new TaskServiceError(
          'BEHAVIOR_LIVE_APPLY_UNCONFIRMED',
          'Task Worker exited before confirming the live behavior change',
          503
        ));
      }
      entry.behaviorRequests.clear();
      for (const request of entry.focusRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new TaskServiceError(
          'TASK_FOCUS_UNAVAILABLE',
          'Task Worker exited before confirming browser focus',
          409
        ));
      }
      entry.focusRequests.clear();
      for (const request of entry.continueRequests.values()) {
        clearTimeout(request.timer);
        request.reject(new TaskServiceError(
          'TASK_WORKER_UNAVAILABLE',
          'Task Worker exited before confirming the user handoff',
          409
        ));
      }
      entry.continueRequests.clear();
    }
    // A heartbeat renewal that started before finalization may still be queued
    // inside ProfileStore. Drain it before the one authoritative release so a
    // late renewal cannot resurrect a completed task's lease.
    await entry?.leaseRenewalTail?.catch(() => {});
    await awaitTaskPersistence(task.id);
    if (
      task.outputSealRequired === true &&
      (task.completionClaimed === true || task.state === 'verifying')
    ) {
      if (!entry?.outputSealPromise) {
        task.outputSeal = null;
        task.outputSealError = {
          code: 'TASK_OUTPUT_SEAL_MISSING',
          message: 'Task output was not sealed at the completion boundary'
        };
      } else {
        try {
          task.outputSeal = await entry.outputSealPromise;
          task.outputSealError = null;
        } catch (error) {
          task.outputSeal = null;
          task.outputSealError = sanitizeError(error, 'TASK_OUTPUT_SEAL_FAILED');
        }
      }
    }
    // Freeze the final checkpoint generation before workerExited or settled
    // can become observable. IPC updates are drained above and no new Worker
    // messages are accepted after entry.attached=false.
    await sealAttemptCheckpoint(task, { allowDiskRecovery: true });
    children.delete(task.id);
    task.cleanup.workerExited = true;
    task.cleanup.exitCode = exitCode;
    task.cleanup.exitSignal = signal || null;
    const claimedCompletion = task.completionClaimed === true || task.state === 'verifying';
    const cancellationRequested = Boolean(task.cancelRequestedAt);
    if (!claimedCompletion && !cancellationRequested && !TERMINAL_TASK_STATES.has(task.state)) {
      await update(task, {
        state: 'failed',
        error: { code: 'TASK_WORKER_EXITED', message: 'Task worker exited before reporting a terminal state' }
      });
    }
    if (task.cleanup?.browserClosed === true) {
      await releaseTaskLease(task);
    } else if (!(await reconcileTaskCleanupReceipt(task, { workerExitConfirmed: true }))) {
      await markCleanupUnknown(task.profileId, task.leaseOwner, task.leaseGeneration);
    }
    if (claimedCompletion && task.state === 'verifying') {
      try {
        task.completion = await verifyCompletionGate(task);
        task.state = 'completed';
        task.error = null;
      } catch (error) {
        task.state = 'failed';
        task.error = sanitizeError(error, 'TASK_COMPLETION_GATE_FAILED');
      } finally {
        // The full per-file snapshot is needed only between completion claim
        // and confirmed Worker exit. Persist the compact verified summary,
        // never a potentially multi-megabyte hash table in every task record.
        task.outputSeal = null;
        task.outputSealError = null;
      }
    }
    refreshCleanupSettled(task);
    if (cancellationRequested) {
      if (task.cleanup.settled === true) {
        task.state = 'cancelled';
        task.error = null;
        if (task.cancelCommandId) {
          markCommandStatus(task, task.cancelCommandId, 'applied', {
            message: 'Browser closed, Worker exited, and Profile lease released'
          });
        }
        appendTimeline(task, 'task.cancelled', {
          commandId: task.cancelCommandId || null,
          status: 'applied',
          message: 'Cancellation cleanup confirmed'
        });
      } else {
        task.state = 'failed';
        task.error = {
          code: 'TASK_CANCEL_CLEANUP_UNCONFIRMED',
          message: 'Cancellation was requested but browser cleanup could not be confirmed'
        };
      }
    }
    task.finishedAt ||= nowIso();
    if (TERMINAL_TASK_STATES.has(task.state)) task.progress = terminalProgress(task, task.state);
    task.health = {
      status: task.state,
      checkedAt: nowIso(),
      ...(task.health?.diagnosticRequested === true
        ? {
          diagnosticRequested: true,
          ...(typeof task.health.since === 'string' ? { since: task.health.since } : {})
        }
        : {})
    };
    finishAttemptHistory(task);
    await refreshResumeCheckpointState(task);
    await update(task, {
      state: task.state,
      error: task.error,
      finishedAt: task.finishedAt,
      cleanup: task.cleanup,
      health: task.health,
      history: task.history,
      commands: task.commands,
      timeline: task.timeline,
      timelineSequence: task.timelineSequence,
      checkpoint: task.checkpoint,
      checkpointSeal: task.checkpointSeal,
      resumeCheckpointValid: task.resumeCheckpointValid,
      resumeCheckpointError: task.resumeCheckpointError,
      outputSealRequired: task.outputSealRequired,
      outputSeal: task.outputSeal,
      outputSealError: task.outputSealError,
      ...(task.completion ? { completion: task.completion } : {})
    });
    if (task.cleanup.settled === true) {
      await removeCleanupReceipt(taskCleanupReceiptPath(task)).catch(() => {});
    }
    await retireTransientTaskType(task).catch(() => {});
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
      await markCleanupUnknown(task.profileId, task.leaseOwner, task.leaseGeneration);
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
      behaviorRequests: new Map(),
      focusRequests: new Map(),
      continueRequests: new Map(),
      workerOutputSeal: null,
      workerOutputSealError: null,
      outputSealPromise: null,
      attached: false
    };

    // Worker messages are advisory, but lifecycle state is authoritative in
    // the Manager. Once cancellation or completion has begun, no late
    // progress/cooldown/handoff/diagnostic callback may make the task look
    // runnable again. Terminal error and cleanup messages remain accepted by
    // their dedicated handlers below.
    const lifecycleFinalizationStarted = () => Boolean(
      closing || entry.finalized || task.cancelRequestedAt ||
      task.completionClaimed === true || TERMINAL_TASK_STATES.has(task.state)
    );
    const mutableWorkerIngressClosed = () => Boolean(
      lifecycleFinalizationStarted() || task.state === 'verifying'
    );

    try {
      child.on('message', (message) => {
      if (!entry.attached) return;
      if (!message || typeof message !== 'object') return;
      if (message.type === 'heartbeat') {
        // A heartbeat proves only that the Worker is alive. It must never undo
        // an already-authoritative cancel/completion boundary, postpone forced
        // cleanup, or renew a Profile lease after finalization has begun.
        if (lifecycleFinalizationStarted()) {
          scheduleForcedStop(task, entry);
          return;
        }
        entry.diagnoseAt = 0;
        clearTimeout(entry.forceKillTimer);
        entry.forceKillTimer = null;
        void update(task, { heartbeatAt: nowIso() }).catch(() => {});
        const renewal = entry.leaseRenewalTail.then(async () => {
          if (!entry.attached || lifecycleFinalizationStarted()) return;
          await profileStore.acquireLease(task.profileId, task.leaseOwner, {
            pid: child.pid,
            ttlMs: LEASE_TTL_MS,
            cleanupRequired: true,
            ...(Number.isSafeInteger(task.leaseGeneration)
              ? { expectedGeneration: task.leaseGeneration }
              : {}),
            ...taskLeaseAccess(task)
          });
        });
        entry.leaseRenewalTail = renewal.catch((error) => {
          if (lifecycleFinalizationStarted()) return;
          void update(task, { state: 'failed', error: sanitizeError(error, 'LEASE_RENEWAL_FAILED') }).catch(() => {});
          send(child, { type: 'cancel' });
          scheduleForcedStop(task, entry);
        });
        return;
      }
      if (message.type === 'progress' && message.progress) {
        if (mutableWorkerIngressClosed()) return;
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
        if (currentActivity && !mutableWorkerIngressClosed()) {
          void update(task, { currentActivity }).catch(() => {});
        }
        return;
      }
      if (message.type === 'waiting_user' && message.request) {
        if (mutableWorkerIngressClosed()) return;
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
            kind: request.kind === 'human_verification' ? 'human_verification' : 'instruction',
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
        const workerStateIsTerminal = TERMINAL_TASK_STATES.has(message.state);
        if (mutableWorkerIngressClosed() && !workerStateIsTerminal) return;
        if (
          message.state === 'completed' &&
          (task.cancelRequestedAt || task.state === 'cancel_requested')
        ) return;
        if (['pause_requested', 'paused', 'recovering', 'running'].includes(message.state) && message.commandId) {
          const status = message.state === 'paused' || message.state === 'running' ? 'applied' : 'delivered';
          markCommandStatus(task, message.commandId, status, {
            message: message.state === 'paused'
              ? 'Current browser action settled; task is paused'
              : message.state === 'running'
                ? 'Live page revalidated; task resumed'
                : ''
          });
          if (message.state === 'running') task.pauseContext = null;
          void update(task, {
            state: message.state,
            pauseContext: task.pauseContext,
            commands: task.commands,
            timeline: task.timeline,
            timelineSequence: task.timelineSequence,
            progress: {
              ...task.progress,
              message: message.state === 'paused'
                ? 'Paused after current action settled; diagnostic captured'
                : message.state === 'recovering'
                  ? 'Revalidating live page before resume'
                  : message.state === 'running'
                    ? 'Task resumed after live-page validation'
                    : 'Pause requested; settling current action'
            },
            health: {
              status: message.state === 'paused' ? 'paused' : 'healthy',
              checkedAt: nowIso()
            },
            ...(message.state === 'running' ? { progressAt: nowIso() } : {})
          }).catch(() => {});
          return;
        }
        if (
          ['pause_requested', 'paused'].includes(task.state) &&
          !['failed', 'cancelled', 'completed'].includes(message.state)
        ) {
          // A cooldown, handoff, or startup transition racing the pause must
          // not make the Manager claim execution resumed while the action gate
          // is still closed.
          return;
        }
        const terminal = TERMINAL_TASK_STATES.has(message.state);
        const resumedFromCooldown = task.state === 'cooling_down' && message.state === 'running';
        if (resumedFromCooldown) entry.stallDiagnoseAt = 0;
        if (message.state === 'completed') {
          if (!TERMINAL_TASK_STATES.has(task.state)) {
            const completionUpdate = update(task, {
              state: 'verifying',
              completionClaimed: true,
              progress: { ...task.progress, message: 'Verifying result and cleanup' }
            });
            if (task.outputSealRequired === true && !entry.outputSealPromise) {
              if (entry.workerOutputSealError) {
                entry.outputSealPromise = Promise.reject(entry.workerOutputSealError);
              } else if (entry.workerOutputSeal) {
                entry.outputSealPromise = Promise.resolve(entry.workerOutputSeal);
              } else if (requireWorkerOutputSeal) {
                entry.outputSealPromise = Promise.reject(new TaskServiceError(
                  'TASK_OUTPUT_SEAL_MISSING',
                  'Task Worker did not publish its completion output seal',
                  409
                ));
              } else {
                // Custom test Workers use a Manager-owned fallback snapshot.
                // The production Worker must publish its pre-claim snapshot.
                entry.outputSealPromise = snapshotOutputTree({
                  root: task.outputDir,
                  limits: OUTPUT_SEAL_LIMITS
                });
              }
              void entry.outputSealPromise.catch(() => {});
            }
            void completionUpdate.catch(() => {});
          }
          scheduleForcedStop(task, entry);
          return;
        }
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          if (message.state === 'cancelled' && task.cancelRequestedAt) {
            // Cancellation is not terminal until browser close, Worker exit,
            // and Profile lease release are all durably confirmed.
            void update(task, {
              state: 'cancel_requested',
              progress: { ...task.progress, message: 'Cancellation acknowledged; confirming cleanup' }
            }).catch(() => {});
            scheduleForcedStop(task, entry);
            return;
          }
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
        if (mutableWorkerIngressClosed()) return;
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
        if (mutableWorkerIngressClosed()) return;
        void update(task, {
          lastScreenshot: { path: message.path, reason: message.reason, at: nowIso(), attempt: task.attempt }
        }).catch(() => {});
        return;
      }
      if (message.type === 'observation') {
        if (mutableWorkerIngressClosed()) return;
        void update(task, {
          lastObservation: { path: message.path, reason: message.reason, at: nowIso(), attempt: task.attempt }
        }).catch(() => {});
        return;
      }
      if (message.type === 'behavior' && message.behavior) {
        if (mutableWorkerIngressClosed()) return;
        const state = workerBehaviorState(message.behavior, task.behavior);
        if (state) void update(task, { behaviorState: state }).catch(() => {});
        return;
      }
      if (message.type === 'behavior_applied' && typeof message.requestId === 'string') {
        const request = entry.behaviorRequests.get(message.requestId);
        if (!request) return;
        entry.behaviorRequests.delete(message.requestId);
        clearTimeout(request.timer);
        const state = workerBehaviorState(message.behavior, request.behavior);
        if (state) request.resolve(state);
        else request.reject(new TaskServiceError(
          'BEHAVIOR_LIVE_APPLY_INVALID',
          'Task Worker returned an invalid behavior application receipt',
          502
        ));
        return;
      }
      if (message.type === 'behavior_control_error' && typeof message.requestId === 'string') {
        const request = entry.behaviorRequests.get(message.requestId);
        if (!request) return;
        entry.behaviorRequests.delete(message.requestId);
        clearTimeout(request.timer);
        request.reject(new TaskServiceError(
          'BEHAVIOR_LIVE_APPLY_REJECTED',
          redactSensitiveText(message.error?.message || 'Task Worker rejected the live behavior change').slice(0, 500),
          409
        ));
        return;
      }
      if (message.type === 'focus_applied' && typeof message.requestId === 'string') {
        const request = entry.focusRequests.get(message.requestId);
        if (!request) return;
        entry.focusRequests.delete(message.requestId);
        clearTimeout(request.timer);
        request.resolve(typeof message.at === 'string' ? message.at : nowIso());
        return;
      }
      if (message.type === 'focus_control_error' && typeof message.requestId === 'string') {
        const request = entry.focusRequests.get(message.requestId);
        if (!request) return;
        entry.focusRequests.delete(message.requestId);
        clearTimeout(request.timer);
        request.reject(new TaskServiceError(
          message.error?.code === 'TASK_FOCUS_NO_LIVE_PAGE' ? 'TASK_FOCUS_NO_LIVE_PAGE' : 'TASK_FOCUS_REJECTED',
          redactSensitiveText(message.error?.message || 'Task Worker could not focus its browser page').slice(0, 500),
          409
        ));
        return;
      }
      if (message.type === 'continue_applied' && typeof message.requestId === 'string') {
        const request = entry.continueRequests.get(message.requestId);
        if (!request) return;
        entry.continueRequests.delete(message.requestId);
        clearTimeout(request.timer);
        request.resolve(typeof message.at === 'string' ? message.at : nowIso());
        return;
      }
      if (message.type === 'continue_control_error' && typeof message.requestId === 'string') {
        const request = entry.continueRequests.get(message.requestId);
        if (!request) return;
        entry.continueRequests.delete(message.requestId);
        clearTimeout(request.timer);
        request.reject(new TaskServiceError(
          'USER_HANDOFF_CONTINUE_REJECTED',
          redactSensitiveText(message.error?.message || 'Task Worker rejected the user handoff').slice(0, 500),
          409
        ));
        return;
      }
      if (message.type === 'cooldown' && message.cooldown) {
        if (mutableWorkerIngressClosed()) return;
        const record = message.cooldown;
        if (
          ['active', 'completed', 'interrupted'].includes(record.status) &&
          typeof record.resumeAt === 'string' &&
          typeof record.reason === 'string'
        ) {
          const timing = normalizeTaskTiming(task);
          if (timing) {
            if (record.status === 'active') {
              timing.activeCooldownStartedAt = record.startedAt || nowIso();
            } else {
              const startedAt = record.startedAt || timing.activeCooldownStartedAt;
              if (startedAt && timing.lastCooldownStartedAt !== startedAt) {
                const calculated = Math.max(0, Date.parse(record.finishedAt || nowIso()) - Date.parse(startedAt));
                timing.cooldownDurationMs += Number.isFinite(record.elapsedMs)
                  ? Math.max(0, Math.round(record.elapsedMs))
                  : (Number.isFinite(calculated) ? calculated : 0);
                timing.lastCooldownStartedAt = startedAt;
              }
              timing.activeCooldownStartedAt = null;
            }
          }
          void update(task, {
            cooldown: {
              status: record.status,
              durationMs: Number(record.durationMs) || 0,
              resumeAt: record.resumeAt,
              reason: redactSensitiveText(record.reason).slice(0, 160),
              updatedAt: nowIso()
            },
            ...(timing ? { timing } : {})
          }).catch(() => {});
        }
        return;
      }
      if (message.type === 'control_error' && message.commandId) {
        markCommandStatus(task, message.commandId, 'rejected', {
          message: redactSensitiveText(message.error?.message || 'Task control command failed').slice(0, 2_000)
        });
        void update(task, {
          commands: task.commands,
          timeline: task.timeline,
          timelineSequence: task.timelineSequence
        }).catch(() => {});
        return;
      }
      if (message.type === 'output_seal') {
        if (
          entry.finalized || task.cancelRequestedAt || task.completionClaimed === true ||
          task.state !== 'verifying'
        ) return;
        if (entry.workerOutputSeal || entry.workerOutputSealError) {
          entry.workerOutputSealError = new TaskServiceError(
            'TASK_OUTPUT_SEAL_DUPLICATE',
            'Task Worker published more than one completion output seal',
            409
          );
          entry.workerOutputSeal = null;
          return;
        }
        entry.workerOutputSeal = clone(message.snapshot);
        return;
      }
      if (message.type === 'result') {
        const verificationIngressOpen = (
          !entry.finalized && !task.cancelRequestedAt && task.completionClaimed !== true &&
          task.state === 'verifying'
        );
        if (mutableWorkerIngressClosed() && !verificationIngressOpen) return;
        void update(task, { result: clone(redactSensitiveValue(message.result)) }).catch(() => {});
        return;
      }
      if (message.type === 'error') {
        if (!TERMINAL_TASK_STATES.has(task.state)) {
          const cancellationPending = message.state === 'cancelled' && task.cancelRequestedAt;
          const nextState = cancellationPending ? 'cancel_requested' : message.state === 'cancelled' ? 'cancelled' : 'failed';
          void update(task, {
            state: nextState,
            error: sanitizeError(message.error),
            ...(cancellationPending ? {} : { finishedAt: nowIso() }),
            progress: cancellationPending
              ? { ...task.progress, message: 'Cancellation acknowledged; confirming cleanup' }
              : terminalProgress(task, nextState)
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

      const progressSensitive = ['starting_browser', 'running', 'recovering'].includes(task.state) ||
        (task.state === 'verifying' && task.completionClaimed !== true);
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
        const stalledSince = task.health?.since || task.progressAt || task.startedAt || task.createdAt;
        void update(task, {
          state: 'failed',
          health: {
            status: 'failed',
            since: stalledSince,
            checkedAt: nowIso(),
            diagnosticRequested: true
          },
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
      // Every attempt launched by this runtime uses the current double-snapshot
      // contract, including queued tasks restored from a pre-2.8.2 state file.
      outputSealRequired: true,
      outputSeal: null,
      outputSealError: null,
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
      if (task.state === 'cancelled' || task.cancelRequestedAt) {
        throw new TaskServiceError('TASK_LAUNCH_CANCELLED', 'Queued task was cancelled before worker launch', 409);
      }
      const cleanupReceiptPath = taskCleanupReceiptPath(task);
      await rm(cleanupReceiptPath, { force: true });
      child = workerFactory(TASK_WORKER, 'task');
      entry = attachTaskWorker(task, child);
      if (task.state === 'cancelled' || task.cancelRequestedAt) {
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
      task.leaseGeneration = leasedProfile.lease?.generation ?? null;
      if (task.state === 'cancelled' || task.cancelRequestedAt) {
        throw new TaskServiceError('TASK_LAUNCH_CANCELLED', 'Queued task was cancelled before browser startup', 409);
      }
      failureCode = 'TASK_WORKER_START_FAILED';
      const startingAt = nowIso();
      const behavior = resolveProfileBehavior(leasedProfile);
      setAttemptHistoryBehavior(task, behavior);
      markAttemptWorkerStarted(task, startingAt);
      const pausePending = task.state === 'pause_requested' && Boolean(task.pauseContext?.commandId);
      await update(task, {
        state: pausePending ? 'pause_requested' : 'starting_browser',
        startedAt: startingAt,
        workerPid: child.pid,
        behavior,
        behaviorState: initialBehaviorState(behavior, startingAt),
        history: task.history,
        progress: {
          current: 0,
          total: null,
          message: pausePending ? 'Starting browser at a requested pause boundary' : 'Starting browser'
        },
        progressAt: startingAt,
        heartbeatAt: startingAt,
        health: { status: 'healthy', checkedAt: startingAt }
      });
      if (task.state === 'cancelled' || task.cancelRequestedAt) {
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
          ...(task.interactionContract ? { interactionContract: task.interactionContract } : {}),
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
      if (task.state !== 'cancelled' && !task.cancelRequestedAt) {
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
    return serializeTaskMutation(() => createSerialized(body, caller));
  }

  async function createSerialized(body = {}, suppliedCaller = {}) {
    await ready;
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    const allowed = new Set([
      'profileId',
      'taskType',
      'taskLabel',
      'input',
      'timeoutMs',
      'idempotencyKey'
    ]);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (Object.hasOwn(body, 'externalCostBudget')) {
      throw new TaskServiceError(
        'TASK_EXTERNAL_COST_UNSUPPORTED',
        'externalCostBudget was removed in Task Master 2.8.0; govern paid provider calls outside Task Master'
      );
    }
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
    const taskLabel = normalizeTaskLabel(body.taskLabel, taskType.title || taskType.name);
    const interactionContract = taskType.interactionContract === FULL_HUMAN_INTERACTION_CONTRACT
      ? FULL_HUMAN_INTERACTION_CONTRACT
      : null;
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
      taskLabel,
      taskTypeSha256: taskType.sha256,
      supportsResume: taskType.supportsResume === true,
      interactionContract,
      timeoutMs: body.timeoutMs ?? null,
      input
    };
    const hash = requestHash(hashInput);
    const existing = [...tasks.values()].find((task) => (
      isTaskOwner(task, caller) && task.idempotencyKey === body.idempotencyKey
    ));
    if (existing) {
      const { taskLabel: _taskLabel, ...legacyHashInput } = hashInput;
      const { interactionContract: _interactionContract, ...versionThreeHashInput } = hashInput;
      const { interactionContract: _legacyInteractionContract, ...versionTwoHashInput } = legacyHashInput;
      const legacyHash = existing.requestHashVersion === undefined
        ? requestHash({ ...versionTwoHashInput, behavior: existing.behavior })
        : existing.requestHashVersion === 2
          ? requestHash(versionTwoHashInput)
          : existing.requestHashVersion === 3
            ? requestHash(versionThreeHashInput)
            : null;
      if (existing.requestHash !== hash && existing.requestHash !== legacyHash) {
        throw new TaskServiceError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency key is already bound to a different task request',
          409
        );
      }
      if (existing.deletedAt) {
        throw new TaskServiceError(
          'TASK_IDEMPOTENCY_RETIRED',
          'The idempotency key belongs to a deleted task record; use a new key for a new task',
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
    const createdAt = nowIso();
    const task = {
      id,
      jobId: `job_${randomUUID().replaceAll('-', '')}`,
      revision: 1,
      timelineSequence: 0,
      timeline: [],
      commands: [],
      reports: [],
      report: null,
      profileId: body.profileId,
      taskType: taskType.name,
      taskLabel,
      taskTypeSha256: taskType.sha256,
      supportsResume: taskType.supportsResume === true,
      ...(interactionContract ? { interactionContract } : {}),
      modulePath: taskType.modulePath,
      ownerRole: caller.role,
      ownerClientId: caller.clientId,
      ...(caller.role === 'agent' ? { ownerAgentName: caller.agentName } : {}),
      idempotencyKey: body.idempotencyKey,
      requestHash: hash,
      requestHashVersion: 4,
      inputRevisionHash: requestHash(input),
      behavior,
      input: clone(input),
      timeoutMs: body.timeoutMs ?? null,
      attempt: 1,
      history: [],
      diagnosticHistory: [],
      resumeKeys: [],
      state: 'queued',
      currentActivity: lifecycleActivity('queued'),
      progress: { current: 0, total: null, message: 'Queued' },
      progressAt: nowIso(),
      heartbeatAt: nowIso(),
      health: { status: 'healthy', checkedAt: nowIso() },
      behaviorState: initialBehaviorState(behavior),
      cooldown: null,
      timing: { version: 1, cooldownDurationMs: 0, activeCooldownStartedAt: null },
      outputDir,
      outputSealRequired: true,
      outputSeal: null,
      outputSealError: null,
      checkpoint: null,
      checkpointSeal: null,
      resumeInput: null,
      resumeCheckpointValid: false,
      resumeCheckpointError: null,
      result: null,
      error: null,
      cleanup: { browserClosed: false, leaseReleased: false, workerExited: false, settled: false },
      createdAt,
      updatedAt: createdAt,
      startedAt: null,
      finishedAt: null,
      leaseOwner: `task:${id}`,
      leaseHeld: false,
      leaseGeneration: null
    };
    task.displayName = buildTaskDisplayName(task);
    appendTimeline(task, 'task.created', {
      actor: taskActor(caller),
      message: `Task ${task.taskType} queued`
    });
    beginAttemptHistory(task);
    tasks.set(id, task);
    await persist(task);
    await scheduleQueuedTasks();
    await awaitTaskPersistence(id);
    return publicRecord(task);
  }

  async function recoverDiagnosticsPointers(task) {
    const diagnostics = await readDiagnosticsPointers(task);
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

  async function sealAttemptCheckpoint(task, {
    allowDiskRecovery = false,
    expectedCheckpoint = task.checkpoint,
    checkpointKnownAbsent = false
  } = {}) {
    if (task.supportsResume !== true) return false;
    if (task.checkpointSeal?.attempt === task.attempt) return task.resumeCheckpointValid === true;
    let pointer = null;
    let checkpointError = null;
    try {
      if (checkpointKnownAbsent) {
        throw new TaskServiceError(
          'TASK_CHECKPOINT_REQUIRED',
          'Task attempt closed without a checkpoint',
          409
        );
      }
      const checkpointPath = path.join(root, task.id, 'checkpoint.json');
      const checkpointStats = await lstat(checkpointPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!checkpointStats) {
        throw new TaskServiceError(
          expectedCheckpoint ? 'TASK_CHECKPOINT_INVALID' : 'TASK_CHECKPOINT_REQUIRED',
          expectedCheckpoint
            ? 'Recorded task checkpoint is unavailable at terminal sealing'
            : 'Task attempt closed without a checkpoint',
          409
        );
      }
      const current = await inspectResumeCheckpoint(task);
      if (!allowDiskRecovery) {
        const expected = expectedCheckpoint;
        if (
          expected?.attempt !== task.attempt ||
          expected.savedAt !== current.savedAt ||
          expected.sha256 !== current.sha256 ||
          expected.sizeBytes !== current.sizeBytes
        ) {
          throw new TaskServiceError(
            'TASK_CHECKPOINT_INVALID',
            'Task checkpoint was not recorded before terminal sealing',
            409
          );
        }
      }
      const { source: _source, ...verifiedPointer } = current;
      pointer = verifiedPointer;
    } catch (error) {
      checkpointError = sanitizeError(error, 'TASK_CHECKPOINT_INVALID');
    }
    task.checkpoint = pointer;
    task.checkpointSeal = {
      attempt: task.attempt,
      sealedAt: nowIso(),
      status: pointer ? 'sealed' : 'unavailable'
    };
    task.resumeCheckpointValid = pointer !== null;
    task.resumeCheckpointError = pointer ? null : checkpointError;
    await update(task, {
      checkpoint: task.checkpoint,
      checkpointSeal: task.checkpointSeal,
      resumeCheckpointValid: task.resumeCheckpointValid,
      resumeCheckpointError: task.resumeCheckpointError
    });
    await awaitTaskPersistence(task.id);
    return task.resumeCheckpointValid;
  }

  async function refreshResumeCheckpointState(task) {
    if (
      task.supportsResume !== true || task.state !== 'failed' ||
      task.cleanup?.settled !== true
    ) {
      task.resumeCheckpointValid = false;
      // Terminal sealing happens before cleanup becomes observable as settled.
      // A concurrent read in that window must not erase the current attempt's
      // durable INVALID/REQUIRED classification and let finalization replace it
      // with a weaker absence error.
      if (!(task.state === 'failed' && task.checkpointSeal?.attempt === task.attempt)) {
        task.resumeCheckpointError = null;
      }
      return false;
    }
    try {
      if (task.checkpointSeal?.attempt !== task.attempt) {
        throw new TaskServiceError(
          'TASK_CHECKPOINT_INVALID',
          'Task checkpoint was not sealed at the Worker exit boundary',
          409
        );
      }
      if (task.checkpointSeal.status === 'unavailable') {
        const unexpected = await lstat(path.join(root, task.id, 'checkpoint.json')).catch((error) => {
          if (error?.code === 'ENOENT') return null;
          throw error;
        });
        if (unexpected) {
          throw new TaskServiceError(
            'TASK_CHECKPOINT_INVALID',
            'A checkpoint appeared after the attempt was sealed without one',
            409
          );
        }
        task.resumeCheckpointValid = false;
        task.resumeCheckpointError ||= {
          code: 'TASK_CHECKPOINT_REQUIRED',
          message: 'Task attempt closed without a checkpoint'
        };
        return false;
      }
      if (task.checkpointSeal.status !== 'sealed') {
        throw new TaskServiceError(
          'TASK_CHECKPOINT_INVALID',
          'Task checkpoint seal status is invalid',
          409
        );
      }
      await verifyResumeCheckpoint(task);
      task.resumeCheckpointValid = true;
      task.resumeCheckpointError = null;
      return true;
    } catch (error) {
      task.resumeCheckpointValid = false;
      task.resumeCheckpointError = sanitizeError(error, 'TASK_CHECKPOINT_INVALID');
      return false;
    }
  }

  async function resume(id, body = {}, caller = {}) {
    requireServiceOpen();
    return serializeTaskMutation(() => resumeSerialized(id, body, caller));
  }

  async function resumeSerialized(id, body = {}, suppliedCaller = {}) {
    await ready;
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || task.deletedAt || !isTaskOwner(task, caller)) {
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
    if (task.legacyPaidRuntime === true) {
      throw new TaskServiceError(
        'TASK_EXTERNAL_COST_UNSUPPORTED',
        'This task used the external-cost runtime removed in Task Master 2.8.0 and cannot be resumed.',
        409
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
    if (!task.checkpoint) {
      const sealedError = task.checkpointSeal?.attempt === task.attempt
        ? task.resumeCheckpointError
        : null;
      throw new TaskServiceError(
        sealedError?.code === 'TASK_CHECKPOINT_INVALID'
          ? 'TASK_CHECKPOINT_INVALID'
          : 'TASK_CHECKPOINT_REQUIRED',
        sealedError?.code === 'TASK_CHECKPOINT_INVALID'
          ? 'Task checkpoint failed terminal integrity verification'
          : 'Task has no checkpoint to resume',
        409
      );
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

    archiveAttemptDiagnostics(task);
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
    task.outputSealRequired = true;
    task.outputSeal = null;
    task.outputSealError = null;
    task.checkpoint = null;
    task.checkpointSeal = null;
    task.cleanup = { browserClosed: false, leaseReleased: false, workerExited: false, settled: false };
    task.startedAt = null;
    task.finishedAt = null;
    task.workerPid = null;
    task.leaseHeld = false;
    task.lastScreenshot = null;
    task.lastObservation = null;
    await rm(path.join(root, task.id, 'diagnostics.json'), { force: true });
    task.resumeCheckpointValid = false;
    task.resumeCheckpointError = null;
    task.resumeInput = resumeInput;
    task.progressAt = nowIso();
    task.health = { status: 'healthy', checkedAt: nowIso() };
    task.behavior = behavior;
    task.behaviorState = initialBehaviorState(behavior);
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
      .filter((task) => !task.deletedAt && canAccess(task, caller))
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
    if (!task || task.deletedAt || !canAccess(task, caller)) {
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

  function serializeControl(id, operation) {
    requireServiceOpen();
    const previous = controlChains.get(id) || Promise.resolve();
    const serialized = previous.catch(() => {}).then(operation);
    controlChains.set(id, serialized);
    return serialized.finally(() => {
      if (controlChains.get(id) === serialized) controlChains.delete(id);
    });
  }

  async function pauseTask(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      requireCoordinationBody(body, new Set(['commandId', 'expectedRevision']));
      const task = requireTaskAccess(id, caller);
      const payload = { target: 'paused' };
      const payloadHash = requestHash({ kind: 'pause', payload });
      if (existingCommand(task, body.commandId, payloadHash)) return readPublicRecord(task);
      if (!['queued', 'acquiring_profile', 'starting_browser', 'running', 'recovering'].includes(task.state)) {
        throw new TaskServiceError(
          'TASK_NOT_PAUSABLE',
          'Only queued or actively executing tasks can be paused; waiting and cooling tasks already have safe wait controls',
          409
        );
      }
      const queuedPause = task.state === 'queued';
      const entry = children.get(id);
      if (!queuedPause && !entry) {
        throw new TaskServiceError('TASK_WORKER_UNAVAILABLE', 'Task worker is unavailable for pause', 409);
      }
      const previousState = task.state;
      const { command } = addCommand(task, {
        commandId: body.commandId,
        kind: 'pause',
        expectedRevision: body.expectedRevision,
        actor: taskActor(caller),
        payload,
        status: queuedPause || previousState === 'paused' ? 'applied' : 'pending'
      });
      task.pauseContext = {
        previousState,
        requestedAt: nowIso(),
        commandId: command.commandId
      };
      task.state = 'paused';
      task.health = { status: 'paused', checkedAt: nowIso() };
      task.progress = { ...task.progress, message: queuedPause ? 'Queued task paused' : 'Pause requested' };
      if (!queuedPause && previousState !== 'paused') task.state = 'pause_requested';
      await update(task, {
        state: task.state,
        revision: task.revision,
        commands: task.commands,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence,
        pauseContext: task.pauseContext,
        progress: task.progress,
        health: task.health
      });
      if (task.state === 'pause_requested') {
        const delivered = await sendChildMessageConfirmed(entry.child, {
          type: 'pause',
          commandId: command.commandId
        });
        if (!delivered) {
          task.state = previousState;
          markCommandStatus(task, command.commandId, 'rejected', {
            message: 'Task worker did not accept the pause command'
          });
          await update(task, {
            state: task.state,
            commands: task.commands,
            timeline: task.timeline,
            timelineSequence: task.timelineSequence
          });
          throw new TaskServiceError('TASK_WORKER_UNAVAILABLE', 'Task worker is unavailable for pause', 409);
        }
        markCommandStatus(task, command.commandId, 'delivered');
        await update(task, {
          commands: task.commands,
          timeline: task.timeline,
          timelineSequence: task.timelineSequence
        });
      }
      return readPublicRecord(task);
    });
  }

  async function resumePausedTask(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      requireCoordinationBody(body, new Set(['commandId', 'expectedRevision']));
      const task = requireTaskAccess(id, caller);
      const payload = { target: 'running' };
      const payloadHash = requestHash({ kind: 'resume_pause', payload });
      if (existingCommand(task, body.commandId, payloadHash)) return readPublicRecord(task);
      if (!['paused', 'pause_requested'].includes(task.state)) {
        throw new TaskServiceError('TASK_NOT_PAUSED', 'Task is not paused or waiting to pause', 409);
      }
      const queuedPause = task.pauseContext?.previousState === 'queued' && !children.has(id);
      const entry = children.get(id);
      if (!queuedPause && !entry) {
        throw new TaskServiceError('TASK_WORKER_UNAVAILABLE', 'Task worker is unavailable for resume', 409);
      }
      const { command } = addCommand(task, {
        commandId: body.commandId,
        kind: 'resume_pause',
        expectedRevision: body.expectedRevision,
        actor: taskActor(caller),
        payload,
        status: queuedPause ? 'applied' : 'pending'
      });
      if (queuedPause) {
        task.state = 'queued';
        task.pauseContext = null;
        task.health = { status: 'healthy', checkedAt: nowIso() };
        task.progress = { ...task.progress, message: 'Queued task resumed' };
      } else {
        task.state = 'recovering';
        task.health = { status: 'healthy', checkedAt: nowIso() };
        task.progress = { ...task.progress, message: 'Revalidating live page before resume' };
      }
      await update(task, {
        state: task.state,
        revision: task.revision,
        commands: task.commands,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence,
        pauseContext: task.pauseContext,
        progress: task.progress,
        health: task.health
      });
      if (queuedPause) {
        await scheduleQueuedTasks();
      } else {
        const delivered = await sendChildMessageConfirmed(entry.child, {
          type: 'resume_pause',
          commandId: command.commandId
        });
        if (!delivered) {
          task.state = 'paused';
          markCommandStatus(task, command.commandId, 'rejected', {
            message: 'Task worker did not accept the resume command'
          });
          await update(task, {
            state: task.state,
            commands: task.commands,
            timeline: task.timeline,
            timelineSequence: task.timelineSequence
          });
          throw new TaskServiceError('TASK_WORKER_UNAVAILABLE', 'Task worker is unavailable for resume', 409);
        }
        markCommandStatus(task, command.commandId, 'delivered');
        await update(task, {
          commands: task.commands,
          timeline: task.timeline,
          timelineSequence: task.timelineSequence
        });
      }
      return readPublicRecord(task);
    });
  }

  async function submitTaskCommand(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      requireCoordinationBody(body, new Set(['commandId', 'expectedRevision', 'kind', 'message']));
      if (!AGENT_COMMAND_KINDS.has(body.kind)) {
        throw new TaskServiceError('INVALID_TASK_COMMAND', 'kind must be ask or modify');
      }
      const task = requireTaskAccess(id, caller);
      const message = boundedText(body.message, { field: 'message', maximum: 8_000 });
      const payload = { message };
      const payloadHash = requestHash({ kind: body.kind, payload });
      if (existingCommand(task, body.commandId, payloadHash)) return readPublicRecord(task);
      addCommand(task, {
        commandId: body.commandId,
        kind: body.kind,
        expectedRevision: body.expectedRevision,
        actor: taskActor(caller),
        payload,
        status: 'pending'
      });
      await update(task, {
        revision: task.revision,
        commands: task.commands,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence
      });
      return readPublicRecord(task);
    });
  }

  async function claimTaskCommands(id, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    const task = requireTaskAccess(id, caller, { ownerOnly: true });
    const actor = taskActor(caller);
    let changed = false;
    const commands = task.commands.filter((command) => (
      AGENT_COMMAND_KINDS.has(command.kind) && ['pending', 'delivered', 'acknowledged'].includes(command.status)
    ));
    for (const command of commands) {
      if (command.status !== 'pending') continue;
      markCommandStatus(task, command.commandId, 'delivered', { actor });
      changed = true;
    }
    if (changed) {
      await update(task, {
        commands: task.commands,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence
      });
    }
    return { taskId: task.id, revision: task.revision, commands: commands.map(publicCommand) };
  }

  async function claimAgentInbox({ limit = 100 } = {}, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'agent') {
      throw new TaskServiceError('AGENT_INBOX_FORBIDDEN', 'Only a scoped Agent can claim its inbox', 403);
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new TaskServiceError('INVALID_AGENT_INBOX_LIMIT', 'Inbox limit must be from 1 to 200');
    }
    const records = [];
    const changedTasks = new Set();
    const owned = [...tasks.values()]
      .filter((task) => !task.deletedAt && isTaskOwner(task, caller))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const task of owned) {
      normalizeTaskCoordination(task);
      for (const command of task.commands) {
        if (records.length >= limit) break;
        if (!AGENT_COMMAND_KINDS.has(command.kind) || !['pending', 'delivered', 'acknowledged'].includes(command.status)) {
          continue;
        }
        if (command.status === 'pending') {
          markCommandStatus(task, command.commandId, 'delivered', { actor: taskActor(caller) });
          changedTasks.add(task);
        }
        records.push({ taskId: task.id, revision: task.revision, command: publicCommand(command) });
      }
      if (records.length >= limit) break;
    }
    await Promise.all([...changedTasks].map((task) => update(task, {
      commands: task.commands,
      timeline: task.timeline,
      timelineSequence: task.timelineSequence
    })));
    return { commands: records, total: records.length };
  }

  async function getTaskTimeline(id, { afterSequence = 0, limit = 100 } = {}, suppliedCaller = {}) {
    await ready;
    const caller = callerIdentity(suppliedCaller);
    const task = requireTaskAccess(id, caller);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new TaskServiceError('INVALID_TASK_TIMELINE_CURSOR', 'afterSequence must be a non-negative integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new TaskServiceError('INVALID_TASK_TIMELINE_LIMIT', 'Timeline limit must be from 1 to 200');
    }
    const events = task.timeline.filter((event) => event.sequence > afterSequence).slice(0, limit);
    return {
      taskId: task.id,
      revision: task.revision,
      events: clone(events),
      nextSequence: events.at(-1)?.sequence ?? afterSequence
    };
  }

  async function respondTaskCommand(id, commandId, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      const task = requireTaskAccess(id, caller, { ownerOnly: true });
      if (typeof commandId !== 'string' || !COMMAND_ID_PATTERN.test(commandId)) {
        throw new TaskServiceError('INVALID_TASK_COMMAND', 'commandId is invalid');
      }
      const allowed = new Set(['expectedRevision', 'status', 'message']);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) {
        throw new TaskServiceError('INVALID_TASK_COMMAND', 'Command response fields are invalid');
      }
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
        throw new TaskServiceError('INVALID_TASK_COMMAND', 'expectedRevision must be a positive integer');
      }
      if (!['acknowledged', 'applied', 'rejected'].includes(body.status)) {
        throw new TaskServiceError('INVALID_TASK_COMMAND', 'status must be acknowledged, applied, or rejected');
      }
      const command = task.commands.find((entry) => entry.commandId === commandId);
      if (!command || !AGENT_COMMAND_KINDS.has(command.kind)) {
        throw new TaskServiceError('TASK_COMMAND_NOT_FOUND', 'Task command was not found', 404);
      }
      if (command.status === body.status) return { task: await readPublicRecord(task), command: publicCommand(command) };
      requireTaskRevision(task, body.expectedRevision);
      const message = body.message === undefined
        ? ''
        : boundedText(body.message, { field: 'message', maximum: 8_000, required: false });
      markCommandStatus(task, commandId, body.status, { actor: taskActor(caller), message });
      task.revision += 1;
      await update(task, {
        revision: task.revision,
        commands: task.commands,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence
      });
      return { task: await readPublicRecord(task), command: publicCommand(command) };
    });
  }

  async function reviseQueuedTask(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      requireCoordinationBody(body, new Set(['commandId', 'expectedRevision', 'input']));
      const task = requireTaskAccess(id, caller);
      const payload = { input: clone(body.input ?? {}) };
      const commandPayload = { inputHash: requestHash(payload.input) };
      const payloadHash = requestHash({ kind: 'revise_input', payload: commandPayload });
      if (existingCommand(task, body.commandId, payloadHash)) return readPublicRecord(task);
      const queuedRevision = task.state === 'queued' || (
        task.state === 'paused' && task.pauseContext?.previousState === 'queued' && !children.has(task.id)
      );
      if (!queuedRevision) {
        throw new TaskServiceError(
          'TASK_INPUT_IMMUTABLE',
          'Running or completed task input is immutable; submit a modify command for Agent replanning',
          409
        );
      }
      const taskType = await registry.resolve(task.taskType);
      validateTaskInput(payload.input, taskType.inputSchema);
      addCommand(task, {
        commandId: body.commandId,
        kind: 'revise_input',
        expectedRevision: body.expectedRevision,
        actor: taskActor(caller),
        payload: commandPayload,
        status: 'applied'
      });
      task.input = payload.input;
      task.inputRevisionHash = requestHash(task.input);
      task.progress = { ...task.progress, message: `Queued task input revised at revision ${task.revision}` };
      await update(task, {
        input: task.input,
        inputRevisionHash: task.inputRevisionHash,
        revision: task.revision,
        commands: task.commands,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence,
        progress: task.progress
      });
      return readPublicRecord(task);
    });
  }

  async function publishTaskReport(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      const task = requireTaskAccess(id, caller);
      const allowed = new Set(['reportId', 'expectedRevision', 'status', 'title', 'summary', 'sections']);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.has(key))) {
        throw new TaskServiceError('INVALID_TASK_REPORT', 'Report fields are invalid');
      }
      if (typeof body.reportId !== 'string' || !REPORT_ID_PATTERN.test(body.reportId)) {
        throw new TaskServiceError('INVALID_TASK_REPORT', 'reportId is invalid');
      }
      if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
        throw new TaskServiceError('INVALID_TASK_REPORT', 'expectedRevision must be a positive integer');
      }
      if (!['draft', 'final'].includes(body.status)) {
        throw new TaskServiceError('INVALID_TASK_REPORT', 'status must be draft or final');
      }
      const title = boundedText(body.title, { field: 'title', maximum: 200 });
      const summary = boundedText(body.summary, { field: 'summary', maximum: 20_000 });
      if (!Array.isArray(body.sections) || body.sections.length > 24) {
        throw new TaskServiceError('INVALID_TASK_REPORT', 'sections must contain at most 24 entries');
      }
      const sections = body.sections.map((section, index) => {
        if (!section || typeof section !== 'object' || Array.isArray(section) ||
          Object.keys(section).some((key) => !['heading', 'body'].includes(key))) {
          throw new TaskServiceError('INVALID_TASK_REPORT', `sections[${index}] is invalid`);
        }
        return {
          heading: boundedText(section.heading, { field: `sections[${index}].heading`, maximum: 200 }),
          body: boundedText(section.body, { field: `sections[${index}].body`, maximum: 20_000 })
        };
      });
      const reportHash = requestHash({ status: body.status, title, summary, sections });
      const existing = task.reports.find((report) => report.reportId === body.reportId);
      if (existing) {
        if (existing.reportHash !== reportHash) {
          throw new TaskServiceError('TASK_REPORT_ID_CONFLICT', 'reportId is already bound to different content', 409);
        }
        return readPublicRecord(task);
      }
      requireTaskRevision(task, body.expectedRevision);
      const report = {
        reportId: body.reportId,
        reportHash,
        status: body.status,
        title,
        summary,
        sections,
        author: taskActor(caller),
        publishedAt: nowIso()
      };
      task.reports.push(report);
      task.reports = task.reports.slice(-20);
      task.report = report;
      task.revision += 1;
      appendTimeline(task, 'report.published', {
        actor: taskActor(caller),
        status: body.status,
        message: title
      });
      await update(task, {
        revision: task.revision,
        reports: task.reports,
        report: task.report,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence
      });
      return readPublicRecord(task);
    });
  }

  async function requestCancellation(task, { commandId = null, actor = null } = {}) {
    task.cancelRequestedAt ||= nowIso();
    if (commandId) task.cancelCommandId = commandId;
    appendTimeline(task, 'task.cancel_requested', {
      actor,
      commandId,
      status: 'pending',
      message: 'Cancellation requested; waiting for cleanup proof'
    });
    await update(task, {
      state: 'cancel_requested',
      cancelRequestedAt: task.cancelRequestedAt,
      cancelCommandId: task.cancelCommandId,
      health: { status: 'cancel_requested', checkedAt: nowIso() },
      progress: { ...task.progress, message: 'Cancellation requested; confirming cleanup' },
      timeline: task.timeline,
      timelineSequence: task.timelineSequence
    });
    const entry = children.get(task.id);
    if (entry) {
      send(entry.child, { type: 'cancel' });
      scheduleForcedStop(task, entry);
    } else {
      task.cleanup.browserClosed = true;
      task.cleanup.workerExited = true;
      await releaseTaskLease(task);
      refreshCleanupSettled(task);
      if (task.cleanup.settled === true) {
        task.state = 'cancelled';
        task.error = null;
        task.finishedAt = nowIso();
        task.progress = terminalProgress(task, 'cancelled');
        task.health = { status: 'cancelled', checkedAt: nowIso() };
        if (commandId) markCommandStatus(task, commandId, 'applied', {
          actor,
          message: 'Queued task cancelled before browser startup'
        });
      } else {
        task.state = 'failed';
        task.error = {
          code: 'TASK_CANCEL_CLEANUP_UNCONFIRMED',
          message: 'Cancellation was requested but cleanup could not be confirmed'
        };
      }
      finishAttemptHistory(task);
      await update(task, {
        state: task.state,
        error: task.error,
        finishedAt: task.finishedAt,
        progress: task.progress,
        health: task.health,
        cleanup: task.cleanup,
        history: task.history,
        commands: task.commands,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence
      });
    }
    void scheduleQueuedTasks().catch(() => {});
    return readPublicRecord(task);
  }

  async function terminateTask(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      requireCoordinationBody(body, new Set(['commandId', 'expectedRevision']));
      const task = requireTaskAccess(id, caller);
      const payload = { target: 'cancelled' };
      const payloadHash = requestHash({ kind: 'terminate', payload });
      if (existingCommand(task, body.commandId, payloadHash)) return readPublicRecord(task);
      if (TERMINAL_TASK_STATES.has(task.state)) {
        throw new TaskServiceError('TASK_ALREADY_TERMINAL', 'Task is already terminal', 409);
      }
      if (task.cancelRequestedAt) {
        throw new TaskServiceError('TASK_CANCEL_ALREADY_REQUESTED', 'Task cancellation is already in progress', 409);
      }
      addCommand(task, {
        commandId: body.commandId,
        kind: 'terminate',
        expectedRevision: body.expectedRevision,
        actor: taskActor(caller),
        payload,
        status: 'pending'
      });
      await update(task, {
        revision: task.revision,
        commands: task.commands,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence
      });
      return requestCancellation(task, { commandId: body.commandId, actor: taskActor(caller) });
    });
  }

  async function deleteTask(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      if (caller.role !== 'manager-admin') {
        throw new TaskServiceError('TASK_DELETE_FORBIDDEN', 'Only the Owner Dashboard can delete task records', 403);
      }
      requireCoordinationBody(body, new Set(['commandId', 'expectedRevision']));
      const task = tasks.get(id);
      if (!task || task.deletedAt) {
        throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
      }
      requireTaskRevision(task, body.expectedRevision);
      if (
        !TERMINAL_TASK_STATES.has(task.state) || task.cleanup?.settled !== true ||
        children.has(task.id) || task.leaseHeld === true || finalizationFailures.has(task.id)
      ) {
        throw new TaskServiceError(
          'TASK_DELETE_NOT_READY',
          'Only terminal task records with confirmed browser and Profile cleanup can be deleted',
          409
        );
      }
      task.deletedAt = nowIso();
      task.deletedBy = { role: caller.role, clientId: caller.clientId };
      task.revision += 1;
      task.updatedAt = task.deletedAt;
      await persist(task);
      await awaitTaskPersistence(task.id);
      return { id: task.id, deletedAt: task.deletedAt };
    });
  }

  async function cancel(id, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      const caller = callerIdentity(suppliedCaller);
      const task = requireTaskAccess(id, caller);
      if (TERMINAL_TASK_STATES.has(task.state)) return readPublicRecord(task);
      if (task.cancelRequestedAt) return readPublicRecord(task);
      return requestCancellation(task, { actor: taskActor(caller) });
    });
  }

  async function claimUserRequest(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, async () => {
      await ready;
      requireServiceOpen();
      const caller = callerIdentity(suppliedCaller);
      const task = requireTaskAccess(id, caller);
      const unknown = Object.keys(body).filter((key) => key !== 'requestId');
      if (unknown.length) {
        throw new TaskServiceError('INVALID_USER_REQUEST_CLAIM', `Unsupported claim fields: ${unknown.join(', ')}`);
      }
      if (typeof body.requestId !== 'string' || !HANDOFF_ID_PATTERN.test(body.requestId)) {
        throw new TaskServiceError('INVALID_USER_REQUEST_CLAIM', 'requestId must identify the live handoff request');
      }
      if (task.state !== 'waiting_user' || !['pending', 'claimed'].includes(task.userRequest?.status)) {
        throw new TaskServiceError('TASK_NOT_WAITING_USER', 'Task has no claimable user request', 409);
      }
      if (body.requestId !== task.userRequest.id) {
        throw new TaskServiceError('USER_HANDOFF_MISMATCH', 'Handoff request ID does not match the live task', 409);
      }
      if (task.userRequest.kind === 'human_verification' && caller.role !== 'manager-admin') {
        throw new TaskServiceError(
          'USER_HANDOFF_CLAIM_FORBIDDEN',
          'Only the Owner Dashboard can claim a human-verification handoff',
          403
        );
      }
      if (task.userRequest.status === 'claimed') return readPublicRecord(task);
      task.userRequest = {
        ...task.userRequest,
        status: 'claimed',
        claimedAt: nowIso()
      };
      appendTimeline(task, 'user_request.claimed', {
        actor: taskActor(caller),
        message: `User request ${task.userRequest.id} claimed`
      });
      await update(task, {
        userRequest: task.userRequest,
        timeline: task.timeline,
        timelineSequence: task.timelineSequence
      });
      return publicRecord(task);
    });
  }

  async function continueTask(id, body = {}, suppliedCaller = {}) {
    return serializeControl(id, () => continueTaskSerialized(id, body, suppliedCaller));
  }

  async function continueTaskSerialized(id, body = {}, suppliedCaller = {}) {
    await ready;
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    const task = tasks.get(id);
    if (!task || task.deletedAt || !canAccess(task, caller)) {
      throw new TaskServiceError('TASK_NOT_FOUND', `Task ${id} was not found`, 404);
    }
    const allowed = new Set(['requestId', 'note']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new TaskServiceError('INVALID_TASK_CONTINUE', `Unsupported continue fields: ${unknown.join(', ')}`);
    }
    if (task.state !== 'waiting_user' || !['pending', 'claimed'].includes(task.userRequest?.status)) {
      throw new TaskServiceError('TASK_NOT_WAITING_USER', 'Task is not waiting for a new instruction', 409);
    }
    if (task.userRequest.kind === 'human_verification' && task.userRequest.status !== 'claimed') {
      throw new TaskServiceError(
        'USER_HANDOFF_OWNER_CLAIM_REQUIRED',
        'The Owner must claim the live human-verification request before this task can continue',
        409
      );
    }
    const requestId = body.requestId || task.userRequest.id;
    if (!HANDOFF_ID_PATTERN.test(requestId) || requestId !== task.userRequest.id) {
      throw new TaskServiceError('USER_HANDOFF_MISMATCH', 'Handoff request ID does not match the live task', 409);
    }
    if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2_000)) {
      throw new TaskServiceError('INVALID_TASK_CONTINUE', 'note must contain at most 2000 characters');
    }
    const entry = children.get(id);
    if (!entry?.attached || entry.finalized || !entry.child?.connected) {
      throw new TaskServiceError('TASK_WORKER_UNAVAILABLE', 'Task worker is unavailable for continuation', 409);
    }
    let resolveReceipt;
    let rejectReceipt;
    const receipt = new Promise((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    receipt.catch(() => {});
    const timer = setTimeout(() => {
      entry.continueRequests.delete(requestId);
      rejectReceipt(new TaskServiceError(
        'USER_HANDOFF_CONTINUE_TIMEOUT',
        'Task Worker did not confirm the user handoff in time',
        504
      ));
    }, handoffContinueTimeoutMs);
    entry.continueRequests.set(requestId, { timer, resolve: resolveReceipt, reject: rejectReceipt });
    void sendChildMessageConfirmed(entry.child, {
      type: 'continue', requestId, note: body.note || ''
    }).then((delivered) => {
      if (delivered) return;
      entry.continueRequests.delete(requestId);
      clearTimeout(timer);
      rejectReceipt(new TaskServiceError(
        'TASK_WORKER_UNAVAILABLE',
        'Task Worker did not accept the user handoff command',
        503
      ));
    });
    await receipt;
    task.userRequest = {
      ...task.userRequest,
      status: 'continued',
      continuedAt: nowIso(),
      ...(body.note?.trim() ? { note: redactSensitiveText(body.note).slice(0, 2_000) } : {})
    };
    const workerAdvanced = task.state !== 'waiting_user';
    await update(task, {
      state: workerAdvanced ? task.state : 'recovering',
      userRequest: task.userRequest,
      ...(workerAdvanced ? {} : {
        progress: { ...task.progress, message: 'New instruction received; verifying live page state' },
        progressAt: nowIso(),
        health: { status: 'healthy', checkedAt: nowIso() }
      })
    });
    return publicRecord(task);
  }

  async function sendLiveBehavior(task, entry, behavior) {
    const requestId = `behavior_${randomUUID().replaceAll('-', '')}`;
    let resolveReceipt;
    let rejectReceipt;
    const receipt = new Promise((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    // The caller always awaits this promise, but keep the rejection observed
    // while child.send confirmation is still pending.
    receipt.catch(() => {});
    const timer = setTimeout(() => {
      entry.behaviorRequests.delete(requestId);
      rejectReceipt(new TaskServiceError(
        'BEHAVIOR_LIVE_APPLY_TIMEOUT',
        'Task Worker did not confirm the live behavior change in time',
        504
      ));
    }, behaviorApplyTimeoutMs);
    entry.behaviorRequests.set(requestId, {
      behavior,
      timer,
      resolve: resolveReceipt,
      reject: rejectReceipt
    });
    // A Worker receipt is stronger evidence than the child.send callback and
    // may arrive first. Start delivery confirmation without blocking the
    // bounded receipt deadline; a wedged IPC callback must not hang this API.
    void sendChildMessageConfirmed(entry.child, {
      type: 'set_behavior',
      requestId,
      behavior
    }).then((delivered) => {
      if (delivered) return;
      entry.behaviorRequests.delete(requestId);
      clearTimeout(timer);
      rejectReceipt(new TaskServiceError(
        'BEHAVIOR_LIVE_APPLY_UNCONFIRMED',
        'Task Worker did not accept the live behavior command',
        503
      ));
    });
    return receipt;
  }

  async function focusTask(id, suppliedCaller = {}) {
    await ready;
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    const task = requireTaskAccess(id, caller);
    if (TERMINAL_TASK_STATES.has(task.state)) {
      throw new TaskServiceError('TASK_FOCUS_UNAVAILABLE', 'Terminal tasks have no live browser page to focus', 409);
    }
    const entry = children.get(task.id);
    if (!entry?.attached || entry.finalized || !entry.child?.connected) {
      throw new TaskServiceError('TASK_FOCUS_UNAVAILABLE', 'Task Worker has no live browser page to focus', 409);
    }
    const requestId = `focus_${randomUUID().replaceAll('-', '')}`;
    let resolveReceipt;
    let rejectReceipt;
    const receipt = new Promise((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    receipt.catch(() => {});
    const timer = setTimeout(() => {
      entry.focusRequests.delete(requestId);
      rejectReceipt(new TaskServiceError(
        'TASK_FOCUS_TIMEOUT',
        'Task Worker did not confirm browser focus in time',
        504
      ));
    }, FOCUS_APPLY_TIMEOUT_MS);
    entry.focusRequests.set(requestId, { timer, resolve: resolveReceipt, reject: rejectReceipt });
    void sendChildMessageConfirmed(entry.child, { type: 'focus', requestId }).then((delivered) => {
      if (delivered) return;
      entry.focusRequests.delete(requestId);
      clearTimeout(timer);
      rejectReceipt(new TaskServiceError(
        'TASK_FOCUS_UNAVAILABLE',
        'Task Worker did not accept the browser focus command',
        503
      ));
    });
    const focusedAt = await receipt;
    return { task: await readPublicRecord(task), focusedAt };
  }

  async function forceReleaseProfileLease(profileId, body = {}, suppliedCaller = {}) {
    await ready;
    requireServiceOpen();
    const caller = callerIdentity(suppliedCaller);
    if (caller.role !== 'manager-admin') {
      throw new TaskServiceError(
        'PROFILE_FORCE_RELEASE_FORBIDDEN',
        'Only the Owner can force-release a quarantined Profile lease',
        403
      );
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TaskServiceError('INVALID_PROFILE_FORCE_RELEASE', 'Force release request must be an object');
    }
    const allowed = new Set(['confirm', 'commandId', 'expectedUpdatedAt']);
    const unknown = Object.keys(body).filter((key) => !allowed.has(key));
    if (unknown.length) {
      throw new TaskServiceError(
        'INVALID_PROFILE_FORCE_RELEASE',
        `Unsupported force release fields: ${unknown.join(', ')}`
      );
    }
    if (body.confirm !== true) {
      throw new TaskServiceError(
        'PROFILE_FORCE_RELEASE_CONFIRMATION_REQUIRED',
        'Owner confirmation is required before a Profile lease can be force-released',
        409
      );
    }
    if (typeof body.commandId !== 'string' || !COMMAND_ID_PATTERN.test(body.commandId)) {
      throw new TaskServiceError(
        'INVALID_PROFILE_FORCE_RELEASE',
        'commandId must contain 8-128 letters, numbers, dots, underscores, colons, or hyphens'
      );
    }
    if (typeof body.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(body.expectedUpdatedAt))) {
      throw new TaskServiceError(
        'INVALID_PROFILE_FORCE_RELEASE',
        'expectedUpdatedAt must identify the Profile state shown to the Owner'
      );
    }
    if (typeof profileStore.forceReleaseLease !== 'function') {
      throw new TaskServiceError(
        'PROFILE_FORCE_RELEASE_UNAVAILABLE',
        'The Profile store does not support force release',
        501
      );
    }

    return serializeTaskMutation(async () => {
      let profile = await reconcileAnyCleanup(await profileStore.get(profileId));
      const replayAudit = profile.lastForcedLeaseRelease?.commandId === body.commandId
        ? profile.lastForcedLeaseRelease
        : null;
      const lease = profile.lease;
      const ownerId = lease?.ownerId || replayAudit?.ownerId || '';
      const taskId = /^task:(task_[a-f0-9]{32})$/u.exec(ownerId)?.[1] ?? replayAudit?.taskId ?? null;
      const task = taskId ? tasks.get(taskId) : null;

      if (!replayAudit) {
        if (
          profile.kind !== 'persistent' || profile.state !== 'error' ||
          lease?.cleanupRequired !== true || typeof profile.cleanupUnknownAt !== 'string'
        ) {
          throw new TaskServiceError(
            'PROFILE_FORCE_RELEASE_NOT_ALLOWED',
            'Only a cleanup-blocked persistent Profile can be force-released',
            409
          );
        }
        const recognizedOwner = taskId || /^profile-open:/u.test(ownerId) || /^session-import:/u.test(ownerId);
        if (!recognizedOwner) {
          throw new TaskServiceError(
            'PROFILE_FORCE_RELEASE_OWNER_UNKNOWN',
            'The quarantined lease owner is not a recognized Task Master runtime',
            409
          );
        }
        if (task && !TERMINAL_TASK_STATES.has(task.state)) {
          throw new TaskServiceError(
            'PROFILE_FORCE_RELEASE_TASK_ACTIVE',
            'Terminate the active task before force-releasing its Profile lease',
            409
          );
        }
        const leaseProcessAlive = Number.isSafeInteger(lease?.pid) && lease.pid > 0
          ? await processAlive(lease.pid)
          : false;
        if ((taskId && children.has(taskId)) || isKnownLiveLease(profileId, ownerId) || leaseProcessAlive) {
          throw new TaskServiceError(
            'PROFILE_FORCE_RELEASE_OWNER_ACTIVE',
            'The lease owner may still be alive; close or terminate it before force release',
            409
          );
        }
      }

      const released = await profileStore.forceReleaseLease(profileId, replayAudit ? {
        commandId: body.commandId,
        expectedOwnerId: replayAudit.ownerId,
        expectedGeneration: replayAudit.revokedGeneration,
        expectedUpdatedAt: body.expectedUpdatedAt
      } : {
        commandId: body.commandId,
        expectedOwnerId: lease.ownerId,
        expectedGeneration: lease.generation,
        expectedUpdatedAt: body.expectedUpdatedAt
      });
      profile = released.profile;

      if (task && task.cleanup?.forceReleaseCommandId !== body.commandId) {
        task.leaseHeld = false;
        task.cleanup = {
          ...(task.cleanup || {}),
          leaseReleased: true,
          settled: false,
          ownerForceReleased: true,
          ownerForceReleasedAt: released.audit.releasedAt,
          forceReleaseCommandId: body.commandId,
          revokedLeaseGeneration: released.audit.revokedGeneration,
          leaseFenceGeneration: released.audit.fenceGeneration
        };
        delete task.cleanup.leaseReleaseError;
        task.revision = (Number.isSafeInteger(task.revision) ? task.revision : 1) + 1;
        task.updatedAt = nowIso();
        appendTimeline(task, 'profile.lease.force_released', {
          actor: taskActor(caller),
          message: 'Owner force-released the quarantined Profile lease; browser cleanup remains unconfirmed'
        });
        await persist(task);
      }
      if (task) finalizationFailures.delete(task.id);
      void scheduleQueuedTasks().catch(() => {});
      return {
        profile: structuredClone(profile),
        ...(taskId ? { taskId } : {}),
        idempotent: released.idempotent === true
      };
    });
  }

  async function applyProfileBehavior(profileId, requestedBehavior) {
    await ready;
    requireServiceOpen();
    if (!isBehaviorMode(requestedBehavior)) {
      throw new TaskServiceError(
        'INVALID_PROFILE_BEHAVIOR',
        'Profile behavior must be fast, auto, or human'
      );
    }
    const previous = behaviorApplyChains.get(profileId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      // Re-read after entering the per-Profile lane. Concurrent callers are
      // last-write-wins and can never apply an older mode after a newer one.
      const profile = await profileStore.get(profileId);
      const behavior = resolveProfileBehavior(profile);
      const affected = [...tasks.values()].filter((task) => (
        !task.deletedAt && task.profileId === profileId && !TERMINAL_TASK_STATES.has(task.state)
      ));
      const appliedTaskIds = [];
      let activeApplied = 0;
      for (const task of affected) {
        const entry = children.get(task.id);
        let state = initialBehaviorState(behavior);
        if (entry?.attached && !entry.finalized) {
          try {
            state = await sendLiveBehavior(task, entry, behavior);
            activeApplied += 1;
          } catch (error) {
            if (!TERMINAL_TASK_STATES.has(task.state)) {
              await update(task, {
                state: 'failed',
                error: sanitizeError(error, 'BEHAVIOR_LIVE_APPLY_UNCONFIRMED'),
                finishedAt: nowIso(),
                progress: terminalProgress(task, 'failed'),
                health: { status: 'failed', checkedAt: nowIso() }
              });
              send(entry.child, { type: 'cancel' });
              scheduleForcedStop(task, entry);
            }
            throw error;
          }
        }
        task.behavior = behavior;
        task.behaviorState = state;
        appendTimeline(task, 'profile.behavior.changed', {
          message: `Profile behavior changed live to ${behavior}`
        });
        await update(task, {
          behavior,
          behaviorState: state,
          timeline: task.timeline,
          timelineSequence: task.timelineSequence
        });
        appliedTaskIds.push(task.id);
      }
      return {
        profileId,
        behavior,
        activeApplied,
        taskIds: appliedTaskIds
      };
    });
    behaviorApplyChains.set(profileId, operation);
    try {
      return await operation;
    } finally {
      if (behaviorApplyChains.get(profileId) === operation) behaviorApplyChains.delete(profileId);
    }
  }

  async function interruptTaskForShutdown(task) {
    const safelyPausedQueued = task.state === 'paused' && task.pauseContext?.previousState === 'queued' &&
      !task.startedAt && !task.workerPid && task.leaseHeld !== true;
    if (task.state === 'queued' || safelyPausedQueued || TERMINAL_TASK_STATES.has(task.state)) return;
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
      await Promise.allSettled([...controlChains.values()]);
      await Promise.allSettled([...behaviorApplyChains.values()]);
      const exitingWorkers = [...children.values()].map((entry) => entry.exitPromise);
      const shutdownResults = await Promise.allSettled([
        ...[...tasks.values()]
          .filter((task) => task.state !== 'queued' && !TERMINAL_TASK_STATES.has(task.state))
          .map((task) => interruptTaskForShutdown(task)),
        closeAllProfiles()
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
        if (task) await markCleanupUnknown(task.profileId, task.leaseOwner, task.leaseGeneration);
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
      const historicalQuarantineOwners = new Set(profiles.filter((profile) => (
        profile.state === 'error' &&
        profile.lease?.cleanupRequired === true &&
        startupQuarantineOwners.has(profile.lease.ownerId) &&
        /^(?:task:|profile-open:|session-import:)/u.test(profile.lease.ownerId || '')
      )).map((profile) => profile.lease.ownerId));
      const cleanupUnconfirmed = profiles.some((profile) => {
        if (historicalQuarantineOwners.has(profile.lease?.ownerId)) return false;
        return profile.state === 'error' || profile.lease?.cleanupRequired === true;
      });
      const taskCleanupUnconfirmed = [...tasks.values()].some((task) => (
        !(
          TERMINAL_TASK_STATES.has(task.state) &&
          (
            historicalQuarantineOwners.has(task.leaseOwner) ||
            (task.cleanup?.ownerForceReleased === true && task.leaseHeld !== true)
          )
        ) && (
          task.leaseHeld === true ||
          (TERMINAL_TASK_STATES.has(task.state) && task.startedAt && task.cleanup?.settled !== true)
        )
      ));
      if (
        shutdownResults.some((result) => result.status === 'rejected') ||
        children.size > 0 ||
        hasOpenProfiles() ||
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
    const visible = [...tasks.values()].filter((task) => !task.deletedAt);
    return {
      active: children.size,
      queued: queuedTasks().length,
      paused: visible.filter((task) => task.state === 'paused').length,
      pauseRequested: visible.filter((task) => task.state === 'pause_requested').length,
      cancelRequested: visible.filter((task) => task.state === 'cancel_requested').length,
      waitingUser: visible.filter((task) => task.state === 'waiting_user').length,
      stalled: visible.filter((task) => task.health?.status === 'stalled').length,
      maxConcurrent: maxConcurrentTasks,
      maxQueued: maxQueuedTasks
    };
  }

  async function listHumanVerificationRequests(suppliedCaller = {}) {
    await ready;
    callerIdentity(suppliedCaller);
    return [...tasks.values()]
      .filter((task) => (
        !task.deletedAt && task.state === 'waiting_user' &&
        task.userRequest?.kind === 'human_verification' &&
        ['pending', 'claimed'].includes(task.userRequest?.status)
      ))
      .map((task) => ({
        id: task.id,
        state: task.state,
        userRequest: {
          id: task.userRequest.id,
          kind: 'human_verification',
          status: task.userRequest.status
        }
      }));
  }

  return Object.freeze({
    schedulerStatus,
    listHumanVerificationRequests,
    list,
    create,
    get,
    getInternal,
    listArtifacts,
    readArtifact,
    cancel,
    terminateTask,
    deleteTask,
    pauseTask,
    resumePausedTask,
    submitTaskCommand,
    claimTaskCommands,
    claimAgentInbox,
    respondTaskCommand,
    getTaskTimeline,
    reviseQueuedTask,
    publishTaskReport,
    claimUserRequest,
    continueTask,
    focusTask,
    resume,
    installTaskType,
    installTaskPack,
    listTaskTypes,
    describeTaskType,
    deprecateTaskType,
    restoreTaskType,
    listTaskPacks,
    listTaskAssets,
    applyTaskAssetAction,
    applyProfileBehavior,
    forceReleaseProfileLease,
    openProfile,
    closeProfile,
    close
  });
}
