export function playwrightInstallArguments(cliPath, platform = process.platform) {
  if (typeof cliPath !== 'string' || !cliPath) throw new TypeError('Playwright CLI path is required');
  return [
    cliPath,
    'install',
    ...(platform === 'linux' ? ['--with-deps'] : []),
    'chromium'
  ];
}

export function bootstrapNextAction(error, platform = process.platform) {
  if (error?.code === 'BROWSER_INSTALL_FAILED' && platform === 'linux') {
    return 'Allow Playwright to install Chromium and its Linux system packages, then rerun the exact same connect command once.';
  }
  return 'Confirm network access and Node.js 20+, then rerun the exact same connect command once.';
}
