import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { access, link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProfileStore } from '../src/lib/profile-store.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';

const ADMIN = { role: 'manager-admin', clientId: 'manager-admin' };
const AGENT_A = { role: 'agent', clientId: 'agent-a' };
const AGENT_B = { role: 'agent', clientId: 'agent-b' };
let nextPid = 60_000;

class FakeWorker extends EventEmitter {
  constructor(onSend) {
    super();
    this.pid = nextPid += 1;
    this.connected = true;
    this.exitCode = null;
    this.onSend = onSend;
    this.killSignals = [];
  }
  send(message, _handle, _options, callback) {
    this.onSend?.(message, this);
    callback?.();
  }
  finish() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.connected = false;
    this.emit('exit', 0, null);
  }
  kill(signal = 'SIGTERM') {
    this.killSignals.push(signal);
    this.finish();
    return true;
  }
}

function fakeProfiles(root) {
  const profile = {
    id: 'profile_fixture',
    name: 'Fixture',
    userDataDir: path.join(root, 'profile'),
    defaultBehavior: 'fast',
    state: 'idle',
    lease: null
  };
  return {
    profile,
    async get(id) {
      if (id !== profile.id) throw Object.assign(new Error('not found'), { code: 'PROFILE_NOT_FOUND' });
      return structuredClone(profile);
    },
    async acquireLease(id, ownerId, options) {
      if (id !== profile.id) throw new Error('not found');
      if (profile.lease && profile.lease.ownerId !== ownerId) {
        throw Object.assign(new Error('leased'), { code: 'PROFILE_LEASED', statusCode: 409 });
      }
      profile.lease = { ownerId, pid: options.pid };
      profile.state = ownerId.startsWith('profile-open:') ? 'open' : 'leased';
      return structuredClone(profile);
    },
    async releaseLease(id, ownerId) {
      if (id === profile.id && profile.lease?.ownerId === ownerId) {
        profile.lease = null;
        profile.state = 'idle';
        return true;
      }
      return false;
    }
  };
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

async function serviceFixture(t, {
  keepWorkerOpen = false,
  terminalWorkerOpen = false,
  terminalError = null,
  childErrorOpen = false,
  moduleSource = null,
  workerResult = null,
  externalCostOperations = [],
  withArtifacts = false,
  withDiagnostic = false,
  withLostDiagnosticManifest = false,
  withMaxArtifacts = false,
  diagnosticGraceMs,
  workerCleanupGraceMs = 100,
  workerHardKillGraceMs = 50,
  artifactValidationHook = null
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-runtime-core-'));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed);
  const modulePath = path.join(allowed, 'fixture.mjs');
  await writeFile(modulePath, moduleSource ?? 'export async function run() { return { summary: "ok", evidence: [{ kind: "message", value: "ok" }] }; }\n');
  const profiles = fakeProfiles(root);
  const starts = [];
  const workers = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state', 'tasks'),
    profileStore: profiles,
    allowedTaskRoots: [allowed],
    seedTaskTypes: [],
    ...(diagnosticGraceMs === undefined ? {} : { diagnosticGraceMs }),
    workerCleanupGraceMs,
    workerHardKillGraceMs,
    artifactValidationHook,
    workerFactory(_workerPath, kind) {
      const externalCostResponses = new Map();
      const requestExternalCost = (child, operation, index) => new Promise((resolve, reject) => {
        const requestId = `fixture-cost-${index}`;
        externalCostResponses.set(requestId, { resolve, reject });
        child.emit('message', {
          type: 'external_cost_request',
          requestId,
          action: operation.action,
          operationId: operation.operationId,
          amount: operation.amount
        });
      });
      const worker = new FakeWorker((message, child) => {
        if (kind === 'task' && message.type === 'external_cost_response') {
          const pending = externalCostResponses.get(message.requestId);
          if (!pending) return;
          externalCostResponses.delete(message.requestId);
          if (message.ok === true) pending.resolve(message.result);
          else pending.reject(Object.assign(new Error(message.error?.message || 'external cost rejected'), {
            code: message.error?.code
          }));
          return;
        }
        if (kind === 'task' && message.type === 'start') {
          starts.push(message.config);
          if (childErrorOpen) {
            setImmediate(() => child.emit('error', new Error('worker IPC failed')));
            return;
          }
          if (terminalWorkerOpen) {
            setImmediate(() => {
              child.emit('message', { type: 'result', result: { summary: 'ok', evidence: [{ kind: 'message', value: 'ok' }] } });
              child.emit('message', { type: 'state', state: 'completed' });
              child.emit('message', { type: 'cleanup', browserClosed: true });
            });
            return;
          }
          if (terminalError) {
            setImmediate(() => {
              child.emit('message', { type: 'error', error: { message: terminalError } });
              child.emit('message', { type: 'cleanup', browserClosed: true });
              child.finish();
            });
            return;
          }
          if (!keepWorkerOpen) setImmediate(() => void (async () => {
            for (const [index, operation] of externalCostOperations.entries()) {
              await requestExternalCost(child, operation, index);
            }
            let evidence = [{ kind: 'message', value: 'ok' }];
            if (withArtifacts) {
              await writeFile(path.join(message.config.outputDir, 'visible.txt'), 'hello 世界 and more', 'utf8');
              await writeFile(path.join(message.config.outputDir, 'undeclared.txt'), 'must stay hidden', 'utf8');
              await writeFile(path.join(path.dirname(message.config.outputDir), 'outside.txt'), 'outside output', 'utf8');
              evidence = [
                { kind: 'artifact', file: 'visible.txt', agentVisible: true }
              ];
            }
            if (withMaxArtifacts) {
              evidence = [];
              for (let index = 0; index < 32; index += 1) {
                const file = `result-${String(index).padStart(3, '0')}.txt`;
                await writeFile(path.join(message.config.outputDir, file), String(index), 'utf8');
                evidence.push({ kind: 'artifact', file });
              }
            }
            if (withDiagnostic) {
              const screenshot = path.join(message.config.outputDir, 'screenshots', 'failure.png');
              await mkdir(path.dirname(screenshot), { recursive: true });
              await writeFile(screenshot, Buffer.from('diagnostic-image'));
              child.emit('message', { type: 'screenshot', path: screenshot, reason: 'action-click' });
            }
            if (withLostDiagnosticManifest) {
              const screenshot = path.join(message.config.outputDir, 'screenshots', 'lost-ipc.png');
              const observation = path.join(message.config.outputDir, 'observations', 'lost-ipc.json');
              await mkdir(path.dirname(screenshot), { recursive: true });
              await mkdir(path.dirname(observation), { recursive: true });
              await writeFile(screenshot, Buffer.from('lost-ipc-diagnostic'));
              await writeFile(observation, '{"refs":[]}\n');
              const at = new Date().toISOString();
              await writeFile(path.join(path.dirname(message.config.outputDir), 'diagnostics.json'), `${JSON.stringify({
                version: 2,
                taskId: message.config.taskId,
                attempt: message.config.attempt,
                updatedAt: at,
                screenshot: { relativePath: path.join('screenshots', 'lost-ipc.png'), reason: 'timeout', at },
                observation: { relativePath: path.join('observations', 'lost-ipc.json'), reason: 'timeout', at }
              })}\n`);
            }
            child.emit('message', {
              type: 'result',
              result: workerResult ?? { summary: 'ok', evidence }
            });
            child.emit('message', { type: 'state', state: 'completed' });
            child.emit('message', { type: 'cleanup', browserClosed: true });
            child.finish();
          })());
        }
        if (kind === 'profile-open' && message.type === 'open') {
          setTimeout(() => child.emit('message', { type: 'ready' }), 10);
        }
        if (kind === 'profile-open' && message.type === 'close') setImmediate(() => child.finish());
      });
      workers.push(worker);
      return worker;
    }
  });
  await service.installTaskType({ name: 'fixture', modulePath }, ADMIN);
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  return { root, allowed, modulePath, profiles, service, starts, workers };
}

test('task registry snapshots trusted modules and task create rejects raw module paths', async (t) => {
  const { modulePath, service, starts } = await serviceFixture(t);
  await writeFile(modulePath, 'throw new Error("changed after install");\n');
  const created = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'snapshot:1'
  }, AGENT_A);
  assert.equal(created.taskType, 'fixture');
  assert.equal('modulePath' in created, false);
  assert.equal('outputDir' in created, false);
  assert.match(created.outputRef, /^taskmaster:\/\//);
  await waitFor(() => starts.length === 1);
  assert.notEqual(starts[0].modulePath, modulePath);
  assert.match(await readFile(starts[0].modulePath, 'utf8'), /summary: "ok"/);

  await assert.rejects(service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    modulePath,
    idempotencyKey: 'snapshot:2'
  }, AGENT_A), { code: 'INVALID_TASK_CREATE' });
  await assert.rejects(service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    timeoutMs: 24 * 60 * 60 * 1_000 + 1,
    idempotencyKey: 'snapshot:timeout'
  }, AGENT_A), { code: 'INVALID_TASK_TIMEOUT' });
  await assert.rejects(service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    externalCostBudget: { currency: 'USD', maxAmount: 1 },
    idempotencyKey: 'snapshot:undeclared-budget'
  }, AGENT_A), { code: 'TASK_EXTERNAL_COST_NOT_DECLARED' });
});

test('paid Task Packs require a bounded per-run budget and verified final cost evidence', async (t) => {
  const moduleSource = [
    'export const meta = { externalCost: { currency: "USD", maxAmountPerRun: 5 } };',
    'export async function run() { return { summary: "unused", evidence: [{ kind: "message", value: "unused" }] }; }',
    ''
  ].join('\n');
  const validFixture = await serviceFixture(t, {
    moduleSource,
    externalCostOperations: [
      { action: 'reserve', operationId: 'provider-call-1', amount: 2.5 },
      { action: 'settle', operationId: 'provider-call-1', amount: 2 }
    ],
    workerResult: {
      summary: 'paid run complete',
      evidence: [
        { kind: 'message', value: 'provider work complete' },
        { kind: 'count', label: 'external-cost-estimated', value: 2.5 },
        { kind: 'count', label: 'external-cost-actual', value: 2 }
      ]
    }
  });
  await assert.rejects(validFixture.service.create({
    profileId: 'profile_fixture', taskType: 'fixture', idempotencyKey: 'paid:missing-budget'
  }, AGENT_A), { code: 'TASK_EXTERNAL_COST_BUDGET_REQUIRED' });
  await assert.rejects(validFixture.service.create({
    profileId: 'profile_fixture', taskType: 'fixture',
    externalCostBudget: { currency: 'EUR', maxAmount: 2 },
    idempotencyKey: 'paid:wrong-currency'
  }, AGENT_A), { code: 'INVALID_TASK_EXTERNAL_COST_BUDGET' });
  await assert.rejects(validFixture.service.create({
    profileId: 'profile_fixture', taskType: 'fixture',
    externalCostBudget: { currency: 'USD', maxAmount: 6 },
    idempotencyKey: 'paid:over-ceiling'
  }, AGENT_A), { code: 'TASK_EXTERNAL_COST_BUDGET_EXCEEDS_CEILING' });

  const created = await validFixture.service.create({
    profileId: 'profile_fixture', taskType: 'fixture',
    externalCostBudget: { currency: 'USD', maxAmount: 3 },
    idempotencyKey: 'paid:valid-budget'
  }, AGENT_A);
  const completed = await waitFor(async () => {
    const task = await validFixture.service.get(created.id, AGENT_A);
    return task.cleanup?.settled ? task : null;
  });
  assert.equal(completed.state, 'completed');
  assert.equal('externalCostBudget' in completed, false);
  assert.deepEqual(completed.externalCostUsage, {
    currency: 'USD', estimatedTotal: 2.5, actualTotal: 2, remainingAmount: 1
  });
  assert.deepEqual(validFixture.starts[0].externalCostBudget, { currency: 'USD', maxAmount: 3 });

  const missingEvidenceFixture = await serviceFixture(t, { moduleSource });
  const missingEvidence = await missingEvidenceFixture.service.create({
    profileId: 'profile_fixture', taskType: 'fixture',
    externalCostBudget: { currency: 'USD', maxAmount: 3 },
    idempotencyKey: 'paid:missing-evidence'
  }, AGENT_A);
  const missingFailed = await waitFor(async () => {
    const task = await missingEvidenceFixture.service.get(missingEvidence.id, AGENT_A);
    return task.cleanup?.settled ? task : null;
  });
  assert.equal(missingFailed.state, 'failed');
  assert.equal(missingFailed.error.code, 'TASK_COMPLETION_GATE_FAILED');

  const overBudgetFixture = await serviceFixture(t, {
    moduleSource,
    workerResult: {
      summary: 'over budget',
      evidence: [
        { kind: 'count', label: 'external-cost-estimated', value: 2 },
        { kind: 'count', label: 'external-cost-actual', value: 4 }
      ]
    }
  });
  const overBudget = await overBudgetFixture.service.create({
    profileId: 'profile_fixture', taskType: 'fixture',
    externalCostBudget: { currency: 'USD', maxAmount: 3 },
    idempotencyKey: 'paid:actual-over-budget'
  }, AGENT_A);
  const overBudgetFailed = await waitFor(async () => {
    const task = await overBudgetFixture.service.get(overBudget.id, AGENT_A);
    return task.cleanup?.settled ? task : null;
  });
  assert.equal(overBudgetFailed.state, 'failed');
  assert.equal(overBudgetFailed.error.code, 'TASK_COMPLETION_GATE_FAILED');
});

test('task type installation rejects unsupported schemas and enforces the declared input contract', async (t) => {
  const { allowed, service } = await serviceFixture(t);
  const invalidPattern = path.join(allowed, 'invalid-pattern.mjs');
  await writeFile(invalidPattern, [
    'export const meta = { inputSchema: { type: "object", properties: { value: { type: "string", pattern: "[" } } } };',
    'export async function run() {}',
    ''
  ].join('\n'));
  await assert.rejects(
    service.installTaskType({ name: 'invalid-pattern', modulePath: invalidPattern }, ADMIN),
    { code: 'INVALID_TASK_METADATA' }
  );

  const unsupported = path.join(allowed, 'unsupported-schema.mjs');
  await writeFile(unsupported, [
    'export const meta = { inputSchema: { oneOf: [{ type: "object" }] } };',
    'export async function run() {}',
    ''
  ].join('\n'));
  await assert.rejects(
    service.installTaskType({ name: 'unsupported-schema', modulePath: unsupported }, ADMIN),
    { code: 'INVALID_TASK_METADATA' }
  );

  const constrained = path.join(allowed, 'constrained.mjs');
  await writeFile(constrained, [
    'export const meta = { inputSchema: { type: "object", additionalProperties: false, required: ["count"], properties: { count: { type: "integer", minimum: 1, maximum: 3 } } } };',
    'export async function run() {}',
    ''
  ].join('\n'));
  await service.installTaskType({ name: 'constrained', modulePath: constrained }, ADMIN);
  await assert.rejects(service.create({
    profileId: 'profile_fixture',
    taskType: 'constrained',
    idempotencyKey: 'schema:invalid',
    input: { count: 4, unexpected: true }
  }, AGENT_A), (error) => {
    assert.equal(error.code, 'TASK_INPUT_SCHEMA_FAILED');
    assert.equal(typeof error.details?.field, 'string');
    assert.equal(typeof error.details?.reason, 'string');
    return true;
  });
});

test('idempotency is persistent, payload-bound, and isolated per Agent owner', async (t) => {
  const { root, allowed, profiles, service } = await serviceFixture(t);
  const body = {
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'agent-a:stable',
    input: { b: 2, a: 1 }
  };
  const [first, second] = await Promise.all([
    service.create(body, AGENT_A),
    service.create({ ...body, input: { a: 1, b: 2 } }, AGENT_A)
  ]);
  assert.equal(first.id, second.id);
  await assert.rejects(
    service.create({ ...body, input: { a: 3 } }, AGENT_A),
    { code: 'IDEMPOTENCY_CONFLICT' }
  );
  await waitFor(async () => (await service.get(first.id, AGENT_A)).cleanup.settled);
  const other = await service.create({ ...body, input: { a: 3 } }, AGENT_B);
  assert.notEqual(other.id, first.id);
  await waitFor(async () => (await service.get(other.id, AGENT_B)).cleanup.settled);

  await service.close();
  let restartedWorkers = 0;
  const restarted = createTaskService({
    stateDir: path.join(root, 'state', 'tasks'),
    profileStore: profiles,
    allowedTaskRoots: [allowed],
    seedTaskTypes: [],
    workerFactory() {
      restartedWorkers += 1;
      throw new Error('an idempotent replay must not start a new worker');
    }
  });
  t.after(() => restarted.close().catch(() => {}));
  const replay = await restarted.create(body, AGENT_A);
  assert.equal(replay.id, first.id);
  assert.equal(restartedWorkers, 0);
  await assert.rejects(
    restarted.create({ ...body, input: { a: 99 } }, AGENT_A),
    { code: 'IDEMPOTENCY_CONFLICT' }
  );
});

test('all Agents can use a Profile even when legacy ownership metadata remains in a fixture', async (t) => {
  const { profiles, service } = await serviceFixture(t);
  profiles.profile.ownerClientId = AGENT_A.clientId;
  profiles.profile.access = 'private';

  const first = await service.create({
    profileId: profiles.profile.id,
    taskType: 'fixture',
    idempotencyKey: 'profile-private-agent-b'
  }, AGENT_B);
  await waitFor(async () => (await service.get(first.id, AGENT_B)).cleanup.settled);

  const owned = await service.create({
    profileId: profiles.profile.id,
    taskType: 'fixture',
    idempotencyKey: 'profile-private-agent-a'
  }, AGENT_A);
  await waitFor(async () => (await service.get(owned.id, AGENT_A)).cleanup.settled);

  const shared = await service.create({
    profileId: profiles.profile.id,
    taskType: 'fixture',
    idempotencyKey: 'profile-shared-agent-b'
  }, AGENT_B);
  const complete = await waitFor(async () => {
    const current = await service.get(shared.id, AGENT_B);
    return current.cleanup.settled ? current : null;
  });
  assert.equal(complete.state, 'completed');
});

test('task owner scope and cursor pagination are enforced', async (t) => {
  const { service } = await serviceFixture(t);
  const created = [];
  for (let index = 0; index < 5; index += 1) {
    created.push(await service.create({
      profileId: 'profile_fixture',
      taskType: 'fixture',
      idempotencyKey: `page:${index}`
    }, AGENT_A));
    await waitFor(async () => (await service.get(created.at(-1).id, AGENT_A)).cleanup.settled);
  }
  await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'agent-b:only'
  }, AGENT_B);

  const firstPage = await service.list({ caller: AGENT_A, limit: 2 });
  assert.equal(firstPage.tasks.length, 2);
  assert.ok(firstPage.nextCursor);
  const secondPage = await service.list({ caller: AGENT_A, limit: 2, cursor: firstPage.nextCursor });
  assert.equal(secondPage.tasks.length, 2);
  assert.equal(new Set([...firstPage.tasks, ...secondPage.tasks].map((task) => task.id)).size, 4);
  assert.equal((await service.list({ caller: AGENT_B, limit: 100 })).tasks.length, 1);
  assert.equal((await service.list({ caller: ADMIN, limit: 100 })).tasks.length, 6);
  await assert.rejects(service.get(created[0].id, AGENT_B), { code: 'TASK_NOT_FOUND' });
  await assert.rejects(service.cancel(created[0].id, AGENT_B), { code: 'TASK_NOT_FOUND' });
});

test('Agent principal names cannot collide with Manager-owned tasks', async (t) => {
  const { service } = await serviceFixture(t);
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'manager-owned-task'
  }, ADMIN);
  await waitFor(async () => (await service.get(task.id, ADMIN)).cleanup.settled);
  const forgedAgent = { role: 'agent', clientId: 'manager-admin' };
  await assert.rejects(service.get(task.id, forgedAgent), { code: 'TASK_ACCESS_DENIED' });
  await assert.rejects(service.cancel(task.id, forgedAgent), { code: 'TASK_ACCESS_DENIED' });
  await assert.rejects(service.resume(task.id, { resumeKey: 'forged-resume-key' }, forgedAgent), {
    code: 'TASK_ACCESS_DENIED'
  });
  assert.equal((await service.getInternal(task.id)).ownerRole, 'manager-admin');
});

test('artifact access is owner-scoped, declaration-only, path-safe, and byte-bounded', async (t) => {
  const { service } = await serviceFixture(t, { withArtifacts: true });
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'artifact:1'
  }, AGENT_A);
  await waitFor(async () => (await service.get(task.id, AGENT_A)).cleanup.settled);

  const artifacts = await service.listArtifacts(task.id, AGENT_A);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].name, 'visible.txt');
  assert.equal(artifacts[0].agentVisible, true);
  assert.equal('filePath' in artifacts[0], false);
  await assert.rejects(service.listArtifacts(task.id, AGENT_B), { code: 'TASK_NOT_FOUND' });

  let offset = 0;
  let text = '';
  do {
    const part = await service.readArtifact(task.id, artifacts[0].id, {
      offset,
      maxBytes: 8
    }, AGENT_A);
    assert.equal(part.encoding, 'utf8');
    assert.ok(Buffer.byteLength(part.chunk, 'utf8') <= 8);
    text += part.chunk;
    offset = part.nextOffset;
    if (part.eof) break;
  } while (true);
  assert.equal(text, 'hello 世界 and more');
  await assert.rejects(
    service.readArtifact(task.id, artifacts[0].id, { offset: 0, maxBytes: 49 * 1024 }, AGENT_A),
    { code: 'INVALID_ARTIFACT_LIMIT' }
  );
});

test('artifact reads stay bound to the validated open file when its pathname is replaced', async (t) => {
  let armed = false;
  let replacementPath;
  let displacedPath;
  const fixture = await serviceFixture(t, {
    withArtifacts: true,
    artifactValidationHook: async ({ stage, candidate }) => {
      if (!armed || stage !== 'after-validation' || path.basename(candidate) !== 'visible.txt') return;
      armed = false;
      await rename(candidate, displacedPath);
      await rename(replacementPath, candidate);
    }
  });
  const task = await fixture.service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'artifact:path-replacement'
  }, AGENT_A);
  await waitFor(async () => (await fixture.service.get(task.id, AGENT_A)).cleanup.settled);
  const [artifact] = await fixture.service.listArtifacts(task.id, AGENT_A);
  replacementPath = path.join(fixture.root, 'outside-secret.txt');
  displacedPath = path.join(fixture.starts[0].outputDir, 'validated-original.txt');
  await writeFile(replacementPath, 'outside secret must not be returned', 'utf8');
  armed = true;

  await assert.rejects(
    fixture.service.readArtifact(task.id, artifact.id, { offset: 0, maxBytes: 48 }, AGENT_A),
    { code: 'ARTIFACT_INTEGRITY_FAILED' }
  );
  assert.equal((await readFile(path.join(fixture.starts[0].outputDir, 'visible.txt'), 'utf8')), 'outside secret must not be returned');
});

test('artifact hardlinks are omitted and cannot expose a file outside the task output', async (t) => {
  const fixture = await serviceFixture(t, { withArtifacts: true });
  const task = await fixture.service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'artifact:hardlink'
  }, AGENT_A);
  await waitFor(async () => (await fixture.service.get(task.id, AGENT_A)).cleanup.settled);
  const [artifact] = await fixture.service.listArtifacts(task.id, AGENT_A);
  const visiblePath = path.join(fixture.starts[0].outputDir, 'visible.txt');
  const secretPath = path.join(fixture.root, 'hardlink-secret.txt');
  await writeFile(secretPath, 'hardlink secret must stay private', 'utf8');
  await rm(visiblePath);
  await link(secretPath, visiblePath);

  await assert.rejects(
    fixture.service.listArtifacts(task.id, AGENT_A),
    { code: 'ARTIFACT_INTEGRITY_FAILED' }
  );
  await assert.rejects(
    fixture.service.readArtifact(task.id, artifact.id, { offset: 0, maxBytes: 48 }, AGENT_A),
    { code: 'ARTIFACT_INTEGRITY_FAILED' }
  );
});

test('terminal worker messages force a non-exiting child to stop and release its Profile lease', async (t) => {
  const { profiles, service, workers } = await serviceFixture(t, {
    terminalWorkerOpen: true,
    diagnosticGraceMs: 20
  });
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'worker:terminal-hang'
  }, AGENT_A);
  const settled = await waitFor(async () => {
    const current = await service.get(task.id, AGENT_A);
    return current.cleanup.settled ? current : null;
  });
  assert.equal(settled.state, 'completed');
  assert.equal(settled.cleanup.workerExited, true);
  assert.equal(settled.cleanup.leaseReleased, true);
  assert.deepEqual(workers[0].killSignals, ['SIGTERM']);
  assert.equal(profiles.profile.lease, null);
});

test('a child error does not release the Profile lease until the still-running worker is terminated', async (t) => {
  const { profiles, service, workers } = await serviceFixture(t, {
    childErrorOpen: true,
    diagnosticGraceMs: 100
  });
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'worker:child-error-hang'
  }, AGENT_A);
  const failedBeforeExit = await waitFor(async () => {
    const current = await service.get(task.id, AGENT_A);
    return current.state === 'failed' ? current : null;
  });
  assert.equal(failedBeforeExit.cleanup.leaseReleased, false);
  const exited = await waitFor(async () => {
    const current = await service.get(task.id, AGENT_A);
    return current.cleanup.workerExited ? current : null;
  });
  assert.equal(exited.cleanup.settled, false);
  assert.equal(exited.cleanup.leaseReleased, false);
  assert.equal(exited.resumeAvailable, false);
  assert.deepEqual(workers[0].killSignals, ['SIGTERM']);
  assert.equal(profiles.profile.lease.ownerId, `task:${task.id}`);
});

test('worker error secrets are redacted before task state is persisted or returned', async (t) => {
  const { root, service } = await serviceFixture(t, {
    terminalError: 'token=token-secret api_key=api-secret session_token=session-secret x-api-key: header-secret'
  });
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'worker:redaction'
  }, AGENT_A);
  const settled = await waitFor(async () => {
    const current = await service.get(task.id, AGENT_A);
    return current.cleanup.settled ? current : null;
  });
  const serialized = JSON.stringify(settled);
  assert.equal(serialized.includes('token-secret'), false);
  assert.equal(serialized.includes('api-secret'), false);
  assert.equal(serialized.includes('session-secret'), false);
  assert.equal(serialized.includes('header-secret'), false);
  assert.match(serialized, /REDACTED/u);
  await service.close();
  const internal = JSON.stringify(await service.getInternal(task.id));
  const persisted = await readFile(path.join(root, 'state', 'tasks', task.id, 'task.json'), 'utf8');
  for (const secret of ['token-secret', 'api-secret', 'session-secret', 'header-secret']) {
    assert.equal(internal.includes(secret), false);
    assert.equal(persisted.includes(secret), false);
  }
});

test('task service defensively redacts an untrusted worker result before persistence', async (t) => {
  const { root, service } = await serviceFixture(t, {
    workerResult: {
      summary: 'api_key=result-api-secret token=result-token-secret',
      evidence: [{ api_key: 'nested-api-secret', note: 'session_token=result-session-secret' }]
    }
  });
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'worker:result-redaction'
  }, AGENT_A);
  await waitFor(async () => (await service.get(task.id, AGENT_A)).cleanup.settled);
  await service.close();
  const internal = JSON.stringify(await service.getInternal(task.id));
  const persisted = await readFile(path.join(root, 'state', 'tasks', task.id, 'task.json'), 'utf8');
  for (const secret of [
    'result-api-secret',
    'result-token-secret',
    'nested-api-secret',
    'result-session-secret'
  ]) {
    assert.equal(internal.includes(secret), false);
    assert.equal(persisted.includes(secret), false);
  }
  assert.match(internal, /REDACTED/u);
});

test('diagnostic screenshots are agent-visible artifacts without exposing local paths', async (t) => {
  const { service } = await serviceFixture(t, { withDiagnostic: true });
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'diagnostic:1'
  }, AGENT_A);
  const terminal = await waitFor(async () => {
    const current = await service.get(task.id, AGENT_A);
    return current.cleanup?.settled ? current : null;
  });
  assert.equal(typeof terminal.lastScreenshot.ref, 'string');
  assert.equal(JSON.stringify(terminal).includes(path.sep + 'screenshots' + path.sep), false);
  const artifacts = await service.listArtifacts(task.id, AGENT_A);
  assert.deepEqual(artifacts.map((artifact) => ({ name: artifact.name, kind: artifact.kind })), [
    { name: 'failure.png', kind: 'diagnostic-screenshot' }
  ]);
});

test('diagnostic manifest recovers screenshot and semantic pointers after IPC loss', async (t) => {
  const { service } = await serviceFixture(t, { withLostDiagnosticManifest: true });
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'diagnostic-manifest-lost-ipc'
  }, AGENT_A);
  const terminal = await waitFor(async () => {
    const current = await service.get(task.id, AGENT_A);
    return current.cleanup?.settled ? current : null;
  });
  assert.equal(typeof terminal.lastScreenshot?.ref, 'string');
  assert.equal(typeof terminal.lastObservation?.ref, 'string');
  assert.equal(JSON.stringify(terminal).includes(path.sep + 'screenshots' + path.sep), false);
  const artifacts = await service.listArtifacts(task.id, AGENT_A);
  assert.deepEqual(artifacts.map((artifact) => [artifact.name, artifact.kind]).sort(), [
    ['lost-ipc.json', 'diagnostic-observation'],
    ['lost-ipc.png', 'diagnostic-screenshot']
  ]);
});

test('diagnostic screenshot remains visible beside the maximum completion evidence list', async (t) => {
  const { service } = await serviceFixture(t, { withDiagnostic: true, withMaxArtifacts: true });
  const task = await service.create({
    profileId: 'profile_fixture',
    taskType: 'fixture',
    idempotencyKey: 'diagnostic:capacity'
  }, AGENT_A);
  await waitFor(async () => (await service.get(task.id, AGENT_A)).cleanup.settled);
  const artifacts = await service.listArtifacts(task.id, AGENT_A);
  assert.equal(artifacts.length, 33);
  assert.equal(artifacts[0].kind, 'diagnostic-screenshot');
  assert.equal(artifacts[0].name, 'failure.png');
});

test('manual Profile open is single-flight under concurrent callers', async (t) => {
  let openWorkers = 0;
  const fixture = await serviceFixture(t);
  const original = fixture.service;
  await original.close();
  const service = createTaskService({
    stateDir: path.join(fixture.root, 'single-flight', 'tasks'),
    profileStore: fixture.profiles,
    allowedTaskRoots: [fixture.allowed],
    seedTaskTypes: [],
    workerFactory(_workerPath, kind) {
      let openMessage;
      const child = new FakeWorker((message, worker) => {
        if (kind === 'profile-open' && message.type === 'open') {
          openMessage = message;
          openWorkers += 1;
          setTimeout(() => worker.emit('message', { type: 'ready' }), 20);
        }
        if (message.type === 'close') setImmediate(() => void (async () => {
          await mkdir(path.dirname(openMessage.cleanupReceiptPath), { recursive: true });
          await writeFile(openMessage.cleanupReceiptPath, `${JSON.stringify({
            version: 1,
            ...openMessage.cleanupReceipt,
            workerPid: worker.pid,
            closedAt: new Date().toISOString()
          })}\n`);
          worker.emit('message', { type: 'closed', browserClosed: true, cleanupReceiptWritten: true });
          worker.finish();
        })());
      });
      return child;
    }
  });
  const opened = await Promise.all(Array.from({ length: 20 }, () => service.openProfile('profile_fixture')));
  assert.equal(openWorkers, 1);
  assert.equal(new Set(opened.map((item) => item.pid)).size, 1);
  await service.closeProfile('profile_fixture');
  await service.close();
});

test('interrupted Profile deletion restores its exact directory on startup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-delete-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'profiles.json');
  const profilesRoot = path.join(root, 'profiles');
  const first = new ProfileStore({ filePath, profilesRoot });
  await first.init();
  const profile = await first.create({ name: 'Recovery fixture' });
  await writeFile(path.join(profile.userDataDir, 'marker.txt'), 'preserve');
  const tombstoneName = `.deleting-${profile.id}-00000000-0000-4000-8000-000000000000`;
  await rename(profile.userDataDir, path.join(profilesRoot, tombstoneName));
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  data.profiles[0].state = 'deleting';
  data.profiles[0].lease = {
    ownerId: 'profile-delete:fixture', pid: 999999, expiresAt: new Date(0).toISOString()
  };
  data.profiles[0].deletion = { tombstoneName, startedAt: new Date(0).toISOString() };
  await writeFile(filePath, `${JSON.stringify(data)}\n`);

  const recovered = new ProfileStore({ filePath, profilesRoot, processAlive: async () => false });
  await recovered.init();
  const current = await recovered.get(profile.id);
  assert.equal(current.state, 'idle');
  assert.equal(current.lease, null);
  assert.equal(current.deletion, undefined);
  await access(path.join(profile.userDataDir, 'marker.txt'));
});

test('Profile deletion keeps its registry tombstone when filesystem removal fails and retries on startup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-delete-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'profiles.json');
  const profilesRoot = path.join(root, 'profiles');
  let injected = false;
  const first = new ProfileStore({
    filePath,
    profilesRoot,
    removePath: async (target, options) => {
      if (!injected && path.basename(target).startsWith('.deleting-')) {
        injected = true;
        throw Object.assign(new Error('directory is busy'), { code: 'EBUSY' });
      }
      return rm(target, options);
    }
  });
  await first.init();
  const profile = await first.create({ name: 'Busy deletion fixture' });
  await writeFile(path.join(profile.userDataDir, 'marker.txt'), 'preserve until retry');
  await assert.rejects(first.remove(profile.id), { code: 'PROFILE_DELETE_IO_FAILED' });

  const persisted = JSON.parse(await readFile(filePath, 'utf8')).profiles[0];
  assert.equal(persisted.id, profile.id);
  assert.equal(persisted.state, 'deleting');
  assert.equal(persisted.deletion.phase, 'moved');
  await access(path.join(profilesRoot, persisted.deletion.tombstoneName, 'marker.txt'));

  const recovered = new ProfileStore({ filePath, profilesRoot, processAlive: async () => false });
  await recovered.init();
  assert.deepEqual(await recovered.list(), []);
  await assert.rejects(access(path.join(profilesRoot, persisted.deletion.tombstoneName)), { code: 'ENOENT' });
});

test('Profile deletion startup finishes a crash after tombstone removal but before registry commit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-delete-post-rm-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'profiles.json');
  const profilesRoot = path.join(root, 'profiles');
  const first = new ProfileStore({ filePath, profilesRoot });
  await first.init();
  const profile = await first.create({ name: 'Post remove crash fixture' });
  const tombstoneName = `.deleting-${profile.id}-00000000-0000-4000-8000-000000000001`;
  await rm(profile.userDataDir, { recursive: true, force: true });
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  data.profiles[0].state = 'deleting';
  data.profiles[0].lease = {
    ownerId: 'profile-delete:fixture', pid: 999999, expiresAt: new Date(0).toISOString()
  };
  data.profiles[0].deletion = {
    tombstoneName,
    startedAt: new Date(0).toISOString(),
    phase: 'moved'
  };
  await writeFile(filePath, `${JSON.stringify(data)}\n`);

  const recovered = new ProfileStore({ filePath, profilesRoot, processAlive: async () => false });
  await recovered.init();
  assert.deepEqual(await recovered.list(), []);
});

test('orphan Profile tombstones fail closed when occupied and are removed on a later startup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-delete-orphan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'profiles.json');
  const profilesRoot = path.join(root, 'profiles');
  await mkdir(profilesRoot, { recursive: true });
  const tombstoneName = `.deleting-profile_${'a'.repeat(32)}-00000000-0000-4000-8000-000000000002`;
  const tombstonePath = path.join(profilesRoot, tombstoneName);
  await mkdir(tombstonePath);
  await writeFile(path.join(tombstonePath, 'marker.txt'), 'orphan');
  const blocked = new ProfileStore({
    filePath,
    profilesRoot,
    removePath: async (target, options) => {
      if (target === tombstonePath) throw Object.assign(new Error('directory is occupied'), { code: 'EBUSY' });
      return rm(target, options);
    }
  });
  await assert.rejects(blocked.init(), { code: 'PROFILE_DELETE_RECOVERY_FAILED' });
  await access(path.join(tombstonePath, 'marker.txt'));

  const recovered = new ProfileStore({ filePath, profilesRoot });
  await recovered.init();
  await assert.rejects(access(tombstonePath), { code: 'ENOENT' });
});
