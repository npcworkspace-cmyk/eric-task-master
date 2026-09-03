#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION, DEFAULT_HOST, DEFAULT_PORT, TERMINAL_TASK_STATES, VERSION } from './contracts.mjs';
import { isProcessAlive } from './lib/process-tree.mjs';
import { defaultDataDirectory, startManager } from './manager.mjs';
import { redactSensitiveText, redactSensitiveValue } from './lib/redaction.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const HELP = `Eric Task Master ${VERSION}

Fast path:
  taskmaster run JOB.mjs [--profile NAME_OR_ID] [--input JSON_OR_@FILE] [--label TEXT] [--detach]

Tasks:
  taskmaster follow TASK_ID
  taskmaster status [TASK_ID]
  taskmaster stop TASK_ID
  taskmaster resume TASK_ID [--value JSON_OR_@FILE]
  taskmaster delete TASK_ID
  taskmaster files TASK_ID [--read RELATIVE_PATH]

Profiles:
  taskmaster profiles list
  taskmaster profiles create NAME
  taskmaster profiles default NAME_OR_ID
  taskmaster profiles rename NAME_OR_ID --name NEW_NAME
  taskmaster profiles open|close|delete NAME_OR_ID

Manager:
  taskmaster panel
  taskmaster manager start|foreground|status|stop

All commands accept --json. Manager starts automatically when needed.`;

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
    if (equals > 2) {
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

const COMMON_OPTIONS = Object.freeze(['help', 'host', 'json', 'port', 'state-dir']);

function assertAllowedOptions(options, allowed = []) {
  const accepted = new Set([...COMMON_OPTIONS, ...allowed]);
  const unknown = Object.keys(options).filter((key) => !accepted.has(key));
  if (unknown.length) {
    throw cliError(
      'UNKNOWN_OPTION',
      `Unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((key) => `--${key}`).join(', ')}`
    );
  }
}

function cliError(code, message, nextAction = null) {
  return Object.assign(new Error(message), { code, nextAction });
}

export function parseIntegerOption(value, {
  name,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
  defaultValue
} = {}) {
  const missing = value === undefined || value === null;
  if (missing && defaultValue !== undefined) return defaultValue;
  const isNumber = typeof value === 'number';
  const text = typeof value === 'string' ? value.trim() : null;
  const supplied = isNumber || (text !== null && text.length > 0);
  const parsed = isNumber ? value : Number(text);
  if (!supplied || !Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw cliError(
      'INVALID_NUMERIC_OPTION',
      `${name || 'numeric option'} must be a safe integer from ${minimum} to ${maximum}`
    );
  }
  return parsed;
}

export function parseOutputBudgetOptions(options = {}) {
  const maxBytes = options['max-bytes'] === undefined
    ? undefined
    : parseIntegerOption(options['max-bytes'], {
        name: '--max-bytes', minimum: 1, maximum: 64 * 1024 * 1024 * 1024
      });
  const maxFiles = options['max-files'] === undefined
    ? undefined
    : parseIntegerOption(options['max-files'], {
        name: '--max-files', minimum: 1, maximum: 1_000_000
      });
  const suppliedMaxEntries = options['max-entries'] === undefined
    ? undefined
    : parseIntegerOption(options['max-entries'], {
        name: '--max-entries', minimum: 1, maximum: 2_000_000
      });
  const maxEntries = suppliedMaxEntries ?? (maxFiles === undefined
    ? undefined
    : Math.min(2_000_000, Math.max(20_000, maxFiles * 2)));
  if (maxFiles !== undefined && maxEntries < maxFiles) {
    throw cliError('INVALID_OUTPUT_BUDGET', '--max-entries must be greater than or equal to --max-files');
  }
  if (maxBytes === undefined && maxFiles === undefined && maxEntries === undefined) return undefined;
  return {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxFiles === undefined ? {} : { maxFiles }),
    ...(maxEntries === undefined ? {} : { maxEntries })
  };
}

function settings(options = {}) {
  const host = options.host || process.env.ERIC_TASK_MASTER_HOST || DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw cliError('LOOPBACK_REQUIRED', `Manager must use ${DEFAULT_HOST}`);
  const port = parseIntegerOption(
    options.port ?? process.env.ERIC_TASK_MASTER_PORT ?? DEFAULT_PORT,
    { name: '--port', minimum: 1, maximum: 65_535 }
  );
  const stateDir = path.resolve(options['state-dir'] || defaultDataDirectory());
  return { host, port, stateDir, baseUrl: `http://${host}:${port}` };
}

function emit(value, json = false) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } else if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

async function requestJson(config, pathname, { method = 'GET', body, token, timeoutMs = 30_000 } = {}) {
  let response;
  try {
    response = await fetch(new URL(pathname, config.baseUrl), {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    throw cliError('MANAGER_UNREACHABLE', `Manager request failed: ${error.message}`);
  }
  const source = await response.text();
  let payload = {};
  try {
    payload = source ? JSON.parse(source) : {};
  } catch {
    throw cliError('INVALID_MANAGER_RESPONSE', `Manager returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    const error = cliError(
      payload.error?.code || `HTTP_${response.status}`,
      payload.error?.message || `Manager returned ${response.status}`,
      payload.nextAction ?? payload.error?.nextAction ?? null
    );
    const details = payload.error?.details ?? payload.details;
    if (details !== undefined) error.details = details;
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

async function health(config, timeoutMs = 1_500) {
  const result = await requestJson(config, '/v1/health', { timeoutMs });
  if (result.service !== 'eric-task-master') throw cliError('PORT_OCCUPIED', 'Manager port belongs to another service');
  return result;
}

async function readToken(config) {
  try {
    const value = JSON.parse(await readFile(path.join(config.stateDir, 'config.json'), 'utf8'));
    if (typeof value.managerToken !== 'string' || value.managerToken.length < 32) throw new Error();
    return value.managerToken;
  } catch {
    throw cliError('MANAGER_TOKEN_UNAVAILABLE', 'Manager local token is unavailable');
  }
}

async function waitForManager(config, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const current = await health(config);
      if (current.apiVersion !== API_VERSION) {
        throw cliError('MANAGER_API_INCOMPATIBLE', `Manager API ${current.apiVersion} is incompatible with ${API_VERSION}`);
      }
      if (current.version !== VERSION) {
        throw cliError('MANAGER_VERSION_MISMATCH', `Manager ${current.version || 'unknown'} does not match CLI ${VERSION}`);
      }
      return current;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw cliError('MANAGER_START_TIMEOUT', lastError?.message || 'Manager did not start');
}

async function startupError({ startupLog, code = null, signal = null, cause = null }) {
  const logSource = await readFile(startupLog, 'utf8').catch(() => '');
  const logTail = logSource.trim().slice(-8_000);
  let managerCode = null;
  for (const line of logSource.split(/\r?\n/u).reverse()) {
    try {
      const record = JSON.parse(line);
      if (typeof record?.error?.code === 'string') {
        managerCode = record.error.code;
        break;
      }
    } catch {
      // Startup markers are intentionally not JSON records.
    }
  }
  const exitReason = cause?.message || (signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`);
  const error = cliError(
    'MANAGER_START_FAILED',
    `Manager exited before it became ready: ${exitReason}${logTail ? `\n${logTail}` : ''}`,
    `Inspect ${startupLog}, fix the reported startup error, then retry.`
  );
  error.managerCode = managerCode;
  error.details = {
    startupLog,
    exitCode: code,
    signal,
    ...(managerCode ? { managerCode } : {}),
    ...(logTail ? { logTail } : {})
  };
  return error;
}

export async function startBackgroundManager(config, {
  spawnProcess = spawn,
  waitForReady = waitForManager,
  executable = process.execPath,
  cliPath = CLI_PATH
} = {}) {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'NODE_OPTIONS')
  );
  cleanEnvironment.NODE_OPTIONS = '';
  const startupDirectory = path.join(config.stateDir, 'logs');
  const startupLog = path.join(
    startupDirectory,
    `manager-startup-${process.pid}-${randomUUID()}.log`
  );
  await mkdir(startupDirectory, { recursive: true, mode: 0o700 });
  const logHandle = await open(startupLog, 'a', 0o600);
  await logHandle.chmod(0o600).catch(() => {});
  await logHandle.appendFile(`\n[${new Date().toISOString()}] starting Manager\n`, 'utf8');
  let child;
  try {
    child = spawnProcess(executable, [
      cliPath,
      'serve',
      '--host', config.host,
      '--port', String(config.port),
      '--state-dir', config.stateDir,
      '--json'
    ], {
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      windowsHide: true,
      env: cleanEnvironment
    });
  } catch (cause) {
    await logHandle.close();
    await appendFile(startupLog, `${cause?.stack || cause}\n`, { mode: 0o600 }).catch(() => {});
    throw await startupError({ startupLog, cause });
  }
  const earlyExit = new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', async (cause) => {
      if (settled) return;
      settled = true;
      await appendFile(startupLog, `${cause?.stack || cause}\n`, { mode: 0o600 }).catch(() => {});
      reject(await startupError({ startupLog, cause }));
    });
    child.once('exit', async (code, signal) => {
      if (settled) return;
      settled = true;
      const error = await startupError({ startupLog, code, signal });
      if (error.managerCode === 'MANAGER_ALREADY_RUNNING' || error.managerCode === 'MANAGER_LOCK_BUSY') {
        resolve({ kind: 'contended' });
      } else {
        reject(error);
      }
    });
  });
  const readiness = Promise.resolve().then(() => waitForReady(config));
  const readyOrFailed = Promise.race([
    readiness.then((value) => ({ kind: 'ready', value })),
    earlyExit
  ]);
  await logHandle.close();
  child.unref();
  try {
    const outcome = await readyOrFailed;
    if (outcome.kind === 'ready') return outcome.value;
    // This child lost the state lock to a sibling auto-start. It is not a
    // startup failure: wait for the winning Manager on the same loopback port.
    return await readiness;
  } catch (error) {
    if (error?.code === 'MANAGER_START_FAILED') throw error;
    const logSource = await readFile(startupLog, 'utf8').catch(() => '');
    const logTail = logSource.trim().slice(-8_000);
    error.nextAction ||= `Inspect ${startupLog}, stop any stuck Manager process, then retry.`;
    error.details = {
      ...(error.details && typeof error.details === 'object' ? error.details : {}),
      startupLog,
      ...(logTail ? { logTail } : {})
    };
    throw error;
  }
}

async function waitForManagerStop(config, timeoutMs = 20_000, managerPid = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await health(config, 500);
    } catch (error) {
      if (error.code === 'MANAGER_UNREACHABLE') {
        if (!managerPid || !isProcessAlive(managerPid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

export async function ensureManager(config, { startManager = startBackgroundManager } = {}) {
  try {
    const current = await health(config);
    if (current.apiVersion !== API_VERSION) {
      throw cliError(
        'MANAGER_API_INCOMPATIBLE',
        `Running Manager API ${current.apiVersion} is incompatible with ${API_VERSION}`,
        'Stop the older Manager once, then retry.'
      );
    }
    if (current.version === VERSION) return current;

    const token = await readToken(config);
    const status = await requestJson(config, '/v1/status', { token });
    const activeTasks = Number(status.tasks?.running || 0) + Number(status.tasks?.queued || 0);
    if (activeTasks > 0) {
      throw cliError(
        'MANAGER_VERSION_MISMATCH',
        `Manager ${current.version || 'unknown'} has ${activeTasks} active task(s) and cannot be replaced by CLI ${VERSION}`,
        'Let the active tasks finish or stop them, then run the command again.'
      );
    }
    await requestJson(config, '/v1/manager/stop', { method: 'POST', body: {}, token });
    if (!(await waitForManagerStop(config, 20_000, current.pid))) {
      throw cliError(
        'MANAGER_VERSION_MISMATCH',
        `Manager ${current.version || 'unknown'} did not stop for the CLI ${VERSION} upgrade`,
        'Stop the old Manager manually, then run the command again.'
      );
    }
    return startManager(config);
  } catch (error) {
    if (error.code !== 'MANAGER_UNREACHABLE') throw error;
    return startManager(config);
  }
}

async function apiContext(options) {
  const config = settings(options);
  await ensureManager(config);
  return { config, token: await readToken(config) };
}

async function parseJsonInput(value, field = 'input') {
  if (value === undefined) return {};
  let source = String(value);
  if (source.startsWith('@')) source = await readFile(path.resolve(source.slice(1)), 'utf8');
  try {
    const parsed = JSON.parse(source);
    if (parsed === undefined) throw new Error();
    return parsed;
  } catch {
    throw cliError('INVALID_JSON', `${field} is not valid JSON`);
  }
}

async function followTask(taskId, options, json) {
  let after = parseIntegerOption(options.after ?? 0, {
    name: '--after', minimum: 0, maximum: Number.MAX_SAFE_INTEGER
  });
  const context = await apiContext(options);
  let lastState = null;
  let historyWarningEmitted = false;
  while (true) {
    const result = await requestJson(
      context.config,
      `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${after}&limit=500`,
      { token: context.token }
    );
    if (result.truncated && !historyWarningEmitted) {
      emit(json
        ? {
            ok: true,
            taskId,
            warning: {
              code: 'TASK_EVENT_HISTORY_TRUNCATED',
              message: 'Older task events are no longer available; current state and remaining events are complete.'
            }
          }
        : {
            type: 'warning',
            code: 'TASK_EVENT_HISTORY_TRUNCATED',
            message: 'Older task events are no longer available; current state and remaining events are complete.'
          }, json);
      historyWarningEmitted = true;
    }
    for (const event of result.events) {
      after = Math.max(after, event.sequence);
      emit(json ? { ok: true, taskId, event } : event, json);
    }
    lastState = result.task;
    if (TERMINAL_TASK_STATES.has(result.task.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  emit(json ? { ok: true, task: lastState } : lastState, json);
  if (lastState.state === 'error' || lastState.state === 'stopped') process.exitCode = 1;
  return lastState;
}

async function runCommand(args, options, json) {
  const moduleArg = args[0];
  if (!moduleArg) throw cliError('TASK_MODULE_REQUIRED', 'run requires JOB.mjs');
  const modulePath = path.resolve(moduleArg);
  const timeoutMs = options.timeout === undefined
    ? undefined
    : parseIntegerOption(options.timeout, {
        name: '--timeout', minimum: 1_000, maximum: 30 * 24 * 60 * 60_000
      });
  const outputBudget = parseOutputBudgetOptions(options);
  const body = {
    modulePath,
    ...(options.profile ? { profileId: options.profile } : {}),
    ...(options.label ? { label: options.label } : {}),
    input: await parseJsonInput(options.input),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(outputBudget === undefined ? {} : { outputBudget })
  };
  const context = await apiContext(options);
  const created = await requestJson(context.config, '/v1/tasks', {
    method: 'POST',
    body,
    token: context.token,
    timeoutMs: 60_000
  });
  emit(json ? created : created.task, json);
  if (options.detach === true || options.detach === 'true') return created.task;
  return followTask(created.task.id, options, json);
}

async function taskAction(action, taskId, options, json) {
  if (!taskId) throw cliError('TASK_ID_REQUIRED', `${action} requires TASK_ID`);
  const context = await apiContext(options);
  let result;
  if (action === 'delete') {
    result = await requestJson(context.config, `/v1/tasks/${encodeURIComponent(taskId)}`, {
      method: 'DELETE', token: context.token, timeoutMs: 30_000
    });
  } else {
    result = await requestJson(context.config, `/v1/tasks/${encodeURIComponent(taskId)}/actions`, {
      method: 'POST',
      body: {
        action,
        ...(action === 'resume' && options.value !== undefined
          ? { value: await parseJsonInput(options.value, 'resume value') }
          : {})
      },
      token: context.token,
      timeoutMs: 30_000
    });
  }
  emit(result, json);
  return result;
}

async function statusCommand(taskId, options, json) {
  const context = await apiContext(options);
  const pathname = taskId ? `/v1/tasks/${encodeURIComponent(taskId)}` : '/v1/status';
  const result = await requestJson(context.config, pathname, { token: context.token });
  emit(result, json);
  return result;
}

async function profileCommand(action, args, options, json) {
  const context = await apiContext(options);
  if (action === 'list') {
    const result = await requestJson(context.config, '/v1/profiles', { token: context.token });
    emit(result, json);
    return result;
  }
  if (action === 'create') {
    const name = options.name || args[0];
    if (!name) throw cliError('PROFILE_NAME_REQUIRED', 'profiles create requires NAME');
    const result = await requestJson(context.config, '/v1/profiles', {
      method: 'POST', body: { name }, token: context.token
    });
    emit(result, json);
    return result;
  }
  const identifier = args[0];
  if (!identifier) throw cliError('PROFILE_REQUIRED', `profiles ${action} requires NAME_OR_ID`);
  let result;
  if (action === 'default' || action === 'rename') {
    const body = action === 'default'
      ? { isDefault: true }
      : { name: options.name || args[1] };
    if (action === 'rename' && !body.name) throw cliError('PROFILE_NAME_REQUIRED', 'profiles rename requires --name');
    result = await requestJson(context.config, `/v1/profiles/${encodeURIComponent(identifier)}`, {
      method: 'PATCH', body, token: context.token
    });
  } else if (action === 'delete') {
    result = await requestJson(context.config, `/v1/profiles/${encodeURIComponent(identifier)}`, {
      method: 'DELETE', token: context.token, timeoutMs: 30_000
    });
  } else if (action === 'open' || action === 'close') {
    result = await requestJson(context.config, `/v1/profiles/${encodeURIComponent(identifier)}/actions`, {
      method: 'POST', body: { action }, token: context.token, timeoutMs: 45_000
    });
  } else {
    throw cliError('UNKNOWN_COMMAND', `Unknown profiles command: ${action}`);
  }
  emit(result, json);
  return result;
}

async function filesCommand(taskId, options, json) {
  if (!taskId) throw cliError('TASK_ID_REQUIRED', 'files requires TASK_ID');
  const offset = parseIntegerOption(options.offset ?? 0, {
    name: '--offset', minimum: 0, maximum: Number.MAX_SAFE_INTEGER
  });
  const maxBytes = parseIntegerOption(options['max-bytes'] ?? 262144, {
    name: '--max-bytes', minimum: 1, maximum: 4 * 1024 * 1024
  });
  const limit = parseIntegerOption(options.limit ?? 10_000, {
    name: '--limit', minimum: 1, maximum: 10_000
  });
  const context = await apiContext(options);
  if (options.read && !json) {
    let currentOffset = offset;
    let result;
    do {
      result = await requestJson(
        context.config,
        `/v1/tasks/${encodeURIComponent(taskId)}/artifacts?path=${encodeURIComponent(options.read)}&offset=${currentOffset}&maxBytes=${maxBytes}`,
        { token: context.token }
      );
      process.stdout.write(Buffer.from(result.artifact.data, 'base64'));
      if (!result.artifact.eof && result.artifact.nextOffset <= currentOffset) {
        throw cliError('INVALID_ARTIFACT_RESPONSE', 'Manager did not advance the artifact read offset');
      }
      currentOffset = result.artifact.nextOffset;
    } while (!result.artifact.eof);
    return result;
  }

  const query = options.read
    ? `?path=${encodeURIComponent(options.read)}&offset=${offset}&maxBytes=${maxBytes}`
    : `?offset=${offset}&limit=${limit}`;
  const result = await requestJson(
    context.config,
    `/v1/tasks/${encodeURIComponent(taskId)}/artifacts${query}`,
    { token: context.token }
  );
  if (options.read) {
    emit(result, json);
  } else {
    emit(result.truncated && result.nextOffset !== null
      ? {
          ...result,
          nextAction: `Run taskmaster files ${taskId} --offset ${result.nextOffset} to read the next page.`
        }
      : result, json);
  }
  return result;
}

function openUrl(url) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(command, [url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function serveCommand(config, json) {
  const manager = await startManager({ host: config.host, port: config.port, dataDir: config.stateDir });
  const pidFile = path.join(config.stateDir, 'manager.json');
  await writeFile(pidFile, `${JSON.stringify({ pid: process.pid, version: VERSION, baseUrl: manager.baseUrl })}\n`, {
    mode: 0o600
  });
  emit({ ok: true, event: 'manager-ready', version: VERSION, pid: process.pid, baseUrl: manager.baseUrl }, json);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await manager.stop();
    } catch {
      // Keep the foreground Manager alive so a later stop can retry cleanup.
      stopping = false;
    }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  while (!manager.stopped) await new Promise((resolve) => setTimeout(resolve, 200));
  await rm(pidFile, { force: true }).catch(() => {});
}

async function managerCommand(action, options, json) {
  const config = settings(options);
  if (action === 'foreground') return serveCommand(config, json);
  if (action === 'start') {
    const current = await ensureManager(config);
    emit({ ok: true, manager: current }, json);
    return;
  }
  if (action === 'status') {
    const current = await health(config);
    emit({ ok: true, manager: current }, json);
    return;
  }
  if (action === 'stop') {
    const current = await health(config).catch((error) => {
      if (error.code === 'MANAGER_UNREACHABLE') return null;
      throw error;
    });
    if (!current) {
      emit({ ok: true, state: 'stopped' }, json);
      return;
    }
    const token = await readToken(config);
    await requestJson(config, '/v1/manager/stop', { method: 'POST', body: {}, token });
    const managerPid = Number.isSafeInteger(current.pid) && current.pid > 0 ? current.pid : null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        await health(config, 500);
      } catch (error) {
        if (error.code === 'MANAGER_UNREACHABLE') {
          while (managerPid && Date.now() < deadline && isProcessAlive(managerPid)) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (!managerPid || !isProcessAlive(managerPid)) {
            emit({ ok: true, state: 'stopped' }, json);
            return;
          }
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw cliError('MANAGER_STOP_TIMEOUT', 'Manager did not stop in time');
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown manager command: ${action}`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const options = parsed.options;
  const args = parsed.positionals;
  const json = options.json === true || options.json === 'true';
  const command = args.shift() || 'status';
  if (command === 'help' || options.help) {
    assertAllowedOptions(options);
    return emit(HELP);
  }
  if (command === 'serve') {
    assertAllowedOptions(options);
    return serveCommand(settings(options), json);
  }
  if (command === 'run') {
    assertAllowedOptions(options, ['detach', 'input', 'label', 'max-bytes', 'max-entries', 'max-files', 'profile', 'timeout']);
    return runCommand(args, options, json);
  }
  if (command === 'follow') {
    assertAllowedOptions(options, ['after']);
    return followTask(args[0], options, json);
  }
  if (command === 'status') {
    assertAllowedOptions(options);
    return statusCommand(args[0], options, json);
  }
  if (command === 'stop' || command === 'resume' || command === 'delete') {
    assertAllowedOptions(options, command === 'resume' ? ['value'] : []);
    return taskAction(command, args[0], options, json);
  }
  if (command === 'files') {
    assertAllowedOptions(options, ['limit', 'max-bytes', 'offset', 'read']);
    return filesCommand(args[0], options, json);
  }
  if (command === 'profiles') {
    const action = args.shift() || 'list';
    assertAllowedOptions(options, action === 'create' || action === 'rename' ? ['name'] : []);
    return profileCommand(action, args, options, json);
  }
  if (command === 'manager') {
    assertAllowedOptions(options);
    return managerCommand(args.shift() || 'status', options, json);
  }
  if (command === 'panel') {
    assertAllowedOptions(options);
    const context = await apiContext(options);
    openUrl(`${context.config.baseUrl}/dashboard`);
    return emit({ ok: true, url: `${context.config.baseUrl}/dashboard` }, json);
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(CLI_PATH)) main().catch((error) => {
  const parsed = parseArgs(process.argv.slice(2));
  const json = parsed.options.json === true || parsed.options.json === 'true';
  const payload = {
    ok: false,
    error: {
      code: error.code || 'TASKMASTER_FAILED',
      message: redactSensitiveText(error.message || 'Task Master failed'),
      ...(error.details === undefined ? {} : { details: redactSensitiveValue(error.details) })
    },
    ...(error.nextAction ? { nextAction: redactSensitiveText(error.nextAction) } : {})
  };
  process.stderr.write(`${json ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
