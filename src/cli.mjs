#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManager } from './manager.mjs';
import { createTaskService } from './runtime/task-service.mjs';
import { DEFAULT_HOST, DEFAULT_PORT, TERMINAL_TASK_STATES, VERSION } from './contracts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = fileURLToPath(import.meta.url);
const HELP = `eric-task-master ${VERSION}

Usage:
  taskmaster connect [--force-acceptance] [--json]
  taskmaster status [--json]
  taskmaster manager stop [--json]
  taskmaster profiles list [--json]
  taskmaster profiles create --name NAME [--behavior MODE] [--headless]
  taskmaster profiles update PROFILE_ID [--name NAME] [--behavior MODE]
  taskmaster profiles open|close|delete PROFILE_ID
  taskmaster task list [--json]
  taskmaster task run --profile ID --module PATH [--input JSON] [--behavior MODE]
  taskmaster task status|follow|cancel TASK_ID [--json]
  taskmaster extension-path [--json]

Task run follows progress until terminal state by default.`;

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf('=');
    if (equals !== -1) {
      options[value.slice(2, equals)] = value.slice(equals + 1);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return { positionals, options };
}

function defaultStateDir() {
  return resolve(process.env.ERIC_TASK_MASTER_HOME || join(homedir(), '.eric-task-master'));
}

function settings(options) {
  const port = Number(options.port ?? process.env.ERIC_TASK_MASTER_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw cliError('INVALID_PORT', 'Port must be an integer from 1 to 65535');
  }
  const host = options.host || process.env.ERIC_TASK_MASTER_HOST || DEFAULT_HOST;
  if (host !== '127.0.0.1') {
    throw cliError('LOOPBACK_REQUIRED', 'Task Master binds only to 127.0.0.1');
  }
  const stateDir = resolve(options['state-dir'] || defaultStateDir());
  return { host, port, stateDir, baseUrl: `http://${host}:${port}` };
}

function cliError(code, message, nextAction) {
  return Object.assign(new Error(message), { code, nextAction });
}

function emit(value, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  process.stdout.write(`${formatHuman(value)}\n`);
}

function formatHuman(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(formatHuman).join('\n');
  return JSON.stringify(value, null, 2);
}

async function readManagerToken(stateDir) {
  try {
    const config = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
    if (typeof config.managerToken === 'string' && config.managerToken.length >= 32) {
      return config.managerToken;
    }
  } catch {
    // The caller reports a stable connection error below.
  }
  throw cliError(
    'MANAGER_TOKEN_UNAVAILABLE',
    'Manager authentication token is unavailable',
    'Run the fixed connect command once.'
  );
}

async function requestJson(baseUrl, pathname, { method = 'GET', body, token, timeoutMs = 10_000 } = {}) {
  let response;
  try {
    response = await fetch(new URL(pathname, baseUrl), {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw cliError('MANAGER_UNREACHABLE', `Manager request failed: ${error.message}`, 'Retry the fixed connect command once.');
  }
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw cliError('INVALID_MANAGER_RESPONSE', `Manager returned non-JSON status ${response.status}`);
    }
  }
  if (!response.ok) {
    const detail = payload.error || payload;
    throw cliError(detail.code || `HTTP_${response.status}`, detail.message || `Manager returned ${response.status}`);
  }
  return payload;
}

async function health(config, timeoutMs = 1_500) {
  const result = await requestJson(config.baseUrl, '/v1/health', { timeoutMs });
  if (result.service !== 'eric-task-master') {
    throw cliError('PORT_OCCUPIED', `Port ${config.port} belongs to another service`);
  }
  if (result.version !== VERSION) {
    throw cliError(
      'MANAGER_VERSION_MISMATCH',
      `Manager ${result.version} does not match project ${VERSION}`,
      'Stop the older Manager process and rerun connect.'
    );
  }
  return result;
}

async function waitForManager(config, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await health(config);
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw cliError(
    'MANAGER_START_TIMEOUT',
    `Manager did not become ready: ${lastError?.message || 'timeout'}`,
    'Retry the fixed connect command once.'
  );
}

async function ensureManager(config) {
  try {
    return { health: await health(config), started: false };
  } catch (error) {
    if (!['MANAGER_UNREACHABLE'].includes(error.code)) throw error;
  }
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [
    CLI_PATH,
    'serve',
    '--host', config.host,
    '--port', String(config.port),
    '--state-dir', config.stateDir
  ], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  return { health: await waitForManager(config), started: true };
}

async function serve(config, json) {
  const manager = await startManager({
    host: config.host,
    port: config.port,
    dataDir: config.stateDir,
    dashboardDir: resolve(ROOT, 'dashboard'),
    taskServiceFactory({ profileStore, stateDir }) {
      return createTaskService({ profileStore, stateDir });
    }
  });
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const pidFile = join(config.stateDir, 'manager.json');
  await writeFile(pidFile, `${JSON.stringify({ pid: process.pid, version: VERSION, baseUrl: manager.baseUrl })}\n`, { mode: 0o600 });
  emit({ ok: true, event: 'manager-ready', version: VERSION, pid: process.pid, baseUrl: manager.baseUrl }, json);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await manager.stop();
    await rm(pidFile, { force: true }).catch(() => {});
  };
  process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
  await new Promise(() => {});
}

async function loadInput(raw) {
  if (raw === undefined) return {};
  if (raw.startsWith('@')) {
    return JSON.parse(await readFile(resolve(raw.slice(1)), 'utf8'));
  }
  return JSON.parse(raw);
}

async function apiContext(options) {
  const config = settings(options);
  await ensureManager(config);
  return { config, token: await readManagerToken(config.stateDir) };
}

async function followTask(context, taskId, json, options = {}) {
  const pollMs = Number(options['poll-ms'] ?? 1_000);
  const timeoutMs = Number(options['wait-ms'] ?? 24 * 60 * 60 * 1_000);
  const deadline = Date.now() + timeoutMs;
  let previous;
  while (Date.now() < deadline) {
    const { task } = await requestJson(context.config.baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}`, {
      token: context.token
    });
    const signature = JSON.stringify([task.state, task.progress, task.heartbeatAt, task.error]);
    if (signature !== previous) {
      emit({ event: 'task-progress', task }, json);
      previous = signature;
    }
    if (
      TERMINAL_TASK_STATES.has(task.state) &&
      (task.cleanup?.settled || task.cleanup?.managerRestartObserved)
    ) return task;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  throw cliError(
    'TASK_FOLLOW_TIMEOUT',
    `Task ${taskId} is still running after the follow timeout`,
    `Run task follow ${taskId}; do not submit a duplicate.`
  );
}

async function connect(options, json) {
  const config = settings(options);
  const connection = await ensureManager(config);
  const token = await readManagerToken(config.stateDir);
  const acceptanceFile = join(config.stateDir, `acceptance-${VERSION}.json`);
  let acceptance;
  if (!options['force-acceptance'] && existsSync(acceptanceFile)) {
    try {
      acceptance = JSON.parse(await readFile(acceptanceFile, 'utf8'));
      if (!acceptance.ok || acceptance.version !== VERSION) acceptance = null;
    } catch {
      acceptance = null;
    }
  }
  if (!acceptance) {
    const { runAcceptance } = await import('../scripts/acceptance.mjs');
    acceptance = await runAcceptance({ baseUrl: config.baseUrl, token, stateDir: config.stateDir });
    if (!acceptance.ok) {
      const firstFailed = acceptance.checks?.find((check) => !check.passed);
      const failure = firstFailed
        ? `${firstFailed.name}${firstFailed.detail ? `: ${firstFailed.detail}` : ''}`
        : 'unknown check';
      throw cliError(
        'ACCEPTANCE_FAILED',
        `Built-in acceptance failed at ${failure}`,
        acceptance.nextAction
      );
    }
    await writeFile(acceptanceFile, `${JSON.stringify(acceptance, null, 2)}\n`, { mode: 0o600 });
  } else {
    acceptance = { ...acceptance, cached: true };
  }
  const result = {
    ok: true,
    version: VERSION,
    manager: { ...connection.health, startedNow: connection.started },
    acceptance,
    extensionPath: resolve(ROOT, 'extension'),
    dashboard: `${config.baseUrl}/dashboard`,
    nextAction: 'List profiles, then ask for the browser task.'
  };
  emit(result, json);
  return result;
}

async function stopManager(options, json) {
  const config = settings(options);
  let running;
  try {
    running = await health(config);
  } catch (error) {
    if (error.code === 'MANAGER_UNREACHABLE') {
      emit({ ok: true, stopped: false, message: 'Manager is not running' }, json);
      return;
    }
    throw error;
  }
  let recorded;
  try {
    recorded = JSON.parse(await readFile(join(config.stateDir, 'manager.json'), 'utf8'));
  } catch {
    throw cliError('MANAGER_PID_UNAVAILABLE', 'Manager PID record is unavailable; refusing to stop an unverified process.');
  }
  if (
    recorded.pid !== running.pid ||
    recorded.version !== running.version ||
    recorded.baseUrl !== config.baseUrl
  ) {
    throw cliError('MANAGER_PID_MISMATCH', 'Manager PID record does not match the live service; refusing to stop it.');
  }
  process.kill(recorded.pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await health(config, 500);
    } catch (error) {
      if (error.code === 'MANAGER_UNREACHABLE') {
        await rm(join(config.stateDir, 'manager.json'), { force: true }).catch(() => {});
        emit({ ok: true, stopped: true, pid: recorded.pid }, json);
        return;
      }
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw cliError('MANAGER_STOP_TIMEOUT', `Manager process ${recorded.pid} did not stop in time`);
}

async function profileCommand(action, args, options, json) {
  const context = await apiContext(options);
  if (action === 'list') {
    const result = await requestJson(context.config.baseUrl, '/v1/profiles', { token: context.token });
    emit({ ok: true, ...result }, json);
    return;
  }
  if (action === 'create') {
    if (!options.name) throw cliError('PROFILE_NAME_REQUIRED', '--name is required');
    const body = {
      name: options.name,
      defaultBehavior: options.behavior || 'fast',
      headless: options.headless === true || options.headless === 'true',
      ...(options.channel ? { browserChannel: options.channel } : {})
    };
    const result = await requestJson(context.config.baseUrl, '/v1/profiles', { method: 'POST', body, token: context.token });
    emit({ ok: true, ...result }, json);
    return;
  }
  const profileId = args[0];
  if (!profileId) throw cliError('PROFILE_ID_REQUIRED', `profiles ${action} requires a profile ID`);
  if (action === 'update') {
    const body = {};
    if (options.name !== undefined) body.name = options.name;
    if (options.behavior !== undefined) body.defaultBehavior = options.behavior;
    if (options.headless !== undefined) body.headless = options.headless === true || options.headless === 'true';
    if (options.channel !== undefined) body.browserChannel = options.channel === 'none' ? null : options.channel;
    const result = await requestJson(context.config.baseUrl, `/v1/profiles/${encodeURIComponent(profileId)}`, {
      method: 'PATCH', body, token: context.token
    });
    emit({ ok: true, ...result }, json);
    return;
  }
  const route = action === 'delete'
    ? `/v1/profiles/${encodeURIComponent(profileId)}`
    : `/v1/profiles/${encodeURIComponent(profileId)}/${action}`;
  const method = action === 'delete' ? 'DELETE' : 'POST';
  const result = await requestJson(context.config.baseUrl, route, { method, token: context.token });
  emit({ ok: true, ...result }, json);
}

async function taskCommand(action, args, options, json) {
  const context = await apiContext(options);
  if (action === 'list') {
    const result = await requestJson(context.config.baseUrl, '/v1/tasks', { token: context.token });
    emit({ ok: true, ...result }, json);
    return;
  }
  if (action === 'run') {
    if (!options.profile) throw cliError('PROFILE_ID_REQUIRED', '--profile is required');
    if (!options.module) throw cliError('TASK_MODULE_REQUIRED', '--module is required');
    const modulePath = isAbsolute(options.module) ? options.module : resolve(options.module);
    const body = {
      profileId: options.profile,
      modulePath,
      input: await loadInput(options.input),
      ...(options.behavior ? { behavior: options.behavior } : {}),
      ...(options.timeout ? { timeoutMs: Number(options.timeout) } : {})
    };
    const { task } = await requestJson(context.config.baseUrl, '/v1/tasks', {
      method: 'POST', body, token: context.token
    });
    emit({ event: 'task-started', task }, json);
    if (options.detach) return;
    const terminal = await followTask(context, task.id, json, options);
    emit({ ok: terminal.state === 'completed', event: 'task-finished', task: terminal }, json);
    if (terminal.state !== 'completed') process.exitCode = 1;
    return;
  }
  const taskId = args[0];
  if (!taskId) throw cliError('TASK_ID_REQUIRED', `task ${action} requires a task ID`);
  if (action === 'status') {
    const result = await requestJson(context.config.baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}`, { token: context.token });
    emit({ ok: true, ...result }, json);
    return;
  }
  if (action === 'follow') {
    const terminal = await followTask(context, taskId, json, options);
    emit({ ok: terminal.state === 'completed', event: 'task-finished', task: terminal }, json);
    if (terminal.state !== 'completed') process.exitCode = 1;
    return;
  }
  if (action === 'cancel') {
    const result = await requestJson(context.config.baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST', token: context.token
    });
    emit({ ok: true, ...result }, json);
    return;
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown task command: ${action}`);
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const json = options.json === true || options.json === 'true';
  const command = positionals.shift() || 'connect';
  if (options.help || command === 'help') {
    emit(HELP, false);
    return;
  }
  if (command === 'serve') return serve(settings(options), json);
  if (command === 'connect') return connect(options, json);
  if (command === 'manager') {
    const action = positionals.shift() || 'status';
    if (action === 'stop') return stopManager(options, json);
    if (action === 'status') {
      const config = settings(options);
      emit({ ok: true, manager: await health(config) }, json);
      return;
    }
    throw cliError('UNKNOWN_COMMAND', `Unknown manager command: ${action}`);
  }
  if (command === 'profiles') return profileCommand(positionals.shift() || 'list', positionals, options, json);
  if (command === 'task') return taskCommand(positionals.shift() || 'list', positionals, options, json);
  if (command === 'status') {
    const config = settings(options);
    emit({ ok: true, manager: await health(config) }, json);
    return;
  }
  if (command === 'extension-path') {
    emit({ ok: true, path: resolve(ROOT, 'extension') }, json);
    return;
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
}

main().catch((error) => {
  const { options } = parseArgs(process.argv.slice(2));
  const payload = {
    ok: false,
    error: { code: error.code || 'TASKMASTER_FAILED', message: error.message },
    nextAction: error.nextAction || 'Read the error, correct the stated cause, and retry the same command once.'
  };
  if (options.json === true || options.json === 'true') {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  process.exitCode = 1;
});
