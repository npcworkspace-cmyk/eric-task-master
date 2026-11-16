import assert from 'node:assert/strict';
import test from 'node:test';
import { createFastSession, runFastSession, validateFastCommand } from '../src/runtime/fast-session.mjs';

function harness(options = {}) {
  const records = [];
  const effects = [];
  const page = {};
  const state = { pageId: 'page-1', pageVersion: 'v1', url: 'http://fixture.test/social', title: 'fixture' };
  let onControl;
  const authorization = { version: 1, accountId: 'acct-1', resourceIds: ['res-1'], origins: ['http://fixture.test'], allowedActions: ['click', 'fill', 'navigate'], expiresAt: new Date(Date.now() + 60000).toISOString() };
  const browser = {
    page, unsafe: null,
    meta: async () => ({ ...state }),
    observe: async () => ({ ...state, items: [], total: 0 }),
    condition: async (condition) => condition.text !== 'fail',
    identity: async () => ({ accountId: 'acct-1', resourceId: 'res-1' }),
    act: async (action) => { effects.push(action.actionId); state.pageVersion = `v${effects.length + 1}`; await options.act?.(action); },
    read: async () => 'fixture text', invalidate: () => { state.pageVersion += '-invalidate'; },
    clearUnsafe: () => { browser.unsafe = null; }, dispose: async () => {},
    ...options.browser
  };
  const runtime = {
    page, browserAdapter: browser,
    input: { operationId: 'op-1', authorization, identity: { account: { selector: '#account' } } },
    signal: new AbortController().signal,
    durable: async (type, payload) => {
      records.push({ type, payload });
      if (type === 'authorize') { options.authorize?.(payload); return { authorization: options.authorization || authorization, mode: 'operations' }; }
      return options.durable?.(type, payload) || { acknowledged: true };
    },
    onControl(fn) { onControl = fn; return () => {}; }
  };
  const session = createFastSession(runtime);
  const command = (kind, payload, extra = {}) => ({ schemaVersion: 1, commandId: `cmd-${records.length}-${kind}`, operationId: 'op-1', authorizationVersion: 1, ...state, kind, payload, ...extra });
  const batch = (extra = {}) => command('batch', { preconditions: [{ target: { selector: '#proof' }, text: 'pass' }], stopConditions: [], actions: [{ actionId: 'a1', type: 'click', target: { selector: '#save' } }], verify: [{ target: { selector: '#proof' }, text: 'pass' }], ...extra });
  return { session, records, effects, browser, state, runtime, command, batch, control: (value) => onControl(value) };
}

test('versioned commands reject oversized groups and missing safety conditions', () => {
  assert.throws(() => validateFastCommand({ schemaVersion: 1, commandId: 'c', kind: 'batch', payload: { actions: [] } }), { code: 'INVALID_COMMAND' });
});

test('every declared condition is validated before any batch action can run', async (t) => {
  const h = harness(); t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {}));
  const malformed = { target: { selector: '#checkbox' }, cheked: true };
  const cases = [
    { preconditions: [malformed] }, { stopConditions: [malformed] }, { verify: [malformed] },
    ...['preconditions', 'guard', 'expected'].map(field => ({ actions: [
      { actionId: 'first', type: 'click', target: { selector: '#save' } },
      { actionId: 'later', type: 'click', target: { selector: '#save' }, [field]: field === 'preconditions' ? [malformed] : malformed }
    ] })),
    { actions: [{ actionId: 'first', type: 'click', target: { selector: '#save' } }, { actionId: 'wait', type: 'wait', value: { condition: malformed } }] }
  ];
  for (const payload of cases) await assert.rejects(h.session.execute(h.batch(payload)), { code: 'INVALID_CONDITION' });
  assert.equal(h.effects.length, 0);
  assert.equal(h.records.some(record => record.type === 'action'), false);
});

for (const type of ['read', 'locate', 'wait']) {
  test(`${type} does not skip its declared expected condition`, async (t) => {
    const h = harness(); t.after(() => h.session.dispose());
    await h.session.execute(h.command('observe', {}));
    const action = { actionId: `checked-${type}`, type, target: { selector: '#proof' },
      ...(type === 'wait' ? { value: { condition: { target: { selector: '#ready' }, text: 'pass' } } } : {}),
      expected: { target: { selector: '#proof' }, text: 'fail' } };
    const result = await h.session.execute(h.batch({ actions: [action], verify: [], timeoutMs: 35 }));
    assert.equal(result.status, 'stopped'); assert.equal(result.reason, 'CONDITION_TIMEOUT');
    assert.equal(h.effects.length, 0);
    assert.equal(h.session.unresolved, false);
  });
}

test('actual action expected readback is recorded without inventing unchecked group proof', async (t) => {
  const h = harness(); t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {}));
  const reply = await h.session.execute(h.batch({ verify: [], actions: [
    { actionId: 'verified-save', type: 'click', target: { selector: '#save' }, expected: { target: { selector: '#proof' }, text: 'pass' } }
  ] }));
  assert.equal(reply.status, 'confirmed'); assert.equal(reply.result.actions[0].expectedMatched, true);
  assert.equal(reply.result.verification.actionExpectedMatched, 1);
  assert.equal(reply.result.verification.businessResultVerified, true);
  assert.equal(reply.result.verification.groupMatched, undefined);
  const saved = h.records.filter(record => record.type === 'action' && record.payload.status === 'confirmed').at(-1).payload;
  assert.equal(saved.verification.expectedMatched, true); assert.equal(saved.verification.method, 'readback');
});

test('one checked effect does not claim readback verification for another unchecked effect', async (t) => {
  const h = harness(); t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {}));
  const reply = await h.session.execute(h.batch({ verify: [], actions: [
    { actionId: 'checked', type: 'click', target: { selector: '#save' }, expected: { target: { selector: '#proof' }, text: 'pass' } },
    { actionId: 'unchecked', type: 'click', target: { selector: '#other' } }
  ] }));
  assert.equal(reply.status, 'confirmed'); assert.equal(reply.result.verification.matched, true);
  assert.equal(reply.result.verification.businessResultVerified, false);
  const saved = h.records.filter(record => record.type === 'action' && record.payload.status === 'confirmed').map(record => record.payload);
  assert.equal(saved[0].verification.businessResultVerified, true);
  assert.equal(saved[1].verification.businessResultVerified, false);
});

test('persistent commands reuse one browser and durable initiated ACK precedes the effect', async () => {
  const h = harness({ act: async () => { assert.equal(h.records.filter((r) => r.type === 'action').at(-1).payload.status, 'initiated'); } });
  await h.session.execute(h.command('observe', {}));
  const reply = await h.session.execute(h.batch());
  assert.equal(reply.status, 'confirmed');
  assert.deepEqual(h.effects, ['a1']);
  assert.deepEqual(h.records.filter((r) => r.type === 'action').map((r) => r.payload.status), ['prepared', 'initiated', 'confirmed']);
  assert.equal(reply.result.actions[0].status, 'confirmed');
  assert.equal((await h.session.execute(h.command('observe', {}))).pageId, 'page-1');
  await h.session.dispose();
});

test('no observation, stale references and changed authorization cannot mutate', async () => {
  const h = harness();
  assert.equal((await h.session.execute(h.batch())).reason, 'OBSERVATION_REQUIRED');
  await h.session.execute(h.command('observe', {}));
  assert.equal((await h.session.execute({ ...h.batch(), pageVersion: 'old' })).reason, 'STALE_OBSERVATION');
  await h.session.execute(h.command('observe', {}));
  h.runtime.input.authorization.version = 2;
  assert.equal((await h.session.execute(h.batch())).reason, 'AUTHORIZATION_CHANGED');
  assert.equal(h.effects.length, 0);
  await h.session.dispose();
});

test('failed final verification becomes unknown and blocks retry until reconciliation', async () => {
  const h = harness();
  await h.session.execute(h.command('observe', {}));
  assert.equal((await h.session.execute(h.batch({ verify: [{ target: { selector: '#proof' }, text: 'fail' }] }))).status, 'unknown');
  await h.session.execute(h.command('observe', {}));
  assert.equal((await h.session.execute(h.batch())).reason, 'RECONCILE_REQUIRED');
  assert.equal(h.effects.length, 1);
  assert.equal((await h.session.execute(h.command('reconcile', { actionIds: ['a1'], verify: [{ target: { selector: '#proof' }, text: 'pass' }] }))).status, 'confirmed');
  assert.equal((await h.session.execute(h.batch())).reason, 'ACTION_ALREADY_ATTEMPTED');
  await h.session.dispose();
});

test('lost completion ACK does not auto-repeat the write', async () => {
  const h = harness({ durable: (type, payload) => { if (type === 'action' && payload.status === 'confirmed') throw new Error('lost ACK'); } });
  await h.session.execute(h.command('observe', {}));
  assert.equal((await h.session.execute(h.batch())).status, 'unknown');
  assert.equal(h.effects.length, 1);
  await h.session.dispose();
});

test('second-step precondition failure preserves the first initiated action as unknown', async () => {
  let checks = 0;
  const h = harness({ browser: { condition: async () => ++checks < 2 } });
  await h.session.execute(h.command('observe', {}));
  const result = await h.session.execute(h.batch({ actions: [{ actionId: 'a1', type: 'click', target: {} }, { actionId: 'a2', type: 'click', target: {}, preconditions: [{ target: { selector: '#proof' }, text: 'pass' }] }] }));
  assert.equal(result.status, 'unknown');
  assert.deepEqual(h.effects, ['a1']);
  assert.equal(h.records.filter((r) => r.type === 'action').at(-1).payload.status, 'unknown');
  await h.session.dispose();
});

test('manual takeover stops remaining steps and resume requires a fresh observation', async () => {
  const h = harness({ act: async () => h.control({ action: 'takeover', mode: 'manual' }) });
  await h.session.execute(h.command('observe', {}));
  assert.equal((await h.session.execute(h.batch())).status, 'unknown');
  assert.equal(h.session.mode, 'operations');
  assert.equal(h.session.automationPaused, true);
  h.control({ action: 'resume', mode: 'operations' });
  assert.equal(h.session.unresolved, true);
  assert.equal(h.effects.length, 1);
  await h.session.dispose();
});

test('one page cannot accept concurrent commands', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const h = harness({ browser: { observe: async () => { await blocked; return {}; } } });
  const first = h.session.execute(h.command('observe', {}));
  await assert.rejects(h.session.execute(h.command('observe', {})), { code: 'PAGE_BUSY' });
  release(); await first;
  await h.session.dispose();
});

test('local wait times out and quiet watchers produce no main-Agent event', async () => {
  const h = harness({ browser: { condition: async () => false } });
  assert.equal((await h.session.execute(h.command('wait', { condition: { target: { selector: '#ready' }, state: 'visible' }, timeoutMs: 30, pollMs: 25 }))).reason, 'CONDITION_TIMEOUT');
  const priorEvents = h.records.filter((r) => r.type === 'event').length;
  await h.session.execute(h.command('wait', { watch: true, watchId: 'quiet', condition: { target: { selector: '#ready' }, state: 'visible' }, pollMs: 100 }));
  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(h.records.filter((r) => r.type === 'event').length, priorEvents);
  await h.session.dispose();
});

test('run loop resumes commands on the same runtime without re-launching', async () => {
  const h = harness();
  await h.session.dispose();
  const values = [h.command('observe', {}), h.command('control', { action: 'stop' })];
  h.runtime.wait = async (value) => { assert.equal(value.reason, 'operations-command'); return values.shift(); };
  assert.equal((await runFastSession(h.runtime)).status, 'stopped');
  assert.ok(h.records.some((r) => r.type === 'command-result'));
});

for (const mismatch of ['origin']) {
  test(`protected reads and non-refresh reconciliation refuse ${mismatch} without returning page contents`, async () => {
    let contentReads = 0;
    const h = harness({ browser: { observe: async () => { contentReads += 1; return { text: 'must-not-leak' }; }, identity: async () => ({ accountId: mismatch === 'account' ? 'foreign' : 'acct-1', resourceId: mismatch === 'missing-resource' ? null : mismatch === 'resource' ? 'foreign' : 'res-1' }) } });
    if (mismatch === 'origin') h.state.url = 'http://foreign.test/private';
    for (const kind of ['observe', 'wait', 'screenshot', 'reconcile']) {
      const reply = await h.session.execute(h.command(kind, { health: true, verify: [{ target: { selector: '#proof' }, text: 'pass' }], actionIds: ['a1'] }));
      assert.equal(reply.status, 'stopped');
      assert.equal(reply.url, undefined); assert.equal(reply.title, undefined);
      assert.ok(!JSON.stringify(reply).includes('must-not-leak'));
    }
    assert.equal(contentReads, 0);
    assert.equal(h.records.some((item) => item.type === 'reconciliation'), false);
    await h.session.dispose();
  });
}

for (const mismatch of ['account', 'resource', 'missing-resource']) {
  test(`strict ${mismatch} guards effects and reconciliation but leaves a diagnostic page readable`, async () => {
    const h = harness({ browser: { identity: async () => ({ accountId: mismatch === 'account' ? 'foreign' : 'acct-1', resourceId: mismatch === 'missing-resource' ? null : mismatch === 'resource' ? 'foreign' : 'res-1' }) } });
    const observation = await h.session.execute(h.command('observe', {}));
    assert.equal(observation.status, 'confirmed'); assert.equal(observation.identityStatus.verified, false);
    assert.equal((await h.session.execute(h.command('wait', { health: true }))).status, 'confirmed');
    assert.equal((await h.session.execute(h.command('reconcile', { actionIds: ['a1'], verify: [{ target: { selector: '#proof' }, text: 'pass' }] }))).status, 'stopped');
    assert.equal((await h.session.execute(h.batch())).status, 'stopped');
    assert.equal(h.effects.length, 0); assert.equal(h.records.some((item) => item.type === 'reconciliation'), false);
    await h.session.dispose();
  });
}

test('resource assertion cannot substitute for missing actual page resource evidence', async () => {
  const h = harness();
  assert.equal((await h.session.execute(h.command('observe', {}))).status, 'confirmed');
  h.browser.identity = async () => ({ accountId: 'acct-1', resourceId: null });
  const reply = await h.session.execute(h.batch({ resourceId: 'res-1' }));
  assert.equal(reply.status, 'stopped');
  assert.equal(reply.reason, 'IDENTITY_UNVERIFIED');
  assert.equal(h.effects.length, 0);
  assert.equal(h.records.some((item) => item.type === 'action'), false);
  await h.session.dispose();
});

test('explicit login-expired condition preserves diagnostic reading and still prevents protected effects', async () => {
  let contentReads = 0;
  const h = harness({ browser: { condition: async () => true, observe: async () => { contentReads += 1; return {}; } } });
  h.runtime.input.safetyConditions = { loginExpired: { target: { selector: '#login-expired' }, state: 'visible' } };
  const observation = await h.session.execute(h.command('observe', {}));
  assert.equal(observation.status, 'confirmed'); assert.equal(observation.identityStatus.warning, 'LOGIN_EXPIRED');
  assert.ok(contentReads > 0);
  assert.equal((await h.session.execute(h.batch())).reason, 'LOGIN_EXPIRED');
  assert.equal(h.effects.length, 0);
  assert.ok(h.records.some((item) => item.type === 'event' && item.payload.type === 'login.expired'));
  await h.session.dispose();
});

test('empty initial page returns only bootstrap metadata and can navigate without reading missing ad fields', async () => {
  let reads = 0;
  const h = harness({ act: async (action) => { h.state.url = action.value; }, browser: { read: async () => { reads += 1; throw new Error('missing ad field'); } } });
  h.state.url = 'about:blank'; h.state.title = 'must-not-return';
  h.runtime.input.businessContext = { currency: { selector: '#currency', expected: 'USD' } };
  const observation = await h.session.execute(h.command('observe', {}));
  assert.equal(observation.result.bootstrap, true);
  assert.deepEqual(observation.result.items, []);
  assert.equal(observation.title, '');
  const reply = await h.session.execute(h.batch({ preconditions: [{ url: 'about:blank' }], actions: [{ actionId: 'bootstrap-nav', type: 'navigate', effect: false, value: 'http://fixture.test/ads', expected: { url: 'http://fixture.test/ads' } }], verify: [{ url: 'http://fixture.test/ads' }] }));
  assert.equal(reply.status, 'confirmed');
  assert.equal(reads, 0);
  assert.ok(h.records.some((item) => item.type === 'authorize' && item.payload.origin === 'http://fixture.test'));
  await h.session.dispose();
});

test('reconciliation always emits actual identity and observed URL for Manager provenance checks', async () => {
  const h = harness();
  const reply = await h.session.execute(h.command('reconcile', { actionIds: ['old'], verify: [{ target: { selector: '#proof' }, text: 'pass' }] }));
  assert.equal(reply.status, 'confirmed');
  const result = h.records.find((item) => item.type === 'reconciliation').payload.result;
  assert.deepEqual(result.identity, { accountId: 'acct-1', resourceId: 'res-1' });
  assert.equal(result.url, h.state.url);
  assert.ok(h.records.some((item) => item.type === 'authorize'));
  await h.session.dispose();
});

test('watcher rebinds once after a bounded navigation context failure and checks live read authority', async () => {
  let conditionCalls = 0;
  const h = harness({ browser: { condition: async () => { conditionCalls += 1; if (conditionCalls === 1) throw Object.assign(new Error('Execution context was destroyed during navigation'), { code: 'OBSERVATION_UNAVAILABLE' }); return true; } } });
  const reply = await h.session.execute(h.command('wait', { watch: true, once: true, watchId: 'rebind', condition: { target: { selector: '#ready' }, state: 'visible' }, pollMs: 100 }));
  assert.equal(reply.status, 'confirmed');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(conditionCalls >= 2, 'the injected context failure must really be retried');
  assert.equal(h.records.filter((item) => item.type === 'event' && item.payload.type === 'watch.changed').length, 1);
  assert.equal(h.records.some((item) => item.type === 'event' && item.payload.type === 'watch.failed'), false);
  assert.ok(h.records.some((item) => item.type === 'authorize' && item.payload.backgroundRead));
  await h.session.dispose();
});

test('dialog acknowledgement needs fresh scene and durable ACK, preserves takeover, then requires observation', async () => {
  const h = harness();
  h.browser.unsafe = 'UNEXPECTED_DIALOG';
  h.control({ action: 'takeover' });
  await h.session.execute(h.command('observe', {}));
  const reply = await h.session.execute(h.command('control', { action: 'acknowledge-dialog', reason: 'Reviewed benign isolated interruption; no external effect' }));
  assert.equal(reply.status, 'confirmed');
  assert.equal(h.browser.unsafe, null);
  assert.equal(h.session.automationPaused, true);
  assert.ok(h.records.some((row) => row.type === 'dialog-acknowledgement' && row.payload.resourceId === 'res-1'));
  h.control({ action: 'resume' });
  assert.equal((await h.session.execute(h.batch())).reason, 'OBSERVATION_REQUIRED');
  await h.session.dispose();
});

test('stale dialog acknowledgement cannot clear unsafe or create a false persistence receipt', async () => {
  const h = harness(); h.browser.unsafe = 'UNEXPECTED_DIALOG';
  const reply = await h.session.execute(h.command('control', { action: 'acknowledge-dialog', reason: 'Review' }, { pageVersion: 'old' }));
  assert.equal(reply.reason, 'STALE_OBSERVATION');
  assert.equal(h.browser.unsafe, 'UNEXPECTED_DIALOG');
  assert.equal(h.records.some((row) => row.type === 'dialog-acknowledgement'), false);
  await h.session.dispose();
});

test('unknown external submit cannot be bypassed by acknowledging its dialog', async () => {
  const h = harness({ act: async () => { h.browser.unsafe = 'UNEXPECTED_DIALOG'; }, durable: (type) => { if (type === 'dialog-acknowledgement') throw Object.assign(new Error('Reconcile actual effect first'), { code: 'RECONCILIATION_REQUIRED' }); } });
  await h.session.execute(h.command('observe', {}));
  assert.equal((await h.session.execute(h.batch())).status, 'unknown');
  await h.session.execute(h.command('observe', {}));
  const reply = await h.session.execute(h.command('control', { action: 'acknowledge-dialog', reason: 'Cannot skip a real unknown write' }));
  assert.equal(reply.reason, 'RECONCILIATION_REQUIRED');
  assert.equal(h.session.unresolved, true); assert.equal(h.browser.unsafe, 'UNEXPECTED_DIALOG');
  await h.session.dispose();
});

test('cursor toggles do not release takeover, change mode or invalidate page observations', async () => {
  const h = harness();
  assert.equal(h.session.cursorEnabled, true);
  h.control({ action: 'takeover' }); const version = h.state.pageVersion;
  h.control({ action: 'cursor', visible: false });
  assert.equal(h.session.cursorEnabled, false); assert.equal(h.session.automationPaused, true);
  assert.equal(h.session.mode, 'operations'); assert.equal(h.state.pageVersion, version);
  await h.session.dispose();
});

test('cross-resource non-effect navigation preserves actual source identity and emits actual destination readback', async () => {
  const h = harness({ act: async (action) => { h.state.url = action.value; } });
  h.runtime.input.authorization.resourceIds.push('res-destination');
  h.browser.identity = async () => ({ accountId: 'acct-1', resourceId: h.state.url.endsWith('/site') ? 'res-destination' : 'res-1' });
  h.browser.refresh = async (url) => { h.state.url = url; };
  await h.session.execute(h.command('observe', {}));
  const expected = { url: 'http://fixture.test/site' };
  const navigated = await h.session.execute(h.batch({ actions: [{ actionId: 'cross-resource-navigation', type: 'navigate', effect: false, value: expected.url, expected }], verify: [expected] }));
  assert.equal(navigated.status, 'confirmed');
  const local = h.records.find((row) => row.type === 'command-result' && row.payload.localActions?.length).payload.localActions[0];
  assert.equal(local.resourceId, 'res-1');
  assert.equal(local.after.resourceId, 'res-destination');
  const reconciled = await h.session.execute(h.command('reconcile', { url: expected.url, actionIds: ['cross-resource-navigation'], verify: [expected] }));
  assert.equal(reconciled.status, 'confirmed');
  const payload = h.records.find((row) => row.type === 'reconciliation').payload;
  assert.deepEqual(payload.result.identity, { accountId: 'acct-1', resourceId: 'res-destination' });
  assert.equal(payload.result.url, expected.url); assert.deepEqual(payload.result.verification, [expected]);
  await h.session.dispose();
});
