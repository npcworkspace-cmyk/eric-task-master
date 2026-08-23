import { redactSensitiveText } from '../lib/redaction.mjs';

function safeSend(message) {
  if (typeof process.send !== 'function' || !process.connected) return;
  try {
    process.send(message, undefined, undefined, () => {});
  } catch {
    // Parent-side exit handling is authoritative.
  }
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

export async function runOpenProfile(profile, {
  loadPlaywright = () => import('playwright'),
  signal
} = {}) {
  let context = null;
  let heartbeat = null;
  try {
    const playwright = await loadPlaywright();
    const browserType = playwright[profile.browser || 'chromium'];
    if (!browserType?.launchPersistentContext) throw new Error('Unsupported Playwright browser');
    context = await browserType.launchPersistentContext(profile.userDataDir, {
      headless: false,
      ...(profile.browserChannel ? { channel: profile.browserChannel } : {}),
      ...(profile.launchOptions || {})
    });
    if (context.pages().length === 0) await context.newPage();
    safeSend({ type: 'ready' });
    heartbeat = setInterval(() => safeSend({ type: 'heartbeat', at: new Date().toISOString() }), 20_000);

    if (signal?.aborted) return;
    await new Promise((resolve) => {
      signal?.addEventListener('abort', resolve, { once: true });
      context.once?.('close', resolve);
    });
  } catch (error) {
    safeSend({
      type: 'error',
      error: {
        code: error?.code || 'PROFILE_OPEN_FAILED',
        message: redactSensitiveText(error?.message || 'Profile failed to open').slice(0, 2_000)
      }
    });
  } finally {
    clearInterval(heartbeat);
    await closeWithTimeout(context).catch(() => {});
    safeSend({ type: 'closed' });
  }
}

if (typeof process.send === 'function') {
  const controller = new AbortController();
  let started = false;
  process.on('message', (message) => {
    if (message?.type === 'open' && !started) {
      started = true;
      void runOpenProfile(message.profile, { signal: controller.signal }).finally(() => {
        setTimeout(() => {
          if (process.connected) process.disconnect();
        }, 10);
      });
    }
    if (message?.type === 'close') controller.abort();
  });
  process.on('disconnect', () => controller.abort());
}
