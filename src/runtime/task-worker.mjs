import { lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createActionHelper } from '../lib/behavior.mjs';
import { createCooldownHelper } from '../lib/cooldown.mjs';
import { createEffectJournal } from '../lib/effect-journal.mjs';
import { captureBoundedDiagnosticImage } from '../lib/diagnostic-screenshot.mjs';
import { createOutputBudget } from '../lib/output-budget.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';
import { createSemanticObserver } from '../lib/semantic-observer.mjs';
import { createUserHandoff } from '../lib/user-handoff.mjs';
import { writeCleanupReceipt } from '../lib/cleanup-receipt.mjs';

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;

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
  return writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

async function writeBufferAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readFrozenResumeCheckpoint(config) {
  const expected = config.resumeCheckpoint;
  if (
    !expected || typeof expected.path !== 'string' ||
    expected.sourceAttempt !== config.attempt - 1 || expected.targetAttempt !== config.attempt ||
    typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(expected.sha256) ||
    !Number.isSafeInteger(expected.sizeBytes) || expected.sizeBytes <= 0 ||
    expected.sizeBytes > MAX_CHECKPOINT_BYTES
  ) {
    const error = new Error('Frozen resume checkpoint contract is invalid');
    error.code = 'TASK_CHECKPOINT_INVALID';
    throw error;
  }
  let handle;
  try {
    const before = await lstat(expected.path, { bigint: true });
    if (
      !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      before.size !== BigInt(expected.sizeBytes)
    ) throw new Error('invalid frozen checkpoint');
    handle = await open(expected.path, 'r');
    const opened = await handle.stat({ bigint: true });
    if (!sameFileIdentity(before, opened) || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) {
      throw new Error('frozen checkpoint changed');
    }
    const source = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      !sameFileIdentity(opened, after) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs ||
      createHash('sha256').update(source).digest('hex') !== expected.sha256
    ) throw new Error('frozen checkpoint changed');
    const record = JSON.parse(source.toString('utf8'));
    if (
      !record || typeof record !== 'object' || Array.isArray(record) ||
      record.taskId !== config.taskId || record.attempt !== expected.sourceAttempt ||
      typeof record.savedAt !== 'string' || Number.isNaN(Date.parse(record.savedAt)) ||
      !Object.hasOwn(record, 'data')
    ) throw new Error('invalid frozen checkpoint record');
    return record;
  } catch (cause) {
    const error = new Error('Frozen resume checkpoint is unavailable or changed');
    error.code = 'TASK_CHECKPOINT_INVALID';
    error.cause = cause;
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
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
  if (!context) return true;
  if (typeof context.close !== 'function') return false;
  try {
    await withDeadline(context.close(), timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export async function closeTaskBrowserSession(context, browser, timeoutMs = 10_000) {
  const contextClosed = await closeTaskBrowserContext(context, timeoutMs);
  if (browser) {
    if (typeof browser.close !== 'function') return false;
    try {
      await withDeadline(browser.close(), timeoutMs);
      return true;
    } catch {
      return false;
    }
  }
  return contextClosed;
}

let activePage = null;
let activeProgress = { current: 0, total: null, message: 'Starting browser' };
let activeOutputBudget = null;
let activeSemantic = null;
let activeHandoff = null;
let activeDiagnosticsPath = null;
let activeDiagnostics = null;
let activeDiagnosticsWrite = Promise.resolve();

async function recordDiagnostic(kind, filePath, outputDir, reason) {
  if (!activeDiagnosticsPath || !['screenshot', 'observation'].includes(kind)) return;
  const relativePath = path.relative(outputDir, filePath);
  if (
    !relativePath || path.isAbsolute(relativePath) || relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`)
  ) return;
  const at = new Date().toISOString();
  activeDiagnostics = {
    ...(activeDiagnostics || {}),
    version: 2,
    updatedAt: at,
    [kind]: { relativePath, reason, at }
  };
  // The fixed task-root manifest closes the file-written/IPC-lost crash window.
  // Serialize writers so concurrent watchdog and action diagnostics cannot
  // replace a newer pointer with a stale snapshot.
  const snapshot = structuredClone(activeDiagnostics);
  activeDiagnosticsWrite = activeDiagnosticsWrite
    .catch(() => {})
    .then(() => writeJsonAtomic(activeDiagnosticsPath, snapshot));
  await activeDiagnosticsWrite;
}

async function captureFailure(
  page,
  outputDir,
  reason,
  outputBudget = activeOutputBudget,
  semantic = activeSemantic
) {
  if (!page || page.isClosed?.()) return null;
  const screenshotsDir = path.join(outputDir, 'screenshots');
  const safeReason = String(reason || 'failure').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48);
  const screenshotPath = path.join(screenshotsDir, `${Date.now()}-${safeReason}.jpg`);
  let releaseReservation = () => {};
  let captured = false;
  let result = null;
  try {
    await outputBudget?.assertSafeRoot?.();
    await mkdir(screenshotsDir, { recursive: true });
    releaseReservation = await outputBudget?.reserveDiagnostic?.(screenshotPath) || releaseReservation;
    const screenshot = await withDeadline(captureBoundedDiagnosticImage(page), 8_000);
    await writeBufferAtomic(screenshotPath, screenshot);
    captured = true;
    await recordDiagnostic('screenshot', screenshotPath, outputDir, safeReason);
    safeSend({ type: 'screenshot', path: screenshotPath, reason: safeReason });
    result = screenshotPath;
  } catch {
    result = null;
  } finally {
    if (!captured) releaseReservation();
  }
  if (semantic) {
    const observationsDir = path.join(outputDir, 'observations');
    const observationPath = path.join(observationsDir, `${Date.now()}-${safeReason}.json`);
    let releaseObservation = () => {};
    let observationCaptured = false;
    try {
      await outputBudget?.assertSafeRoot?.();
      await mkdir(observationsDir, { recursive: true });
      releaseObservation = await outputBudget?.reserveDiagnostic?.(observationPath) || releaseObservation;
      let snapshot;
      let unavailable = false;
      try {
        snapshot = await withDeadline(semantic.snapshot({
          scope: 'viewport',
          maxNodes: 120,
          maxTextChars: 8_000
        }), 8_000);
      } catch {
        // A transient or unsupported semantic tree must not make the entire
        // diagnostic disappear. Keep an explicit, credential-free record so
        // the Agent can use the screenshot and knows observation was unavailable.
        unavailable = true;
        snapshot = {
          id: null,
          url: null,
          title: '',
          content: '',
          refs: [],
          truncated: true,
          frameErrors: 1
        };
      }
      await writeJsonAtomic(observationPath, {
        reason: safeReason,
        capturedAt: new Date().toISOString(),
        snapshot,
        ...(unavailable ? {
          unavailable: true,
          error: { code: 'SEMANTIC_DIAGNOSTIC_UNAVAILABLE' }
        } : {})
      });
      observationCaptured = true;
      await recordDiagnostic('observation', observationPath, outputDir, safeReason);
      safeSend({ type: 'observation', path: observationPath, reason: safeReason });
    } catch {
      // A semantic diagnostic is best-effort and never hides the browser error.
    } finally {
      if (!observationCaptured) releaseObservation();
    }
  }
  return result;
}

function normalizeResult(result) {
  if (
    !result || typeof result !== 'object' || Array.isArray(result) ||
    typeof result.summary !== 'string' || !result.summary.trim() || result.summary.length > 4_000 ||
    !Array.isArray(result.evidence)
  ) {
    const error = new TypeError('Task module must return an object with summary and evidence');
    error.code = 'TASK_RESULT_INVALID';
    throw error;
  }
  const normalized = {
    summary: redactSensitiveText(result.summary),
    evidence: redactSensitiveValue(result.evidence)
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
  activePage = null;
  activeProgress = { current: 0, total: null, message: 'Starting browser' };
  activeOutputBudget = null;
  activeSemantic = null;
  activeHandoff = null;
  activeDiagnosticsPath = path.join(path.dirname(config.checkpointPath), 'diagnostics.json');
  activeDiagnostics = {
    version: 2,
    taskId: config.taskId,
    attempt: config.attempt
  };
  activeDiagnosticsWrite = Promise.resolve();
  const heartbeatMs = Number(config.heartbeatMs) || DEFAULT_HEARTBEAT_MS;
  const timeoutMs = Number(config.timeoutMs) || DEFAULT_TASK_TIMEOUT_MS;
  let context = null;
  let browser = null;
  let heartbeatTimer = null;
  let timeoutTimer = null;
  let lastScreenshot = null;
  let cancellationListener = null;
  let browserClosed = false;
  let outputBudget = null;
  let effectJournal = null;
  let frozenResumeRecord = null;
  let resumeCheckpointConsumed = false;
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
  const timeoutPromise = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => {
      const error = new TaskTimeoutError(timeoutMs);
      if (!executionSignal.aborted) executionController.abort(error);
      reject(error);
    }, timeoutMs);
  });
  timeoutPromise.catch(() => {});
  const cancellationPromise = signal
    ? new Promise((_, reject) => {
      cancellationListener = () => reject(new TaskCancelledError());
      if (signal.aborted) cancellationListener();
      else signal.addEventListener('abort', cancellationListener, { once: true });
    })
    : new Promise(() => {});
  cancellationPromise.catch(() => {});
  const awaitExecution = (promise) => Promise.race([promise, timeoutPromise, cancellationPromise]);

  const emitHeartbeat = () => safeSend({
    type: 'heartbeat',
    at: new Date().toISOString(),
    progress: activeProgress
  });
  heartbeatTimer = setInterval(emitHeartbeat, heartbeatMs);
  emitHeartbeat();

  try {
    await awaitExecution(mkdir(config.outputDir, { recursive: true }));
    await awaitExecution(mkdir(path.dirname(config.checkpointPath), { recursive: true }));
    if (config.resumeCheckpoint) {
      frozenResumeRecord = await awaitExecution(readFrozenResumeCheckpoint(config));
    }
    if (executionSignal.aborted) throw new TaskCancelledError();
    outputBudget = await awaitExecution(createOutputBudget({
      root: config.outputDir,
      limits: config.outputBudget
    }));
    activeOutputBudget = outputBudget;
    await awaitExecution(outputBudget.assertWithinBudget());
    stopBudgetChecks = outputBudget.startPeriodic((error) => {
      if (budgetFailure) return;
      budgetFailure = error;
      rejectBudget(error);
    });
    effectJournal = await awaitExecution(createEffectJournal({
      filePath: path.join(path.dirname(config.checkpointPath), 'effect-journal.jsonl')
    }));
    const guardResumeEffectResolution = (sequence, observedOutcome) => {
      if (config.resumeCheckpoint && !resumeCheckpointConsumed) {
        const error = new Error('Consume the frozen checkpoint before resolving an unknown effect');
        error.code = 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED';
        throw error;
      }
      return effectJournal.resolveUnknown(sequence, observedOutcome);
    };
    const effects = Object.freeze({
      pending: () => effectJournal.pending(),
      resolveUnknown: guardResumeEffectResolution
    });

    safeSend({ type: 'state', state: 'starting_browser' });
    const playwright = await awaitExecution(loadPlaywright());
    const browserName = config.profile.browser || 'chromium';
    const browserType = playwright[browserName];
    const profileKind = config.profile.kind || 'persistent';
    if (
      (profileKind === 'persistent' && !browserType?.launchPersistentContext) ||
      (profileKind === 'ephemeral' && !browserType?.launch)
    ) {
      const error = new Error(`Unsupported Playwright browser: ${browserName}`);
      error.code = 'BROWSER_UNSUPPORTED';
      throw error;
    }

    const launchOptions = {
      headless: config.profile.headless ?? false,
      ...(config.profile.browserChannel ? { channel: config.profile.browserChannel } : {}),
      ...(config.profile.launchOptions || {})
    };
    if (profileKind === 'ephemeral') {
      browser = await awaitExecution(browserType.launch(launchOptions));
      context = await awaitExecution(browser.newContext({
        serviceWorkers: 'block',
        ...(config.profile.contextOptions || {})
      }));
    } else {
      context = await awaitExecution(browserType.launchPersistentContext(config.profile.userDataDir, launchOptions));
    }
    const pages = context.pages();
    const page = pages[0] || await awaitExecution(context.newPage());
    activePage = page;

    const progress = async ({ current, total = null, message }) => {
      await outputBudget.assertWithinBudget();
      const normalizedCurrent = Number(current);
      const normalizedTotal = total === null ? null : Number(total);
      const previousTotal = activeProgress.total === null ? null : Number(activeProgress.total);
      if (!Number.isFinite(normalizedCurrent) || normalizedCurrent < 0) {
        throw new TypeError('progress.current must be a non-negative number');
      }
      if (normalizedCurrent < activeProgress.current) {
        const error = new TypeError('progress.current cannot move backwards within an attempt');
        error.code = 'TASK_PROGRESS_INVALID';
        throw error;
      }
      if (normalizedTotal !== null && (!Number.isFinite(normalizedTotal) || normalizedTotal < normalizedCurrent)) {
        throw new TypeError('progress.total must be null or a number greater than or equal to current');
      }
      if (previousTotal !== null && (normalizedTotal === null || normalizedTotal < previousTotal)) {
        const error = new TypeError('progress.total cannot be removed or reduced within an attempt');
        error.code = 'TASK_PROGRESS_INVALID';
        throw error;
      }
      if (!String(message || '').trim()) throw new TypeError('progress.message is required');
      activeProgress = {
        current: normalizedCurrent,
        total: normalizedTotal,
        message: String(message).slice(0, 500)
      };
      safeSend({ type: 'progress', progress: activeProgress, at: new Date().toISOString() });
    };

    let checkpointWrittenThisAttempt = false;
    const checkpoint = async (data) => {
      if (config.resumeCheckpoint && !resumeCheckpointConsumed) {
        const error = new Error('Consume the frozen checkpoint before writing a new checkpoint');
        error.code = 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED';
        throw error;
      }
      await outputBudget.assertWithinBudget();
      const record = {
        taskId: config.taskId,
        attempt: config.attempt,
        savedAt: new Date().toISOString(),
        data
      };
      const encoded = `${JSON.stringify(record, null, 2)}\n`;
      if (Buffer.byteLength(encoded) > MAX_CHECKPOINT_BYTES) {
        const error = new Error('Task checkpoint exceeds 8 MiB; persist bulk data under outputDir');
        error.code = 'TASK_CHECKPOINT_TOO_LARGE';
        throw error;
      }
      await writeTextAtomic(config.checkpointPath, encoded);
      checkpointWrittenThisAttempt = true;
      safeSend({
        type: 'checkpoint',
        path: config.checkpointPath,
        attempt: config.attempt,
        savedAt: record.savedAt,
        sha256: createHash('sha256').update(encoded).digest('hex'),
        sizeBytes: Buffer.byteLength(encoded)
      });
      return record;
    };
    checkpoint.read = async () => {
      try {
        const readingFrozenResume = Boolean(config.resumeCheckpoint && !checkpointWrittenThisAttempt);
        const record = readingFrozenResume
          ? frozenResumeRecord
          : JSON.parse(await readFile(config.checkpointPath, 'utf8'));
        if (
          !record || typeof record !== 'object' || Array.isArray(record) ||
          record.taskId !== config.taskId ||
          !Number.isSafeInteger(record.attempt) ||
          ![config.attempt - 1, config.attempt].includes(record.attempt) ||
          typeof record.savedAt !== 'string' || !Object.hasOwn(record, 'data')
        ) {
          const error = new Error('Task checkpoint is invalid');
          error.code = 'TASK_CHECKPOINT_INVALID';
          throw error;
        }
        if (readingFrozenResume) resumeCheckpointConsumed = true;
        return record.data;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    };

    let semantic;
    const rawAction = createActionHelper({
      page,
      mode: config.behavior,
      abortSignal: executionSignal,
      onEffect: (event) => effectJournal.record(event),
      onAdaptiveState: (state) => safeSend({
        type: 'behavior',
        behavior: {
          configured: config.behavior,
          effective: state.level >= 2 ? 'human' : state.level === 1 ? 'cautious' : 'fast',
          adaptive: state,
          at: new Date().toISOString()
        }
      }),
      onFailure: async ({ operation }) => {
        lastScreenshot = await captureFailure(page, config.outputDir, `action-${operation}`, outputBudget);
      }
    });
    const guardResumeAction = (method) => (...args) => {
      if (!resumeCheckpointConsumed) {
        const error = new Error('Consume the frozen checkpoint before issuing browser actions');
        error.code = 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED';
        throw error;
      }
      return rawAction[method](...args);
    };
    const action = config.resumeCheckpoint
      ? Object.freeze({
        get mode() { return rawAction.mode; },
        get effectiveMode() { return rawAction.effectiveMode; },
        get adaptiveState() { return rawAction.adaptiveState; },
        signal: (...args) => rawAction.signal(...args),
        run: guardResumeAction('run'),
        goto: guardResumeAction('goto'),
        click: guardResumeAction('click'),
        fill: guardResumeAction('fill'),
        type: guardResumeAction('type'),
        hover: guardResumeAction('hover'),
        scroll: guardResumeAction('scroll'),
        read: (...args) => rawAction.read(...args),
        wait: (...args) => rawAction.wait(...args)
      })
      : rawAction;
    semantic = createSemanticObserver({ page, action });
    activeSemantic = semantic;
    const handoff = createUserHandoff({
      signal: executionSignal,
      capture: (reason) => captureFailure(page, config.outputDir, reason, outputBudget, semantic),
      onRequest: async (request) => safeSend({ type: 'waiting_user', request }),
      onState: async (state) => safeSend({ type: 'state', state }),
      onProgress: async (message) => progress({
        current: activeProgress.current,
        total: activeProgress.total,
        message
      })
    });
    activeHandoff = handoff;
    const cooldown = createCooldownHelper({
      signal: executionSignal,
      onSignal: (kind) => action.signal(kind),
      onCooldown: async (record) => safeSend({ type: 'cooldown', cooldown: record }),
      onState: async (state) => safeSend({ type: 'state', state }),
      onProgress: async ({ durationMs, resumeAt, reason }) => progress({
        current: activeProgress.current,
        total: activeProgress.total,
        message: `${reason}; resume at ${resumeAt} (${durationMs}ms)`
      })
    });

    const taskUrl = pathToFileURL(config.modulePath);
    const taskModule = await awaitExecution(import(`${taskUrl.href}?task=${encodeURIComponent(config.taskId)}`));
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
      semantic,
      handoff,
      progress,
      checkpoint,
      signal: executionSignal
    }));
    taskPromise.catch(() => {});

    const rawResult = await Promise.race([taskPromise, timeoutPromise, cancellationPromise, budgetPromise]);
    if (config.resumeCheckpoint && !resumeCheckpointConsumed) {
      const error = new Error('Resumed task did not consume its frozen checkpoint');
      error.code = 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED';
      throw error;
    }
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
    browserClosed = await closeTaskBrowserSession(context, browser);
    let cleanupReceiptWritten = false;
    if (browserClosed && config.cleanupReceiptPath) {
      try {
        await writeCleanupReceipt(config.cleanupReceiptPath, {
          kind: 'task',
          taskId: config.taskId,
          attempt: config.attempt
        });
        cleanupReceiptWritten = true;
      } catch {
        // The live Manager may still confirm cleanup through IPC. After a
        // Manager crash, absence of this receipt intentionally blocks resume.
      }
    }
    activePage = null;
    activeOutputBudget = null;
    activeSemantic = null;
    activeHandoff?.cancel();
    activeHandoff = null;
    activeDiagnosticsPath = null;
    activeDiagnostics = null;
    safeSend({
      type: 'cleanup',
      browserClosed,
      cleanupReceiptWritten,
      at: new Date().toISOString()
    });
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
    if (message?.type === 'continue') {
      void activeHandoff?.continue({ requestId: message.requestId, note: message.note });
    }
    if (message?.type === 'diagnose') {
      void captureFailure(activePage, message.outputDir, message.reason || 'diagnostic').finally(() => {
        safeSend({ type: 'heartbeat', at: new Date().toISOString(), progress: activeProgress });
      });
    }
  });

  process.on('disconnect', () => controller.abort());
}
