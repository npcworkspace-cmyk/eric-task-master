import { startStdioServer } from '../../../src/mcp/stdio.mjs';

const task = {
  id: 'task_fixture',
  profileId: 'profile_fixture',
  taskType: 'fixture.read',
  behavior: 'fast',
  state: 'running',
  progress: { current: 1, total: 2, message: 'Fixture progress' },
  cleanup: { browserClosed: false, leaseReleased: false, workerExited: false, settled: false },
  lastScreenshot: {
    reason: 'action-click',
    at: '2026-08-24T00:00:00.000Z',
    ref: 'taskmaster://tasks/task_fixture/screenshot'
  },
  result: {
    summary: 'Fixture task',
    evidence: [
      { kind: 'count', value: 1 },
      { kind: 'url', value: 'https://example.com/path?token=secret' }
    ]
  },
  modulePath: 'C:\\secret\\task.mjs',
  outputDir: 'C:\\secret\\outputs',
  managerToken: 'do-not-return',
  error: { code: 'FIXTURE_ERROR', message: 'Bearer do-not-return' }
};

const profile = {
  id: 'profile_fixture',
  name: 'Fixture',
  state: 'open',
  defaultBehavior: 'fast',
  access: 'private',
  lastUsedAt: '2026-08-24T00:00:00.000Z',
  userDataDir: 'C:\\secret\\profile',
  lease: { token: 'do-not-return' }
};

const client = {
  async getStatus() {
    return {
      ok: true,
      service: 'eric-task-master',
      version: '0.0.2',
      apiVersion: 1,
      pid: 42,
      managerToken: 'do-not-return'
    };
  },
  async listProfiles() { return [profile]; },
  async createProfile(input) { return { ...profile, name: input.name }; },
  async updateProfile(_profileId, patch) { return { ...profile, ...patch }; },
  async openProfile() { return profile; },
  async closeProfile() { return { ...profile, state: 'idle' }; },
  async listTaskTypes() {
    return [{
      id: 'fixture.read',
      title: 'Fixture reader',
      readOnly: true,
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      modulePath: 'C:\\secret\\task.mjs'
    }];
  },
  async describeTaskType(name) {
    return {
      id: name,
      title: 'Fixture reader',
      readOnly: true,
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } }
    };
  },
  async startTask(input) { return { ...task, taskType: input.taskType, profileId: input.profileId }; },
  async listTasks() { return { tasks: [task], nextCursor: 'next_fixture' }; },
  async getTask() { return task; },
  async waitTask(_taskId, { onProgress }) {
    await onProgress?.(task.progress, task);
    return { task, timedOut: true };
  },
  async continueTask() { return { ...task, state: 'recovering' }; },
  async resumeTask() {
    return {
      task: { ...task, attempt: 2, state: 'queued' },
      notice: 'Inspect unknown external action outcomes before retrying.'
    };
  },
  async cancelTask() { return { ...task, state: 'cancelled' }; },
  async listArtifacts() {
    return [
      { id: 'artifact_visible', name: 'result.txt', mimeType: 'text/plain', sizeBytes: 7, agentVisible: true },
      { id: 'artifact_hidden', name: 'cookies.txt', mimeType: 'text/plain', sizeBytes: 100, agentVisible: false }
    ];
  },
  async readArtifact({ artifactId, offset }) {
    return {
      artifact: { id: artifactId, name: 'result.txt', mimeType: 'text/plain', sizeBytes: 7, agentVisible: true },
      offset,
      nextOffset: offset + 7,
      eof: true,
      encoding: 'utf8',
      chunk: 'fixture'
    };
  }
};

startStdioServer({ clientFactory: () => client });
