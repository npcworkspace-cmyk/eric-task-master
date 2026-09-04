import { chromium } from 'playwright';

export async function run({ context, progress }) {
  if (typeof chromium?.launchPersistentContext !== 'function') {
    throw new Error('Playwright chromium API is unavailable');
  }
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH) {
    throw new Error('Host Node injection reached the installed task Worker');
  }
  const versionPage = await context.newPage();
  try {
    await versionPage.goto('chrome://version/', { waitUntil: 'domcontentloaded' });
    const commandLine = await versionPage.locator('#command_line').innerText();
    if (!commandLine.includes('--remote-debugging-pipe') || /(?:^|\s)--no-sandbox(?:[=\s]|$)/u.test(commandLine)) {
      throw new Error('Installed Chrome must not run with --no-sandbox');
    }
  } finally {
    await versionPage.close();
  }
  await progress({ current: 1, total: 1, message: 'Bare Playwright import passed' });
  return { barePlaywrightImport: true, hostNodeInjectionIsolated: true, sandboxEnabled: true };
}
