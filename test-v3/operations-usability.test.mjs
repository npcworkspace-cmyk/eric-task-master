import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFastSession, validateFastCommand } from '../src/runtime/fast-session.mjs';
import { createOperationsService } from '../src/runtime/operations-service.mjs';
import { operationAuthorization } from '../src/lib/operations-contracts.mjs';
import { ACTION_TYPES, normalizeOperationsCommand, sameDocument } from '../src/lib/operations-actions.mjs';
import { operationsSchema } from '../src/lib/operations-schema.mjs';
import { selectedSkillDirectory } from '../src/lib/skill-sync.mjs';
import { removeTestTree } from './test-fs.mjs';

function sessionFixture(t, options = {}) {
  const state = { pageId: 'page-1', pageVersion: '0:document-one:0', url: 'https://fixture.invalid/task', title: 'Task' };
  const authorization = { ...operationAuthorization(undefined, 'owned-profile'), version: 1, ...options.authorization };
  const records = [], actions = [];
  let revision = 0;
  const browser = {
    page: {}, unsafe: null, meta: async () => ({ ...state }),
    observe: async () => ({ ...state, items: [{ selector: '#draft', text: 'Current scene' }], total: 1 }),
    identity: async () => { throw Object.assign(new Error('Account selector not yet present'), { code: 'TARGET_NOT_FOUND', details: { phase: 'identity', field: 'account' } }); },
    condition: async (condition) => condition.text !== 'fail' && (condition.url === undefined || state.url === condition.url),
    validateAction: async () => {},
    act: async (action) => { actions.push(action); state.pageVersion = `0:document-one:${++revision}`; return options.act?.(action); },
    read: async () => 'Read result', invalidate: () => {}, dispose: async () => {},
    ...options.browser
  };
  const runtime = { page: browser.page, browserAdapter: browser, signal: new AbortController().signal,
    input: { operationId: 'op-test', authorization, identity: options.identity },
    durable: async (type, payload) => { records.push({ type, payload }); return type === 'authorize' ? { authorization } : { acknowledged: true }; }
  };
  const session = createFastSession(runtime);
  t.after(() => session.dispose());
  let sequence = 0;
  const command = (kind, payload = {}, extra = {}) => ({ schemaVersion: 1, operationId: 'op-test', authorizationVersion: 1, commandId: `test-${++sequence}`, kind, payload, ...extra });
  return { session, browser, state, authorization, actions, records, command };
}

test('general Profile operations need no website identity and return the next scene without extra observe calls', async (t) => {
  const h = sessionFixture(t);
  assert.equal((await h.session.execute(h.command('observe'))).status, 'confirmed');
  const first = await h.session.execute(h.command('batch', { actions: [{ type: 'fill', target: { selector: '#draft' }, value: 'draft' }] }));
  assert.equal(first.status, 'confirmed'); assert.ok(first.result.observation);
  assert.equal(first.identityStatus.scope, 'profile'); assert.equal(first.identityStatus.websiteAccountVerified, false);
  assert.equal(first.result.verification.businessResultVerified, false, 'primitive completion must not become a business-delivery claim');
  const second = await h.session.execute(h.command('batch', { actions: [{ type: 'key', value: 'End', effect: false }] }));
  assert.equal(second.status, 'confirmed'); assert.equal(h.actions.length, 2);
});

test('a general session opens its first authorized URL without a redundant blank-page observation', async (t) => {
  const h = sessionFixture(t, { act: (action) => { h.state.url = action.value; } });
  h.state.url = 'about:blank';
  const url = 'https://fixture.invalid/task';
  const reply = await h.session.execute(h.command('batch', { actions: [{ type: 'navigate', value: url }], verify: [{ url }] }));
  assert.equal(reply.status, 'confirmed'); assert.equal(reply.url, url); assert.ok(reply.result.observation);
});

test('startup navigation convenience cannot bypass a takeover/resume scene refresh', async (t) => {
  const h = sessionFixture(t);
  h.session.control({ action: 'takeover' }); h.session.control({ action: 'resume' });
  const result = await h.session.execute(h.command('batch', { actions: [{ type: 'navigate', value: 'https://fixture.invalid/task' }] }));
  assert.equal(result.reason, 'OBSERVATION_REQUIRED'); assert.equal(h.actions.length, 0);
});

test('ordinary DOM revision changes keep a document usable; actual navigation still needs a new scene', async (t) => {
  const h = sessionFixture(t);
  await h.session.execute(h.command('observe'));
  h.state.pageVersion = '4:document-one:999';
  const reply = await h.session.execute(h.command('batch', { actions: [{ type: 'scroll', value: { y: 100 } }] }, { pageVersion: '0:document-one:0', pageId: 'page-1' }));
  assert.equal(reply.status, 'confirmed');
  h.state.pageVersion = '5:document-two:0';
  assert.equal((await h.session.execute(h.command('batch', { actions: [{ type: 'scroll', value: { y: 100 } }] }))).reason, 'STALE_OBSERVATION');
  assert.equal(sameDocument('1:document:1', '3:document:200'), true);
  assert.equal(sameDocument('1:document:1', '1:different:1'), false);
});

test('optional strict identity can report a missing selector without blocking observation; it still blocks effects', async (t) => {
  const h = sessionFixture(t, { authorization: { scope: 'identity', accountId: 'actual-account', resourceIds: ['resource'], origins: ['https://fixture.invalid'], allowedActions: ['click', 'navigate'], expiresAt: new Date(Date.now() + 60000).toISOString() }, identity: { account: { selector: '#account' }, resource: { selector: '#resource' } } });
  const observation = await h.session.execute(h.command('observe'));
  assert.equal(observation.status, 'confirmed'); assert.equal(observation.identityStatus.reason, 'TARGET_NOT_FOUND');
  const effect = await h.session.execute(h.command('batch', { actions: [{ type: 'click', target: { selector: '#publish' } }] }));
  assert.equal(effect.reason, 'TARGET_NOT_FOUND'); assert.equal(effect.result.details.phase, 'identity');
  assert.equal(h.actions.length, 0); assert.equal(h.session.unresolved, false);
});

test('a non-effect navigation error preserves the real cause and never creates a write lock', async (t) => {
  const h = sessionFixture(t, { act: () => { throw Object.assign(new Error('Navigation was aborted by the page'), { code: 'ERR_ABORTED' }); } });
  await h.session.execute(h.command('observe'));
  const reply = await h.session.execute(h.command('batch', { actions: [{ type: 'navigate', value: 'https://fixture.invalid/next' }] }));
  assert.equal(reply.reason, 'ERR_ABORTED'); assert.equal(reply.result.details.actionType, 'navigate');
  assert.equal(h.session.unresolved, false); assert.ok(reply.observation);
  const committed = h.records.filter((item) => item.type === 'command-result').at(-1).payload;
  const failed = committed.localActions.find((item) => item.actionId === reply.result.details.actionId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.verification.code, 'ERR_ABORTED');
  assert.equal(failed.effect, false);
  assert.equal(h.records.filter((item) => item.type === 'action').length, 0, 'local failure evidence is committed atomically with its command result');
});

test('an uncertain external effect retains its root cause, permits inspection and local actions, but never replays', async (t) => {
  let calls = 0;
  const h = sessionFixture(t, { act: (action) => { if (action.type === 'click') { calls++; throw Object.assign(new Error('Timed out after dispatch'), { code: 'SUBMISSION_TIMEOUT', details: { phase: 'post-submit' } }); } } });
  await h.session.execute(h.command('observe'));
  const reply = await h.session.execute(h.command('batch', { actions: [{ type: 'click', target: { selector: '#publish' } }], verify: [{ target: { selector: '#proof' }, text: 'pass' }] }));
  assert.equal(reply.status, 'unknown'); assert.equal(reply.result.details.cause, 'SUBMISSION_TIMEOUT'); assert.equal(reply.result.details.phase, 'post-submit');
  assert.ok(reply.observation); assert.equal(h.session.unresolved, true);
  assert.equal((await h.session.execute(h.command('batch', { actions: [{ type: 'scroll', value: { y: 20 } }] }))).status, 'confirmed');
  assert.equal((await h.session.execute(h.command('batch', { actions: [{ type: 'click', target: { selector: '#publish' } }] }))).reason, 'RECONCILE_REQUIRED');
  assert.equal(calls, 1);
});

test('one canonical action catalog and deterministic generated action IDs work for every host', () => {
  const schema = operationsSchema();
  assert.deepEqual(schema.actionTypes, ACTION_TYPES);
  for (const type of ACTION_TYPES) {
    const input = { commandId: 'stable-host-command', kind: 'batch', payload: { actions: [{ type, ...(type === 'wait' ? { value: { condition: { url: 'https://fixture.invalid/task' } } } : {}) }] } };
    const a = validateFastCommand(input), b = normalizeOperationsCommand(input);
    assert.deepEqual(a.payload.actions, b.payload.actions); assert.equal(typeof schema.actionCatalog[type].defaultEffect, 'boolean');
  }
  for (const name of ['simpleBatch', 'richText', 'crossTabBatch', 'download', 'upload']) validateFastCommand(schema.examples[name]);
  assert.throws(() => validateFastCommand({ kind: 'batch', payload: { actions: [{ type: 'invented-action' }] } }), { code: 'INVALID_ACTION' });
});

test('non-Codex hosts use the bundled guide without a dependency on a Codex Skill directory', () => {
  const bundled = selectedSkillDirectory({ environment: { ERIC_TASK_MASTER_AGENT_ID: 'dsh-session' } });
  assert.equal(bundled.directory, path.resolve('skills/eric-task-master')); assert.equal(bundled.required, true);
  assert.deepEqual(selectedSkillDirectory({ environment: {} }), bundled, 'A plain CLI/unknown Agent must not depend on a Codex home');
  const explicit = path.join(os.tmpdir(), 'another-agent', 'eric-task-master');
  assert.equal(selectedSkillDirectory({ environment: { ERIC_TASK_MASTER_AGENT_ID: 'other-session', ERIC_TASK_MASTER_SKILL_DIR: explicit } }).directory, explicit);
});

test('a default Profile session starts without routing adapters or website permission boilerplate and waits for one real reply', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-simple-ops-'));
  const tasks = new Map();
  let next = 0;
  const taskService = { createOperation: async (body) => { const task = { id: `task-${++next}`, state: 'waiting', waiting: { reason: 'operations-command', id: 'wait-1' }, input: body.input }; tasks.set(task.id, task); return task; }, get: async (id) => tasks.get(id), resume: async () => {}, setOperationDurableHandler: () => {} };
  const profileStore = { getDefault: async () => ({ id: 'default-profile', modePolicy: 'auto' }), get: async (id) => ({ id, modePolicy: 'auto' }) };
  const service = await createOperationsService({ stateDir, taskService, profileStore, tickMs: 60000 });
  t.after(async () => { await service.close(); await removeTestTree(stateDir); });
  const op = await service.start({ goal: 'Finish the task', mode: 'operations' });
  assert.equal(op.browserSelection.kind, 'profile'); assert.equal(op.browserSelection.profileId, 'default-profile'); assert.equal(op.authorization.scope, 'profile'); assert.equal(op.identity, null);
  const reserved = await service.command(op.id, { kind: 'observe' });
  const waiting = service.waitCommand(op.id, reserved.commandId, 1000);
  await service.durable(op.taskId, 'command-result', { commandId: reserved.commandId, status: 'confirmed', result: { text: 'Actual worker result' } });
  const reply = await waiting;
  assert.equal(reply.status, 'confirmed'); assert.equal(reply.result.text, 'Actual worker result'); assert.equal(reply.operationId, op.id);
});
