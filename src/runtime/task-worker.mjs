import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOutputBudget } from '../lib/output-budget.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';
import { launchChromeProfile } from './browser-engine.mjs';

let externalResume = () => false;
let activeCleanupAck = null;
let processCleanupConfirmed = true;

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

async function closeContext(context, timeoutMs = 10_000) {
  // No context handle is not cleanup proof: a failed launch can still have
  // started a Chrome child. Let the Manager contain the owned process tree.
  if (!context) return false;
  let timer;
  try {
    await Promise.race([
      context.close(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('close timeout')), timeoutMs); })
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function captureFailure(context, outputDir) {
  const pages = context?.pages?.().filter((page) => !page.isClosed?.()).reverse() ?? [];
  if (pages.length === 0) return null;
  const filePath = path.join(outputDir, 'failure.png');
  for (const page of pages) {
    try {
      await page.screenshot({ path: filePath, fullPage: false, timeout: 10_000 });
      return 'failure.png';
    } catch {
      // Stable Chrome can occasionally reject the higher-level screenshot
      // while its target is still readable. CDP is the bounded fallback.
    }
    let session;
    try {
      session = await context.newCDPSession(page);
      const captured = await session.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false
      });
      if (!captured?.data) continue;
      await writeFile(filePath, Buffer.from(captured.data, 'base64'), { mode: 0o600 });
      return 'failure.png';
    } catch {
      // Try another live page before accepting that no image is available.
    } finally {
      await session?.detach?.().catch(() => {});
    }
  }
  return null;
}

export async function runTaskWorker(config, {
  loadPlaywright = () => import('playwright'),
  signal
} = {}) {
  processCleanupConfirmed = false;
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) controller.abort(new TaskStoppedError());
  };
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });

  let context;
  let heartbeat;
  let timeout;
  let stopBudget = () => {};
  let activeWait = null;
  const startedAt = new Date().toISOString();

  const resumeWait = (value = null) => {
    if (!activeWait) return false;
    const waiter = activeWait;
    activeWait = null;
    waiter.resolve(value);
    return true;
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
    await mkdir(config.outputDir, { recursive: true, mode: 0o700 });
    const outputBudget = await createOutputBudget({ root: config.outputDir, limits: config.outputBudget });
    await outputBudget.assertWithinBudget();
    stopBudget = outputBudget.startPeriodic((error) => {
      if (!controller.signal.aborted) controller.abort(error);
    });

    if (Number.isSafeInteger(config.timeoutMs) && config.timeoutMs > 0) {
      timeout = setTimeout(() => {
        const error = Object.assign(new Error(`Task exceeded ${config.timeoutMs}ms`), { code: 'TASK_TIMEOUT' });
        if (!controller.signal.aborted) controller.abort(error);
      }, config.timeoutMs);
      timeout.unref?.();
    }

    send({ type: 'state', state: 'running', at: startedAt });
    heartbeat = setInterval(() => send({ type: 'heartbeat', at: new Date().toISOString() }), 10_000);
    heartbeat.unref?.();
    send({ type: 'heartbeat', at: new Date().toISOString() });
    const playwright = await loadPlaywright();
    context = await launchChromeProfile(playwright, config.profile);
    const page = context.pages()[0] || await context.newPage();
    const browser = context.browser?.() || null;

    const progress = async (update) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const value = normalizeProgress(update);
      await outputBudget.assertWithinBudget();
      send({ type: 'progress', progress: value, at: new Date().toISOString() });
      return value;
    };

    const emit = async (value) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const event = safeJson(value, { maximumBytes: 64 * 1024 });
      send({ type: 'event', event, at: new Date().toISOString() });
      return event;
    };

    const waitForResume = async ({ reason = 'waiting', resumeAfterMs = null, data = null } = {}) => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (activeWait) throw Object.assign(new Error('Task already has an active wait'), { code: 'TASK_ALREADY_WAITING' });
      if (resumeAfterMs !== null && (!Number.isSafeInteger(resumeAfterMs) || resumeAfterMs < 0)) {
        throw new TypeError('resumeAfterMs must be null or a non-negative integer');
      }
      const waiting = {
        id: `wait_${randomUUID().replaceAll('-', '')}`,
        reason: String(reason).slice(0, 1_000),
        data: safeJson(data, { maximumBytes: 64 * 1024 }),
        startedAt: new Date().toISOString(),
        ...(resumeAfterMs === null ? {} : {
          resumeAfterMs,
          resumeAt: new Date(Date.now() + resumeAfterMs).toISOString()
        })
      };
      send({ type: 'waiting', waiting });
      let timer;
      try {
        const value = await new Promise((resolve, reject) => {
          activeWait = { id: waiting.id, resolve, reject };
          if (resumeAfterMs !== null) timer = setTimeout(() => resumeWait(null), resumeAfterMs);
        });
        if (controller.signal.aborted) throw controller.signal.reason;
        send({ type: 'resumed', waitId: waiting.id, at: new Date().toISOString() });
        return value;
      } finally {
        clearTimeout(timer);
        if (activeWait?.id === waiting.id) activeWait = null;
      }
    };

    const sourceUrl = `${pathToFileURL(config.modulePath).href}?task=${encodeURIComponent(config.taskId)}`;
    const taskModule = await import(sourceUrl);
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

    const taskPromise = Promise.resolve().then(() => run({
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
    taskPromise.catch(() => {});
    const stoppedPromise = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    stoppedPromise.catch(() => {});
    const result = await Promise.race([taskPromise, stoppedPromise]);
    await outputBudget.assertWithinBudget();
    const normalized = safeJson(result);
    send({ type: 'result', result: normalized, at: new Date().toISOString() });
    send({ type: 'state', state: 'finished', at: new Date().toISOString() });
    return { state: 'finished', result: normalized };
  } catch (error) {
    const stopped = error instanceof TaskStoppedError || error?.code === 'TASK_STOPPED';
    const screenshot = stopped ? null : await captureFailure(context, config.outputDir);
    const payload = normalizeTaskError(error, { stopped, screenshot });
    send({ type: 'error', state: stopped ? 'stopped' : 'error', error: payload, at: new Date().toISOString() });
    send({ type: 'state', state: stopped ? 'stopped' : 'error', at: new Date().toISOString() });
    return { state: stopped ? 'stopped' : 'error', error: payload };
  } finally {
    stopBudget();
    clearInterval(heartbeat);
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', abortWait);
    signal?.removeEventListener('abort', stop);
    externalResume = () => false;
    if (!controller.signal.aborted) controller.abort(new TaskStoppedError());
    const browserClosed = await closeContext(context);
    const cleanupAcknowledged = await sendCleanupWithAck({
      type: 'cleanup', browserClosed, at: new Date().toISOString()
    });
    processCleanupConfirmed = browserClosed && cleanupAcknowledged;
  }
}

if (typeof process.send === 'function') {
  const controller = new AbortController();
  let started = false;
  process.on('message', (message) => {
    if (message?.type === 'start' && !started) {
      started = true;
      void runTaskWorker(message.config, { signal: controller.signal }).finally(() => {
        // If Playwright could not prove that its persistent context closed,
        // stay attached so the owning Manager can terminate this complete
        // detached process tree. Exiting here could orphan Chrome while making
        // the Profile appear reusable.
        if (processCleanupConfirmed) {
          if (process.connected) process.disconnect();
          setTimeout(() => process.exit(0), 25);
        }
      });
      return;
    }
    if (message?.type === 'stop') controller.abort(new TaskStoppedError());
    if (message?.type === 'resume') externalResume(message.value ?? null);
    if (message?.type === 'cleanup_ack' && activeCleanupAck?.id === message.cleanupId) {
      activeCleanupAck.finish(true);
    }
  });
  process.on('disconnect', () => controller.abort(new TaskStoppedError()));
}
