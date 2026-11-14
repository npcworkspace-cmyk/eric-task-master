import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperationsService } from '../src/runtime/operations-service.mjs';
import { operationsSchema } from '../src/lib/operations-schema.mjs';
import { validateFastCommand } from '../src/runtime/fast-session.mjs';
import { publicTask } from '../src/contracts.mjs';
import { removeTestTree } from './test-fs.mjs';

async function setup(t, options = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-ops-service-'));
  const tasks = new Map(); const resumes = []; const controls = []; let sequence = 0; let clock = Date.now();
  const taskService = { createOperation: async (body) => { const task = { id: `task${++sequence}`, state: 'waiting', waiting: { reason: 'operations-command', id: `wait${sequence}` }, input: body.input }; tasks.set(task.id, task); return task; },
    get: async (id) => tasks.get(id), resume: async (id, value, envelope) => { resumes.push({ id, value, envelope }); tasks.get(id).state = 'running'; },
    stop: async (id) => { tasks.get(id).state = 'stopped'; }, operationControl: async (id, control) => { controls.push({ id, control }); return control.action === 'cursor' ? { applied: true, cursorEnabled: control.visible } : true; },
    setOperationDurableHandler: () => {} };
  const profileStore = { get: async (id) => ({ id, modePolicy: 'auto' }) };
  const service = await createOperationsService({ stateDir, taskService, profileStore, now: () => clock, tickMs: 60000, ...options });
  t.after(async () => { await service.close(); await removeTestTree(stateDir); });
  const input = { goal: 'Local test', mode: 'operations', browserSelection: { kind: 'profile', profileId: 'explicit-test' },
    authorization: { accountId: 'account', resourceIds: ['resource'], origins: ['http://localhost:5555'], allowedActions: ['click', 'ads.adjust'], expiresAt: new Date(clock + 3600000).toISOString() } };
  return { service, stateDir, taskService, profileStore, tasks, resumes, controls, input, advance: (milliseconds) => { clock += milliseconds; } };
}

test('operation rejects implicit Profile fallback, persists commands, dispatches same worker once', async (t) => {
  const { service, input, resumes } = await setup(t);
  await assert.rejects(service.start({ ...input, browserSelection: undefined }), { code: 'BROWSER_ADAPTER_UNAVAILABLE' });
  const operation = await service.start(input);
  const command = { commandId: 'observe1', kind: 'observe', payload: {} };
  const first = await service.command(operation.id, command); assert.equal(first.status, 'pending'); assert.equal(resumes[0].id, operation.taskId);
  await service.command(operation.id, command); await service.tick(); assert.equal(resumes.length, 1);
  await assert.rejects(service.command(operation.id, { ...command, payload: { changed: true } }), { code: 'COMMAND_ID_CONFLICT' });
  await service.durable(operation.taskId, 'command-result', { commandId: 'observe1', status: 'confirmed', result: { text: 'summary' } });
  assert.equal((await service.get(operation.id)).pending, null);
});

test('durable initiated state precedes write, unknown blocks mutations and takeover retains mode', async (t) => {
  const { service, input, controls } = await setup(t); const operation = await service.start(input);
  await service.command(operation.id, { commandId: 'batch1', kind: 'batch', payload: { actions: [{ actionId: 'click1' }] } });
  const envelope = { commandId: 'batch1', actionId: 'click1', accountId: 'account', resourceId: 'resource', kind: 'click', authorizationVersion: 1, origin: 'http://localhost:5555' };
  assert.equal((await service.durable(operation.taskId, 'authorize', envelope)).authorization.version, 1);
  await service.durable(operation.taskId, 'action', { ...envelope, status: 'prepared' });
  await service.durable(operation.taskId, 'action', { ...envelope, status: 'initiated' });
  assert.equal((await service.store.read()).actions[0].status, 'initiated');
  await service.durable(operation.taskId, 'action', { ...envelope, status: 'unknown' });
  await service.durable(operation.taskId, 'command-result', { commandId: 'batch1', status: 'unknown' });
  await assert.rejects(service.command(operation.id, { commandId: 'batch2', kind: 'batch', payload: { actions: [{}] } }), { code: 'RECONCILIATION_REQUIRED' });
  await service.action(operation.id, { action: 'takeover' });
  const after = await service.get(operation.id); assert.equal(after.manualLock, true); assert.equal(after.mode, 'operations'); assert.equal(after.status, 'paused');
  await assert.rejects(service.action(operation.id, { action: 'resume' }), { code: 'RECONCILIATION_REQUIRED' }); assert.equal(controls[0].control.action, 'takeover');
});

test('event chain separates delivery receipt from handled decision; expired/revoked auth blocks', async (t) => {
  const { service, input, advance } = await setup(t); const operation = await service.start(input);
  const event = await service.durable(operation.taskId, 'event', { type: 'decision', dedupeKey: 'one', summary: 'Review now' });
  assert.equal((await service.durable(operation.taskId, 'event', { type: 'decision', dedupeKey: 'one' })).id, event.id);
  await assert.rejects(service.action(operation.id, { action: 'decide', eventId: event.id, summary: 'Decision', authorizationVersion: 1 }), { code: 'EVENT_NOT_RECEIVED' });
  await service.action(operation.id, { action: 'ack', eventId: event.id });
  assert.equal((await service.events(operation.id)).events[0].state, 'received');
  await service.action(operation.id, { action: 'decide', eventId: event.id, summary: 'Keep waiting', authorizationVersion: 1 });
  assert.equal((await service.events(operation.id)).events[0].state, 'handled');
  advance(3600001); await assert.rejects(service.command(operation.id, { commandId: 'expired', kind: 'observe' }), { code: 'AUTHORIZATION_INACTIVE' });
});

test('actual scheduler -> persisted event -> executable receipt -> explicit decision', async (t) => {
  let deliveries = 0;
  const { service, input, advance } = await setup(t, { hostDispatch: async (_adapter, event) => { deliveries += 1; return { accepted: true, eventId: event.id, deliveryId: 'receipt', received: true }; } });
  const operation = await service.start({ ...input, hostAdapter: { executable: process.execPath, args: [] }, schedule: { timezone: 'UTC', nextAt: new Date(Date.now() - 1000).toISOString(), intervalMs: 1000, maxRunsPerWindow: 1, misfire: 'once' } });
  await service.tick(); const event = (await service.events(operation.id)).events[0];
  assert.equal(event.state, 'received'); assert.equal(deliveries, 1);
  await service.action(operation.id, { action: 'decide', eventId: event.id, authorizationVersion: 1, summary: 'Inspect unchanged page', command: { commandId: 'scheduled-observe', kind: 'observe' } });
  assert.equal((await service.get(operation.id)).commands[0].commandId, 'scheduled-observe');
  advance(2000); await service.tick(); assert.equal(deliveries, 1);
});

test('restart of an idle session permits explicit resume while uncertain effects require readback', async (t) => {
  const { service, stateDir, taskService, profileStore, input, tasks } = await setup(t);
  const safetyConditions = { loginExpired: { target: { selector: '#login-expired' }, state: 'visible' } };
  const businessContext = { currency: { selector: '#currency', expected: 'USD' } };
  const idle = await service.start({ ...input, safetyConditions, businessContext, commandLimit: 2, showCursor: false }); tasks.get(idle.taskId).state = 'stopped';
  assert.deepEqual(idle.task.input.safetyConditions, safetyConditions);
  await service.close();
  const recovered = await createOperationsService({ stateDir, taskService, profileStore, tickMs: 60000 });
  t.after(() => recovered.close());
  assert.equal((await recovered.get(idle.id)).status, 'reconcile-required');
  await recovered.action(idle.id, { action: 'resume' });
  const resumed = await recovered.get(idle.id);
  assert.notEqual(resumed.taskId, idle.taskId); assert.equal(resumed.task.input.reconcileRequired, false);
  assert.deepEqual(resumed.task.input.safetyConditions, safetyConditions); assert.deepEqual(resumed.task.input.businessContext, businessContext); assert.equal(resumed.task.input.commandLimit, 2);
  assert.equal(resumed.task.input.showCursor, false); assert.equal(resumed.cursorEnabled, false);
  assert.equal(resumed.mode, 'operations'); assert.equal(resumed.status, 'running');
  await recovered.durable(resumed.taskId, 'command-result', { commandId: resumed.pending, status: 'confirmed' });
  tasks.get(resumed.taskId).state = 'waiting';
  const expected = { target: { selector: '#value' }, text: 'Actual value' };
  await recovered.command(idle.id, { commandId: 'uncertain-command', kind: 'batch', payload: { actions: [{ actionId: 'uncertain', expected }] } });
  const record = { commandId: 'uncertain-command', actionId: 'uncertain', authorizationVersion: 1, accountId: 'account', resourceId: 'resource', kind: 'click' };
  await recovered.durable(resumed.taskId, 'action', { ...record, status: 'prepared' });
  await recovered.durable(resumed.taskId, 'action', { ...record, status: 'initiated' });
  tasks.get(resumed.taskId).state = 'stopped'; await recovered.close();
  const uncertain = await createOperationsService({ stateDir, taskService, profileStore, tickMs: 60000 }); t.after(() => uncertain.close());
  await assert.rejects(uncertain.action(idle.id, { action: 'resume' }), { code: 'RECONCILIATION_REQUIRED' });
  await uncertain.command(idle.id, { commandId: 'readback', kind: 'reconcile', payload: { actionIds: ['uncertain'], verify: [expected] } });
  const readback = await uncertain.get(idle.id); assert.equal(readback.task.input.reconcileRequired, true);
  await uncertain.durable(readback.taskId, 'reconciliation', { commandId: 'readback', actionIds: ['uncertain'], result: { matched: true, verification: [expected], identity: { accountId: 'account', resourceId: 'resource' }, url: 'http://localhost:5555/resource' } });
  assert.equal((await uncertain.get(idle.id)).status, 'running');
  assert.equal((await uncertain.get(idle.id)).actions[0].status, 'confirmed');
});

test('resume IPC uncertainty releases reservation for read-only diagnosis without resending', async (t) => {
  const { service, input, taskService, tasks, resumes } = await setup(t);
  const operation = await service.start(input); const resume = taskService.resume; let attempts = 0;
  taskService.resume = async () => { attempts += 1; throw Object.assign(new Error('IPC acknowledgement lost'), { code: 'TASK_RESUME_UNCONFIRMED' }); };
  await service.command(operation.id, { commandId: 'uncertain-delivery', kind: 'observe' });
  const unknown = await service.get(operation.id); assert.equal(unknown.pending, null); assert.equal(unknown.commands[0].status, 'unknown');
  taskService.resume = resume; tasks.get(operation.taskId).state = 'waiting';
  await service.command(operation.id, { commandId: 'read-only-diagnosis', kind: 'observe' });
  assert.equal(attempts, 1); assert.equal(resumes.length, 1); assert.equal(resumes[0].value.commandId, 'read-only-diagnosis');
});

test('admission budget pauses durably; hard duration pauses an in-flight effect and watchers', async (t) => {
  const { service, input, controls, advance } = await setup(t);
  const zero = await service.start({ ...input, budgets: { maxRuns: 0 } });
  await assert.rejects(service.command(zero.id, { commandId: 'over-budget', kind: 'observe' }), { code: 'OPERATION_BUDGET_EXCEEDED' });
  assert.equal((await service.get(zero.id)).status, 'paused'); assert.equal((await service.get(zero.id)).pauseReason.code, 'OPERATION_BUDGET_EXCEEDED'); assert.equal(controls.at(-1).control.action, 'pause');
  const operation = await service.start({ ...input, budgets: { maxRuns: 1, maxDurationMs: 1000 } });
  await service.command(operation.id, { commandId: 'last-run', kind: 'batch', payload: { actions: [{ actionId: 'last-action', type: 'click' }] } });
  const request = { commandId: 'last-run', actionId: 'last-action', kind: 'click', accountId: 'account', resourceId: 'resource', origin: 'http://localhost:5555' };
  assert.equal((await service.durable(operation.taskId, 'authorize', request)).authorization.version, 1, 'last admitted run may still authorize its effects');
  await service.durable(operation.taskId, 'action', { ...request, status: 'prepared' });
  advance(1001);
  await assert.rejects(service.durable(operation.taskId, 'action', { ...request, status: 'initiated' }), { code: 'OPERATION_BUDGET_EXCEEDED' });
  const paused = await service.get(operation.id); assert.equal(paused.status, 'paused'); assert.equal(paused.actions[0].status, 'prepared');
  assert.equal(controls.at(-1).control.action, 'pause');
  await service.store.recover(); assert.equal((await service.get(operation.id)).status, 'paused', 'restart recovery must not clear a durable budget pause');
});

test('unfinished scheduled inspection coalesces; capacity exhaustion visibly pauses without deleting safety evidence', async (t) => {
  const { service, input, advance, controls } = await setup(t, { storeOptions: { maxRecords: 2 } });
  const operation = await service.start({ ...input, schedule: { timezone: 'UTC', nextAt: new Date(Date.now() - 1000).toISOString(), intervalMs: 1000, maxRunsPerWindow: 100, misfire: 'once' } });
  for (let count = 0; count < 10; count += 1) { advance(1001); await service.tick(); }
  let events = await service.events(operation.id); assert.equal(events.events.length, 1); assert.equal(events.events[0].coalescedTriggers, 10);
  await service.durable(operation.taskId, 'event', { type: 'safety', dedupeKey: 'safety', priority: 'safety' });
  await assert.rejects(service.durable(operation.taskId, 'event', { type: 'third', dedupeKey: 'capacity' }), { code: 'OPERATIONS_STORAGE_LIMIT' });
  const paused = await service.get(operation.id); assert.equal(paused.status, 'paused'); assert.equal(paused.storageFailure.code, 'OPERATIONS_STORAGE_LIMIT');
  events = await service.events(operation.id); assert.equal(events.events.length, 2); assert.ok(events.events.some((item) => item.type === 'safety')); assert.equal(controls.at(-1).control.reason, 'OPERATIONS_STORAGE_LIMIT');
});

test('reconciliation rejects foreign scope and unrelated conditions', async (t) => {
  const { service, input, tasks } = await setup(t); const operation = await service.start(input);
  const expected = { target: { selector: '#saved-value' }, text: 'new value' };
  await service.command(operation.id, { commandId: 'effect', kind: 'batch', payload: { actions: [{ actionId: 'write', expected }] } });
  const action = { commandId: 'effect', actionId: 'write', accountId: 'account', resourceId: 'resource', kind: 'click' };
  for (const status of ['prepared', 'initiated', 'unknown']) await service.durable(operation.taskId, 'action', { ...action, status });
  await service.durable(operation.taskId, 'command-result', { commandId: 'effect', status: 'unknown' }); tasks.get(operation.taskId).state = 'waiting';
  await service.command(operation.id, { commandId: 'readback-bound', kind: 'reconcile', payload: { actionIds: ['write'], verify: [expected] } });
  const result = { matched: true, verification: [expected], identity: { accountId: 'account', resourceId: 'resource' }, url: 'http://localhost:5555/resource' };
  await assert.rejects(service.durable(operation.taskId, 'reconciliation', { commandId: 'readback-bound', actionIds: ['write'], result: { ...result, identity: { accountId: 'foreign', resourceId: 'resource' } } }), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(service.durable(operation.taskId, 'reconciliation', { commandId: 'readback-bound', actionIds: ['write'], result: { ...result, verification: [{ target: { selector: '#domain' }, text: 'unchanged page label' }] } }), { code: 'RECONCILIATION_EXPECTATION_MISMATCH' });
  assert.equal((await service.get(operation.id)).actions[0].status, 'unknown');
  await service.durable(operation.taskId, 'reconciliation', { commandId: 'readback-bound', actionIds: ['write'], result });
  assert.equal((await service.get(operation.id)).actions[0].status, 'confirmed');
});

test('stable social target/content prevents duplicate replies across decision IDs but permits a new evidenced inbound object', async (t) => {
  const { service, input, tasks } = await setup(t); input.authorization.allowedActions.push('social.reply');
  const operation = await service.start(input);
  const interaction = { platform: 'local', communityId: 'community', postId: 'resource', conversationId: 'thread', replyToId: 'resource' };
  const expected = { target: { selector: '#reply' }, text: 'Approved exact reply' };
  const make = (id, target = interaction) => ({ commandId: id, kind: 'batch', payload: { actions: [{ actionId: id, kind: 'social.reply', interaction: target, expected }] } });
  const request = (id, object = 'resource') => ({ commandId: id, actionId: id, kind: 'social.reply', accountId: 'account', resourceId: 'resource', origin: 'http://localhost:5555', observedReplyToId: object });
  await service.command(operation.id, make('decision-one')); await service.durable(operation.taskId, 'authorize', request('decision-one'));
  for (const status of ['prepared', 'initiated', 'confirmed']) await service.durable(operation.taskId, 'action', { ...request('decision-one'), status });
  await service.durable(operation.taskId, 'command-result', { commandId: 'decision-one', status: 'confirmed' }); tasks.get(operation.taskId).state = 'waiting';
  await service.command(operation.id, make('decision-two', { ...interaction, conversationId: 'changed-unverified-label' }));
  await assert.rejects(service.durable(operation.taskId, 'authorize', request('decision-two')), { code: 'SOCIAL_INTERACTION_DUPLICATE' });
  await service.durable(operation.taskId, 'command-result', { commandId: 'decision-two', status: 'stopped' }); tasks.get(operation.taskId).state = 'waiting';
  await service.command(operation.id, make('new-inbound', { ...interaction, replyToId: 'comment-2', replyToEvidence: { target: { selector: '#incoming-id' }, text: 'comment-2' } }));
  await assert.rejects(service.durable(operation.taskId, 'authorize', request('new-inbound', 'resource')), { code: 'SOCIAL_OBJECT_MISMATCH' });
  assert.equal((await service.durable(operation.taskId, 'authorize', request('new-inbound', 'comment-2'))).authorization.version, 1);
});

test('compact command get excludes history size while retaining all unknown safety state; offline examples match runtime schema', async (t) => {
  const { service, input } = await setup(t); const operation = await service.start(input);
  await service.command(operation.id, { commandId: 'current', kind: 'observe' });
  await service.durable(operation.taskId, 'command-result', { commandId: 'current', status: 'confirmed', result: { text: 'current summary' } });
  await service.store.update((data) => {
    for (let index = 0; index < 100; index += 1) data.commands.push({ operationId: operation.id, commandId: `history-${index}`, status: 'confirmed', reply: { text: 'historical context'.repeat(100) }, createdAt: new Date().toISOString() });
    data.actions.push({ operationId: operation.id, actionId: 'unknown-safety', commandId: 'old-write', status: 'unknown', resourceId: 'resource', expected: { text: 'unresolved value' } });
    const current = data.operations.find((item) => item.id === operation.id); current.status = 'paused'; current.pauseReason = { code: 'SAFETY_REVIEW' };
  });
  const full = await service.get(operation.id); const compact = await service.get(operation.id, { commandId: 'current' });
  const fullBytes = Buffer.byteLength(JSON.stringify(full)); const compactBytes = Buffer.byteLength(JSON.stringify(compact));
  assert.ok(compactBytes < fullBytes / 20);
  t.diagnostic(JSON.stringify({ fullBytes, compactBytes, reductionPercent: 100 * (1 - compactBytes / fullBytes), unresolvedSafetyActionsRetained: compact.unresolvedActions.length }));
  assert.equal(compact.command.reply.result.text, 'current summary'); assert.equal(compact.status, 'paused'); assert.equal(compact.pauseReason.code, 'SAFETY_REVIEW'); assert.equal(compact.unresolvedActions[0].actionId, 'unknown-safety'); assert.equal(compact.omitted.otherCommandCount, 100);
  const schema = operationsSchema(); assert.deepEqual(schema.executionModes, ['batch', 'operations']); assert.equal(schema.selectionPolicy, 'auto');
  assert.equal(schema.examples.bootstrap.pageVersion, 'COPY_FRESH_PAGE_VERSION'); assert.equal(schema.examples.batch.pageVersion, 'COPY_FRESH_PAGE_VERSION');
  for (const name of ['observe', 'bootstrap', 'batch', 'reconcile']) validateFastCommand({ schemaVersion: 1, ...schema.examples[name] });
});

test('background read authorization stays read-only and is invalid after pause', async (t) => {
  const { service, input } = await setup(t); const operation = await service.start(input);
  await service.command(operation.id, { commandId: 'watch-origin', kind: 'observe' });
  await service.durable(operation.taskId, 'command-result', { commandId: 'watch-origin', status: 'confirmed' });
  const background = { commandId: 'watch-origin', kind: 'observe', effect: false, backgroundRead: true, accountId: 'account', resourceId: 'resource', origin: 'http://localhost:5555' };
  assert.equal((await service.durable(operation.taskId, 'authorize', background)).authorization.version, 1);
  await assert.rejects(service.durable(operation.taskId, 'authorize', { ...background, actionId: 'unreserved-mutation' }), { code: 'COMMAND_NOT_RESERVED' });
  await service.action(operation.id, { action: 'pause' });
  await assert.rejects(service.durable(operation.taskId, 'authorize', background), { code: 'OPERATION_NOT_RUNNING' });
});

test('partial reconciliation cannot clear a second uncertain external effect', async (t) => {
  const { service, input, tasks } = await setup(t); const operation = await service.start(input);
  const expected = { target: { selector: '#result' }, text: 'actual approved value' };
  await service.command(operation.id, { commandId: 'two-effects', kind: 'batch', payload: { actions: [{ actionId: 'one', expected }, { actionId: 'two', expected }] } });
  for (const actionId of ['one', 'two']) for (const status of ['prepared', 'initiated', 'unknown']) await service.durable(operation.taskId, 'action', { commandId: 'two-effects', actionId, kind: 'click', accountId: 'account', resourceId: 'resource', status });
  await service.durable(operation.taskId, 'command-result', { commandId: 'two-effects', status: 'unknown' }); tasks.get(operation.taskId).state = 'waiting';
  await service.command(operation.id, { commandId: 'partial-readback', kind: 'reconcile', payload: { actionIds: ['one'], verify: [expected] } });
  await assert.rejects(service.durable(operation.taskId, 'reconciliation', { commandId: 'partial-readback', actionIds: ['one'], result: { matched: true, identity: { accountId: 'account', resourceId: 'resource' }, url: 'http://localhost:5555/resource', verification: [expected] } }), { code: 'RECONCILIATION_INCOMPLETE' });
  assert.ok((await service.get(operation.id)).actions.every((action) => action.status === 'unknown'));
});

test('twenty successful quiet authorizations rewrite nothing, while budget rejection commits its pause', async (t) => {
  const { service, input, advance, controls } = await setup(t); const operation = await service.start({ ...input, budgets: { maxDurationMs: 10000 } });
  await service.command(operation.id, { commandId: 'quiet-observer', kind: 'observe' });
  await service.durable(operation.taskId, 'command-result', { commandId: 'quiet-observer', status: 'confirmed' });
  const ledgerPath = service.store.store.filePath;
  const before = await stat(ledgerPath, { bigint: true }); const sourceBefore = await readFile(ledgerPath, 'utf8');
  const originalUpdate = service.store.store.update.bind(service.store.store); let writes = 0;
  service.store.store.update = async (...args) => { writes += 1; return originalUpdate(...args); };
  const request = { commandId: 'quiet-observer', kind: 'observe', effect: false, backgroundRead: true, accountId: 'account', resourceId: 'resource', origin: 'http://localhost:5555' };
  for (let count = 0; count < 20; count += 1) assert.equal((await service.durable(operation.taskId, 'authorize', request)).authorization.version, 1);
  const after = await stat(ledgerPath, { bigint: true });
  assert.equal(writes, 0); assert.equal(before.mtimeNs, after.mtimeNs); assert.equal(await readFile(ledgerPath, 'utf8'), sourceBefore);
  advance(10001);
  await assert.rejects(service.durable(operation.taskId, 'authorize', request), { code: 'OPERATION_BUDGET_EXCEEDED' });
  assert.equal(writes, 1); assert.equal(JSON.parse(await readFile(ledgerPath, 'utf8')).operations[0].status, 'paused'); assert.equal(controls.at(-1).control.action, 'pause');
  t.diagnostic(JSON.stringify({ quietAuthorizations: 20, quietLedgerWrites: 0, budgetPauseLedgerWrites: writes, pausePersisted: true }));
});

test('budget snapshot recheck cannot overwrite a concurrent terminal stop or revoke', async (t) => {
  for (const terminal of ['stopped', 'revoked']) {
    const { service, input, advance } = await setup(t);
    const operation = await service.start({ ...input, budgets: { maxDurationMs: 1000 } });
    await service.command(operation.id, { commandId: 'terminal-race', kind: 'observe' });
    advance(1001);
    const originalRead = service.store.read.bind(service.store); let inject = true;
    service.store.read = async () => {
      const snapshot = await originalRead();
      if (inject) {
        inject = false;
        await service.store.update((data) => {
          const current = data.operations.find((item) => item.id === operation.id);
          current.status = terminal; current.budgets.maxDurationMs = 100000;
          if (terminal === 'revoked') current.authorization.revokedAt = new Date().toISOString();
        });
      }
      return snapshot;
    };
    await assert.rejects(service.durable(operation.taskId, 'authorize', { commandId: 'terminal-race', kind: 'observe', effect: false }), { code: 'OPERATION_NOT_RUNNING' });
    assert.equal((await service.get(operation.id)).status, terminal);
    if (terminal === 'revoked') assert.ok((await service.get(operation.id)).authorization.revokedAt);
  }
});

test('operation cursor defaults follow modes; explicit toggles persist without changing takeover or authority', async (t) => {
  const { service, input, controls, tasks } = await setup(t);
  const operations = await service.start(input); assert.equal(operations.cursorEnabled, true); assert.equal(operations.task.input.showCursor, true);
  const batch = await service.start({ ...input, mode: 'batch' }); assert.equal(batch.cursorEnabled, false); assert.equal(batch.task.input.showCursor, false);
  tasks.get(batch.taskId).state = 'waiting';
  await service.action(batch.id, { action: 'resume', mode: 'operations' }); assert.equal((await service.get(batch.id)).cursorEnabled, true, 'Mode default changes only when there is no explicit cursor preference');
  const overridden = await service.start({ ...input, mode: 'batch', showCursor: true }); assert.equal(overridden.cursorEnabled, true);
  await assert.rejects(service.start({ ...input, showCursor: 'yes' }), { code: 'INVALID_CURSOR_PREFERENCE' });
  await service.action(operations.id, { action: 'takeover' });
  const before = await service.get(operations.id);
  await service.action(operations.id, { action: 'update', showCursor: false });
  let current = await service.get(operations.id); assert.equal(current.cursorEnabled, false); assert.equal(current.runtimeOptions.showCursor, false);
  assert.equal(current.manualLock, true); assert.equal(current.status, 'paused'); assert.deepEqual(current.authorization, before.authorization); assert.deepEqual(current.counters, before.counters);
  assert.deepEqual(controls.at(-1).control, { action: 'cursor', visible: false });
  tasks.get(operations.taskId).state = 'waiting';
  await service.action(operations.id, { action: 'resume', mode: 'batch' });
  current = await service.get(operations.id); assert.equal(current.cursorEnabled, false); assert.equal(current.mode, 'batch');
  const ordinary = publicTask({ id: 'free', mode: 'batch', state: 'queued', operationId: 'untrusted', cursorEnabled: true });
  assert.equal(ordinary.operationId, undefined); assert.equal(ordinary.cursorEnabled, undefined);
  const controlled = publicTask({ id: 'builtin', builtin: 'fast-operations', operationId: 'op', mode: 'operations', cursorEnabled: false, state: 'waiting' });
  assert.equal(controlled.operationId, 'op'); assert.equal(controlled.cursorEnabled, false);
});

test('dialog acknowledgement abandons only effect-free preparation, keeps takeover, and rejects stale or unknown-submit cases', async (t) => {
  const { service, input, tasks } = await setup(t);
  const operation = await service.start(input);
  await service.command(operation.id, { commandId: 'interrupted-preparation', kind: 'batch', pageId: 'page-current', pageVersion: '1:current-document:0', payload: { actions: [{ actionId: 'prepare', type: 'fill', effect: false, expected: { text: 'prepared' } }] } });
  for (const status of ['prepared', 'initiated', 'unknown']) await service.durable(operation.taskId, 'action', { commandId: 'interrupted-preparation', actionId: 'prepare', kind: 'click', accountId: 'account', resourceId: 'resource', status });
  await service.durable(operation.taskId, 'command-result', { commandId: 'interrupted-preparation', status: 'unknown' });
  await service.action(operation.id, { action: 'takeover' }); tasks.get(operation.taskId).state = 'waiting';
  const acknowledgement = { commandId: 'ack-dialog', kind: 'control', pageId: 'page-current', pageVersion: '2:current-document:3', payload: { action: 'acknowledge-dialog', reason: 'Root inspected a benign dismissed alert and abandons interrupted preparation' } };
  await service.command(operation.id, acknowledgement);
  const evidence = { commandId: acknowledgement.commandId, pageId: acknowledgement.pageId, pageVersion: acknowledgement.pageVersion, reason: acknowledgement.payload.reason, accountId: 'account', resourceId: 'resource', origin: 'http://localhost:5555' };
  await assert.rejects(service.durable(operation.taskId, 'dialog-acknowledgement', { ...evidence, pageVersion: 'stale' }), { code: 'INVALID_DIALOG_ACKNOWLEDGEMENT' });
  assert.equal((await service.durable(operation.taskId, 'dialog-acknowledgement', evidence)).acknowledged, true);
  let result = await service.get(operation.id); assert.equal(result.manualLock, true); assert.equal(result.status, 'paused'); assert.equal(result.actions[0].status, 'failed'); assert.equal(result.actions[0].verification.state, 'abandoned');
  assert.ok(result.records.some((record) => record.kind === 'dialog-acknowledgement'));
  const external = await service.start(input);
  await service.command(external.id, { commandId: 'unknown-submit', kind: 'batch', payload: { actions: [{ actionId: 'submit', type: 'click', expected: { text: 'saved' } }] } });
  for (const status of ['prepared', 'initiated', 'unknown']) await service.durable(external.taskId, 'action', { commandId: 'unknown-submit', actionId: 'submit', kind: 'click', accountId: 'account', resourceId: 'resource', status });
  await service.durable(external.taskId, 'command-result', { commandId: 'unknown-submit', status: 'unknown' }); tasks.get(external.taskId).state = 'waiting';
  await service.command(external.id, acknowledgement);
  await assert.rejects(service.durable(external.taskId, 'dialog-acknowledgement', evidence), { code: 'RECONCILIATION_REQUIRED' });
  result = await service.get(external.id); assert.equal(result.actions[0].status, 'unknown');
});

test('cursor IPC failure keeps the last confirmed preference and exposes unapplied state without unlocking', async (t) => {
  const { service, input, taskService } = await setup(t); const operation = await service.start(input);
  await service.action(operation.id, { action: 'takeover' });
  taskService.operationControl = async () => false;
  await assert.rejects(service.action(operation.id, { action: 'update', showCursor: false }), { code: 'CURSOR_APPLY_UNCONFIRMED' });
  const current = await service.get(operation.id); assert.equal(current.cursorEnabled, true); assert.equal(current.runtimeOptions.showCursor, undefined);
  assert.equal(current.cursorApplyState, 'unconfirmed'); assert.equal(current.cursorRequested, false); assert.equal(current.manualLock, true); assert.equal(current.status, 'paused');
});

test('recreated Worker resumes with startup cursor preference without premature cursor IPC; later explicit updates still require ACK', async (t) => {
  for (const explicit of [undefined, false]) {
    const { service, input, taskService, tasks, controls } = await setup(t);
    const operation = await service.start({ ...input, ...(explicit === undefined ? {} : { showCursor: explicit }) });
    await service.store.update((data) => { data.operations.find((item) => item.id === operation.id).cursorApplyState = 'applied'; });
    tasks.get(operation.taskId).state = 'stopped';
    const originalCreate = taskService.createOperation;
    taskService.createOperation = async (body) => { const task = await originalCreate(body); task.state = 'queued'; return task; };
    const originalControl = taskService.operationControl;
    taskService.operationControl = async (id, control) => {
      if (control.action === 'cursor' && tasks.get(id)?.state === 'queued') throw Object.assign(new Error('Worker listener not registered during browser startup'), { code: 'CURSOR_HANDLER_UNAVAILABLE' });
      return originalControl(id, control);
    };
    const resumed = await service.action(operation.id, { action: 'resume' });
    assert.notEqual(resumed.taskId, operation.taskId); assert.equal(resumed.task.state, 'queued');
    assert.equal(resumed.cursorApplyState, 'initial', 'Queued startup preference must not inherit the previous Worker applied ACK');
    assert.equal(resumed.task.input.showCursor, explicit ?? true); assert.equal(resumed.cursorEnabled, explicit ?? true);
    assert.equal(controls.filter((item) => item.id === resumed.taskId && item.control.action === 'cursor').length, 0);
    assert.equal(resumed.commands.at(-1).delivered, false);
    tasks.get(resumed.taskId).state = 'waiting'; await service.tick();
    assert.equal((await service.get(operation.id)).commands.at(-1).delivered, true);
    await service.durable(resumed.taskId, 'command-result', { commandId: resumed.pending, status: 'confirmed' });
    const updated = await service.action(operation.id, { action: 'update', showCursor: !(explicit ?? true) });
    assert.equal(updated.cursorApplyState, 'applied'); assert.equal(updated.cursorEnabled, !(explicit ?? true));
    assert.equal(controls.at(-1).control.action, 'cursor');
    taskService.operationControl = async () => false;
    await assert.rejects(service.action(operation.id, { action: 'update', showCursor: explicit ?? true }), { code: 'CURSOR_APPLY_UNCONFIRMED' });
  }
});

test('dialog acknowledgement does not abandon other pages, resources or document generations', async (t) => {
  const { service, input } = await setup(t); const operation = await service.start(input);
  await service.store.update((data) => {
    const definitions = [
      { id: 'this-context', pageId: 'page-current', version: '1:current-document:0', resourceId: 'resource' },
      { id: 'other-page', pageId: 'page-other', version: '1:current-document:0', resourceId: 'resource' },
      { id: 'other-resource', pageId: 'page-current', version: '1:current-document:0', resourceId: 'different-resource' },
      { id: 'old-document', pageId: 'page-current', version: '1:old-document:0', resourceId: 'resource' }
    ];
    for (const item of definitions) {
      data.commands.push({ operationId: operation.id, commandId: item.id, status: 'unknown', createdAt: new Date().toISOString(), envelope: { pageId: item.pageId, pageVersion: item.version, payload: { actions: [{ actionId: item.id, effect: false }] } } });
      data.actions.push({ operationId: operation.id, commandId: item.id, actionId: item.id, effect: false, status: 'unknown', accountId: 'account', resourceId: item.resourceId });
    }
  });
  const body = { commandId: 'scoped-ack', kind: 'control', pageId: 'page-current', pageVersion: '3:current-document:2', payload: { action: 'acknowledge-dialog', reason: 'Only this document and resource were inspected' } };
  await service.command(operation.id, body);
  const ack = await service.durable(operation.taskId, 'dialog-acknowledgement', { commandId: body.commandId, pageId: body.pageId, pageVersion: body.pageVersion, reason: body.payload.reason, accountId: 'account', resourceId: 'resource', origin: 'http://localhost:5555' });
  assert.deepEqual(ack.abandonedActionIds, ['this-context']); assert.equal(ack.localUncertaintyCleared, false); assert.equal(ack.requiresReconciliation, true);
  assert.deepEqual(ack.remainingUnresolvedActionIds.sort(), ['old-document', 'other-page', 'other-resource']);
  const current = await service.get(operation.id); assert.equal(current.actions.find((action) => action.actionId === 'this-context').status, 'failed');
  assert.ok(current.actions.filter((action) => action.actionId !== 'this-context').every((action) => action.status === 'unknown'));
});

async function navigationReadbackFixture(t, original, { recordKind = original.kind || original.type, requestedEffect = original.effect } = {}) {
  const setupResult = await setup(t); const { service, input, tasks } = setupResult;
  input.authorization.resourceIds = ['source-resource', 'destination-resource']; input.authorization.allowedActions.push('navigate', 'fill', 'site.prepare');
  const operation = await service.start(input);
  const definition = { actionId: 'cross-resource-navigation', ...original };
  await service.command(operation.id, { commandId: 'navigation-command', kind: 'batch', pageId: 'same-page', pageVersion: '1:source-document:0', payload: { actions: [definition] } });
  for (const status of ['prepared', 'initiated', 'unknown']) await service.durable(operation.taskId, 'action', {
    commandId: 'navigation-command', actionId: definition.actionId, accountId: 'account', resourceId: 'source-resource',
    expectedIdentity: { accountId: 'account', resourceId: 'source-resource' }, kind: recordKind, effect: requestedEffect, before: 'source-view', proposed: original.value, status
  });
  await service.durable(operation.taskId, 'command-result', { commandId: 'navigation-command', status: 'unknown' }); tasks.get(operation.taskId).state = 'waiting';
  await service.command(operation.id, { commandId: 'destination-readback', kind: 'reconcile', payload: { actionIds: [definition.actionId], verify: [original.expected] } });
  const result = { matched: true, identity: { accountId: 'account', resourceId: 'destination-resource' }, url: 'http://localhost:5555/site', verification: [original.expected] };
  const reconcile = (override = {}) => service.durable(operation.taskId, 'reconciliation', { commandId: 'destination-readback', actionIds: [definition.actionId], result: { ...result, ...override } });
  return { ...setupResult, operation, reconcile };
}

test('original effect-free HTTP navigation reconciles its exact authorized destination while preserving source identity', async (t) => {
  const target = 'http://localhost:5555/site';
  const { service, operation, reconcile } = await navigationReadbackFixture(t, { type: 'navigate', effect: false, value: target, expected: { url: target } });
  await assert.rejects(reconcile({ url: 'http://localhost:5555/wrong-page' }), { code: 'RECONCILIATION_DESTINATION_MISMATCH' });
  await assert.rejects(reconcile({ identity: { accountId: 'foreign-account', resourceId: 'destination-resource' } }), { code: 'ACCOUNT_MISMATCH' });
  await assert.rejects(reconcile({ identity: { accountId: 'account', resourceId: 'unauthorized-destination' } }), { code: 'RESOURCE_NOT_AUTHORIZED' });
  await assert.rejects(reconcile({ verification: [{ target: { selector: '#unrelated' }, text: 'anything' }] }), { code: 'RECONCILIATION_EXPECTATION_MISMATCH' });
  assert.equal((await service.get(operation.id)).actions[0].status, 'unknown');
  await reconcile();
  const action = (await service.get(operation.id)).actions[0];
  assert.equal(action.status, 'confirmed'); assert.equal(action.accountId, 'account'); assert.equal(action.resourceId, 'source-resource'); assert.equal(action.before, 'source-view'); assert.equal(action.proposed, target);
  assert.deepEqual(action.expectedIdentity, { accountId: 'account', resourceId: 'source-resource' });
  assert.equal(action.destinationReadback.accountId, 'account'); assert.equal(action.destinationReadback.resourceId, 'destination-resource'); assert.equal(action.destinationReadback.url, target); assert.ok(action.destinationReadback.verifiedAt);
});

test('navigation destination exception cannot be borrowed by effects, non-navigation preparation, malformed or mismatched persisted declarations', async (t) => {
  const target = 'http://localhost:5555/site';
  const variants = [
    { original: { type: 'fill', kind: 'site.prepare', effect: false, value: target, expected: { url: target } } },
    { original: { type: 'click', kind: 'navigate', effect: false, value: target, expected: { url: target } } },
    { original: { type: 'navigate', kind: 'site.prepare', effect: false, value: target, expected: { url: target } }, recordKind: 'navigate' },
    { original: { type: 'navigate', effect: true, value: target, expected: { url: target } }, requestedEffect: false },
    { original: { type: 'navigate', effect: false, value: target, expected: { url: 'http://localhost:5555/different' } } },
    { original: { type: 'navigate', effect: false, value: 'file:///unapproved', expected: { url: 'file:///unapproved' } } },
    { original: { type: 'navigate', effect: false, value: target, expected: { url: target } }, recordKind: 'site.prepare' }
  ];
  for (const { original, ...options } of variants) {
    const { service, operation, reconcile } = await navigationReadbackFixture(t, original, options);
    await assert.rejects(reconcile(), { code: 'RECONCILIATION_RESOURCE_MISMATCH' });
    const action = (await service.get(operation.id)).actions[0]; assert.equal(action.status, 'unknown'); assert.equal(action.resourceId, 'source-resource'); assert.equal(action.destinationReadback, undefined);
  }
});
