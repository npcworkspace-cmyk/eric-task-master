import { basename } from 'node:path';
import { publicProfile as publicManagerProfile } from '../contracts.mjs';
import { redactPublicText } from '../lib/redaction.mjs';
import { TaskMasterClientError } from './errors.mjs';

export const MAX_TOOL_RESULT_BYTES = 256 * 1024;
export const MAX_ARTIFACT_CHUNK_BYTES = 48 * 1024;

const FORBIDDEN_KEY = /(?:token|cookie|authorization|header|password|secret|modulepath|userdata|outputdir|checkpoint|session|lease|\bpath\b|pid)/i;
const SAFE_EVIDENCE_KINDS = new Set(['artifact', 'count', 'hash', 'message', 'note', 'url']);

function stringValue(value, maxLength = 256) {
  if (typeof value !== 'string') return undefined;
  return redactText(value, maxLength);
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function definedEntries(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

export function redactText(value, maxLength = 2048) {
  const text = redactPublicText(value, { pathReplacement: '[LOCAL_PATH]' });
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return redactText(url.toString(), 2048);
  } catch {
    return undefined;
  }
}

function publicTaskErrorMessage(code) {
  if (/TIMEOUT|HEARTBEAT/.test(code)) return 'Task timed out or stopped reporting progress; inspect diagnostic artifacts before retrying.';
  if (/PROFILE_(?:IN_USE|LEASED|LEASE_FAILED)/.test(code)) return 'The selected Profile is already in use; choose another Profile or wait for cleanup to settle.';
  if (/ACTION|NAVIGATION|PLAYWRIGHT|BROWSER/.test(code)) return 'A browser action failed; inspect the latest diagnostic screenshot and live task state.';
  if (/INPUT|SCHEMA/.test(code)) return 'Task input does not match the installed task type contract.';
  if (/INTERRUPTED|MANAGER_RESTART/.test(code)) return 'Manager restarted during the task; inspect the preserved checkpoint before resuming.';
  return 'Task failed; inspect its state, progress, checkpoint, and diagnostic artifacts.';
}

function safeJson(value, { depth = 0, seen = new Set() } = {}) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return redactText(value, 2048);
  if (depth >= 6 || !value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = value.slice(0, 64).map((item) => safeJson(item, { depth: depth + 1, seen })).filter((item) => item !== undefined);
  } else {
    output = {};
    for (const [key, item] of Object.entries(value).slice(0, 128)) {
      if (FORBIDDEN_KEY.test(key)) continue;
      const safe = safeJson(item, { depth: depth + 1, seen });
      if (safe !== undefined) output[key] = safe;
    }
  }
  seen.delete(value);
  return output;
}

export function publicStatus(status) {
  const counts = safeJson(status?.counts);
  return definedEntries([
    ['ok', booleanValue(status?.ok)],
    ['service', stringValue(status?.service, 80)],
    ['version', stringValue(status?.version, 32)],
    ['apiVersion', numberValue(status?.apiVersion)],
    ['state', stringValue(status?.state, 64)],
    ['startedAt', stringValue(status?.startedAt, 64)],
    ['counts', counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : undefined]
  ]);
}

export function publicProfile(profile) {
  return safeJson(publicManagerProfile(profile)) || {};
}

function publicProgress(progress) {
  if (!progress || typeof progress !== 'object') return undefined;
  return definedEntries([
    ['current', numberValue(progress.current)],
    ['total', numberValue(progress.total)],
    ['percent', numberValue(progress.percent)],
    ['phase', stringValue(progress.phase, 128)],
    ['message', stringValue(progress.message, 512)],
    ['updatedAt', stringValue(progress.updatedAt, 64)]
  ]);
}

function publicAttemptHistory(history) {
  if (!Array.isArray(history)) return undefined;
  const entries = history.slice(-100).map((entry) => definedEntries([
    ['attempt', Number.isSafeInteger(entry?.attempt) ? entry.attempt : undefined],
    ['resumed', booleanValue(entry?.resumed)],
    ['behavior', stringValue(entry?.behavior, 32)],
    ['state', stringValue(entry?.state, 64)],
    ['errorCode', stringValue(entry?.errorCode, 64)],
    ['startedAt', stringValue(entry?.startedAt, 64)],
    ['finishedAt', stringValue(entry?.finishedAt, 64)],
    ['checkpointSavedAt', stringValue(entry?.checkpointSavedAt, 64)]
  ])).filter((entry) => Number.isSafeInteger(entry.attempt));
  return entries.length ? entries : undefined;
}

function publicTaskCommands(commands) {
  if (!Array.isArray(commands)) return undefined;
  const output = commands.slice(-100).map((command) => definedEntries([
    ['commandId', stringValue(command?.commandId, 128)],
    ['kind', stringValue(command?.kind, 32)],
    ['status', stringValue(command?.status, 32)],
    ['expectedRevision', Number.isSafeInteger(command?.expectedRevision) ? command.expectedRevision : undefined],
    ['message', stringValue(command?.message, 8_000)],
    ['response', stringValue(command?.response, 2_000)],
    ['createdAt', stringValue(command?.createdAt, 64)],
    ['updatedAt', stringValue(command?.updatedAt, 64)]
  ])).filter((command) => command.commandId && command.kind && command.status);
  return output.length ? output : undefined;
}

function publicTaskReport(report) {
  if (!report || typeof report !== 'object') return undefined;
  const sections = Array.isArray(report.sections)
    ? report.sections.slice(0, 24).map((section) => definedEntries([
      ['heading', stringValue(section?.heading, 200)],
      ['body', stringValue(section?.body, 20_000)]
    ])).filter((section) => section.heading && section.body)
    : [];
  return definedEntries([
    ['reportId', stringValue(report.reportId, 128)],
    ['status', stringValue(report.status, 16)],
    ['title', stringValue(report.title, 200)],
    ['summary', stringValue(report.summary, 20_000)],
    ['sections', sections],
    ['publishedAt', stringValue(report.publishedAt, 64)]
  ]);
}

function publicEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || !SAFE_EVIDENCE_KINDS.has(evidence.kind)) return undefined;
  const base = definedEntries([
    ['kind', evidence.kind],
    ['label', stringValue(evidence.label, 128)]
  ]);
  if (evidence.kind === 'url') {
    const value = safeUrl(evidence.value);
    return value ? { ...base, value } : undefined;
  }
  if (evidence.kind === 'count') {
    const value = numberValue(evidence.value);
    return value === undefined ? undefined : { ...base, value };
  }
  if (evidence.kind === 'hash') {
    const value = typeof evidence.value === 'string' && /^[a-f0-9]{32,128}$/i.test(evidence.value)
      ? evidence.value
      : undefined;
    return value ? { ...base, value } : undefined;
  }
  if (evidence.kind === 'artifact') {
    const artifactId = stringValue(evidence.artifactId ?? evidence.value, 128);
    return artifactId ? { ...base, artifactId } : undefined;
  }
  const value = stringValue(evidence.value, 1024);
  return value ? { ...base, value } : undefined;
}

export function publicTask(task, { includeResult = true } = {}) {
  const result = task?.result && typeof task.result === 'object' ? task.result : undefined;
  const evidence = includeResult && Array.isArray(result?.evidence)
    ? result.evidence.slice(0, 32).map(publicEvidence).filter(Boolean)
    : undefined;
  const errorCode = typeof task?.error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(task.error.code)
    ? task.error.code
    : undefined;
  const cleanup = task?.cleanup && typeof task.cleanup === 'object'
    ? definedEntries([
      ['browserClosed', booleanValue(task.cleanup.browserClosed)],
      ['leaseReleased', booleanValue(task.cleanup.leaseReleased)],
      ['workerExited', booleanValue(task.cleanup.workerExited)],
      ['settled', booleanValue(task.cleanup.settled)],
      ['managerRestartObserved', booleanValue(task.cleanup.managerRestartObserved)]
    ])
    : undefined;
  const diagnostic = task?.lastScreenshot && typeof task.lastScreenshot === 'object'
    ? definedEntries([
      ['kind', 'screenshot'],
      ['reason', stringValue(task.lastScreenshot.reason, 128)],
      ['at', stringValue(task.lastScreenshot.at, 64)],
      ['artifactsAvailable', true]
    ])
    : undefined;
  const observation = task?.lastObservation && typeof task.lastObservation === 'object'
    ? definedEntries([
      ['kind', 'semantic-observation'],
      ['reason', stringValue(task.lastObservation.reason, 128)],
      ['at', stringValue(task.lastObservation.at, 64)],
      ['artifactsAvailable', true]
    ])
    : undefined;
  const userRequest = task?.userRequest && typeof task.userRequest === 'object'
    ? definedEntries([
      ['id', stringValue(task.userRequest.id, 128)],
      ['reason', stringValue(task.userRequest.reason, 500)],
      ['instructions', stringValue(task.userRequest.instructions, 2_000)],
      ['requestedAt', stringValue(task.userRequest.requestedAt, 64)],
      ['expiresAt', stringValue(task.userRequest.expiresAt, 64)],
      ['status', stringValue(task.userRequest.status, 32)],
      ['screenshotAvailable', booleanValue(task.userRequest.screenshotAvailable)]
    ])
    : undefined;
  const health = task?.health && typeof task.health === 'object'
    ? definedEntries([
      ['status', stringValue(task.health.status, 32)],
      ['since', stringValue(task.health.since, 64)],
      ['checkedAt', stringValue(task.health.checkedAt, 64)],
      ['diagnosticRequested', booleanValue(task.health.diagnosticRequested)]
    ])
    : undefined;
  const behaviorState = task?.behaviorState && typeof task.behaviorState === 'object'
    ? definedEntries([
      ['configured', stringValue(task.behaviorState.configured, 32)],
      ['effective', stringValue(task.behaviorState.effective, 32)],
      ['at', stringValue(task.behaviorState.at, 64)],
      ['adaptive', task.behaviorState.adaptive && typeof task.behaviorState.adaptive === 'object'
        ? definedEntries([
          ['level', numberValue(task.behaviorState.adaptive.level)],
          ['label', stringValue(task.behaviorState.adaptive.label, 32)],
          ['actionsRemaining', numberValue(task.behaviorState.adaptive.actionsRemaining)],
          ['signal', stringValue(task.behaviorState.adaptive.signal, 64)]
        ])
        : undefined]
    ])
    : undefined;
  const cooldown = task?.cooldown && typeof task.cooldown === 'object'
    ? definedEntries([
      ['status', stringValue(task.cooldown.status, 32)],
      ['durationMs', numberValue(task.cooldown.durationMs)],
      ['resumeAt', stringValue(task.cooldown.resumeAt, 64)],
      ['reason', stringValue(task.cooldown.reason, 160)],
      ['updatedAt', stringValue(task.cooldown.updatedAt, 64)]
    ])
    : undefined;
  const currentActivity = task?.currentActivity && typeof task.currentActivity === 'object'
    ? definedEntries([
      ['phase', stringValue(task.currentActivity.phase, 32)],
      ['status', stringValue(task.currentActivity.status, 16)],
      ['updatedAt', stringValue(task.currentActivity.updatedAt, 64)]
    ])
    : undefined;
  const agent = task?.agent && typeof task.agent === 'object'
    ? definedEntries([
      ['clientId', stringValue(task.agent.clientId, 128)],
      ['name', stringValue(task.agent.name, 160)]
    ])
    : undefined;
  return definedEntries([
    ['id', stringValue(task?.id, 128)],
    ['jobId', stringValue(task?.jobId, 128)],
    ['revision', Number.isSafeInteger(task?.revision) ? task.revision : undefined],
    ['profileId', stringValue(task?.profileId, 128)],
    ['taskType', stringValue(task?.taskType, 128)],
    ['createdBy', stringValue(task?.createdBy, 128)],
    ['agent', agent?.clientId && agent?.name ? agent : undefined],
    ['behavior', stringValue(task?.behavior, 32)],
    ['attempt', Number.isSafeInteger(task?.attempt) ? task.attempt : undefined],
    ['history', publicAttemptHistory(task?.history)],
    ['state', stringValue(task?.state, 64)],
    ['currentActivity', currentActivity],
    ['progress', publicProgress(task?.progress)],
    ['progressAt', stringValue(task?.progressAt, 64)],
    ['createdAt', stringValue(task?.createdAt, 64)],
    ['startedAt', stringValue(task?.startedAt, 64)],
    ['updatedAt', stringValue(task?.updatedAt, 64)],
    ['finishedAt', stringValue(task?.finishedAt, 64)],
    ['heartbeatAt', stringValue(task?.heartbeatAt, 64)],
    ['health', health],
    ['behaviorState', behaviorState],
    ['cooldown', cooldown],
    ['queuePosition', numberValue(task?.queuePosition)],
    ['queueReason', stringValue(task?.queueReason, 160)],
    ['cleanup', cleanup && Object.keys(cleanup).length ? cleanup : undefined],
    ['diagnostic', diagnostic],
    ['observation', observation],
    ['userRequest', userRequest],
    ['checkpoint', task?.checkpoint ? definedEntries([
      ['available', true],
      ['savedAt', stringValue(task.checkpoint.savedAt, 64)]
    ]) : undefined],
    ['resumeAvailable', booleanValue(task?.resumeAvailable)],
    ['commands', publicTaskCommands(task?.commands)],
    ['report', publicTaskReport(task?.report)],
    ['summary', includeResult ? stringValue(result?.summary ?? task?.summary, 4096) : undefined],
    ['evidence', evidence?.length ? evidence : undefined],
    ['error', errorCode ? { code: errorCode, message: publicTaskErrorMessage(errorCode) } : undefined]
  ]);
}

export function publicTaskType(taskType, { includeSchema = true } = {}) {
  const schema = includeSchema ? safeJson(taskType?.inputSchema) : undefined;
  const stringList = (value, maximum) => Array.isArray(value)
    ? value.slice(0, maximum).map((item) => stringValue(item, 253)).filter(Boolean)
    : undefined;
  return definedEntries([
    ['id', stringValue(taskType?.id ?? taskType?.name, 128)],
    ['title', stringValue(taskType?.title ?? taskType?.name, 120)],
    ['description', stringValue(taskType?.description, 1024)],
    ['version', stringValue(taskType?.version, 32)],
    ['readOnly', booleanValue(taskType?.readOnly)],
    ['domains', stringList(taskType?.domains, 16)],
    ['intents', stringList(taskType?.intents, 16)],
    ['tags', stringList(taskType?.tags, 32)],
    ['outputs', stringList(taskType?.outputs, 32)],
    ['risk', stringValue(taskType?.risk, 16)],
    ['lifecycle', stringValue(taskType?.lifecycle, 16)],
    ['deprecatedAt', stringValue(taskType?.deprecatedAt, 64)],
    ['replacedBy', stringValue(taskType?.replacedBy, 128)],
    ['pack', taskType?.pack && typeof taskType.pack === 'object' ? definedEntries([
      ['name', stringValue(taskType.pack.name, 80)],
      ['version', stringValue(taskType.pack.version, 64)]
    ]) : undefined],
    ['supportsResume', booleanValue(taskType?.supportsResume)],
    ['inputSchema', schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : undefined]
  ]);
}

export function publicArtifact(artifact) {
  if (artifact?.agentVisible !== true) return undefined;
  const rawName = typeof artifact.name === 'string' ? artifact.name.replaceAll('\\', '/') : '';
  const mimeType = typeof artifact?.mimeType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(artifact.mimeType)
    ? artifact.mimeType
    : undefined;
  return definedEntries([
    ['id', stringValue(artifact?.id, 128)],
    ['name', stringValue(basename(rawName), 255)],
    ['kind', stringValue(artifact?.kind, 64)],
    ['mimeType', mimeType],
    ['sizeBytes', numberValue(artifact?.sizeBytes)],
    ['sha256', typeof artifact?.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(artifact.sha256) ? artifact.sha256 : undefined],
    ['createdAt', stringValue(artifact?.createdAt, 64)]
  ]);
}

export function publicArtifactRead(payload, requestedArtifactId) {
  const artifact = publicArtifact(payload?.artifact);
  if (!artifact || artifact.id !== requestedArtifactId) {
    throw new TaskMasterClientError(
      'ARTIFACT_NOT_AGENT_VISIBLE',
      'The requested artifact is not marked as agent-visible.',
      { nextAction: 'List task artifacts and choose an agent-visible artifact.' }
    );
  }
  const encoding = payload?.encoding === 'base64' ? 'base64' : 'utf8';
  const chunk = typeof payload?.chunk === 'string' ? payload.chunk : '';
  if (encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk)) {
    throw new TaskMasterClientError('INVALID_ARTIFACT_ENCODING', 'Task Master returned invalid base64 artifact data.');
  }
  const decodedBytes = encoding === 'base64'
    ? Math.floor((chunk.length * 3) / 4)
    : Buffer.byteLength(chunk);
  if (decodedBytes > MAX_ARTIFACT_CHUNK_BYTES) {
    throw new TaskMasterClientError('ARTIFACT_CHUNK_TOO_LARGE', 'The artifact chunk exceeded the MCP output limit.');
  }
  return {
    artifact,
    offset: numberValue(payload?.offset) ?? 0,
    nextOffset: numberValue(payload?.nextOffset) ?? decodedBytes,
    eof: payload?.eof === true,
    encoding,
    // Agent-visible artifacts are explicit, trusted task outputs. Preserve their
    // bytes exactly so JSON/JSONL/CSV remains parseable and its advertised hash
    // remains meaningful. Task summaries and evidence are still redacted.
    chunk
  };
}

export function assertResultBound(value) {
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > MAX_TOOL_RESULT_BYTES) {
    throw new TaskMasterClientError(
      'OUTPUT_LIMIT_EXCEEDED',
      'The MCP tool result exceeded its bounded output limit.',
      { nextAction: 'Request a smaller page or artifact chunk.' }
    );
  }
  return value;
}
