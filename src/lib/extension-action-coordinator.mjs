import { randomUUID } from 'node:crypto';

export const EXTENSION_ACTION_PROTOCOL = Object.freeze({
  version: 'taskmaster-cooperative-v2',
  requestEvent: 'eric-task-master:extension-action-request-v2',
  grantEvent: 'eric-task-master:extension-action-grant-v2',
  releaseEvent: 'eric-task-master:extension-action-release-v2'
});

const PARTICIPANT_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const OPERATION_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
const MAX_QUEUE_DEPTH = 32;
const DEFAULT_MAX_REQUEST_RECORDS = 8_192;

function boundedInteger(value, fallback, minimum, maximum) {
  const normalized = Number(value ?? fallback);
  if (!Number.isSafeInteger(normalized)) return fallback;
  return Math.max(minimum, Math.min(maximum, normalized));
}

function safeIdentifier(value, fallback, pattern) {
  const normalized = String(value || '').slice(0, 80);
  return pattern.test(normalized) ? normalized : fallback;
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
      leaseId
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
    healthy: true,
    maximumActive: 0,
    serialized: true
  });
}

function disabledCoordinator() {
  return Object.freeze({
    enabled: false,
    protocol: EXTENSION_ACTION_PROTOCOL.version,
    run: async (_operation, callback) => callback(),
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
  taskWaitMs = 15_000,
  extensionWaitMs = 5_000,
  extensionLeaseMs = 4_000,
  maxRequestRecords = DEFAULT_MAX_REQUEST_RECORDS
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
  const boundedTaskWaitMs = boundedInteger(taskWaitMs, 15_000, 500, 60_000);
  const boundedExtensionWaitMs = boundedInteger(extensionWaitMs, 5_000, 250, 15_000);
  const boundedExtensionLeaseMs = boundedInteger(extensionLeaseMs, 4_000, 250, 10_000);
  const boundedMaxRequestRecords = boundedInteger(maxRequestRecords, DEFAULT_MAX_REQUEST_RECORDS, 32, 65_536);
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
  let holder = null;
  let closed = false;
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

  const abortError = () => {
    if (signal?.reason instanceof Error) return signal.reason;
    const error = new Error('Task execution was aborted');
    error.code = 'TASK_CANCELLED';
    return error;
  };

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

  function rejectQueued(error) {
    while (queue.length) {
      const item = queue.shift();
      clearTimeout(item.waitTimer);
      settleRequestRecord(item);
      item.reject(error);
    }
  }

  function release(leaseId, reason = 'released') {
    if (!holder || holder.leaseId !== leaseId) return false;
    clearTimeout(holder.leaseTimer);
    settleRequestRecord(holder);
    holder = null;
    queueMicrotask(pump);
    return reason;
  }

  function pump() {
    if (closed || holder || queue.length === 0) return;
    const item = queue.shift();
    clearTimeout(item.waitTimer);
    if (signal?.aborted) {
      settleRequestRecord(item);
      item.reject(abortError());
      queueMicrotask(pump);
      return;
    }
    const leaseId = randomUUID();
    const startedAt = Date.now();
    const durationMs = item.owner === 'extension' ? item.durationMs : null;
    holder = {
      ...item,
      leaseId,
      startedAt,
      leaseTimer: durationMs === null ? null : setTimeout(() => {
        leaseTimeouts += 1;
        poisonedError = conflictError({
          eventType: 'extension-lease-expired',
          participantId: item.participantId,
          operation: item.operation
        });
        release(leaseId, 'expired');
        rejectQueued(poisonedError);
      }, durationMs)
    };
    maximumActive = Math.max(maximumActive, 1);
    if (item.owner === 'task') taskLeases += 1;
    else extensionLeases += 1;
    const lease = Object.freeze({
      owner: item.owner,
      leaseId,
      startedAt,
      ...(durationMs === null ? {} : { expiresAt: new Date(startedAt + durationMs).toISOString() })
    });
    if (item.requestKey) {
      const record = requestRecords.get(item.requestKey);
      if (record) {
        record.state = 'active';
        record.response = { ok: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt };
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
    sourceFrame = null
  }) {
    if (closed) return Promise.reject(Object.assign(new Error('Extension action coordinator is closed'), { code: 'TASK_CANCELLED' }));
    if (signal?.aborted) return Promise.reject(abortError());
    if (poisonedError) return Promise.reject(poisonedError);
    if (queue.length >= MAX_QUEUE_DEPTH) {
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
        resolve,
        reject,
        waitTimer: null
      };
      item.waitTimer = setTimeout(() => {
        const index = queue.indexOf(item);
        if (index >= 0) queue.splice(index, 1);
        leaseTimeouts += 1;
        settleRequestRecord(item);
        reject(conflictError({ eventType: 'coordination-wait-timeout', owner, operation }));
      }, waitMs);
      queue.push(item);
      pump();
    });
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
          holder.requestId === requestId && holder.leaseId === leaseId
        )
      };
    }
    if (payload.kind === 'request') {
      if (!acceptingExtensions) return { ok: false, reason: 'task-finishing' };
      const participantId = safeIdentifier(payload.participantId, '', PARTICIPANT_PATTERN);
      const requestId = safeIdentifier(payload.requestId, '', PARTICIPANT_PATTERN);
      const operation = safeIdentifier(payload.operation, 'extension-action', OPERATION_PATTERN);
      if (!participantId || !requestId) return { ok: false, reason: 'invalid-request' };
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
      record.promise = acquire({
        owner: 'extension',
        participantId,
        requestId,
        operation,
        waitMs: boundedExtensionWaitMs,
        durationMs,
        requestKey: key,
        sourcePage: source?.page || page,
        sourceFrame: source?.frame || page.mainFrame?.() || null
      }).then((lease) => ({ ok: true, leaseId: lease.leaseId, expiresAt: lease.expiresAt })).catch((error) => {
        record.state = 'settled';
        return { ok: false, reason: error?.code === 'TASK_CANCELLED' ? 'cancelled' : 'unavailable' };
      });
      requestRecords.set(key, record);
      return record.promise;
    }
    if (payload.kind === 'release') {
      const participantId = safeIdentifier(payload.participantId, '', PARTICIPANT_PATTERN);
      const leaseId = String(payload.leaseId || '').slice(0, 80);
      const released = Boolean(
        participantId && holder?.owner === 'extension' &&
        holder.participantId === participantId && holder.leaseId === leaseId &&
        release(leaseId)
      );
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
  const watchPage = (candidate) => {
    if (!candidate || pageLifecycleHandlers.has(candidate)) return;
    const releaseForSourceFrame = (frame, reason) => {
      if (holder?.owner !== 'extension') return;
      if (holder.sourcePage && holder.sourcePage !== candidate) return;
      const mainFrameNavigated = reason === 'navigation' &&
        typeof candidate.mainFrame === 'function' && frame === candidate.mainFrame();
      if (!mainFrameNavigated && holder.sourceFrame && holder.sourceFrame !== frame) return;
      navigationReleases += 1;
      release(holder.leaseId, reason);
    };
    const navigated = (frame) => releaseForSourceFrame(frame, 'navigation');
    const detached = (frame) => releaseForSourceFrame(frame, 'frame-detached');
    const closedPage = () => {
      if (holder?.owner !== 'extension') return;
      if (holder.sourcePage && holder.sourcePage !== candidate) return;
      navigationReleases += 1;
      release(holder.leaseId, 'page-closed');
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
      waitMs: boundedTaskWaitMs
    });
    try {
      return await callback();
    } finally {
      release(lease.leaseId);
    }
  }

  function seal() {
    acceptingExtensions = false;
  }

  async function beforeCompletion() {
    seal();
    await run('completion-barrier', async () => {});
  }

  async function close() {
    if (closed) return;
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
    rejectQueued(error);
    if (holder) release(holder.leaseId, 'closed');
  }

  signal?.addEventListener('abort', close, { once: true });

  return Object.freeze({
    enabled: true,
    protocol: EXTENSION_ACTION_PROTOCOL.version,
    run,
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
      maximumActive,
      healthy: !poisonedError,
      serialized: maximumActive <= 1
    }),
    close
  });
}
