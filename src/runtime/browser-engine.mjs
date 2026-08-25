function engineError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function resolveBrowserEngine(playwright, profile = {}) {
  const browserType = playwright?.chromium;
  if (!browserType) {
    throw engineError('BROWSER_UNSUPPORTED', 'Playwright Chromium is unavailable');
  }
  if (profile.browserEngine === 'chrome') {
    return { browserType, launchOptions: { channel: 'chrome' } };
  }
  if (profile.browserEngine === 'chromium') {
    return { browserType, launchOptions: {} };
  }
  throw engineError(
    'BROWSER_ENGINE_UNSUPPORTED',
    `Unsupported Profile browser engine: ${String(profile.browserEngine)}`
  );
}
