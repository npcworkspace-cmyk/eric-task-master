import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperationsService } from '../src/runtime/operations-service.mjs';
import { removeTestTree } from './test-fs.mjs';

async function setup(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-local-receipts-'));
  const tasks = new Map(); let sequence = 0;
  const service = await createOperationsService({ stateDir, tickMs: 60000,
    profileStore: { getDefault: async () => ({ id: 'isolated', modePolicy: 'auto' }) },
    taskService: { createOperation: async () => { const task = { id: `task-${++sequence}`, state: 'waiting', waiting: { reason: 'operations-command', id: 'wait' } }; tasks.set(task.id, task); return task; },
      get: async (id) => tasks.get(id), resume: async (id) => { tasks.get(id).state = 'running'; }, stop: async (id) => { tasks.get(id).state = 'stopped'; }, operationControl: async () => true,
      setOperationDurableHandler: () => {}, setOperationReadyHandler: () => {} } });
  t.after(async () => { await service.close(); await removeTestTree(stateDir); });
  const op = await service.start({ goal: 'Local preparation receipt tests', mode: 'operations' });
  const receipt = (commandId, actionId, kind, extra = {}) => ({ operationId: op.id, commandId, actionId, kind, effect: false,
    authorizationVersion: op.authorization.version, accountId: op.authorization.accountId, resourceId: 'http://local.test/page',
    pageId: 'page', pageVersion: '1:document:1', origin: 'http://local.test', status: 'confirmed', verification: { matched: true }, ...extra });
  return { service, op, tasks, receipt };
}

test('partial local facts and stopped command commit atomically without publishing internal receipts', async (t) => {
  const { service, op, tasks, receipt } = await setup(t);
  const actions = [{ actionId: 'one', type: 'fill', effect: false, target: { selector: '#draft' }, value: 'draft', expected: { target: { selector: '#draft' }, value: 'draft' } },
    { actionId: 'two', type: 'click', effect: false, target: { selector: '#preview' } }];
  await service.command(op.id, { commandId: 'local', kind: 'batch', payload: { actions } });
  await service.durable(op.taskId, 'authorize', { commandId: 'local', actionId: 'one', kind: 'fill', effect: false, localReceipt: true,
    accountId: op.authorization.accountId, resourceId: 'http://local.test/page', origin: 'http://local.test', authorizationVersion: 1 });
  await service.durable(op.taskId, 'command-result', { commandId: 'local', status: 'stopped', reason: 'ACTION_FAILED',
    localActions: [receipt('local', 'one', 'fill'), receipt('local', 'two', 'click', { status: 'failed' })] });
  const saved = await service.get(op.id);
  assert.deepEqual(saved.actions.map((item) => [item.actionId, item.status, item.effect, item.localReceipt]), [['one', 'confirmed', false, true], ['two', 'failed', false, true]]);
  assert.deepEqual(saved.completedActionIds, ['one']);
  assert.deepEqual(saved.actions[0].expected, actions[0].expected);
  assert.equal(saved.commands[0].reply.localActions, undefined);
  assert.equal(saved.commands[0].reply.status, 'stopped');
  tasks.get(op.taskId).state = 'waiting';
  await service.command(op.id, { commandId: 'different', kind: 'batch', payload: { actions: [actions[1]] } });
  for (const localReceipt of [undefined, true]) await assert.rejects(service.durable(op.taskId, 'authorize', { commandId: 'different', actionId: 'two', kind: 'click', effect: false, localReceipt,
    accountId: op.authorization.accountId, resourceId: 'http://local.test/page', origin: 'http://local.test', authorizationVersion: 1 }), { code: 'ACTION_ALREADY_INITIATED' });
});

test('local receipts cannot impersonate reserved external effects or exempt uploads', async (t) => {
  for (const action of [{ actionId: 'external', type: 'click' }, { actionId: 'upload', type: 'upload', effect: false }]) {
    const { service, op, receipt } = await setup(t);
    await service.command(op.id, { commandId: 'guarded', kind: 'batch', payload: { actions: [action] } });
    await assert.rejects(service.durable(op.taskId, 'command-result', { commandId: 'guarded', status: 'confirmed', localActions: [receipt('guarded', action.actionId, action.type)] }), { code: 'INVALID_LOCAL_RECEIPT' });
    assert.equal((await service.get(op.id)).actions.length, 0);
    assert.equal((await service.get(op.id)).commands[0].status, 'pending');
  }
});

test('receipt metadata mismatches and duplicate IDs reject the whole transaction', async (t) => {
  const { service, op, receipt } = await setup(t);
  await service.command(op.id, { commandId: 'metadata', kind: 'batch', payload: { actions: [{ actionId: 'local', type: 'fill', effect: false }, { actionId: 'other', type: 'click', effect: false }] } });
  for (const changed of [{ commandId: 'foreign' }, { operationId: 'foreign' }, { authorizationVersion: 2 }, { accountId: 'foreign' }, { pageId: '' }, { pageVersion: '' }, { origin: '' }, { effect: true }, { kind: 'click' }, { transport: { url: 'http://other' } }]) {
    await assert.rejects(service.durable(op.taskId, 'command-result', { commandId: 'metadata', status: 'confirmed', localActions: [receipt('metadata', 'local', 'fill', changed)] }), { code: 'INVALID_LOCAL_RECEIPT' });
  }
  const valid = receipt('metadata', 'local', 'fill');
  await assert.rejects(service.durable(op.taskId, 'command-result', { commandId: 'metadata', status: 'confirmed', localActions: [valid, valid] }), { code: 'INVALID_LOCAL_RECEIPT' });
  await assert.rejects(service.durable(op.taskId, 'command-result', { commandId: 'metadata', status: 'confirmed', localActions: [valid, receipt('metadata', 'other', 'click', { commandId: 'foreign' })] }), { code: 'INVALID_LOCAL_RECEIPT' });
  assert.equal((await service.get(op.id)).actions.length, 0);
});

test('recording already executed local facts after revocation never restores permission', async (t) => {
  const { service, op, receipt } = await setup(t);
  await service.command(op.id, { commandId: 'revoked', kind: 'batch', payload: { actions: [{ actionId: 'local', type: 'fill', effect: false }] } });
  await service.action(op.id, { action: 'revoke' });
  await service.durable(op.taskId, 'command-result', { commandId: 'revoked', status: 'stopped', localActions: [receipt('revoked', 'local', 'fill')] });
  const saved = await service.get(op.id);
  assert.equal(saved.status, 'revoked');
  assert.ok(saved.authorization.revokedAt);
  assert.equal(saved.authorization.version, 2);
  assert.equal(saved.actions[0].status, 'confirmed');
  await assert.rejects(service.command(op.id, { commandId: 'not-resumed', kind: 'batch', payload: { actions: [{ type: 'click', effect: false }] } }), { code: 'OPERATION_NOT_RUNNING' });
});
