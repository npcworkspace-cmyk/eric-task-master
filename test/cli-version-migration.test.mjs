import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

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
  const health = await fetch(`${legacy.baseUrl}/v1/health`).then((response) => response.json());
  assert.equal(health.version, VERSION);
  const currentConfig = JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'));
  const newIssue = await fetch(`${legacy.baseUrl}/v1/agents/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${currentConfig.managerToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ clientId: 'upgrade.fixture', name: 'Upgrade fixture' })
  }).then((response) => response.json());
  assert.match(newIssue.agentToken, /^ETMA2\./);
  const scopedProfiles = await fetch(`${legacy.baseUrl}/v1/profiles`, {
    headers: { Authorization: `Bearer ${newIssue.agentToken}` }
  });
  assert.equal(scopedProfiles.status, 200);
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
