import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOutputBudget } from '../lib/output-budget.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';
import { launchChromeProfile } from './browser-engine.mjs';

const notWaiting = () => ({ accepted: false, waitId: null, reason: 'TASK_NOT_WAITING' });
let externalResume = notWaiting;
let activeCleanupAck = null;

class TaskStoppedError extends Error {
  constructor() {
    super('Task stopped');
    this.code = 'TASK_STOPPED';
  }
}

function send(message) {
  if (!process.connected || typeof process.send !== 'function') return;
  try {
    process.send(message, undefined, undefined, () => {});
  } catch {
    // Parent process exit is also observed through disconnect.
  }
}

function sendCleanupWithAck(message, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    if (!process.connected || typeof process.send !== 'function') return resolve(false);
    const cleanupId = `cleanup_${randomUUID().replaceAll('-', '')}`;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeCleanupAck?.id === cleanupId) activeCleanupAck = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    activeCleanupAck = { id: cleanupId, finish };
    try {
      process.send({ ...message, cleanupId }, undefined, undefined, (error) => {
        if (error) finish(false);
      });
    } catch {
      finish(false);
    }
  });
}

function safeJson(value, { maximumBytes = 1024 * 1024 } = {}) {
  if (value === undefined) return null;
  let encoded;
  try {
    encoded = JSON.stringify(redactSensitiveValue(value));
  } catch {
    return { warning: 'Task returned a non-serializable value; files and progress were preserved.' };
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > maximumBytes) {
    return { warning: 'Task returned more than 1 MiB; persist large results under outputDir.' };
  }
  return JSON.parse(encoded);
}

function normalizeTaskError(error, { stopped = false, screenshot = null } = {}) {
  const payload = {
    code: stopped ? 'TASK_STOPPED' : String(error?.code || 'TASK_FAILED').slice(0, 100),
    message: redactSensitiveText(error?.message || (stopped ? 'Task stopped' : 'Task failed')).slice(0, 4_000),
    ...(error?.details === undefined ? {} : {
      details: safeJson(error.details, { maximumBytes: 64 * 1024 })
    }),
    ...(error?.nextAction === undefined ? {} : {
      nextAction: redactSensitiveText(String(error.nextAction)).slice(0, 2_000)
    }),
    ...(error?.cause ? {
      cause: {
        code: String(error.cause.code || 'ERROR').slice(0, 100),
        message: redactSensitiveText(error.cause.message || 'Underlying operation failed').slice(0, 2_000)
      }
    } : {}),
    ...(screenshot ? { screenshot } : {})
  };
  return payload;
}

function normalizeProgress(update = {}) {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    throw new TypeError('progress update must be an object');
  }
  const current = Number(update.current ?? 0);
  const total = update.total === undefined || update.total === null ? null : Number(update.total);
  if (!Number.isFinite(current) || current < 0) throw new TypeError('progress.current must be non-negative');
  if (total !== null && (!Number.isFinite(total) || total < 0)) {
    throw new TypeError('progress.total must be null or non-negative');
  }
  return {
    current,
    total,
    message: String(update.message ?? '').slice(0, 1_000),
    ...(typeof update.phase === 'string' ? { phase: update.phase.slice(0, 64) } : {})
  };
}

function closeContext(context, reportCleanup, timeoutMs = 10_000) {
  // No context handle is not cleanup proof: a failed launch can still have
  // started a Chrome child. Let the Manager contain the owned process tree.
  if (!context) return reportCleanup(false, { phase: 'close', reason: 'missing_context' });
  const startedAt = Date.now();
  let timer;
  const closing = Promise.resolve().then(() => context.close()).then(() => {
    clearTimeout(timer);
    return reportCleanup(true);
  }, (error) => {
    clearTimeout(timer);
    return reportCleanup(false, {
      phase: 'close', reason: 'error', elapsedMs: Date.now() - startedAt,
      error: normalizeTaskError(error)
    });
  });
  // The deadline starts containment; it must not discard a later real close.
  // Keep observing the one close operation, without retrying or delaying stop.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(reportCleanup(false, {
      phase: 'close', reason: 'timeout', elapsedMs: Date.now() - startedAt
    })), timeoutMs);
  });
  return Promise.race([closing, deadline]);
}

async function captureSnapshot(context, outputDir, relativePath = 'failure.png', { budget, signal, targetPage } = {}) {
  const pages = (targetPage ? [targetPage] : context?.pages?.().slice().reverse() ?? [])
    .filter((page) => !page.isClosed?.());
  if (pages.length === 0) return null;
  const filePath = path.join(outputDir, relativePath);
  let releaseReservation;
  let written = false;
  let maximumBytes = Infinity;
  // Only observation is timed out. No page action is retried by this helper.
  const bounded = async (operation) => {
    if (signal?.aborted) throw new Error('Screenshot stopped');
    let timer;
    let abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (signal?.aborted) throw new Error('Screenshot stopped');
          return operation();
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Screenshot timed out')), 10_000);
          abort = () => reject(new Error('Screenshot stopped'));
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        })
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
  try {
    if (budget) {
      const usage = await budget.assertWithinBudget();
      // Do not make the scanner exceed its entry limit merely by creating
      // the diagnostic directory and one image while the task is paused.
      if (usage.entries + 2 > budget.limits.maxEntries) return null;
      maximumBytes = budget.limits.diagnosticReserveBytes - usage.diagnosticBytes;
      if (usage.diagnosticFiles >= budget.limits.diagnosticReserveFiles || maximumBytes <= 0) return null;
      await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      releaseReservation = await budget.reserveDiagnostic(filePath);
    }
    for (const page of pages) {
      if (signal?.aborted) return null;
      let bytes;
      try {
        bytes = await bounded(() => page.screenshot({ fullPage: false, timeout: 10_000 }));
      } catch {
        let session;
        let expired = false;
        try {
          const captured = await bounded(async () => {
            session = await context.newCDPSession(page);
            if (expired || signal?.aborted) {
              void session.detach?.().catch(() => {});
              session = null;
              throw new Error('Screenshot stopped');
            }
            return session.send('Page.captureScreenshot', {
              format: 'png', fromSurface: true, captureBeyondViewport: false
            });
          });
          if (captured?.data && Buffer.byteLength(captured.data, 'base64') <= maximumBytes) {
            bytes = Buffer.from(captured.data, 'base64');
          }
        } catch {
          // Another live page may still be readable.
        } finally {
          expired = true;
          void session?.detach?.().catch(() => {});
        }
      }
      if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > maximumBytes || signal?.aborted) continue;
      await writeFile(filePath, bytes, { mode: 0o600, flag: budget ? 'wx' : 'w' });
      written = true;
      return relativePath;
    }
  } catch {
    // A missing screenshot is an unknown observation, never a resume decision.
  } finally {
    if (!written) releaseReservation?.();
  }
  return null;
}

export function resumeTaskWorker(value = null, match = {}) {
  return externalResume(value, match).accepted;
}

export function acknowledgeTaskWorkerResume(message, sendMessage = send) {
  const result = externalResume(message.value ?? null, {
    waitId: message.waitId, probeId: message.probeId
  });
  sendMessage({
    type: 'resume_ack', requestId: message.requestId, ...result,
    ...(message.probeId === undefined ? {} : { probeId: message.probeId })
  });
  return result.accepted;
}

export async function runTaskWorker(config, {
  loadPlaywright = () => import('playwright'),
  sendMessage = send,
  sendCleanup = sendCleanupWithAck,
  onCleanupConfirmed = () => {},
  pendingLaunchCleanupMs = 10_000,
  verificationProbeIntervalMs = 5 * 60_000,
  verificationPauseAfterMs = 20 * 60_000,
  heartbeatIntervalMs = 10_000,
  signal
} = {}) {
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) controller.abort(new TaskStoppedError());
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });

  let context;
  let launchPromise;
  let cleanupPromise;
  let cleanupTimer;
  let cleanupFailedReported = false;
  let cleanupSucceededReported = false;
  let heartbeat;
  let timeout;
  let timeoutStartedAt = null;
  let timeoutRemainingMs = Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : null;
  let stopBudget = () => {};
  let activeWait = null;
  const startedAt = new Date().toISOString();

  const assertActive = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  // Every asynchronous startup phase observes cancellation immediately. A
  // browser handle arriving after cancellation is still ours to close.
  const abortable = (operation) => new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      reject(controller.signal.reason);
    };
    if (controller.signal.aborted) return abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      assertActive();
      return operation();
    }).then((value) => {
      controller.signal.removeEventListener('abort', abort);
      if (settled || controller.signal.aborted) {
        abort();
        return;
      }
      settled = true;
      resolve(value);
    }, (error) => {
      controller.signal.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      reject(error);
    });
  });

  const reportCleanup = async (browserClosed, details) => {
    if (browserClosed ? cleanupSucceededReported : cleanupFailedReported || cleanupSucceededReported) return;
    if (browserClosed) cleanupSucceededReported = true;
    else cleanupFailedReported = true;
    const acknowledged = await sendCleanup({
      type: 'cleanup', browserClosed, at: new Date().toISOString(),
      ...(details ? { details } : {})
    });
    if (browserClosed && acknowledged) onCleanupConfirmed();
  };
  const closeAndReport = (ownedContext) => {
    cleanupPromise ||= closeContext(ownedContext, async (browserClosed, details) => {
      clearTimeout(cleanupTimer);
      await reportCleanup(browserClosed, details);
    });
    return cleanupPromise;
  };

  const armTimeout = () => {
    if (timeoutRemainingMs === null || controller.signal.aborted) return;
    timeoutStartedAt = Date.now();
    timeout = setTimeout(() => {
      const error = Object.assign(new Error(`Task exceeded ${config.timeoutMs}ms`), { code: 'TASK_TIMEOUT' });
      if (!controller.signal.aborted) controller.abort(error);
    }, timeoutRemainingMs);
    timeout.unref?.();
  };

  const pauseTimeout = () => {
    if (timeoutRemainingMs === null || timeoutStartedAt === null) return;
    timeoutRemainingMs = Math.max(1, timeoutRemainingMs - (Date.now() - timeoutStartedAt));
    timeoutStartedAt = null;
    clearTimeout(timeout);
    timeout = null;
  };

  const resumeWait = (value = null, { waitId, probeId } = {}) => {
    if (!activeWait) return notWaiting();
    const rejected = (reason) => ({ accepted: false, waitId: activeWait.id, reason });
    if (waitId !== undefined && activeWait.id !== waitId) return rejected('TASK_WAIT_MISMATCH');
    if (probeId !== undefined && activeWait.automaticPaused) return rejected('TASK_VERIFICATION_PAUSED');
    if (probeId !== undefined && activeWait.probeId !== probeId) return rejected('TASK_PROBE_MISMATCH');
    const waiter = activeWait;
    activeWait = null;
    waiter.resolve(value);
    return { accepted: true, waitId: waiter.id };
  };
  externalResume = resumeWait;

  const abortWait = () => {
    if (!activeWait) return;
    const waiter = activeWait;
    activeWait = null;
    waiter.reject(controller.signal.reason instanceof Error ? controller.signal.reason : new TaskStoppedError());
  };
  controller.signal.addEventListener('abort', abortWait, { once: true });

  try {
    armTimeout();
    await abortable(() => mkdir(config.outputDir, { recursive: true, mode: 0o700 }));
    const outputBudget = await abortable(() => createOutputBudget({ root: config.outputDir, limits: config.outputBudget }));
    await abortable(() => outputBudget.assertWithinBudget());
    stopBudget = outputBudget.startPeriodic((error) => {
      if (!controller.signal.aborted) controller.abort(error);
    });

    sendMessage({ type: 'state', state: 'running', at: startedAt });
    heartbeat = setInterval(() => sendMessage({ type: 'heartbeat', at: new Date().toISOString() }), heartbeatIntervalMs);
    heartbeat.unref?.();
    sendMessage({ type: 'heartbeat', at: new Date().toISOString() });
    const playwright = await abortable(loadPlaywright);
    context = await abortable(() => {
      launchPromise = launchChromeProfile(playwright, config.profile);
      return launchPromise;
    });
    assertActive();
    const page = context.pages()[0] || await abortable(() => context.newPage());
    const browser = context.browser?.() || null;

    const progress = async (update) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const value = normalizeProgress(update);
      await outputBudget.assertWithinBudget({ allowCached: true });
      assertActive();
      sendMessage({ type: 'progress', progress: value, at: new Date().toISOString() });
      return value;
    };

    const emit = async (value) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const event = safeJson(value, { maximumBytes: 64 * 1024 });
      sendMessage({ type: 'event', event, at: new Date().toISOString() });
      return event;
    };

    const waitForResume = async ({ reason = 'waiting', resumeAfterMs = null, data = null, page: targetPage = page } = {}) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (activeWait) throw Object.assign(new Error('Task already has an active wait'), { code: 'TASK_ALREADY_WAITING' });
      if (resumeAfterMs !== null && (!Number.isSafeInteger(resumeAfterMs) || resumeAfterMs < 0)) {
        throw new TypeError('resumeAfterMs must be null or a non-negative integer');
      }
      const verification = String(reason).trim().toLowerCase() === 'verification';
      if (verification && resumeAfterMs !== null) {
        throw new TypeError('verification waits use the Manager probe schedule and cannot set resumeAfterMs');
      }
      const waiting = {
        id: `wait_${randomUUID().replaceAll('-', '')}`,
        reason: String(reason).slice(0, 1_000),
        data: safeJson(data, { maximumBytes: 64 * 1024 }),
        startedAt: new Date().toISOString(),
        ...(verification ? {
          kind: 'verification',
          probeIntervalMs: verificationProbeIntervalMs,
          maximumProbes: 4,
          nextProbeAt: new Date(Date.now() + verificationProbeIntervalMs).toISOString(),
          automaticPaused: false,
          pauseAfterMs: verificationPauseAfterMs,
          pauseAt: new Date(Date.now() + verificationPauseAfterMs).toISOString()
        } : {}),
        ...(resumeAfterMs === null ? {} : {
          resumeAfterMs,
          resumeAt: new Date(Date.now() + resumeAfterMs).toISOString()
        })
      };
      let timer;
      let pauseTimer;
      const probeTimers = [];
      const probeStartedAt = Date.now();
      const waitController = new AbortController();
      const abortCapture = () => waitController.abort();
      controller.signal.addEventListener('abort', abortCapture, { once: true });
      const scheduleProbes = () => {
        for (let probeCount = 1; probeCount <= 4; probeCount += 1) {
          const probeTimer = setTimeout(async () => {
            if (!activeWait || activeWait.id !== waiting.id || activeWait.automaticPaused || controller.signal.aborted) return;
            const probeId = `probe_${randomUUID().replaceAll('-', '')}`;
            const screenshot = await captureSnapshot(context, config.outputDir,
              `screenshots/${probeStartedAt}-${waiting.id}-${probeCount}.png`,
              { budget: outputBudget, signal: waitController.signal, targetPage });
            if (!activeWait || activeWait.id !== waiting.id || controller.signal.aborted) return;
            // The Agent can only match an observation it has actually received.
            // Keep the previous published ID valid while a new capture is pending.
            activeWait.probeId = probeId;
            const automaticPaused = activeWait.automaticPaused;
            sendMessage({
              type: 'event',
              event: {
                type: 'verification.probe',
                waitId: waiting.id,
                probeId,
                probe: probeCount,
                maximumProbes: 4,
                screenshot,
                screenshotPath: screenshot ? path.join(config.outputDir, screenshot) : null,
                needsAgentDecision: !automaticPaused,
                automaticPaused,
                automaticProbesComplete: automaticPaused || probeCount === 4,
                nextProbeAt: automaticPaused || probeCount === 4 ? null :
                  new Date(probeStartedAt + (probeCount + 1) * verificationProbeIntervalMs).toISOString()
              },
              at: new Date().toISOString()
            });
          }, Math.max(0, probeStartedAt + probeCount * verificationProbeIntervalMs - Date.now()));
          probeTimer.unref?.();
          probeTimers.push(probeTimer);
        }
        // The deadline does not wait for screenshots or Agent decisions. Chrome
        // stays available for a later explicit manual resume or stop.
        pauseTimer = setTimeout(() => {
          if (!activeWait || activeWait.id !== waiting.id || controller.signal.aborted) return;
          activeWait.automaticPaused = true;
          sendMessage({
            type: 'event',
            event: {
              type: 'verification.paused', waitId: waiting.id,
              automaticPaused: true, pausedAt: new Date().toISOString(),
              reason: 'verification_wait_timeout', nextProbeAt: null,
              automaticProbesComplete: true, needsAgentDecision: false
            },
            at: new Date().toISOString()
          });
        }, verificationPauseAfterMs);
        pauseTimer.unref?.();
      };
      try {
        const resumed = new Promise((resolve, reject) => {
          activeWait = { id: waiting.id, resolve, reject, automaticPaused: false };
        });
        if (verification) {
          pauseTimeout();
          scheduleProbes();
        }
        if (resumeAfterMs !== null) timer = setTimeout(() => resumeWait(null), resumeAfterMs);
        sendMessage({ type: 'waiting', waiting });
        const value = await resumed;
        if (controller.signal.aborted) throw controller.signal.reason;
        sendMessage({ type: 'resumed', waitId: waiting.id, at: new Date().toISOString() });
        if (verification) armTimeout();
        return value;
      } finally {
        clearTimeout(timer);
        clearTimeout(pauseTimer);
        for (const probeTimer of probeTimers) clearTimeout(probeTimer);
        waitController.abort();
        controller.signal.removeEventListener('abort', abortCapture);
        if (activeWait?.id === waiting.id) activeWait = null;
      }
    };

    const sourceUrl = `${pathToFileURL(config.modulePath).href}?task=${encodeURIComponent(config.taskId)}`;
    const taskModule = await abortable(() => import(sourceUrl));
    assertActive();
    const run = typeof taskModule.run === 'function'
      ? taskModule.run
      : typeof taskModule.default === 'function'
        ? taskModule.default
        : null;
    if (!run) {
      throw Object.assign(new TypeError('Task module must export function run(runtime) or a default function'), {
        code: 'TASK_MODULE_INVALID'
      });
    }

    const result = await abortable(() => run({
      playwright,
      browser,
      context,
      page,
      input: config.input ?? {},
      outputDir: config.outputDir,
      progress,
      emit,
      wait: waitForResume,
      signal: controller.signal
    }));
    await abortable(() => outputBudget.assertWithinBudget());
    assertActive();
    const normalized = safeJson(result);
    sendMessage({ type: 'result', result: normalized, at: new Date().toISOString() });
    sendMessage({ type: 'state', state: 'finished', at: new Date().toISOString() });
    return { state: 'finished', result: normalized };
  } catch (error) {
    const stopped = error instanceof TaskStoppedError || error?.code === 'TASK_STOPPED';
    const screenshot = controller.signal.aborted ? null : await captureSnapshot(context, config.outputDir);
    const payload = normalizeTaskError(error, { stopped, screenshot });
    sendMessage({ type: 'error', state: stopped ? 'stopped' : 'error', error: payload, at: new Date().toISOString() });
    sendMessage({ type: 'state', state: stopped ? 'stopped' : 'error', at: new Date().toISOString() });
    return { state: stopped ? 'stopped' : 'error', error: payload };
  } finally {
    stopBudget();
    clearInterval(heartbeat);
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', abortWait);
    signal?.removeEventListener('abort', stop);
    externalResume = notWaiting;
    if (!controller.signal.aborted) controller.abort(new TaskStoppedError());
    if (context) {
      await closeAndReport(context);
    } else if (!launchPromise) {
      // Cancellation happened before this runtime could start Chrome.
      await reportCleanup(true);
    } else {
      // Do not turn an unresolved launch into a failed close. Stop task code
      // immediately, keep the Worker attached, and close the eventual handle.
      // The bounded deadline still hands an unresponsive launch to the Manager.
      cleanupTimer = setTimeout(() => {
        void reportCleanup(false).catch(() => {});
      }, pendingLaunchCleanupMs);
      cleanupTimer.unref?.();
      void launchPromise.then(closeAndReport, async () => {
        clearTimeout(cleanupTimer);
        await reportCleanup(false);
      }).catch(() => {});
    }
  }
}

if (typeof process.send === 'function') {
  const controller = new AbortController();
  let started = false;
  let exitRequested = false;
  const finishAfterCleanup = () => {
    if (exitRequested) return;
    exitRequested = true;
    if (process.connected) process.disconnect();
    setTimeout(() => process.exit(0), 25);
  };
  process.on('message', (message) => {
    if (message?.type === 'start' && !started) {
      started = true;
      // This callback also handles cleanup completed by a late launch handle
      // after task execution has already returned its stopped/timeout result.
      void runTaskWorker(message.config, {
        signal: controller.signal, onCleanupConfirmed: finishAfterCleanup
      });
      return;
    }
    if (message?.type === 'stop') controller.abort(new TaskStoppedError());
    if (message?.type === 'resume') acknowledgeTaskWorkerResume(message);
    if (message?.type === 'cleanup_ack' && activeCleanupAck?.id === message.cleanupId) {
      activeCleanupAck.finish(true);
    }
  });
  process.on('disconnect', () => controller.abort(new TaskStoppedError()));
}
