import { redactSensitiveText, redactSensitiveValue } from './lib/redaction.mjs';

export const VERSION = '3.1.2';
export const API_VERSION = 3;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 19946;
export const PROFILE_LAUNCH_TIMEOUT_MS = 60_000;
export const PROFILE_OPEN_TIMEOUT_MS = 75_000;
export const PROFILE_ACTION_TIMEOUT_MS = 100_000;

export const TASK_STATES = Object.freeze([
  'queued',
  'running',
  'waiting',
  'stopping',
  'finished',
  'stopped',
  'error'
]);
export const TERMINAL_TASK_STATES = new Set(['finished', 'stopped', 'error']);
export const PROFILE_STATES = Object.freeze(['idle', 'open', 'leased', 'deleting', 'error']);

export function isTerminalTask(task) {
  return TERMINAL_TASK_STATES.has(task?.state);
}

export function publicProfile(profile, defaultProfileId = null) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    id: profile.id,
    name: profile.name,
    state: PROFILE_STATES.includes(profile.state) ? profile.state : 'error',
    isDefault: profile.id === defaultProfileId,
    createdAt: profile.createdAt ?? null,
    updatedAt: profile.updatedAt ?? null,
    lastUsedAt: profile.lastUsedAt ?? null,
    ...(profile.lease ? {
      lease: {
        kind: profile.lease.kind,
        taskId: profile.lease.taskId ?? null,
        acquiredAt: profile.lease.acquiredAt,
        heartbeatAt: profile.lease.heartbeatAt,
        expiresAt: profile.lease.expiresAt
      }
    } : {})
  };
}

function publicProgress(progress) {
  if (!progress || typeof progress !== 'object') {
    return { current: 0, total: null, message: '' };
  }
  return {
    current: Number.isFinite(progress.current) ? Math.max(0, progress.current) : 0,
    total: Number.isFinite(progress.total) ? Math.max(0, progress.total) : null,
    message: redactSensitiveText(String(progress.message ?? '')).slice(0, 1_000),
    ...(typeof progress.phase === 'string' ? { phase: progress.phase.slice(0, 64) } : {})
  };
}

export function publicTask(task) {
  if (!task || typeof task !== 'object') return null;
  const end = Date.parse(task.finishedAt ?? '') || Date.now();
  const start = Date.parse(task.startedAt ?? task.createdAt ?? '');
  return {
    id: task.id,
    label: redactSensitiveText(String(task.label ?? 'task')).slice(0, 160),
    title: redactSensitiveText(String(task.label ?? 'task')).slice(0, 160),
    profileId: task.profileId,
    profileName: task.profileName ?? null,
    moduleName: task.moduleName ?? null,
    outputBudget: task.outputBudget && typeof task.outputBudget === 'object'
      ? redactSensitiveValue(task.outputBudget)
      : {},
    state: TASK_STATES.includes(task.state) ? task.state : 'error',
    progress: publicProgress(task.progress),
    waiting: task.waiting ? redactSensitiveValue(task.waiting) : null,
    result: task.result === undefined ? null : redactSensitiveValue(task.result),
    error: task.error ? {
      code: redactSensitiveText(String(task.error.code ?? 'TASK_FAILED')).slice(0, 100),
      message: redactSensitiveText(String(task.error.message ?? 'Task failed')).slice(0, 4_000),
      ...(task.error.details === undefined ? {} : {
        details: redactSensitiveValue(task.error.details, { maxDepth: 8, maxItems: 200 })
      }),
      ...(task.error.nextAction === undefined ? {} : {
        nextAction: redactSensitiveText(String(task.error.nextAction)).slice(0, 2_000)
      }),
      ...(task.error.cause ? {
        cause: {
          code: redactSensitiveText(String(task.error.cause.code ?? 'ERROR')).slice(0, 100),
          message: redactSensitiveText(String(task.error.cause.message ?? 'Underlying operation failed')).slice(0, 2_000)
        }
      } : {})
    } : null,
    eventSequence: Number.isSafeInteger(task.eventSequence) ? task.eventSequence : 0,
    createdAt: task.createdAt ?? null,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    outputClearedAt: task.outputClearedAt ?? null,
    heartbeatAt: task.heartbeatAt ?? null,
    canResume: task.state === 'waiting',
    elapsedMs: Number.isFinite(start) ? Math.max(0, end - start) : 0,
    outputRef: task.id ? `/v1/tasks/${encodeURIComponent(task.id)}/artifacts` : null
  };
}
