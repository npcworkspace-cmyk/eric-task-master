import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationsStore } from '../src/lib/operations-store.mjs';
import { createOperationsService } from '../src/runtime/operations-service.mjs';
import { removeTestTree } from './test-fs.mjs';

async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-ops-hotpath-'));
  const tasks = new Map(), resumes = [];
  let ready, sequence = 0, get = async (id) => tasks.get(id);
  let resume = async (id, value) => { resumes.push({ id, value }); tasks.get(id).state = 'running'; };
  const taskService = {
    createOperation: async () => { const task = { id: `task-${++sequence}`, state: 'waiting', waiting: { id: 'wait', reason: 'operations-command' } }; tasks.set(task.id, task); return task; },
    get: (id) => get(id), resume: (...args) => resume(...args),
    stop: async (id) => { tasks.get(id).state = 'stopped'; }, operationControl: async () => true,
    setOperationDurableHandler: () => {}, setOperationReadyHandler: (handler) => { ready = handler; }
  };
  const profileStore = { getDefault: async () => ({ id: 'test-profile', modePolicy: 'auto' }) };
  const service = await createOperationsService({ stateDir, taskService, profileStore, tickMs: 60000 });
  t.after(async () => { await service.close(); await removeTestTree(stateDir); });
  return { service, tasks, resumes, journalPath: path.join(stateDir, 'operations', 'operations.journal.jsonl'),
    ready: (id) => ready?.(id), readyHandler: () => ready, setGet: (fn) => { get = fn; }, setResume: (fn) => { resume = fn; } };
}

test('a persisted Worker-ready notification delivers a reserved command without waiting for a scheduler tick', async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Local event handoff', mode: 'operations' });
  f.tasks.get(operation.taskId).state = 'running';
  await f.service.command(operation.id, { commandId: 'next', kind: 'observe' });
  assert.equal(f.resumes.length, 0);
  f.tasks.get(operation.taskId).state = 'waiting';
  await f.ready(operation.taskId);
  assert.equal(f.resumes.length, 1);
  assert.equal(f.resumes[0].value.commandId, 'next');
  await f.ready(operation.taskId);
  assert.equal(f.resumes.length, 1, 'the durable delivered flag still forbids duplicate dispatch');
  await f.service.close();
  assert.equal(f.readyHandler(), null);
});

test('a ready notification racing an active deliver attempt retains one redispatch, never a replay', async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Local event race', mode: 'operations' });
  const task = f.tasks.get(operation.taskId); task.state = 'running';
  let entered, release;
  const waitingGet = new Promise((resolve) => { entered = resolve; });
  const holdGet = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  f.setGet(async () => {
    if (++calls === 2) { entered(); await holdGet; return { ...task, state: 'running', waiting: null }; }
    return task;
  });
  const command = f.service.command(operation.id, { commandId: 'next-race', kind: 'observe' });
  await waitingGet;
  task.state = 'waiting';
  await f.ready(operation.taskId);
  release();
  await command;
  let timer;
  try {
    await Promise.race([
      (async () => { while (!f.resumes.length) await new Promise((resolve) => setTimeout(resolve, 1)); })(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('ready event was lost')), 500); })
    ]);
  } finally { clearTimeout(timer); }
  await f.ready(operation.taskId);
  assert.equal(f.resumes.length, 1);
});

test('a revoked reservation cannot be delivered by a late Worker-ready notification', async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Local revocation', mode: 'operations' });
  f.tasks.get(operation.taskId).state = 'running';
  await f.service.command(operation.id, { commandId: 'blocked', kind: 'observe' });
  await f.service.action(operation.id, { action: 'revoke' });
  f.tasks.get(operation.taskId).state = 'waiting';
  await f.ready(operation.taskId);
  assert.equal(f.resumes.length, 0);
});

test('incremental journal sanitation never trusts initial disk data and catches nested and replacement edits', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-sanitize-records-'));
  t.after(() => removeTestTree(stateDir));
  const file = path.join(stateDir, 'operations.json');
  await writeFile(file, JSON.stringify({ version: 1, operations: [{ id: 'op', authorization: { accountId: 'a', version: 1 }, password: 'INITIAL_SECRET' }],
    actions: [], commands: [], events: [], records: [{ id: 'record', nested: { value: 'safe' } }] }));
  const store = await new OperationsStore({ stateDir }).init();
  await store.update(() => {});
  assert.equal((await readFile(file, 'utf8')).includes('INITIAL_SECRET'), false);
  await store.update((data) => {
    data.operations[0].authorization.version = 2;
    data.records[0].nested.password = 'NESTED_SECRET';
    data.records[0].nested.value = 'cookie=COOKIE_SECRET';
    data.records.push({ id: 'second', verificationCode: 'OTP_SECRET', payload: { name: 'access_token', value: 'NAMED_SECRET' } });
    data.actions = [{ actionId: 'replacement', status: 'prepared', apiKey: 'REPLACED_SECRET' }];
    data.password = 'ENVELOPE_SECRET';
  });
  const text = (await Promise.all([file, store.store.journalPath].map((active) => readFile(active, 'utf8')))).join('\n');
  for (const value of ['NESTED_SECRET', 'COOKIE_SECRET', 'OTP_SECRET', 'NAMED_SECRET', 'REPLACED_SECRET', 'ENVELOPE_SECRET']) assert.equal(text.includes(value), false, value);
  assert.equal((await store.read()).operations[0].authorization.version, 2);
  assert.equal((await store.read()).records[1].payload.value, '[REDACTED]');
  await store.update((data) => { data.records[0].password = undefined; });
  assert.equal(Object.hasOwn((await store.read()).records[0], 'password'), false);
  const replaced = await store.read(); replaced.records[0].password = 'REPLACED_DISK_SECRET';
  await store.store.replace(replaced);
  await store.update(() => {});
  assert.equal((await Promise.all([file, store.store.journalPath].map((active) => readFile(active, 'utf8')))).join('\n').includes('REPLACED_DISK_SECRET'), false);
});

test('sanitized record reuse preserves whole-journal depth and array bounds', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-sanitize-bounds-'));
  t.after(() => removeTestTree(stateDir));
  const store = await new OperationsStore({ stateDir }).init();
  await store.update((data) => { data.records.push({ id: 'bounded' }); });
  await assert.rejects(store.update((data) => {
    let nested = data.records[0];
    for (let depth = 0; depth < 30; depth++) nested = nested.child = {};
    nested.value = 'too deep';
  }), { code: 'RECORD_TOO_DEEP' });
  assert.equal((await store.read()).records[0].child, undefined);
  await assert.rejects(store.update((data) => { data.events = Array.from({ length: 10002 }, () => ({ state: 'pending' })); }), { code: 'RECORD_TOO_DEEP' });
  assert.equal((await store.read()).events.length, 0);
  const untrusted = await store.read();
  let nested = untrusted.records[0];
  for (let depth = 0; depth < 30; depth++) nested = nested.child = {};
  nested.value = 'untrusted disk depth';
  const untrustedDir = await mkdtemp(path.join(os.tmpdir(), 'etm-untrusted-journal-depth-'));
  t.after(() => removeTestTree(untrustedDir));
  await writeFile(path.join(untrustedDir, 'operations.json'), JSON.stringify(untrusted));
  const reopened = await new OperationsStore({ stateDir: untrustedDir }).init();
  await assert.rejects(reopened.update(() => {}), { code: 'RECORD_TOO_DEEP' });
});

test('projected authorization reads retain live authority and cross-operation evidence without unrelated reply histories', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-auth-projection-'));
  t.after(() => removeTestTree(stateDir));
  const store = await new OperationsStore({ stateDir }).init();
  await store.update((data) => {
    data.operations.push({ id: 'own', taskId: 'worker', authorization: { accountId: 'account', version: 1, revokedAt: null } },
      { id: 'other', taskId: 'other-worker', authorization: { accountId: 'other-account', version: 1 } });
    data.commands.push({ operationId: 'own', commandId: 'current', status: 'pending', envelope: { kind: 'observe' }, reply: { text: 'unneeded current reply' } },
      { operationId: 'other', commandId: 'current', status: 'confirmed', envelope: { kind: 'batch' }, reply: { text: 'unrelated observation history' } });
    data.actions.push({ operationId: 'other', actionId: 'prior-social', status: 'confirmed', effect: true, socialInteractionKey: 'cross-operation-duplicate-key', createdAt: new Date().toISOString() });
  });
  const projected = await store.readAuthorizationContext('worker', 'current');
  assert.equal(projected.operations.length, 1);
  assert.equal(projected.commands.length, 1);
  assert.equal(projected.commands[0].operationId, 'own');
  assert.equal(projected.commands[0].reply, undefined);
  assert.equal(projected.actions[0].socialInteractionKey, 'cross-operation-duplicate-key');
  projected.operations[0].authorization.version = 99;
  projected.actions[0].socialInteractionKey = 'tampered local copy';
  assert.equal((await store.readAuthorizationContext('worker', 'current')).operations[0].authorization.version, 1);
  assert.equal((await store.read()).actions[0].socialInteractionKey, 'cross-operation-duplicate-key');
  await store.update((data) => { data.operations[0].authorization.revokedAt = '2026-11-16T01:00:00.000Z'; data.operations[0].authorization.version = 2; });
  assert.equal((await store.readAuthorizationContext('worker', 'current')).operations[0].authorization.revokedAt, '2026-11-16T01:00:00.000Z');
  await appendFile(store.store.journalPath, '\n');
  await assert.rejects(store.readAuthorizationContext('worker', 'current'), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
});

test('detached sanitized commit cannot be mutated through retained updater drafts or results', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-detached-commit-'));
  t.after(() => removeTestTree(stateDir));
  const store = await new OperationsStore({ stateDir }).init();
  let retained, retainedRecord;
  const result = await store.update((data) => {
    retained = data;
    retainedRecord = { id: 'record', nested: { value: 'committed' } };
    data.records.push(retainedRecord);
    return retainedRecord;
  });
  retained.records[0].nested.value = 'mutated draft';
  retained.records.push({ id: 'injected' });
  retained.version = 99;
  retainedRecord.nested.value = 'mutated input';
  result.nested.value = 'mutated result';
  const committed = await store.read();
  assert.equal(committed.version, 1);
  assert.deepEqual(committed.records, [{ id: 'record', nested: { value: 'committed' } }]);
  await store.update((data) => { retained = data; });
  retained.records[0].nested.value = 'mutated cached record';
  assert.equal((await store.read()).records[0].nested.value, 'committed');
  const reopened = await new OperationsStore({ stateDir }).init();
  assert.deepEqual((await reopened.read()).records, committed.records);
});

test('private canonical reuse preserves distinct equal records and sanitizes nested edits after cache hits', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-private-canonical-'));
  t.after(() => removeTestTree(stateDir));
  const store = await new OperationsStore({ stateDir }).init();
  await store.update((data) => {
    data.records.push({ nested: { value: 'equal' } }, { nested: { value: 'equal' } });
  });
  for (let count = 0; count < 3; count++) await store.update(() => {});
  let retained;
  await store.update((data) => {
    retained = data.records;
    data.records[0].nested.value = 'edited';
    data.records[0].nested.password = 'CACHE_EDIT_SECRET';
  });
  retained[0].nested.value = 'retained mutation';
  const saved = await store.read();
  assert.deepEqual(saved.records, [{ nested: { value: 'edited' } }, { nested: { value: 'equal' } }]);
  assert.equal((await readFile(store.store.journalPath, 'utf8')).includes('CACHE_EDIT_SECRET'), false);
  assert.deepEqual((await (await new OperationsStore({ stateDir }).init()).read()).records, saved.records);
});

test('compact command projection still fences disk edits before replying', async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Projected reply fence', mode: 'operations' });
  await f.service.command(operation.id, { commandId: 'projected', kind: 'observe' });
  await f.service.durable(operation.taskId, 'command-result', { commandId: 'projected', status: 'confirmed' });
  assert.equal((await f.service.waitCommand(operation.id, 'projected', 0)).status, 'confirmed');
  // The service's state is deliberately private; locate only this test's store
  // through its retained fixture state directory, never a shared Manager state.
  await appendFile(f.journalPath, '\n');
  await assert.rejects(f.service.get(operation.id, { commandId: 'projected' }), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
});

test('a waiting Worker reserves command and one delivered attempt in the same journal commit', async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Atomic waiting handoff', mode: 'operations' });
  const before = (await readFile(f.journalPath, 'utf8')).trim().split('\n').length;
  const record = await f.service.command(operation.id, { commandId: 'atomic', kind: 'observe' });
  const after = (await readFile(f.journalPath, 'utf8')).trim().split('\n').length;
  assert.equal(record.delivered, true);
  assert.equal(after - before, 1, 'reservation and delivered fence share one fsynced transaction');
  assert.equal(f.resumes.length, 1);
});

test('simultaneous duplicate command and ready notification never repeat an atomic handoff', async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Atomic duplicate race', mode: 'operations' });
  let entered, release, sends = 0;
  const started = new Promise((resolve) => { entered = resolve; }), held = new Promise((resolve) => { release = resolve; });
  f.setResume(async () => { sends++; entered(); await held; });
  const first = f.service.command(operation.id, { commandId: 'same', kind: 'observe' });
  await started;
  await Promise.all([f.service.command(operation.id, { commandId: 'same', kind: 'observe' }), f.ready(operation.taskId)]);
  release(); await first;
  await f.ready(operation.taskId);
  assert.equal(sends, 1);
});

test('stale exact waiting ID becomes unknown without effects or automatic resend', async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Stale waiting fence', mode: 'operations' });
  const task = f.tasks.get(operation.taskId); let prefetched = false, sends = 0, effects = 0;
  f.setGet(async () => {
    const snapshot = structuredClone(task);
    if (!prefetched) { prefetched = true; task.waiting.id = 'new-wait'; }
    return snapshot;
  });
  f.setResume(async (_id, _value, options) => {
    sends++;
    if (options.waitId !== task.waiting.id) throw Object.assign(new Error('Waiting ID changed'), { code: 'STALE_WAIT' });
    effects++;
  });
  await f.service.command(operation.id, { commandId: 'stale', kind: 'observe' });
  const saved = await f.service.get(operation.id, { commandId: 'stale' });
  assert.equal(saved.command.status, 'unknown');
  assert.equal(saved.status, 'reconcile-required');
  await f.ready(operation.taskId);
  assert.equal(sends, 1);
  assert.equal(effects, 0);
});

for (const control of ['revoke', 'takeover', 'pause']) test(`${control} after atomic commit but before IPC prevents the handoff`, async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Post-commit authority fence', mode: 'operations' });
  const original = OperationsStore.prototype.update;
  let armed = true;
  OperationsStore.prototype.update = async function (...args) {
    const result = await original.apply(this, args);
    if (armed && result?.commandId === 'guarded') { armed = false; await f.service.action(operation.id, { action: control }); }
    return result;
  };
  t.after(() => { OperationsStore.prototype.update = original; });
  await f.service.command(operation.id, { commandId: 'guarded', kind: 'batch', payload: { actions: [{ actionId: 'guarded-action', type: 'click', effect: false }] } });
  assert.equal(f.resumes.length, 0);
  const saved = await f.service.get(operation.id);
  assert.equal(saved.status, control === 'revoke' ? 'revoked' : 'paused');
  assert.equal(saved.manualLock, control === 'takeover');
  assert.equal(saved.commands[0].status, 'unknown');
  await f.ready(operation.taskId);
  assert.equal(f.resumes.length, 0);
});

test('an uncertain atomic resume acknowledgement cannot overwrite a committed command result', async (t) => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Terminal result race', mode: 'operations' });
  f.setResume(async (taskId, envelope) => {
    await f.service.durable(taskId, 'command-result', { commandId: envelope.commandId, status: 'confirmed', text: 'real committed result' });
    throw Object.assign(new Error('Resume acknowledgement lost'), { code: 'ACK_LOST' });
  });
  await f.service.command(operation.id, { commandId: 'result-won', kind: 'observe' });
  const saved = await f.service.get(operation.id, { commandId: 'result-won' });
  assert.equal(saved.command.status, 'confirmed');
  assert.equal(saved.command.reply.text, 'real committed result');
  assert.equal(saved.status, 'running');
});
