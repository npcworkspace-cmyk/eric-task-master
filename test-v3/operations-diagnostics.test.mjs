import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOperationsDiagnostics } from '../src/lib/operations-diagnostics.mjs';
import { createFastSession } from '../src/runtime/fast-session.mjs';

test('diagnostic ring is bounded, detached and excludes input/message/page content', async () => {
  let clock = 0;
  const trace = createOperationsDiagnostics({ limit: 4, clock: () => ++clock });
  trace.mark('native-action', 'fail', { actionId: 'a1', code: 'DETACHED', message: 'SECRET', value: 'PASSWORD', url: 'private' });
  for (let index = 0; index < 8; index++) trace.mark('authority');
  const snapshot = trace.snapshot();
  assert.equal(snapshot.stages.length, 4); assert.equal(snapshot.dropped, 5);
  assert.equal(snapshot.phase, 'native-action'); assert.equal(snapshot.code, 'DETACHED');
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|PASSWORD|private/);
  snapshot.stages[0].stage = 'mutated'; assert.notEqual(trace.snapshot().stages[0].stage, 'mutated');
  const error = Object.assign(new Error('ORIGINAL'), { code: 'SYNTHETIC' });
  await assert.rejects(trace.measure('verification', () => Promise.reject(error)), (actual) => actual === error);
  assert.equal(trace.summary().phase, 'native-action', 'later diagnostic failure must not replace first failure');
});

test('session saves native-failure stage evidence without replay or private page content', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'etm-diagnostic-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const state = { pageId: 'page-1', pageVersion: '1:doc:1', url: 'http://fixture.test/', title: 'SECRET-PAGE-TEXT' };
  const authorization = { scope: 'profile', version: 1, accountId: 'profile:test', origins: ['*'], resourceIds: ['*'], allowedActions: ['*'] };
  let recorder, actions = 0;
  const records = [];
  const browser = { page: {}, unsafe: null, meta: async () => ({ ...state }),
    observe: async () => ({ ...state, items: [], total: 0 }), validateAction: async () => {}, condition: async () => true,
    setStageRecorder: (next) => { recorder = next; },
    act: async (action) => {
      actions++;
      recorder?.({ stage: 'native-action', event: 'begin', actionId: action.actionId, actionType: action.type });
      recorder?.({ stage: 'native-action', event: 'fail', actionId: action.actionId, actionType: action.type, code: 'DETACHED' });
      throw Object.assign(new Error('Synthetic native detachment'), { code: 'DETACHED' });
    }, dispose: async () => {} };
  const session = createFastSession({ page: browser.page, context: {}, browserAdapter: browser, outputDir,
    signal: new AbortController().signal, input: { operationId: 'op-test', authorization },
    durable: async (type, payload) => { records.push({ type, payload }); return type === 'authorize' ? { authorization } : { acknowledged: true }; } });
  t.after(() => session.dispose());
  const command = (commandId, kind, payload = {}) => ({ schemaVersion: 1, operationId: 'op-test', commandId, authorizationVersion: 1, ...state, kind, payload });
  const observed = await session.execute(command('observe-1', 'observe'));
  assert.equal(observed.diagnostics, undefined, 'successful ordinary replies do not carry diagnostic arrays');
  const reply = await session.execute(command('failed-1', 'batch', { preconditions: [], verify: [],
    actions: [{ actionId: 'open-1', type: 'click', effect: false, target: { selector: '#open' } }] }));
  assert.equal(reply.status, 'stopped'); assert.equal(actions, 1);
  assert.equal(reply.result.details.phase, 'native-action'); assert.equal(reply.diagnostics.phase, 'native-action');
  assert.equal(recorder, null); assert.equal(reply.diagnostics.stages, undefined);
  const evidence = JSON.parse(await readFile(path.join(outputDir, reply.diagnostics.evidenceRef), 'utf8'));
  assert.ok(evidence.stages.some((entry) => entry.stage === 'native-action' && entry.event === 'fail'));
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET-PAGE-TEXT|#open|http:|authorization/);
  assert.equal((await readdir(outputDir)).length, 1);
  assert.equal(records.filter((entry) => entry.type === 'command-result' && entry.payload.commandId === 'failed-1').length, 1);
});
