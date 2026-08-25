import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { JsonStore } from './json-store.mjs';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_SESSIONS = 128;
const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60_000;

function hashToken(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function iso(value) {
  return new Date(value).toISOString();
}

function normalizeState(value) {
  return value && typeof value === 'object' && Array.isArray(value.sessions)
    ? { version: 1, sessions: value.sessions.filter((item) => item && typeof item === 'object') }
    : { version: 1, sessions: [] };
}

export class DashboardSessionStore {
  #store;
  #now;
  #ttlMs;
  #maxSessions;
  #touchIntervalMs;

  constructor({
    filePath,
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    maxSessions = DEFAULT_MAX_SESSIONS,
    touchIntervalMs = DEFAULT_TOUCH_INTERVAL_MS
  } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    this.#store = new JsonStore(filePath, () => ({ version: 1, sessions: [] }));
    this.#now = now;
    this.#ttlMs = ttlMs;
    this.#maxSessions = maxSessions;
    this.#touchIntervalMs = touchIntervalMs;
  }

  async init() {
    await this.#store.init();
    await this.#store.update((raw) => {
      const state = normalizeState(raw);
      const now = this.#now();
      state.sessions = state.sessions
        .filter((session) => (
          typeof session.id === 'string' &&
          typeof session.tokenHash === 'string' &&
          Number.isFinite(Date.parse(session.expiresAt)) &&
          Date.parse(session.expiresAt) > now &&
          !session.revokedAt
        ))
        .slice(-this.#maxSessions);
      return state;
    });
  }

  async create({ focusTaskId = null } = {}) {
    const rawToken = randomBytes(32).toString('base64url');
    const createdAt = this.#now();
    const record = {
      id: randomBytes(16).toString('hex'),
      tokenHash: hashToken(rawToken),
      createdAt: iso(createdAt),
      lastSeenAt: iso(createdAt),
      expiresAt: iso(createdAt + this.#ttlMs),
      ...(focusTaskId ? { focusTaskId } : {})
    };
    await this.#store.update((raw) => {
      const state = normalizeState(raw);
      state.sessions = state.sessions
        .filter((session) => Date.parse(session.expiresAt) > createdAt && !session.revokedAt)
        .slice(-(this.#maxSessions - 1));
      state.sessions.push(record);
      return state;
    });
    return { token: rawToken, session: this.#public(record), expiresInMs: this.#ttlMs };
  }

  async authenticate(rawToken) {
    if (typeof rawToken !== 'string' || rawToken.length < 32 || rawToken.length > 256) return null;
    const expectedHash = hashToken(rawToken);
    const now = this.#now();
    let authenticated = null;
    let shouldTouch = false;
    const state = normalizeState(await this.#store.read());
    for (const session of state.sessions) {
      if (!safeEqual(session.tokenHash, expectedHash)) continue;
      if (session.revokedAt || Date.parse(session.expiresAt) <= now) return null;
      authenticated = session;
      shouldTouch = now - Date.parse(session.lastSeenAt || session.createdAt) >= this.#touchIntervalMs;
      break;
    }
    if (!authenticated) return null;
    if (shouldTouch) {
      const nextExpiry = iso(now + this.#ttlMs);
      await this.#store.update((raw) => {
        const current = normalizeState(raw);
        const match = current.sessions.find((session) => safeEqual(session.tokenHash, expectedHash));
        if (match && !match.revokedAt && Date.parse(match.expiresAt) > now) {
          match.lastSeenAt = iso(now);
          match.expiresAt = nextExpiry;
          authenticated = match;
        }
        return current;
      });
    }
    return this.#public(authenticated);
  }

  async revoke(rawToken) {
    if (typeof rawToken !== 'string') return false;
    const expectedHash = hashToken(rawToken);
    let revoked = false;
    await this.#store.update((raw) => {
      const state = normalizeState(raw);
      for (const session of state.sessions) {
        if (!safeEqual(session.tokenHash, expectedHash) || session.revokedAt) continue;
        session.revokedAt = iso(this.#now());
        revoked = true;
      }
      return state;
    });
    return revoked;
  }

  async revokeAll() {
    const revokedAt = iso(this.#now());
    let count = 0;
    await this.#store.update((raw) => {
      const state = normalizeState(raw);
      for (const session of state.sessions) {
        if (session.revokedAt) continue;
        session.revokedAt = revokedAt;
        count += 1;
      }
      return state;
    });
    return count;
  }

  #public(session) {
    return {
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      ...(session.focusTaskId ? { focusTaskId: session.focusTaskId } : {})
    };
  }
}

export const DASHBOARD_SESSION_TTL_MS = DEFAULT_TTL_MS;
