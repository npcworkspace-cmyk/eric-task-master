const SESSION_COOKIE_RETENTION_SECONDS = 12 * 60 * 60;

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

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new TypeError('Session bundle is required');
  const origin = new URL(bundle.origin);
  if (!['http:', 'https:'].includes(origin.protocol)) throw new TypeError('Session origin must use HTTP or HTTPS');
  if (!Array.isArray(bundle.cookies) || !Array.isArray(bundle.localStorage)) {
    throw new TypeError('Session bundle cookies and localStorage must be arrays');
  }
  for (const cookie of bundle.cookies) {
    if (typeof cookie?.name !== 'string' || typeof cookie?.value !== 'string') {
      throw new TypeError('Every cookie must contain string name and value fields');
    }
    const domain = String(cookie.domain || origin.hostname).replace(/^\./, '').toLowerCase();
    const hostname = origin.hostname.toLowerCase();
    if (hostname !== domain && !hostname.endsWith(`.${domain}`)) {
      throw new TypeError('Session bundle contains a cookie outside the selected origin');
    }
  }
  for (const entry of bundle.localStorage) {
    if (typeof entry?.name !== 'string' || typeof entry?.value !== 'string') {
      throw new TypeError('Every localStorage entry must contain string name and value fields');
    }
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
  if (cookie.hostOnly || !cookie.domain) {
    normalized.url = new URL(cookie.path || '/', origin).href;
  } else {
    normalized.domain = cookie.domain;
    normalized.path = cookie.path || '/';
  }
  if (!cookie.session && Number.isFinite(Number(cookie.expirationDate))) {
    normalized.expires = Number(cookie.expirationDate);
  } else if (cookie.session) {
    // The importer must close before a task can lease the persistent profile.
    // Chromium removes session cookies on that clean close, so retain the
    // explicitly transferred copy for a bounded local window.
    normalized.expires = Math.floor(Date.now() / 1_000) + SESSION_COOKIE_RETENTION_SECONDS;
  }
  const partitionKey = typeof cookie.partitionKey === 'string'
    ? cookie.partitionKey
    : cookie.partitionKey?.topLevelSite;
  if (partitionKey) normalized.partitionKey = partitionKey;
  return normalized;
}

async function closeWithTimeout(context) {
  if (!context) return;
  let timer;
  try {
    await Promise.race([
      context.close(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 10_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runSessionImport({ profile, bundle }, {
  loadPlaywright = () => import('playwright')
} = {}) {
  const origin = validateBundle(bundle);
  let context = null;
  try {
    const playwright = await loadPlaywright();
    const browserType = playwright[profile.browser || 'chromium'];
    if (!browserType?.launchPersistentContext) throw new Error('Unsupported Playwright browser');
    context = await browserType.launchPersistentContext(profile.userDataDir, {
      headless: true,
      ...(profile.browserChannel ? { channel: profile.browserChannel } : {}),
      ...(profile.launchOptions || {})
    });

    const cookies = bundle.cookies.map((cookie) => toPlaywrightCookie(cookie, origin));
    if (cookies.length > 0) await context.addCookies(cookies);

    await context.addInitScript(({ selectedOrigin, entries }) => {
      if (location.origin !== selectedOrigin) return;
      for (const entry of entries) localStorage.setItem(entry.name, entry.value);
    }, { selectedOrigin: origin.origin, entries: bundle.localStorage });

    const page = context.pages()[0] || await context.newPage();
    await page.goto(origin.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const localStorageMatches = await page.evaluate((entries) => (
      entries.filter((entry) => localStorage.getItem(entry.name) === entry.value).length
    ), bundle.localStorage);
    const visibleCookies = await context.cookies(origin.href);
    const cookiesPersisted = bundle.cookies.every((expected) => visibleCookies.some((actual) => (
      actual.name === expected.name && actual.value === expected.value
    )));

    return {
      status: 'partial',
      cookieCount: cookies.length,
      localStorageCount: bundle.localStorage.length,
      sessionCookieRetentionHours: 12,
      verification: cookiesPersisted && localStorageMatches === bundle.localStorage.length
        ? 'storage_imported_not_login_verified'
        : 'storage_import_incomplete'
    };
  } finally {
    await closeWithTimeout(context).catch(() => {});
  }
}

if (typeof process.send === 'function') {
  let started = false;
  process.on('message', (message) => {
    if (message?.type !== 'import' || started) return;
    started = true;
    void runSessionImport(message.config)
      .then((result) => safeSend({ type: 'result', result }))
      .catch((error) => safeSend({
        type: 'error',
        error: {
          code: error?.code || 'SESSION_IMPORT_FAILED',
          message: String(error?.message || 'Session import failed').slice(0, 2_000)
        }
      }))
      .finally(() => {
        setTimeout(() => {
          if (process.connected) process.disconnect();
        }, 10);
      });
  });
}
