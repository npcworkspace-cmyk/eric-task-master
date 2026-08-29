import { redactPublicText } from './redaction.mjs';

const CATEGORIES = new Set(['input', 'precondition', 'provider', 'navigation', 'data', 'runtime']);
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/u;
const GENERIC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
const FIELD_PATH_PATTERN = /^[a-zA-Z0-9_$.[\]-]{1,128}$/u;
const TYPE_NAME_PATTERN = /^[a-z][a-z0-9 _|.-]{0,63}$/u;
const OPAQUE_CREDENTIAL_PATTERNS = Object.freeze([
  /\bgh[pousr]_[a-zA-Z0-9]{36,255}\b/gu,
  /\bgithub_pat_[a-zA-Z0-9_]{22,255}\b/gu,
  /\bsk-(?:(?:proj|svcacct)-[a-zA-Z0-9_-]{20,255}|[a-zA-Z0-9]{20,255})\b/gu,
  /\bsk-ant-(?:api\d{2}-)?[a-zA-Z0-9_-]{20,255}\b/gu,
  /\beyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{8,}\b/gu,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/gu,
  /\bxox[a-z]-[a-zA-Z0-9-]{20,255}\b/gu,
  /\b\d{6,12}:[a-zA-Z0-9_-]{30,255}\b/gu
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedText(value, maximum) {
  let text = redactPublicText(String(value || '').replace(/\s+/gu, ' ').trim());
  // This intentionally covers only high-confidence credential formats. Task
  // modules must never copy an arbitrary provider payload into this contract.
  for (const pattern of OPAQUE_CREDENTIAL_PATTERNS) {
    text = text.replace(pattern, '[REDACTED_CREDENTIAL]');
  }
  return text.slice(0, maximum);
}

export function sanitizePublicTaskFailure(value) {
  if (!plainObject(value)) return null;
  const category = boundedText(value.category, 32);
  const code = boundedText(value.code, 64);
  const publicMessage = boundedText(value.publicMessage, 500);
  const nextAction = boundedText(value.nextAction, 500);
  if (!CATEGORIES.has(category) || !CODE_PATTERN.test(code) || !publicMessage || !nextAction) return null;
  const sourceFields = value.fields === undefined ? [] : value.fields;
  if (!Array.isArray(sourceFields) || sourceFields.length > 8) return null;
  const fields = [];
  for (const field of sourceFields) {
    if (!plainObject(field)) return null;
    const path = boundedText(field.path, 128);
    const reason = boundedText(field.reason, 300);
    if (!FIELD_PATH_PATTERN.test(path) || !reason) return null;
    const expectedType = field.expectedType === undefined ? '' : boundedText(field.expectedType, 64);
    const receivedType = field.receivedType === undefined ? '' : boundedText(field.receivedType, 64);
    if (
      (expectedType && !TYPE_NAME_PATTERN.test(expectedType)) ||
      (receivedType && !TYPE_NAME_PATTERN.test(receivedType))
    ) return null;
    fields.push(Object.freeze({
      path,
      reason,
      ...(expectedType ? { expectedType } : {}),
      ...(receivedType ? { receivedType } : {})
    }));
  }
  return Object.freeze({ category, code, publicMessage, fields: Object.freeze(fields), nextAction });
}

function genericPublicTaskFailureMessage(code) {
  if (/TIMEOUT|HEARTBEAT/u.test(code)) {
    return 'Task timed out or stopped reporting progress; inspect diagnostic artifacts before retrying.';
  }
  if (/PROFILE_(?:IN_USE|LEASED|LEASE_FAILED)/u.test(code)) {
    return 'The selected Profile is already in use; choose another Profile or wait for cleanup to settle.';
  }
  if (/ACTION|NAVIGATION|PLAYWRIGHT|BROWSER/u.test(code)) {
    return 'A browser action failed; inspect the latest diagnostic screenshot and live task state.';
  }
  if (/INPUT|SCHEMA/u.test(code)) {
    return 'Task input does not match the installed task type contract.';
  }
  if (/INTERRUPTED|MANAGER_RESTART/u.test(code)) {
    return 'Manager restarted during the task; inspect the preserved checkpoint before resuming.';
  }
  return 'Task failed; inspect its state, progress, checkpoint, and diagnostic artifacts.';
}

function alreadyProjectedFailure(value) {
  if (!plainObject(value)) return null;
  const allowed = new Set(['category', 'code', 'message', 'fields', 'nextAction']);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  return sanitizePublicTaskFailure({
    category: value.category,
    code: value.code,
    publicMessage: value.message,
    fields: value.fields,
    nextAction: value.nextAction
  });
}

export function projectPublicTaskFailure(error) {
  if (!plainObject(error)) return undefined;
  const failure = sanitizePublicTaskFailure(error.publicFailure) || alreadyProjectedFailure(error);
  if (failure) {
    return Object.freeze({
      code: failure.code,
      category: failure.category,
      message: failure.publicMessage,
      fields: Object.freeze(failure.fields.map((field) => Object.freeze({ ...field }))),
      nextAction: failure.nextAction
    });
  }
  const code = typeof error.code === 'string' && GENERIC_CODE_PATTERN.test(error.code)
    ? error.code
    : undefined;
  return code
    ? Object.freeze({ code, message: genericPublicTaskFailureMessage(code) })
    : undefined;
}

export class PublicTaskFailure extends Error {
  constructor(input) {
    const normalized = sanitizePublicTaskFailure(input);
    if (!normalized) throw new TypeError('Public task failure must use the bounded public failure contract');
    super(normalized.publicMessage);
    this.name = 'PublicTaskFailure';
    this.code = normalized.code;
    this.publicFailure = normalized;
  }
}

export function createTaskFailureFacade() {
  return Object.freeze({
    raise(input) {
      throw new PublicTaskFailure(input);
    }
  });
}
