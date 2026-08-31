const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;

function cooldownError(code, message) {
  return Object.assign(new Error(message), { code });
}

function observedRejection(error) {
  const rejection = Promise.reject(error);
  rejection.catch(() => {});
  return rejection;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    return Math.ceil(Number(normalized) * 1_000);
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - nowMs);
}

export function resolveCooldownMs({
  retryAfter,
  milliseconds,
  fallbackMs = 30_000,
  attempt = 1,
  nowMs = Date.now(),
  random = Math.random
} = {}) {
  const fromHeader = parseRetryAfter(retryAfter, nowMs);
  const explicit = Number.isFinite(milliseconds) ? Number(milliseconds) : null;
  const base = fromHeader ?? explicit ?? Math.min(
    5 * 60_000,
    Math.max(1_000, Number(fallbackMs) || 30_000) * (2 ** clamp(Number(attempt) - 1 || 0, 0, 8))
  );
  const positiveJitter = fromHeader === null ? Math.round(base * clamp(Number(random()) || 0, 0, 1) * 0.1) : 0;
  return clamp(Math.ceil(base + positiveJitter), MIN_COOLDOWN_MS, MAX_COOLDOWN_MS);
}

async function defaultSleep(milliseconds, signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Task was cancelled'), { code: 'TASK_CANCELLED' });
  await new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback) => (value) => {
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      finish(reject)(signal.reason || Object.assign(new Error('Task was cancelled'), { code: 'TASK_CANCELLED' }));
    };
    timer = setTimeout(finish(resolve), milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createCooldownHelper({
  signal,
  sleep = defaultSleep,
  onState = async () => {},
  onProgress = async () => {},
  onSignal = () => {},
  onCooldown = async () => {},
  now = () => Date.now(),
  random = Math.random
} = {}) {
  let accepting = true;
  let preparing = null;
  let active = null;

  const cancellationError = () => (
    signal?.reason instanceof Error
      ? signal.reason
      : cooldownError('TASK_CANCELLED', 'Task was cancelled')
  );
  const completionError = () => cooldownError(
    'TASK_COOLDOWN_AFTER_COMPLETION',
    'Cooldown was issued after the task entered completion'
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
    operation.catch(() => {});
    const result = await Promise.race([operation, admission.stopPromise]);
    assertLive(admission);
    return result;
  }

  function cooldown(options = {}) {
    if (!accepting) return observedRejection(completionError());
    if (preparing || active) {
      return observedRejection(cooldownError(
        'TASK_COOLDOWN_ALREADY_ACTIVE',
        'Only one cooldown may be active per task'
      ));
    }
    if (signal?.aborted) return observedRejection(cancellationError());

    // Admission is synchronous, including the period spent reading Retry-After.
    const admission = createAdmission();
    preparing = admission;
    const onAbort = () => admission.stop(cancellationError());
    signal?.addEventListener('abort', onAbort, { once: true });

    const operation = (async () => {
      let activeRecordPublished = false;
      let lifecycle = null;
      try {
        let retryAfter = options.retryAfter;
        if (retryAfter === undefined && typeof options.response?.headerValue === 'function') {
          retryAfter = await awaitStep(admission, () => options.response.headerValue('retry-after'));
        }
        assertLive(admission);
        const durationMs = resolveCooldownMs({
          retryAfter,
          milliseconds: options.milliseconds,
          fallbackMs: options.fallbackMs,
          attempt: options.attempt,
          nowMs: now(),
          random
        });
        const startedAtMs = now();
        const startedAt = new Date(startedAtMs).toISOString();
        const resumeAt = new Date(startedAtMs + durationMs).toISOString();
        const reason = String(options.reason || 'Rate limit cooldown').slice(0, 160);
        lifecycle = { durationMs, startedAtMs, startedAt, resumeAt, reason };
        preparing = null;
        active = admission;

        assertLive(admission);
        onSignal(String(options.signalKind || 'rate_limit'));
        assertLive(admission);
        await awaitStep(admission, () => onState('cooling_down'));
        await awaitStep(admission, () => onProgress({ durationMs, resumeAt, reason }));
        await awaitStep(admission, () => onCooldown({ status: 'active', durationMs, startedAt, resumeAt, reason }));
        activeRecordPublished = true;
        await awaitStep(admission, () => sleep(durationMs, signal));

        const finishedAtMs = now();
        const finishedAt = new Date(finishedAtMs).toISOString();
        await awaitStep(admission, () => onCooldown({
          status: 'completed',
          durationMs,
          startedAt,
          finishedAt,
          elapsedMs: Math.max(0, finishedAtMs - startedAtMs),
          resumeAt,
          reason
        }));
        await awaitStep(admission, () => onState('running'));
        return { durationMs, resumeAt };
      } catch (error) {
        // Cancellation keeps the durable interrupted record, but completion
        // sealing suppresses every late publication after the result boundary.
        if (
          activeRecordPublished && lifecycle && signal?.aborted && accepting &&
          error?.code !== 'TASK_COOLDOWN_AFTER_COMPLETION'
        ) {
          const finishedAtMs = now();
          await onCooldown({
            status: 'interrupted',
            durationMs: lifecycle.durationMs,
            startedAt: lifecycle.startedAt,
            finishedAt: new Date(finishedAtMs).toISOString(),
            elapsedMs: Math.max(0, finishedAtMs - lifecycle.startedAtMs),
            resumeAt: lifecycle.resumeAt,
            reason: lifecycle.reason
          });
        }
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
        if (preparing === admission) preparing = null;
        if (active === admission) active = null;
      }
    })();
    operation.catch(() => {});
    return operation;
  }

  cooldown.seal = () => {
    const wasActive = Boolean(preparing || active);
    accepting = false;
    const error = completionError();
    preparing?.stop(error);
    active?.stop(error);
    return wasActive;
  };
  Object.defineProperties(cooldown, {
    active: {
      enumerable: true,
      get: () => Boolean(preparing || active)
    },
    preparing: {
      enumerable: true,
      get: () => Boolean(preparing)
    }
  });
  return cooldown;
}
