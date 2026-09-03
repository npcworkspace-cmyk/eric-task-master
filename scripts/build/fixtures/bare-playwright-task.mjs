import { chromium } from 'playwright';

export async function run({ progress }) {
  if (typeof chromium?.launchPersistentContext !== 'function') {
    throw new Error('Playwright chromium API is unavailable');
  }
  if (process.env.NODE_OPTIONS || process.env.NODE_PATH) {
    throw new Error('Host Node injection reached the installed task Worker');
  }
  await progress({ current: 1, total: 1, message: 'Bare Playwright import passed' });
  return { barePlaywrightImport: true, hostNodeInjectionIsolated: true };
}
