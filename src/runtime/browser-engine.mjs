function engineError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function resolveBrowserEngine(playwright, profile = {}) {
  const browserType = playwright?.chromium;
  if (!browserType) {
    throw engineError('BROWSER_UNSUPPORTED', 'Playwright Chromium is unavailable');
  }
  const extensionsEnabled = profile.extensionsEnabled ?? (profile.headless !== true);
  if (profile.kind === 'ephemeral' && extensionsEnabled) {
    throw engineError(
      'EPHEMERAL_PROFILE_EXTENSIONS_UNSUPPORTED',
      'Ephemeral Profiles cannot run browser extensions'
    );
  }
  if (profile.kind !== 'ephemeral' && extensionsEnabled && profile.headless === true) {
    throw engineError(
      'PROFILE_EXTENSIONS_HEADLESS_CONFLICT',
      'Browser extensions require a visible persistent Profile'
    );
  }
  const extensionLaunchOptions = profile.kind !== 'ephemeral' && extensionsEnabled
    ? { ignoreDefaultArgs: ['--disable-extensions'] }
    : {};
  if (profile.browserEngine === 'chrome') {
    return { browserType, launchOptions: { channel: 'chrome', ...extensionLaunchOptions } };
  }
  if (profile.browserEngine === 'chromium') {
    return { browserType, launchOptions: extensionLaunchOptions };
  }
  throw engineError(
    'BROWSER_ENGINE_UNSUPPORTED',
    `Unsupported Profile browser engine: ${String(profile.browserEngine)}`
  );
}
