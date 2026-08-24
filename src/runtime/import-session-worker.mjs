import { randomUUID } from 'node:crypto';
import { writeCleanupReceipt } from '../lib/cleanup-receipt.mjs';
import { redactSensitiveText } from '../lib/redaction.mjs';
import { SESSION_IMPORT_DEADLINES } from './session-import-deadlines.mjs';

const SESSION_COOKIE_RETENTION_SECONDS = 12 * 60 * 60;

class SessionImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionImportError';
    this.code = code;
  }
}

function safeSend(message) {
  if (typeof process.send !== 'function' || !process.connected) return;
  try {
    process.send(message, undefined, undefined, () => {});
  } catch {
    // The parent owns process-exit handling.
  }
}

function sameSite(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'strict') return 'Strict';
  if (normalized === 'lax') return 'Lax';
  if (normalized === 'none' || normalized === 'no_restriction') return 'None';
  return undefined;
}

function partitionKey(cookie) {
  return typeof cookie?.partitionKey === 'string'
    ? cookie.partitionKey
    : cookie?.partitionKey?.topLevelSite;
}

function normalizedDomain(value) {
  return String(value || '').replace(/^\./, '').toLowerCase();
}

function partitionMatchesOrigin(cookie, origin) {
  const key = partitionKey(cookie);
  if (!key) return true;
  try {
    const partition = new URL(key);
    const partitionHost = partition.hostname.toLowerCase();
    const originHost = origin.hostname.toLowerCase();
    return partition.protocol === origin.protocol && (
      partitionHost === originHost
      || partitionHost.endsWith(`.${originHost}`)
      || originHost.endsWith(`.${partitionHost}`)
    );
  } catch {
    return false;
  }
}

function cookieDomainMatchesOrigin(cookie, origin) {
  const domain = normalizedDomain(cookie.domain);
  const hostname = origin.hostname.toLowerCase();
  if (!domain || (hostname !== domain && !hostname.endsWith(`.${domain}`))) return false;
  return (origin.protocol === 'https:' || !cookie.secure) && partitionMatchesOrigin(cookie, origin);
}

function cookieIdentity(cookie, origin) {
  const url = cookie.url ? new URL(cookie.url) : null;
  const domain = String(cookie.domain || url?.hostname || origin.hostname).toLowerCase();
  const path = String(cookie.path || url?.pathname || '/');
  return JSON.stringify([cookie.name, domain, path, partitionKey(cookie) || '']);
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new TypeError('Session bundle is required');
  const origin = new URL(bundle.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== bundle.origin) {
    throw new TypeError('Session origin must be an HTTP or HTTPS origin');
  }
  if (!Array.isArray(bundle.cookies) || !Array.isArray(bundle.localStorage)) {
    throw new TypeError('Session bundle cookies and localStorage must be arrays');
  }
  const cookieKeys = new Set();
  for (const cookie of bundle.cookies) {
    if (typeof cookie?.name !== 'string' || typeof cookie?.value !== 'string') {
      throw new TypeError('Every cookie must contain string name and value fields');
    }
    const domain = String(cookie.domain || origin.hostname).replace(/^\./, '').toLowerCase();
    const hostname = origin.hostname.toLowerCase();
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
      throw new TypeError('Session bundle contains a cookie outside the selected origin');
    }
    if (cookie.path !== undefined && (typeof cookie.path !== 'string' || !cookie.path.startsWith('/'))) {
      throw new TypeError('Every cookie path must start with /');
    }
    if (!partitionMatchesOrigin(cookie, origin)) {
      throw new TypeError('Session bundle contains a cookie partition outside the selected origin');
    }
    const key = cookieIdentity({
      ...cookie,
      domain: cookie.hostOnly || !cookie.domain ? origin.hostname : cookie.domain,
      path: cookie.path || '/'
    }, origin);
    if (cookieKeys.has(key)) throw new TypeError('Session bundle contains duplicate cookies');
    cookieKeys.add(key);
  }
  const localStorageKeys = new Set();
  for (const entry of bundle.localStorage) {
    if (typeof entry?.name !== 'string' || typeof entry?.value !== 'string') {
      throw new TypeError('Every localStorage entry must contain string name and value fields');
    }
    if (localStorageKeys.has(entry.name)) {
      throw new TypeError('Session bundle contains duplicate localStorage keys');
    }
    localStorageKeys.add(entry.name);
  }
  if (bundle.source?.tabUrl && new URL(bundle.source.tabUrl).origin !== origin.origin) {
    throw new TypeError('Session source URL must match the selected origin');
  }
  return origin;
}

function toPlaywrightCookie(cookie, origin) {
  const normalized = {
    name: cookie.name,
    value: cookie.value,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    ...(sameSite(cookie.sameSite) ? { sameSite: sameSite(cookie.sameSite) } : {})
  };
  // A Playwright `url` cookie always defaults to path `/`, even when the URL
  // contains another path. An exact hostname domain (without a leading dot)
  // preserves Chrome's host-only semantics and the original path.
  normalized.domain = cookie.hostOnly || !cookie.domain ? origin.hostname : cookie.domain;
  normalized.path = cookie.path || '/';
  if (!cookie.session && Number.isFinite(Number(cookie.expirationDate))) {
    normalized.expires = Number(cookie.expirationDate);
  } else if (cookie.session) {
    // A clean Chromium shutdown drops session-only cookies. The explicitly
    // transferred copy remains local to this Profile and expires after 12h.
    normalized.expires = Math.floor(Date.now() / 1_000) + SESSION_COOKIE_RETENTION_SECONDS;
  }
  const key = partitionKey(cookie);
  if (key) normalized.partitionKey = key;
  return normalized;
}

function toRollbackCookie(cookie) {
  const restored = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    ...(sameSite(cookie.sameSite) ? { sameSite: sameSite(cookie.sameSite) } : {})
  };
  if (Number.isFinite(Number(cookie.expires)) && Number(cookie.expires) >= 0) {
    restored.expires = Number(cookie.expires);
  }
  const key = partitionKey(cookie);
  if (key) restored.partitionKey = key;
  return restored;
}

async function originCookies(context, origin) {
  const allCookies = await context.cookies();
  return allCookies.filter((cookie) => cookieDomainMatchesOrigin(cookie, origin));
}

function clearTuple(cookie) {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path || '/']);
}

async function clearCookieSet(context, cookies, origin) {
  const allCookies = await context.cookies();
  const targetedIdentities = new Set(cookies.map((cookie) => cookieIdentity(cookie, origin)));
  const cleared = new Set();
  for (const cookie of cookies) {
    const key = clearTuple(cookie);
    if (cleared.has(key)) continue;
    cleared.add(key);
    const preserved = allCookies.filter((candidate) => (
      clearTuple(candidate) === key
      && !targetedIdentities.has(cookieIdentity(candidate, origin))
    ));
    await context.clearCookies({
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path || '/'
    });
    if (preserved.length > 0) await context.addCookies(preserved.map(toRollbackCookie));
  }
}

async function replaceLocalStorage(page, entries) {
  return page.evaluate((nextEntries) => {
    localStorage.clear();
    for (const entry of nextEntries) localStorage.setItem(entry.name, entry.value);
    return Object.keys(localStorage).length;
  }, entries);
}

async function readLocalStorage(page) {
  return page.evaluate(() => Object.entries(localStorage).map(([name, value]) => ({ name, value })));
}

function sameLocalStorage(actual, expected) {
  if (actual.length !== expected.length) return false;
  const actualMap = new Map(actual.map((entry) => [entry.name, entry.value]));
  return expected.every((entry) => actualMap.get(entry.name) === entry.value);
}

function sameCookies(actual, expected, origin) {
  if (actual.length !== expected.length) return false;
  const actualMap = new Map(actual.map((cookie) => [cookieIdentity(cookie, origin), cookie]));
  return expected.every((cookie) => {
    const found = actualMap.get(cookieIdentity(cookie, origin));
    if (!found || found.value !== cookie.value) return false;
    if (cookie.httpOnly !== undefined && Boolean(found.httpOnly) !== Boolean(cookie.httpOnly)) return false;
    if (cookie.secure !== undefined && Boolean(found.secure) !== Boolean(cookie.secure)) return false;
    if (cookie.sameSite !== undefined && sameSite(found.sameSite) !== sameSite(cookie.sameSite)) return false;
    if (cookie.expires !== undefined && Number.isFinite(Number(cookie.expires))) {
      if (Math.abs(Number(found.expires) - Number(cookie.expires)) > 1) return false;
    }
    return true;
  });
}

async function verifyState(context, page, origin, expectedCookies, expectedLocalStorage) {
  const [cookies, localStorage] = await Promise.all([
    originCookies(context, origin),
    readLocalStorage(page)
  ]);
  return sameCookies(cookies, expectedCookies, origin)
    && sameLocalStorage(localStorage, expectedLocalStorage);
}

async function openOriginProbe(context, origin) {
  const page = context.pages()[0] || await context.newPage();
  const probeUrl = `${origin.origin}/.well-known/eric-task-master/session-import/${randomUUID()}`;
  await page.route(probeUrl, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><meta charset="utf-8"><title>Task Master session import</title>'
  }));
  try {
    await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } finally {
    await page.unroute(probeUrl).catch(() => {});
  }
  if (new URL(page.url()).origin !== origin.origin) {
    throw new SessionImportError('SESSION_IMPORT_PREPARE_FAILED', 'Session import origin could not be prepared');
  }
  return page;
}

async function restoreSnapshot(context, page, origin, snapshot) {
  const currentCookies = await originCookies(context, origin);
  await clearCookieSet(context, currentCookies, origin);
  await replaceLocalStorage(page, []);
  if (snapshot.cookies.length > 0) {
    await context.addCookies(snapshot.cookies.map(toRollbackCookie));
  }
  await replaceLocalStorage(page, snapshot.localStorage);
  if (!await verifyState(context, page, origin, snapshot.cookies, snapshot.localStorage)) {
    throw new Error('rollback verification failed');
  }
}

async function withDeadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('browser cleanup timed out')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeSessionBrowserSession(
  context,
  timeoutMs = SESSION_IMPORT_DEADLINES.closeAttemptMs
) {
  if (!context) return true;
  let browser = null;
  try {
    browser = context.browser?.() || null;
  } catch {
    // The context close below still has a chance to prove cleanup.
  }
  try {
    await withDeadline(context.close(), timeoutMs);
    return true;
  } catch {
    if (!browser) return false;
  }
  if (typeof browser.close !== 'function') return false;
  try {
    await withDeadline(browser.close(), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

function safeImportFailure(error) {
  if (error instanceof SessionImportError) return error;
  return new SessionImportError('SESSION_IMPORT_FAILED', 'Session import failed');
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new SessionImportError('SESSION_IMPORT_CANCELLED', 'Session import was cancelled');
  }
}

export async function runSessionImport({
  profile,
  bundle,
  cleanupReceiptPath = null,
  cleanupReceipt = null
}, {
  loadPlaywright = () => import('playwright'),
  signal,
  rollbackTimeoutMs = SESSION_IMPORT_DEADLINES.rollbackMs,
  closeTimeoutMs = SESSION_IMPORT_DEADLINES.closeAttemptMs
} = {}) {
  let origin = null;
  let context = null;
  let page = null;
  let snapshot = null;
  let mutationStarted = false;
  let result = null;
  let failure = null;
  let cleanupOutcome = null;
  let browserClosed = false;
  let cleanupReceiptWritten = false;
  try {
    origin = validateBundle(bundle);
    throwIfAborted(signal);
    const playwright = await loadPlaywright();
    throwIfAborted(signal);
    const browserType = playwright[profile.browser || 'chromium'];
    if (!browserType?.launchPersistentContext) throw new Error('Unsupported Playwright browser');
    context = await browserType.launchPersistentContext(profile.userDataDir, {
      headless: true,
      ...(profile.browserChannel ? { channel: profile.browserChannel } : {}),
      ...(profile.launchOptions || {}),
      serviceWorkers: 'block'
    });
    throwIfAborted(signal);

    page = await openOriginProbe(context, origin);
    throwIfAborted(signal);
    snapshot = {
      cookies: await originCookies(context, origin),
      localStorage: await readLocalStorage(page)
    };
    throwIfAborted(signal);

    const importedCookies = bundle.cookies.map((cookie) => toPlaywrightCookie(cookie, origin));
    mutationStarted = true;
    await clearCookieSet(context, snapshot.cookies, origin);
    throwIfAborted(signal);
    await replaceLocalStorage(page, []);
    throwIfAborted(signal);
    if (importedCookies.length > 0) await context.addCookies(importedCookies);
    throwIfAborted(signal);
    await replaceLocalStorage(page, bundle.localStorage);
    throwIfAborted(signal);

    if (!await verifyState(context, page, origin, importedCookies, bundle.localStorage)) {
      throw new SessionImportError(
        'SESSION_IMPORT_VERIFICATION_FAILED',
        'Session import verification failed'
      );
    }
    throwIfAborted(signal);

    cleanupOutcome = 'committed';
    result = {
      status: 'partial',
      cookieCount: importedCookies.length,
      localStorageCount: bundle.localStorage.length,
      sessionCookieRetentionHours: 12,
      verification: 'storage_replaced_not_login_verified'
    };
  } catch (error) {
    failure = safeImportFailure(error);
    if (mutationStarted && context && page && snapshot) {
      try {
        await withDeadline(restoreSnapshot(context, page, origin, snapshot), rollbackTimeoutMs);
        cleanupOutcome = 'rolled_back';
      } catch {
        failure = new SessionImportError(
          'SESSION_IMPORT_ROLLBACK_FAILED',
          'Session import failed and the previous origin state could not be restored'
        );
        cleanupOutcome = null;
      }
    } else if (!mutationStarted) {
      // No persistent state write occurred, so the original state is already
      // the verified rollback outcome.
      cleanupOutcome = 'rolled_back';
    }
  }

  browserClosed = await closeSessionBrowserSession(context, closeTimeoutMs).catch(() => false);
  if (browserClosed) context = null;
  if (browserClosed && cleanupOutcome && cleanupReceiptPath && cleanupReceipt) {
    cleanupReceiptWritten = await writeCleanupReceipt(cleanupReceiptPath, {
      ...cleanupReceipt,
      outcome: cleanupOutcome
    }).then(() => true, () => false);
  }
  snapshot = null;
  bundle = null;

  if (failure?.code === 'SESSION_IMPORT_ROLLBACK_FAILED') {
    failure.browserClosed = browserClosed;
    failure.cleanupReceiptWritten = false;
    failure.cleanupOutcome = null;
    throw failure;
  }
  if (!browserClosed || (cleanupReceiptPath && !cleanupReceiptWritten)) {
    const cleanupError = new SessionImportError(
      'SESSION_IMPORT_CLEANUP_UNCONFIRMED',
      'Session import browser cleanup could not be confirmed'
    );
    cleanupError.browserClosed = browserClosed;
    cleanupError.cleanupReceiptWritten = cleanupReceiptWritten;
    cleanupError.cleanupOutcome = cleanupOutcome;
    throw cleanupError;
  }
  if (failure) {
    failure.browserClosed = browserClosed;
    failure.cleanupReceiptWritten = cleanupReceiptWritten;
    failure.cleanupOutcome = cleanupOutcome;
    throw failure;
  }
  return {
    ...result,
    browserClosed,
    cleanupReceiptWritten,
    cleanupOutcome
  };
}

if (typeof process.send === 'function') {
  const controller = new AbortController();
  let started = false;
  process.on('message', (message) => {
    if (message?.type === 'cancel') {
      controller.abort();
      return;
    }
    if (message?.type !== 'import' || started) return;
    started = true;
    void runSessionImport(message.config, { signal: controller.signal })
      .then((result) => safeSend({ type: 'result', result }))
      .catch((error) => safeSend({
        type: 'error',
        error: {
          code: error?.code || 'SESSION_IMPORT_FAILED',
          message: redactSensitiveText(error?.message || 'Session import failed').slice(0, 2_000),
          browserClosed: error?.browserClosed === true,
          cleanupReceiptWritten: error?.cleanupReceiptWritten === true,
          cleanupOutcome: typeof error?.cleanupOutcome === 'string' ? error.cleanupOutcome : null
        }
      }))
      .finally(() => {
        setTimeout(() => {
          if (process.connected) process.disconnect();
        }, 10);
      });
  });
  process.on('SIGTERM', () => controller.abort());
  process.on('disconnect', () => controller.abort());
}
