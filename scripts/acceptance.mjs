#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManager } from '../src/manager.mjs';
import { createTaskService } from '../src/runtime/task-service.mjs';
import { API_VERSION, TERMINAL_TASK_STATES, VERSION } from '../src/contracts.mjs';
import {
  createIdentityNonce,
  MANAGER_SERVICE,
  verifyManagerIdentityProof
} from '../src/lib/manager-identity.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function api(baseUrl, pathname, {
  method = 'GET', body, token, timeoutMs = 15_000, headers: extraHeaders = {}
} = {}) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extraHeaders
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload.error || payload;
    throw Object.assign(new Error(detail.message || `HTTP ${response.status}`), {
      code: detail.code || `HTTP_${response.status}`
    });
  }
  return payload;
}

async function fixtureServer() {
  const html = await readFile(resolve(ROOT, 'test', 'fixtures', 'acceptance.html'));
  const server = createServer((request, response) => {
    if (request.url === '/' || request.url?.startsWith('/?')) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      response.end(html);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  };
}

async function waitForTask(baseUrl, token, id, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    ({ task } = await api(baseUrl, `/v1/tasks/${encodeURIComponent(id)}`, { token }));
    if (
      TERMINAL_TASK_STATES.has(task.state) &&
      task.cleanup?.settled
    ) return task;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw Object.assign(new Error(`Task ${id} did not finish cleanup`), { code: 'ACCEPTANCE_TASK_TIMEOUT', task });
}

async function waitForTaskState(
  baseUrl,
  token,
  id,
  expectedState,
  timeoutMs = 30_000,
  ready = () => true
) {
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    ({ task } = await api(baseUrl, `/v1/tasks/${encodeURIComponent(id)}`, { token }));
    if (task.state === expectedState && ready(task)) return task;
    if (TERMINAL_TASK_STATES.has(task.state)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  const lastState = task?.state || 'unobserved';
  const lastError = task?.error?.code ? `, error=${task.error.code}` : '';
  throw Object.assign(new Error(
    `Task ${id} did not reach ${expectedState} (lastState=${lastState}${lastError})`
  ), {
    code: 'ACCEPTANCE_TASK_STATE_TIMEOUT',
    task
  });
}

async function readArtifactText(baseUrl, token, taskId, artifactId) {
  const payload = await api(
    baseUrl,
    `/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}?offset=0&maxBytes=${48 * 1024}`,
    { token }
  );
  if (payload.encoding !== 'utf8' || !payload.eof || typeof payload.chunk !== 'string') {
    throw Object.assign(new Error('Acceptance report was not returned as one bounded UTF-8 artifact'), {
      code: 'INVALID_ACCEPTANCE_ARTIFACT'
    });
  }
  return payload.chunk;
}

function evidenceMap(reports) {
  const map = new Map();
  for (const report of reports) {
    for (const item of report.evidence || []) {
      if (!map.has(item.kind)) map.set(item.kind, []);
      map.get(item.kind).push(item);
    }
  }
  return map;
}

export async function runAcceptance({ baseUrl, token, stateDir } = {}) {
  if (!baseUrl || !token || !stateDir) throw new TypeError('runAcceptance requires baseUrl, token, and stateDir');
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), ...(detail ? { detail } : {}) });
  const fixture = await fixtureServer();
  let profile;
  let ephemeralProfile;
    const tasks = [];
    const acceptanceReports = [];
  try {
    const health = await api(baseUrl, '/v1/health');
    add('manager health', health.ok && health.service === 'eric-task-master');
    add('version contract', health.version === VERSION && health.apiVersion === 1, health.version);
    const localConfig = JSON.parse(await readFile(resolve(stateDir, 'config.json'), 'utf8'));
    const nonce = createIdentityNonce();
    const identityProof = await api(baseUrl, '/v1/identity/challenge', {
      method: 'POST',
      body: { nonce }
    });
    const managerUrl = new URL(baseUrl);
    verifyManagerIdentityProof(identityProof, localConfig.managerIdentity, {
      service: MANAGER_SERVICE,
      version: VERSION,
      apiVersion: API_VERSION,
      host: managerUrl.hostname,
      port: Number(managerUrl.port || 80),
      nonce
    });
    add('pinned Manager identity challenge', true);

    const manifest = JSON.parse(await readFile(resolve(ROOT, 'extension', 'manifest.json'), 'utf8'));
    add('extension manifest', manifest.manifest_version === 3 && manifest.version === VERSION);
    const manifestText = JSON.stringify(manifest);
    add(
      'extension control-only boundary',
      !manifestText.includes('debugger') && !manifestText.includes('devtools') && !manifest.content_scripts
    );

    ({ profile } = await api(baseUrl, '/v1/profiles', {
      method: 'POST',
      token,
      body: {
        name: `Acceptance ${Date.now()}`,
        defaultBehavior: 'fast',
        headless: true
      }
    }));
    add('isolated profile creation', profile?.id && profile.state === 'idle' && profile.headless === true);

    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
    const approval = await api(baseUrl, '/v1/pair/authorize', {
      method: 'POST',
      token,
      body: {}
    });
    const challenge = await api(baseUrl, '/v1/pair/challenge', {
      headers: {
        Origin: extensionOrigin,
        'X-Taskmaster-Pairing-Code': approval.pairingCode
      }
    });
    const paired = await api(baseUrl, '/v1/pair/extension', {
      method: 'POST',
      headers: { Origin: extensionOrigin },
      body: {
        challenge: challenge.challenge,
        pairingCode: approval.pairingCode,
        name: 'Acceptance extension'
      }
    });
    add('extension challenge pairing', typeof paired.token === 'string' && paired.token.length >= 32);

    const fixtureOrigin = new URL(fixture.url).origin;
    const secretMarker = 'secret-must-not-echo';
    const imported = await api(baseUrl, `/v1/profiles/${encodeURIComponent(profile.id)}/session`, {
      method: 'POST',
      token: paired.token,
      headers: { Origin: extensionOrigin },
      timeoutMs: 60_000,
      body: {
        origin: fixtureOrigin,
        cookies: [{
          name: 'taskmaster_imported',
          value: 'accepted',
          domain: '127.0.0.1',
          path: '/',
          hostOnly: true,
          session: true,
          httpOnly: false,
          secure: false,
          sameSite: 'lax'
        }, {
          name: 'taskmaster_private_marker',
          value: secretMarker,
          domain: '127.0.0.1',
          path: '/',
          hostOnly: true,
          session: true,
          httpOnly: true,
          secure: false,
          sameSite: 'lax'
        }],
        localStorage: [{ name: 'taskmaster_imported', value: 'accepted' }],
        source: { extensionId: 'ignored-by-manager', tabUrl: fixtureOrigin }
      }
    });
    add(
      'session bridge privacy and import',
      imported.status === 'partial' &&
      imported.verification === 'storage_replaced_not_login_verified' &&
      imported.cookieCount === 2 &&
      imported.localStorageCount === 1 &&
      imported.sessionCookieRetentionHours === 12 &&
      !JSON.stringify(imported).includes(secretMarker)
    );

    const uploadPath = resolve(ROOT, 'test', 'fixtures', 'upload.txt');
    const acceptanceRunId = Date.now().toString(36);
    for (const behavior of ['fast', 'human', 'adaptive']) {
      const created = await api(baseUrl, '/v1/tasks', {
        method: 'POST',
        token,
        body: {
          profileId: profile.id,
          taskType: 'acceptance',
          idempotencyKey: `acceptance-${acceptanceRunId}-${behavior}`,
          behavior,
          timeoutMs: 90_000,
          input: { url: fixture.url, uploadPath, expectedSession: true }
        }
      });
      const task = await waitForTask(baseUrl, token, created.task.id);
      tasks.push(task);
      add(
        `${behavior} behavior task`,
        task.state === 'completed',
        task.error ? `${task.error.code}: ${task.error.message}` : undefined
      );
    }

    for (const task of tasks) {
      const { artifacts } = await api(baseUrl, `/v1/tasks/${encodeURIComponent(task.id)}/artifacts`, { token });
      const expected = new Set(['acceptance.json', 'acceptance.png', 'taskmaster-fixture.txt']);
      const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
      if ([...expected].some((name) => !byName.has(name) || byName.get(name).sizeBytes <= 0)) {
        throw Object.assign(new Error(`Acceptance artifacts are incomplete for ${task.id}`), {
          code: 'ACCEPTANCE_ARTIFACT_MISSING'
        });
      }
      const report = JSON.parse(await readArtifactText(
        baseUrl,
        token,
        task.id,
        byName.get('acceptance.json').id
      ));
      if (!report.passed || report.behavior !== task.behavior) {
        throw Object.assign(new Error(`Acceptance report does not match task ${task.id}`), {
          code: 'ACCEPTANCE_ARTIFACT_MISMATCH'
        });
      }
      acceptanceReports.push(report);
    }
    add('bounded artifact API', true);

    const evidence = evidenceMap(acceptanceReports);
    const allTrue = (kind) => evidence.get(kind)?.length === 3 && evidence.get(kind).every((item) => item.ok);
    add('navigation', allTrue('navigation'));
    add('text input', allTrue('input'));
    add('human behavior mechanics', allTrue('behavior'));
    add('click and select', allTrue('checkbox') && allTrue('select'));
    add('file upload', allTrue('upload'));
    add('cookie and local storage', allTrue('cookie') && allTrue('localStorage'));
    add(
      'imported session persisted',
      allTrue('session-import-cookie') && allTrue('session-import-storage')
    );
    add('file download', allTrue('download'));
    add('screenshot fallback primitive', allTrue('screenshot'));
    add(
      'progress and heartbeat',
      tasks.every((task) => task.progress?.current === 9 && task.progress?.total === 9 && task.heartbeatAt)
    );
    add(
      'checkpoint and compact evidence',
      tasks.every((task) => task.checkpoint?.ref && task.result?.evidence?.length === 4) &&
      acceptanceReports.every((report) => Array.isArray(report.evidence) && report.evidence.length >= 10)
    );

    ({ profile: ephemeralProfile } = await api(baseUrl, '/v1/profiles', {
      method: 'POST',
      token,
      body: {
        name: `Ephemeral acceptance ${Date.now()}`,
        kind: 'ephemeral',
        defaultBehavior: 'adaptive',
        headless: true
      }
    }));
    add(
      'ephemeral Profile creation',
      ephemeralProfile?.id && ephemeralProfile.kind === 'ephemeral' && ephemeralProfile.state === 'idle'
    );

    for (const operation of ['open', 'session']) {
      let rejected = false;
      try {
        await api(baseUrl, `/v1/profiles/${encodeURIComponent(ephemeralProfile.id)}/${operation}`, {
          method: 'POST',
          token: operation === 'session' ? paired.token : token,
          ...(operation === 'session' ? {
            headers: { Origin: extensionOrigin },
            body: {
              origin: fixtureOrigin,
              cookies: [],
              localStorage: [],
              source: { tabUrl: fixtureOrigin }
            }
          } : { body: {} })
        });
      } catch (error) {
        rejected = error.code === (
          operation === 'open'
            ? 'EPHEMERAL_PROFILE_OPEN_UNSUPPORTED'
            : 'EPHEMERAL_PROFILE_SESSION_UNSUPPORTED'
        );
      }
      add(`ephemeral Profile rejects ${operation}`, rejected);
    }

    const ephemeralTasks = [];
    const ephemeralReports = [];
    for (let index = 0; index < 2; index += 1) {
      const created = await api(baseUrl, '/v1/tasks', {
        method: 'POST',
        token,
        body: {
          profileId: ephemeralProfile.id,
          taskType: 'acceptance',
          idempotencyKey: `acceptance-${acceptanceRunId}-ephemeral-${index}`,
          behavior: 'adaptive',
          timeoutMs: 90_000,
          input: { url: fixture.url, uploadPath, expectCleanStart: true }
        }
      });
      const task = await waitForTask(baseUrl, token, created.task.id);
      ephemeralTasks.push(task);
      const { artifacts } = await api(baseUrl, `/v1/tasks/${encodeURIComponent(task.id)}/artifacts`, { token });
      const reportArtifact = artifacts.find((artifact) => artifact.name === 'acceptance.json');
      if (!reportArtifact) {
        throw Object.assign(new Error(`Ephemeral acceptance report is missing for ${task.id}`), {
          code: 'ACCEPTANCE_ARTIFACT_MISSING'
        });
      }
      ephemeralReports.push(JSON.parse(await readArtifactText(
        baseUrl,
        token,
        task.id,
        reportArtifact.id
      )));
    }
    add(
      'ephemeral task isolation',
      ephemeralTasks.every((task) => task.state === 'completed') &&
      ephemeralReports.length === ephemeralTasks.length &&
      ephemeralReports.every((report) => (
        report.passed === true &&
        report.evidence?.some((item) => item.kind === 'ephemeral-clean-start' && item.ok)
      ))
    );

    const handoffCreated = await api(baseUrl, '/v1/tasks', {
      method: 'POST',
      token,
      body: {
        profileId: ephemeralProfile.id,
        taskType: 'handoff-acceptance',
        idempotencyKey: `acceptance-${acceptanceRunId}-handoff`,
        behavior: 'adaptive',
        timeoutMs: 90_000,
        input: { url: fixture.url }
      }
    });
    const waiting = await waitForTaskState(
      baseUrl,
      token,
      handoffCreated.task.id,
      'waiting_user',
      60_000,
      (task) => Boolean(task.lastScreenshot?.ref && task.lastObservation?.ref)
    );
    const waitingArtifacts = await api(
      baseUrl,
      `/v1/tasks/${encodeURIComponent(waiting.id)}/artifacts`,
      { token }
    );
    add(
      'waiting_user diagnostics',
      waiting.userRequest?.status === 'pending' &&
      waiting.lastScreenshot?.ref &&
      waiting.lastObservation?.ref &&
      waitingArtifacts.artifacts.some((item) => item.kind === 'diagnostic-screenshot') &&
      waitingArtifacts.artifacts.some((item) => item.kind === 'diagnostic-observation')
    );
    await api(baseUrl, `/v1/tasks/${encodeURIComponent(waiting.id)}/continue`, {
      method: 'POST',
      token,
      body: { requestId: waiting.userRequest.id, note: 'acceptance-continue' }
    });
    const handoffTask = await waitForTask(baseUrl, token, waiting.id);
    add(
      'waiting_user same-task continuation',
      handoffTask.state === 'completed' &&
      handoffTask.id === waiting.id &&
      handoffTask.userRequest?.status === 'continued'
    );
    add(
      'ephemeral Profile leaves no browser state',
      (await readdir(resolve(stateDir, 'profiles', ephemeralProfile.id))).length === 0
    );

    await api(baseUrl, `/v1/profiles/${encodeURIComponent(ephemeralProfile.id)}`, { method: 'DELETE', token });
    ephemeralProfile = null;

    await api(baseUrl, `/v1/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE', token });
    const remaining = await api(baseUrl, '/v1/profiles', { token });
    add(
      'browser and profile cleanup',
      tasks.every((task) => task.cleanup?.browserClosed && task.cleanup?.leaseReleased && task.cleanup?.workerExited && task.cleanup?.settled) &&
      !remaining.profiles.some((item) => item.id === profile.id)
    );
    profile = null;
  } catch (error) {
    add('acceptance execution', false, `${error.code || 'ERROR'}: ${error.message}`);
  } finally {
    if (profile?.id) {
      await api(baseUrl, `/v1/profiles/${encodeURIComponent(profile.id)}/close`, { method: 'POST', token }).catch(() => {});
      await api(baseUrl, `/v1/profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE', token }).catch(() => {});
    }
    if (ephemeralProfile?.id) {
      await api(baseUrl, `/v1/profiles/${encodeURIComponent(ephemeralProfile.id)}`, { method: 'DELETE', token }).catch(() => {});
    }
    await fixture.close();
  }

  const passed = checks.filter((check) => check.passed).length;
  const result = {
    ok: passed === checks.length,
    version: VERSION,
    passed,
    total: checks.length,
    checks,
    checkedAt: new Date().toISOString(),
    nextAction: passed === checks.length
      ? 'List profiles, then ask for the browser task.'
      : 'Read the first failed check, correct that cause, and rerun the same acceptance command.'
  };
  return result;
}

async function directRun() {
  const stateDir = await mkdtemp(join(tmpdir(), 'eric-task-master-acceptance-'));
  let manager;
  try {
    manager = await startManager({
      host: '127.0.0.1',
      port: 0,
      dataDir: stateDir,
      dashboardDir: resolve(ROOT, 'dashboard'),
      taskServiceFactory(taskOptions) {
        return createTaskService(taskOptions);
      }
    });
    const result = await runAcceptance({ baseUrl: manager.baseUrl, token: manager.token, stateDir });
    if (process.env.TASKMASTER_ACCEPTANCE_REPORT) {
      const reportPath = resolve(process.env.TASKMASTER_ACCEPTANCE_REPORT);
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await manager?.stop().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  directRun().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      error: { code: error.code || 'ACCEPTANCE_CRASHED', message: error.message },
      nextAction: 'Install Playwright Chromium and rerun npm run acceptance.'
    })}\n`);
    process.exitCode = 1;
  });
}
