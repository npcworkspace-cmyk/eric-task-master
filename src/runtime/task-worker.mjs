import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createActionHelper } from '../lib/behavior.mjs';
import { resolveBrowserEngine } from './browser-engine.mjs';
import { createCooldownHelper } from '../lib/cooldown.mjs';
import { createEffectJournal } from '../lib/effect-journal.mjs';
import { captureBoundedDiagnosticImage } from '../lib/diagnostic-screenshot.mjs';
import { createOutputBudget } from '../lib/output-budget.mjs';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';
import { createSemanticObserver } from '../lib/semantic-observer.mjs';
import { createUserHandoff } from '../lib/user-handoff.mjs';
import { writeCleanupReceipt } from '../lib/cleanup-receipt.mjs';
import { createJourneyHelper } from '../lib/journey.mjs';
import {
  createObservationCapability,
  createObservationFacade,
  createObservationLocatorUnwrapper
} from '../lib/observation-facade.mjs';
import { outputSealLimitsForBudget, snapshotOutputTree } from '../lib/output-seal.mjs';
import { FULL_HUMAN_INTERACTION_CONTRACT } from '../lib/interaction-contract.mjs';
import { createTaskFailureFacade, sanitizePublicTaskFailure } from '../lib/public-task-failure.mjs';
import { isBehaviorMode } from '../contracts.mjs';
import { createActionArbiter } from '../lib/action-arbiter.mjs';
import { createExtensionActionCoordinator } from '../lib/extension-action-coordinator.mjs';

const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_TASK_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
const ATOMIC_RENAME_RETRY_MS = Object.freeze([25, 50, 100, 200, 400]);
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const PROGRESS_PHASE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const EFFECT_ACTIVITY = Object.freeze({
  goto: 'navigating',
  click: 'clicking',
  fill: 'typing',
  type: 'typing',
  hover: 'hovering',
  scroll: 'scrolling',
  custom: 'working'
});

function checkpointDataError(message = 'Task checkpoint data must be a bounded JSON value') {
  const error = new TypeError(message);
  error.code = 'TASK_CHECKPOINT_INVALID';
  return error;
}

function normalizeCheckpointData(data) {
  const stack = [{ value: data, depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    nodes += 1;
    if (nodes > 250_000 || depth > 64) throw checkpointDataError('Task checkpoint data is too deeply nested');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw checkpointDataError('Task checkpoint numbers must be finite');
      continue;
    }
    if (typeof value !== 'object') throw checkpointDataError();
    if (seen.has(value)) throw checkpointDataError('Task checkpoint data cannot contain cycles or shared object references');
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw checkpointDataError('Task checkpoint arrays cannot contain holes');
        stack.push({ value: value[index], depth: depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw checkpointDataError('Task checkpoint objects must use plain JSON object shapes');
    }
    for (const key of Object.keys(value)) stack.push({ value: value[key], depth: depth + 1 });
  }
  let encoded;
  try {
    encoded = JSON.stringify(data);
  } catch (cause) {
    throw checkpointDataError(`Task checkpoint data is not JSON serializable: ${cause?.name || 'serialization-error'}`);
  }
  if (encoded === undefined) throw checkpointDataError();
  return JSON.parse(encoded);
}

export function browserEffectActivity({ state, operation } = {}, now = () => new Date().toISOString()) {
  const phase = EFFECT_ACTIVITY[operation] || 'working';
  const status = state === 'started'
    ? 'active'
    : state === 'succeeded'
      ? 'succeeded'
      : 'unknown';
  return Object.freeze({ phase, status, updatedAt: now() });
}

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

class TaskPauseResumeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TaskPauseResumeError';
    this.code = 'TASK_PAUSE_RESUME_VALIDATION_FAILED';
  }
}

/**
 * Cooperative task pause gate. A pause request never interrupts an in-flight
 * browser effect. It waits for every admitted action to settle, runs one
 * bounded diagnostic callback, and only then reports `paused`. New actions and
 * task completion remain gated until resume validation succeeds.
 */
export function createCooperativePauseGate({
  signal,
  onState = async () => {},
  onPaused = async () => {},
  onResumeValidate = async () => {},
  onResumed = async () => {}
} = {}) {
  let pauseRequested = false;
  let paused = false;
  let activeActions = 0;
  let pauseCommandId = null;
  let transition = Promise.resolve();
  let acceptingControls = true;
  const waiters = new Set();
  const idleWaiters = new Set();

  const abortError = (candidate = signal) => (
    candidate?.reason instanceof Error ? candidate.reason : new TaskCancelledError()
  );

  function detachWaiter(waiter) {
    for (const [candidate, listener] of waiter.abortListeners || []) {
      candidate.removeEventListener('abort', listener);
    }
    waiter.abortListeners = [];
  }

  function wakeWaiters(error = null) {
    for (const waiter of waiters) {
      detachWaiter(waiter);
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
    waiters.clear();
  }

  function waitUntilResumed(admissionSignal = null) {
    if (!pauseRequested) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortError());
    if (admissionSignal?.aborted) return Promise.reject(abortError(admissionSignal));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, abortListeners: [] };
      const attachAbort = (candidate) => {
        if (!candidate) return;
        const abortListener = () => {
          detachWaiter(waiter);
          waiters.delete(waiter);
          reject(abortError(candidate));
        };
        waiter.abortListeners.push([candidate, abortListener]);
        candidate.addEventListener('abort', abortListener, { once: true });
      };
      waiters.add(waiter);
      attachAbort(signal);
      if (admissionSignal !== signal) attachAbort(admissionSignal);
    });
  }

  function waitUntilIdle() {
    if (activeActions === 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => idleWaiters.add({ resolve, reject }));
  }

  function queueTransition(callback) {
    const operation = transition.catch(() => {}).then(callback);
    transition = operation.catch(() => {});
    return operation;
  }

  async function settlePause() {
    if (signal?.aborted || !pauseRequested || paused || activeActions !== 0) return;
    await onPaused({ commandId: pauseCommandId });
    if (signal?.aborted || !pauseRequested || activeActions !== 0) return;
    paused = true;
    await onState('paused', { commandId: pauseCommandId });
  }

  async function requestPause(commandId = null) {
    if (signal?.aborted) throw abortError();
    if (!acceptingControls) {
      const error = new Error('Pause was requested after the task entered completion');
      error.code = 'TASK_CONTROL_AFTER_COMPLETION';
      throw error;
    }
    if (pauseRequested) return { state: paused ? 'paused' : 'pause_requested', commandId: pauseCommandId };
    pauseRequested = true;
    paused = false;
    pauseCommandId = commandId || null;
    await onState('pause_requested', { commandId: pauseCommandId });
    if (signal?.aborted) throw abortError();
    await queueTransition(settlePause);
    if (signal?.aborted) throw abortError();
    return { state: paused ? 'paused' : 'pause_requested', commandId: pauseCommandId };
  }

  async function requestResume(commandId = null) {
    if (signal?.aborted) throw abortError();
    if (!pauseRequested) return { state: 'running', commandId };
    return queueTransition(async () => {
      // A resume racing the final in-flight effect waits for the pause boundary
      // and its diagnostic proof before validating the live page.
      await waitUntilIdle();
      if (signal?.aborted) throw abortError();
      await settlePause();
      if (signal?.aborted) throw abortError();
      await onState('recovering', { commandId });
      if (signal?.aborted) throw abortError();
      await onResumeValidate({ commandId, pauseCommandId });
      if (signal?.aborted) throw abortError();
      await onResumed({ commandId, pauseCommandId });
      if (signal?.aborted) throw abortError();
      pauseRequested = false;
      paused = false;
      pauseCommandId = null;
      wakeWaiters();
      if (signal?.aborted) throw abortError();
      await onState('running', { commandId });
      if (signal?.aborted) throw abortError();
      return { state: 'running', commandId };
    });
  }

  function seal() {
    acceptingControls = false;
  }

  async function acquire({ signal: admissionSignal = null } = {}) {
    for (;;) {
      await waitUntilResumed(admissionSignal);
      if (signal?.aborted) throw abortError();
      if (admissionSignal?.aborted) throw abortError(admissionSignal);
      // The flag check and counter increment are synchronous, so a pause cannot
      // report its idle boundary between admission and accounting.
      if (pauseRequested) continue;
      activeActions += 1;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        activeActions -= 1;
        if (activeActions === 0) {
          for (const waiter of idleWaiters) waiter.resolve();
          idleWaiters.clear();
        }
        if (!signal?.aborted && pauseRequested && activeActions === 0) {
          await queueTransition(settlePause);
        }
      };
    }
  }

  async function run(callback) {
    if (typeof callback !== 'function') throw new TypeError('pause gate callback is required');
    const release = await acquire();
    try {
      return await callback();
    } finally {
      await release();
    }
  }

  signal?.addEventListener('abort', () => {
    const error = abortError();
    acceptingControls = false;
    pauseRequested = false;
    paused = false;
    pauseCommandId = null;
    wakeWaiters(error);
    for (const waiter of idleWaiters) waiter.reject(error);
    idleWaiters.clear();
  }, { once: true });

  return Object.freeze({
    requestPause,
    requestResume,
    seal,
    acquire,
    run,
    waitIfPaused: waitUntilResumed,
    beforeCompletion: waitUntilResumed,
    get state() {
      return paused ? 'paused' : pauseRequested ? 'pause_requested' : 'running';
    },
    get activeActions() {
      return activeActions;
    }
  });
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
  const publicFailure = sanitizePublicTaskFailure(error?.publicFailure);
  return {
    code: error?.code || 'TASK_FAILED',
    message: message.slice(0, 2_000),
    ...(publicFailure ? { publicFailure } : {}),
    ...(screenshot ? { screenshot } : {})
  };
}

async function writeJsonAtomic(filePath, value) {
  return writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function renameAtomic(temporaryPath, filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, filePath);
      return;
    } catch (error) {
      const delayMs = ATOMIC_RENAME_RETRY_MS[attempt];
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || delayMs === undefined) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
    }
  }
}

async function writeTextAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await renameAtomic(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function writeBufferAtomic(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, { mode: 0o600 });
    await renameAtomic(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
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
let activePauseControl = null;
let activeRuntimeControl = null;
let pendingPauseControls = [];
let activeActionHelper = null;
let activeExtensionCoordinator = null;
let pendingBehavior = null;
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
  const unavailable = Object.freeze({
    screenshotPath: null,
    observationPath: null,
    reason: String(reason || 'failure')
  });
  if (!page || page.isClosed?.()) return unavailable;
  const screenshotsDir = path.join(outputDir, 'screenshots');
  const safeReason = String(reason || 'failure').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48);
  const screenshotPath = path.join(screenshotsDir, `${Date.now()}-${safeReason}.jpg`);
  let releaseReservation = () => {};
  let captured = false;
  let result = null;
  let observationResult = null;
  try {
    await outputBudget?.assertSafeRoot?.();
    await mkdir(screenshotsDir, { recursive: true });
    releaseReservation = await outputBudget?.reserveDiagnostic?.(screenshotPath) || releaseReservation;
    const screenshot = await withDeadline(captureBoundedDiagnosticImage(page), 8_000);
    await writeBufferAtomic(screenshotPath, screenshot);
    captured = true;
    result = screenshotPath;
    // The file and direct IPC pointer are authoritative for the live Manager.
    // A temporarily locked recovery manifest must not hide valid diagnostics.
    await recordDiagnostic('screenshot', screenshotPath, outputDir, safeReason).catch(() => {});
    safeSend({ type: 'screenshot', path: screenshotPath, reason: safeReason });
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
      observationResult = observationPath;
      await recordDiagnostic('observation', observationPath, outputDir, safeReason).catch(() => {});
      safeSend({ type: 'observation', path: observationPath, reason: safeReason });
    } catch {
      // A semantic diagnostic is best-effort and never hides the browser error.
    } finally {
      if (!observationCaptured) releaseObservation();
    }
  }
  return Object.freeze({
    screenshotPath: result,
    observationPath: observationResult,
    reason: safeReason
  });
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

function restrictedPackAction(action) {
  const fail = (operation) => {
    const error = new Error(`Task Packs must use journey.${operation} instead of the legacy action facade`);
    error.code = 'TASK_PACK_JOURNEY_REQUIRED';
    throw error;
  };
  return Object.freeze({
    get mode() { return action.mode; },
    get effectiveMode() { return action.effectiveMode; },
    get autoState() { return action.autoState; },
    get adaptiveState() { return action.adaptiveState; },
    get audit() { return action.audit; },
    signal: () => fail('signal'),
    run: () => fail('run'),
    goto: () => fail('open'),
    click: () => fail('click'),
    fill: () => fail('fill'),
    type: () => fail('type'),
    hover: () => fail('hover'),
    scroll: () => fail('scroll'),
    read: () => fail('read'),
    wait: () => fail('wait')
  });
}

function freezePlaywrightPrototypeChain(label, client, seen) {
  if (!client || typeof client !== 'object') return [];
  const frozen = [];
  let prototype = Object.getPrototypeOf(client);
  let depth = 0;
  // Playwright Page/Context/Frame clients inherit shared ChannelOwner and
  // EventEmitter implementations. Freezing only the leaf would leave inherited
  // dispatch hooks replaceable, so retain the complete unique client chain.
  // EventEmitter2 creates own `on` and `off` aliases on every future handle.
  // Lock every method on those constructor-sensitive layers except the two
  // aliases, then continue through the unique chain instead of freezing an
  // inherited non-writable alias that would break later handle construction.
  while (prototype && prototype !== Object.prototype) {
    if (depth > 16) {
      const error = new Error(`Playwright ${label} client prototype chain is unexpectedly deep`);
      error.code = 'BROWSER_CLIENT_PROTOTYPE_UNAVAILABLE';
      throw error;
    }
    const isConstructorSensitiveEmitterLayer = (
      Object.hasOwn(prototype, 'on') &&
      Object.hasOwn(prototype, 'addListener') &&
      Object.hasOwn(prototype, 'off') &&
      Object.hasOwn(prototype, 'removeListener')
    );
    if (isConstructorSensitiveEmitterLayer) {
      if (!seen.has(prototype)) {
        seen.add(prototype);
        for (const name of Object.getOwnPropertyNames(prototype)) {
          if (name === 'constructor' || name === 'on' || name === 'off') continue;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
          if (!descriptor || typeof descriptor.value !== 'function') continue;
          Object.defineProperty(prototype, name, {
            ...descriptor,
            writable: false,
            configurable: false
          });
        }
        frozen.push(`${label}:${prototype.constructor?.name || 'emitter'}-methods`);
      }
      prototype = Object.getPrototypeOf(prototype);
      depth += 1;
      continue;
    }
    if (!seen.has(prototype)) {
      seen.add(prototype);
      Object.freeze(prototype);
      if (!Object.isFrozen(prototype)) {
        const error = new Error(`Playwright ${label} client prototype could not be frozen`);
        error.code = 'BROWSER_CLIENT_PROTOTYPE_UNAVAILABLE';
        throw error;
      }
      frozen.push(depth === 0 ? label : `${label}:ancestor-${depth}`);
    }
    prototype = Object.getPrototypeOf(prototype);
    depth += 1;
  }
  return frozen;
}

export function freezePlaywrightClientPrototypes({ context, page }) {
  // Task modules execute in this Worker realm. Freeze the direct client
  // prototypes before importing trusted Task code so an accidental package-wide
  // monkeypatch cannot route later Playwright calls around the action FIFO. This
  // is defense in depth, not a hostile-code sandbox.
  const clients = [
    ['Page', page],
    ['BrowserContext', context],
    ['Frame', typeof page?.mainFrame === 'function' ? page.mainFrame() : null],
    ['Locator', typeof page?.locator === 'function' ? page.locator(':root') : null],
    ['Mouse', page?.mouse],
    ['Keyboard', page?.keyboard]
  ];
  if (page?.touchscreen) clients.push(['Touchscreen', page.touchscreen]);

  const seen = new Set();
  const frozen = clients
    .flatMap(([label, client]) => freezePlaywrightPrototypeChain(label, client, seen));
  return Object.freeze(frozen);
}

export async function runTaskWorker(config, {
  loadPlaywright = () => import('playwright'),
  signal,
  handoffDrainTimeoutMs = 20_000
} = {}) {
  if (
    config.interactionContract !== undefined &&
    config.interactionContract !== FULL_HUMAN_INTERACTION_CONTRACT
  ) {
    const error = new TypeError(`Unsupported interaction contract: ${config.interactionContract}`);
    error.code = 'TASK_INTERACTION_CONTRACT_UNSUPPORTED';
    throw error;
  }
  if (!isBehaviorMode(config.behavior)) {
    const error = new TypeError(`Unsupported behavior mode: ${config.behavior}`);
    error.code = 'TASK_BEHAVIOR_UNSUPPORTED';
    throw error;
  }
  activePage = null;
  activeProgress = { current: 0, total: null, message: 'Starting browser' };
  activeOutputBudget = null;
  activeSemantic = null;
  activeHandoff = null;
  activePauseControl = null;
  activeRuntimeControl = null;
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
  let sealPendingProofBoundaries = async () => {};
  let sealCheckpointBoundary = () => {};
  let drainCheckpointBoundary = async () => {};
  let sealEffectResolutionBoundary = () => {};
  let drainEffectResolutionBoundary = async () => {};
  let sealProgressBoundary = () => {};
  let drainProgressBoundary = async () => {};
  let sealRuntimeControlBoundary = () => {};
  let drainRuntimeControlBoundary = async () => {};
  let sealHandoffBoundary = () => false;
  let drainHandoffBoundary = async () => {};
  let sealCooldownBoundary = () => false;
  let frozenResumeRecord = null;
  let resumeCheckpointConsumed = false;
  let lastCheckpointReceipt = null;
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
    let effectRecordTail = Promise.resolve();
    const recordEffectEvent = (event) => {
      const recordPromise = effectRecordTail.then(() => effectJournal.record(event));
      // Keep one observed tail so timeout recovery can wait for every durable
      // append that was already scheduled without creating unhandled rejections.
      effectRecordTail = recordPromise.catch(() => {});
      return recordPromise;
    };
    let effectResolutionTail = Promise.resolve();
    let effectResolutionFailure = null;
    let effectResolutionAccepting = true;
    sealEffectResolutionBoundary = () => { effectResolutionAccepting = false; };
    drainEffectResolutionBoundary = async () => {
      await effectResolutionTail;
      if (effectResolutionFailure) throw effectResolutionFailure;
    };
    const effectResolutionAbortError = () => (
      typeof executionSignal.reason?.code === 'string'
        ? executionSignal.reason
        : new TaskCancelledError()
    );
    const guardResumeEffectResolution = (sequence, observedOutcome) => {
      if (!effectResolutionAccepting) {
        const error = new Error('Effect resolution was issued after the task entered completion');
        error.code = 'TASK_EFFECT_AFTER_COMPLETION';
        const rejection = Promise.reject(error);
        rejection.catch(() => {});
        return rejection;
      }
      if (executionSignal.aborted) {
        const rejection = Promise.reject(effectResolutionAbortError());
        rejection.catch(() => {});
        return rejection;
      }
      if (config.resumeCheckpoint && !resumeCheckpointConsumed) {
        const error = new Error('Consume the frozen checkpoint before resolving an unknown effect');
        error.code = 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED';
        const rejection = Promise.reject(error);
        rejection.catch(() => {});
        return rejection;
      }
      const operation = effectResolutionTail.then(() => {
        if (executionSignal.aborted) throw effectResolutionAbortError();
        if (effectResolutionFailure) throw effectResolutionFailure;
        return effectJournal.resolveUnknown(sequence, observedOutcome);
      });
      operation.catch(() => {});
      effectResolutionTail = operation.catch((error) => {
        if (!effectResolutionFailure) effectResolutionFailure = error;
      });
      return operation;
    };
    const effects = Object.freeze({
      pending: () => effectJournal.pending(),
      resolveUnknown: guardResumeEffectResolution
    });

    safeSend({ type: 'state', state: 'starting_browser' });
    const playwright = await awaitExecution(loadPlaywright());
    const { browserType, launchOptions: engineLaunchOptions } = resolveBrowserEngine(playwright, config.profile);
    const profileKind = config.profile.kind || 'persistent';
    if (
      (profileKind === 'persistent' && !browserType?.launchPersistentContext) ||
      (profileKind === 'ephemeral' && !browserType?.launch)
    ) {
      const error = new Error('Unsupported Playwright browser');
      error.code = 'BROWSER_UNSUPPORTED';
      throw error;
    }

    const launchOptions = {
      ...engineLaunchOptions,
      headless: config.profile.headless ?? false
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
    freezePlaywrightClientPrototypes({ context, page });

    let extensionCoordinator = null;
    const pauseGate = createCooperativePauseGate({
      signal: executionSignal,
      onState: async (state, detail = {}) => safeSend({
        type: 'state',
        state,
        ...(detail.commandId ? { commandId: detail.commandId } : {})
      }),
      onPaused: async () => {
        extensionCoordinator?.pause();
        const diagnostics = await captureFailure(
          page,
          config.outputDir,
          'task-paused',
          outputBudget,
          activeSemantic
        );
        if (diagnostics.screenshotPath) lastScreenshot = diagnostics.screenshotPath;
      },
      onResumeValidate: async () => {
        if (page.isClosed?.()) throw new TaskPauseResumeError('Task page closed while paused');
        try {
          await withDeadline(Promise.all([
            Promise.resolve(page.url()),
            page.locator('html').count()
          ]), 5_000);
        } catch {
          throw new TaskPauseResumeError('Task page could not be revalidated before resume');
        }
      },
      onResumed: async () => extensionCoordinator?.resume()
    });
    const assertResumeCheckpointConsumed = () => {
      if (config.resumeCheckpoint && !resumeCheckpointConsumed) {
        const error = new Error('Consume the frozen checkpoint before issuing browser actions');
        error.code = 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED';
        throw error;
      }
    };
    extensionCoordinator = await createExtensionActionCoordinator({
      context,
      page,
      signal: executionSignal,
      enabled: config.profile.extensionsEnabled === true,
      onExtensionEffect: (event) => recordEffectEvent(event),
      acquireExtensionBoundary: ({ signal: admissionSignal } = {}) => {
        assertResumeCheckpointConsumed();
        return pauseGate.acquire({ signal: admissionSignal });
      }
    });
    activeExtensionCoordinator = extensionCoordinator;
    const actionArbiter = createActionArbiter({ signal: executionSignal });
    activePauseControl = Object.freeze({
      requestPause: (commandId) => pauseGate.requestPause(commandId).catch((error) => {
        if (!executionSignal.aborted && error?.code !== 'TASK_CONTROL_AFTER_COMPLETION') {
          executionController.abort(error);
        }
        throw error;
      }),
      requestResume: (commandId) => pauseGate.requestResume(commandId).catch((error) => {
        if (!executionSignal.aborted) executionController.abort(error);
        throw error;
      })
    });
    const queuedControls = pendingPauseControls;
    pendingPauseControls = [];
    for (const control of queuedControls) {
      try {
        if (control.type === 'pause') await activePauseControl.requestPause(control.commandId);
        else if (control.type === 'resume_pause') await activePauseControl.requestResume(control.commandId);
      } catch (error) {
        safeSend({ type: 'control_error', commandId: control.commandId, error: errorPayload(error) });
        throw error;
      }
    }

    let progressBoundaryTail = Promise.resolve();
    let progressBoundaryFailure = null;
    let progressBoundaryAccepting = true;
    let progressBoundaryPending = 0;
    const progressBoundaryController = new AbortController();
    sealProgressBoundary = () => {
      if (!progressBoundaryAccepting) return;
      progressBoundaryAccepting = false;
      if (progressBoundaryPending > 0 && !progressBoundaryController.signal.aborted) {
        const error = new Error('Task returned before an admitted progress update settled');
        error.code = 'TASK_PROGRESS_NOT_AWAITED';
        progressBoundaryFailure ||= error;
        progressBoundaryController.abort(error);
      }
    };
    drainProgressBoundary = async () => {
      await progressBoundaryTail;
      if (progressBoundaryFailure) throw progressBoundaryFailure;
    };
    const progress = ({ current, total = null, message, phase }) => {
      // Admission is synchronous. A timer that calls progress after run()
      // returns cannot sneak through merely because the first await yields.
      if (!progressBoundaryAccepting) {
        const error = new Error('Progress was issued after the task entered completion');
        error.code = 'TASK_PROGRESS_AFTER_COMPLETION';
        const rejection = Promise.reject(error);
        rejection.catch(() => {});
        return rejection;
      }
      progressBoundaryPending += 1;
      const operation = progressBoundaryTail.then(async () => {
        if (executionSignal.aborted) throw (
          executionSignal.reason instanceof Error ? executionSignal.reason : new TaskCancelledError()
        );
        await pauseGate.waitIfPaused(progressBoundaryController.signal);
        if (executionSignal.aborted) throw (
          executionSignal.reason instanceof Error ? executionSignal.reason : new TaskCancelledError()
        );
        await outputBudget.assertWithinBudget();
        if (executionSignal.aborted) throw (
          executionSignal.reason instanceof Error ? executionSignal.reason : new TaskCancelledError()
        );
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
        if (phase !== undefined && (typeof phase !== 'string' || !PROGRESS_PHASE_PATTERN.test(phase))) {
          const error = new TypeError('progress.phase must match ^[a-z][a-z0-9_-]{0,31}$');
          error.code = 'TASK_PROGRESS_INVALID';
          throw error;
        }
        activeProgress = {
          current: normalizedCurrent,
          total: normalizedTotal,
          message: String(message).slice(0, 500),
          ...(phase === undefined ? {} : { phase })
        };
        safeSend({ type: 'progress', progress: activeProgress, at: new Date().toISOString() });
      }).finally(() => {
        progressBoundaryPending -= 1;
      });
      progressBoundaryTail = operation.catch((error) => {
        if (!executionSignal.aborted && !progressBoundaryFailure) progressBoundaryFailure = error;
      });
      return operation;
    };

    let checkpointWrittenThisAttempt = false;
    let checkpointBoundaryTail = Promise.resolve();
    let checkpointWriteFailure = null;
    let checkpointBoundaryAccepting = true;
    sealCheckpointBoundary = () => { checkpointBoundaryAccepting = false; };
    drainCheckpointBoundary = async () => {
      await checkpointBoundaryTail;
      if (checkpointWriteFailure) throw checkpointWriteFailure;
    };
    const queueCheckpointBoundary = (callback, { write = false } = {}) => {
      if (!checkpointBoundaryAccepting) {
        const error = new Error('Checkpoint operation was issued after the task entered completion');
        error.code = 'TASK_CHECKPOINT_AFTER_COMPLETION';
        const rejection = Promise.reject(error);
        rejection.catch(() => {});
        return rejection;
      }
      const operation = checkpointBoundaryTail.then(() => {
        if (checkpointWriteFailure) throw checkpointWriteFailure;
        if (executionSignal.aborted) throw (
          executionSignal.reason instanceof Error ? executionSignal.reason : new TaskCancelledError()
        );
        return callback();
      });
      checkpointBoundaryTail = operation.catch((error) => {
        if (write && !checkpointWriteFailure) checkpointWriteFailure = error;
      });
      return operation;
    };
    const checkpoint = (data) => {
      // Freeze both task data and extension proof at API admission. A checkpoint
      // queued before an extension receipt must never become post-receipt proof
      // merely because an earlier checkpoint delayed its durable write.
      const extensionHandoffAtAdmission = activeExtensionCoordinator?.checkpointContext?.() || null;
      let normalizedDataAtAdmission;
      try {
        normalizedDataAtAdmission = normalizeCheckpointData(data);
      } catch (error) {
        const rejection = Promise.reject(error);
        rejection.catch(() => {});
        return rejection;
      }
      return queueCheckpointBoundary(async () => {
        await pauseGate.waitIfPaused();
        if (config.resumeCheckpoint && !resumeCheckpointConsumed) {
          const error = new Error('Consume the frozen checkpoint before writing a new checkpoint');
          error.code = 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED';
          throw error;
        }
        await outputBudget.assertWithinBudget();
        const normalizedData = normalizedDataAtAdmission;
        const extensionHandoff = extensionHandoffAtAdmission;
        const record = {
          taskId: config.taskId,
          attempt: config.attempt,
          savedAt: new Date().toISOString(),
          ...(extensionHandoff ? { extensionHandoff } : {}),
          data: normalizedData
        };
        const encoded = `${JSON.stringify(record, null, 2)}\n`;
        if (Buffer.byteLength(encoded) > MAX_CHECKPOINT_BYTES) {
          const error = new Error('Task checkpoint exceeds 8 MiB; persist bulk data under outputDir');
          error.code = 'TASK_CHECKPOINT_TOO_LARGE';
          throw error;
        }
        await writeTextAtomic(config.checkpointPath, encoded);
        const persisted = await readFile(config.checkpointPath, 'utf8');
        if (persisted !== encoded) {
          const error = new Error('Task checkpoint changed before durable verification');
          error.code = 'TASK_CHECKPOINT_INVALID';
          throw error;
        }
        let persistedRecord;
        try {
          persistedRecord = JSON.parse(persisted);
        } catch {
          throw checkpointDataError('Task checkpoint could not be read after persistence');
        }
        if (
          persistedRecord?.taskId !== config.taskId || persistedRecord?.attempt !== config.attempt ||
          persistedRecord?.savedAt !== record.savedAt || !Object.hasOwn(persistedRecord, 'data') ||
          JSON.stringify(persistedRecord.extensionHandoff ?? null) !== JSON.stringify(extensionHandoff)
        ) {
          throw checkpointDataError('Task checkpoint failed post-write verification');
        }
        checkpointWrittenThisAttempt = true;
        lastCheckpointReceipt = {
          attempt: config.attempt,
          savedAt: record.savedAt,
          sha256: createHash('sha256').update(persisted).digest('hex'),
          sizeBytes: Buffer.byteLength(persisted)
        };
        if (extensionHandoff) {
          activeExtensionCoordinator.checkpointCompleted(
            extensionHandoff.receiptId,
            lastCheckpointReceipt
          );
        }
        safeSend({
          type: 'checkpoint',
          path: config.checkpointPath,
          ...lastCheckpointReceipt
        });
        return persistedRecord;
      }, { write: true });
    };
    checkpoint.read = () => queueCheckpointBoundary(async () => {
      try {
        if (checkpointWriteFailure) throw checkpointWriteFailure;
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
    });

    let semantic;
    let cooldown;
    const fullHumanJourney = config.interactionContract === FULL_HUMAN_INTERACTION_CONTRACT;
    const extensionFlow = Object.freeze({
      enabled: extensionCoordinator.enabled,
      protocol: extensionCoordinator.protocol,
      expectCompletion: (options) => extensionCoordinator.expectCompletion(options),
      resolveCompletion: (receiptId, resolution) => (
        queueCheckpointBoundary(() => extensionCoordinator.resolveCompletion(receiptId, resolution))
      )
    });
    let terminalEffectGeneration = 0;
    const observationCapability = createObservationCapability();
    const unwrapTaskLocator = createObservationLocatorUnwrapper(observationCapability);
    const rawAction = createActionHelper({
      page,
      unwrapLocator: unwrapTaskLocator,
      mode: pendingBehavior ?? config.behavior,
      abortSignal: executionSignal,
      strictVisibleTraversal: fullHumanJourney,
      onEffect: async (event) => {
        const sequence = await recordEffectEvent(event);
        if (event.state === 'succeeded') terminalEffectGeneration += 1;
        safeSend({ type: 'activity', activity: browserEffectActivity(event) });
        return sequence;
      },
      onBeforeEffectSuccess: () => extensionCoordinator.beforeEffectSuccess(),
      onBehaviorState: (state) => safeSend({
        type: 'behavior',
        behavior: {
          ...state,
          at: new Date().toISOString()
        }
      }),
      onNavigationCooldown: (options) => cooldown(options),
      onFailure: async ({ operation }) => {
        safeSend({
          type: 'activity',
          activity: browserEffectActivity({ state: 'failed', operation })
        });
        const diagnostics = await captureFailure(page, config.outputDir, `action-${operation}`, outputBudget);
        lastScreenshot = diagnostics.screenshotPath;
      }
    });
    activeActionHelper = rawAction;
    safeSend({
      type: 'behavior',
      behavior: {
        configured: rawAction.mode,
        effective: rawAction.effectiveMode,
        ...(rawAction.mode === 'auto' ? { auto: rawAction.autoState } : {}),
        at: new Date().toISOString()
      }
    });
    const persistUnknownProofBoundary = async () => {
      try {
        await recordEffectEvent({ state: 'started', operation: 'custom' });
      } catch (error) {
        // A pending effect already provides the required no-replay barrier.
        if (error?.code !== 'TASK_EFFECT_OUTCOME_UNKNOWN') throw error;
      }
    };
    const activeProofScopes = new Map();
    let proofScopeSequence = 0;
    const sealProofScope = async (scope) => {
      await effectRecordTail;
      if (scope.sealed || terminalEffectGeneration <= scope.generationAtStart) return;
      if (!scope.sealPromise) {
        scope.sealPromise = persistUnknownProofBoundary().then(() => {
          scope.sealed = true;
        });
      }
      await scope.sealPromise;
    };
    sealPendingProofBoundaries = async () => {
      const scopes = [...activeProofScopes.values()];
      await effectRecordTail;
      for (const scope of scopes) await sealProofScope(scope);
    };
    const runExclusiveAction = (operation, callback) => {
      // Reserve both Task admission and the shared Task/extension FIFO
      // synchronously. A pre-completion action keeps its Task ticket while it
      // waits behind an extension; coordinator rejection cancels that ticket.
      let reservation;
      try {
        assertResumeCheckpointConsumed();
        reservation = actionArbiter.reserve(operation);
      } catch (error) {
        const rejection = Promise.reject(error);
        rejection.catch(() => {});
        return rejection;
      }
      const coordinated = extensionCoordinator.run(operation, () => reservation.execute(async () => {
        const scope = {
          id: ++proofScopeSequence,
          generationAtStart: terminalEffectGeneration,
          sealed: false,
          sealPromise: null
        };
        activeProofScopes.set(scope.id, scope);
        try {
          const result = await pauseGate.run(callback);
          // A timed-out task can abort while a successful effect record is still
          // being flushed. Never let the late success erase the unknown boundary.
          if (executionSignal.aborted) await sealProofScope(scope);
          activeProofScopes.delete(scope.id);
          return result;
        } catch (error) {
          // The primitive can be durably succeeded before Journey verification,
          // settling, or the outer extension slot finishes. If that outer proof
          // fails, persist a new unknown boundary so resume cannot replay blindly.
          await sealProofScope(scope);
          activeProofScopes.delete(scope.id);
          throw error;
        }
      }));
      return coordinated.catch(async (error) => {
        await reservation.cancel();
        throw error;
      });
    };
    const guardedAction = (method) => (...args) => (
      runExclusiveAction(method, () => rawAction[method](...args))
    );
    const action = Object.freeze({
      get mode() { return rawAction.mode; },
      get effectiveMode() { return rawAction.effectiveMode; },
      get autoState() { return rawAction.autoState; },
      get adaptiveState() { return rawAction.adaptiveState; },
      get audit() { return rawAction.audit; },
      signal: (...args) => rawAction.signal(...args),
      run: guardedAction('run'),
      goto: guardedAction('goto'),
      click: guardedAction('click'),
      fill: guardedAction('fill'),
      type: guardedAction('type'),
      hover: guardedAction('hover'),
      select: guardedAction('select'),
      scroll: guardedAction('scroll'),
      survey: guardedAction('survey'),
      read: guardedAction('read'),
      wait: guardedAction('wait')
    });
    const capture = Object.freeze({
      viewport: (options = {}) => runExclusiveAction('capture-viewport', async () => {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
          const error = new TypeError('capture.viewport options must be an object');
          error.code = 'TASK_CAPTURE_INVALID';
          throw error;
        }
        const unknown = Object.keys(options).filter((key) => key !== 'file');
        if (unknown.length) {
          const error = new TypeError(`Unsupported capture.viewport fields: ${unknown.join(', ')}`);
          error.code = 'TASK_CAPTURE_INVALID';
          throw error;
        }
        const file = typeof options.file === 'string' ? options.file : '';
        if (!/^[a-z0-9][a-z0-9._-]{0,119}\.(?:png|jpe?g)$/iu.test(file) || path.basename(file) !== file) {
          const error = new TypeError('capture.viewport file must be a bounded PNG or JPEG basename');
          error.code = 'TASK_CAPTURE_INVALID';
          throw error;
        }
        const target = path.join(config.outputDir, file);
        await outputBudget.assertSafeRoot();
        try {
          await lstat(target);
          const error = new Error('capture.viewport never overwrites an existing artifact');
          error.code = 'TASK_CAPTURE_FILE_EXISTS';
          throw error;
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
        const jpeg = /\.jpe?g$/iu.test(file);
        const image = Buffer.from(await page.screenshot({
          type: jpeg ? 'jpeg' : 'png',
          ...(jpeg ? { quality: 80 } : {}),
          fullPage: false,
          animations: 'allow',
          caret: 'initial'
        }));
        if (!image.length) {
          const error = new Error('capture.viewport returned an empty image');
          error.code = 'TASK_CAPTURE_FAILED';
          throw error;
        }
        await writeBufferAtomic(target, image);
        await outputBudget.assertWithinBudget();
        return Object.freeze({ file, sizeBytes: image.length });
      })
    });
    let journey = null;
    let taskPage;
    let taskContext;
    let taskAction = action;
    let observation;
    if (fullHumanJourney) {
      journey = createJourneyHelper({
        page,
        action: rawAction,
        contract: FULL_HUMAN_INTERACTION_CONTRACT,
        runStep: runExclusiveAction,
        coordinationAudit: () => ({
          ...actionArbiter.audit(),
          extension: extensionCoordinator.audit()
        }),
        unwrapLocator: unwrapTaskLocator,
        onState: ({ phase, operation, at }) => safeSend({
          type: 'activity',
          activity: {
            phase: operation.includes('scroll') ? 'scrolling'
              : operation.includes('fill') || operation.includes('type') ? 'typing'
                : operation.includes('click') || operation.includes('page') || operation.includes('navigate') ? 'clicking'
                  : operation === 'open' ? 'navigating' : 'working',
            status: phase === 'started' ? 'active' : phase === 'succeeded' ? 'succeeded' : 'unknown',
            updatedAt: at
          }
        })
      });
      observation = createObservationFacade({
        page,
        context,
        capability: observationCapability,
        onViolation: (event) => journey.violation(event)
      });
      taskAction = restrictedPackAction(action);
    } else {
      observation = createObservationFacade({
        page,
        context,
        capability: observationCapability,
        requiredFacade: 'action'
      });
    }
    // Every task kind receives the same read-only browser surface. Extensions
    // still execute with their native browser permissions, while Task code must
    // route mutations through action/journey so both peers share one FIFO.
    taskPage = observation.page;
    taskContext = observation.context;
    semantic = createSemanticObserver({
      page,
      action: fullHumanJourney ? journey : action,
      locatorTransform: observation.locator
    });
    activeSemantic = semantic;
    let runtimeControlAccepting = true;
    let runtimeControlTail = Promise.resolve();
    const runtimeControlRejection = (code, message) => {
      const error = new Error(message);
      error.code = code;
      const rejection = Promise.reject(error);
      rejection.catch(() => {});
      return rejection;
    };
    const queueRuntimeControl = (operation, callback) => {
      if (!runtimeControlAccepting) {
        return runtimeControlRejection(
          'TASK_CONTROL_AFTER_COMPLETION',
          'Runtime control was issued after the task entered completion'
        );
      }
      if (executionSignal.aborted) {
        const rejection = Promise.reject(
          executionSignal.reason instanceof Error ? executionSignal.reason : new TaskCancelledError()
        );
        rejection.catch(() => {});
        return rejection;
      }
      const operationPromise = runExclusiveAction(operation, callback);
      runtimeControlTail = Promise.allSettled([runtimeControlTail, operationPromise]).then(() => {});
      return operationPromise;
    };
    sealRuntimeControlBoundary = () => { runtimeControlAccepting = false; };
    drainRuntimeControlBoundary = async () => { await runtimeControlTail; };
    activeRuntimeControl = Object.freeze({
      focus: (requestId) => queueRuntimeControl('focus-task-page', async () => {
        if (!activePage || activePage.isClosed()) {
          const error = new Error('Task Worker has no live page to focus');
          error.code = 'TASK_FOCUS_NO_LIVE_PAGE';
          throw error;
        }
        await activePage.bringToFront();
        if (executionSignal.aborted) throw (
          executionSignal.reason instanceof Error ? executionSignal.reason : new TaskCancelledError()
        );
        safeSend({ type: 'focus_applied', requestId, at: new Date().toISOString() });
      }),
      diagnose: (reason) => queueRuntimeControl('external-diagnostic', async () => {
        const diagnostics = await captureFailure(
          activePage,
          config.outputDir,
          reason || 'diagnostic',
          outputBudget,
          semantic
        );
        if (diagnostics.screenshotPath) lastScreenshot = diagnostics.screenshotPath;
        if (!executionSignal.aborted) {
          safeSend({ type: 'heartbeat', at: new Date().toISOString(), progress: activeProgress });
        }
        return diagnostics;
      }),
      seal: sealRuntimeControlBoundary,
      beforeCompletion: drainRuntimeControlBoundary
    });
    const handoff = createUserHandoff({
      signal: executionSignal,
      capture: (reason) => runExclusiveAction(
        'handoff-diagnostic',
        () => captureFailure(page, config.outputDir, reason, outputBudget, semantic)
      ),
      onRequest: async (request, diagnostics) => safeSend({
        type: 'waiting_user',
        request,
        diagnostics: {
          ...(diagnostics?.screenshotPath ? {
            screenshot: { path: diagnostics.screenshotPath, reason: diagnostics.reason }
          } : {}),
          ...(diagnostics?.observationPath ? {
            observation: { path: diagnostics.observationPath, reason: diagnostics.reason }
          } : {})
        }
      }),
      onState: async (state) => safeSend({ type: 'state', state }),
      onProgress: async (message) => progress({
        current: activeProgress.current,
        total: activeProgress.total,
        message
      })
    });
    activeHandoff = handoff;
    sealHandoffBoundary = () => handoff.seal();
    let handoffDrainPromise = null;
    drainHandoffBoundary = () => {
      if (!handoffDrainPromise) {
        handoffDrainPromise = handoff.drain({ timeoutMs: handoffDrainTimeoutMs });
        handoffDrainPromise.catch(() => {});
      }
      return handoffDrainPromise;
    };
    cooldown = createCooldownHelper({
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
    sealCooldownBoundary = () => cooldown.seal();

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
      page: taskPage,
      context: taskContext,
      input: config.input,
      outputDir: config.outputDir,
      action: taskAction,
      ...(journey ? { journey } : {}),
      cooldown,
      effects,
      semantic,
      capture,
      extensionFlow,
      handoff,
      failure: createTaskFailureFacade(),
      progress,
      checkpoint,
      signal: executionSignal
    }));
    taskPromise.catch(() => {});

    const rawResult = await Promise.race([taskPromise, timeoutPromise, cancellationPromise, budgetPromise]);
    // Completion is a two-phase barrier. Seal every durable/control/action
    // ingress path synchronously before awaiting any admitted operation.
    const handoffActiveAtCompletion = sealHandoffBoundary();
    const cooldownActiveAtCompletion = sealCooldownBoundary();
    sealProgressBoundary();
    sealRuntimeControlBoundary();
    sealCheckpointBoundary();
    sealEffectResolutionBoundary();
    pauseGate.seal();
    actionArbiter.seal();
    extensionCoordinator.seal();
    if (handoffActiveAtCompletion) {
      const error = new Error('Task returned while a user handoff was still active');
      error.code = 'TASK_USER_HANDOFF_NOT_AWAITED';
      throw error;
    }
    if (cooldownActiveAtCompletion) {
      const error = new Error('Task returned while a cooldown was still active');
      error.code = 'TASK_COOLDOWN_NOT_AWAITED';
      throw error;
    }
    await drainProgressBoundary();
    await drainRuntimeControlBoundary();
    await drainCheckpointBoundary();
    await drainEffectResolutionBoundary();
    await pauseGate.beforeCompletion();
    // Seal both action ingress paths first,
    // then give an already-started unknown browser effect precedence over a
    // queue-drain timeout. Re-check after draining because an admitted queued
    // action may only create its effect record once it starts.
    await effectJournal.assertSettled();
    await actionArbiter.beforeCompletion();
    await extensionCoordinator.beforeCompletion();
    if (config.resumeCheckpoint && !resumeCheckpointConsumed) {
      const error = new Error('Resumed task did not consume its frozen checkpoint');
      error.code = 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED';
      throw error;
    }
    let interactionAudit = null;
    if (journey) {
      interactionAudit = journey.assertComplete();
      await writeJsonAtomic(path.join(config.outputDir, 'interaction-audit.json'), interactionAudit);
    }
    await outputBudget.assertWithinBudget();
    await effectJournal.assertSettled();
    const resultInput = interactionAudit
      ? {
          ...rawResult,
          evidence: [
            ...rawResult.evidence,
            {
              kind: 'artifact',
              file: 'interaction-audit.json',
              agentVisible: true,
              label: 'full-human-v1 interaction audit'
            }
          ]
        }
      : rawResult;
    if (interactionAudit && rawResult.evidence.length >= 32) {
      const error = new Error('full-human-v1 Task Pack results must leave one evidence slot for the interaction audit');
      error.code = 'TASK_INTERACTION_AUDIT_EVIDENCE_LIMIT';
      throw error;
    }
    const result = normalizeResult(resultInput);
    // Enter a non-runnable verification phase before hashing output so a large
    // but bounded tree cannot be mistaken for stalled task logic. The Worker
    // publishes its exact content-addressed snapshot before the completion
    // claim; Manager compares it again only after this process exits.
    safeSend({ type: 'state', state: 'verifying' });
    const outputSeal = await snapshotOutputTree({
      root: config.outputDir,
      limits: outputSealLimitsForBudget(outputBudget.limits)
    });
    safeSend({ type: 'output_seal', snapshot: outputSeal });
    safeSend({ type: 'result', result });
    safeSend({ type: 'state', state: 'completed' });
    return { state: 'completed', result };
  } catch (error) {
    sealHandoffBoundary();
    sealCooldownBoundary();
    sealProgressBoundary();
    sealRuntimeControlBoundary();
    sealCheckpointBoundary();
    sealEffectResolutionBoundary();
    await drainProgressBoundary().catch(() => {});
    await drainRuntimeControlBoundary().catch(() => {});
    await drainEffectResolutionBoundary().catch(() => {});
    try {
      await sealPendingProofBoundaries();
    } catch (proofBoundaryError) {
      error = proofBoundaryError;
    }
    // Stop cooperative task code and reject every new action before diagnostic
    // work begins. The browser stays open only long enough for the bounded
    // screenshot, then finally closes it unconditionally.
    if (!executionSignal.aborted) executionController.abort(error);
    await drainHandoffBoundary().catch(() => {});
    const cancelled = error instanceof TaskCancelledError || error?.code === 'TASK_CANCELLED';
    if (!cancelled && !lastScreenshot) {
      const diagnostics = await captureFailure(
        activePage,
        config.outputDir,
        error?.code || 'task-failure',
        outputBudget
      );
      lastScreenshot = diagnostics.screenshotPath;
    }
    const state = cancelled ? 'cancelled' : 'failed';
    safeSend({ type: 'error', state, error: errorPayload(error, lastScreenshot) });
    safeSend({ type: 'state', state });
    return { state, error: errorPayload(error, lastScreenshot) };
  } finally {
    sealHandoffBoundary();
    sealCooldownBoundary();
    sealProgressBoundary();
    sealRuntimeControlBoundary();
    sealCheckpointBoundary();
    sealEffectResolutionBoundary();
    await drainHandoffBoundary().catch(() => {});
    await drainProgressBoundary().catch(() => {});
    await drainRuntimeControlBoundary().catch(() => {});
    await drainCheckpointBoundary().catch(() => {});
    await drainEffectResolutionBoundary().catch(() => {});
    stopBudgetChecks();
    clearInterval(heartbeatTimer);
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', forwardCancellation);
    if (cancellationListener) signal?.removeEventListener('abort', cancellationListener);
    // Freeze the durable effect boundary before aborting module work. An action
    // that resumes only because cleanup fired must not overwrite a pending
    // unknown outcome with a misleading terminal record.
    await sealPendingProofBoundaries().catch(() => {});
    await effectJournal?.close?.().catch(() => {});
    await activeExtensionCoordinator?.close?.().catch(() => {});
    activeExtensionCoordinator = null;
    if (!executionSignal.aborted) executionController.abort(new TaskCancelledError());
    browserClosed = await closeTaskBrowserSession(context, browser);
    let cleanupReceiptWritten = false;
    if (browserClosed && config.cleanupReceiptPath) {
      try {
        await writeCleanupReceipt(config.cleanupReceiptPath, {
          kind: 'task',
          taskId: config.taskId,
          attempt: config.attempt,
          checkpoint: lastCheckpointReceipt
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
    activePauseControl = null;
    activeRuntimeControl = null;
    pendingPauseControls = [];
    activeActionHelper = null;
    pendingBehavior = null;
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
    if (message?.type === 'set_behavior') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : null;
      try {
        if (!isBehaviorMode(message.behavior)) {
          const error = new TypeError(`Unsupported behavior mode: ${message.behavior}`);
          error.code = 'TASK_BEHAVIOR_UNSUPPORTED';
          throw error;
        }
        pendingBehavior = message.behavior;
        const state = activeActionHelper
          ? activeActionHelper.setMode(message.behavior)
          : {
              configured: message.behavior,
              effective: message.behavior === 'auto' ? 'fast' : message.behavior,
              ...(message.behavior === 'auto'
                ? { auto: { level: 0, label: 'fast', actionsRemaining: 0, signal: null } }
                : {})
            };
        safeSend({
          type: 'behavior_applied',
          requestId,
          behavior: { ...state, at: new Date().toISOString() }
        });
      } catch (error) {
        safeSend({
          type: 'behavior_control_error',
          requestId,
          error: errorPayload(error)
        });
      }
    }
    if (message?.type === 'pause' || message?.type === 'resume_pause') {
      const operation = message.type === 'pause' ? 'requestPause' : 'requestResume';
      if (!activePauseControl) {
        pendingPauseControls.push({ type: message.type, commandId: message.commandId || null });
      } else {
        void activePauseControl[operation](message.commandId || null).catch((error) => {
          safeSend({
            type: 'control_error',
            commandId: message.commandId || null,
            error: errorPayload(error)
          });
        });
      }
    }
    if (message?.type === 'continue') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : null;
      void (async () => {
        if (!activeHandoff) {
          const error = new Error('Task Worker has no active user handoff');
          error.code = 'USER_HANDOFF_NOT_ACTIVE';
          throw error;
        }
        const applied = await activeHandoff.continue({ requestId, note: message.note });
        if (!applied) {
          const error = new Error('User handoff does not match the active Worker request');
          error.code = 'USER_HANDOFF_MISMATCH';
          throw error;
        }
        safeSend({ type: 'continue_applied', requestId, at: new Date().toISOString() });
      })().catch((error) => {
        safeSend({ type: 'continue_control_error', requestId, error: errorPayload(error) });
      });
    }
    if (message?.type === 'focus') {
      const requestId = typeof message.requestId === 'string' ? message.requestId : null;
      void (async () => {
        if (!activeRuntimeControl) {
          const error = new Error('Task Worker has no live page to focus');
          error.code = 'TASK_FOCUS_NO_LIVE_PAGE';
          throw error;
        }
        await activeRuntimeControl.focus(requestId);
      })().catch((error) => {
        safeSend({ type: 'focus_control_error', requestId, error: errorPayload(error) });
      });
    }
    if (message?.type === 'diagnose') {
      void activeRuntimeControl?.diagnose(message.reason || 'diagnostic').catch(() => {});
    }
  });

  process.on('disconnect', () => controller.abort());
}
