import { redactSensitiveText } from '../lib/redaction.mjs';
import { writeCleanupReceipt } from '../lib/cleanup-receipt.mjs';

function safeSend(message) {
  if (typeof process.send !== 'function' || !process.connected) return;
  try {
    process.send(message, undefined, undefined, () => {});
  } catch {
    // Parent-side exit handling is authoritative.
  }
}

async function withDeadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Profile browser cleanup timed out')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeProfileBrowserSession(context, timeoutMs = 10_000) {
  if (!context) return true;
  const browser = context.browser?.() || null;
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

export async function runOpenProfile(profile, {
  loadPlaywright = () => import('playwright'),
  signal,
  cleanupReceiptPath = null,
  cleanupReceipt = null
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
    const browserClosed = await closeProfileBrowserSession(context);
    let cleanupReceiptWritten = false;
    if (browserClosed && cleanupReceiptPath && cleanupReceipt) {
      try {
        await writeCleanupReceipt(cleanupReceiptPath, cleanupReceipt);
        cleanupReceiptWritten = true;
      } catch {
        // The parent can still confirm a live IPC cleanup. A restarted Manager
        // deliberately refuses to release the Profile without this receipt.
      }
    }
    if (!browserClosed) {
      safeSend({
        type: 'error',
        error: {
          code: 'PROFILE_CLEANUP_UNCONFIRMED',
          message: 'Profile browser cleanup could not be confirmed'
        }
      });
    }
    safeSend({ type: 'closed', browserClosed, cleanupReceiptWritten });
  }
}

if (typeof process.send === 'function') {
  const controller = new AbortController();
  let started = false;
  process.on('message', (message) => {
    if (message?.type === 'open' && !started) {
      started = true;
      void runOpenProfile(message.profile, {
        signal: controller.signal,
        cleanupReceiptPath: message.cleanupReceiptPath,
        cleanupReceipt: message.cleanupReceipt
      }).finally(() => {
        setTimeout(() => {
          if (process.connected) process.disconnect();
        }, 10);
      });
    }
    if (message?.type === 'close') controller.abort();
  });
  process.on('disconnect', () => controller.abort());
}
