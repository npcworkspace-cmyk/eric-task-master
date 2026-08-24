import { randomUUID } from 'node:crypto';

const DEFAULT_WAIT_MS = 10 * 60_000;
const MAX_WAIT_MS = 60 * 60_000;

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
  let pending = null;

  function failPending(error) {
    if (!pending) return false;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    signal?.removeEventListener('abort', current.onAbort);
    current.reject(error);
    return true;
  }

  async function request(input = {}) {
    if (pending) {
      throw new UserHandoffError('USER_HANDOFF_ALREADY_PENDING', 'Only one user handoff may be pending per task');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new UserHandoffError('INVALID_USER_HANDOFF', 'User handoff request must be an object');
    }
    const unknown = Object.keys(input).filter((key) => !['reason', 'instructions', 'timeoutMs'].includes(key));
    if (unknown.length) {
      throw new UserHandoffError('INVALID_USER_HANDOFF', `Unsupported handoff fields: ${unknown.join(', ')}`);
    }
    const reason = boundedText(input.reason, 'reason', 500, { required: true });
    const instructions = boundedText(input.instructions, 'instructions', 2_000);
    const timeoutMs = input.timeoutMs === undefined ? DEFAULT_WAIT_MS : Number(input.timeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_WAIT_MS) {
      throw new UserHandoffError('INVALID_USER_HANDOFF', 'timeoutMs must be an integer from 1000 to 3600000');
    }
    if (signal?.aborted) throw signal.reason || new UserHandoffError('TASK_CANCELLED', 'Task was cancelled');

    const requestId = `handoff_${randomUUID().replaceAll('-', '')}`;
    const requestedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
    const screenshot = await capture('waiting-user');
    const requestRecord = {
      id: requestId,
      reason,
      ...(instructions ? { instructions } : {}),
      requestedAt,
      expiresAt,
      ...(screenshot ? { screenshotAvailable: true } : {})
    };
    let resolveWait;
    let rejectWait;
    const waitPromise = new Promise((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    // The request must already be continuable before it becomes externally
    // visible. Otherwise a very fast Agent continuation can arrive in the
    // small gap between publishing waiting_user and installing this waiter.
    const onAbort = () => failPending(
      signal.reason || new UserHandoffError('TASK_CANCELLED', 'Task was cancelled')
    );
    const timer = setTimeout(() => failPending(new UserHandoffError(
      'TASK_USER_HANDOFF_TIMEOUT',
      'Task did not receive a new instruction before the handoff deadline'
    )), timeoutMs);
    timer.unref?.();
    pending = { requestRecord, resolve: resolveWait, reject: rejectWait, timer, onAbort };
    signal?.addEventListener('abort', onAbort, { once: true });
    waitPromise.catch(() => {});

    try {
      if (signal?.aborted) throw signal.reason || new UserHandoffError('TASK_CANCELLED', 'Task was cancelled');
      // Publish the complete request before the generic state event. The
      // Manager handles this message atomically as state + request metadata,
      // so readers can never observe waiting_user without a request ID.
      await onRequest(requestRecord);
      if (!pending) return waitPromise;
      await onState('waiting_user');
      if (!pending) return waitPromise;
      await onProgress(`Waiting for a new instruction: ${reason}`);
      if (signal?.aborted) throw signal.reason || new UserHandoffError('TASK_CANCELLED', 'Task was cancelled');
    } catch (error) {
      failPending(error instanceof Error ? error : new Error('User handoff could not be reported'));
    }
    return waitPromise;
  }

  async function continueRequest({ requestId, note = '' } = {}) {
    if (!pending || requestId !== pending.requestRecord.id) return false;
    const normalizedNote = boundedText(note, 'note', 2_000);
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    signal?.removeEventListener('abort', current.onAbort);
    await onState('recovering');
    await onProgress('New instruction received; verifying live page state');
    current.resolve(Object.freeze({
      requestId,
      ...(normalizedNote ? { note: normalizedNote } : {}),
      continuedAt: new Date().toISOString()
    }));
    await onState('running');
    return true;
  }

  function cancel(error = new UserHandoffError('TASK_CANCELLED', 'Task was cancelled')) {
    return failPending(error);
  }

  return Object.freeze({
    request,
    continue: continueRequest,
    cancel,
    get pending() {
      return pending ? structuredClone(pending.requestRecord) : null;
    }
  });
}
