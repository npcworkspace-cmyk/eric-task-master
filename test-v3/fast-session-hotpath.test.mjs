import assert from 'node:assert/strict';
import test from 'node:test';
import { createFastSession, runFastSession } from '../src/runtime/fast-session.mjs';

function harness({ strict = false, beforeRecord } = {}) {
  const state = { pageId: 'page-1', pageVersion: '1:document-1:1', url: 'http://fixture.test/local', title: 'fixture' };
  const authorization = { ...(strict ? {} : { scope: 'profile' }), version: 1, accountId: 'account', resourceIds: ['*'], origins: ['http://fixture.test'], allowedActions: ['*'], expiresAt: strict ? new Date(Date.now() + 60000).toISOString() : null };
  const records = [], effects = [];
  const browser = { page: {}, unsafe: null, meta: async () => ({ ...state }),
    observe: async () => ({ ...state, items: [{ text: 'visible content' }], total: 1 }),
    identity: async () => ({ accountId: 'account', resourceId: 'resource' }),
    condition: async () => true, act: async action => { effects.push(action.actionId); }, dispose: async () => {} };
  const runtime = { page: browser.page, browserAdapter: browser, signal: new AbortController().signal,
    input: { operationId: 'op-1', authorization, ...(strict ? { identity: { account: { selector: '#account' } } } : {}) },
    durable: async (type, payload) => {
      records.push({ type, payload });
      beforeRecord?.({ type, payload, authorization, records });
      return type === 'authorize' ? { authorization: { ...authorization } } : { acknowledged: true };
    }
  };
  const session = createFastSession(runtime);
  const command = (kind, payload) => ({ schemaVersion: 1, operationId: 'op-1', commandId: `${kind}-${records.length}`, authorizationVersion: 1, ...state, kind, payload });
  return { session, records, effects, command, runtime };
}

for (const strict of [false, true]) {
  test(`${strict ? 'strict identity' : 'Profile'} observation retains ${strict ? 6 : 3} live authorization checks`, async (t) => {
    const h = harness({ strict }); t.after(() => h.session.dispose());
    assert.equal((await h.session.execute(h.command('observe', {}))).status, 'confirmed');
    assert.equal(h.records.filter(r => r.type === 'authorize').length, strict ? 6 : 3);
  });
}

test('Profile optimization still rechecks revocation after prepared ACK before an external effect', async (t) => {
  const h = harness({ beforeRecord: ({ type, payload, authorization }) => {
    if (type === 'action' && payload.status === 'prepared') authorization.revokedAt = new Date().toISOString();
  } });
  t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {}));
  const reply = await h.session.execute(h.command('batch', { actions: [{ actionId: 'external-save', type: 'click', target: { selector: '#save' } }], preconditions: [], verify: [] }));
  assert.equal(reply.reason, 'AUTHORIZATION_EXPIRED');
  assert.equal(h.effects.length, 0);
  assert.equal(h.records.some(r => r.type === 'action' && r.payload.status === 'initiated'), false);
});

test('explicit local actions keep live authorization and commit receipts only with the command result', async (t) => {
  const h = harness(); t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {})); h.records.length = 0;
  const reply = await h.session.execute(h.command('batch', { actions: [{ actionId: 'local-fill', type: 'fill', effect: false, target: { selector: '#draft' }, value: 'draft' }], preconditions: [], verify: [] }));
  assert.equal(reply.status, 'confirmed');
  assert.equal(reply.localActions, undefined);
  assert.equal(h.records.filter(r => r.type === 'action').length, 0);
  assert.equal(h.records.filter(r => r.type === 'authorize' && r.payload.localReceipt === true).length, 1);
  const local = h.records.find(r => r.type === 'command-result').payload.localActions;
  assert.equal(local.length, 1); assert.equal(local[0].status, 'confirmed'); assert.equal(local[0].effect, false);
  assert.equal(local[0].origin, 'http://fixture.test');
});

test('partial local failures retain successful and failed attempted receipts with the stopped result', async (t) => {
  const h = harness(); t.after(() => h.session.dispose());
  h.runtime.browserAdapter.act = async action => { h.effects.push(action.actionId); if (action.actionId === 'local-fail') throw new Error('Synthetic failed local action'); };
  await h.session.execute(h.command('observe', {})); h.records.length = 0;
  const reply = await h.session.execute(h.command('batch', { actions: ['local-ok', 'local-fail'].map(actionId => ({ actionId, type: 'click', effect: false, target: { selector: '#local' } })), preconditions: [], verify: [] }));
  assert.equal(reply.status, 'stopped');
  const local = h.records.find(r => r.type === 'command-result').payload.localActions;
  assert.deepEqual(local.map(r => [r.actionId, r.status]), [['local-ok', 'confirmed'], ['local-fail', 'failed']]);
  await h.session.execute(h.command('observe', {}));
  const repeated = await h.session.execute(h.command('batch', { actions: [{ actionId: 'local-fail', type: 'click', effect: false, target: { selector: '#local' } }], preconditions: [], verify: [] }));
  assert.equal(repeated.reason, 'ACTION_ALREADY_ATTEMPTED'); assert.equal(h.effects.length, 2);
});

test('upload and download retain per-action durability even with explicit effect false', async (t) => {
  const h = harness(); t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {})); h.records.length = 0;
  await h.session.execute(h.command('batch', { actions: ['upload', 'download'].map(type => ({ actionId: type, type, effect: false, target: { selector: '#files' }, value: 'synthetic-file' })), preconditions: [], verify: [] }));
  assert.equal(h.records.filter(r => r.type === 'action').length, 6);
  assert.equal(h.records.some(r => r.type === 'authorize' && r.payload.localReceipt), false);
});

test('lost final command-result ACK is not overwritten and the Worker cannot execute the next command', async () => {
  let loseAck = false;
  const h = harness({ beforeRecord: ({ type }) => { if (loseAck && type === 'command-result') throw new Error('Lost result ACK'); } });
  await h.session.dispose();
  const commands = [h.command('observe', {}), h.command('batch', { actions: [{ actionId: 'local', type: 'fill', effect: false, target: { selector: '#draft' }, value: 'draft' }], preconditions: [], verify: [] })];
  commands[1].commandId = 'local-lost-ack';
  let waits = 0;
  h.runtime.wait = async () => { const command = commands[waits++]; if (waits === 2) loseAck = true; return command; };
  await assert.rejects(runFastSession(h.runtime), { code: 'COMMAND_RESULT_UNKNOWN' });
  assert.equal(waits, 2);
  assert.equal(h.records.filter(r => r.type === 'command-result' && r.payload.commandId === 'local-lost-ack').length, 1);
  assert.equal(h.effects.length, 1);
});

test('sixteen large local expectations fall back before acting instead of overflowing one durable result', async (t) => {
  const h = harness({ beforeRecord: ({ payload }) => { assert.ok(Buffer.byteLength(JSON.stringify(payload)) <= 128 * 1024); } });
  t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {})); h.records.length = 0;
  const actions = Array.from({ length: 16 }, (_, index) => ({ actionId: `large-local-${index}`, type: 'fill', effect: false,
    target: { selector: '#draft' }, value: 'draft', expected: { target: { selector: '#readback' }, text: 'x'.repeat(7400) } }));
  const command = h.command('batch', { actions, preconditions: [], verify: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(command)) < 128 * 1024);
  const reply = await h.session.execute(command);
  assert.equal(reply.status, 'confirmed');
  assert.equal(h.effects.length, 16);
  assert.ok(h.records.some(record => record.type === 'action'), 'large records must take the original per-action durable path');
  const final = h.records.find(record => record.type === 'command-result').payload;
  assert.ok((final.localActions || []).length < 16);
  assert.ok(Buffer.byteLength(JSON.stringify(final)) <= 128 * 1024);
});
