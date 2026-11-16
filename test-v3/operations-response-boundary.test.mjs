import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/contracts.mjs';
import { createManager } from '../src/manager.mjs';
import { parseOperationsReplyDetail } from '../src/cli.mjs';
import { managerStateId } from '../src/lib/manager-state.mjs';
import { OperationsStore } from '../src/lib/operations-store.mjs';
import { createOperationsService, operationsReplyDetail } from '../src/runtime/operations-service.mjs';
import { removeTestTree } from './test-fs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(t) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'etm-response-boundary-'));
  const tasks = new Map(); let ready, created = 0, reads = 0;
  const taskService = {
    createOperation: async () => { const task = { id: `worker-${++created}`, state: 'waiting', waiting: { id: `wait-${created}`, reason: 'operations-command' } }; tasks.set(task.id, task); return task; },
    get: async id => { reads++; return tasks.get(id); },
    resume: async id => { tasks.get(id).state = 'running'; }, stop: async id => { tasks.get(id).state = 'stopped'; },
    operationControl: async () => true, setOperationDurableHandler() {}, setOperationReadyHandler: value => { ready = value; }
  };
  const service = await createOperationsService({ stateDir, taskService, profileStore: { getDefault: async () => ({ id: 'profile-unit', modePolicy: 'auto' }) }, tickMs: 60000 });
  t.after(async () => { await service.close(); await removeTestTree(stateDir); });
  return { service, tasks, stateDir, ready: id => ready?.(id), reads: () => reads };
}
const scene = text => ({ pageId: 'page-unit', pageVersion: '1:unit-document:7', url: 'http://localhost/unit', title: 'Unit editor',
  items: [{ ref: 'r1', selector: 'html > body:nth-of-type(1) > button:nth-of-type(1)', tag: 'button', role: 'button', text, disabled: false, checked: false }],
  total: 1, offset: 0, omitted: { before: 0, after: 0, textCharacters: 0 }, continuation: null });
async function seedHistory(service, id, count = 24) {
  await service.store.update(data => {
    for (let index = 0; index < count; index++) data.commands.push({ operationId: id, commandId: `old-${index}`, status: 'confirmed', delivered: true,
      envelope: { kind: 'observe' }, createdAt: new Date().toISOString(), reply: { commandId: `old-${index}`, status: 'confirmed', result: { observation: scene(`Retained evidence ${index}`) } } });
    data.records.push({ operationId: id, id: 'business', result: 'retained business evidence' });
    data.actions.push({ operationId: id, actionId: 'unknown-save', commandId: 'uncertain', status: 'unknown', effect: true,
      authorizationVersion: 1, pageId: 'page-unit', pageVersion: '1:unit-document:5', expected: { text: 'server result' } });
  });
}

test('compact operation reads return receipt summaries without loading histories; explicit full retains complete evidence', async t => {
  const { service } = await fixture(t), operation = await service.start({ goal: 'Response boundary' });
  await seedHistory(service, operation.id);
  let hydrated = 0; const hydrate = service.store.hydrateCommands.bind(service.store);
  service.store.hydrateCommands = async records => { hydrated += records.length; return hydrate(records); };
  const compact = await service.get(operation.id, { detail: 'compact' });
  assert.equal(hydrated, 0, 'status summaries must not read old cold replies');
  assert.equal(compact.commands.length, 1); assert.equal(compact.commands[0].commandId, 'old-23');
  assert.equal(compact.commands[0].reply, undefined); assert.match(compact.commands[0].fullEvidence, /--command old-23 --detail full/u);
  assert.equal(compact.omitted.otherCommandCount, 23); assert.equal(compact.omitted.businessRecordCount, 1);
  assert.equal(compact.unresolvedActions.length, 1); assert.equal(compact.unresolvedActions[0].actionId, 'unknown-save');
  assert.equal(compact.unresolvedActionCount, 1);
  assert.equal(compact.unresolvedActions[0].authorizationVersion, 1);
  const full = await service.get(operation.id);
  assert.equal(full.commands.length, 24); assert.equal(full.records[0].result, 'retained business evidence');
  assert.equal(full.commands[0].reply.result.observation.items[0].selector, scene('').items[0].selector);
  const selected = await service.get(operation.id, { commandId: 'old-3', detail: 'compact' });
  assert.equal(selected.command.reply.result.observation.items[0].selector, undefined);
  assert.equal(selected.command.reply.result.observation.items[0].name, 'Retained evidence 3');
  assert.equal((await service.get(operation.id, { commandId: 'old-3', detail: 'full' })).command.reply.result.observation.items[0].selector, scene('').items[0].selector);
});

test('waitCommand, events, ready and idle tick use fenced projections rather than whole hydrated store reads', async t => {
  const f = await fixture(t), operation = await f.service.start({ goal: 'Projected paths' });
  await seedHistory(f.service, operation.id, 2);
  f.service.store.read = async () => assert.fail('unrelated historical replies must not be read');
  const before = f.reads();
  const reply = await f.service.waitCommand(operation.id, 'old-0', 0, { detail: 'compact' });
  assert.equal(reply.status, 'confirmed'); assert.equal(f.reads(), before, 'a receipt wait does not need a full task read');
  assert.equal((await f.service.events(operation.id)).events.length, 0);
  await f.ready(operation.taskId); await f.service.tick();
  assert.equal(f.reads(), before, 'no pending command means no delivery task lookup');
  assert.equal((await f.service.get(operation.id, { detail: 'compact' })).status, 'running');
});

for (const status of ['confirmed', 'unknown']) test(`post-commit compact budget failure preserves the actual ${status} receipt and exact full retrieval`, async t => {
  const { service } = await fixture(t), operation = await service.start({ goal: 'Irreducible response' });
  const record = await service.command(operation.id, { commandId: `large-${status}`, kind: 'observe' });
  const text = 'irreducible-safety-context '.repeat(1000);
  await service.durable(operation.taskId, 'command-result', { commandId: record.commandId, status, result: { safetyContext: text }, needsDecision: status === 'unknown' });
  const compact = await service.commandReply(operation.id, record, { waitMs: 0, detail: 'compact' });
  assert.equal(compact.commandId, record.commandId); assert.equal(compact.status, status);
  assert.equal(compact.needsDecision, true); assert.equal(compact.reason, 'OUTPUT_CONTEXT_INSUFFICIENT');
  assert.equal(compact.fullReceiptRequired, true); assert.match(compact.fullReceipt.command, new RegExp(`--command ${record.commandId} --detail full`, 'u'));
  const full = await service.get(operation.id, { commandId: record.commandId, detail: 'full' });
  assert.equal(full.command.status, status); assert.equal(full.command.reply.result.safetyContext, text);
});

test('a committed cold receipt hydration fault keeps its original status/code, fences automation and never advertises currently readable evidence', async t => {
  const { service, stateDir } = await fixture(t), operation = await service.start({ goal: 'Cold read fault boundary' });
  const record = await service.command(operation.id, { commandId: 'cold-committed', kind: 'observe' });
  const text = 'original cold evidence '.repeat(300);
  await service.durable(operation.taskId, 'command-result', { commandId: record.commandId, status: 'confirmed', result: { safetyContext: text } });
  assert.ok(await service.store.project(data => data.commands.find(item => item.commandId === record.commandId).replyRef));
  const read = service.store.evidence.read.bind(service.store.evidence);
  service.store.evidence.read = async () => { throw Object.assign(new Error('Injected first cold read failure'), { code: 'OPERATIONS_EVIDENCE_INVALID', statusCode: 409 }); };
  const receipt = await service.commandReply(operation.id, record, { waitMs: 0, detail: 'compact' });
  assert.equal(receipt.commandId, record.commandId); assert.equal(receipt.status, 'confirmed');
  assert.equal(receipt.statusSource, 'committed-command-metadata'); assert.equal(receipt.reason, 'COMMAND_RECEIPT_UNAVAILABLE');
  assert.equal(receipt.needsDecision, true); assert.equal(receipt.receiptUnavailable, true); assert.equal(receipt.evidenceAvailable, false);
  assert.equal(receipt.storageFailure.code, 'OPERATIONS_EVIDENCE_INVALID'); assert.equal(receipt.storageRecovery.code, 'OPERATIONS_EVIDENCE_INVALID');
  assert.equal(receipt.storageRecovery.automationMayProceed, false); assert.equal(receipt.storageRecovery.retryCommand, false);
  assert.equal(receipt.fullReceipt, undefined, 'an unreadable file is not a promise that full retrieval currently works');
  await assert.rejects(service.command(operation.id, { commandId: 'must-not-run', kind: 'observe' }), { code: 'STATE_STORE_EXTERNALLY_MODIFIED' });
  service.store.evidence.read = read;
  const reopened = await new OperationsStore({ stateDir: path.join(stateDir, 'operations') }).init();
  const truth = (await reopened.read()).commands.find(item => item.commandId === record.commandId);
  assert.equal(truth.status, 'confirmed'); assert.equal(truth.reply.result.safetyContext, text);
  assert.equal(truth.reply.receiptUnavailable, undefined, 'presentation failure must not overwrite durable success');
});

test('compact event pages retain every event and full payload through their returned cursors', async t => {
  const { service } = await fixture(t), operation = await service.start({ goal: 'Event pagination' });
  await service.store.update(data => {
    for (let index = 1; index <= 20; index++) data.events.push({ id: `event-${index}`, operationId: operation.id, sequence: index, state: 'pending', type: 'decision', priority: 'normal', summary: 'Read real context', payload: { text: 'x'.repeat(1200) }, expiresAt: new Date(Date.now() + 60000).toISOString() });
    data.eventSequence = 20;
  });
  const all = []; let after = 0;
  for (let page = 0; page < 20; page++) {
    const reply = await service.events(operation.id, { after, detail: 'compact' });
    if (!reply.events.length) break;
    assert.equal(reply.pending, 20);
    for (const event of reply.events) { assert.equal(event.payload.text.length, 1200); all.push(event.id); }
    assert.ok(reply.nextCursor > after); after = reply.nextCursor;
  }
  assert.deepEqual(all, Array.from({ length: 20 }, (_, index) => `event-${index + 1}`));
  assert.equal((await service.events(operation.id, { detail: 'full' })).events.length, 20);
});

test('compact stop results remain small while explicit full still exposes historical receipts', async t => {
  const { service } = await fixture(t), operation = await service.start({ goal: 'Stop result' });
  await seedHistory(service, operation.id);
  const compact = await service.action(operation.id, { action: 'stop' }, { detail: 'compact' });
  assert.equal(compact.status, 'stopped'); assert.equal(compact.commands.length, 1);
  assert.equal(compact.unresolvedActions[0].status, 'unknown');
  assert.equal(compact.omitted.otherCommandCount, 23);
  assert.equal((await service.get(operation.id, { detail: 'full' })).commands.length, 24);
});

test('operation overflow fallback retains bounded Profile/current authorization state and explicitly requires full reads for omitted limits', async t => {
  const { service } = await fixture(t), operation = await service.start({ goal: 'Overflow Profile identity' });
  const expiresAt = new Date(Date.now() + 60000).toISOString(), revokedAt = new Date().toISOString();
  await service.store.update(data => {
    const current = data.operations.find(item => item.id === operation.id);
    current.profileName = 'Selected overflow Profile'; current.status = 'revoked'; current.manualLock = true;
    Object.assign(current.authorization, { accountId: 'current-account', version: 7, expiresAt, revokedAt,
      limits: { fields: Array.from({ length: 120 }, (_, index) => `approved-${index}-${'x'.repeat(60)}`) } });
  });
  const compact = await service.get(operation.id, { detail: 'compact' });
  assert.equal(compact.reason, 'OUTPUT_CONTEXT_INSUFFICIENT'); assert.equal(compact.needsDecision, true);
  assert.deepEqual(compact.browserSelection, { kind: 'profile', profileId: 'profile-unit' });
  assert.equal(compact.profileName, 'Selected overflow Profile'); assert.equal(compact.accountId, 'current-account');
  assert.equal(compact.authorizationVersion, 7); assert.equal(compact.authorizationScope, 'profile');
  assert.equal(compact.authorizationExpiresAt, expiresAt); assert.equal(compact.authorizationRevokedAt, revokedAt);
  assert.equal(compact.status, 'revoked'); assert.equal(compact.manualLock, true);
  assert.equal(compact.authorizationLimits, undefined); assert.deepEqual(compact.missingContext, { fields: ['authorizationLimits'], fullReadRequired: true });
  assert.equal(compact.fullReceiptRequired, true); assert.match(compact.fullReceipt.command, /--detail full$/u);
  const full = await service.get(operation.id, { detail: 'full' });
  assert.equal(full.authorization.limits.fields.length, 120); assert.equal(full.authorization.version, 7);
});

test('response detail validation is explicit and envelope overrides never modify the command identity', () => {
  for (const value of ['compact', 'full']) assert.equal(parseOperationsReplyDetail(value), value);
  for (const value of ['', true, 'summary', 1]) assert.throws(() => parseOperationsReplyDetail(value), { code: 'INVALID_REPLY_DETAIL' });
  const command = { commandId: 'original', kind: 'observe', payload: { observation: { detail: 'full' } } };
  const original = structuredClone(command);
  assert.equal(operationsReplyDetail('compact', command), 'full'); assert.deepEqual(command, original);
  assert.equal(operationsReplyDetail('full', { payload: { detail: 'compact', observation: { detail: 'full' } } }), 'compact');
  assert.throws(() => operationsReplyDetail('compact', { payload: { detail: 'invalid' } }), { code: 'INVALID_REPLY_DETAIL' });
});

test('actual Manager operations routes keep compact/full detail outside reservation identity and reject invalid detail before admission', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etm-response-routes-')), tasks = new Map();
  let manager, created = 0, resumed = 0;
  const taskService = {
    createOperation: async () => { const task = { id: `route-worker-${++created}`, state: 'waiting', waiting: { id: 'route-wait', reason: 'operations-command' } }; tasks.set(task.id, task); return task; },
    get: async id => tasks.get(id), stop: async id => { tasks.get(id).state = 'stopped'; }, operationControl: async () => true,
    setOperationDurableHandler() {}, setOperationReadyHandler() {}, close: async () => {},
    resume: async (id, command) => {
      resumed++;
      await manager.operationsService.durable(id, 'command-result', { commandId: command.commandId, status: 'confirmed',
        result: command.payload?.large ? { safetyContext: 'must remain retrievable '.repeat(1000) } : { observation: scene('Actual route response') } });
      tasks.get(id).state = 'waiting';
    }
  };
  manager = await createManager({ dataDir: directory, port: 0, taskServiceFactory: async () => taskService });
  t.after(async () => { await manager.stop(); await removeTestTree(directory); });
  await manager.start();
  const profile = await manager.profileStore.create({ name: 'No browser route unit' });
  const { managerToken } = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8'));
  const request = async (suffix, body) => {
    const response = await fetch(`${manager.baseUrl}/v1/operations${suffix}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${managerToken}`, 'x-taskmaster-runtime-version': VERSION, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { code: response.status, value: await response.json() };
  };
  const started = await request('', { profileId: profile.id, goal: 'Route boundary unit' });
  assert.equal(started.code, 201); assert.equal(started.value.operation.authorization, undefined);
  assert.deepEqual(started.value.operation.browserSelection, { kind: 'profile', profileId: profile.id });
  assert.equal(started.value.operation.profileName, 'No browser route unit');
  assert.equal(started.value.operation.authorizationScope, 'profile');
  const id = started.value.operation.id, body = { commandId: 'route-read', kind: 'observe' };
  const invalid = await request(`/${id}/commands?waitMs=1000&detail=invalid`, body);
  assert.equal(invalid.code, 400); assert.equal(invalid.value.error.code, 'INVALID_REPLY_DETAIL');
  const invalidOverride = await request(`/${id}/commands?waitMs=1000&detail=full`, { ...body, payload: { detail: 'invalid' } });
  assert.equal(invalidOverride.code, 400); assert.equal(invalidOverride.value.error.code, 'INVALID_REPLY_DETAIL');
  assert.equal((await manager.operationsService.get(id)).commands.length, 0);
  const compact = await request(`/${id}/commands?waitMs=1000`, body);
  assert.equal(compact.code, 200); assert.equal(compact.value.command.status, 'confirmed');
  assert.equal(compact.value.command.result.observation.items[0].selector, undefined);
  const full = await request(`/${id}/commands?waitMs=1000&detail=full`, body);
  assert.equal(full.value.command.result.observation.items[0].selector, scene('').items[0].selector);
  assert.equal(resumed, 1, 'requesting full detail must reuse the committed receipt without dispatching again');
  const override = await request(`/${id}/commands?waitMs=1000&detail=compact`, { commandId: 'route-full', kind: 'observe', payload: { detail: 'full' } });
  assert.equal(override.value.command.result.observation.items[0].selector, scene('').items[0].selector);
  const selected = await request(`/${id}?commandId=route-read&detail=full`);
  assert.equal(selected.value.operation.command.reply.result.observation.items[0].selector, scene('').items[0].selector);
  const summary = await request(`/${id}`); assert.equal(summary.value.operation.commands.length, 1);
  assert.equal(summary.value.operation.commands[0].reply, undefined); assert.equal(summary.value.operation.omitted.otherCommandCount, 1);
  const audit = await request(`/${id}?detail=full`); assert.equal(audit.value.operation.commands.length, 2);
  const largeBody = { commandId: 'route-large', kind: 'observe', payload: { large: true } };
  const large = await request(`/${id}/commands?waitMs=1000`, largeBody);
  assert.equal(large.code, 200, 'a committed outcome must not look like a rejected unexecuted request');
  assert.equal(large.value.command.status, 'confirmed'); assert.equal(large.value.command.commandId, 'route-large');
  assert.equal(large.value.command.reason, 'OUTPUT_CONTEXT_INSUFFICIENT');
  assert.match(large.value.command.fullReceipt.path, /commandId=route-large&detail=full$/u);
  const actualLarge = await request(`/${id}?commandId=route-large&detail=full`);
  assert.equal(actualLarge.value.operation.command.reply.result.safetyContext.length, 'must remain retrievable '.repeat(1000).length);
  const originalHydrate = manager.operationsService.store.hydrateCommand.bind(manager.operationsService.store);
  const hydrationError = () => Object.assign(new Error('Injected cold evidence presentation failure'), { code: 'OPERATIONS_EVIDENCE_INVALID', statusCode: 409 });
  manager.operationsService.store.hydrateCommand = async record => { if (record.replyRef) throw hydrationError(); return originalHydrate(record); };
  const beforeDuplicate = resumed;
  const unavailableDuplicate = await request(`/${id}/commands?waitMs=1000&detail=full`, largeBody);
  assert.equal(unavailableDuplicate.code, 200); assert.equal(unavailableDuplicate.value.command.commandId, 'route-large');
  assert.equal(unavailableDuplicate.value.command.status, 'confirmed'); assert.equal(unavailableDuplicate.value.command.reason, 'COMMAND_RECEIPT_UNAVAILABLE');
  assert.equal(unavailableDuplicate.value.command.storageFailure.code, 'OPERATIONS_EVIDENCE_INVALID');
  assert.equal(unavailableDuplicate.value.command.evidenceAvailable, false); assert.equal(unavailableDuplicate.value.command.fullReceipt, undefined);
  assert.equal(resumed, beforeDuplicate, 'a failed old receipt read must not recreate/replay its Worker command');
  const generatedUnavailable = await request(`/${id}/commands?waitMs=1000`, { kind: 'observe', payload: { large: true } });
  assert.equal(generatedUnavailable.code, 200); assert.match(generatedUnavailable.value.command.commandId, /^cmd_/u);
  assert.equal(generatedUnavailable.value.command.status, 'confirmed'); assert.equal(generatedUnavailable.value.command.reason, 'COMMAND_RECEIPT_UNAVAILABLE');
  assert.equal(generatedUnavailable.value.command.storageFailure.code, 'OPERATIONS_EVIDENCE_INVALID');
  assert.equal(generatedUnavailable.value.command.storageRecovery.requiresOwnerRecovery, true);
  manager.operationsService.store.hydrateCommand = originalHydrate;
  const originalHydrateMany = manager.operationsService.store.hydrateCommands.bind(manager.operationsService.store);
  manager.operationsService.store.hydrateCommands = async () => { throw hydrationError(); };
  const failedRead = await request(`/${id}?commandId=route-large&detail=full`);
  assert.equal(failedRead.code, 409); assert.equal(failedRead.value.error.code, 'OPERATIONS_EVIDENCE_INVALID');
  assert.equal(failedRead.value.error.details.operationReceipt.commandId, 'route-large');
  assert.equal(failedRead.value.error.details.operationReceipt.status, 'confirmed');
  manager.operationsService.store.hydrateCommands = originalHydrateMany;
  const listed = await request(''); assert.equal(listed.value.operations[0].unresolvedActionCount, 0);
  assert.match(listed.value.operations[0].fullEvidence, /--detail full$/u);
  const stopped = await request(`/${id}/actions`, { action: 'stop' });
  assert.equal(stopped.value.result.status, 'stopped'); assert.equal(stopped.value.result.commands[0].reply, undefined);
});

async function cliFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etm-response-cli-')), token = 'r'.repeat(48), instance = 'response-instance-0000000001';
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ managerToken: token, stateInstanceId: instance }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/health') { res.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3, pid: 912346,
      stateId: managerStateId(instance, directory), stateChanged: false })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const item = { url: req.url, body: raw ? JSON.parse(raw) : null }; requests.push(item);
    res.end(JSON.stringify({ ok: true, command: { commandId: item.body?.commandId || 'receipt', status: 'confirmed' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await removeTestTree(directory); });
  const run = (args, input = null) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'src/cli.mjs'), 'ops', ...args, '--state-dir', directory, '--port', String(server.address().port), '--json'], {
      cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '',
        ERIC_TASK_MASTER_HOME: directory, ERIC_TASK_MASTER_AGENT_ID: 'response-cli-test', ERIC_TASK_MASTER_AGENT_SKILL_VERSION: VERSION, ERIC_TASK_MASTER_SKILL_DIR: path.join(ROOT, 'skills', 'eric-task-master') }
    });
    let stdout = '', stderr = ''; child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
  return { requests, run };
}

test('command and stream CLI carry response-only detail queries without rewriting common JSON envelopes', { timeout: 10000 }, async t => {
  const f = await cliFixture(t), body = { commandId: 'same-json', kind: 'observe', payload: {} };
  const one = await f.run(['command', 'op-unit', '--input', JSON.stringify(body), '--detail', 'full']);
  assert.equal(one.code, 0, one.stderr); assert.match(f.requests[0].url, /[?&]detail=full$/u); assert.deepEqual(f.requests[0].body, body);
  const stream = await f.run(['stream', 'op-unit', '--detail', 'full'], `${JSON.stringify(body)}\n`);
  assert.equal(stream.code, 0, stream.stderr); assert.match(f.requests[1].url, /[?&]detail=full$/u); assert.deepEqual(f.requests[1].body, body);
  const normal = await f.run(['command', 'op-unit', '--input', JSON.stringify(body)]);
  assert.equal(normal.code, 0, normal.stderr); assert.match(f.requests[2].url, /[?&]detail=compact$/u); assert.deepEqual(f.requests[2].body, body);
  const invalid = await f.run(['command', 'op-unit', '--input', JSON.stringify(body), '--detail', 'invalid']);
  assert.equal(invalid.code, 1); assert.equal(JSON.parse(invalid.stderr.trim()).error.code, 'INVALID_REPLY_DETAIL');
  assert.equal(f.requests.length, 3, 'invalid detail must not submit a command');
});
