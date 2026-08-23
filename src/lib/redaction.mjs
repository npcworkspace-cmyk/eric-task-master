const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy[-_]?authorization|headers?|cookies?|set[-_]?cookie|manager[-_]?token|(?:access|refresh|id|auth|bearer|session)[-_]?token|tokens?|session(?:[-_]?id)?|api[-_]?key|apikey|x[-_]?api[-_]?key|client[-_]?secret|private[-_]?key|credentials?|jwt|passwords?|passwd|secrets?)$/i;

const NAMED_SECRET = /((?:^|[^a-z0-9_-])["']?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|manager[-_]?token|(?:access|refresh|id|auth|bearer|session)[-_]?token|token|session(?:[-_]?id)?|api[-_]?key|apikey|x[-_]?api[-_]?key|client[-_]?secret|private[-_]?key|credential|jwt|password|passwd|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n}]+)/gi;
const PREFIXED_SECRET = /((?:^|[\s,;{])["']?(?:[a-z0-9]+[-_])+(?:api[-_]?key|token|session[-_]?id|private[-_]?key|credential|jwt|password|passwd|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n}]+)/gi;
const QUERY_SECRET = /([?&](?:authorization|auth|token|access_token|refresh_token|id_token|auth_token|bearer_token|session|session_token|session_id|sessionid|api_key|apikey|x-api-key|key|client_secret|private_key|credential|jwt|password|passwd|secret)=)[^&#\s]*/gi;
const AUTH_HEADER = /((?:^|[^a-z0-9_-])(?:authorization|proxy[-_]?authorization)\s*[:=]\s*)(?:bearer\s+|basic\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)/gi;
const COOKIE_HEADER = /((?:^|[\r\n])\s*(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi;
const BEARER_VALUE = /(\bbearer\s+)[a-z0-9._~+/=-]+/gi;

export function isSensitiveKey(key) {
  const normalized = String(key ?? '').trim();
  if (!normalized) return false;
  if (SENSITIVE_KEY_PATTERN.test(normalized)) return true;
  const compact = normalized.replace(/[-_\s]/g, '').toLowerCase();
  return /^(?:authorization|proxyauthorization|headers?|cookies?|setcookie|managertoken|(?:access|refresh|id|auth|bearer|session)?tokens?|session(?:id)?|apikey|xapikey|clientsecret|privatekey|credentials?|jwt|passwords?|passwd|secrets?)$/.test(compact)
    || /(?:apikey|token|sessionid|privatekey|credential|jwt|password|passwd|secret)$/.test(compact);
}

export function redactSensitiveText(value) {
  return String(value)
    .replace(AUTH_HEADER, '$1[REDACTED]')
    .replace(COOKIE_HEADER, '$1[REDACTED]')
    .replace(PREFIXED_SECRET, '$1[REDACTED]')
    .replace(NAMED_SECRET, '$1[REDACTED]')
    .replace(QUERY_SECRET, '$1[REDACTED]')
    .replace(BEARER_VALUE, '$1[REDACTED]');
}

export function redactSensitiveValue(value, { depth = 0, maxDepth = 12, maxItems = 1_000 } = {}) {
  if (depth > maxDepth) return '[truncated]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.slice(0, maxItems).map((item) => redactSensitiveValue(item, {
      depth: depth + 1,
      maxDepth,
      maxItems
    }));
  }
  if (!value || typeof value !== 'object') return value;
  const safe = {};
  for (const [key, item] of Object.entries(value).slice(0, maxItems)) {
    if (isSensitiveKey(key)) continue;
    safe[key] = redactSensitiveValue(item, { depth: depth + 1, maxDepth, maxItems });
  }
  return safe;
}
