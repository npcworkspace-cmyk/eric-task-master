import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { validateConfig, receiveEvent, validateDecision, decisionSchema, codexArguments } from '../scripts/codex-host-adapter.mjs';
import { removeTestTree } from './test-fs.mjs';

function config(root) { return validateConfig({ schemaVersion: 1, enabled: true, operationId: 'op_' + 'a'.repeat(32), stateDir: path.join(root, 'state'), evidenceDir: path.join(root, 'evidence'), workingDirectory: root,
  codexExecutable: path.join(root, 'codex.exe'), taskmasterNode: process.execPath, taskmasterCli: path.join(root, 'cli.mjs'), allowedObserveScopes: ['#status'], maxModelCalls: 3, timeoutMs: 120000, model: 'gpt-6.1-sol' }); }

test('config fails closed on missing explicit paths, scope, enabled flag and model-call bounds', () => {
  const c = config(path.resolve('adapter-unit-only'));
  for (const change of [{ enabled: false }, { stateDir: 'relative' }, { allowedObserveScopes: [] }, { maxModelCalls: 4 }, { maxModelCalls: 0 }, { timeoutMs: 300001 }]) assert.throws(() => validateConfig({ ...c, ...change }));
  const args = codexArguments(c, path.resolve('schema.json'), path.resolve('decision.json'));
  for (const flag of ['--ephemeral', '--json', '--skip-git-repo-check', '--ignore-user-config', '--output-schema', '--output-last-message']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only'); assert.equal(args.at(-1), '-'); assert.ok(!args.some((arg) => arg.includes('dangerously')));
  assert.equal(decisionSchema(c).additionalProperties, false);
});

test('concurrent duplicate receipt and lost receipt retry persist once, keep stable delivery and never relaunch', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'etm-codex-adapter-')); t.after(() => removeTestTree(root)); const c = config(root);
  const event = { id: 'event:windows-safe', operationId: c.operationId, type: 'scheduled', payload: { summary: 'untrusted page text' } };
  let launches = 0; const launch = async () => { launches++; };
  const results = await Promise.all(Array.from({ length: 5 }, () => receiveEvent(c, event, { launch })));
  assert.equal(launches, 1); assert.equal(results.filter((row) => row.owner).length, 1);
  const duplicate = await receiveEvent(c, event, { launch }); assert.deepEqual(duplicate.receipt, results[0].receipt); assert.equal(launches, 1);
  assert.equal(JSON.parse(await readFile(path.join(duplicate.directory, 'status.json'), 'utf8')).handled, false, 'Receipt is not a semantic decision or handled event');
  await assert.rejects(receiveEvent({ ...c, model: 'other' }, event, { launch }), { code: 'DUPLICATE_EVENT_CONFIG_CONFLICT' });
  await writeFile(path.join(c.evidenceDir, 'STOP'), 'stop'); await assert.rejects(receiveEvent(c, event, { launch }), { code: 'ADAPTER_STOPPED' });
  await assert.rejects(receiveEvent(c, { ...event, operationId: 'other' }, { launch }), { code: 'EVENT_SCOPE_MISMATCH' });
});

test('decision validation permits only authorized fixed read scopes or explicit safe stop, never mutation/replay', () => {
  const c = config(path.resolve('adapter-unit-only')); const event = { id: 'e1' };
  const operation = { status: 'running', pending: null, manualLock: false, authorization: { version: 1 }, actions: [] };
  const decision = { schemaVersion: 1, eventId: event.id, operationId: c.operationId, authorizationVersion: 1, disposition: 'observe', summary: 'Agent chooses bounded read-only continuation', scope: '#status' };
  assert.equal(validateDecision(decision, c, event, operation), decision);
  for (const change of [{ disposition: 'batch' }, { scope: 'body' }, { eventId: 'other' }, { authorizationVersion: 2 }, { summary: '' }, { command: { kind: 'batch' } }]) assert.throws(() => validateDecision({ ...decision, ...change }, c, event, operation));
  for (const change of [{ pending: 'busy' }, { status: 'paused' }, { manualLock: true }, { actions: [{ status: 'unknown' }] }]) assert.throws(() => validateDecision(decision, c, event, { ...operation, ...change }));
  const stop = { ...decision, disposition: 'stop', scope: '' }; assert.equal(validateDecision(stop, c, event, { ...operation, status: 'paused', actions: [{ status: 'unknown' }] }), stop);
});
