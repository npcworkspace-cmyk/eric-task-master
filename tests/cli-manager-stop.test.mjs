import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { API_VERSION, VERSION } from '../src/contracts.mjs';
import {
  createManagerIdentityProof,
  generateManagerIdentity,
  MANAGER_SERVICE
} from '../src/lib/manager-identity.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
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
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function reply(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'content-type': 'application/json',
    'content-length': body.length,
    ...extraHeaders
  });
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function waitForReady(baseUrl, pidFile, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const [health, pidRecord] = await Promise.all([
        fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.json()),
        readFile(pidFile, 'utf8').then(JSON.parse)
      ]);
      if (health.state === 'ready' && pidRecord.baseUrl === baseUrl) return pidRecord;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Manager did not become ready: ${lastError?.message || 'timeout'}`);
}

test('CLI graceful stop authenticates the Manager and removes its PID proof cross-platform', {
  timeout: 30_000
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-cli-stop-'));
  const stateDir = path.join(root, 'state');
  const pidFile = path.join(stateDir, 'manager.json');
  const failureFile = path.join(stateDir, 'manager-shutdown-failure.json');
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const managerChild = spawn(process.execPath, [
    CLI,
    'serve',
    '--json',
    '--port', String(port),
    '--state-dir', stateDir
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let managerStdout = '';
  let managerStderr = '';
  managerChild.stdout.on('data', (chunk) => { managerStdout += chunk; });
  managerChild.stderr.on('data', (chunk) => { managerStderr += chunk; });
  const managerExit = new Promise((resolve, reject) => {
    managerChild.once('error', reject);
    managerChild.once('exit', (code, signal) => resolve({ code, signal }));
  });

  t.after(async () => {
    if (managerChild.exitCode === null) managerChild.kill('SIGKILL');
    await managerExit.catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const record = await waitForReady(baseUrl, pidFile);
  assert.equal(record.pid, managerChild.pid);
  const stopped = await runCli([
    'manager', 'stop', '--json',
    '--port', String(port),
    '--state-dir', stateDir
  ]);
  assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout || managerStderr);
  const result = JSON.parse(stopped.stdout.trim());
  assert.equal(result.ok, true);
  assert.equal(result.stopped, true);
  assert.equal(result.graceful, true);
  assert.equal(result.pid, managerChild.pid);

  const exited = await managerExit;
  assert.equal(exited.code, 0, managerStderr || managerStdout);
  assert.equal(exited.signal, null);
  await assert.rejects(readFile(pidFile), { code: 'ENOENT' });
  await assert.rejects(readFile(failureFile), { code: 'ENOENT' });
});

test('CLI reports nonzero when an acknowledged shutdown retains its PID proof', {
  timeout: 20_000
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-cli-stop-failure-'));
  const stateDir = path.join(root, 'state');
  const identity = generateManagerIdentity();
  const managerToken = `manager-admin-${'x'.repeat(40)}`;
  const recordedPid = 424242;
  await mkdir(stateDir, { recursive: true });
  const server = createHttpServer(async (request, response) => {
    const body = request.method === 'POST' ? await requestBody(request) : {};
    if (request.url === '/v1/health') {
      reply(response, 200, {
        ok: true,
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: API_VERSION,
        pid: recordedPid,
        state: 'ready'
      });
      return;
    }
    if (request.url === '/v1/identity/challenge') {
      reply(response, 200, createManagerIdentityProof(identity, {
        service: MANAGER_SERVICE,
        version: VERSION,
        apiVersion: API_VERSION,
        host: '127.0.0.1',
        port: server.address().port,
        nonce: body.nonce
      }));
      return;
    }
    if (request.url === '/v1/manager/shutdown') {
      assert.equal(request.headers.authorization, `Bearer ${managerToken}`);
      reply(response, 202, {
        ok: true,
        accepted: true,
        state: 'stopping',
        pid: recordedPid,
        identityFingerprint: identity.fingerprint,
        requestedAt: new Date().toISOString()
      }, { connection: 'close' });
      response.once('finish', () => setImmediate(() => server.close()));
      return;
    }
    reply(response, 404, { error: { code: 'NOT_FOUND', message: 'not found' } });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const pidRecord = { pid: recordedPid, version: VERSION, baseUrl };
  await writeFile(path.join(stateDir, 'config.json'), `${JSON.stringify({
    managerToken,
    managerIdentity: identity
  })}\n`);
  await writeFile(path.join(stateDir, 'manager.json'), `${JSON.stringify(pidRecord)}\n`);
  await writeFile(path.join(stateDir, 'manager-shutdown-failure.json'), `${JSON.stringify({
    ...pidRecord,
    error: { code: 'PROFILE_CLEANUP_FAILED', message: 'fixture cleanup failed' }
  })}\n`);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve)).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const stopped = await runCli([
    'manager', 'stop', '--json',
    '--port', String(port),
    '--state-dir', stateDir
  ]);
  assert.equal(stopped.code, 1, stopped.stdout || stopped.stderr);
  const failure = JSON.parse(stopped.stderr.trim());
  assert.equal(failure.error.code, 'MANAGER_SHUTDOWN_UNCONFIRMED');
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, 'manager.json'), 'utf8')), pidRecord);
  assert.equal(
    JSON.parse(await readFile(path.join(stateDir, 'manager-shutdown-failure.json'), 'utf8')).error.code,
    'PROFILE_CLEANUP_FAILED'
  );
});

test('CLI never signals a persisted PID when the authenticated Manager is unreachable', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-cli-stop-unreachable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  const port = await freePort();
  const record = { pid: 424_243, version: VERSION, baseUrl: `http://127.0.0.1:${port}` };
  await writeFile(path.join(stateDir, 'manager.json'), `${JSON.stringify(record)}\n`);
  const stopped = await runCli([
    'manager', 'stop', '--json',
    '--port', String(port),
    '--state-dir', stateDir
  ]);
  assert.equal(stopped.code, 1, stopped.stdout || stopped.stderr);
  assert.equal(JSON.parse(stopped.stderr.trim()).error.code, 'MANAGER_SHUTDOWN_UNCONFIRMED');
  assert.deepEqual(JSON.parse(await readFile(path.join(stateDir, 'manager.json'), 'utf8')), record);
  assert.doesNotMatch(await readFile(CLI, 'utf8'), /process\.kill\(recorded\.pid/u);
});
