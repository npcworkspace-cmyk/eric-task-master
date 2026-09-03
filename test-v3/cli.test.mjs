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
import { fileURLToPath } from 'node:url';
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

function runCli(args, { cwd = ROOT } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
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

test('CLI replaces an idle same-API old Manager only after its process exits and never interrupts active tasks', async (t) => {
  async function oldManager(activeTasks, { processId, onStop } = {}) {
    const server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/v1/health') {
        response.end(JSON.stringify({
          service: 'eric-task-master', version: '2.9.9', apiVersion: 3,
          ...(processId ? { pid: processId } : {})
        }));
        return;
      }
      if (request.url === '/v1/status') {
        response.end(JSON.stringify({ ok: true, tasks: { running: activeTasks, queued: 0 } }));
        return;
      }
      if (request.url === '/v1/manager/stop' && request.method === 'POST') {
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
    startManager: async () => { throw new Error('must not start'); }
  }), (error) => {
    assert.equal(error.code, 'MANAGER_VERSION_MISMATCH');
    assert.match(error.nextAction, /finish or stop/u);
    return true;
  });
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
