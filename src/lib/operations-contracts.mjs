import { createHash } from 'node:crypto';

export const MODES = Object.freeze(['auto', 'batch', 'operations']);
export function opsError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value) => createHash('sha256').update(canonical(value)).digest('hex');
export function selectMode({ modePolicy = 'auto', mode, skillMode, intent, manualLock = false } = {}) {
  for (const value of [modePolicy, mode, skillMode].filter((value) => value !== undefined)) {
    if (!MODES.includes(value)) throw opsError('INVALID_MODE', 'Mode must be auto, batch or operations');
  }
  if (mode && mode !== 'auto') return { mode, reason: 'task-intent', ...(manualLock ? { automationPaused: true } : {}) };
  const requested = mode && mode !== 'auto' ? mode : skillMode && skillMode !== 'auto' ? skillMode :
    ['monitor', 'follow-up', 'waiting'].includes(intent) ? 'operations' : 'batch';
  if (modePolicy !== 'auto' && mode !== 'auto') return { mode: modePolicy, reason: 'profile-policy', ...(manualLock ? { automationPaused: true } : {}) };
  return { mode: requested, reason: skillMode && skillMode !== 'auto' ? 'skill-intent' : intent ? 'operational-intent' : 'script-default', ...(manualLock ? { automationPaused: true } : {}) };
}
export function validateAuthorization(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || !value.accountId || !Array.isArray(value.resourceIds) ||
      !value.resourceIds.length || !Array.isArray(value.origins) || !value.origins.length ||
      !Array.isArray(value.allowedActions) || !value.allowedActions.length ||
      !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= now) {
    throw opsError('INVALID_AUTHORIZATION', 'Explicit account, resources, origins, actions and future expiry are required');
  }
  for (const origin of value.origins) {
    let valid = false; try { valid = new URL(origin).origin === origin && ['http:', 'https:'].includes(new URL(origin).protocol); } catch { /* invalid explicit origin */ }
    if (!valid) throw opsError('INVALID_AUTHORIZATION', 'Authorization origins must be exact HTTP URL origins');
  }
  if (typeof value.accountId !== 'string' || [...value.resourceIds, ...value.allowedActions].some((item) => typeof item !== 'string' || !item.trim() || item.length > 256)) throw opsError('INVALID_AUTHORIZATION', 'Account, resources and actions must be nonempty identifiers');
  if (value.limits) {
    for (const field of ['dailyMax', 'cooldownMs', 'maxPerMinute', 'maxChange', 'maxCumulativeChange', 'maxDataAgeMs']) if (value.limits[field] != null && (!Number.isFinite(value.limits[field]) || value.limits[field] < 0)) throw opsError('INVALID_AUTHORIZATION_LIMIT', `${field} must be a nonnegative finite number`);
    if (value.limits.fields && (!Array.isArray(value.limits.fields) || value.limits.fields.some((field) => typeof field !== 'string'))) throw opsError('INVALID_AUTHORIZATION_LIMIT', 'Allowed fields must be a list');
  }
  return structuredClone(value);
}
export function assertAuthorized(operation, request = {}, now = Date.now()) {
  const auth = operation.authorization;
  if (auth.revokedAt || Date.parse(auth.expiresAt) <= now) throw opsError('AUTHORIZATION_INACTIVE', 'Authorization expired or was revoked', 403);
  if (request.authorizationVersion !== undefined && request.authorizationVersion !== auth.version) throw opsError('AUTHORIZATION_CHANGED', 'Refresh authorization before continuing', 409);
  if (request.accountId && request.accountId !== auth.accountId) throw opsError('ACCOUNT_MISMATCH', 'Account is outside authorization', 403);
  if (request.resourceId && !auth.resourceIds.includes(request.resourceId)) throw opsError('RESOURCE_NOT_AUTHORIZED', 'Resource is outside authorization', 403);
  if (request.origin && !auth.origins.includes(request.origin)) throw opsError('ORIGIN_NOT_AUTHORIZED', 'Origin is outside authorization', 403);
  if (request.kind && !['observe', 'wait', 'tabs', 'select-tab', 'screenshot', 'reconcile', 'control'].includes(request.kind) &&
      !auth.allowedActions.includes(request.kind)) throw opsError('ACTION_NOT_AUTHORIZED', `Action ${request.kind} is outside authorization`, 403);
  return auth;
}
