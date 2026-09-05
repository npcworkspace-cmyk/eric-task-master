import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';
import fsPromises, { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { removeTestTree } from './test-fs.mjs';
import { isProcessAlive } from '../src/lib/process-tree.mjs';
import { VERSION } from '../src/contracts.mjs';
import {
  ensureManager,
  parseIntegerOption,
  parseOutputBudgetOptions,
  startBackgroundManager
} from '../src/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.mjs');

function runCli(args, { cwd = ROOT, nodeArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, CLI, ...args], {
      cwd,
      env: { ...process.env, NODE_OPTIONS: '' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function lastJson(source) {
  const lines = source.trim().split(/\r?\n/u).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('CLI integer options reject non-finite, fractional, negative, blank, and flag values locally', async () => {
  for (const invalid of [NaN, Infinity, -1, 1.5, 'NaN', 'Infinity', '-1', '1.5', ' ', true]) {
    assert.throws(
      () => parseIntegerOption(invalid, { name: '--count', minimum: 0, maximum: 10 }),
      { code: 'INVALID_NUMERIC_OPTION' }
    );
  }
  assert.equal(parseIntegerOption('0', { name: '--count', minimum: 0, maximum: 10 }), 0);
  assert.equal(parseIntegerOption(10, { name: '--count', minimum: 0, maximum: 10 }), 10);
  assert.deepEqual(parseOutputBudgetOptions({ 'max-files': '25001' }), {
    maxFiles: 25_001,
    maxEntries: 50_002
  });
  assert.deepEqual(parseOutputBudgetOptions({ 'max-files': '1000000' }), {
    maxFiles: 1_000_000,
    maxEntries: 2_000_000
  });
  assert.throws(
    () => parseOutputBudgetOptions({ 'max-files': '25001', 'max-entries': '20000' }),
    { code: 'INVALID_OUTPUT_BUDGET' }
  );

  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-invalid-'));
  try {
    const cases = [
      ['run', 'missing.mjs', '--timeout', 'NaN', '--port', '9'],
      ['run', 'missing.mjs', '--max-bytes', '1.5', '--port', '9'],
      ['run', 'missing.mjs', '--max-files', '-1', '--port', '9'],
      ['run', 'missing.mjs', '--max-entries', '2.5', '--port', '9'],
      ['follow', 'task_missing', '--after', 'Infinity', '--port', '9'],
      ['follow', 'task_missing', '--wait-ms', '-1', '--port', '9'],
      ['follow', 'task_missing', '--wait-ms', '60001', '--port', '9'],
      ['files', 'task_missing', '--offset', ' ', '--port', '9'],
      ['files', 'task_missing', '--max-bytes', 'NaN', '--port', '9'],
      ['status', '--port', '1.5']
    ];
    for (const args of cases) {
      const result = await runCli([...args, '--state-dir', root, '--json']);
      assert.equal(result.code, 1, args.join(' '));
      assert.equal(lastJson(result.stderr).error.code, 'INVALID_NUMERIC_OPTION', args.join(' '));
    }
    const typo = await runCli([
      'run', 'missing.mjs', '--profle', 'wrong-default', '--state-dir', root, '--port', '9', '--json'
    ]);
    assert.equal(typo.code, 1);
    assert.equal(lastJson(typo.stderr).error.code, 'UNKNOWN_OPTION');
    assert.match(lastJson(typo.stderr).error.message, /--profle/u);
  } finally {
    await removeTestTree(root);
  }
});

test('CLI preserves terminal task payloads, exit status, and Manager error details', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-server-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), `${JSON.stringify({ managerToken: 'x'.repeat(48) })}\n`);

  const states = {
    task_finished: { state: 'finished', result: { count: 2 }, outputRef: { files: 1 } },
    task_error: {
      state: 'error',
      error: {
        code: 'EXPECTED_FAILURE',
        message: 'failed after partial work',
        details: { stage: 'fetch' },
        nextAction: 'Retry after cooling down',
        cause: { code: 'ECONNRESET', message: 'Connection reset' }
      },
      outputRef: { files: 2, bytes: 42 }
    },
    task_stopped: {
      state: 'stopped', error: { code: 'TASK_STOPPED', message: 'stopped by owner' },
      outputRef: { files: 1, bytes: 21 }
    }
  };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3 }));
      return;
    }
    if (request.url === '/v1/tasks/task_passthrough') {
      response.statusCode = 409;
      response.end(JSON.stringify({
        ok: false,
        error: {
          code: 'EXACT_MANAGER_FAILURE',
          message: 'The original Manager explanation',
          details: { field: 'profileId', reason: 'busy' }
        },
        nextAction: 'Wait for the current task, then retry.'
      }));
      return;
    }
    const match = request.url.match(/^\/v1\/tasks\/(task_(?:finished|error|stopped))\/events\?/u);
    if (match) {
      const specific = states[match[1]];
      response.end(JSON.stringify({
        events: [],
        truncated: match[1] === 'task_finished',
        task: {
          id: match[1], label: match[1], profileId: 'profile_test',
          progress: { current: 1, total: 2, message: 'terminal' },
          createdAt: '2026-01-01T00:00:00.000Z',
          ...specific
        }
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const common = ['--state-dir', root, '--port', String(port), '--json'];

  const finished = await runCli(['follow', 'task_finished', ...common]);
  assert.equal(finished.code, 0);
  assert.deepEqual(lastJson(finished.stdout).task.result, { count: 2 });
  assert.ok(finished.stdout.split(/\r?\n/u).some((line) => line.includes('TASK_EVENT_HISTORY_TRUNCATED')));

  for (const id of ['task_error', 'task_stopped']) {
    const terminal = await runCli(['follow', id, ...common]);
    assert.equal(terminal.code, 1);
    const payload = lastJson(terminal.stdout).task;
    assert.equal(payload.state, id.slice('task_'.length));
    assert.ok(payload.error.code);
    assert.ok(payload.outputRef.files > 0, 'partial artifacts remain visible in the terminal payload');
    if (id === 'task_error') {
      assert.deepEqual(payload.error.details, { stage: 'fetch' });
      assert.equal(payload.error.nextAction, 'Retry after cooling down');
      assert.deepEqual(payload.error.cause, { code: 'ECONNRESET', message: 'Connection reset' });
    }
  }

  const failed = await runCli(['status', 'task_passthrough', ...common]);
  assert.equal(failed.code, 1);
  assert.deepEqual(lastJson(failed.stderr), {
    ok: false,
    error: {
      code: 'EXACT_MANAGER_FAILURE',
      message: 'The original Manager explanation',
      details: { field: 'profileId', reason: 'busy' }
    },
    nextAction: 'Wait for the current task, then retry.'
  });
});

test('follow returns the current verification probe and cursor without ending the task', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-verification-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), `${JSON.stringify({ managerToken: 'p'.repeat(48) })}\n`);
  const probe = {
    type: 'verification.probe', waitId: 'wait_current', probeId: 'probe_current', probe: 4,
    maximumProbes: 4, screenshot: 'screenshots/current.png',
    screenshotPath: path.join(root, 'screenshots', 'current.png'),
    needsAgentDecision: true, automaticProbesComplete: true, nextProbeAt: null
  };
  const waiting = { id: probe.waitId, reason: 'verification', ...probe };
  const task = { id: 'task_probe', state: 'waiting', waiting };
  const resumes = [];
  let eventRequests = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3 }));
      return;
    }
    if (request.url === '/v1/tasks/task_probe') {
      response.end(JSON.stringify({ ok: true, task }));
      return;
    }
    if (request.url === '/v1/tasks/task_probe/actions') {
      let body = '';
      for await (const chunk of request) body += chunk;
      resumes.push(JSON.parse(body));
      response.end(JSON.stringify({ ok: true, task }));
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/v1/tasks/task_probe/events') {
      eventRequests += 1;
      const after = Number(url.searchParams.get('after'));
      const events = [
        { sequence: 1, type: 'task.event', data: { ...probe, waitId: 'wait_old', probeId: 'probe_old_wait' } },
        { sequence: 2, type: 'task.event', data: { ...probe, probeId: 'probe_old' } },
        { sequence: 3, type: 'task.event', data: probe },
        { sequence: 4, type: 'progress', data: { current: 1, message: 'still waiting' } }
      ].filter((event) => event.sequence > after);
      response.end(JSON.stringify({
        events,
        task: eventRequests === 1 ? task : { ...task, state: 'finished', waiting: null },
        nextAfter: events.at(-1)?.sequence ?? after,
        truncated: false
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const common = ['--state-dir', root, '--port', String(server.address().port), '--json'];

  const followed = await runCli(['follow', task.id, ...common]);
  assert.equal(followed.code, 0, followed.stderr);
  assert.equal(eventRequests, 1, 'follow should hand the new screenshot back to the Agent immediately');
  assert.deepEqual(lastJson(followed.stdout), { ok: true, task, state: 'waiting', attention: probe, after: 4 });
  assert.equal(followed.stdout.includes('probe_old'), false, 'old wait and probe images must not be reissued');
  const continued = await runCli(['follow', task.id, '--after', '4', ...common]);
  assert.equal(continued.code, 0, continued.stderr);
  assert.equal(lastJson(continued.stdout).task.state, 'finished');
  assert.equal(continued.stdout.includes('attention'), false);

  const status = await runCli(['status', task.id, ...common]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(lastJson(status.stdout).task.waiting.screenshotPath, probe.screenshotPath);
  assert.equal(lastJson(status.stdout).task.waiting.probeId, probe.probeId);
  const automatic = await runCli(['resume', task.id, '--probe', probe.probeId, ...common]);
  assert.equal(automatic.code, 0, automatic.stderr);
  assert.deepEqual(resumes.at(-1), { action: 'resume', probeId: probe.probeId });
  const manual = await runCli(['resume', task.id, ...common]);
  assert.equal(manual.code, 0, manual.stderr);
  assert.deepEqual(resumes.at(-1), { action: 'resume' });
  const invalid = await runCli(['resume', task.id, '--probe', ...common]);
  assert.equal(invalid.code, 1);
  assert.equal(lastJson(invalid.stderr).error.code, 'INVALID_PROBE_ID');
});

test('non-JSON artifact reads stream every chunk to EOF', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-artifact-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), `${JSON.stringify({ managerToken: 'a'.repeat(48) })}\n`);
  const content = Buffer.from('complete-artifact');
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3 }));
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/v1/tasks/task_files/artifacts') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const maxBytes = Number(url.searchParams.get('maxBytes') || 4);
      const end = Math.min(content.length, offset + maxBytes);
      response.end(JSON.stringify({
        ok: true,
        artifact: {
          path: 'result.txt', offset, size: content.length, nextOffset: end,
          eof: end >= content.length, encoding: 'base64', data: content.subarray(offset, end).toString('base64')
        }
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const result = await runCli([
    'files', 'task_files', '--read', 'result.txt', '--max-bytes', '4',
    '--state-dir', root, '--port', String(server.address().port)
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, content.toString('utf8'));
});

test('manager stop waits for the exact Manager process to exit after its port closes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-stop-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), `${JSON.stringify({ managerToken: 's'.repeat(48) })}\n`);
  const managerProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    windowsHide: true,
    stdio: 'ignore'
  });
  t.after(() => {
    if (managerProcess.exitCode === null) managerProcess.kill('SIGKILL');
  });
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({
        service: 'eric-task-master', version: VERSION, apiVersion: 3, pid: managerProcess.pid
      }));
      return;
    }
    if (request.url === '/v1/manager/stop' && request.method === 'POST') {
      response.end(JSON.stringify({ ok: true, state: 'stopping' }));
      setTimeout(() => managerProcess.kill('SIGTERM'), 700).unref();
      setImmediate(() => {
        server.close();
        server.closeAllConnections?.();
      });
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const result = await runCli([
    'manager', 'stop', '--state-dir', root, '--port', String(server.address().port), '--json'
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(isProcessAlive(managerProcess.pid), false, 'CLI returned before the Manager process exited');
});

test('background Manager startup reports an early exit immediately with a persistent log', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-start-'));
  t.after(() => removeTestTree(root));
  const child = new EventEmitter();
  child.pid = 43210;
  child.unref = () => {};
  let finishExit;
  const exitFinished = new Promise((resolve) => { finishExit = resolve; });
  const originalOpen = fsPromises.open;
  let delayedClose = 0;
  const openMock = t.mock.method(fsPromises, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (/manager-startup-[^\\/]+\.log$/u.test(String(args[0]))) {
      const close = handle.close.bind(handle);
      handle.close = async (...closeArgs) => {
        delayedClose += 1;
        // Complete the exit handler before releasing the descriptor: no disk-timing race in this regression.
        await exitFinished;
        await new Promise((resolve) => setImmediate(resolve));
        return close(...closeArgs);
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    openMock.mock.restore();
    syncBuiltinESMExports();
  });
  const startedAt = Date.now();
  const promise = startBackgroundManager({
    host: '127.0.0.1', port: 19846, stateDir: root, baseUrl: 'http://127.0.0.1:19846'
  }, {
    spawnProcess: () => {
      queueMicrotask(async () => {
        try {
          await child.rawListeners('exit')[0](23, null);
        } finally {
          finishExit();
        }
      });
      return child;
    },
    waitForReady: () => new Promise(() => {})
  });
  let startupLog;
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'MANAGER_START_FAILED');
    assert.match(error.message, /exit code 23/u);
    assert.match(error.nextAction, /Inspect/u);
    assert.equal(error.details.exitCode, 23);
    assert.match(error.details.startupLog, /manager-startup-[^\\/]+\.log$/u);
    startupLog = error.details.startupLog;
    return true;
  });
  assert.equal(delayedClose, 1);
  assert.ok(Date.now() - startedAt < 2_000, 'early exit should not wait for the 20 second readiness timeout');
  assert.match(await readFile(startupLog, 'utf8'), /starting Manager/u);
});

test('background Manager lock loser waits for the winning sibling instead of failing early', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-contended-'));
  t.after(() => removeTestTree(root));
  const child = new EventEmitter();
  child.pid = 43211;
  child.unref = () => {};
  const expected = { service: 'eric-task-master', apiVersion: 3, state: 'ready' };
  const result = await startBackgroundManager({
    host: '127.0.0.1', port: 19847, stateDir: root, baseUrl: 'http://127.0.0.1:19847'
  }, {
    spawnProcess: (_command, _args, options) => {
      writeSync(options.stdio[1], `${JSON.stringify({
        ok: false,
        error: { code: 'MANAGER_ALREADY_RUNNING', message: 'another process won' }
      })}\n`);
      setImmediate(() => child.emit('exit', 1, null));
      return child;
    },
    waitForReady: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return expected;
    }
  });
  assert.deepEqual(result, expected);
});

test('background startup accepts a compatible different-version sibling that wins the startup race', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-start-compatible-'));
  t.after(() => removeTestTree(root));
  const expected = { service: 'eric-task-master', apiVersion: 3, version: '3.0.1', state: 'ready' };
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(expected));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const child = new EventEmitter();
  child.pid = 43212;
  child.unref = () => {};
  const result = await startBackgroundManager({
    host: '127.0.0.1', port: server.address().port, stateDir: root,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  }, { spawnProcess: () => child });
  assert.deepEqual(result, expected);
});

test('explicit Manager maintenance waits for process exit and never interrupts active tasks or manual Profiles', async (t) => {
  async function oldManager(activeTasks, { processId, onStop, profiles = [], capabilities = ['manager.idle-stop'] } = {}) {
    const server = http.createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/health') {
        response.end(JSON.stringify({
          service: 'eric-task-master', version: '2.9.9', apiVersion: 3, capabilities,
          ...(processId ? { pid: processId } : {})
        }));
        return;
      }
      if (request.url === '/v1/status') {
        response.end(JSON.stringify({ ok: true, tasks: { running: activeTasks, queued: 0 } }));
        return;
      }
      if (request.url === '/v1/profiles') {
        response.end(JSON.stringify({ ok: true, profiles }));
        return;
      }
      if (request.url === '/v1/manager/stop' && request.method === 'POST') {
        let source = '';
        for await (const chunk of request) source += chunk;
        assert.deepEqual(JSON.parse(source), { onlyIfIdle: true });
        response.end(JSON.stringify({ ok: true, state: 'stopping' }));
        onStop?.();
        setImmediate(() => {
          server.close();
          server.closeAllConnections?.();
        });
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'not found' } }));
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return server;
  }

  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-version-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), `${JSON.stringify({ managerToken: 'v'.repeat(48) })}\n`);

  const idleProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    windowsHide: true,
    stdio: 'ignore'
  });
  t.after(() => {
    if (idleProcess.exitCode === null) idleProcess.kill('SIGKILL');
  });
  const idle = await oldManager(0, {
    processId: idleProcess.pid,
    onStop: () => setTimeout(() => idleProcess.kill('SIGTERM'), 700).unref()
  });
  const idleConfig = {
    host: '127.0.0.1',
    port: idle.address().port,
    stateDir: root,
    baseUrl: `http://127.0.0.1:${idle.address().port}`
  };
  let starts = 0;
  const replacement = { service: 'eric-task-master', version: VERSION, apiVersion: 3 };
  assert.deepEqual(await ensureManager(idleConfig, {
    maintainVersion: true,
    startManager: async () => {
      assert.equal(isProcessAlive(idleProcess.pid), false, 'replacement started before old Manager exited');
      starts += 1;
      return replacement;
    }
  }), replacement);
  assert.equal(starts, 1);

  const active = await oldManager(1);
  t.after(() => new Promise((resolve) => active.close(resolve)));
  const activeConfig = {
    host: '127.0.0.1',
    port: active.address().port,
    stateDir: root,
    baseUrl: `http://127.0.0.1:${active.address().port}`
  };
  await assert.rejects(ensureManager(activeConfig, {
    maintainVersion: true,
    startManager: async () => { throw new Error('must not start'); }
  }), (error) => {
    assert.equal(error.code, 'MANAGER_VERSION_MISMATCH');
    assert.match(error.nextAction, /finish or stop/u);
    return true;
  });

  const manual = await oldManager(0, {
    profiles: [{ id: 'profile_manual', state: 'open', lease: { kind: 'manual' } }],
    onStop: () => assert.fail('maintenance must not close the manual login window')
  });
  t.after(() => new Promise((resolve) => manual.close(resolve)));
  await assert.rejects(ensureManager({
    ...activeConfig, baseUrl: `http://127.0.0.1:${manual.address().port}`
  }, { maintainVersion: true }), (error) => {
    assert.equal(error.code, 'MANAGER_VERSION_MISMATCH');
    assert.match(error.message, /occupied Profile/u);
    assert.match(error.nextAction, /controls remain available/u);
    return true;
  });

  const legacy = await oldManager(0, { capabilities: [], onStop: () => assert.fail('legacy Manager cannot guard idle maintenance') });
  t.after(() => new Promise((resolve) => legacy.close(resolve)));
  await assert.rejects(ensureManager({
    ...activeConfig, baseUrl: `http://127.0.0.1:${legacy.address().port}`
  }, { maintainVersion: true }), (error) => {
    assert.equal(error.code, 'MANAGER_CAPABILITY_UNAVAILABLE');
    assert.match(error.nextAction, /explicitly run taskmaster manager stop/u);
    return true;
  });
});

test('compatible different-version Managers remain usable for task controls and ordinary runs without maintenance', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-compatible-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ managerToken: 'c'.repeat(48) }));
  const requests = [];
  const submissions = [];
  const task = { id: 'task_existing', state: 'finished', eventSequence: 0 };
  let capabilities = [];
  const server = http.createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'eric-task-master', version: '3.0.1', apiVersion: 3, capabilities }));
      return;
    }
    if (request.url === '/v1/status') {
      response.end(JSON.stringify({ ok: true, tasks: { running: 3, queued: 2 } }));
      return;
    }
    if (request.url === '/v1/tasks' && request.method === 'POST') {
      let source = '';
      for await (const chunk of request) source += chunk;
      submissions.push(JSON.parse(source));
    }
    if (request.url.startsWith('/v1/tasks')) {
      response.end(JSON.stringify({ ok: true, task, events: [], nextAfter: 0, files: [] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { code: 'UNEXPECTED_REQUEST', message: request.url } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const common = ['--state-dir', root, '--port', String(server.address().port), '--json'];
  for (const args of [
    ['status', task.id], ['follow', task.id], ['files', task.id], ['stop', task.id],
    ['resume', task.id], ['delete', task.id], ['run', 'job.mjs', '--detach']
  ]) {
    const result = await runCli([...args, ...common]);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
  }
  assert.equal(requests.some((request) => request.includes('/v1/status')), false, 'ordinary commands do not preflight idle state');
  assert.equal(requests.some((request) => request.includes('/v1/manager/stop')), false);
  const unsupported = await runCli(['run', 'job.mjs', '--request-key', 'logical-submit', '--detach', ...common]);
  assert.equal(unsupported.code, 1);
  assert.equal(lastJson(unsupported.stderr).error.code, 'MANAGER_CAPABILITY_UNAVAILABLE');
  assert.match(lastJson(unsupported.stderr).nextAction, /controls remain available/u);
  assert.equal(submissions.length, 1, 'an unsupported request key is never silently ignored');

  capabilities = ['task.request-key'];
  requests.length = 0;
  const accepted = await runCli(['run', 'job.mjs', '--request-key', 'logical-submit', ...common]);
  assert.equal(accepted.code, 0, accepted.stderr);
  assert.equal(submissions.at(-1).requestKey, 'logical-submit');
  assert.equal(requests.filter((request) => request.includes('/v1/health')).length, 1, 'run reuses its connection for follow');
  const invalid = await runCli(['run', 'job.mjs', '--request-key', ...common]);
  assert.equal(invalid.code, 1);
  assert.equal(lastJson(invalid.stderr).error.code, 'INVALID_REQUEST_KEY');
});

test('follow drains every retained terminal event and returns the final cursor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-pages-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ managerToken: 'e'.repeat(48) }));
  const events = Array.from({ length: 601 }, (_, index) => ({ sequence: index + 100, type: 'progress', data: { current: index } }));
  const cursors = [];
  const task = { id: 'task_pages', state: 'finished', eventSequence: 700 };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3 }));
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    const after = Number(url.searchParams.get('after'));
    cursors.push(after);
    const selected = events.filter((event) => event.sequence > after).slice(0, 500);
    response.end(JSON.stringify({ task, events: selected, truncated: after < 99, nextAfter: selected.at(-1)?.sequence ?? after }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const followed = await runCli(['follow', task.id, '--state-dir', root, '--port', String(server.address().port), '--json']);
  assert.equal(followed.code, 0, followed.stderr);
  const records = followed.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(records.filter((record) => record.event).length, 601);
  assert.equal(records.filter((record) => record.warning).length, 1);
  assert.deepEqual(cursors, [0, 599]);
  assert.deepEqual(records.at(-1), { ok: true, task, state: 'finished', after: 700 });
});

test('bounded follow returns a usable cursor on timeout and current manual attention immediately', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-bounded-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ managerToken: 'b'.repeat(48) }));
  let eventRequests = 0;
  let task = { id: 'task_bound', state: 'running', eventSequence: 7 };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3 }));
      return;
    }
    eventRequests += 1;
    response.end(JSON.stringify({ task, events: [], nextAfter: 7, truncated: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const common = ['--after', '7', '--state-dir', root, '--port', String(server.address().port), '--json'];
  const followed = await runCli(['follow', task.id, '--wait-ms', '50', ...common]);
  assert.equal(followed.code, 0, followed.stderr);
  assert.deepEqual(lastJson(followed.stdout), { ok: true, task, state: 'running', attention: null, after: 7 });
  assert.equal(eventRequests, 1, 'the deadline does not trigger a redundant final request');
  const immediate = await runCli(['follow', task.id, '--wait-ms', '0', ...common]);
  assert.equal(immediate.code, 0, immediate.stderr);
  assert.equal(lastJson(immediate.stdout).after, 7);
  task = { ...task, state: 'waiting', waiting: { id: 'wait_user', reason: 'user', message: 'Provide input' } };
  const started = Date.now();
  const waiting = await runCli(['follow', task.id, '--wait-ms', '60000', ...common]);
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.ok(Date.now() - started < 5_000, 'current manual waiting does not consume the long wait budget');
  assert.deepEqual(lastJson(waiting.stdout), {
    ok: true, task, state: 'waiting', attention: { type: 'task.waiting', ...task.waiting }, after: 7
  });
  task.waiting = {
    id: 'wait_verification', reason: 'verification', automaticPaused: true, needsAgentDecision: false, probeId: 'probe_4'
  };
  const paused = await runCli(['follow', task.id, ...common]);
  assert.equal(paused.code, 0, paused.stderr);
  assert.deepEqual(lastJson(paused.stdout).attention, {
    type: 'verification.paused', ...task.waiting, needsAgentDecision: false, manualResumeRequired: true
  });
});

test('bounded follow returns after its final wait even when the timer wakes before the wall-clock deadline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-early-timer-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ managerToken: 'j'.repeat(48) }));
  const preload = path.join(root, 'early-timer.mjs');
  await writeFile(preload, `
    const schedule = globalThis.setTimeout;
    Date.now = () => 1000;
    globalThis.setTimeout = (callback, milliseconds, ...args) =>
      schedule(callback, milliseconds <= 50 ? 0 : milliseconds, ...args);
  `);
  let eventRequests = 0;
  const task = { id: 'task_early_timer', state: 'running', eventSequence: 0 };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3 }));
      return;
    }
    eventRequests += 1;
    response.end(JSON.stringify({
      // A redundant second request ends the old loop deterministically, so
      // this regression fails without hanging when the clock remains early.
      task: eventRequests === 1 ? task : { ...task, state: 'finished' },
      events: [], nextAfter: 0
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const followed = await runCli([
    'follow', task.id, '--wait-ms', '50', '--state-dir', root, '--port', String(server.address().port), '--json'
  ], { nodeArgs: ['--import', pathToFileURL(preload).href] });
  assert.equal(followed.code, 0, followed.stderr);
  assert.equal(eventRequests, 1, 'a final wait never starts another poll because the timer fired early');
  assert.deepEqual(lastJson(followed.stdout), { ok: true, task, state: 'running', attention: null, after: 0 });
});

test('bounded follow keeps its last snapshot when a later event request stalls past the deadline', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-bounded-socket-'));
  t.after(() => removeTestTree(root));
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ managerToken: 'd'.repeat(48) }));
  let eventRequests = 0;
  const task = { id: 'task_socket', state: 'running', eventSequence: 0 };
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v1/health') {
      response.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3 }));
      return;
    }
    eventRequests += 1;
    if (eventRequests === 1) response.end(JSON.stringify({ task, events: [], nextAfter: 0 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const started = Date.now();
  const result = await runCli([
    'follow', task.id, '--wait-ms', '600', '--state-dir', root, '--port', String(server.address().port), '--json'
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(lastJson(result.stdout), { ok: true, task, state: 'running', attention: null, after: 0 });
  assert.equal(eventRequests, 2);
  assert.ok(Date.now() - started < 5_000, 'the request must share the follow deadline instead of waiting 30 seconds');
});

test('twelve concurrent CLI clients converge on one cold Manager across multiple rounds', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-cli-cold-race-'));
  const active = [];
  t.after(async () => {
    for (const item of active) {
      await runCli([
        'manager', 'stop', '--state-dir', item.stateDir, '--port', String(item.port), '--json'
      ]).catch(() => {});
    }
    await removeTestTree(root);
  });

  for (let round = 0; round < 3; round += 1) {
    const stateDir = path.join(root, `round-${round}`);
    const port = await reservePort();
    const target = { stateDir, port };
    active.push(target);
    const results = await Promise.all(Array.from({ length: 12 }, () => runCli([
      'status', '--state-dir', stateDir, '--port', String(port), '--json'
    ])));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      const payload = lastJson(result.stdout);
      assert.equal(payload.ok, true);
      assert.equal(payload.state, 'ready');
    }
    const stopped = await runCli([
      'manager', 'stop', '--state-dir', stateDir, '--port', String(port), '--json'
    ]);
    assert.equal(stopped.code, 0, stopped.stderr);
    active.splice(active.indexOf(target), 1);
  }
});
