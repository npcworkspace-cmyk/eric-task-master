import { AsyncLocalStorage } from 'node:async_hooks';

export class ActionArbiterAbortError extends Error {
  constructor() {
    super('Browser action was cancelled before it entered the interaction boundary');
    this.name = 'ActionArbiterAbortError';
    this.code = 'TASK_CANCELLED';
  }
}

/**
 * One FIFO interaction boundary for a task Worker. The lock is intentionally
 * wider than a single Playwright primitive: Journey callers hold it through
 * transition verification and settling so another action cannot change the
 * page between an effect and its proof.
 */
export function createActionArbiter({ signal } = {}) {
  const executionScope = new AsyncLocalStorage();
  const scopeToken = Object.freeze({});
  let tail = Promise.resolve();
  let issued = 0;
  let started = 0;
  let completed = 0;
  let failed = 0;
  let pending = 0;
  let active = 0;
  let maximumActive = 0;
  let maximumQueueDepth = 0;
  let accepting = true;

  const abortError = () => (
    signal?.reason instanceof Error ? signal.reason : new ActionArbiterAbortError()
  );

  function assertCanAdmit() {
    if (executionScope.getStore() === scopeToken) {
      const error = new Error('A browser action cannot start another browser action inside the same active FIFO slot');
      error.code = 'TASK_ACTION_REENTRANT';
      throw error;
    }
    if (signal?.aborted) throw abortError();
    if (!accepting) {
      const error = new Error('Browser action was issued after the task entered completion');
      error.code = 'TASK_ACTION_AFTER_COMPLETION';
      throw error;
    }
  }

  function reserve(operation) {
    assertCanAdmit();
    const name = String(operation || 'browser-action').slice(0, 80);
    const ticket = ++issued;
    const prior = tail.catch(() => {});
    let release;
    tail = new Promise((resolve) => { release = resolve; });
    pending += 1;
    maximumQueueDepth = Math.max(maximumQueueDepth, pending);
    let state = 'reserved';

    const settlePending = async () => {
      await prior;
      pending -= 1;
    };
    const execute = async (callback) => {
      if (typeof callback !== 'function') throw new TypeError('action arbiter callback is required');
      if (state !== 'reserved') {
        const error = new Error('Browser action reservation was already consumed');
        error.code = 'TASK_ACTION_RESERVATION_CONSUMED';
        throw error;
      }
      state = 'executing';
      await settlePending();
      if (signal?.aborted) {
        state = 'settled';
        release();
        throw abortError();
      }

      active += 1;
      started += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        const result = await executionScope.run(scopeToken, () => callback({ ticket, operation: name }));
        completed += 1;
        return result;
      } catch (error) {
        failed += 1;
        throw error;
      } finally {
        active -= 1;
        state = 'settled';
        release();
      }
    };
    const cancel = async () => {
      if (state !== 'reserved') return false;
      state = 'cancelling';
      await settlePending();
      state = 'settled';
      release();
      return true;
    };
    return Object.freeze({ ticket, operation: name, execute, cancel });
  }

  async function run(operation, callback) {
    if (typeof callback !== 'function') throw new TypeError('action arbiter callback is required');
    return reserve(operation).execute(callback);
  }

  function audit() {
    return Object.freeze({
      issued,
      started,
      completed,
      failed,
      pending,
      active,
      maximumActive,
      maximumQueueDepth,
      accepting,
      serialized: maximumActive <= 1
    });
  }

  function seal() {
    accepting = false;
  }

  async function beforeCompletion({ timeoutMs = 30_000 } = {}) {
    seal();
    if (signal?.aborted) throw abortError();
    const boundedTimeoutMs = Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000
      ? timeoutMs
      : 30_000;
    let timer;
    let abortListener;
    try {
      await Promise.race([
        tail,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Browser action queue did not settle before task completion');
            error.code = 'TASK_ACTION_QUEUE_UNSETTLED';
            reject(error);
          }, boundedTimeoutMs);
          if (signal) {
            abortListener = () => reject(abortError());
            signal.addEventListener('abort', abortListener, { once: true });
          }
        })
      ]);
    } finally {
      clearTimeout(timer);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
    }
    if (pending !== 0 || active !== 0) {
      const error = new Error('Browser action queue did not settle before task completion');
      error.code = 'TASK_ACTION_QUEUE_UNSETTLED';
      throw error;
    }
  }

  return Object.freeze({ run, reserve, assertCanAdmit, audit, seal, beforeCompletion });
}
