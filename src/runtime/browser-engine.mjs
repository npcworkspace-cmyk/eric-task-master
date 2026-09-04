function browserError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

export function chromeLaunchOptions(overrides = {}) {
  return {
    channel: 'chrome',
    headless: false,
    chromiumSandbox: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    ...overrides
  };
}

export async function launchChromeProfile(playwright, profile, overrides = {}) {
  if (!playwright?.chromium?.launchPersistentContext) {
    throw browserError('CHROME_UNAVAILABLE', 'The bundled Playwright runtime is unavailable');
  }
  if (typeof profile?.userDataDir !== 'string' || !profile.userDataDir) {
    throw browserError('PROFILE_PATH_UNAVAILABLE', 'The Chrome Profile path is unavailable');
  }
  try {
    return await playwright.chromium.launchPersistentContext(
      profile.userDataDir,
      chromeLaunchOptions(overrides)
    );
  } catch (cause) {
    throw browserError(
      'CHROME_LAUNCH_FAILED',
      'Stable Google Chrome could not open this Task Master Profile',
      cause
    );
  }
}
