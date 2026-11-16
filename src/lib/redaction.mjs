const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy[-_]?authorization|headers?|cookies?|set[-_]?cookie|manager[-_]?token|(?:access|refresh|id|auth|bearer|session)[-_]?token|tokens?|session(?:[-_]?id)?|api[-_]?key|apikey|x[-_]?api[-_]?key|client[-_]?secret|private[-_]?key|credentials?|jwt|passwords?|passwd|secrets?)$/i;
const COMPACT_SENSITIVE_KEY_PATTERN = /^(?:authorization|proxyauthorization|headers?|cookies?|setcookie|managertoken|(?:access|refresh|id|auth|bearer|session)?tokens?|session(?:id)?|apikey|xapikey|clientsecret|privatekey|credentials?|jwt|passwords?|passwd|secrets?)$/;
const SENSITIVE_KEY_SUFFIX = /(?:apikey|token|sessionid|privatekey|credential|jwt|password|passwd|secret)$/;
const NAMED_SECRET_DESCRIPTOR = /(?:^|[-_])(auth|authorization|bearer|cookie|credential|jwt|password|secret|session|token)(?:$|[-_])/iu;

const NAMED_SECRET = /((?:^|[^a-z0-9_-])["']?(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|manager[-_]?token|(?:access|refresh|id|auth|bearer|session)[-_]?token|token|session(?:[-_]?id)?|api[-_]?key|apikey|x[-_]?api[-_]?key|client[-_]?secret|private[-_]?key|credential|jwt|password|passwd|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n}]+)/gi;
const PREFIXED_SECRET = /((?:^|[\s,;{])["']?(?:[a-z0-9]+[-_])+(?:api[-_]?key|token|session[-_]?id|private[-_]?key|credential|jwt|password|passwd|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&\r\n}]+)/gi;
const QUERY_SECRET = /([?&](?:authorization|auth|token|access_token|refresh_token|id_token|auth_token|bearer_token|session|session_token|session_id|sessionid|api_key|apikey|x-api-key|key|client_secret|private_key|credential|jwt|password|passwd|secret)=)[^&#\s]*/gi;
const AUTH_HEADER = /((?:^|[^a-z0-9_-])(?:authorization|proxy[-_]?authorization)\s*[:=]\s*)(?:bearer\s+|basic\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)/gi;
const COOKIE_HEADER = /((?:^|[\r\n])\s*(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gi;
const BEARER_VALUE = /(\bbearer\s+)[a-z0-9._~+/=-]+/gi;
const TEXT_REDACTIONS = [AUTH_HEADER, COOKIE_HEADER, PREFIXED_SECRET, NAMED_SECRET, QUERY_SECRET, BEARER_VALUE];
const HTTP_URL = /https?:\/\/[^\s"'<>]+/gi;
const FILE_URL = /file:\/\/\/[^\s"'<>]+/gi;
const WINDOWS_ABSOLUTE_PATH = /(^|[^A-Za-z0-9+.-])([A-Za-z]:[\\/][^\s"'<>]*)/gm;
const UNC_ABSOLUTE_PATH = /(^|[\s("'=,:;])(\\\\[^\s"'<>]+)/gm;
const POSIX_ABSOLUTE_PATH = /(^|[\s("'=,:;])(\/(?!\/)[^\s"'<>),;}:]+)/gm;

export function isSensitiveKey(key) {
  const normalized = String(key ?? '').trim();
  if (!normalized) return false;
  if (SENSITIVE_KEY_PATTERN.test(normalized)) return true;
  const compact = normalized.replace(/[-_\s]/g, '').toLowerCase();
  return COMPACT_SENSITIVE_KEY_PATTERN.test(compact) || SENSITIVE_KEY_SUFFIX.test(compact);
}

export function redactSensitiveText(value) {
  let result = String(value);
  for (const pattern of TEXT_REDACTIONS) result = result.replace(pattern, '$1[REDACTED]');
  return result;
}

// Data only: the browser executes these same canonical rules before slicing.
// Keeping the source/order shared prevents a split token leaking across chunks.
export function sensitiveTextRules() {
  return TEXT_REDACTIONS.map(pattern => ({ source: pattern.source, flags: pattern.flags, replacement: '$1[REDACTED]' }));
}

export function sensitiveDescriptorRules() {
  const data = pattern => ({ source: pattern.source, flags: pattern.flags });
  return { direct: data(SENSITIVE_KEY_PATTERN), compact: [COMPACT_SENSITIVE_KEY_PATTERN, SENSITIVE_KEY_SUFFIX].map(data), named: data(NAMED_SECRET_DESCRIPTOR) };
}

// A redacted span (including its key/header prefix) is atomic. A field chunk
// target may be exceeded; the containing observation/reply budget stays hard.
export function sliceRedactedText(value, offset, maxChars) {
  if (offset >= value.length || maxChars <= 0) return '';
  const stable = text => redactSensitiveText(text) === text;
  if (!stable(value.slice(offset))) throw Object.assign(new Error('Requested source offset would create a new secret boundary; restart from offset 0'), { code: 'UNSAFE_TEXT_OFFSET' });
  const marker = '[REDACTED]';
  const spans = [];
  for (const pattern of TEXT_REDACTIONS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(value))) if (match[0].includes(marker)) spans.push([match.index, match.index + match[0].length]);
  }
  for (let at = value.indexOf(marker); at >= 0; at = value.indexOf(marker, at + marker.length)) spans.push([at, at + marker.length]);
  const merged = [];
  for (const span of spans.sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && span[0] < previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else merged.push(span);
  }
  const target = Math.min(value.length, offset + maxChars);
  const snap = (end, forward) => {
    for (const [start, finish] of merged) if (start < end && finish > end) { end = forward ? finish : start > offset ? start : finish; break; }
    return end;
  };
  const safeEnd = end => end > offset && stable(value.slice(offset, end)) && stable(value.slice(end));
  // Check a bounded neighborhood. Tiny chunks may need a context-atomic floor;
  // explicit unsafe starts are rejected rather than silently moved.
  const checked = new Set();
  for (const forward of [false, true]) for (let shift = 0; shift <= 32; shift++) {
    const end = snap(Math.min(value.length, Math.max(offset, target + (forward ? shift : -shift))), forward);
    if (checked.has(end)) continue;
    checked.add(end);
    if (safeEnd(end)) return value.slice(offset, end);
  }
  throw Object.assign(new Error('No redaction-stable chunk boundary fits; request a larger full field read'), { code: 'CONTEXT_INSUFFICIENT' });
}

function hasSecretNamedValueShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'value')) {
    return false;
  }
  const descriptor = typeof value.name === 'string'
    ? value.name
    : typeof value.key === 'string'
      ? value.key
      : '';
  const looksLikeCookie = typeof value.name === 'string' && (
    typeof value.domain === 'string' || typeof value.path === 'string' ||
    typeof value.httpOnly === 'boolean' || typeof value.secure === 'boolean' ||
    typeof value.sameSite === 'string'
  );
  return looksLikeCookie || isSensitiveKey(descriptor) || NAMED_SECRET_DESCRIPTOR.test(descriptor);
}

function sanitizePublicHttpUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return value;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[REDACTED_URL]';
  }
}

export function redactPublicText(value, { pathReplacement = '[local-path-hidden]' } = {}) {
  const urls = [];
  const withUrlPlaceholders = redactSensitiveText(value)
    .replace(HTTP_URL, (url) => {
      const index = urls.push(sanitizePublicHttpUrl(url)) - 1;
      return `\uE000${index}\uE001`;
    });
  return withUrlPlaceholders
    .replace(FILE_URL, pathReplacement)
    .replace(WINDOWS_ABSOLUTE_PATH, (_match, prefix) => `${prefix}${pathReplacement}`)
    .replace(UNC_ABSOLUTE_PATH, (_match, prefix) => `${prefix}${pathReplacement}`)
    .replace(POSIX_ABSOLUTE_PATH, (_match, prefix) => `${prefix}${pathReplacement}`)
    .replace(/\uE000(\d+)\uE001/g, (_match, index) => urls[Number(index)] ?? '[REDACTED_URL]');
}

export function redactSensitiveValue(value, { depth = 0, maxDepth = 12, maxItems = 1_000 } = {}) {
  if (depth > maxDepth) return '[truncated]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) {
    const redacted = value.slice(0, maxItems).map((item) => redactSensitiveValue(item, {
      depth: depth + 1,
      maxDepth,
      maxItems
    }));
    if (value.length > maxItems) {
      redacted.push({
        __taskMasterTruncated: {
          kind: 'array',
          includedItems: maxItems,
          omittedItems: value.length - maxItems
        }
      });
    }
    return redacted;
  }
  if (!value || typeof value !== 'object') return value;
  const redactNamedValue = hasSecretNamedValueShape(value);
  const safe = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, maxItems)) {
    if (isSensitiveKey(key)) continue;
    if (redactNamedValue && key === 'value') {
      safe.value = '[REDACTED]';
      continue;
    }
    safe[key] = redactSensitiveValue(item, { depth: depth + 1, maxDepth, maxItems });
  }
  if (entries.length > maxItems) {
    safe.__taskMasterTruncated = {
      kind: 'object',
      includedItems: maxItems,
      omittedItems: entries.length - maxItems
    };
  }
  return safe;
}

export function redactPublicValue(value, { depth = 0, maxDepth = 12, maxItems = 1_000 } = {}) {
  if (depth > maxDepth) return '[truncated]';
  if (typeof value === 'string') return redactPublicText(value);
  if (Array.isArray(value)) {
    const redacted = value.slice(0, maxItems).map((item) => redactPublicValue(item, {
      depth: depth + 1,
      maxDepth,
      maxItems
    }));
    if (value.length > maxItems) {
      redacted.push({
        __taskMasterTruncated: {
          kind: 'array',
          includedItems: maxItems,
          omittedItems: value.length - maxItems
        }
      });
    }
    return redacted;
  }
  if (!value || typeof value !== 'object') return value;
  const redactNamedValue = hasSecretNamedValueShape(value);
  const safe = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, maxItems)) {
    if (isSensitiveKey(key)) continue;
    if (redactNamedValue && key === 'value') {
      safe.value = '[REDACTED]';
      continue;
    }
    safe[key] = redactPublicValue(item, { depth: depth + 1, maxDepth, maxItems });
  }
  if (entries.length > maxItems) {
    safe.__taskMasterTruncated = {
      kind: 'object',
      includedItems: maxItems,
      omittedItems: entries.length - maxItems
    };
  }
  return safe;
}
