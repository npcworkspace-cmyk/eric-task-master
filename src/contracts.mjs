import { isSensitiveKey, redactPublicText } from './lib/redaction.mjs';
import { normalizeAgentName, validateAgentClientId } from './lib/agent-token.mjs';
import { projectPublicTaskFailure } from './lib/public-task-failure.mjs';

export const VERSION = '2.9.0';
export const API_VERSION = 1;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 19946;
export const BEHAVIOR_MODES = Object.freeze(['fast', 'auto', 'human']);
export const BROWSER_ENGINES = Object.freeze(['chrome', 'chromium']);
export const PROFILE_KINDS = Object.freeze(['persistent', 'ephemeral']);
export const PROFILE_STATES = Object.freeze(['idle', 'starting', 'open', 'leased', 'deleting', 'error']);
export const TASK_STATES = Object.freeze([
  'queued',
  'acquiring_profile',
  'starting_browser',
  'running',
  'pause_requested',
  'paused',
  'waiting_user',
  'cooling_down',
  'recovering',
  'verifying',
  'cancel_requested',
  'completed',
  'failed',
  'cancelled'
]);
export const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);

export function isSettledTerminalTask(task) {
  return TERMINAL_TASK_STATES.has(task?.state) && task?.cleanup?.settled === true;
}

export function isBehaviorMode(value) {
  return BEHAVIOR_MODES.includes(value);
}

export function normalizeBehaviorMode(value, { allowLegacy = false } = {}) {
  if (allowLegacy && value === 'adaptive') return 'auto';
  return isBehaviorMode(value) ? value : null;
}

export function isBrowserEngine(value) {
  return BROWSER_ENGINES.includes(value);
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
    'browserEngine',
    'extensionsEnabled',
    'createdAt',
    'updatedAt',
    'lastUsedAt',
    'lastOpenedAt'
  ]) {
    if (profile?.[key] !== undefined) safe[key] = profile[key];
  }
  if (profile?.lease?.cleanupRequired === true) safe.cleanupRequired = true;
  return safe;
}

function redactLocalPaths(value, depth = 0) {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') {
    return redactPublicText(value);
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

function publicTaskTiming(task) {
  const createdAt = Date.parse(task?.createdAt);
  const finishedAt = Date.parse(task?.finishedAt);
  const endAt = Number.isFinite(finishedAt) ? finishedAt : Date.now();
  const totalDurationMs = Number.isFinite(createdAt) ? Math.max(0, endAt - createdAt) : 0;
  if (task?.timing?.version !== 1) {
    return { recorded: false, runDurationMs: null, cooldownDurationMs: null, totalDurationMs };
  }
  let cooldownDurationMs = Number.isFinite(task.timing.cooldownDurationMs)
    ? Math.max(0, Math.round(task.timing.cooldownDurationMs))
    : 0;
  const activeCooldownStartedAt = Date.parse(task.timing.activeCooldownStartedAt);
  if (Number.isFinite(activeCooldownStartedAt)) {
    const resumeAt = Date.parse(task.cooldown?.resumeAt);
    const activeEndAt = Number.isFinite(resumeAt) ? Math.min(endAt, resumeAt) : endAt;
    cooldownDurationMs += Math.max(0, activeEndAt - activeCooldownStartedAt);
  }
  let elapsedSinceStart = 0;
  if (Array.isArray(task?.history)) {
    for (const attempt of task.history) {
      const attemptStart = Date.parse(attempt?.workerStartedAt);
      if (!Number.isFinite(attemptStart)) continue;
      const attemptFinish = Date.parse(attempt?.finishedAt);
      elapsedSinceStart += Math.max(0, (Number.isFinite(attemptFinish) ? attemptFinish : endAt) - attemptStart);
    }
  }
  if (elapsedSinceStart === 0) {
    const startedAt = Date.parse(task?.startedAt);
    elapsedSinceStart = Number.isFinite(startedAt) ? Math.max(0, endAt - startedAt) : 0;
  }
  return {
    recorded: true,
    runDurationMs: Math.max(0, elapsedSinceStart - cooldownDurationMs),
    cooldownDurationMs,
    totalDurationMs
  };
}

export function publicTask(task) {
  const safe = {};
  for (const key of [
    'id',
    'jobId',
    'revision',
    'profileId',
    'taskType',
    'taskLabel',
    'displayName',
    'supportsResume',
    'interactionContract',
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
    'cleanup',
    'createdAt',
    'updatedAt',
    'startedAt',
    'finishedAt',
    'completion',
    'userRequest',
    'createdBy'
  ]) {
    if (
      key === 'result' &&
      !(task.state === 'completed' && task.completion?.integrity !== 'invalid' && task.completion?.verifiedAt)
    ) continue;
    if (task?.[key] !== undefined) safe[key] = redactLocalPaths(task[key]);
  }
  const projectedError = projectPublicTaskFailure(task?.error);
  if (projectedError) safe.error = projectedError;
  if (Array.isArray(safe.result?.evidence)) {
    safe.result.evidence = safe.result.evidence.filter((item) => !(
      item?.kind === 'count' &&
      ['external-cost-estimated', 'external-cost-actual'].includes(item?.label)
    ));
  }
  safe.timing = publicTaskTiming(task);
  if (Array.isArray(task?.timeline)) {
    safe.timeline = task.timeline.slice(-200).map((event) => redactLocalPaths(event));
  }
  if (Array.isArray(task?.commands)) {
    safe.commands = task.commands.slice(-100).map((command) => ({
      commandId: command.commandId,
      kind: command.kind,
      status: command.status,
      expectedRevision: command.expectedRevision,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
      ...(command.actor ? { actor: redactLocalPaths(command.actor) } : {}),
      ...(typeof command.payload?.message === 'string'
        ? { message: redactPublicText(command.payload.message) }
        : {}),
      ...(typeof command.response === 'string'
        ? { response: redactPublicText(command.response) }
        : {})
    }));
  }
  if (task?.report && typeof task.report === 'object') {
    safe.report = redactLocalPaths({
      reportId: task.report.reportId,
      status: task.report.status,
      title: task.report.title,
      summary: task.report.summary,
      sections: task.report.sections,
      author: task.report.author,
      publishedAt: task.report.publishedAt
    });
  }
  if (
    task?.currentActivity && typeof task.currentActivity === 'object' &&
    typeof task.currentActivity.phase === 'string' &&
    /^[a-z][a-z0-9_-]{0,31}$/.test(task.currentActivity.phase) &&
    ['active', 'succeeded', 'unknown', 'waiting', 'cancelled'].includes(task.currentActivity.status) &&
    typeof task.currentActivity.updatedAt === 'string' && task.currentActivity.updatedAt.length <= 64
  ) {
    safe.currentActivity = {
      phase: task.currentActivity.phase,
      status: task.currentActivity.status,
      updatedAt: task.currentActivity.updatedAt
    };
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
      reason: redactPublicText(task.lastScreenshot.reason ?? ''),
      at: task.lastScreenshot.at,
      ref: `taskmaster://tasks/${encodeURIComponent(task.id)}/screenshot`
    };
  }
  if (task.lastObservation) {
    safe.lastObservation = {
      reason: redactPublicText(task.lastObservation.reason ?? ''),
      at: task.lastObservation.at,
      ref: `taskmaster://tasks/${encodeURIComponent(task.id)}/observation`
    };
  }
  if (task.ownerClientId) safe.createdBy = task.ownerClientId;
  const agentSource = task?.agent && typeof task.agent === 'object'
    ? task.agent
    : task?.ownerRole === 'agent' && task.ownerClientId
      ? { clientId: task.ownerClientId, name: task.ownerAgentName ?? task.ownerClientId }
      : null;
  if (agentSource) {
    try {
      const clientId = validateAgentClientId(agentSource.clientId);
      safe.agent = {
        clientId,
        name: normalizeAgentName(agentSource.name ?? clientId)
      };
    } catch {
      // Invalid persisted display metadata is omitted without affecting task access.
    }
  }
  const hasInternalResumeState = Object.hasOwn(task || {}, 'resumeCheckpointValid');
  safe.resumeAvailable = hasInternalResumeState
    ? Boolean(
        task.supportsResume === true && task.state === 'failed' && task.checkpoint &&
        task.resumeCheckpointValid === true && task.cleanup?.settled === true
      )
    : task.resumeAvailable === true;
  const resumeBlocked = task.resumeCheckpointError || task.resumeBlocked;
  if (!safe.resumeAvailable && resumeBlocked) {
    safe.resumeBlocked = redactLocalPaths(resumeBlocked);
  }
  return safe;
}
