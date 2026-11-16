import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createFastSession } from '../src/runtime/fast-session.mjs';
import { createFastBrowser } from '../src/runtime/fast-browser.mjs';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const proof = { target: { selector: '#proof' }, text: 'ready' };
async function fixture(t, hooks = {}) {
  const records = [], calls = [], state = { pageId: 'page-unit', pageVersion: '0:approved-document:0', url: 'http://fixture.test/approved', title: 'fixture' };
  const authorization = { version: 1, scope: 'profile', accountId: 'profile:unit', resourceIds: ['*'], origins: ['http://fixture.test'], allowedActions: ['*'], expiresAt: null };
  const page = {}, browser = hooks.browserAdapter || { page, unsafe: null,
    meta: async () => ({ ...state }), observe: async () => ({ ...state, items: [], total: 0 }),
    condition: async condition => hooks.condition ? hooks.condition(condition) : true,
    read: async target => hooks.read ? hooks.read(target) : 'read value',
    validateAction: async () => {},
    act: async (action, timeoutMs, expectedScene) => { calls.push({ action, timeoutMs, expectedScene, dispatchedAt: performance.now() }); await hooks.act?.(action); },
    invalidate() {}, dispose: async () => {} };
  let sequence = 0;
  const session = createFastSession({ page: browser.page || page, context: hooks.context, browserAdapter: browser,
    input: { operationId: 'op-unit', authorization, browserSelection: { kind: 'profile', profileId: 'unit' } }, signal: new AbortController().signal,
    durable: async (type, payload) => { records.push({ type, payload }); await hooks.durable?.(type, payload, state);
      return type === 'authorize' ? { authorization, mode: 'operations' } : { acknowledged: true }; }
  });
  t.after(() => session.dispose());
  const command = (kind, payload) => ({ schemaVersion: 1, commandId: `boundary-${++sequence}`, operationId: 'op-unit', authorizationVersion: 1, kind, payload });
  await session.execute(command('observe', {}));
  const batch = (actions, extra = {}) => session.execute(command('batch', { actions, preconditions: [], stopConditions: [], verify: [], timeoutMs: 40, ...extra }));
  return { session, records, calls, state, command, batch };
}
const click = (actionId = 'effect', extra = {}) => ({ actionId, type: 'click', target: { role: 'button', name: 'Save' }, ...extra });

test('a final explicit wait cannot confirm a 40 ms group after a 150 ms late-ready read', async t => {
  let checks = 0;
  const h = await fixture(t, { condition: async () => { checks++; await sleep(150); return true; } });
  const result = await h.batch([{ actionId: 'wait-last', type: 'wait', value: { condition: proof, timeoutMs: 3000, pollMs: 25 } }]);
  assert.equal(result.status, 'stopped'); assert.equal(result.reason, 'CONDITION_TIMEOUT');
  assert.equal(checks, 1); assert.equal(h.calls.length, 0); assert.equal(h.session.unresolved, false);
});

for (const phase of ['prepared', 'initiated']) test(`a 150 ms ${phase} ACK cannot dispatch an expired 40 ms group`, async t => {
  const h = await fixture(t, { durable: async (type, payload) => { if (type === 'action' && payload.status === phase) await sleep(150); } });
  const result = await h.batch([click()]);
  assert.equal(h.calls.length, 0);
  if (phase === 'prepared') {
    assert.equal(result.status, 'stopped'); assert.equal(result.reason, 'CONDITION_TIMEOUT');
    assert.equal(h.records.some(record => record.type === 'action' && record.payload.status === 'initiated'), false);
    assert.equal(h.session.unresolved, false);
  } else {
    assert.equal(result.status, 'unknown'); assert.equal(result.result.details.cause, 'CONDITION_TIMEOUT');
    assert.equal(h.records.some(record => record.type === 'action' && record.payload.status === 'initiated'), true);
    assert.equal(h.records.some(record => record.type === 'action' && record.payload.status === 'unknown'), true);
    assert.equal(h.session.unresolved, true);
    const retry = await h.batch([click('must-not-replay')]);
    assert.equal(retry.reason, 'RECONCILE_REQUIRED'); assert.equal(h.calls.length, 0);
  }
});

test('normal in-budget action succeeds with exact pre-ACK scene and one absolute monotonic deadline', async t => {
  const h = await fixture(t, { durable: async (type, payload, state) => { if (type === 'action' && payload.status === 'prepared') state.pageVersion = '0:approved-document:2'; } });
  const result = await h.batch([click('timely', { expected: proof })], { timeoutMs: 100 });
  assert.equal(result.status, 'confirmed'); assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].expectedScene.pageId, 'page-unit');
  assert.equal(h.calls[0].expectedScene.pageVersion, '0:approved-document:0', 'the ACK must not overwrite the originally checked document binding');
  assert.ok(Number.isFinite(h.calls[0].expectedScene.deadlineAt));
  assert.ok(h.calls[0].expectedScene.deadlineAt > h.calls[0].dispatchedAt);
  assert.ok(Number.isSafeInteger(h.calls[0].timeoutMs) && h.calls[0].timeoutMs > 0 && h.calls[0].timeoutMs <= 100);
  assert.equal(result.result.verification.businessResultVerified, true);
  assert.deepEqual(h.records.filter(record => record.type === 'action').map(record => record.payload.status), ['prepared', 'initiated', 'confirmed']);
});

for (const type of ['read', 'locate']) test(`last ${type} cannot confirm after its group deadline`, async t => {
  const h = await fixture(t, { read: async () => { await sleep(150); return 'late value'; } });
  const result = await h.batch([{ actionId: `late-${type}`, type, target: { selector: '#read' } }]);
  assert.equal(result.status, 'stopped'); assert.equal(result.reason, 'CONDITION_TIMEOUT');
  assert.equal(h.calls.length, 0); assert.equal(h.session.unresolved, false);
});

for (const mode of ['action-expected', 'group-verify']) test(`late true ${mode} is unknown after an initiated effect and never authorizes replay`, async t => {
  const h = await fixture(t, { condition: async () => { await sleep(150); return true; } });
  const result = await h.batch([click('sent-once', mode === 'action-expected' ? { expected: proof } : {})], mode === 'group-verify' ? { verify: [proof] } : {});
  assert.equal(result.status, 'unknown'); assert.equal(result.result.details.cause, 'CONDITION_TIMEOUT');
  assert.equal(h.calls.length, 1); assert.equal(h.session.unresolved, true);
  assert.equal(h.records.some(record => record.type === 'action' && record.payload.status === 'confirmed'), false);
  assert.equal(h.records.some(record => record.type === 'action' && record.payload.status === 'unknown'), true);
  const retry = await h.batch([click('new-id-must-not-replay')]);
  assert.equal(retry.reason, 'RECONCILE_REQUIRED'); assert.equal(h.calls.length, 1);
});

test('required confirmation ACK may finish late without rolling a timely verified persisted effect back to unknown', async t => {
  const h = await fixture(t, { durable: async (type, payload) => { if (type === 'action' && payload.status === 'confirmed') await sleep(150); } });
  const result = await h.batch([click('verified-before-deadline', { expected: proof })]);
  assert.equal(result.status, 'confirmed'); assert.equal(result.result.verification.businessResultVerified, true);
  assert.equal(h.calls.length, 1); assert.equal(h.session.unresolved, false);
  assert.deepEqual(h.records.filter(record => record.type === 'action').map(record => record.payload.status), ['prepared', 'initiated', 'confirmed']);
});

test('actual browser preparation cannot dispatch after the absolute group deadline', async t => {
  let visibleReads = 0, nativeClicks = 0;
  const target = { count: async () => 1, isVisible: async () => { if (++visibleReads === 2) await sleep(150); return true; },
    isEnabled: async () => true, click: async () => { nativeClicks++; } };
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, mainFrame: () => 'main', url: () => 'http://fixture.test/approved',
    getByRole: () => target, evaluate: async (_fn, args) => ({ epoch: 'approved-document', revision: 0, url: 'http://fixture.test/approved', title: 'fixture', items: [], total: 0, offset: 0 }) });
  const context = { pages: () => [page] }, browser = createFastBrowser({ page, context });
  const h = await fixture(t, { browserAdapter: browser, context });
  const result = await h.batch([click('native-deadline')]);
  assert.equal(visibleReads, 2); assert.equal(nativeClicks, 0);
  assert.equal(result.status, 'unknown'); assert.equal(result.result.details.cause, 'CONDITION_TIMEOUT');
  assert.equal(h.session.unresolved, true);
});
