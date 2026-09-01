import { createHash, randomUUID } from 'node:crypto';
import { normalizeAgentName } from '../lib/agent-token.mjs';
import { redactSensitiveText } from '../lib/redaction.mjs';
import { isReservedAgentClientId } from '../lib/principal.mjs';
import { TaskServiceError } from './task-service-error.mjs';

const LEGACY_EXTERNAL_COST_FIELDS = Object.freeze([
  'externalCost',
  'externalCostBudget',
  'externalCostLedger',
  'externalCostUsage'
]);
export const COMMAND_ID_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;
const TASK_LABEL_MAX_LENGTH = 80;
export const MAX_TASK_COMMANDS = 200;
const MAX_TASK_TIMELINE = 500;

const AGENT_LABELS = Object.freeze({
  codex: 'Codex',
  'claude-desktop': 'Claude',
  'claude-code': 'Claude',
  workbuddy: 'WorkBuddy',
  hermes: 'Hermes',
  pi: 'Pi',
  dsh: 'DSH',
  openclaw: 'OpenClaw'
});

function nowIso() {
  return new Date().toISOString();
}

export function clone(value) {
  return structuredClone(value);
}

export function boundedText(value, { field, maximum = 2_000, required = true } = {}) {
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) {
    throw new TaskServiceError(
      'INVALID_TASK_COMMAND',
      `${field || 'text'} must be ${required ? 'a non-empty ' : ''}string of at most ${maximum} characters`
    );
  }
  return redactSensitiveText(value).slice(0, maximum);
}

export function normalizeTaskLabel(value, fallback) {
  if (value === undefined) {
    const safeFallback = redactSensitiveText(typeof fallback === 'string' ? fallback.trim() : 'task')
      .replace(/[\u0000-\u001f\u007f]/gu, ' ')
      .trim()
      .slice(0, TASK_LABEL_MAX_LENGTH);
    return safeFallback || 'task';
  }
  const candidate = value;
  if (
    typeof candidate !== 'string' || !candidate.trim() || candidate.length > TASK_LABEL_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new TaskServiceError(
      'INVALID_TASK_LABEL',
      `taskLabel must be a non-empty string of at most ${TASK_LABEL_MAX_LENGTH} characters without control characters`
    );
  }
  return redactSensitiveText(candidate.trim()).slice(0, TASK_LABEL_MAX_LENGTH);
}

function stableAgentLabel(taskOrCaller) {
  if (taskOrCaller?.role === 'manager-admin' || taskOrCaller?.ownerRole === 'manager-admin') return 'Manager';
  const clientId = String(taskOrCaller?.clientId ?? taskOrCaller?.ownerClientId ?? 'agent');
  const hostKey = clientId.includes(':')
    ? clientId.slice(clientId.lastIndexOf(':') + 1)
    : clientId.split(/[._]/u)[0];
  if (AGENT_LABELS[hostKey]) return AGENT_LABELS[hostKey];
  const safe = hostKey.replace(/[^a-zA-Z0-9-]/gu, '').slice(0, 24);
  return safe || 'Agent';
}

function compactCreatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return 'unknown-time';
  return date.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z').replace('T', '-');
}

export function buildTaskDisplayName(task) {
  return `${stableAgentLabel(task)}-${task.taskLabel || task.taskType || 'task'}-${compactCreatedAt(task.createdAt)}`;
}

export function normalizeTaskTiming(task) {
  if (!task.timing || typeof task.timing !== 'object' || Array.isArray(task.timing) || task.timing.version !== 1) {
    return null;
  }
  task.timing.cooldownDurationMs = Number.isFinite(task.timing.cooldownDurationMs)
    ? Math.max(0, Math.round(task.timing.cooldownDurationMs))
    : 0;
  return task.timing;
}

export function taskActor(caller) {
  return {
    role: caller.role,
    clientId: caller.clientId,
    ...(caller.role === 'agent' && caller.agentName ? { name: caller.agentName } : {})
  };
}

export function requestHash(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function normalizeTaskCoordination(task) {
  task.revision = Number.isSafeInteger(task.revision) && task.revision >= 1 ? task.revision : 1;
  task.jobId = typeof task.jobId === 'string' && /^job_[a-f0-9]{32}$/.test(task.jobId)
    ? task.jobId
    : `job_${createHash('sha256').update(task.id).digest('hex').slice(0, 32)}`;
  task.timeline = Array.isArray(task.timeline)
    ? task.timeline.filter((entry) => entry && typeof entry === 'object').slice(-MAX_TASK_TIMELINE)
    : [];
  const latestTimelineSequence = task.timeline.reduce((maximum, entry) => (
    Number.isSafeInteger(entry.sequence) && entry.sequence > maximum ? entry.sequence : maximum
  ), 0);
  task.timelineSequence = Number.isSafeInteger(task.timelineSequence) && task.timelineSequence >= 0
    ? Math.max(task.timelineSequence, latestTimelineSequence)
    : latestTimelineSequence;
  task.commands = Array.isArray(task.commands)
    ? task.commands.filter((entry) => (
        entry && typeof entry === 'object' &&
        typeof entry.commandId === 'string' && COMMAND_ID_PATTERN.test(entry.commandId)
      )).slice(-MAX_TASK_COMMANDS)
    : [];
  task.reports = Array.isArray(task.reports)
    ? task.reports.filter((entry) => entry && typeof entry === 'object').slice(-20)
    : [];
  if (!task.report || typeof task.report !== 'object' || Array.isArray(task.report)) task.report = null;
  if (task.input && typeof task.input === 'object' && !Array.isArray(task.input)) {
    task.inputRevisionHash ||= requestHash(task.input);
  }
}

export function appendTimeline(task, type, { actor = null, message = '', commandId = null, status = null } = {}) {
  normalizeTaskCoordination(task);
  task.timelineSequence += 1;
  const entry = {
    id: `event_${randomUUID().replaceAll('-', '')}`,
    sequence: task.timelineSequence,
    type,
    at: nowIso(),
    ...(actor ? { actor: clone(actor) } : {}),
    ...(message ? { message: redactSensitiveText(message).slice(0, 2_000) } : {}),
    ...(commandId ? { commandId } : {}),
    ...(status ? { status } : {})
  };
  task.timeline.push(entry);
  task.timeline = task.timeline.slice(-MAX_TASK_TIMELINE);
  return entry;
}

export function requireCoordinationBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TaskServiceError('INVALID_TASK_COMMAND', 'Task command body must be an object');
  }
  const unknown = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknown.length) {
    throw new TaskServiceError('INVALID_TASK_COMMAND', `Unsupported task command fields: ${unknown.join(', ')}`);
  }
  if (typeof body.commandId !== 'string' || !COMMAND_ID_PATTERN.test(body.commandId)) {
    throw new TaskServiceError(
      'INVALID_TASK_COMMAND',
      'commandId must contain 8-128 letters, numbers, dots, underscores, colons, or hyphens'
    );
  }
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
    throw new TaskServiceError('INVALID_TASK_COMMAND', 'expectedRevision must be a positive integer');
  }
}

export function callerIdentity(caller = {}) {
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

export function profileCallerIdentity(caller = {}) {
  if (
    ['manager-admin', 'agent'].includes(caller.role) &&
    typeof caller.clientId === 'string' && caller.clientId &&
    !(caller.role === 'agent' && isReservedAgentClientId(caller.clientId))
  ) {
    return { role: caller.role, clientId: caller.clientId };
  }
  throw new TaskServiceError('PROFILE_ACCESS_DENIED', 'Profile operation is not allowed for this caller', 403);
}

export function canAccess(task, caller) {
  return caller.role === 'manager-admin' || (
    caller.role === 'agent' && task.ownerRole === 'agent' && task.ownerClientId === caller.clientId
  );
}

export function isTaskOwner(task, caller) {
  return task.ownerRole === caller.role && task.ownerClientId === caller.clientId;
}

export function isSamePrincipal(entry, caller) {
  return entry?.ownerRole === caller.role && entry?.ownerClientId === caller.clientId;
}

export function canUseProfile(profile, caller) {
  if (caller.role === 'manager-admin') return true;
  return caller.role === 'agent' && Boolean(profile);
}

export function requireProfileUse(profile, caller) {
  if (!canUseProfile(profile, caller)) {
    throw new TaskServiceError(
      'PROFILE_ACCESS_DENIED',
      'This Agent is not authorized to use this Profile',
      403
    );
  }
  return profile;
}

export function taskLeaseAccess(task) {
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

export function filterTaskTypes(taskTypes, filters = {}) {
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

export function migrateLegacyExternalCostState(task) {
  const wasResumable = task.supportsResume === true || task.resumeCheckpointValid === true || Boolean(task.checkpoint);
  const paid = task.legacyPaidRuntime === true || LEGACY_EXTERNAL_COST_FIELDS.some((field) => (
    Object.hasOwn(task, field) && task[field] !== null && task[field] !== undefined
  ));
  for (const field of LEGACY_EXTERNAL_COST_FIELDS) delete task[field];
  if (paid) {
    task.legacyPaidRuntime = true;
    task.supportsResume = false;
    if (Array.isArray(task.result?.evidence)) {
      task.result.evidence = task.result.evidence.filter((item) => !(
        item?.kind === 'count' &&
        ['external-cost-estimated', 'external-cost-actual'].includes(item?.label)
      ));
    }
  }
  return { paid, wasResumable };
}

export function legacyExternalCostUnsupportedError() {
  return {
    code: 'TASK_EXTERNAL_COST_UNSUPPORTED',
    message: 'This task used the external-cost runtime removed in Task Master 2.8.0 and cannot run or resume.'
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
  );
}

function inputSchemaError(location, message, { expectedType, receivedType } = {}) {
  throw new TaskServiceError(
    'TASK_INPUT_SCHEMA_FAILED',
    `Task input ${location} ${message}`,
    400,
    {
      field: location,
      reason: message,
      ...(expectedType ? { expectedType } : {}),
      ...(receivedType ? { receivedType } : {})
    }
  );
}

function jsonValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number') return 'number';
  return typeof value;
}

export function validateTaskInput(value, schema, location = '$', depth = 0) {
  if (!schema || typeof schema !== 'object') return;
  if (depth > 20) inputSchemaError(location, 'is nested too deeply');
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) {
    inputSchemaError(location, 'is not one of the allowed values');
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = jsonValueType(value);
    const matches = types.includes(actual) || (actual === 'integer' && types.includes('number'));
    if (!matches) inputSchemaError(location, `must be ${types.join(' or ')}`, {
      expectedType: types.join(' | '),
      receivedType: actual
    });
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

export function encodeCursor(task) {
  return Buffer.from(JSON.stringify({ id: task.id }), 'utf8').toString('base64url');
}

export function decodeCursor(value) {
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
