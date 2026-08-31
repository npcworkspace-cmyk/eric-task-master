import { randomUUID } from 'node:crypto';

export const EXTENSION_ACTION_PROTOCOL = Object.freeze({
  version: 'taskmaster-cooperative-v2',
  requestEvent: 'eric-task-master:extension-action-request-v2',
  grantEvent: 'eric-task-master:extension-action-grant-v2',
  releaseEvent: 'eric-task-master:extension-action-release-v2'
});

const PARTICIPANT_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const MAX_EXTENSION_QUEUE_DEPTH = 256;
const DEFAULT_MAX_REQUEST_RECORDS = 8_192;
const MAX_COMPLETION_WAITERS = 1;
const MAX_COMPLETION_FACTS = 16;
const BOUNDARY_ACQUISITION_CLOSE_GRACE_MS = 100;
const COMPLETION_STATUSES = new Set(['succeeded', 'not_applied', 'unknown']);
const COMPLETION_DECISIONS = new Set(['verified', 'rejected']);

function boundedInteger(value, fallback, minimum, maximum) {
  const normalized = Number(value ?? fallback);
  if (!Number.isSafeInteger(normalized)) return fallback;
  return Math.max(minimum, Math.min(maximum, normalized));
}

function safeIdentifier(value, fallback, pattern) {
  const normalized = String(value || '').slice(0, 80);
  return pattern.test(normalized) ? normalized : fallback;
}

function strictIdentifier(value, pattern) {
  return typeof value === 'string' && value.length <= 80 && pattern.test(value) ? value : null;
}

function completionError(code, message) {
  return Object.assign(new Error(message), { code });
}

function observedRejection(error) {
  const rejection = Promise.reject(error);
  rejection.catch(() => {});
  return rejection;
}

function normalizeCompletionOutcome(value, fallbackCode = 'outcome-missing') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({ status: 'unknown', code: fallbackCode, facts: Object.freeze([]) });
  }
  const status = COMPLETION_STATUSES.has(value.status) ? value.status : null;
  const code = strictIdentifier(value.code, OPERATION_PATTERN);
  const facts = Array.isArray(value.facts) && value.facts.length <= MAX_COMPLETION_FACTS
    ? value.facts.map((fact) => strictIdentifier(fact, OPERATION_PATTERN))
    : null;
  if (!status || !code || !facts || facts.some((fact) => !fact)) {
    return Object.freeze({ status: 'unknown', code: 'outcome-invalid', facts: Object.freeze([]) });
  }
  return Object.freeze({ status, code, facts: Object.freeze(facts) });
}

export class BrowserActionConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BrowserActionConflictError';
    this.code = 'BROWSER_ACTION_CONFLICT';
    this.details = Object.freeze({ ...details });
  }
}

function installPageBridge(config) {
  if (globalThis[config.installMarker]) return;
  Object.defineProperty(globalThis, config.installMarker, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const invoke = (payload) => {
    const bridge = globalThis[config.bindingName];
    if (typeof bridge !== 'function') return Promise.resolve({ ok: false, reason: 'bridge-unavailable' });
    return Promise.resolve(bridge(payload)).catch(() => ({ ok: false, reason: 'bridge-failed' }));
  };
  const requestStates = new Map();
  const leaseRequests = new Map();

  document.addEventListener(config.requestEvent, (event) => {
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
    const participantId = String(detail.participantId || '').slice(0, 80);
    const requestId = String(detail.requestId || '').slice(0, 80);
    const requestKey = `${participantId}\u0000${requestId}`;
    const existing = requestStates.get(requestKey);
    if (existing) {
      // The original pending request will still publish its one final result to
      // every listener in this document. Once granted or settled, retries get
      // an explicit terminal rejection instead of hanging or replaying work.
      if (existing.state === 'pending') return;
      document.dispatchEvent(new CustomEvent(config.grantEvent, {
        detail: {
          ok: false,
          participantId,
          requestId,
          reason: existing.state === 'settled' ? 'request-settled' : 'request-duplicate'
        }
      }));
      return;
    }
    if (requestStates.size >= config.maxRequestRecords) {
      document.dispatchEvent(new CustomEvent(config.grantEvent, {
        detail: { ok: false, participantId, requestId, reason: 'request-capacity' }
      }));
      return;
    }
    const requestState = { state: 'pending', leaseId: null };
    requestStates.set(requestKey, requestState);
    invoke({
      kind: 'request',
      participantId,
      requestId,
      operation: detail.operation,
      durationMs: detail.durationMs
    }).then(async (result) => {
      let delivered = result;
      if (result?.ok === true && result?.leaseId) {
        const validation = await invoke({
          kind: 'validate',
          participantId,
          requestId,
          leaseId: result.leaseId
        });
        if (validation?.ok !== true) delivered = { ok: false, reason: 'lease-expired' };
      }
      if (delivered?.ok === true && delivered?.leaseId) {
        requestState.state = 'active';
        requestState.leaseId = delivered.leaseId;
        leaseRequests.set(delivered.leaseId, requestState);
      } else {
        requestState.state = 'settled';
      }
      document.dispatchEvent(new CustomEvent(config.grantEvent, {
        detail: {
          ok: delivered?.ok === true,
          participantId,
          requestId: String(detail.requestId || '').slice(0, 80),
          ...(delivered?.leaseId ? { leaseId: delivered.leaseId } : {}),
          ...(delivered?.expiresAt ? { expiresAt: delivered.expiresAt } : {}),
          ...(delivered?.reason ? { reason: delivered.reason } : {})
        }
      }));
    });
  }, true);

  document.addEventListener(config.releaseEvent, (event) => {
    const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
    const leaseId = String(detail.leaseId || '').slice(0, 80);
    const requestState = leaseRequests.get(leaseId);
    if (requestState) {
      requestState.state = 'settled';
      leaseRequests.delete(leaseId);
    }
    invoke({
      kind: 'release',
      participantId: detail.participantId,
      leaseId,
      outcome: detail.outcome
    });
  }, true);
}

function emptyAudit(enabled) {
  return Object.freeze({
    enabled,
    protocol: EXTENSION_ACTION_PROTOCOL.version,
    identityBoundary: 'cooperative-not-authenticated',
    active: 0,
    pending: 0,
    taskLeases: 0,
    extensionLeases: 0,
    conflicts: 0,
    leaseTimeouts: 0,
    duplicateRequests: 0,
    requestCapacityRejects: 0,
    navigationReleases: 0,
    completionExpectations: 0,
    completionGate: 0,
    completionCheckpointed: 0,
    completionEffectPending: 0,
    completionReceipts: 0,
    boundaryAcquisitions: 0,
    healthy: true,
    maximumActive: 0,
    serialized: true
  });
}

function disabledCoordinator() {
  const unavailable = () => observedRejection(completionError(
    'EXTENSION_COMPLETION_UNAVAILABLE',
    'Extension completion coordination is disabled for this Profile'
  ));
  return Object.freeze({
    enabled: false,
    protocol: EXTENSION_ACTION_PROTOCOL.version,
    run: async (_operation, callback) => callback(),
    expectCompletion: unavailable,
    resolveCompletion: unavailable,
    checkpointContext: () => null,
    checkpointCompleted: () => null,
    pause: () => {},
    resume: () => {},
    seal: () => {},
    beforeCompletion: async () => {},
    beforeEffectSuccess: async () => {},
    assertCurrentClean: () => {},
    audit: () => emptyAudit(false),
    close: async () => {}
  });
}

/**
 * Shares one bounded FIFO lease between Task Master and extensions that opt in
 * to taskmaster-cooperative-v2. This is a coordination contract, not an
 * extension-authentication boundary. Arbitrary third-party extensions cannot
 * be forced into this queue, so the runtime makes no synthetic-event guess
 * that would confuse ordinary website scripts with extension code.
 */
export async function createExtensionActionCoordinator({
  context,
  page,
  signal,
  enabled = false,
  extensionWaitMs = 5_000,
  extensionLeaseMs = 4_000,
  maxRequestRecords = DEFAULT_MAX_REQUEST_RECORDS,
  onExtensionEffect = null,
  acquireExtensionBoundary = null
} = {}) {
  if (!enabled) return disabledCoordinator();
  if (!context || typeof context.exposeBinding !== 'function' || typeof context.addInitScript !== 'function') {
    const error = new Error('Extension action coordination requires BrowserContext bindings and init scripts');
    error.code = 'EXTENSION_ACTION_COORDINATION_UNAVAILABLE';
    throw error;
  }
  if (!page || typeof page.evaluate !== 'function') {
    const error = new Error('Extension action coordination requires an active task page');
    error.code = 'EXTENSION_ACTION_COORDINATION_UNAVAILABLE';
    throw error;
  }

  const bindingName = `__ericTaskMasterExtensionBridge_${randomUUID().replaceAll('-', '')}`;
  const installMarker = `__ericTaskMasterExtensionCoordinator_${randomUUID().replaceAll('-', '')}`;
  const boundedExtensionWaitMs = boundedInteger(extensionWaitMs, 5_000, 250, 15_000);
  const boundedExtensionLeaseMs = boundedInteger(extensionLeaseMs, 4_000, 250, 10_000);
  const boundedMaxRequestRecords = boundedInteger(maxRequestRecords, DEFAULT_MAX_REQUEST_RECORDS, 32, 65_536);
  if (onExtensionEffect !== null && typeof onExtensionEffect !== 'function') {
    throw new TypeError('onExtensionEffect must be a function when provided');
  }
  if (acquireExtensionBoundary !== null && typeof acquireExtensionBoundary !== 'function') {
    throw new TypeError('acquireExtensionBoundary must be a function when provided');
  }
  const bridgeConfig = Object.freeze({
    bindingName,
    installMarker,
    requestEvent: EXTENSION_ACTION_PROTOCOL.requestEvent,
    grantEvent: EXTENSION_ACTION_PROTOCOL.grantEvent,
    releaseEvent: EXTENSION_ACTION_PROTOCOL.releaseEvent,
    maxRequestRecords: boundedMaxRequestRecords
  });
  const queue = [];
  const requestRecords = new Map();
  const completionWaiters = [];
  let holder = null;
  let completionGate = null;
  let completionReceipts = 0;
  let closed = false;
  let paused = false;
  let acceptingExtensions = true;
  let taskLeases = 0;
  let extensionLeases = 0;
  let conflicts = 0;
  let leaseTimeouts = 0;
  let duplicateRequests = 0;
  let requestCapacityRejects = 0;
  let navigationReleases = 0;
  let maximumActive = 0;
  let poisonedError = null;
  const pendingBoundaryAcquisitions = new Set();
  const inFlightOperations = new Set();
  const pendingBoundarySettlements = new Set();
  let extensionBoundaryTail = Promise.resolve();
  let closePromise = null;
  const lifecycleController = new AbortController();

  const abortError = () => {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error('Task execution was aborted');
    error.code = 'TASK_CANCELLED';
    return error;
  };

  function trackOperation(candidate) {
    const operation = Promise.resolve(candidate);
    inFlightOperations.add(operation);
    operation.then(
      () => inFlightOperations.delete(operation),
      () => inFlightOperations.delete(operation)
    );
    return operation;
  }

  function raceLifecycle(candidate) {
    const operation = Promise.resolve(candidate);
    operation.catch(() => {});
    if (lifecycleController.signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(abortError());
      lifecycleController.signal.addEventListener('abort', onAbort, { once: true });
      operation.then(
        (value) => {
          lifecycleController.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          lifecycleController.signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  function conflictError(details = {}) {
    conflicts += 1;
    const eventType = safeIdentifier(details.eventType, 'coordination-conflict', OPERATION_PATTERN);
    return new BrowserActionConflictError(
      `The cooperative browser-action queue could not grant a bounded lease (${eventType})`,
      details
    );
  }

  function requestKey(participantId, requestId) {
    return `${participantId}\u0000${requestId}`;
  }

  function settleRequestRecord(item) {
    if (!item.requestKey) return;
    const record = requestRecords.get(item.requestKey);
    if (record) record.state = 'settled';
  }

  function releaseQueuedBoundary(item) {
    const releaseBoundary = item?.extensionBoundaryRelease;
    if (typeof releaseBoundary !== 'function') return;
    item.extensionBoundaryRelease = null;
    scheduleBoundaryRelease(releaseBoundary).catch(() => {});
  }

  function rejectQueueItem(item, error) {
    if (!item || item.settled) return false;
    item.settled = true;
    clearTimeout(item.waitTimer);
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    settleRequestRecord(item);
    releaseQueuedBoundary(item);
    item.reject(error);
    return true;
  }

  function rejectQueued(error) {
    for (const item of [...queue]) rejectQueueItem(item, error);
  }

  function rejectCompletionWaiters(error) {
    while (completionWaiters.length) {
      const waiter = completionWaiters.shift();
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function scheduleBoundaryRelease(callback) {
    if (typeof callback !== 'function') return Promise.resolve();
    const operation = extensionBoundaryTail.then(() => callback());
    extensionBoundaryTail = operation.catch(() => {
      poisonedError = poisonedError || conflictError({
        eventType: 'extension-pause-boundary-release-failed'
      });
      rejectQueued(poisonedError);
      rejectCompletionWaiters(poisonedError);
    });
    return operation;
  }

  async function acquirePauseBoundary() {
    if (!acquireExtensionBoundary) return null;
    if (closed) throw Object.assign(new Error('Extension action coordinator is closed'), { code: 'TASK_CANCELLED' });
    if (!acceptingExtensions) {
      throw completionError(
        'EXTENSION_COMPLETION_AFTER_COMPLETION',
        'Extension action requests cannot enter the task after completion begins'
      );
    }
    const token = {
      cancelled: false,
      adopted: false,
      releasePromise: null,
      reject: null,
      controller: new AbortController()
    };
    const cancelled = new Promise((_, reject) => { token.reject = reject; });
    cancelled.catch(() => {});
    const acquisition = Promise.resolve().then(() => acquireExtensionBoundary({
      signal: token.controller.signal
    }));
    const scheduleTokenBoundaryRelease = (releaseBoundary) => {
      if (!token.releasePromise) token.releasePromise = scheduleBoundaryRelease(releaseBoundary);
      return token.releasePromise;
    };
    const settlement = acquisition.then((releaseBoundary) => {
      if (token.cancelled && !token.adopted && typeof releaseBoundary === 'function') {
        scheduleTokenBoundaryRelease(releaseBoundary).catch(() => {});
      }
    }, () => {});
    pendingBoundarySettlements.add(settlement);
    settlement.finally(() => pendingBoundarySettlements.delete(settlement)).catch(() => {});
    pendingBoundaryAcquisitions.add(token);
    try {
      const releaseBoundary = await Promise.race([acquisition, cancelled]);
      if (typeof releaseBoundary !== 'function') {
        throw new TypeError('Extension pause boundary did not return a release function');
      }
      if (closed || token.cancelled || !acceptingExtensions) {
        await scheduleTokenBoundaryRelease(releaseBoundary).catch(() => {});
        if (closed || token.cancelled) {
          throw Object.assign(new Error('Extension action coordinator is closed'), { code: 'TASK_CANCELLED' });
        }
        throw completionError(
          'EXTENSION_COMPLETION_AFTER_COMPLETION',
          'Extension action requests cannot enter the task after completion begins'
        );
      }
      token.adopted = true;
      return releaseBoundary;
    } finally {
      pendingBoundaryAcquisitions.delete(token);
    }
  }

  function cancelBoundaryAcquisitions(error) {
    for (const token of pendingBoundaryAcquisitions) {
      if (token.cancelled) continue;
      token.cancelled = true;
      token.controller.abort(error);
      token.reject(error);
    }
  }

  async function waitForBoundaryAcquisitionGrace() {
    const settlements = [...pendingBoundarySettlements];
    if (!settlements.length) return;
    let timer = null;
    try {
      await Promise.race([
        Promise.allSettled(settlements),
        new Promise((resolve) => { timer = setTimeout(resolve, BOUNDARY_ACQUISITION_CLOSE_GRACE_MS); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function activeHandoff() {
    return completionWaiters[0] || null;
  }

  function matchesHandoff(waiter, item) {
    return Boolean(waiter && item &&
      waiter.participantId === item.participantId &&
      waiter.requestId === item.requestId &&
      waiter.operation === item.operation);
  }

  function poisonHandoff(eventType, details = {}) {
    const error = poisonedError || conflictError({ eventType, ...details });
    poisonedError = error;
    rejectQueued(error);
    rejectCompletionWaiters(error);
    return error;
  }

  function armCompletionTimeout(waiter) {
    if (!waiter || waiter.timer || paused) return;
    const delayMs = boundedInteger(waiter.timeoutRemainingMs, waiter.timeoutMs, 1, 60_000);
    waiter.timeoutDeadlineMs = Date.now() + delayMs;
    waiter.timer = setTimeout(() => {
      waiter.timer = null;
      waiter.timeoutDeadlineMs = null;
      const index = completionWaiters.indexOf(waiter);
      if (index < 0) return;
      completionWaiters.splice(index, 1);
      const timeoutError = completionError(
        'EXTENSION_COMPLETION_EXPECTATION_TIMEOUT',
        'The expected cooperative extension completion did not arrive in time'
      );
      poisonedError = conflictError({
        eventType: 'extension-completion-expectation-timeout',
        participantId: waiter.participantId,
        requestId: waiter.requestId,
        operation: waiter.operation
      });
      rejectQueued(poisonedError);
      rejectCompletionWaiters(poisonedError);
      waiter.reject(timeoutError);
    }, delayMs);
  }

  function pause() {
    if (closed || paused) return;
    paused = true;
    const waiter = activeHandoff();
    if (waiter?.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
      waiter.timeoutRemainingMs = Math.max(1, waiter.timeoutDeadlineMs - Date.now());
      waiter.timeoutDeadlineMs = null;
    }
  }

  function resume() {
    if (closed || !paused) return;
    paused = false;
    const waiter = activeHandoff();
    if (waiter?.phase === 'awaiting-extension') armCompletionTimeout(waiter);
    queueMicrotask(pump);
  }

  function matchCompletion(item, outcome, source) {
    const waiter = activeHandoff();
    if (!waiter || waiter.phase !== 'extension-active' ||
      waiter.extensionLeaseId !== item.leaseId || !matchesHandoff(waiter, item) ||
      item.extensionGrantState !== 'active') {
      if (item.handoffRole === 'extension') {
        poisonHandoff('extension-completion-holder-mismatch', {
          participantId: item.participantId,
          requestId: item.requestId,
          operation: item.operation
        });
      }
      return null;
    }
    if (completionGate) {
      poisonHandoff('extension-completion-gate-overlap');
      return null;
    }
    completionWaiters.shift();
    clearTimeout(waiter.timer);
    const receipt = Object.freeze({
      receiptId: randomUUID(),
      participantId: item.participantId,
      requestId: item.requestId,
      operation: item.operation,
      source,
      completedAt: new Date().toISOString(),
      outcome
    });
    completionGate = {
      receipt,
      checkpoint: null,
      effectSequence: Number.isSafeInteger(item.extensionEffectSequence)
        ? item.extensionEffectSequence
        : null
    };
    completionReceipts += 1;
    waiter.resolve(receipt);
    return receipt;
  }

  function completeExtensionHolder(item, { outcome, source, reason }) {
    matchCompletion(item, outcome, source);
    return release(item.leaseId, reason);
  }

  function release(leaseId, reason = 'released') {
    if (!holder || holder.leaseId !== leaseId) return false;
    const releasingHolder = holder;
    clearTimeout(releasingHolder.leaseTimer);
    settleRequestRecord(releasingHolder);
    holder = null;
    if (typeof releasingHolder.extensionBoundaryRelease === 'function') {
      scheduleBoundaryRelease(releasingHolder.extensionBoundaryRelease).catch(() => {});
    }
    if (releasingHolder.handoffRole === 'trigger' && reason === 'released') {
      const waiter = activeHandoff();
      if (!waiter || waiter.phase !== 'trigger-active' || waiter.triggerLeaseId !== leaseId) {
        poisonHandoff('extension-completion-trigger-state-lost');
      } else {
        waiter.phase = 'awaiting-extension';
        waiter.triggerSettledAt = new Date().toISOString();
        armCompletionTimeout(waiter);
      }
    }
    queueMicrotask(pump);
    return reason;
  }

  function pump() {
    if (closed || paused || poisonedError || holder || completionGate || queue.length === 0) return;
    const waiter = activeHandoff();
    const candidate = queue[0];
    let handoffRole = null;
    if (waiter?.phase === 'armed') {
      if (candidate.owner !== 'task') {
        poisonHandoff('extension-action-before-task-trigger', {
          participantId: candidate.participantId,
          requestId: candidate.requestId,
          operation: candidate.operation
        });
        return;
      }
      handoffRole = 'trigger';
    } else if (waiter?.phase === 'awaiting-extension') {
      if (candidate.owner !== 'extension' || !matchesHandoff(waiter, candidate)) {
        poisonHandoff('extension-completion-next-action-mismatch', {
          owner: candidate.owner,
          participantId: candidate.participantId,
          requestId: candidate.requestId,
          operation: candidate.operation
        });
        return;
      }
      handoffRole = 'extension';
    } else if (waiter && ['trigger-active', 'extension-active'].includes(waiter.phase)) {
      poisonHandoff('extension-completion-active-holder-lost', { phase: waiter.phase });
      return;
    }
    if (candidate.extensionBoundaryState === 'idle') {
      // Only the actual FIFO head may acquire the external pause boundary.
      // Pre-acquiring for a later extension item would make pause wait on work
      // that itself cannot run until earlier Task items resume and release.
      candidate.extensionBoundaryState = 'pending';
      candidate.prepareExtensionBoundary();
      return;
    }
    if (candidate.extensionBoundaryState === 'pending') return;
    if (handoffRole === 'trigger') waiter.phase = 'trigger-active';
    if (handoffRole === 'extension') waiter.phase = 'extension-active';
    const item = queue.shift();
    item.settled = true;
    item.handoffRole = handoffRole;
    clearTimeout(item.waitTimer);
    if (signal?.aborted) {
      settleRequestRecord(item);
      releaseQueuedBoundary(item);
      item.reject(abortError());
      queueMicrotask(pump);
      return;
    }
    const leaseId = randomUUID();
    const startedAt = Date.now();
    const durationMs = item.owner === 'extension' ? item.durationMs : null;
    const persistExtensionGrant = item.owner === 'extension' &&
      handoffRole === 'extension' && Boolean(onExtensionEffect);
    holder = {
      ...item,
      leaseId,
      startedAt,
      extensionGrantState: item.owner === 'extension'
        ? (persistExtensionGrant ? 'persisting' : 'active')
        : null,
      expiresAt: null,
      leaseTimer: null
    };
    const armLeaseTimer = (target, baseTime = Date.now()) => {
      if (!target || durationMs === null || target.leaseTimer) return;
      target.expiresAt = new Date(baseTime + durationMs).toISOString();
      target.leaseTimer = setTimeout(() => {
        leaseTimeouts += 1;
        poisonedError = conflictError({
          eventType: 'extension-lease-expired',
          participantId: item.participantId,
          operation: item.operation
        });
        release(leaseId, 'expired');
        rejectQueued(poisonedError);
        rejectCompletionWaiters(poisonedError);
      }, durationMs);
    };
    holder.armLeaseTimer = armLeaseTimer;
    if (item.owner === 'extension' && !persistExtensionGrant) armLeaseTimer(holder, startedAt);
    if (handoffRole === 'trigger') waiter.triggerLeaseId = leaseId;
    if (handoffRole === 'extension') waiter.extensionLeaseId = leaseId;
    maximumActive = Math.max(maximumActive, 1);
    if (item.owner === 'task') taskLeases += 1;
    else extensionLeases += 1;
    const lease = Object.freeze({
      owner: item.owner,
      leaseId,
      startedAt,
      ...(holder.expiresAt ? { expiresAt: holder.expiresAt } : {})
    });
    if (item.requestKey) {
      const record = requestRecords.get(item.requestKey);
      if (record) {
        record.state = 'active';
        record.response = { ok: true, leaseId: lease.leaseId, expiresAt: holder.expiresAt };
      }
    }
    item.resolve(lease);
  }

  function acquire({
    owner,
    participantId,
    requestId,
    operation,
    waitMs,
    durationMs = null,
    requestKey: durableRequestKey = null,
    sourcePage = null,
    sourceFrame = null,
    extensionBoundaryRelease = null,
    requiresExtensionBoundary = false
  }) {
    if (closed) return Promise.reject(Object.assign(new Error('Extension action coordinator is closed'), { code: 'TASK_CANCELLED' }));
    if (signal?.aborted) return Promise.reject(abortError());
    if (poisonedError) return Promise.reject(poisonedError);
    if (
      owner === 'extension' &&
      queue.filter((candidate) => candidate.owner === 'extension').length >= MAX_EXTENSION_QUEUE_DEPTH
    ) {
      return Promise.reject(conflictError({ eventType: 'coordination-queue-overflow', owner, operation }));
    }
    return new Promise((resolve, reject) => {
      const item = {
        owner,
        participantId,
        requestId,
        operation,
        durationMs,
        requestKey: durableRequestKey,
        sourcePage,
        sourceFrame,
        extensionBoundaryRelease,
        extensionBoundaryState: requiresExtensionBoundary ? 'idle' : 'ready',
        settled: false,
        resolve,
        reject,
        waitTimer: null,
        prepareExtensionBoundary: null
      };
      const armWaitTimer = () => {
        // Trusted Task work is bounded by the task lifecycle, cancellation,
        // and completion drain. A per-item wall-clock timer would wrongly
        // expire Task actions queued behind a valid long action or pause.
        if (!Number.isSafeInteger(waitMs) || waitMs <= 0 || item.settled || item.waitTimer) return;
        item.waitTimer = setTimeout(() => {
          if (item.settled) return;
          leaseTimeouts += 1;
          rejectQueueItem(item, conflictError({
            eventType: 'coordination-wait-timeout',
            owner,
            operation
          }));
          queueMicrotask(pump);
        }, waitMs);
      };
      queue.push(item);
      if (!requiresExtensionBoundary) {
        armWaitTimer();
        pump();
        return;
      }
      item.prepareExtensionBoundary = () => {
        const preparation = acquirePauseBoundary();
        preparation.then(
          (releaseBoundary) => {
            if (item.settled || closed || signal?.aborted || !acceptingExtensions) {
              scheduleBoundaryRelease(releaseBoundary).catch(() => {});
              if (!item.settled) {
                rejectQueueItem(item, closed || signal?.aborted
                  ? abortError()
                  : completionError(
                    'EXTENSION_COMPLETION_AFTER_COMPLETION',
                    'Extension action requests cannot enter the task after completion begins'
                  ));
              }
              queueMicrotask(pump);
              return;
            }
            item.extensionBoundaryRelease = releaseBoundary;
            item.extensionBoundaryState = 'ready';
            armWaitTimer();
            pump();
          },
          (error) => {
            rejectQueueItem(item, error);
            queueMicrotask(pump);
          }
        );
      };
      pump();
    });
  }

  function expectCompletion({ participantId, requestId, operation, timeoutMs = 5_000 } = {}) {
    try {
      if (closed) throw completionError('TASK_CANCELLED', 'Extension action coordinator is closed');
      if (signal?.aborted) throw abortError();
      if (poisonedError) throw poisonedError;
      if (!acceptingExtensions) {
        throw completionError(
          'EXTENSION_COMPLETION_AFTER_COMPLETION',
          'Extension completion expectations cannot be registered after task completion begins'
        );
      }
      const normalizedParticipantId = strictIdentifier(participantId, PARTICIPANT_PATTERN);
      const normalizedRequestId = strictIdentifier(requestId, PARTICIPANT_PATTERN);
      const normalizedOperation = strictIdentifier(operation, OPERATION_PATTERN);
      if (!normalizedParticipantId || !normalizedRequestId || !normalizedOperation) {
        throw completionError(
          'EXTENSION_COMPLETION_INVALID',
          'Extension completion participantId, requestId, and operation must be bounded identifiers'
        );
      }
      const exactRequestKey = requestKey(normalizedParticipantId, normalizedRequestId);
      if (completionGate || completionWaiters.length >= MAX_COMPLETION_WAITERS) {
        throw poisonHandoff('extension-completion-expectation-overlap', {
          participantId: normalizedParticipantId,
          requestId: normalizedRequestId,
          operation: normalizedOperation
        });
      }
      if (holder || queue.length || requestRecords.has(exactRequestKey)) {
        throw poisonHandoff('extension-completion-expectation-order-invalid', {
          participantId: normalizedParticipantId,
          requestId: normalizedRequestId,
          operation: normalizedOperation
        });
      }
      const boundedTimeoutMs = boundedInteger(timeoutMs, 5_000, 10, 60_000);
      const expectation = new Promise((resolve, reject) => {
        const waiter = {
          participantId: normalizedParticipantId,
          requestId: normalizedRequestId,
          operation: normalizedOperation,
          phase: 'armed',
          triggerLeaseId: null,
          triggerSettledAt: null,
          extensionLeaseId: null,
          timeoutMs: boundedTimeoutMs,
          timeoutRemainingMs: boundedTimeoutMs,
          timeoutDeadlineMs: null,
          resolve,
          reject,
          timer: null
        };
        completionWaiters.push(waiter);
      });
      // Task code intentionally creates this promise before its trigger action.
      // Observe rejection immediately so a timeout cannot crash a strict Node
      // Worker before the Task reaches its later `await completion` statement.
      expectation.catch(() => {});
      return expectation;
    } catch (error) {
      return observedRejection(error);
    }
  }

  function checkpointContext() {
    if (!completionGate) return null;
    const { receipt } = completionGate;
    return Object.freeze({
      receiptId: receipt.receiptId,
      participantId: receipt.participantId,
      requestId: receipt.requestId,
      operation: receipt.operation,
      completedAt: receipt.completedAt
    });
  }

  function checkpointCompleted(receiptId, checkpoint = {}) {
    const normalizedReceiptId = strictIdentifier(receiptId, OPERATION_PATTERN);
    if (!normalizedReceiptId || !completionGate ||
      completionGate.receipt.receiptId !== normalizedReceiptId) {
      throw completionError(
        'EXTENSION_COMPLETION_CHECKPOINT_MISMATCH',
        'Checkpoint does not belong to the pending extension completion receipt'
      );
    }
    const attempt = Number(checkpoint.attempt);
    const savedAt = typeof checkpoint.savedAt === 'string' ? checkpoint.savedAt : '';
    const sha256 = typeof checkpoint.sha256 === 'string' ? checkpoint.sha256 : '';
    const sizeBytes = Number(checkpoint.sizeBytes);
    if (!Number.isSafeInteger(attempt) || attempt < 1 ||
      !savedAt || Number.isNaN(Date.parse(savedAt)) ||
      !/^[a-f0-9]{64}$/u.test(sha256) ||
      !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
      throw completionError(
        'EXTENSION_COMPLETION_CHECKPOINT_INVALID',
        'Extension completion checkpoint receipt is invalid'
      );
    }
    completionGate.checkpoint = Object.freeze({
      receiptId: normalizedReceiptId,
      attempt,
      savedAt,
      sha256,
      sizeBytes
    });
    return completionGate.checkpoint;
  }

  function resolveCompletion(receiptId, { decision, code } = {}) {
    return trackOperation((async () => {
      if (closed) throw completionError('TASK_CANCELLED', 'Extension action coordinator is closed');
      if (signal?.aborted) throw abortError();
      const normalizedReceiptId = strictIdentifier(receiptId, OPERATION_PATTERN);
      const normalizedCode = strictIdentifier(code, OPERATION_PATTERN);
      if (!normalizedReceiptId || !COMPLETION_DECISIONS.has(decision) || !normalizedCode) {
        throw completionError(
          'EXTENSION_COMPLETION_RESOLUTION_INVALID',
          'Extension completion resolution requires a pending receipt, decision, and bounded code'
        );
      }
      if (!completionGate || completionGate.receipt.receiptId !== normalizedReceiptId) {
        throw completionError(
          'EXTENSION_COMPLETION_RECEIPT_MISMATCH',
          'Extension completion receipt is not the currently pending gate'
        );
      }
      const resolvingGate = completionGate;
      if (decision === 'verified' && !resolvingGate.checkpoint) {
        throw completionError(
          'EXTENSION_COMPLETION_CHECKPOINT_REQUIRED',
          'A new durable checkpoint for this receipt is required before verified resolution'
        );
      }
      if (decision === 'verified' && Number.isSafeInteger(resolvingGate.effectSequence)) {
        await raceLifecycle(onExtensionEffect({
          state: 'succeeded',
          operation: 'custom',
          sequence: resolvingGate.effectSequence
        }));
      }
      if (closed || signal?.aborted) throw abortError();
      if (completionGate !== resolvingGate || resolvingGate.receipt.receiptId !== normalizedReceiptId) {
        throw completionError(
          'EXTENSION_COMPLETION_RECEIPT_MISMATCH',
          'Extension completion receipt changed while its durable effect was resolving'
        );
      }
      const receipt = resolvingGate.receipt;
      completionGate = null;
      if (decision === 'rejected') {
        poisonedError = conflictError({
          eventType: 'extension-completion-rejected',
          participantId: receipt.participantId,
          operation: receipt.operation,
          code: normalizedCode
        });
        rejectQueued(poisonedError);
        rejectCompletionWaiters(poisonedError);
        throw poisonedError;
      }
      queueMicrotask(pump);
      return Object.freeze({
        ok: true,
        receiptId: receipt.receiptId,
        decision,
        code: normalizedCode
      });
    })());
  }

  async function handleBridge(source, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'invalid-message' };
    }
    if (payload.kind === 'validate') {
      const participantId = safeIdentifier(payload.participantId, '', PARTICIPANT_PATTERN);
      const requestId = safeIdentifier(payload.requestId, '', PARTICIPANT_PATTERN);
      const leaseId = String(payload.leaseId || '').slice(0, 80);
      return {
        ok: Boolean(
          !poisonedError && participantId && requestId && leaseId &&
          holder?.owner === 'extension' && holder.participantId === participantId &&
          holder.requestId === requestId && holder.leaseId === leaseId &&
          holder.extensionGrantState === 'active'
        )
      };
    }
    if (payload.kind === 'request') {
      if (!acceptingExtensions) return { ok: false, reason: 'task-finishing' };
      const participantId = safeIdentifier(payload.participantId, '', PARTICIPANT_PATTERN);
      const requestId = safeIdentifier(payload.requestId, '', PARTICIPANT_PATTERN);
      const operation = strictIdentifier(payload.operation, OPERATION_PATTERN);
      if (!participantId || !requestId || !operation) {
        if (activeHandoff()) {
          poisonHandoff('extension-completion-request-invalid', {
            participantId,
            requestId
          });
        }
        return { ok: false, reason: 'invalid-request' };
      }
      const key = requestKey(participantId, requestId);
      const existing = requestRecords.get(key);
      if (existing) {
        duplicateRequests += 1;
        return {
          ok: false,
          reason: existing.state === 'settled' ? 'request-settled' : 'request-duplicate'
        };
      }
      if (requestRecords.size >= boundedMaxRequestRecords) {
        requestCapacityRejects += 1;
        return { ok: false, reason: 'request-capacity' };
      }
      const durationMs = boundedInteger(payload.durationMs, boundedExtensionLeaseMs, 250, 10_000);
      const record = { state: 'pending', promise: null, response: null };
      requestRecords.set(key, record);
      const operationPromise = (async () => {
        const lease = await acquire({
          owner: 'extension',
          participantId,
          requestId,
          operation,
          waitMs: boundedExtensionWaitMs,
          durationMs,
          requestKey: key,
          sourcePage: source?.page || page,
          sourceFrame: source?.frame || page.mainFrame?.() || null,
          requiresExtensionBoundary: Boolean(acquireExtensionBoundary)
        });
        if (onExtensionEffect && holder?.leaseId === lease.leaseId && holder.handoffRole === 'extension') {
          try {
            const effectSequence = await raceLifecycle(onExtensionEffect({
              state: 'started',
              operation: 'custom'
            }));
            if (!Number.isSafeInteger(effectSequence) || effectSequence < 1) {
              throw new TypeError('Extension effect recorder did not return a durable sequence');
            }
            if (!holder || holder.leaseId !== lease.leaseId) {
              throw conflictError({ eventType: 'extension-effect-holder-lost' });
            }
            holder.extensionEffectSequence = effectSequence;
            const waiter = activeHandoff();
            if (closed || signal?.aborted || poisonedError ||
              !waiter || waiter.phase !== 'extension-active' ||
              waiter.extensionLeaseId !== lease.leaseId || !matchesHandoff(waiter, holder)) {
              const invalidGrantError = closed || signal?.aborted
                ? abortError()
                : poisonedError || conflictError({ eventType: 'extension-grant-state-lost' });
              release(lease.leaseId, 'grant-invalidated');
              throw invalidGrantError;
            }
            holder.extensionGrantState = 'active';
            holder.armLeaseTimer?.(holder);
          } catch (error) {
            if (holder?.leaseId === lease.leaseId) {
              if (!closed && !signal?.aborted && !poisonedError) {
                poisonedError = error instanceof BrowserActionConflictError
                  ? error
                  : conflictError({ eventType: 'extension-effect-journal-failed' });
              }
              release(lease.leaseId, 'effect-journal-failed');
              if (poisonedError) {
                rejectQueued(poisonedError);
                rejectCompletionWaiters(poisonedError);
              }
            }
            throw error;
          }
        }
        if (closed || signal?.aborted || poisonedError || !holder ||
          holder.leaseId !== lease.leaseId || holder.extensionGrantState !== 'active') {
          if (holder?.leaseId === lease.leaseId) release(lease.leaseId, 'grant-invalidated');
          if (closed || signal?.aborted) throw abortError();
          if (poisonedError) throw poisonedError;
          throw conflictError({ eventType: 'extension-grant-not-active' });
        }
        return { ok: true, leaseId: lease.leaseId, expiresAt: holder.expiresAt || lease.expiresAt };
      })();
      record.promise = trackOperation(operationPromise.catch((error) => {
        record.state = 'settled';
        return { ok: false, reason: error?.code === 'TASK_CANCELLED' ? 'cancelled' : 'unavailable' };
      }));
      return record.promise;
    }
    if (payload.kind === 'release') {
      const participantId = safeIdentifier(payload.participantId, '', PARTICIPANT_PATTERN);
      const leaseId = String(payload.leaseId || '').slice(0, 80);
      const releasingHolder = holder;
      const released = Boolean(participantId && releasingHolder?.owner === 'extension' &&
        releasingHolder.participantId === participantId && releasingHolder.leaseId === leaseId &&
        completeExtensionHolder(releasingHolder, {
          outcome: normalizeCompletionOutcome(payload.outcome),
          source: 'release',
          reason: 'released'
        }));
      return { ok: released };
    }
    return { ok: false, reason: 'unsupported-message' };
  }

  await context.exposeBinding(bindingName, handleBridge);
  await context.addInitScript(installPageBridge, bridgeConfig);
  for (const candidate of context.pages?.() || [page]) {
    const frames = typeof candidate.frames === 'function' ? candidate.frames() : [];
    if (frames.length) {
      for (const frame of frames) {
        await frame.evaluate(installPageBridge, bridgeConfig).catch(() => {});
      }
    } else {
      await candidate.evaluate(installPageBridge, bridgeConfig).catch(() => {});
    }
  }

  const pageLifecycleHandlers = new Map();
  const abortPersistingGrant = (candidateHolder, reason) => {
    if (candidateHolder?.owner !== 'extension' ||
      candidateHolder.handoffRole !== 'extension' ||
      candidateHolder.extensionGrantState === 'active') {
      return false;
    }
    poisonHandoff('extension-grant-lifecycle-race', {
      participantId: candidateHolder.participantId,
      requestId: candidateHolder.requestId,
      operation: candidateHolder.operation,
      reason
    });
    release(candidateHolder.leaseId, 'grant-lifecycle-race');
    return true;
  };
  const watchPage = (candidate) => {
    if (!candidate || pageLifecycleHandlers.has(candidate)) return;
    const releaseForSourceFrame = (frame, reason) => {
      if (holder?.owner !== 'extension') return;
      if (holder.sourcePage && holder.sourcePage !== candidate) return;
      const mainFrameNavigated = reason === 'navigation' &&
        typeof candidate.mainFrame === 'function' && frame === candidate.mainFrame();
      if (!mainFrameNavigated && holder.sourceFrame && holder.sourceFrame !== frame) return;
      const releasingHolder = holder;
      navigationReleases += 1;
      if (abortPersistingGrant(releasingHolder, reason)) return;
      completeExtensionHolder(releasingHolder, {
        outcome: normalizeCompletionOutcome({ status: 'unknown', code: reason, facts: [] }),
        source: reason,
        reason
      });
    };
    const navigated = (frame) => releaseForSourceFrame(frame, 'navigation');
    const detached = (frame) => releaseForSourceFrame(frame, 'frame-detached');
    const closedPage = () => {
      if (holder?.owner !== 'extension') return;
      if (holder.sourcePage && holder.sourcePage !== candidate) return;
      const releasingHolder = holder;
      navigationReleases += 1;
      if (abortPersistingGrant(releasingHolder, 'page-closed')) return;
      completeExtensionHolder(releasingHolder, {
        outcome: normalizeCompletionOutcome({ status: 'unknown', code: 'page-closed', facts: [] }),
        source: 'page-closed',
        reason: 'page-closed'
      });
    };
    const handlers = { navigated, detached, closedPage };
    pageLifecycleHandlers.set(candidate, handlers);
    candidate.on?.('framenavigated', navigated);
    candidate.on?.('framedetached', detached);
    candidate.on?.('close', closedPage);
  };
  for (const candidate of context.pages?.() || [page]) watchPage(candidate);
  context.on?.('page', watchPage);

  async function run(operation, callback) {
    if (typeof callback !== 'function') throw new TypeError('coordinated browser action callback is required');
    const normalizedOperation = safeIdentifier(operation, 'browser-action', OPERATION_PATTERN);
    const lease = await acquire({
      owner: 'task',
      participantId: 'task-master',
      requestId: randomUUID(),
      operation: normalizedOperation,
      waitMs: null
    });
    let callbackSucceeded = false;
    try {
      const result = await callback();
      callbackSucceeded = true;
      return result;
    } finally {
      if (!callbackSucceeded && holder?.leaseId === lease.leaseId && holder.handoffRole === 'trigger') {
        poisonHandoff('extension-completion-task-trigger-failed', {
          operation: normalizedOperation
        });
        release(lease.leaseId, 'trigger-failed');
      } else {
        release(lease.leaseId);
      }
    }
  }

  function seal() {
    if (!acceptingExtensions) return;
    acceptingExtensions = false;
    cancelBoundaryAcquisitions(completionError(
      'EXTENSION_COMPLETION_AFTER_COMPLETION',
      'Extension action requests cannot enter the task after completion begins'
    ));
  }

  async function beforeCompletion() {
    seal();
    if (completionGate) {
      throw completionError(
        'EXTENSION_COMPLETION_GATE_PENDING',
        'Task completion is blocked by an unresolved extension completion receipt'
      );
    }
    if (completionWaiters.length) {
      throw completionError(
        'EXTENSION_COMPLETION_EXPECTATION_PENDING',
        'Task completion is blocked by an unresolved extension completion expectation'
      );
    }
    await run('completion-barrier', async () => {});
  }

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      acceptingExtensions = false;
      context.off?.('page', watchPage);
      for (const [candidate, handlers] of pageLifecycleHandlers) {
        candidate.off?.('framenavigated', handlers.navigated);
        candidate.off?.('framedetached', handlers.detached);
        candidate.off?.('close', handlers.closedPage);
      }
      pageLifecycleHandlers.clear();
      const error = signal?.aborted ? abortError() : Object.assign(
        new Error('Extension action coordinator closed'),
        { code: 'TASK_CANCELLED' }
      );
      lifecycleController.abort(error);
      cancelBoundaryAcquisitions(error);
      rejectCompletionWaiters(error);
      completionGate = null;
      rejectQueued(error);
      if (holder) release(holder.leaseId, 'closed');
      // A well-behaved pause boundary observes its abort immediately. Give an
      // already-resolving callback one bounded turn to register its release,
      // without letting a broken callback deadlock task cleanup forever.
      await waitForBoundaryAcquisitionGrace();
      for (;;) {
        const operations = [...inFlightOperations];
        if (operations.length) await Promise.allSettled(operations);
        const boundaryTail = extensionBoundaryTail;
        await boundaryTail;
        if (inFlightOperations.size === 0 && extensionBoundaryTail === boundaryTail) break;
      }
    })();
    return closePromise;
  }

  signal?.addEventListener('abort', () => {
    void close().catch(() => {});
  }, { once: true });

  return Object.freeze({
    enabled: true,
    protocol: EXTENSION_ACTION_PROTOCOL.version,
    run,
    expectCompletion,
    resolveCompletion,
    checkpointContext,
    checkpointCompleted,
    pause,
    resume,
    seal,
    beforeCompletion,
    beforeEffectSuccess: async () => {},
    assertCurrentClean: () => {},
    audit: () => Object.freeze({
      enabled: true,
      protocol: EXTENSION_ACTION_PROTOCOL.version,
      identityBoundary: 'cooperative-not-authenticated',
      active: holder ? 1 : 0,
      pending: queue.length,
      taskLeases,
      extensionLeases,
      conflicts,
      leaseTimeouts,
      duplicateRequests,
      requestCapacityRejects,
      navigationReleases,
      completionExpectations: completionWaiters.length,
      completionGate: completionGate ? 1 : 0,
      completionCheckpointed: completionGate?.checkpoint ? 1 : 0,
      completionEffectPending: Number.isSafeInteger(completionGate?.effectSequence) ? 1 : 0,
      completionReceipts,
      boundaryAcquisitions: pendingBoundaryAcquisitions.size,
      maximumActive,
      healthy: !poisonedError,
      serialized: maximumActive <= 1
    }),
    close
  });
}
