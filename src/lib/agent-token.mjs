import { createHmac, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { isReservedAgentClientId } from './principal.mjs';

export const AGENT_TOKEN_VERSION = 'ETMA2';
export const MAX_AGENT_TOKEN_LENGTH = 512;

const CLIENT_ID = /^[a-zA-Z0-9._:-]{1,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
// Reject characters that can reorder, split, or invisibly spoof an identity in
// a terminal or Dashboard. ZWJ remains allowed so ordinary emoji still work.
const DISPLAY_CONTROL = /[\u061c\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u;
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true });

export class AgentTokenError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'AgentTokenError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgentTokenError(code, message);
}

function requireManagerToken(value) {
  if (typeof value !== 'string' || value.length < 32) {
    fail('INVALID_MANAGER_TOKEN', 'managerToken must contain at least 32 characters');
  }
  return value;
}

export function validateAgentClientId(value) {
  if (typeof value !== 'string' || !CLIENT_ID.test(value)) {
    fail(
      'INVALID_CLIENT_ID',
      'clientId must contain 1-128 letters, numbers, dots, underscores, colons, or hyphens'
    );
  }
  if (isReservedAgentClientId(value)) {
    fail('RESERVED_CLIENT_ID', 'clientId uses a reserved internal principal name');
  }
  return value;
}

export function normalizeAgentName(value) {
  if (typeof value !== 'string') {
    fail('INVALID_AGENT_NAME', 'name must be a string');
  }
  // Reject controls before trimming so a tab/newline cannot be silently hidden.
  if (CONTROL_CHARACTER.test(value) || DISPLAY_CONTROL.test(value)) {
    fail('INVALID_AGENT_NAME', 'name must not contain control or display-control characters');
  }
  const normalized = value.normalize('NFC').trim();
  if (FATAL_UTF8.decode(Buffer.from(normalized, 'utf8')) !== normalized) {
    fail('INVALID_AGENT_NAME', 'name must contain valid Unicode scalar values');
  }
  const codePoints = [...normalized].length;
  if (codePoints < 1 || codePoints > 80) {
    fail('INVALID_AGENT_NAME', 'name must contain 1-80 Unicode characters');
  }
  if (Buffer.byteLength(normalized, 'utf8') > 160) {
    fail('INVALID_AGENT_NAME', 'name must contain at most 160 UTF-8 bytes');
  }
  return normalized;
}

function encode(value) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCanonical(value) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return null;
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return null;
    return FATAL_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function signature(managerToken, payload) {
  return createHmac('sha256', managerToken).update(payload, 'utf8').digest('base64url');
}

function secureSignatureEqual(actual, expected) {
  if (!SIGNATURE.test(actual) || !SIGNATURE.test(expected)) return false;
  const actualBytes = Buffer.from(actual, 'ascii');
  const expectedBytes = Buffer.from(expected, 'ascii');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function issueAgentToken(managerToken, { clientId, name } = {}) {
  const secret = requireManagerToken(managerToken);
  const normalizedClientId = validateAgentClientId(clientId);
  const normalizedName = normalizeAgentName(name);
  const payload = `${AGENT_TOKEN_VERSION}.${encode(normalizedClientId)}.${encode(normalizedName)}`;
  const value = `${payload}.${signature(secret, payload)}`;
  if (value.length > MAX_AGENT_TOKEN_LENGTH) {
    fail('AGENT_TOKEN_TOO_LARGE', 'Agent token exceeds its maximum encoded length');
  }
  return {
    token: value,
    agent: { clientId: normalizedClientId, name: normalizedName }
  };
}

export function authenticateAgentToken(value, managerToken) {
  if (
    typeof value !== 'string' || value.length > MAX_AGENT_TOKEN_LENGTH ||
    typeof managerToken !== 'string' || managerToken.length < 32
  ) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== AGENT_TOKEN_VERSION) return null;
  const clientId = decodeCanonical(parts[1]);
  const name = decodeCanonical(parts[2]);
  if (clientId === null || name === null) return null;
  try {
    validateAgentClientId(clientId);
    if (normalizeAgentName(name) !== name) return null;
  } catch {
    return null;
  }
  const payload = parts.slice(0, 3).join('.');
  if (!secureSignatureEqual(parts[3], signature(managerToken, payload))) return null;
  return { clientId, name };
}
