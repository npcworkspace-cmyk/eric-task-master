import { startStdioServer } from '../../../src/mcp/stdio.mjs';

const task = {
  id: 'task_fixture',
  jobId: 'job_fixture',
  revision: 3,
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

let profileCreateCalls = 0;

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
  async createProfile(input) {
    profileCreateCalls += 1;
    return {
      ...profile,
      name: input.name,
      createdBy: `fixture-call-${profileCreateCalls}`,
      lastUsedAt: null,
      lastOpenedAt: null
    };
  },
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
  async openDashboard(taskId) {
    return {
      ...(taskId ? { taskId } : {}),
      dashboardUrl: `http://127.0.0.1:19946/dashboard${taskId ? `?task=${taskId}` : ''}#code=${'a'.repeat(32)}`
    };
  },
  async startTask(input) {
    const startedTask = { ...task, taskType: input.taskType, profileId: input.profileId };
    return {
      taskId: startedTask.id,
      dashboardUrl: `http://127.0.0.1:19946/dashboard?task=${startedTask.id}#code=${'b'.repeat(32)}`,
      task: startedTask
    };
  },
  async listTasks() { return { tasks: [task], nextCursor: 'next_fixture' }; },
  async getTask() { return task; },
  async waitTask(_taskId, { onProgress }) {
    await onProgress?.(task.progress, task);
    return { task, timedOut: true };
  },
  async claimInbox() {
    return {
      commands: [{
        taskId: task.id,
        revision: task.revision,
        command: {
          commandId: 'command_fixture',
          kind: 'ask',
          status: 'delivered',
          expectedRevision: task.revision,
          payload: { message: 'What should happen next?' },
          payloadHash: 'do-not-return'
        }
      }],
      total: 1
    };
  },
  async respondTaskCommand(input) {
    return {
      task,
      command: {
        commandId: input.commandId,
        kind: 'ask',
        status: input.status,
        expectedRevision: input.expectedRevision,
        response: input.message
      }
    };
  },
  async publishTaskReport(input) {
    return {
      task: {
        ...task,
        report: {
          reportId: input.reportId,
          status: input.status,
          title: input.title,
          summary: input.summary,
          sections: input.sections
        }
      }
    };
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
