import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OperationsStore } from '../src/lib/operations-store.mjs';
import { selectMode } from '../src/lib/operations-contracts.mjs';
import { removeTestTree } from './test-fs.mjs';

test('operations persist domain permissions but redact secrets before disk; recover without replay', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-ops-store-')); t.after(() => removeTestTree(stateDir));
  const store = await new OperationsStore({ stateDir }).init();
  await store.update((data) => {
    data.operations.push({ id: 'op1', status: 'running', authorization: { accountId: 'account', version: 1, diagnostics: { authorization: 'Basic NESTED_PERMISSION_BASIC_SENTINEL' } }, password: 'SECRET_SENTINEL', verificationCode: 'OTP_SENTINEL',
      diagnostics: { request: { authorization: 'Basic HTTP_BASIC_SENTINEL' }, headers: { Authorization: 'Basic HEADER_BASIC_SENTINEL' }, other: { Authorization: 'Basic MIXED_CASE_BASIC_SENTINEL' } } });
    data.actions.push({ actionId: 'write1', status: 'initiated', createdAt: new Date().toISOString() });
    data.commands.push({ commandId: 'cmd1', status: 'pending' });
  });
  const source = await readFile(path.join(stateDir, 'operations.json'), 'utf8');
  assert.equal(source.includes('SECRET_SENTINEL'), false);
  assert.equal(source.includes('OTP_SENTINEL'), false);
  for (const sentinel of ['HTTP_BASIC_SENTINEL', 'HEADER_BASIC_SENTINEL', 'MIXED_CASE_BASIC_SENTINEL', 'NESTED_PERMISSION_BASIC_SENTINEL']) assert.equal(source.includes(sentinel), false);
  assert.equal((await store.read()).operations[0].authorization.accountId, 'account');
  await store.recover();
  const recovered = await store.read(); assert.equal(recovered.operations[0].status, 'reconcile-required'); assert.equal(recovered.actions[0].status, 'unknown'); assert.equal(recovered.commands[0].status, 'unknown');
});

test('mode prompt overrides Profile default for one task; takeover is only a lock', () => {
  assert.deepEqual(selectMode(), { mode: 'batch', reason: 'script-default' });
  assert.equal(selectMode({ modePolicy: 'batch', mode: 'operations' }).mode, 'operations');
  assert.equal(selectMode({ modePolicy: 'operations', mode: 'batch' }).reason, 'task-intent');
  assert.equal(selectMode({ modePolicy: 'operations' }).mode, 'operations');
  assert.equal(selectMode({ modePolicy: 'auto', skillMode: 'operations' }).mode, 'operations');
  assert.equal(selectMode({ modePolicy: 'auto', intent: 'follow-up' }).mode, 'operations');
  assert.deepEqual(selectMode({ mode: 'batch', manualLock: true }), { mode: 'batch', reason: 'task-intent', automationPaused: true });
  assert.throws(() => selectMode({ mode: 'manual' }), { code: 'INVALID_MODE' });
});

test('pending safety evidence is never evicted to evade store limits', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-ops-limit-')); t.after(() => removeTestTree(stateDir));
  const store = await new OperationsStore({ stateDir, maxRecords: 1 }).init();
  await store.update((data) => { data.events.push({ id: 'safety', state: 'pending' }); });
  await assert.rejects(store.update((data) => { data.events.push({ id: 'other', state: 'pending' }); }), { code: 'OPERATIONS_STORAGE_LIMIT' });
  assert.equal((await store.read()).events[0].id, 'safety');
});
