import { randomUUID } from 'node:crypto';

const DEFAULT_WAIT_MS = 10 * 60_000;
const MAX_WAIT_MS = 60 * 60_000;
const HANDOFF_KINDS = new Set(['instruction', 'human_verification']);

function handoffError(code, message) {
  return new UserHandoffError(code, message);
}

function observedRejection(error) {
  const rejection = Promise.reject(error);
  rejection.catch(() => {});
  return rejection;
}

export class UserHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UserHandoffError';
    this.code = code;
  }
}

function boundedText(value, field, maximum, { required = false } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || (required && !value.trim()) || value.length > maximum) {
    throw new UserHandoffError(
      'INVALID_USER_HANDOFF',
      `${field} must contain ${required ? '1' : '0'} to ${maximum} characters`
    );
  }
  return value.trim();
}

export function createUserHandoff({
  signal,
  capture = async () => null,
  onRequest = async () => {},
  onState = async () => {},
  onProgress = async () => {}
} = {}) {
  let accepting = true;
  let preparing = null;
  let pending = null;
  let continuing = null;
  const inFlightSteps = new Set();

  const cancellationError = () => (
    signal?.reason instanceof Error
      ? signal.reason
      : handoffError('TASK_CANCELLED', 'Task was cancelled')
  );
  const completionError = () => handoffError(
    'TASK_USER_HANDOFF_AFTER_COMPLETION',
    'User handoff was issued after the task entered completion'
  );

  function createAdmission() {
    let rejectStop;
    const stopPromise = new Promise((_, reject) => { rejectStop = reject; });
    stopPromise.catch(() => {});
    const admission = {
      stopError: null,
      stopPromise,
      stop(error) {
        if (admission.stopError) return;
        admission.stopError = error;
        rejectStop(error);
      }
    };
    return admission;
  }

  function assertLive(admission) {
    if (admission.stopError) throw admission.stopError;
    if (signal?.aborted) {
      const error = cancellationError();
      admission.stop(error);
      throw error;
    }
    if (!accepting) {
      const error = completionError();
      admission.stop(error);
      throw error;
    }
  }

  async function awaitStep(admission, callback) {
    assertLive(admission);
    const operation = Promise.resolve().then(() => {
      assertLive(admission);
      return callback();
    });
    inFlightSteps.add(operation);
    operation.then(
      () => inFlightSteps.delete(operation),
      () => inFlightSteps.delete(operation)
    );
    operation.catch(() => {});
    const result = await Promise.race([operation, admission.stopPromise]);
    assertLive(admission);
    return result;
  }

  async function drain({ timeoutMs = 20_000 } = {}) {
    // Stopping an admission rejects its public request promptly, but an
    // already-started diagnostic/publication callback cannot be cancelled by a
    // Promise race. Join those callbacks before the Worker tears down its
    // output tree or returns terminal state.
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) {
      throw new TypeError('handoff drain timeoutMs must be an integer from 10 to 60000');
    }
    const settled = (async () => {
      for (;;) {
        const operations = [...inFlightSteps];
        if (!operations.length) return;
        await Promise.allSettled(operations);
      }
    })();
    settled.catch(() => {});
    let timer;
    try {
      await Promise.race([
        settled,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = handoffError(
              'TASK_USER_HANDOFF_DRAIN_UNSETTLED',
              'User handoff callbacks did not settle before task cleanup'
            );
            reject(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function failPending(error) {
    if (!pending) return false;
    const current = pending;
    pending = null;
    if (current.timer !== null) clearTimeout(current.timer);
    signal?.removeEventListener('abort', current.onAbort);
    current.reject(error);
    return true;
  }

  function request(input = {}) {
    if (!accepting) return observedRejection(completionError());
    if (preparing || pending || continuing) {
      return observedRejection(handoffError(
        'USER_HANDOFF_ALREADY_PENDING',
        'Only one user handoff may be active per task'
      ));
    }

    let normalized;
    try {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw handoffError('INVALID_USER_HANDOFF', 'User handoff request must be an object');
      }
      const unknown = Object.keys(input).filter((key) => !['kind', 'reason', 'instructions', 'timeoutMs'].includes(key));
      if (unknown.length) {
        throw handoffError('INVALID_USER_HANDOFF', `Unsupported handoff fields: ${unknown.join(', ')}`);
      }
      const reason = boundedText(input.reason, 'reason', 500, { required: true });
      const instructions = boundedText(input.instructions, 'instructions', 2_000);
      const kind = input.kind === undefined ? 'instruction' : input.kind;
      if (typeof kind !== 'string' || !HANDOFF_KINDS.has(kind)) {
        throw handoffError('INVALID_USER_HANDOFF', 'kind must be instruction or human_verification');
      }
      const timeoutMs = input.timeoutMs === undefined ? DEFAULT_WAIT_MS : Number(input.timeoutMs);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_WAIT_MS) {
        throw handoffError('INVALID_USER_HANDOFF', 'timeoutMs must be an integer from 1000 to 3600000');
      }
      if (signal?.aborted) throw cancellationError();
      normalized = { reason, instructions, kind, timeoutMs };
    } catch (error) {
      return observedRejection(error);
    }

    // Admission is synchronous: completion sealing in the same turn sees this
    // request even while capture or publication has not started yet.
    const admission = createAdmission();
    preparing = admission;
    const onAbort = () => {
      const error = cancellationError();
      admission.stop(error);
      failPending(error);
      if (continuing?.admission === admission) continuing.current.reject(error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const operation = (async () => {
      try {
        const { reason, instructions, kind, timeoutMs } = normalized;
        const requestId = `handoff_${randomUUID().replaceAll('-', '')}`;
        const requestedAt = new Date().toISOString();
        const expiresAt = kind === 'human_verification' ? null : new Date(Date.now() + timeoutMs).toISOString();
        const diagnostics = await awaitStep(admission, () => capture('waiting-user'));
        const screenshotAvailable = typeof diagnostics === 'string'
          ? Boolean(diagnostics)
          : diagnostics === true || Boolean(diagnostics?.screenshotPath);
        const requestRecord = {
          id: requestId,
          kind,
          reason,
          ...(instructions ? { instructions } : {}),
          requestedAt,
          ...(expiresAt ? { expiresAt } : {}),
          ...(screenshotAvailable ? { screenshotAvailable: true } : {})
        };
        let resolveWait;
        let rejectWait;
        const waitPromise = new Promise((resolve, reject) => {
          resolveWait = resolve;
          rejectWait = reject;
        });
        waitPromise.catch(() => {});
        const timer = kind === 'human_verification'
          ? null
          : setTimeout(() => failPending(handoffError(
              'TASK_USER_HANDOFF_TIMEOUT',
              'Task did not receive a new instruction before the handoff deadline'
            )), timeoutMs);
        timer?.unref?.();
        const pendingRecord = {
          admission,
          requestRecord,
          resolve: resolveWait,
          reject: rejectWait,
          timer,
          onAbort
        };
        pending = pendingRecord;
        preparing = null;

        // The waiter is installed before this request becomes externally
        // visible, so an immediate continuation cannot be lost.
        await awaitStep(admission, () => onRequest(requestRecord, diagnostics));
        if (pending === pendingRecord) {
          await awaitStep(admission, () => onState('waiting_user'));
        }
        if (pending === pendingRecord) {
          await awaitStep(admission, () => onProgress(`Waiting for a new instruction: ${reason}`));
        }
        return await Promise.race([waitPromise, admission.stopPromise]);
      } catch (error) {
        if (pending?.admission === admission) {
          failPending(error instanceof Error ? error : new Error('User handoff could not be reported'));
        }
        throw error;
      } finally {
        if (preparing === admission) preparing = null;
        signal?.removeEventListener('abort', onAbort);
      }
    })();
    operation.catch(() => {});
    return operation;
  }

  function continueRequest({ requestId, note = '' } = {}) {
    if (!pending || requestId !== pending.requestRecord.id) return Promise.resolve(false);
    let normalizedNote;
    try {
      normalizedNote = boundedText(note, 'note', 2_000);
    } catch (error) {
      return observedRejection(error);
    }
    const current = pending;
    pending = null;
    if (current.timer !== null) clearTimeout(current.timer);
    const receipt = Object.freeze({
      requestId,
      ...(normalizedNote ? { note: normalizedNote } : {}),
      continuedAt: new Date().toISOString()
    });
    const continuation = { admission: current.admission, current };
    continuing = continuation;
    const operation = (async () => {
      try {
        // Continuation reporting is part of the operation, never detached.
        // Resolve the live task only after Manager-visible state is coherent.
        await awaitStep(current.admission, () => onState('recovering'));
        await awaitStep(current.admission, () => onProgress('New instruction received; verifying live page state'));
        await awaitStep(current.admission, () => onState('running'));
        current.resolve(receipt);
        return true;
      } catch (error) {
        current.reject(error);
        throw error;
      } finally {
        if (continuing === continuation) continuing = null;
      }
    })();
    operation.catch(() => {});
    return operation;
  }

  function cancel(error = new UserHandoffError('TASK_CANCELLED', 'Task was cancelled')) {
    const wasActive = Boolean(preparing || pending || continuing);
    preparing?.stop(error);
    if (pending) {
      pending.admission.stop(error);
      failPending(error);
    }
    if (continuing) {
      continuing.admission.stop(error);
      continuing.current.reject(error);
    }
    return wasActive;
  }

  function seal() {
    const wasActive = Boolean(preparing || pending || continuing);
    accepting = false;
    const error = completionError();
    preparing?.stop(error);
    if (pending) {
      pending.admission.stop(error);
      failPending(error);
    }
    if (continuing) {
      continuing.admission.stop(error);
      continuing.current.reject(error);
    }
    return wasActive;
  }

  return Object.freeze({
    request,
    continue: continueRequest,
    cancel,
    seal,
    drain,
    get active() {
      return Boolean(preparing || pending || continuing);
    },
    get preparing() {
      return Boolean(preparing);
    },
    get pending() {
      return pending ? structuredClone(pending.requestRecord) : null;
    }
  });
}
