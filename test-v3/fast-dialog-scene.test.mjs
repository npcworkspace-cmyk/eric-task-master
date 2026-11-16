import assert from 'node:assert/strict';
import test from 'node:test';
import { createFastSession } from '../src/runtime/fast-session.mjs';

function harness({ duringAcknowledgement } = {}) {
  const state = { pageId: 'page-1', pageVersion: '7:document-A:1', url: 'http://fixture.test/live', title: 'live fixture' };
  const records = [];
  const authorization = { scope: 'profile', version: 1, accountId: 'profile:test', resourceIds: ['*'], origins: ['*'], allowedActions: ['*'], expiresAt: null };
  const browser = {
    page: {}, unsafe: 'UNEXPECTED_DIALOG', unsafeToken: 'dialog-A',
    meta: async () => ({ ...state }), observe: async () => ({ ...state, items: [], total: 0 }),
    clearUnsafe(token) { if (token !== this.unsafeToken) return false; this.unsafe = null; return true; },
    dispose: async () => {}
  };
  const runtime = { page: browser.page, browserAdapter: browser, input: { operationId: 'op-1', authorization },
    signal: new AbortController().signal,
    durable: async (type, payload) => {
      records.push({ type, payload });
      if (type === 'authorize') return { authorization };
      if (type === 'dialog-acknowledgement') duringAcknowledgement?.({ state, browser });
      return { acknowledged: true };
    }
  };
  const session = createFastSession(runtime);
  const command = (kind, payload) => ({ schemaVersion: 1, operationId: 'op-1', commandId: `${kind}-${records.length}`, authorizationVersion: 1, ...state, kind, payload });
  const acknowledge = () => command('control', { action: 'acknowledge-dialog', reason: 'Reviewed the cancelled synthetic dialog; no external effect is unresolved.' });
  return { state, records, browser, session, command, acknowledge };
}

test('dialog acknowledgement survives unrelated live DOM revisions before and during its durable ACK', async (t) => {
  const h = harness({ duringAcknowledgement: ({ state }) => { state.pageVersion = '7:document-A:99'; } });
  t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {}));
  const command = h.acknowledge();
  h.state.pageVersion = '7:document-A:22';
  const reply = await h.session.execute(command);
  assert.equal(reply.status, 'confirmed');
  assert.equal(reply.result.requiresObservation, true);
  assert.equal(h.browser.unsafe, null);
  assert.equal(h.records.filter(r => r.type === 'dialog-acknowledgement').length, 1);
  assert.equal(h.records.find(r => r.type === 'dialog-acknowledgement').payload.pageVersion, command.pageVersion);
  await h.session.dispose();
});

for (const change of ['new-dialog', 'document', 'action']) {
  test(`dialog acknowledgement rejects an observed scene invalidated by ${change}`, async (t) => {
    const h = harness();
    t.after(() => h.session.dispose());
    await h.session.execute(h.command('observe', {}));
    const command = h.acknowledge();
    h.state.pageVersion = change === 'document' ? '7:document-B:2' : '8:document-A:2';
    if (change === 'new-dialog') h.browser.unsafeToken = 'dialog-B';
    const reply = await h.session.execute(command);
    assert.equal(reply.reason, 'STALE_OBSERVATION');
    assert.equal(h.browser.unsafe, 'UNEXPECTED_DIALOG');
    assert.equal(h.records.some(r => r.type === 'dialog-acknowledgement'), false);
    await h.session.dispose();
  });
}

test('a different native-dialog token during durable acknowledgement cannot be cleared', async (t) => {
  const h = harness({ duringAcknowledgement: ({ browser }) => { browser.unsafeToken = 'dialog-B'; } });
  t.after(() => h.session.dispose());
  await h.session.execute(h.command('observe', {}));
  const reply = await h.session.execute(h.acknowledge());
  assert.equal(reply.reason, 'STALE_OBSERVATION');
  assert.equal(h.browser.unsafe, 'UNEXPECTED_DIALOG');
  assert.equal(h.browser.unsafeToken, 'dialog-B');
  await h.session.dispose();
});
