import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path, { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { API_VERSION, VERSION } from '../src/contracts.mjs';
import {
  createManagerIdentityProof,
  generateManagerIdentity,
  MANAGER_SERVICE
} from '../src/lib/manager-identity.mjs';
import { createRegistrar } from '../src/registration/index.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

function legacyAgentToken(managerToken, clientId) {
  const encodedClientId = Buffer.from(clientId, 'utf8').toString('base64url');
  const signature = createHmac('sha256', managerToken)
    .update(`ETMA1\0${clientId}`, 'utf8')
    .digest('base64url');
  return `ETMA1.${encodedClientId}.${signature}`;
}

async function startLegacyManager({
  stateDir,
  version = '1.0.4',
  counts = { active: 0, queued: 0, waitingUser: 0, stalled: 0 },
  profiles = []
}) {
  const identity = generateManagerIdentity();
  const managerToken = randomBytes(32).toString('base64url');
  const pid = 424_242;
  let baseUrl;
  let shutdownAuthorized = false;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, baseUrl);
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        sendJson(response, 200, {
          ok: true,
          service: MANAGER_SERVICE,
          version,
          apiVersion: API_VERSION,
          host: '127.0.0.1',
          port: Number(new URL(baseUrl).port),
          pid,
          identityFingerprint: identity.fingerprint,
          counts
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/identity/challenge') {
        const { nonce } = await readJson(request);
        sendJson(response, 200, createManagerIdentityProof(identity, {
          service: MANAGER_SERVICE,
          version,
          apiVersion: API_VERSION,
          host: '127.0.0.1',
          port: Number(new URL(baseUrl).port),
          nonce
        }));
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/profiles') {
        if (request.headers.authorization !== `Bearer ${managerToken}`) {
          sendJson(response, 401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
          return;
        }
        sendJson(response, 200, { profiles });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/agents/issue') {
        if (request.headers.authorization !== `Bearer ${managerToken}`) {
          sendJson(response, 401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
          return;
        }
        const body = await readJson(request);
        sendJson(response, 201, {
          agentToken: legacyAgentToken(managerToken, body.clientId),
          agent: { clientId: body.clientId, name: body.name || body.clientId }
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/manager/shutdown') {
        if (request.headers.authorization !== `Bearer ${managerToken}`) {
          sendJson(response, 401, { error: { code: 'AUTH_REQUIRED', message: 'Authentication required' } });
          return;
        }
        shutdownAuthorized = true;
        await readJson(request);
        sendJson(response, 202, {
          accepted: true,
          state: 'stopping',
          pid,
          identityFingerprint: identity.fingerprint
        });
        setTimeout(() => {
          void unlink(path.join(stateDir, 'manager.json')).catch(() => {});
          server.close();
        }, 20);
        return;
      }
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      sendJson(response, 500, { error: { code: 'FIXTURE_FAILED', message: error.message } });
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  await writeFile(path.join(stateDir, 'config.json'), `${JSON.stringify({
    version: 1,
    managerToken,
    managerIdentity: identity,
    createdAt: new Date().toISOString(),
    extensions: [],
    agents: []
  })}\n`);
  await writeFile(path.join(stateDir, 'manager.json'), `${JSON.stringify({ pid, version, baseUrl })}\n`);
  return {
    baseUrl,
    port: address.port,
    managerToken,
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
    wasShutdownAuthorized: () => shutdownAuthorized
  };
}

async function writeBlockedProfile(stateDir, {
  id,
  kind = 'ephemeral',
  pid,
  retainedData = false,
  ownerId = 'task:interrupted-upgrade'
}) {
  const userDataDir = path.join(stateDir, 'profiles', id);
  await mkdir(userDataDir, { recursive: true });
  if (retainedData) await writeFile(path.join(userDataDir, 'retained.txt'), 'keep');
  const timestamp = new Date().toISOString();
  const profile = {
    id,
    name: `Blocked ${id.slice(-4)}`,
    kind,
    userDataDir,
    defaultBehavior: kind === 'persistent' ? 'human' : 'auto',
    headless: false,
    browserEngine: kind === 'persistent' ? 'chrome' : 'chromium',
    state: 'error',
    lease: {
      ownerId,
      pid,
      acquiredAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: timestamp,
      cleanupRequired: true
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    lastUsedAt: timestamp,
    cleanupUnknownAt: timestamp
  };
  await writeFile(path.join(stateDir, 'profiles.json'), `${JSON.stringify({
    version: 5,
    profiles: [profile]
  }, null, 2)}\n`);
  return profile;
}

async function writeInterruptedTask(stateDir, {
  id,
  profileId,
  workerPid
}) {
  const timestamp = new Date().toISOString();
  const task = {
    id,
    profileId,
    state: 'failed',
    error: {
      code: 'TASK_INTERRUPTED_BY_MANAGER_RESTART',
      message: 'Manager restarted before task cleanup completed; inspect the checkpoint before resuming.'
    },
    progress: { current: 1, total: 2, message: 'Failed' },
    health: { status: 'failed', checkedAt: timestamp },
    cleanup: {
      browserClosed: false,
      leaseReleased: false,
      workerExited: true,
      settled: false,
      managerRestartObserved: true
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    leaseHeld: true,
    leaseOwner: `task:${id}`,
    workerPid
  };
  const taskDir = path.join(stateDir, 'tasks', id);
  await mkdir(taskDir, { recursive: true });
  await writeFile(path.join(taskDir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  return task;
}

test('connect authenticates and gracefully replaces an idle older Manager', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'eric-task-master-cli-upgrade-'));
  const legacy = await startLegacyManager({ stateDir });
  let currentStarted = false;
  t.after(async () => {
    if (currentStarted) {
      await execFileAsync(process.execPath, [
        CLI, 'manager', 'stop', '--host', '127.0.0.1', '--port', String(legacy.port),
        '--state-dir', stateDir, '--json'
      ], { cwd: ROOT }).catch(() => {});
    }
    await legacy.close().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  });

  await writeFile(path.join(stateDir, `acceptance-${VERSION}.json`), `${JSON.stringify({
    ok: true,
    version: VERSION,
    checks: []
  })}\n`);

  const oldIssue = await fetch(`${legacy.baseUrl}/v1/agents/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${legacy.managerToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ clientId: 'upgrade.fixture', name: 'Upgrade fixture' })
  }).then((response) => response.json());
  assert.match(oldIssue.agentToken, /^ETMA1\./);

  const { stdout } = await execFileAsync(process.execPath, [
    CLI, 'connect', '--host', '127.0.0.1', '--port', String(legacy.port),
    '--state-dir', stateDir, '--skip-mcp-registration', '--json'
  ], { cwd: ROOT, timeout: 30_000 });
  const result = JSON.parse(stdout);
  currentStarted = true;

  assert.equal(legacy.wasShutdownAuthorized(), true);
  assert.equal(result.ok, true);
  assert.equal(result.manager.version, VERSION);
  assert.equal(result.manager.migratedFrom, '1.0.4');
  assert.equal(result.manager.startedNow, true);
  assert.equal(result.manager.agentHostReloadRequired, true);
  assert.match(result.nextAction, /reload this Agent host once before MCP verification/u);
  const health = await fetch(`${legacy.baseUrl}/v1/health`).then((response) => response.json());
  assert.equal(health.version, VERSION);
  const currentConfig = JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'));
  const newIssue = await fetch(`${legacy.baseUrl}/v1/agents/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${currentConfig.managerToken}`,
      'Content-Type': 'application/json',
      'X-Taskmaster-Runtime-Version': VERSION
    },
    body: JSON.stringify({ clientId: 'upgrade.fixture', name: 'Upgrade fixture' })
  }).then((response) => response.json());
  assert.match(newIssue.agentToken, /^ETMA2\./);
  const scopedProfiles = await fetch(`${legacy.baseUrl}/v1/profiles`, {
    headers: {
      Authorization: `Bearer ${newIssue.agentToken}`,
      'X-Taskmaster-Runtime-Version': VERSION
    }
  });
  assert.equal(scopedProfiles.status, 200);
});

test('connect requires an Agent host reload after a registration runtime upgrade even when no old Manager is running', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'eric-task-master-cli-offline-upgrade-'));
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  const stateDir = path.join(root, 'manager');
  const registrationStateDir = path.join(root, 'registration');
  const port = await unusedPort();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    HERMES_HOME: path.join(home, '.hermes'),
    WORKBUDDY_HOME: path.join(home, '.workbuddy'),
    CODEBUDDY_HOME: path.join(home, '.codebuddy'),
    GEMINI_CLI_HOME: path.join(home, '.gemini'),
    DSH_HOME: path.join(home, '.dsh'),
    PI_HOME: path.join(home, '.pi'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    PATH: ''
  };
  let managerStarted = false;
  t.after(async () => {
    if (managerStarted) {
      await execFileAsync(process.execPath, [
        CLI, 'manager', 'stop', '--host', '127.0.0.1', '--port', String(port),
        '--state-dir', stateDir, '--json'
      ], { cwd: ROOT, env }).catch(() => {});
    }
    await rm(root, { recursive: true, force: true });
  });

  await mkdir(codexHome, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(codexHome, 'config.toml'), 'model = "test"\n', 'utf8');
  const oldRegistrar = createRegistrar({
    env,
    home,
    projectRoot: ROOT,
    stateDir: registrationStateDir,
    entrypoint: path.join(ROOT, 'src', 'mcp', 'stdio.mjs'),
    executablePath: process.execPath,
    runtimeVersion: '2.1.2'
  });
  const oldRegistration = await oldRegistrar.install({ hostKeys: ['codex'] });
  assert.equal(oldRegistration.ok, true);
  assert.equal(oldRegistration.agentHostReloadRequired, false);
  await writeFile(path.join(stateDir, `acceptance-${VERSION}.json`), `${JSON.stringify({
    ok: true,
    version: VERSION,
    checks: []
  })}\n`, 'utf8');

  const connectArgs = [
    CLI, 'connect', '--host', '127.0.0.1', '--port', String(port),
    '--state-dir', stateDir, '--registration-state-dir', registrationStateDir,
    '--home', home, '--json'
  ];
  const first = JSON.parse((await execFileAsync(process.execPath, connectArgs, {
    cwd: ROOT,
    env,
    timeout: 30_000
  })).stdout);
  managerStarted = true;
  assert.equal(first.manager.startedNow, true);
  assert.equal(first.manager.migratedFrom, undefined);
  assert.equal(first.mcpRegistration.previousRuntimeVersion, '2.1.2');
  assert.equal(first.mcpRegistration.agentHostReloadRequired, true);
  assert.equal(first.manager.agentHostReloadRequired, true);
  assert.equal(first.readyForTasks, false);
  assert.equal(first.state, 'agent_host_reload_required');
  assert.equal(first.blockingAction.code, 'AGENT_HOST_RELOAD_REQUIRED');
  assert.match(first.nextAction, /runtime changed; reload this Agent host once/u);

  const second = JSON.parse((await execFileAsync(process.execPath, connectArgs, {
    cwd: ROOT,
    env,
    timeout: 30_000
  })).stdout);
  assert.equal(second.manager.startedNow, false);
  assert.equal(second.mcpRegistration.agentHostReloadRequired, false);
  assert.equal(second.manager.agentHostReloadRequired, false);
  assert.equal(second.readyForTasks, true);
  assert.equal(second.state, 'ready');
  assert.equal(second.blockingAction, undefined);
});

test('connect leaves a busy older Manager running and fails closed', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'eric-task-master-cli-upgrade-busy-'));
  const legacy = await startLegacyManager({
    stateDir,
    counts: { active: 1, queued: 0, waitingUser: 0, stalled: 0 }
  });
  t.after(async () => {
    await legacy.close().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI, 'connect', '--host', '127.0.0.1', '--port', String(legacy.port),
      '--state-dir', stateDir, '--skip-mcp-registration', '--json'
    ], { cwd: ROOT, timeout: 10_000 }),
    (error) => {
      assert.match(error.stderr, /MANAGER_UPGRADE_BUSY/);
      return true;
    }
  );
  assert.equal(legacy.wasShutdownAuthorized(), false);
  const health = await fetch(`${legacy.baseUrl}/v1/health`).then((response) => response.json());
  assert.equal(health.version, '1.0.4');
});

test('connect safely discards a dead empty task-quarantined ephemeral Profile during upgrade', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'eric-task-master-cli-upgrade-quarantine-'));
  const deadWorker = spawn(process.execPath, ['-e', '']);
  const deadWorkerPid = deadWorker.pid;
  await once(deadWorker, 'exit');
  const taskId = 'task_cccccccccccccccccccccccccccccccc';
  const profile = await writeBlockedProfile(stateDir, {
    id: 'profile_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    pid: deadWorkerPid,
    ownerId: `task:${taskId}`
  });
  await writeInterruptedTask(stateDir, { id: taskId, profileId: profile.id, workerPid: deadWorkerPid });
  const legacy = await startLegacyManager({
    stateDir,
    profiles: [{ id: profile.id, state: profile.state }]
  });
  let currentStarted = false;
  t.after(async () => {
    if (currentStarted) {
      await execFileAsync(process.execPath, [
        CLI, 'manager', 'stop', '--host', '127.0.0.1', '--port', String(legacy.port),
        '--state-dir', stateDir, '--json'
      ], { cwd: ROOT }).catch(() => {});
    }
    await legacy.close().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  });

  await writeFile(path.join(stateDir, `acceptance-${VERSION}.json`), `${JSON.stringify({
    ok: true,
    version: VERSION,
    checks: []
  })}\n`, 'utf8');
  const result = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'connect', '--host', '127.0.0.1', '--port', String(legacy.port),
    '--state-dir', stateDir, '--skip-mcp-registration', '--json'
  ], { cwd: ROOT, timeout: 30_000 })).stdout);
  currentStarted = true;

  assert.equal(legacy.wasShutdownAuthorized(), true);
  assert.equal(result.manager.version, VERSION);
  assert.equal(result.manager.migratedFrom, '1.0.4');
  assert.equal(result.manager.recoveredQuarantinedProfiles, 1);
  const profiles = JSON.parse(await readFile(path.join(stateDir, 'profiles.json'), 'utf8'));
  assert.deepEqual(profiles.profiles, []);
  await assert.rejects(lstat(profile.userDataDir), { code: 'ENOENT' });
  const recoveredTask = JSON.parse(await readFile(path.join(stateDir, 'tasks', taskId, 'task.json'), 'utf8'));
  assert.equal(recoveredTask.leaseHeld, false);
  assert.equal(recoveredTask.cleanup.settled, true);
  assert.equal(recoveredTask.cleanup.quarantinedProfileDiscardRecovered, true);
});

test('connect repairs a legacy discarded quarantine task before starting the current Manager', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'eric-task-master-cli-legacy-quarantine-task-'));
  const port = await unusedPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadWorker = spawn(process.execPath, ['-e', '']);
  const deadWorkerPid = deadWorker.pid;
  await once(deadWorker, 'exit');
  const taskId = 'task_dddddddddddddddddddddddddddddddd';
  const profileId = 'profile_dddddddddddddddddddddddddddddddd';
  const identity = generateManagerIdentity();
  const managerToken = randomBytes(32).toString('base64url');
  const stoppedManager = { pid: deadWorkerPid, version: '2.5.3', baseUrl };
  let managerStarted = false;
  t.after(async () => {
    if (managerStarted) {
      await execFileAsync(process.execPath, [
        CLI, 'manager', 'stop', '--host', '127.0.0.1', '--port', String(port),
        '--state-dir', stateDir, '--json'
      ], { cwd: ROOT }).catch(() => {});
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  await mkdir(path.join(stateDir, 'profiles'), { recursive: true });
  await writeFile(path.join(stateDir, 'config.json'), `${JSON.stringify({
    version: 1,
    managerToken,
    managerIdentity: identity,
    createdAt: new Date().toISOString(),
    extensions: [],
    agents: []
  })}\n`);
  await writeFile(path.join(stateDir, 'profiles.json'), `${JSON.stringify({ version: 5, profiles: [] })}\n`);
  await writeFile(path.join(stateDir, 'manager.json'), `${JSON.stringify(stoppedManager)}\n`);
  await writeFile(path.join(stateDir, 'manager-shutdown-failure.json'), `${JSON.stringify({
    ...stoppedManager,
    trigger: 'api',
    failedAt: new Date().toISOString(),
    error: {
      code: 'SERVICE_SHUTDOWN_UNCONFIRMED',
      message: 'Task service stopped accepting work, but browser cleanup could not be fully confirmed'
    }
  })}\n`);
  await writeInterruptedTask(stateDir, { id: taskId, profileId, workerPid: deadWorkerPid });
  await writeFile(path.join(stateDir, `acceptance-${VERSION}.json`), `${JSON.stringify({
    ok: true,
    version: VERSION,
    checks: []
  })}\n`);

  const result = JSON.parse((await execFileAsync(process.execPath, [
    CLI, 'connect', '--host', '127.0.0.1', '--port', String(port),
    '--state-dir', stateDir, '--skip-mcp-registration', '--json'
  ], { cwd: ROOT, timeout: 30_000 })).stdout);
  managerStarted = true;

  assert.equal(result.ok, true);
  assert.equal(result.manager.version, VERSION);
  assert.equal(result.manager.migratedFrom, '2.5.3');
  assert.equal(result.manager.recoveredQuarantinedTasks, 1);
  const recoveredTask = JSON.parse(await readFile(path.join(stateDir, 'tasks', taskId, 'task.json'), 'utf8'));
  assert.equal(recoveredTask.leaseHeld, false);
  assert.equal(recoveredTask.cleanup.settled, true);
  assert.equal(recoveredTask.cleanup.quarantinedProfileDiscardRecovered, true);
  await assert.rejects(lstat(path.join(stateDir, 'manager-shutdown-failure.json')), { code: 'ENOENT' });
});

test('connect preserves a non-discardable blocked Profile and leaves the older Manager running', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'eric-task-master-cli-upgrade-profile-busy-'));
  const profile = await writeBlockedProfile(stateDir, {
    id: 'profile_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    kind: 'persistent',
    pid: 1
  });
  const legacy = await startLegacyManager({
    stateDir,
    profiles: [{ id: profile.id, state: profile.state }]
  });
  t.after(async () => {
    await legacy.close().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  });

  await assert.rejects(
    execFileAsync(process.execPath, [
      CLI, 'connect', '--host', '127.0.0.1', '--port', String(legacy.port),
      '--state-dir', stateDir, '--skip-mcp-registration', '--json'
    ], { cwd: ROOT, timeout: 10_000 }),
    (error) => {
      assert.match(error.stderr, /MANAGER_UPGRADE_BUSY/);
      return true;
    }
  );
  assert.equal(legacy.wasShutdownAuthorized(), false);
  assert.equal((await fetch(`${legacy.baseUrl}/v1/health`).then((response) => response.json())).version, '1.0.4');
  assert.equal((await lstat(profile.userDataDir)).isDirectory(), true);
});
