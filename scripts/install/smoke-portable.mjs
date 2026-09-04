#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ROOT, hashTree, parseArgs, readJson, writeJson } from '../build/lib.mjs';
import { isProcessAlive, probeChromeProfileUsage, terminateProcessTree } from '../../src/lib/process-tree.mjs';

const execute = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
assert.equal(Object.keys(args).join(','), 'archive', 'Use --archive PORTABLE.zip');
const archive = resolve(args.archive);
assert.match(archive, /\.zip$/iu, 'Portable smoke requires a ZIP archive');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'Task Master portable smoke '));
const extracted = join(temporaryRoot, 'Extracted package');
const stateDir = join(temporaryRoot, 'Isolated state');
const bundleRoot = join(extracted, 'eric-task-master');
const launcher = join(bundleRoot, 'bin', process.platform === 'win32' ? 'taskmaster.cmd' : 'taskmaster');
const nodeBinary = join(bundleRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
let port;
let manifest;
let managerPid;
let workerPid;
let profileId;
let taskId;
let failure;
const cleanupErrors = [];
const report = { ok: false, archive, extractedToPathWithSpaces: true, checks: [], cleanup: {} };

async function command(file, parameters, options = {}) {
  return execute(file, parameters, {
    cwd: temporaryRoot, windowsHide: true, timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    ...options
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const value = server.address().port;
  await new Promise((accept) => server.close(accept));
  return value;
}

function portOpen() {
  if (!port) return Promise.resolve(false);
  return new Promise((accept) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value) => { socket.destroy(); accept(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function executablePath(pid) {
  if (!isProcessAlive(pid)) return null;
  if (process.platform === 'linux') return realpath(`/proc/${pid}/exe`);
  const result = process.platform === 'win32'
    ? await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction Stop).Path`], { timeout: 10_000 })
    : await command('ps', ['-ww', '-p', String(pid), '-o', 'comm='], { timeout: 10_000 });
  return realpath(result.stdout.trim());
}

function samePath(left, right) {
  if (!left || !right) return false;
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function cli(parameters, timeout = 45_000) {
  const all = [...parameters, '--state-dir', stateDir, '--port', String(port)];
  const env = {
    ...process.env, ERIC_TASK_MASTER_HOME: stateDir, ERIC_TASK_MASTER_PORT: String(port),
    NODE_OPTIONS: '--require=__portable_host_injection_must_not_load__',
    NODE_PATH: join(temporaryRoot, '__host_node_path_must_not_be_used__')
  };
  let result;
  let commandError;
  try {
    result = process.platform === 'win32'
      ? await command(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[launcher, ...all].map((value) => `"${value}"`).join(' ')}"`], {
        env, timeout, windowsVerbatimArguments: true
      })
      : await command(launcher, all, { env, timeout });
  } catch (error) {
    result = error;
    commandError = error;
  }
  const records = String(result.stdout || '').split(/\r?\n/u).filter((line) => line.startsWith('{')).map((line) => JSON.parse(line));
  for (const record of records) {
    if (record.taskId === taskId && record.event?.type === 'task.started') workerPid = record.event.data?.pid;
  }
  const last = records.at(-1);
  if (taskId && last?.task?.id === taskId) {
    report.task = { id: taskId, profileId, state: last.task.state, error: last.task.error, result: last.task.result };
  }
  if (commandError) {
    const detail = last?.error?.message || last?.task?.error?.message || result.stderr || commandError.message;
    throw new Error(`Portable CLI ${parameters[0]} failed: ${String(detail).slice(0, 4000)}`, { cause: commandError });
  }
  return { records, last };
}

try {
  await mkdir(extracted);
  const list = process.platform === 'win32'
    ? await command('tar', ['-tf', archive])
    : await command('unzip', ['-Z1', archive]);
  const entries = list.stdout.trim().split(/\r?\n/u).map((entry) => entry.replaceAll('\\', '/'));
  assert.ok(entries.length && entries.every((entry) => entry.startsWith('eric-task-master/') && !entry.split('/').includes('..')), 'ZIP entries must stay inside the application root');
  if (process.platform === 'win32') await command('tar', ['-xf', archive, '-C', extracted], { timeout: 90_000 });
  else await command('unzip', ['-q', archive, '-d', extracted], { timeout: 90_000 });
  assert.deepEqual(await readdir(extracted), ['eric-task-master']);
  manifest = await readJson(join(bundleRoot, 'release-manifest.json'));
  const lock = await readJson(join(ROOT, 'scripts', 'build', 'runtime-lock.json'));
  assert.equal(manifest.product, 'eric-task-master');
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.arch, process.arch);
  assert.equal(lock.targets[manifest.target]?.platform, process.platform);
  assert.equal(lock.targets[manifest.target]?.arch, process.arch);
  assert.equal(manifest.node.version, lock.nodeVersion);
  assert.deepEqual([manifest.browser.bundled, manifest.browser.requiredChannel], [false, 'chrome']);
  assert.equal((await readJson(join(bundleRoot, 'app', 'package.json'))).version, manifest.version);
  assert.deepEqual(await hashTree(bundleRoot, { exclude: ['release-manifest.json'] }), manifest.tree);
  report.target = manifest.target;
  report.version = manifest.version;
  report.gitSha = manifest.gitSha;
  report.tree = manifest.tree;
  report.checks.push('native manifest and payload hash');
  if (process.platform !== 'win32') {
    for (const file of [launcher, nodeBinary]) {
      assert.ok((await stat(file)).mode & 0o111, `${file} lost executable permission in ZIP`);
      await access(file, constants.X_OK);
    }
    report.checks.push('POSIX executable permissions preserved');
  }
  port = await freePort();
  await cli(['--help']);
  assert.equal((await cli(['status', '--json'])).last.profiles, 0, 'Portable state must start empty');
  managerPid = (await cli(['manager', 'status', '--json'])).last.manager.pid;
  assert.ok(samePath(await executablePath(managerPid), await realpath(nodeBinary)), 'Manager did not start with the portable embedded Node');
  report.embeddedNode = await executablePath(managerPid);
  report.checks.push('portable launcher starts its own embedded Node despite poisoned host Node environment');
  profileId = (await cli(['profiles', 'create', 'Portable smoke', '--json'])).last.profile.id;
  taskId = (await cli(['run', join(ROOT, 'scripts', 'build', 'fixtures', 'bare-playwright-task.mjs'), '--profile', profileId, '--timeout', '60000', '--detach', '--json'])).last.task.id;
  const task = (await cli(['follow', taskId, '--json'], 90_000)).last.task;
  assert.equal(task.state, 'finished');
  for (const key of ['barePlaywrightImport', 'hostNodeInjectionIsolated', 'sandboxEnabled']) assert.equal(task.result?.[key], true, `${key} failed`);
  assert.ok(Number.isSafeInteger(workerPid), 'Task Worker PID evidence is missing');
  report.checks.push('real Chrome task, bare Playwright import, sandbox, and clean Worker environment');
  report.taskResult = task.result;
} catch (error) {
  failure = error;
} finally {
  if (port && manifest) {
    for (const operation of [
      ...(taskId ? [['stop', taskId, '--json'], ['delete', taskId, '--json']] : []),
      ...(profileId ? [['profiles', 'close', profileId, '--json'], ['profiles', 'delete', profileId, '--json']] : []),
      ['manager', 'stop', '--json']
    ]) {
      try { await cli(operation); } catch (error) { cleanupErrors.push(error.message); }
    }
    managerPid ||= (await readJson(join(stateDir, 'manager.json')).catch(() => null))?.pid;
    for (const pid of [workerPid, managerPid]) {
      if (isProcessAlive(pid) && samePath(await executablePath(pid).catch(() => null), await realpath(nodeBinary).catch(() => null))) {
        cleanupErrors.push(`Graceful cleanup left owned process ${pid} alive; forced its process tree to stop`);
        await terminateProcessTree(pid, { graceMs: 2_000 });
      }
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (isProcessAlive(managerPid) || isProcessAlive(workerPid) || await portOpen())) await sleep(100);
  }
  const profileUsage = profileId ? await probeChromeProfileUsage(join(stateDir, 'profiles', profileId)) : 'inactive';
  report.cleanup = { managerExited: !isProcessAlive(managerPid), workerExited: !isProcessAlive(workerPid), portClosed: !(await portOpen()), profileUsage, errors: cleanupErrors };
  if (!report.cleanup.managerExited || !report.cleanup.workerExited || !report.cleanup.portClosed || profileUsage !== 'inactive') cleanupErrors.push('Portable process or Profile cleanup is unconfirmed');
  try {
    if (report.cleanup.managerExited && report.cleanup.workerExited && report.cleanup.portClosed && profileUsage === 'inactive') {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      report.cleanup.temporaryDirectoryRemoved = true;
    } else report.cleanup.temporaryDirectoryRemoved = false;
  } catch (error) { cleanupErrors.push(error.message); }
  report.ok = !failure && cleanupErrors.length === 0;
  if (failure) report.error = failure.message;
  await writeJson(join(ROOT, 'artifacts', `portable-smoke-${manifest?.target || `${process.platform}-${process.arch}`}.json`), report);
}

process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.ok) throw failure || new Error(`Portable smoke cleanup failed: ${cleanupErrors.join('; ')}`);
