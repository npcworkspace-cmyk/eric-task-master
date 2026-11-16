import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperationsService } from '../src/runtime/operations-service.mjs';
import { createFastSession } from '../src/runtime/fast-session.mjs';
import { removeTestTree } from './test-fs.mjs';

test('lost Worker ACK cannot overwrite a Manager-committed local command result or replay it', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etm-local-result-ack-'));
  let task;
  const taskService = { createOperation: async body => (task = { id: 'task-1', state: 'waiting', waiting: { reason: 'operations-command', id: 'wait-1' }, input: body.input }),
    get: async () => task, resume: async () => { task.state = 'running'; }, stop: async () => { task.state = 'stopped'; }, setOperationDurableHandler() {} };
  const service = await createOperationsService({ stateDir: directory, taskService,
    profileStore: { getDefault: async () => ({ id: 'test-profile', modePolicy: 'auto' }) }, tickMs: 60000 });
  let session;
  t.after(async () => { await session?.dispose(); await service.close(); await removeTestTree(directory); });
  const operation = await service.start({ goal: 'Local result ACK integration', mode: 'operations' });
  const state = { pageId: 'page-1', pageVersion: '1:doc-1:1', url: 'http://fixture.test/editor', title: 'fixture' };
  let effects = 0, finalResultCalls = 0;
  const browser = { page: {}, unsafe: null, meta: async () => ({ ...state }), observe: async () => ({ ...state, items: [], total: 0 }), condition: async () => true,
    act: async () => { effects += 1; }, dispose: async () => {} };
  session = createFastSession({ page: browser.page, browserAdapter: browser, signal: new AbortController().signal, input: task.input,
    durable: async (type, payload) => {
      const result = await service.durable(operation.taskId, type, payload);
      if (type === 'command-result' && payload.commandId === 'local-fill') { finalResultCalls += 1; throw new Error('Manager commit succeeded but Worker ACK was lost'); }
      return result;
    } });
  const reserve = async body => {
    task.state = 'waiting';
    await service.command(operation.id, { pageId: state.pageId, pageVersion: state.pageVersion, ...body });
    return (await service.get(operation.id)).commands.find(command => command.commandId === body.commandId).envelope;
  };
  await session.execute(await reserve({ commandId: 'observe', kind: 'observe', payload: {} }));
  const local = await reserve({ commandId: 'local-fill', kind: 'batch', payload: { actions: [{ actionId: 'fill-1', type: 'fill', effect: false, target: { selector: '#draft' }, value: 'draft' }] } });
  await assert.rejects(session.execute(local), { code: 'COMMAND_RESULT_UNKNOWN' });
  const persisted = await service.get(operation.id);
  const savedReply = persisted.commands.find(command => command.commandId === 'local-fill').reply;
  assert.equal(savedReply.status, 'confirmed');
  assert.equal(savedReply.localActions, undefined);
  assert.equal(persisted.actions.find(action => action.actionId === 'fill-1').localReceipt, true);
  assert.equal(persisted.completedActionIds.includes('fill-1'), true);
  await assert.rejects(session.execute({ ...local, commandId: 'do-not-continue' }), { code: 'COMMAND_RESULT_UNKNOWN' });
  assert.deepEqual((await service.get(operation.id)).commands.find(command => command.commandId === 'local-fill').reply, savedReply);
  assert.equal(finalResultCalls, 1);
  assert.equal(effects, 1);
});
