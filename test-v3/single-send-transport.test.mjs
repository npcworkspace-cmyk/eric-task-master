import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleSendTransport, jsonTransport, validateTransport } from '../src/runtime/single-send-transport.mjs';

const url = 'http://localhost:5555/api/config';
async function setup(authorize = async () => {}) {
  let handler; const events = [], calls = [];
  const frame = { page: () => page }; const page = { mainFrame: () => frame, evaluate: async () => false };
  const controller = new AbortController();
  const context = { once() {}, serviceWorkers: () => [], route: async (_, fn) => { handler = fn; } };
  const transport = await createSingleSendTransport({ context, signal: controller.signal, authorizeForward: authorize, onBlocked: async (value) => events.push(value) });
  const guard = jsonTransport(url, { value: 'approved' });
  const arm = (value = {}) => transport.arm({ page, url: 'http://localhost:5555/site', actionId: 'save', commandId: 'batch', guard, ...value });
  const request = (overrides = {}) => ({ method: () => 'POST', url: () => url, resourceType: () => 'fetch', frame: () => frame,
    postDataBuffer: () => Buffer.from(JSON.stringify({ value: 'approved' })), allHeaders: async () => ({ 'content-type': 'application/json' }), ...overrides });
  const route = (overrides = {}) => ({ request: () => request(overrides), abort: async () => calls.push('abort'), continue: async () => calls.push('continue'),
    fetch: async (options) => { calls.push(options); return { status: () => 200, dispose: async () => {} }; }, fulfill: async () => calls.push('fulfill') });
  return { transport, guard, arm, request, route, send: (value) => handler(value), calls, events, controller };
}

test('strict exact HTTP JSON guard rejects credentials, cross origin, methods and unbounded bodies', () => {
  assert.throws(() => validateTransport({ ...jsonTransport(url, {}), url: 'http://user:pass@localhost:5555/api' }));
  assert.throws(() => validateTransport(jsonTransport(url, {}), { pageUrl: 'http://other.test' }));
  for (const value of [{ method: 'PUT' }, { maxBodyBytes: 65537 }, { bodySha256: 'bad' }]) assert.throws(() => validateTransport({ ...jsonTransport(url, {}), ...value }));
});

test('first request consumes budget before asynchronous authorization; duplicate and late retries fail closed', async () => {
  let release; const waiting = new Promise((resolve) => { release = resolve; });
  const s = await setup(() => waiting); await s.arm();
  const first = s.send(s.route()); await s.send(s.route()); release(); await first;
  await assert.rejects(s.transport.finish('save'), { code: 'TRANSPORT_DUPLICATE_BLOCKED' });
  assert.equal(s.calls.filter((value) => value?.maxRetries === 0).length, 1);
  await s.send(s.route()); assert.equal(s.calls.at(-1), 'abort');
  await assert.rejects(s.arm({ actionId: 'new-save' }), { code: 'TRANSPORT_BODY_ALREADY_CONSUMED' });
  assert.equal(s.calls.filter((value) => value === 'continue').length, 0); await s.transport.dispose();
});

test('wrong body/url/frame/auth/secret JSON/redirect never falls back', async () => {
  for (const kind of ['body', 'url', 'iframe', 'newtab', 'auth', 'secret', 'redirect']) {
    const s = await setup(); let guard = s.guard; let overrides = {};
    if (kind === 'body') overrides.postDataBuffer = () => Buffer.from('{}');
    if (kind === 'url') overrides.url = () => `${url}?wrong=1`;
    if (['iframe', 'newtab'].includes(kind)) overrides.frame = () => ({ page: () => ({}) });
    if (kind === 'auth') overrides.allHeaders = async () => ({ 'content-type': 'application/json', authorization: 'not-persisted' });
    if (kind === 'secret') { guard = jsonTransport(url, { password: 'not-persisted' }); overrides.postDataBuffer = () => Buffer.from(JSON.stringify({ password: 'not-persisted' })); }
    await s.arm({ guard }); const route = s.route(overrides);
    if (kind === 'redirect') route.fetch = async () => { s.calls.push('fetch'); return { status: () => 302, dispose: async () => {} }; };
    await s.send(route); await assert.rejects(s.transport.finish('save'));
    assert.ok(!s.calls.includes('continue')); assert.ok(!s.calls.includes('fulfill'));
    if (kind !== 'redirect') assert.ok(!s.calls.some((value) => value?.maxRetries === 0));
    assert.ok(!JSON.stringify(s.events).includes('not-persisted')); await s.transport.dispose();
  }
});

test('stop/takeover/revocation during async authorization cannot forward', async () => {
  for (const kind of ['stop', 'takeover', 'revocation']) {
    let entered, release; const pending = new Promise((resolve) => { release = resolve; }); const started = new Promise((resolve) => { entered = resolve; });
    const s = await setup(async () => { entered(); await pending; if (kind === 'revocation') throw new Error('revoked'); });
    await s.arm(); const sending = s.send(s.route()); await started;
    if (kind === 'stop') s.controller.abort(); else if (kind === 'takeover') s.transport.pause(true);
    release(); await sending; await assert.rejects(s.transport.finish('save'));
    assert.equal(s.calls.filter((value) => value?.maxRetries === 0).length, 0); await s.transport.dispose();
  }
});

test('dispose retains context write deny handler; successful forwarding uses exactly one bounded fetch', async () => {
  const s = await setup(); await s.arm(); await s.send(s.route()); const result = await s.transport.finish('save');
  assert.equal(result.forwarded, true); const fetch = s.calls.find((value) => value?.maxRetries === 0);
  assert.equal(fetch.maxRedirects, 0); assert.equal(fetch.timeout, 10000); assert.ok(fetch.signal instanceof AbortSignal);
  await s.transport.dispose(); await s.send(s.route()); assert.equal(s.calls.at(-1), 'abort');
});
