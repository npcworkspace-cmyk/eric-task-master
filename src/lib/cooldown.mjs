const MIN_COOLDOWN_MS = 1_000;
const MAX_COOLDOWN_MS = 6 * 60 * 60_000;

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
  return async function cooldown(options = {}) {
    let retryAfter = options.retryAfter;
    if (retryAfter === undefined && typeof options.response?.headerValue === 'function') {
      retryAfter = await options.response.headerValue('retry-after');
    }
    const durationMs = resolveCooldownMs({
      retryAfter,
      milliseconds: options.milliseconds,
      fallbackMs: options.fallbackMs,
      attempt: options.attempt,
      nowMs: now(),
      random
    });
    const resumeAt = new Date(now() + durationMs).toISOString();
    const reason = String(options.reason || 'Rate limit cooldown').slice(0, 160);
    onSignal('rate_limit');
    await onState('cooling_down');
    await onProgress({ durationMs, resumeAt, reason });
    await onCooldown({ status: 'active', durationMs, resumeAt, reason });
    try {
      await sleep(durationMs, signal);
    } finally {
      if (!signal?.aborted) {
        await onCooldown({ status: 'completed', durationMs, resumeAt, reason });
        await onState('running');
      }
    }
    return { durationMs, resumeAt };
  };
}
