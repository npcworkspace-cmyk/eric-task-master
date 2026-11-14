import { createHash } from 'node:crypto';
import { isSensitiveKey } from '../lib/redaction.mjs';

const error = (code, message) => Object.assign(new Error(message), { code });
export const SINGLE_SEND_MAX_BYTES = 65536;
export const bodySha256 = (body) => createHash('sha256').update(body).digest('hex');

export function validateTransport(value, { pageUrl, origins } = {}) {
  let url;
  try { url = new URL(value?.url); } catch { throw error('INVALID_TRANSPORT_GUARD', 'Transport requires an exact HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.href !== value.url ||
      [...url.searchParams.keys()].some((key) => isSensitiveKey(key)) || value.method !== 'POST' ||
      !/^[a-f0-9]{64}$/u.test(value.bodySha256 || '') || !Number.isSafeInteger(value.maxBodyBytes) || value.maxBodyBytes < 2 || value.maxBodyBytes > SINGLE_SEND_MAX_BYTES) throw error('INVALID_TRANSPORT_GUARD', 'Only bounded known JSON POST guards without URL credentials are supported');
  if (pageUrl && new URL(pageUrl).origin !== url.origin || origins && !origins.includes(url.origin)) throw error('TRANSPORT_ORIGIN_MISMATCH', 'Transport must use the same currently authorized page origin');
  return { url: value.url, method: 'POST', bodySha256: value.bodySha256, maxBodyBytes: value.maxBodyBytes };
}

export function jsonTransport(url, body, maxBodyBytes = SINGLE_SEND_MAX_BYTES) {
  const bytes = Buffer.from(JSON.stringify(body));
  return validateTransport({ url, method: 'POST', bodySha256: bodySha256(bytes), maxBodyBytes });
}

function sensitiveJson(value, depth = 0) {
  if (depth > 12) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => isSensitiveKey(key) || /^(?:otp|passcode|verification.?code|one.?time.?code)$/iu.test(key) || sensitiveJson(child, depth + 1));
}

// One explicitly opted-in, owned BrowserContext only. It is not a system proxy.
// Read requests retain Chromium transport; all unbound/non-JSON writes fail closed.
export async function createSingleSendTransport({ context, signal, authorizeForward, onBlocked = async () => {} }) {
  let active = null, paused = false, stopped = false;
  const inFlight = new Set();
  const consumed = new Set();
  const key = (guard) => `${guard.method}:${guard.url}:${guard.bodySha256}`;
  const blocked = async (route, code, binding = active) => {
    if (binding) binding.violation ||= code;
    await route.abort('failed').catch(() => {});
    await onBlocked({ type: 'transport.blocked', priority: 'high', dedupeKey: `transport:${binding?.actionId || 'unbound'}:${code}`, summary: code,
      payload: { actionId: binding?.actionId || null, commandId: binding?.commandId || null, code } }).catch(() => {});
  };
  const check = (binding) => {
    if (stopped || paused || signal?.aborted || binding !== active || binding.controller.signal.aborted) throw error('TRANSPORT_STOPPED', 'Transport authorization is no longer active');
  };
  const handle = async (route) => {
    const request = route.request();
    if (['GET', 'HEAD'].includes(request.method())) return route.continue().catch(() => {});
    const binding = active;
    if (!binding || stopped || paused || signal?.aborted) return blocked(route, 'TRANSPORT_UNBOUND_WRITE', binding);
    // Synchronously consume the local forward budget before the first await.
    if (binding.remaining === 0) return blocked(route, 'TRANSPORT_DUPLICATE_BLOCKED', binding);
    binding.remaining = 0;
    consumed.add(key(binding.guard));
    let task;
    task = (async () => {
      let response;
      try {
        check(binding);
        let frame; try { frame = request.frame(); } catch { throw error('TRANSPORT_UNBOUND_FRAME', 'Request has no bound main frame'); }
        if (frame.page() !== binding.page || frame !== binding.page.mainFrame()) throw error('TRANSPORT_UNBOUND_FRAME', 'New-tab and iframe writes are outside this action');
        if (request.method() !== 'POST' || request.url() !== binding.guard.url || !['fetch', 'xhr'].includes(request.resourceType())) throw error('TRANSPORT_REQUEST_MISMATCH', 'Write does not match the explicitly approved JSON endpoint');
        const bytes = request.postDataBuffer();
        if (!Buffer.isBuffer(bytes) || bytes.length > binding.guard.maxBodyBytes || bodySha256(bytes) !== binding.guard.bodySha256) throw error('TRANSPORT_BODY_MISMATCH', 'Write body does not match the approved bounded digest');
        const text = bytes.toString('utf8'); let json;
        try { json = JSON.parse(text); } catch { throw error('TRANSPORT_UNSUPPORTED_BODY', 'Only complete small JSON bodies are supported'); }
        if (!Buffer.from(text).equals(bytes) || !json || typeof json !== 'object' || Array.isArray(json) || sensitiveJson(json)) throw error('TRANSPORT_UNSUPPORTED_BODY', 'Authentication, secret-bearing or streaming bodies are unsupported');
        const headers = await request.allHeaders();
        check(binding);
        if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers['content-type'] || '') || headers.authorization || headers['proxy-authorization']) throw error('TRANSPORT_UNSUPPORTED_AUTH_OR_BODY', 'Only known JSON requests without HTTP authorization headers are supported');
        await authorizeForward(binding, { url: request.url(), method: 'POST', bodySha256: bodySha256(bytes), bodyBytes: bytes.length });
        // A takeover/revoke/stop during any async check must prevent forwarding.
        check(binding);
        binding.forwardStarted = true;
        response = await route.fetch({ maxRetries: 0, maxRedirects: 0, timeout: 10000, signal: binding.controller.signal });
        check(binding);
        if (response.status() >= 300 && response.status() < 400) throw error('TRANSPORT_REDIRECT_UNSUPPORTED', 'Write redirects require separate authorization');
        await route.fulfill({ response });
        binding.result = { forwarded: true, status: response.status(), bodySha256: binding.guard.bodySha256 };
      } catch (cause) {
        // Playwright error call logs may contain headers/body. Never persist them.
        const code = typeof cause.code === 'string' && cause.code.startsWith('TRANSPORT_') ? cause.code : 'TRANSPORT_RESULT_UNKNOWN';
        binding.result = { forwarded: binding.forwardStarted, code };
        await blocked(route, code, binding);
      } finally {
        await response?.dispose().catch(() => {});
        binding.resolve(); inFlight.delete(task);
      }
    })();
    inFlight.add(task);
    return task;
  };
  const stop = () => { stopped = true; active?.controller.abort(); };
  signal?.addEventListener('abort', stop, { once: true });
  const closed = () => { stop(); signal?.removeEventListener('abort', stop); };
  context.once('close', closed);
  await context.route('**/*', handle);
  return {
    async arm(binding) {
      if (stopped || paused || signal?.aborted || active) throw error('TRANSPORT_STOPPED', 'Transport is paused, stopped or already bound');
      if (context.serviceWorkers().length || await binding.page.evaluate(async () => Boolean(navigator.serviceWorker?.controller) || Boolean((await navigator.serviceWorker?.getRegistrations?.())?.length))) throw error('TRANSPORT_SERVICE_WORKER_UNSUPPORTED', 'Service-worker contexts cannot use this bounded transport');
      if (stopped || paused || signal?.aborted) throw error('TRANSPORT_STOPPED', 'Transport stopped while checking compatibility');
      const guard = validateTransport(binding.guard, { pageUrl: binding.url });
      if (consumed.has(key(guard))) throw error('TRANSPORT_BODY_ALREADY_CONSUMED', 'This URL/method/body digest was already consumed in this context; a late retry cannot borrow a new action budget');
      const value = { ...binding, guard, remaining: 1, forwardStarted: false, violation: null, controller: new AbortController(), result: null };
      value.done = new Promise((resolve) => { value.resolve = resolve; });
      active = value;
    },
    async finish(actionId, timeoutMs = 5000) {
      const binding = active;
      if (!binding || binding.actionId !== actionId) throw error('TRANSPORT_BINDING_LOST', 'Transport action binding was lost');
      let timer, abort;
      try {
        await Promise.race([binding.done, new Promise((_, reject) => {
          timer = setTimeout(() => reject(error('TRANSPORT_REQUEST_TIMEOUT', 'Expected JSON request was not positively completed')), timeoutMs);
          abort = () => reject(error('TRANSPORT_STOPPED', 'Transport stopped before completion'));
          binding.controller.signal.addEventListener('abort', abort, { once: true });
          if (binding.controller.signal.aborted) abort();
        })]);
        if (binding.violation || !binding.result || binding.result.code) throw error(binding.violation || binding.result?.code || 'TRANSPORT_RESULT_UNKNOWN', 'Single-send result needs current-resource verification');
        return binding.result;
      } finally {
        clearTimeout(timer); binding.controller.signal.removeEventListener('abort', abort); binding.controller.abort(); if (active === binding) active = null;
      }
    },
    pause(value = true) { paused = value; if (paused) active?.controller.abort(); },
    disarm(actionId) { if (active?.actionId === actionId) { active.controller.abort(); active = null; } },
    async dispose() {
      stop(); await Promise.allSettled([...inFlight]);
      // Keep the deny-write handler installed until the owned context closes.
      // Removing it now could release a late page retry to native Chromium.
    }
  };
}
