import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VERSION } from '../src/contracts.mjs';
import {
  createIdentityNonce,
  createManagerIdentityProof,
  generateManagerIdentity,
  MANAGER_SERVICE,
  verifyManagerIdentityProof
} from '../src/lib/manager-identity.mjs';
import { HttpError } from '../src/lib/http-utils.mjs';
import { startManager } from '../src/manager.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');
const ADMIN_TOKEN = `manager-admin-${'s'.repeat(40)}`;

function reply(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': body.length
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('Manager generates one persistent Ed25519 identity and signs a bound nonce challenge', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'taskmaster-identity-state-'));
  let manager;
  t.after(async () => {
    await manager?.stop().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  });

  manager = await startManager({ port: 0, dataDir: stateDir, taskService: {} });
  const firstConfig = JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'));
  assert.equal(firstConfig.managerIdentity.algorithm, 'Ed25519');
  assert.match(firstConfig.managerIdentity.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(firstConfig.managerIdentity.fingerprint, /^[A-Za-z0-9_-]{43}$/);

  const nonce = createIdentityNonce();
  const proof = await fetch(new URL('/v1/identity/challenge', manager.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce })
  }).then((response) => response.json());
  const binding = {
    service: MANAGER_SERVICE,
    version: VERSION,
    apiVersion: 1,
    host: '127.0.0.1',
    port: manager.address().port,
    nonce
  };
  assert.deepEqual(verifyManagerIdentityProof(proof, firstConfig.managerIdentity, binding), {
    algorithm: 'Ed25519',
    publicKey: firstConfig.managerIdentity.publicKey,
    fingerprint: firstConfig.managerIdentity.fingerprint
  });
  assert.equal(JSON.stringify(proof).includes(firstConfig.managerIdentity.privateKey), false);
  assert.equal(JSON.stringify(proof).includes(firstConfig.managerToken), false);

  const replayNonce = createIdentityNonce();
  assert.throws(
    () => verifyManagerIdentityProof(proof, firstConfig.managerIdentity, { ...binding, nonce: replayNonce }),
    { code: 'MANAGER_IDENTITY_BINDING_MISMATCH' }
  );
  for (const changed of [
    { service: 'fake-service' },
    { version: '999.0.0' },
    { host: 'localhost' },
    { port: binding.port === 65_535 ? 65_534 : binding.port + 1 }
  ]) {
    assert.throws(
      () => verifyManagerIdentityProof(proof, firstConfig.managerIdentity, { ...binding, ...changed }),
      { code: 'MANAGER_IDENTITY_BINDING_MISMATCH' }
    );
  }
  assert.throws(
    () => verifyManagerIdentityProof(proof, generateManagerIdentity(), binding),
    { code: 'MANAGER_IDENTITY_MISMATCH' }
  );

  await manager.stop();
  manager = await startManager({ port: 0, dataDir: stateDir, taskService: {} });
  const secondConfig = JSON.parse(await readFile(path.join(stateDir, 'config.json'), 'utf8'));
  assert.deepEqual(secondConfig.managerIdentity, firstConfig.managerIdentity);
});

test('CLI exposes no admin token to a same-port fake Manager with the wrong key', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'taskmaster-cli-fake-manager-'));
  const pinnedIdentity = generateManagerIdentity();
  const attackerIdentity = generateManagerIdentity();
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({
    managerToken: ADMIN_TOKEN,
    managerIdentity: pinnedIdentity
  }), { mode: 0o600 });

  const captured = [];
  let server;
  server = createServer(async (request, response) => {
    const body = request.method === 'POST' ? await readJson(request) : {};
    captured.push({
      url: request.url,
      authorization: request.headers.authorization,
      body
    });
    if (request.url === '/v1/health') {
      reply(response, 200, { ok: true, service: MANAGER_SERVICE, version: VERSION, apiVersion: 1 });
      return;
    }
    if (request.url === '/v1/identity/challenge') {
      reply(response, 200, createManagerIdentityProof(attackerIdentity, {
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: 1,
        host: '127.0.0.1',
        port: server.address().port,
        nonce: body.nonce
      }));
      return;
    }
    reply(response, 500, { error: { code: 'TOKEN_CAPTURED' } });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });

  const result = await runCli([
    'profiles', 'list', '--json',
    '--agent-id', 'identity-wrong-key-agent', '--agent-name', 'Identity wrong key Agent',
    '--port', String(server.address().port),
    '--state-dir', stateDir
  ]);
  assert.equal(result.code, 1, result.stdout || result.stderr);
  const failure = JSON.parse(result.stderr.trim());
  assert.equal(failure.error.code, 'MANAGER_IDENTITY_MISMATCH');
  assert.deepEqual(captured.map((request) => request.url), [
    '/v1/health',
    '/v1/identity/challenge'
  ]);
  assert.equal(captured.every((request) => request.authorization === undefined), true);
  assert.equal(JSON.stringify(captured).includes(ADMIN_TOKEN), false);
});

test('CLI final JSON does not expose credential markers from Manager responses', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'taskmaster-cli-redaction-'));
  const identity = generateManagerIdentity();
  const marker = 'identity-redaction-marker-4Qv8';
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify({
    managerToken: ADMIN_TOKEN,
    managerIdentity: identity
  }), { mode: 0o600 });

  let server;
  server = createServer(async (request, response) => {
    const body = request.method === 'POST' ? await readJson(request) : {};
    if (request.url === '/v1/health') {
      reply(response, 200, { ok: true, service: MANAGER_SERVICE, version: VERSION, apiVersion: 1 });
      return;
    }
    if (request.url === '/v1/identity/challenge') {
      reply(response, 200, createManagerIdentityProof(identity, {
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: 1,
        host: '127.0.0.1',
        port: server.address().port,
        nonce: body.nonce
      }));
      return;
    }
    reply(response, 400, {
      error: {
        code: 'FIXTURE_REJECTED',
        message: `managerToken=${marker}`
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });

  const result = await runCli([
    'profiles', 'list', '--json',
    '--agent-id', 'identity-redaction-agent', '--agent-name', 'Identity redaction Agent',
    '--port', String(server.address().port),
    '--state-dir', stateDir
  ]);
  assert.equal(result.code, 1);
  assert.equal(result.stderr.includes(marker), false);
  assert.match(result.stderr, /managerToken=\[REDACTED\]/u);
  assert.match(result.stderr, /FIXTURE_REJECTED/u);
});

test('Manager errorResponse redacts message and nested details', async (t) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'taskmaster-manager-redaction-'));
  const marker = 'manager-error-marker-3Nz7';
  const manager = await startManager({
    port: 0,
    dataDir: stateDir,
    taskService: {
      async listTaskTypes() {
        throw new HttpError(
          400,
          'FIXTURE_REJECTED',
          `private_key=${marker}; ENOENT C:\\Users\\eric\\private.txt; /root/acme/private.db; /workspace/customer/auth-state.json; /etc/taskmaster/internal.conf; /opt/vendor/private.log; https://user:pass@example.test/callback?code=${marker}`,
          {
            safe: `Authorization: Bearer ${marker}; /home/eric/private.txt`,
            managerToken: marker
          }
        );
      }
    }
  });
  t.after(async () => {
    await manager.stop().catch(() => {});
    await rm(stateDir, { recursive: true, force: true });
  });

  const response = await fetch(new URL('/v1/task-types', manager.baseUrl), {
    headers: { Authorization: `Bearer ${manager.token}` }
  });
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.equal(text.includes(marker), false);
  assert.equal(text.includes('C:\\Users\\eric'), false);
  assert.equal(text.includes('/home/eric'), false);
  for (const privatePath of ['/root/acme', '/workspace/customer', '/etc/taskmaster', '/opt/vendor']) {
    assert.equal(text.includes(privatePath), false);
  }
  assert.equal(text.includes('user:pass'), false);
  assert.match(text, /\[REDACTED\]/);
});
