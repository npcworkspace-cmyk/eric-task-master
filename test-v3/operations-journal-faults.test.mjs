import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, appendFile, readdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OperationsJournalStore } from '../src/lib/operations-journal-store.mjs';
import { OperationsStore } from '../src/lib/operations-store.mjs';
import { createOperationsService } from '../src/runtime/operations-service.mjs';
import { removeTestTree } from './test-fs.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const signed = value => { const { checksum: _old, ...body } = value; return { ...body, checksum: digest(body) }; };
const defaults = () => ({ version: 1, operations: [], actions: [], commands: [], events: [], records: [] });
async function directory(t) { const value = await mkdtemp(path.join(os.tmpdir(), 'etm-journal-faults-')); t.after(() => removeTestTree(value)); return value; }
const open = async (root, options) => { const store = new OperationsJournalStore(path.join(root, 'operations.json'), defaults(), options); await store.init(); return store; };

test('a torn tail is retained as evidence while only the complete fsynced prefix is replayed', async t => {
  const root = await directory(t), store = await open(root);
  await store.update(value => { value.records.push({ id: 'durably-acknowledged' }); });
  const complete = await readFile(store.journalPath, 'utf8');
  const torn = '{"storeId":"unfinished-entry';
  await appendFile(store.journalPath, torn);
  const restored = await open(root);
  assert.deepEqual((await restored.read()).records, [{ id: 'durably-acknowledged' }]);
  const evidence = (await readdir(root)).filter(name => name.startsWith(path.basename(store.journalPath) + '.torn-'));
  assert.equal(evidence.length, 1);
  assert.ok((await readFile(path.join(root, evidence[0]), 'utf8')).includes(torn), 'torn bytes must remain recoverable');
  assert.equal(await readFile(store.journalPath, 'utf8'), complete);
  await restored.update(value => { value.records.push({ id: 'after-recovery' }); });
  assert.deepEqual((await (await open(root)).read()).records.map(r => r.id), ['durably-acknowledged', 'after-recovery']);
});

for (const corruption of ['sequence', 'previous-hash', 'checksum', 'complete-invalid-json']) {
  test(`fresh replay fails closed on ${corruption} corruption, including freshly recomputed checksums`, async t => {
    const root = await directory(t), store = await open(root);
    await store.update(value => { value.records.push({ id: 'one' }); });
    const original = await readFile(store.journalPath, 'utf8');
    const lines = original.trimEnd().split('\n');
    const entry = JSON.parse(lines[1]);
    if (corruption === 'sequence') lines[1] = JSON.stringify(signed({ ...entry, seq: entry.seq + 2 }));
    if (corruption === 'previous-hash') lines[1] = JSON.stringify(signed({ ...entry, previousHash: `${entry.previousHash[0] === '0' ? '1' : '0'}${entry.previousHash.slice(1)}` }));
    if (corruption === 'checksum') lines[1] = JSON.stringify({ ...entry, checksum: '0'.repeat(64) });
    if (corruption === 'complete-invalid-json') lines[1] = '{"storeId":\n';
    await writeFile(store.journalPath, lines.join('\n') + '\n');
    await assert.rejects(open(root), 'a damaged complete record must not be dropped as a harmless tail');
    assert.equal((await readdir(root)).some(name => name.includes('.torn-')), false);
  });
}

test('an external live WAL append fences both reads and later writes rather than acknowledging over it', async t => {
  const root = await directory(t), store = await open(root);
  await store.update(value => { value.records.push({ id: 'first' }); });
  await appendFile(store.journalPath, '{"untrusted":"external append"}\n');
  await assert.rejects(store.assertUnchanged());
  await assert.rejects(store.read());
  await assert.rejects(store.update(value => { value.records.push({ id: 'must-not-ack' }); }));
  assert.equal((await readFile(store.journalPath, 'utf8')).includes('must-not-ack'), false);
});

test('missing initialized WAL is not silently recreated when acknowledged commits exceed snapshot sequence zero', async t => {
  const root = await directory(t), store = await open(root);
  await store.update(value => { value.records.push({ id: 'acknowledged-only-in-WAL' }); });
  const snapshot = JSON.parse(await readFile(store.filePath, 'utf8'));
  assert.equal(snapshot.seq, 0);
  assert.equal(snapshot.journalReady, true);
  await unlink(store.journalPath);
  await assert.rejects(open(root), 'a snapshot at sequence zero does not prove that no WAL commits existed');
});

for (const stage of ['afterSnapshotCommit', 'beforeJournalReset']) {
  test(`snapshot/WAL handoff restart preserves committed effects after a ${stage} interruption`, async t => {
    const root = await directory(t); let armed = false;
    const store = await open(root, { fault: async current => { if (armed && current === stage) throw new Error(`fault:${stage}`); } });
    await store.update(value => { value.records.push({ id: 'effect-evidence', delivered: true }); });
    armed = true;
    await assert.rejects(store.compact(), new RegExp(`fault:${stage}`));
    const firstRestart = await open(root);
    assert.deepEqual((await firstRestart.read()).records, [{ id: 'effect-evidence', delivered: true }]);
    await firstRestart.update(value => { value.records.push({ id: 'next-record' }); });
    await firstRestart.compact();
    const secondRestart = await open(root);
    assert.deepEqual((await secondRestart.read()).records.map(r => r.id), ['effect-evidence', 'next-record']);
    const snapshot = JSON.parse(await readFile(secondRestart.filePath, 'utf8'));
    assert.equal(snapshot.seq, 2, 'old WAL entries must not be applied as new commits after snapshot handoff');
  });
}

for (const faultStage of ['beforeAppendSync', 'beforeAppendClose']) test(`failed WAL ${faultStage} yields no ACK; restart treats a physically complete initiation as unknown and refuses replay`, async t => {
  const root = await directory(t), stateDir = path.join(root, 'operations');
  const store = new OperationsStore({ stateDir, journalOptions: { fault: async stage => { if (stage === faultStage) throw new Error('injected WAL commit failure'); } } });
  await store.init();
  let effects = 0;
  await assert.rejects((async () => {
    await store.update(value => {
      value.operations.push({ id: 'op-uncertain', taskId: 'old-worker', status: 'running', pending: 'cmd-uncertain',
        authorization: { scope: 'profile', version: 1, accountId: 'profile:test', resourceIds: ['*'], origins: ['*'], allowedActions: ['*'], expiresAt: null, revokedAt: null },
        browserSelection: { kind: 'profile', profileId: 'test' }, counters: { runs: 0 }, budgets: {}, mode: 'operations', manualLock: false });
      value.commands.push({ operationId: 'op-uncertain', commandId: 'cmd-uncertain', status: 'pending', delivered: true });
      value.actions.push({ operationId: 'op-uncertain', commandId: 'cmd-uncertain', actionId: 'action-uncertain', status: 'initiated', effect: true });
    });
    effects++; // Actual effect code may run only after the persistence promise ACKs.
  })(), /injected WAL commit failure/u);
  assert.equal(effects, 0);
  await assert.rejects(store.update(() => {}), 'a failed append must fence the live instance');
  const fresh = await new OperationsStore({ stateDir }).init();
  await fresh.recover();
  const recovered = await fresh.read();
  assert.equal(recovered.actions[0].status, 'unknown');
  assert.equal(recovered.operations[0].status, 'reconcile-required');
  assert.equal(recovered.operations[0].pending, null);
  let launched = 0;
  const service = await createOperationsService({ stateDir: root, tickMs: 60000,
    profileStore: {}, taskService: { createOperation: async () => { launched++; throw new Error('must not launch'); }, setOperationDurableHandler() {}, setOperationReadyHandler() {} } });
  t.after(() => service.close());
  await assert.rejects(service.command('op-uncertain', { commandId: 'replacement-must-not-replay', kind: 'batch', payload: { actions: [{ type: 'click', target: { selector: '#submit' } }] } }),
    error => error.code === 'OPERATION_NOT_RUNNING' || error.code === 'RECONCILIATION_REQUIRED');
  assert.equal(launched, 0);
  assert.equal(effects, 0);
});
