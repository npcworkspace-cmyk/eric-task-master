import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createActionHelper } from '../lib/behavior.mjs';
import { createCooldownHelper } from '../lib/cooldown.mjs';
import { createEffectJournal } from '../lib/effect-journal.mjs';
import { createOutputBudget } from '../lib/output-budget.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';

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
  const message = redactSensitiveText(error?.message || 'Task failed');
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

export async function closeTaskBrowserContext(context, timeoutMs = 10_000) {
  try {
    await withDeadline(context?.close?.() || Promise.resolve(), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

let activePage = null;
let activeProgress = { current: 0, total: null, message: 'Starting browser' };
let activeOutputBudget = null;

async function captureFailure(page, outputDir, reason, outputBudget = activeOutputBudget) {
  if (!page || page.isClosed?.()) return null;
  const screenshotsDir = path.join(outputDir, 'screenshots');
  const safeReason = String(reason || 'failure').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48);
  const screenshotPath = path.join(screenshotsDir, `${Date.now()}-${safeReason}.png`);
  let releaseReservation = () => {};
  let captured = false;
  try {
    await outputBudget?.assertSafeRoot?.();
    await mkdir(screenshotsDir, { recursive: true });
    releaseReservation = await outputBudget?.reserveDiagnostic?.(screenshotPath) || releaseReservation;
    await withDeadline(page.screenshot({ path: screenshotPath, fullPage: false }), 8_000);
    captured = true;
    safeSend({ type: 'screenshot', path: screenshotPath, reason: safeReason });
    return screenshotPath;
  } catch {
    return null;
  } finally {
    if (!captured) releaseReservation();
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
    summary: redactSensitiveText(result.summary || 'Task completed').slice(0, 4_000),
    evidence: Array.isArray(result.evidence) ? redactSensitiveValue(result.evidence) : []
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
  let cancellationListener = null;
  let browserClosed = false;
  let outputBudget = null;
  let effectJournal = null;
  let stopBudgetChecks = () => {};
  let rejectBudget;
  let budgetFailure = null;
  const budgetPromise = new Promise((_, reject) => {
    rejectBudget = reject;
  });
  // The periodic check can fire before the task promise is installed in its
  // race. Keep that rejection observed while preserving it for the race below.
  budgetPromise.catch(() => {});
  const executionController = new AbortController();
  const forwardCancellation = () => {
    if (!executionController.signal.aborted) {
      executionController.abort(signal?.reason instanceof Error ? signal.reason : new TaskCancelledError());
    }
  };
  if (signal?.aborted) forwardCancellation();
  else signal?.addEventListener('abort', forwardCancellation, { once: true });
  const executionSignal = executionController.signal;

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
    if (executionSignal.aborted) throw new TaskCancelledError();
    outputBudget = await createOutputBudget({
      root: config.outputDir,
      limits: config.outputBudget
    });
    activeOutputBudget = outputBudget;
    await outputBudget.assertWithinBudget();
    stopBudgetChecks = outputBudget.startPeriodic((error) => {
      if (budgetFailure) return;
      budgetFailure = error;
      rejectBudget(error);
    });
    effectJournal = await createEffectJournal({
      filePath: path.join(path.dirname(config.checkpointPath), 'effect-journal.jsonl')
    });
    const effects = Object.freeze({
      pending: () => effectJournal.pending(),
      resolveUnknown: (sequence, observedOutcome) => effectJournal.resolveUnknown(sequence, observedOutcome)
    });

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

    const progress = async ({ current, total = null, message }) => {
      await outputBudget.assertWithinBudget();
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
      await outputBudget.assertWithinBudget();
      const record = { savedAt: new Date().toISOString(), data };
      await writeJsonAtomic(config.checkpointPath, record);
      safeSend({ type: 'checkpoint', path: config.checkpointPath, savedAt: record.savedAt });
      return record;
    };
    checkpoint.read = async () => {
      try {
        const record = JSON.parse(await readFile(config.checkpointPath, 'utf8'));
        if (
          !record || typeof record !== 'object' || Array.isArray(record) ||
          typeof record.savedAt !== 'string' || !Object.hasOwn(record, 'data')
        ) {
          const error = new Error('Task checkpoint is invalid');
          error.code = 'TASK_CHECKPOINT_INVALID';
          throw error;
        }
        return record.data;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    };

    const action = createActionHelper({
      page,
      mode: config.behavior,
      abortSignal: executionSignal,
      onEffect: (event) => effectJournal.record(event),
      onFailure: async ({ operation }) => {
        lastScreenshot = await captureFailure(page, config.outputDir, `action-${operation}`, outputBudget);
      }
    });
    const cooldown = createCooldownHelper({
      signal: executionSignal,
      onSignal: (kind) => action.signal(kind),
      onState: async (state) => safeSend({ type: 'state', state }),
      onProgress: async ({ durationMs, resumeAt, reason }) => progress({
        current: activeProgress.current,
        total: activeProgress.total,
        message: `${reason}; resume at ${resumeAt} (${durationMs}ms)`
      })
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
      cooldown,
      effects,
      progress,
      checkpoint,
      signal: executionSignal
    }));
    taskPromise.catch(() => {});

    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        const error = new TaskTimeoutError(timeoutMs);
        reject(error);
      }, timeoutMs);
    });
    const cancellationPromise = signal
      ? new Promise((_, reject) => {
        cancellationListener = () => reject(new TaskCancelledError());
        if (signal.aborted) cancellationListener();
        else signal.addEventListener('abort', cancellationListener, { once: true });
      })
      : new Promise(() => {});

    const rawResult = await Promise.race([taskPromise, timeoutPromise, cancellationPromise, budgetPromise]);
    await outputBudget.assertWithinBudget();
    await effectJournal.assertSettled();
    const result = normalizeResult(rawResult);
    safeSend({ type: 'state', state: 'verifying' });
    safeSend({ type: 'result', result });
    safeSend({ type: 'state', state: 'completed' });
    return { state: 'completed', result };
  } catch (error) {
    // Stop cooperative task code and reject every new action before diagnostic
    // work begins. The browser stays open only long enough for the bounded
    // screenshot, then finally closes it unconditionally.
    if (!executionSignal.aborted) executionController.abort(error);
    const cancelled = error instanceof TaskCancelledError || error?.code === 'TASK_CANCELLED';
    if (!cancelled && !lastScreenshot) {
      lastScreenshot = await captureFailure(
        activePage,
        config.outputDir,
        error?.code || 'task-failure',
        outputBudget
      );
    }
    const state = cancelled ? 'cancelled' : 'failed';
    safeSend({ type: 'error', state, error: errorPayload(error, lastScreenshot) });
    safeSend({ type: 'state', state });
    return { state, error: errorPayload(error, lastScreenshot) };
  } finally {
    stopBudgetChecks();
    clearInterval(heartbeatTimer);
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', forwardCancellation);
    if (cancellationListener) signal?.removeEventListener('abort', cancellationListener);
    // Freeze the durable effect boundary before aborting module work. An action
    // that resumes only because cleanup fired must not overwrite a pending
    // unknown outcome with a misleading terminal record.
    await effectJournal?.close?.().catch(() => {});
    if (!executionSignal.aborted) executionController.abort(new TaskCancelledError());
    browserClosed = await closeTaskBrowserContext(context);
    activePage = null;
    activeOutputBudget = null;
    safeSend({ type: 'cleanup', browserClosed, at: new Date().toISOString() });
  }
}

if (typeof process.send === 'function') {
  let started = false;
  const controller = new AbortController();

  process.on('message', (message) => {
    if (message?.type === 'start' && !started) {
      started = true;
      void runTaskWorker(message.config, { signal: controller.signal }).finally(() => {
        // A trusted task module may leave timers or handles alive after it times
        // out. The child process is the isolation boundary, so it must exit after
        // browser cleanup instead of allowing module code to outlive terminal state.
        if (process.connected) process.disconnect();
        setTimeout(() => process.exit(0), 100);
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
