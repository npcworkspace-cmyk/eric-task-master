import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createActionHelper } from '../lib/behavior.mjs';

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

class TaskCancelledError extends Error {
  constructor() {
    super('Task was cancelled');
    this.name = 'TaskCancelledError';
    this.code = 'TASK_CANCELLED';
  }
}

class TaskTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Task exceeded its ${timeoutMs}ms timeout`);
    this.name = 'TaskTimeoutError';
    this.code = 'TASK_TIMEOUT';
  }
}

function safeSend(message) {
  if (typeof process.send !== 'function' || !process.connected) return;
  try {
    process.send(message, undefined, undefined, () => {});
  } catch {
    // The parent owns crash detection when the IPC channel is already gone.
  }
}

function errorPayload(error, screenshot = null) {
  const message = String(error?.message || 'Task failed')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:access_token|api_key|auth|password|session|token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1[REDACTED]');
  return {
    code: error?.code || 'TASK_FAILED',
    message: message.slice(0, 2_000),
    ...(screenshot ? { screenshot } : {})
  };
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function withDeadline(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Diagnostic operation timed out')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

let activePage = null;
let activeProgress = { current: 0, total: null, message: 'Starting browser' };

async function captureFailure(page, outputDir, reason) {
  if (!page || page.isClosed?.()) return null;
  const screenshotsDir = path.join(outputDir, 'screenshots');
  await mkdir(screenshotsDir, { recursive: true });
  const safeReason = String(reason || 'failure').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48);
  const screenshotPath = path.join(screenshotsDir, `${Date.now()}-${safeReason}.png`);
  try {
    await withDeadline(page.screenshot({ path: screenshotPath, fullPage: false }), 8_000);
    safeSend({ type: 'screenshot', path: screenshotPath, reason: safeReason });
    return screenshotPath;
  } catch {
    return null;
  }
}

function normalizeResult(result) {
  if (result === undefined) return { summary: 'Task completed', evidence: [] };
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    const error = new TypeError('Task module must return an object with summary and evidence');
    error.code = 'TASK_RESULT_INVALID';
    throw error;
  }
  const normalized = {
    summary: String(result.summary || 'Task completed').slice(0, 4_000),
    evidence: Array.isArray(result.evidence) ? result.evidence : []
  };
  const encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > 256 * 1024) {
    const error = new Error('Task result exceeds 256 KiB; persist large data under outputDir');
    error.code = 'TASK_RESULT_TOO_LARGE';
    throw error;
  }
  return normalized;
}

export async function runTaskWorker(config, {
  loadPlaywright = () => import('playwright'),
  signal
} = {}) {
  const heartbeatMs = Number(config.heartbeatMs) || DEFAULT_HEARTBEAT_MS;
  const timeoutMs = Number(config.timeoutMs) || DEFAULT_TASK_TIMEOUT_MS;
  let context = null;
  let heartbeatTimer = null;
  let timeoutTimer = null;
  let lastScreenshot = null;

  await mkdir(config.outputDir, { recursive: true });
  await mkdir(path.dirname(config.checkpointPath), { recursive: true });

  const emitHeartbeat = () => safeSend({
    type: 'heartbeat',
    at: new Date().toISOString(),
    progress: activeProgress
  });
  heartbeatTimer = setInterval(emitHeartbeat, heartbeatMs);
  emitHeartbeat();

  try {
    if (signal?.aborted) throw new TaskCancelledError();
    safeSend({ type: 'state', state: 'starting_browser' });
    const playwright = await loadPlaywright();
    const browserName = config.profile.browser || 'chromium';
    const browserType = playwright[browserName];
    if (!browserType?.launchPersistentContext) {
      const error = new Error(`Unsupported Playwright browser: ${browserName}`);
      error.code = 'BROWSER_UNSUPPORTED';
      throw error;
    }

    const launchOptions = {
      headless: config.profile.headless ?? false,
      ...(config.profile.browserChannel ? { channel: config.profile.browserChannel } : {}),
      ...(config.profile.launchOptions || {})
    };
    context = await browserType.launchPersistentContext(config.profile.userDataDir, launchOptions);
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    activePage = page;

    const onAbort = () => {
      void context?.close().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const progress = async ({ current, total = null, message }) => {
      const normalizedCurrent = Number(current);
      const normalizedTotal = total === null ? null : Number(total);
      if (!Number.isFinite(normalizedCurrent) || normalizedCurrent < 0) {
        throw new TypeError('progress.current must be a non-negative number');
      }
      if (normalizedTotal !== null && (!Number.isFinite(normalizedTotal) || normalizedTotal < normalizedCurrent)) {
        throw new TypeError('progress.total must be null or a number greater than or equal to current');
      }
      if (!String(message || '').trim()) throw new TypeError('progress.message is required');
      activeProgress = {
        current: normalizedCurrent,
        total: normalizedTotal,
        message: String(message).slice(0, 500)
      };
      safeSend({ type: 'progress', progress: activeProgress, at: new Date().toISOString() });
    };

    const checkpoint = async (data) => {
      const record = { savedAt: new Date().toISOString(), data };
      await writeJsonAtomic(config.checkpointPath, record);
      safeSend({ type: 'checkpoint', path: config.checkpointPath, savedAt: record.savedAt });
      return record;
    };
    checkpoint.read = async () => {
      try {
        return JSON.parse(await readFile(config.checkpointPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    };

    const action = createActionHelper({
      page,
      mode: config.behavior,
      onFailure: async ({ operation }) => {
        lastScreenshot = await captureFailure(page, config.outputDir, `action-${operation}`);
      }
    });

    const taskUrl = pathToFileURL(config.modulePath);
    const taskModule = await import(`${taskUrl.href}?task=${encodeURIComponent(config.taskId)}`);
    if (typeof taskModule.run !== 'function') {
      const error = new TypeError('Task module must export async function run(runtime)');
      error.code = 'TASK_MODULE_INVALID';
      throw error;
    }

    safeSend({ type: 'state', state: 'running', meta: taskModule.meta || null });
    await progress({ current: 0, total: null, message: 'Task started' });

    const taskPromise = Promise.resolve().then(() => taskModule.run({
      page,
      context,
      input: config.input,
      outputDir: config.outputDir,
      action,
      progress,
      checkpoint,
      signal
    }));
    taskPromise.catch(() => {});

    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new TaskTimeoutError(timeoutMs)), timeoutMs);
    });
    const cancellationPromise = signal
      ? new Promise((_, reject) => signal.addEventListener('abort', () => reject(new TaskCancelledError()), { once: true }))
      : new Promise(() => {});

    const result = normalizeResult(await Promise.race([taskPromise, timeoutPromise, cancellationPromise]));
    safeSend({ type: 'state', state: 'verifying' });
    safeSend({ type: 'result', result });
    safeSend({ type: 'state', state: 'completed' });
    return { state: 'completed', result };
  } catch (error) {
    const cancelled = error instanceof TaskCancelledError || error?.code === 'TASK_CANCELLED';
    if (!cancelled && !lastScreenshot) {
      lastScreenshot = await captureFailure(activePage, config.outputDir, error?.code || 'task-failure');
    }
    const state = cancelled ? 'cancelled' : 'failed';
    safeSend({ type: 'error', state, error: errorPayload(error, lastScreenshot) });
    safeSend({ type: 'state', state });
    return { state, error: errorPayload(error, lastScreenshot) };
  } finally {
    clearInterval(heartbeatTimer);
    clearTimeout(timeoutTimer);
    try {
      await withDeadline(context?.close?.() || Promise.resolve(), 10_000);
    } catch {
      // The worker process exit is the final cleanup boundary.
    }
    activePage = null;
    safeSend({ type: 'cleanup', browserClosed: true, at: new Date().toISOString() });
  }
}

if (typeof process.send === 'function') {
  let started = false;
  const controller = new AbortController();

  process.on('message', (message) => {
    if (message?.type === 'start' && !started) {
      started = true;
      void runTaskWorker(message.config, { signal: controller.signal }).finally(() => {
        setTimeout(() => {
          if (process.connected) process.disconnect();
        }, 10);
      });
      return;
    }
    if (message?.type === 'cancel') controller.abort();
    if (message?.type === 'diagnose') {
      void captureFailure(activePage, message.outputDir, message.reason || 'diagnostic').finally(() => {
        safeSend({ type: 'heartbeat', at: new Date().toISOString(), progress: activeProgress });
      });
    }
  });

  process.on('disconnect', () => controller.abort());
}
