import { isSensitiveKey, redactSensitiveText } from './lib/redaction.mjs';

export const VERSION = '1.0.0';
export const API_VERSION = 1;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 19946;
export const BEHAVIOR_MODES = Object.freeze(['fast', 'human', 'adaptive']);
export const PROFILE_KINDS = Object.freeze(['persistent', 'ephemeral']);
export const PROFILE_STATES = Object.freeze(['idle', 'starting', 'open', 'leased', 'deleting', 'error']);
export const TASK_STATES = Object.freeze([
  'queued',
  'acquiring_profile',
  'starting_browser',
  'running',
  'waiting_user',
  'cooling_down',
  'recovering',
  'verifying',
  'completed',
  'failed',
  'cancelled'
]);
export const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);

export function isBehaviorMode(value) {
  return BEHAVIOR_MODES.includes(value);
}

export function isProfileKind(value) {
  return PROFILE_KINDS.includes(value);
}

export function publicProfile(profile) {
  const safe = {};
  for (const key of [
    'id',
    'name',
    'kind',
    'state',
    'defaultBehavior',
    'headless',
    'browserChannel',
    'createdAt',
    'updatedAt',
    'lastUsedAt',
    'lastOpenedAt'
  ]) {
    if (profile?.[key] !== undefined) safe[key] = profile[key];
  }
  return safe;
}

function redactLocalPaths(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') {
    if (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(value)) return '[local-path-hidden]';
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => redactLocalPaths(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key) || /^(?:modulePath|outputDir|userDataDir)$/i.test(key)) {
      continue;
    }
    safe[key] = redactLocalPaths(item, depth + 1);
  }
  return safe;
}

export function publicTask(task) {
  const safe = {};
  for (const key of [
    'id',
    'profileId',
    'taskType',
    'behavior',
    'attempt',
    'history',
    'state',
    'progress',
    'progressAt',
    'heartbeatAt',
    'health',
    'behaviorState',
    'cooldown',
    'queuePosition',
    'queueReason',
    'result',
    'error',
    'cleanup',
    'createdAt',
    'updatedAt',
    'startedAt',
    'finishedAt',
    'completion',
    'userRequest'
  ]) {
    if (task?.[key] !== undefined) safe[key] = redactLocalPaths(task[key]);
  }
  if (task.id) safe.outputRef = `taskmaster://tasks/${encodeURIComponent(task.id)}/artifacts/`;
  if (task.checkpoint) {
    safe.checkpoint = {
      savedAt: task.checkpoint.savedAt ?? null,
      ref: `taskmaster://tasks/${encodeURIComponent(task.id)}/checkpoint`
    };
  }
  if (task.lastScreenshot) {
    safe.lastScreenshot = {
      reason: task.lastScreenshot.reason,
      at: task.lastScreenshot.at,
      ref: `taskmaster://tasks/${encodeURIComponent(task.id)}/screenshot`
    };
  }
  if (task.lastObservation) {
    safe.lastObservation = {
      reason: task.lastObservation.reason,
      at: task.lastObservation.at,
      ref: `taskmaster://tasks/${encodeURIComponent(task.id)}/observation`
    };
  }
  if (task.ownerClientId) safe.createdBy = task.ownerClientId;
  safe.resumeAvailable = Boolean(
    task.state === 'failed' && task.checkpoint && task.cleanup?.settled === true
  );
  return safe;
}
