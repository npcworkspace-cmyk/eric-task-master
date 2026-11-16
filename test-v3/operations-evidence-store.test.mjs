import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationsStore } from '../src/lib/operations-store.mjs';
import { OperationsJournalStore, prepareOperationsJournalValue } from '../src/lib/operations-journal-store.mjs';
import { OperationsEvidenceStore } from '../src/lib/operations-evidence-store.mjs';
import { removeTestTree } from './test-fs.mjs';

const defaults = () => ({ version: 1, operations: [], actions: [], commands: [], events: [], records: [] });
const reply = (id = 'one', length = 5100) => ({ commandId: id, status: 'confirmed', result: { observation: { pageId: 'page', pageVersion: '1:document:2', text: '可追溯 evidence '.repeat(Math.ceil(length / 25)).slice(0, length) } } });
const command = (id, value = reply(id), extra = {}) => ({ operationId: 'op', commandId: id, status: 'confirmed', delivered: true,
  fingerprint: `fingerprint:${id}`, envelope: { kind: 'observe', commandId: id }, createdAt: new Date().toISOString(), reply: value, ...extra });
const operation = () => ({ id: 'op', taskId: 'worker', status: 'running', authorization: { accountId: 'profile:test', version: 1, revokedAt: null }, completedActionIds: [], budgets: {}, counters: { runs: 0 } });
async function directory(t) { const value = await mkdtemp(path.join(os.tmpdir(), 'etm-cold-evidence-')); t.after(() => removeTestTree(value)); return value; }
async function open(t, options = {}) { const stateDir = await directory(t), store = await new OperationsStore({ stateDir, ...options }).init(); return { stateDir, store }; }
const files = (store) => readdir(store.evidence.directory);
const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value));

test('terminal reply evidence stays cold through updates while public reads and targeted hydration remain exact', async (t) => {
  const { stateDir, store } = await open(t);
  const expected = reply('large');
  await store.update((data) => {
    data.operations.push(operation()); data.commands.push(command('large', expected), command('small', { status: 'confirmed' }));
    data.actions.push({ operationId: 'op', actionId: 'uncertain', status: 'unknown', effect: true, expected: { text: 'retain safety' } });
  });
  const hot = await store.project((data) => data);
  assert.equal(hot.commands[0].reply, undefined);
  assert.match(hot.commands[0].replyRef.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(hot.commands[0].replyRef.bytes, jsonBytes(expected));
  assert.deepEqual(hot.commands[1].reply, { status: 'confirmed' });
  assert.equal(hot.actions[0].expected.text, 'retain safety');
  assert.equal(hot.operations[0].authorization.version, 1);
  let reads = 0, puts = 0;
  const read = store.evidence.read.bind(store.evidence), put = store.evidence.put.bind(store.evidence);
  store.evidence.read = async (...args) => { reads++; return read(...args); };
  store.evidence.put = async (...args) => { puts++; return put(...args); };
  for (let index = 0; index < 3; index++) await store.update((data) => {
    assert.equal(data.commands[0].reply, undefined, 'old observations never enter the mutable hot draft');
    data.operations[0].counters.runs++;
  });
  await store.readAuthorizationContext('worker', 'large', { kind: 'observe', effect: false });
  assert.equal(reads, 0); assert.equal(puts, 0, 'unchanged refs are not rewritten or fsynced');
  const hydrated = await store.hydrateCommand(hot.commands[0]);
  assert.deepEqual(hydrated.reply, expected); assert.equal(hydrated.replyRef, undefined);
  const pair = await store.hydrateCommands([hot.commands[0], hot.commands[0]]);
  pair[0].reply.result.observation.text = 'caller mutation';
  assert.deepEqual(pair[1].reply, expected, 'two equal references do not share mutable hydrated objects');
  assert.deepEqual((await store.read()).commands[0].reply, expected);
  const reopened = await new OperationsStore({ stateDir }).init();
  assert.deepEqual((await reopened.read()).commands[0].reply, expected);
});

test('reply sanitation happens before immutable evidence is hashed or persisted', async (t) => {
  const { store } = await open(t), value = reply('redacted');
  value.password = 'COLD_PASSWORD_SENTINEL'; value.verificationCode = 'COLD_OTP_SENTINEL';
  value.result.private = { name: 'access_token', value: 'COLD_NAMED_SENTINEL' };
  await store.update((data) => { data.commands.push(command('redacted', value)); });
  const hydrated = (await store.read()).commands[0].reply;
  assert.equal(hydrated.password, undefined); assert.equal(hydrated.verificationCode, undefined);
  assert.equal(hydrated.result.private.value, '[REDACTED]');
  const active = [store.store.filePath, store.store.journalPath, ...(await files(store)).map((file) => path.join(store.evidence.directory, file))];
  const all = (await Promise.all(active.map((file) => readFile(file, 'utf8')))).join('\n');
  for (const secret of ['COLD_PASSWORD_SENTINEL', 'COLD_OTP_SENTINEL', 'COLD_NAMED_SENTINEL']) assert.equal(all.includes(secret), false);
});

test('pending and unknown replies and every action/grant remain hot; forged unsafe references reject', async (t) => {
  const { store } = await open(t);
  await store.update((data) => {
    data.operations.push(operation()); data.actions.push({ operationId: 'op', actionId: 'active', effect: true, status: 'initiated', socialInteractionKey: 'global-duplicate-key' });
    data.commands.push(command('pending', reply('pending'), { status: 'pending' }), command('unknown', reply('unknown'), { status: 'unknown' }));
  });
  const hot = await store.project((data) => data);
  assert.deepEqual(hot.commands.map((item) => Boolean(item.reply && !item.replyRef)), [true, true]);
  assert.equal(hot.actions[0].socialInteractionKey, 'global-duplicate-key');
  assert.equal((await files(store)).length, 0);
  const prepared = store.evidence.prepare(reply('forged')); await store.evidence.put(prepared);
  await assert.rejects(store.update((data) => { data.commands.push({ ...command('invalid', undefined, { status: 'pending' }), replyRef: prepared.reference }); }), { code: 'OPERATIONS_EVIDENCE_INVALID' });
  assert.equal((await store.read()).commands.length, 2);
});

for (const damage of ['missing', 'same-length-corruption']) test(`${damage} cold evidence fails on hydration and startup, not silently replaced by a hot cache`, async (t) => {
  const { stateDir, store } = await open(t);
  await store.update((data) => { data.operations.push(operation()); data.commands.push(command('cold')); });
  const hot = await store.project((data) => data.commands[0]), file = store.evidence.filePath(hot.replyRef);
  if (damage === 'missing') await unlink(file);
  else {
    const bytes = await readFile(file); bytes[bytes.indexOf(Buffer.from('evidence'))] = 'E'.charCodeAt(0); await writeFile(file, bytes);
  }
  // Hot reads intentionally do not hash every unrelated historical file. A
  // selected cold read and every restart do, and fence on failure.
  assert.equal((await store.readAuthorizationContext('worker', 'cold', { kind: 'observe' })).operations[0].id, 'op');
  await assert.rejects(store.hydrateCommand(hot), { code: 'OPERATIONS_EVIDENCE_INVALID' });
  await assert.rejects(store.project((data) => data.operations), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  await assert.rejects(new OperationsStore({ stateDir }).init(), { code: 'OPERATIONS_EVIDENCE_INVALID' });
});

test('reference names cannot escape the evidence directory and existing mismatched content is never overwritten', async (t) => {
  const stateDir = await directory(t), evidence = await new OperationsEvidenceStore(path.join(stateDir, 'evidence')).init();
  assert.throws(() => evidence.filePath({ version: 1, sha256: '../outside', bytes: 10 }), { code: 'OPERATIONS_EVIDENCE_INVALID' });
  const prepared = evidence.prepare({ result: 'immutable' }), file = evidence.filePath(prepared.reference);
  await writeFile(file, 'tampered');
  await assert.rejects(evidence.put(prepared), { code: 'OPERATIONS_EVIDENCE_INVALID' });
  assert.equal(await readFile(file, 'utf8'), 'tampered');
});

for (const stage of ['beforeEvidenceSync', 'beforeEvidenceClose', 'beforeEvidenceLink', 'afterEvidenceCommit']) test(`interruption at ${stage} cannot acknowledge or commit a reference to incomplete evidence`, async (t) => {
  let armed = false, effects = 0;
  const { stateDir, store } = await open(t, { evidenceOptions: { fault: async (current) => { if (armed && current === stage) throw new Error(`fault:${stage}`); } } });
  armed = true;
  await assert.rejects((async () => { await store.update((data) => { data.commands.push(command('unacknowledged')); }); effects++; })(), new RegExp(`fault:${stage}`, 'u'));
  assert.equal(effects, 0);
  assert.equal((await readFile(store.store.journalPath, 'utf8')).includes('unacknowledged'), false);
  await assert.rejects(store.project((data) => data.commands), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  const retained = await files(store), reopened = await new OperationsStore({ stateDir }).init();
  assert.equal((await reopened.read()).commands.length, 0);
  assert.deepEqual(await files(reopened), retained, 'unreferenced immutable files are not automatically garbage-collected');
});

test('evidence commits before WAL append, so a lost reference ACK can recover exact durable evidence without replay', async (t) => {
  let armed = false, effects = 0; const order = [];
  const { stateDir, store } = await open(t, {
    evidenceOptions: { fault: async (stage) => { if (armed && stage === 'afterEvidenceCommit') order.push('evidence'); } },
    journalOptions: { fault: async (stage) => { if (armed && stage === 'beforeAppendSync') { order.push('journal'); throw new Error('lost reference ACK'); } } }
  });
  armed = true;
  await assert.rejects((async () => { await store.update((data) => { data.commands.push(command('durable-before-ref')); }); effects++; })(), /lost reference ACK/u);
  assert.deepEqual(order, ['evidence', 'journal']); assert.equal(effects, 0);
  const reopened = await new OperationsStore({ stateDir }).init();
  assert.deepEqual((await reopened.read()).commands[0].reply, reply('durable-before-ref'));
});

test('logical capacity counts cold payload per retained reply even when one blob is deduplicated', async (t) => {
  const { store } = await open(t, { maxBytes: 48 * 1024 });
  const large = { status: 'confirmed', result: { text: 'x'.repeat(28000) } };
  await store.update((data) => { data.operations.push(operation()); data.commands.push(command('first', large)); });
  const hot = await store.project((data) => data);
  assert.ok(jsonBytes(hot) < 2048);
  await assert.rejects(store.update((data) => { data.commands.push(command('second', large)); }), { code: 'OPERATIONS_STORAGE_LIMIT' });
  const recovered = await store.read();
  assert.equal(recovered.commands.length, 1); assert.equal(recovered.operations[0].status, 'paused');
  assert.equal(recovered.storageFailure.code, 'OPERATIONS_STORAGE_LIMIT');
  assert.equal((await files(store)).length, 1, 'capacity failure happens before writing new evidence');
});

test('restart enforces total logical size rather than only its small hot snapshot', async (t) => {
  const { stateDir, store } = await open(t, { maxBytes: 128 * 1024 });
  await store.update((data) => { data.commands.push(command('one', { text: 'a'.repeat(36000) }), command('two', { text: 'b'.repeat(36000) })); });
  assert.ok(jsonBytes(await store.project((data) => data)) < 2048);
  await assert.rejects(new OperationsStore({ stateDir, maxBytes: 64 * 1024 }).init(), { code: 'OPERATIONS_STORAGE_LIMIT' });
});

for (const format of ['legacy-v1', 'snapshot-v2-with-WAL']) test(`${format} migrates representative 5 KiB replies without truncation or retention loss`, async (t) => {
  const stateDir = await directory(t), file = path.join(stateDir, 'operations.json');
  const old = defaults();
  old.operations.push(operation());
  old.commands = Array.from({ length: 8 }, (_value, index) => command(`history-${index}`, { status: 'confirmed', observation: { text: `${index}:` + 'h'.repeat(5100), items: [{ ref: `ref-${index}`, text: 'original evidence' }] } }, { createdAt: '2000-01-01T00:00:00.000Z' }));
  if (format === 'legacy-v1') await writeFile(file, JSON.stringify(old, null, 2));
  else {
    const journal = await new OperationsJournalStore(file, defaults()).init();
    await journal.update(() => structuredClone(old));
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    snapshot.format = 'eric-task-master-operations-v2';
    const { checksum: _checksum, ...body } = snapshot;
    snapshot.checksum = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await writeFile(file, JSON.stringify(snapshot));
  }
  const original = await readFile(file);
  const store = await new OperationsStore({ stateDir }).init();
  const hot = await store.project((data) => data), hydrated = await store.read();
  assert.deepEqual(hydrated, old, 'migration itself does not apply terminal retention or reduce capability');
  assert.ok(hot.commands.every((item) => item.replyRef && !item.reply));
  assert.ok(jsonBytes(hot) < jsonBytes(hydrated) / 4);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).format, 'eric-task-master-operations-v3');
  assert.equal((await readFile(file, 'utf8')).includes('h'.repeat(100)), false, 'compacted hot snapshot no longer contains historical observations');
  if (format === 'legacy-v1') assert.deepEqual(await readFile(store.store.legacyPath), original);
  assert.deepEqual(await (await new OperationsStore({ stateDir }).init()).read(), old);
  console.log(JSON.stringify({ migration: format, commands: 8, hotBytes: jsonBytes(hot), logicalBytes: jsonBytes(hydrated), payloadsRetained: true }));
});

for (const stage of ['afterSnapshotCommit', 'beforeJournalReset']) test(`cold migration survives ${stage} interruption with complete replies and matching references`, async (t) => {
  const stateDir = await directory(t), original = defaults();
  original.commands.push(command('migration-boundary'));
  await writeFile(path.join(stateDir, 'operations.json'), JSON.stringify(original));
  await assert.rejects(new OperationsStore({ stateDir, journalOptions: { fault: async (current) => { if (current === stage) throw new Error(`migration:${stage}`); } } }).init(), new RegExp(`migration:${stage}`, 'u'));
  const reopened = await new OperationsStore({ stateDir }).init();
  assert.deepEqual(await reopened.read(), original);
  assert.ok((await reopened.project((data) => data.commands[0])).replyRef);
});

test('cold conversion cannot hide deep/truncated structures or leak updater/result aliases', async (t) => {
  const { store } = await open(t); let retained;
  await assert.rejects(store.update((data) => {
    const value = reply('deep'); let current = value;
    for (let depth = 0; depth < 31; depth++) current = current.child = {};
    data.commands.push(command('deep', value));
  }), { code: 'RECORD_TOO_DEEP' });
  assert.equal((await files(store)).length, 0);
  const result = await store.update((data) => { retained = command('isolated'); data.commands.push(retained); return retained; });
  retained.reply.result.observation.text = 'input alias'; result.reply.result.observation.text = 'result alias';
  assert.deepEqual((await store.read()).commands[0].reply, reply('isolated'));
});

test('transaction canonical proof is bound to an immutable plain graph and cannot be supplied for another value', async (t) => {
  const stateDir = await directory(t), journal = await new OperationsJournalStore(path.join(stateDir, 'operations.json'), defaults(), { maxBytes: 1024 }).init();
  const small = defaults(); small.records.push({ nested: { text: 'safe' } });
  Object.freeze(small.records[0]);
  const proof = prepareOperationsJournalValue(small);
  assert.equal(proof.bytes, jsonBytes(small));
  assert.throws(() => { small.records[0].nested.text = 'cannot mutate'; }, TypeError);
  assert.throws(() => { proof.bytes = 0; }, TypeError);
  await journal.update(() => small, { detachedResult: true });
  const oversized = defaults(); oversized.records.push({ text: 'x'.repeat(2000) });
  await assert.rejects(journal.update(() => oversized, { detachedResult: true, canonicalResult: () => proof }), { code: 'OPERATIONS_STORAGE_LIMIT' });
  assert.equal((await journal.read()).records[0].nested.text, 'safe');
  const accessor = defaults(); Object.defineProperty(accessor, 'dynamic', { get: () => 'unsafe', enumerable: true });
  assert.throws(() => prepareOperationsJournalValue(accessor), /accessors/u);
});

test('authorization projection keeps needed safety evidence while read-only checks omit action history', async (t) => {
  const { store } = await open(t);
  await store.update((data) => {
    data.operations.push(operation(), { ...operation(), id: 'other', taskId: 'other-worker' });
    data.commands.push(command('current', { status: 'confirmed' }, { status: 'pending' }));
    data.actions.push({ operationId: 'op', actionId: 'own', status: 'unknown', effect: true },
      { operationId: 'other', actionId: 'foreign-social', status: 'confirmed', socialInteractionKey: 'global-key', createdAt: new Date().toISOString() });
  });
  for (const kind of ['observe', 'wait', 'tabs', 'select-tab', 'reconcile']) assert.equal((await store.readAuthorizationContext('worker', 'current', { kind })).actions.length, 0);
  for (const kind of ['fill', 'ads.adjust', 'click']) assert.deepEqual((await store.readAuthorizationContext('worker', 'current', { kind })).actions.map((item) => item.actionId), ['own']);
  assert.equal((await store.readAuthorizationContext('worker', 'current', { kind: 'social.reply' })).actions.length, 2);
  assert.equal((await store.readAuthorizationContext('worker', 'current')).actions.length, 2);
  await appendFile(store.store.journalPath, '\n');
  await assert.rejects(store.readAuthorizationContext('worker', 'current', { kind: 'observe' }), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
});
