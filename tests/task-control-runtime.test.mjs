import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { createCooperativePauseGate } from '../src/runtime/task-worker.mjs';

const AGENT = Object.freeze({ role: 'agent', clientId: 'agent.control.test', agentName: 'Control Test' });
const ADMIN = Object.freeze({ role: 'manager-admin', clientId: 'manager-admin' });
let nextPid = 91_000;

class ControlWorker extends EventEmitter {
  constructor() {
    super();
    this.pid = nextPid += 1;
    this.connected = true;
    this.exitCode = null;
    this.messages = [];
  }

  send(message, _handle, _options, callback) {
    this.messages.push(message);
    callback?.();
    if (message.type === 'start') {
      setImmediate(() => this.emit('message', { type: 'state', state: 'running' }));
    } else if (message.type === 'pause') {
      setImmediate(() => {
        this.emit('message', { type: 'state', state: 'pause_requested', commandId: message.commandId });
        this.emit('message', { type: 'state', state: 'paused', commandId: message.commandId });
      });
    } else if (message.type === 'resume_pause') {
      setImmediate(() => {
        this.emit('message', { type: 'state', state: 'recovering', commandId: message.commandId });
        this.emit('message', { type: 'state', state: 'running', commandId: message.commandId });
      });
    } else if (message.type === 'continue') {
      setTimeout(() => this.emit('message', { type: 'state', state: 'running' }), 10);
    } else if (message.type === 'focus') {
      setImmediate(() => this.emit('message', {
        type: 'focus_applied',
        requestId: message.requestId,
        at: '2026-08-29T00:00:00.000Z'
      }));
    } else if (message.type === 'cancel') {
      setImmediate(() => {
        this.emit('message', {
          type: 'error',
          state: 'cancelled',
          error: { code: 'TASK_CANCELLED', message: 'Task was cancelled' }
        });
        this.emit('message', { type: 'cleanup', browserClosed: true });
        this.finish();
      });
    }
  }

  finish() {
    if (this.exitCode !== null) return;
    this.exitCode = 0;
    this.connected = false;
    this.emit('exit', 0, null);
  }

  kill() {
    this.finish();
    return true;
  }
}

function fakeProfiles(root) {
  const profile = {
    id: 'profile_control',
    name: 'Control',
    kind: 'ephemeral',
    browserEngine: 'chromium',
    defaultBehavior: 'fast',
    userDataDir: path.join(root, 'profile'),
    state: 'idle',
    lease: null
  };
  return {
    async get(id) {
      if (id !== profile.id) throw new Error('profile not found');
      return structuredClone(profile);
    },
    async acquireLease(id, ownerId, options) {
      if (id !== profile.id || (profile.lease && profile.lease.ownerId !== ownerId)) throw new Error('profile leased');
      profile.lease = { ownerId, pid: options.pid, cleanupRequired: true };
      profile.state = 'leased';
      return structuredClone(profile);
    },
    async releaseLease(id, ownerId) {
      if (id !== profile.id || profile.lease?.ownerId !== ownerId) return false;
      profile.lease = null;
      profile.state = 'idle';
      return true;
    }
  };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition not reached');
}

test('cooperative pause settles the active action, gates the next action, and validates resume', async () => {
  const states = [];
  let diagnostics = 0;
  let validations = 0;
  let releaseFirst;
  const firstAction = new Promise((resolve) => { releaseFirst = resolve; });
  const gate = createCooperativePauseGate({
    onState: async (state) => states.push(state),
    onPaused: async () => { diagnostics += 1; },
    onResumeValidate: async () => { validations += 1; }
  });

  const first = gate.run(() => firstAction);
  await waitFor(() => gate.activeActions === 1);
  const pause = await gate.requestPause('pause-cmd-001');
  assert.equal(pause.state, 'pause_requested');
  assert.deepEqual(states, ['pause_requested']);

  let secondStarted = false;
  const second = gate.run(async () => { secondStarted = true; return 'second'; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondStarted, false);
  releaseFirst('first');
  assert.equal(await first, 'first');
  await waitFor(() => gate.state === 'paused');
  assert.equal(diagnostics, 1);
  assert.equal(secondStarted, false);

  await gate.requestResume('resume-cmd-001');
  assert.equal(await second, 'second');
  assert.equal(validations, 1);
  assert.deepEqual(states, ['pause_requested', 'paused', 'recovering', 'running']);
});

test('task controls are durable, revision-checked, idempotent, and cancellation waits for cleanup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-control-'));
  const allowed = path.join(root, 'allowed');
  await mkdir(allowed, { recursive: true });
  const modulePath = path.join(allowed, 'control.mjs');
  await writeFile(modulePath, [
    "export const meta = { name: 'control', version: '1.0.0', inputSchema: { type: 'object', additionalProperties: true } };",
    "export async function run() { return { summary: 'ok', evidence: [{ kind: 'message', value: 'ok' }] }; }"
  ].join('\n'));
  const workers = [];
  const service = createTaskService({
    stateDir: path.join(root, 'state', 'tasks'),
    profileStore: fakeProfiles(root),
    allowedTaskRoots: [allowed],
    seedTaskTypes: [{ name: 'control', modulePath }],
    workerCleanupGraceMs: 200,
    workerHardKillGraceMs: 100,
    workerFactory() {
      const worker = new ControlWorker();
      workers.push(worker);
      return worker;
    }
  });
  t.after(async () => {
    await service.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const created = await service.create({
    profileId: 'profile_control',
    taskType: 'control',
    input: { url: 'https://example.test' },
    idempotencyKey: 'control-task-001'
  }, AGENT);
  await waitFor(async () => (await service.getInternal(created.id)).state === 'running');

  const handoffId = 'handoff_0123456789abcdef0123456789abcdef';
  workers[0].emit('message', {
    type: 'waiting_user',
    request: {
      id: handoffId,
      kind: 'human_verification',
      reason: 'The site requires a human verification step',
      instructions: 'Complete the visible verification in the same task page.',
      requestedAt: '2026-08-29T00:00:00.000Z',
      expiresAt: '2026-08-29T01:00:00.000Z',
      screenshotAvailable: true
    }
  });
  await waitFor(async () => (await service.getInternal(created.id)).state === 'waiting_user');
  let visible = await service.get(created.id, AGENT);
  assert.equal(visible.userRequest.kind, 'human_verification');
  assert.equal(visible.userRequest.status, 'pending');
  await assert.rejects(
    service.claimUserRequest(created.id, {
      requestId: 'handoff_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    }, AGENT),
    { code: 'USER_HANDOFF_MISMATCH' }
  );
  await assert.rejects(
    service.claimUserRequest(created.id, { requestId: handoffId }, AGENT),
    { code: 'USER_HANDOFF_CLAIM_FORBIDDEN' }
  );
  await assert.rejects(
    service.continueTask(created.id, { requestId: handoffId }, AGENT),
    { code: 'USER_HANDOFF_OWNER_CLAIM_REQUIRED' }
  );
  visible = await service.claimUserRequest(created.id, { requestId: handoffId }, ADMIN);
  assert.equal(visible.userRequest.status, 'claimed');
  assert.ok(visible.userRequest.claimedAt);
  const focused = await service.focusTask(created.id, AGENT);
  assert.equal(focused.task.id, created.id);
  assert.equal(focused.focusedAt, '2026-08-29T00:00:00.000Z');
  assert.ok(workers[0].messages.some((message) => message.type === 'focus'));
  const continued = await service.continueTask(created.id, {
    requestId: handoffId,
    note: 'Human verification is complete; revalidate before continuing.'
  }, AGENT);
  assert.equal(continued.id, created.id);
  assert.equal(continued.userRequest.kind, 'human_verification');
  assert.equal(continued.userRequest.status, 'continued');
  await waitFor(async () => (await service.getInternal(created.id)).state === 'running');

  const instructionId = 'handoff_fedcba9876543210fedcba9876543210';
  workers[0].emit('message', {
    type: 'waiting_user',
    request: {
      id: instructionId,
      kind: 'instruction',
      reason: 'The task needs a bounded instruction',
      requestedAt: '2026-08-29T00:01:00.000Z'
    }
  });
  await waitFor(async () => (await service.getInternal(created.id)).state === 'waiting_user');
  visible = await service.claimUserRequest(created.id, { requestId: instructionId }, AGENT);
  assert.equal(visible.userRequest.kind, 'instruction');
  assert.equal(visible.userRequest.status, 'claimed');
  await service.continueTask(created.id, { requestId: instructionId }, AGENT);
  await waitFor(async () => (await service.getInternal(created.id)).state === 'running');

  await service.pauseTask(created.id, { commandId: 'pause-cmd-001', expectedRevision: 1 }, AGENT);
  await waitFor(async () => (await service.getInternal(created.id)).state === 'paused');
  let internal = await service.getInternal(created.id);
  assert.equal(internal.revision, 2);
  assert.equal(internal.commands.find((item) => item.commandId === 'pause-cmd-001').status, 'applied');

  // A transport replay returns the original command even though its expected
  // revision is now stale.
  await service.pauseTask(created.id, { commandId: 'pause-cmd-001', expectedRevision: 1 }, AGENT);
  assert.equal((await service.getInternal(created.id)).revision, 2);
  await assert.rejects(
    service.submitTaskCommand(created.id, {
      commandId: 'modify-cmd-stale',
      expectedRevision: 1,
      kind: 'modify',
      message: 'Use a different extraction plan'
    }, AGENT),
    { code: 'TASK_REVISION_CONFLICT' }
  );
  await assert.rejects(
    service.reviseQueuedTask(created.id, {
      commandId: 'revise-running-001',
      expectedRevision: 2,
      input: { url: 'https://changed.example.test' }
    }, AGENT),
    { code: 'TASK_INPUT_IMMUTABLE' }
  );

  await service.submitTaskCommand(created.id, {
    commandId: 'modify-cmd-001',
    expectedRevision: 2,
    kind: 'modify',
    message: 'Use a different extraction plan'
  }, AGENT);
  const inbox = await service.claimAgentInbox({}, AGENT);
  assert.equal(inbox.commands.length, 1);
  assert.equal(inbox.commands[0].command.status, 'delivered');
  await service.respondTaskCommand(created.id, 'modify-cmd-001', {
    expectedRevision: 3,
    status: 'acknowledged',
    message: 'Will replan as a new run; current input remains immutable'
  }, AGENT);
  internal = await service.getInternal(created.id);
  assert.deepEqual(internal.input, { url: 'https://example.test' });
  assert.equal(internal.revision, 4);

  await service.publishTaskReport(created.id, {
    reportId: 'report-001',
    expectedRevision: 4,
    status: 'final',
    title: 'Control task report',
    summary: 'The task remains paused and its original input was not modified.',
    sections: [{ heading: 'Outcome', body: 'A durable final report was published.' }]
  }, AGENT);
  assert.equal((await service.getInternal(created.id)).report.status, 'final');
  const publicTask = await service.get(created.id, AGENT);
  assert.equal(publicTask.commands.some((command) => Object.hasOwn(command, 'payloadHash')), false);
  assert.equal(Object.hasOwn(publicTask.report, 'reportHash'), false);

  await service.resumePausedTask(created.id, { commandId: 'resume-cmd-001', expectedRevision: 5 }, AGENT);
  await waitFor(async () => (await service.getInternal(created.id)).state === 'running');
  await service.terminateTask(created.id, { commandId: 'terminate-cmd-001', expectedRevision: 6 }, AGENT);
  const requested = await service.getInternal(created.id);
  assert.ok(['cancel_requested', 'cancelled'].includes(requested.state));
  if (requested.state === 'cancel_requested') assert.equal(requested.cleanup.settled, false);

  const cancelled = await waitFor(async () => {
    const task = await service.getInternal(created.id);
    return task.state === 'cancelled' ? task : null;
  });
  assert.equal(cancelled.cleanup.settled, true);
  assert.equal(cancelled.commands.find((item) => item.commandId === 'terminate-cmd-001').status, 'applied');
  assert.ok(cancelled.timeline.some((event) => event.type === 'task.cancelled'));
  await assert.rejects(service.focusTask(created.id, AGENT), { code: 'TASK_FOCUS_UNAVAILABLE' });
});
