#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startManager } from './manager.mjs';
import { createTaskService } from './runtime/task-service.mjs';
import { createRegistrar } from './registration/index.mjs';
import { API_VERSION, DEFAULT_HOST, DEFAULT_PORT, isSettledTerminalTask, VERSION } from './contracts.mjs';
import {
  createIdentityNonce,
  MANAGER_SERVICE,
  validateManagerIdentityPin,
  verifyManagerIdentityProof
} from './lib/manager-identity.mjs';
import { redactSensitiveText } from './lib/redaction.mjs';
import { waitForManagerShutdownProof } from './lib/manager-shutdown-proof.mjs';
import { shutdownManagerProcess } from './lib/manager-process-shutdown.mjs';
import { readTaskPack, scaffoldTaskPack } from './lib/task-pack.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = fileURLToPath(import.meta.url);
const HELP = `eric-task-master ${VERSION}

Usage:
  taskmaster connect [--force-acceptance] [--json]
  taskmaster status [--json]
  taskmaster manager stop [--json]
  taskmaster profiles list [--json]
  taskmaster profiles create --name NAME [--kind persistent|ephemeral] [--behavior MODE] [--access private|shared] [--headless]
  taskmaster profiles update PROFILE_ID [--name NAME] [--behavior MODE] [--access private|shared]
  taskmaster profiles open|close|delete PROFILE_ID
  taskmaster task-types list [--query TEXT] [--domain HOST] [--intent INTENT] [--json]
  taskmaster task-types describe TASK_TYPE [--json]
  taskmaster task-types install --type NAME --module PATH [--json]
  taskmaster task-packs validate PATH [--json]
  taskmaster task-packs scaffold PATH --name PACK_NAME [--json]
  taskmaster task-packs install PATH [--json]
  taskmaster task list [--json]
  taskmaster task run --profile ID --type TYPE [--module PATH] [--input JSON] [--request-key KEY]
  taskmaster task status|follow|cancel TASK_ID [--json]
  taskmaster task continue TASK_ID [--request-id ID] [--note TEXT] [--json]
  taskmaster task resume TASK_ID --resume-key KEY [--detach] [--json]
  taskmaster artifacts list TASK_ID [--json]
  taskmaster artifacts read TASK_ID --artifact ARTIFACT_ID [--offset N] [--max-bytes N]
  taskmaster mcp status|register|unregister|rollback [--json]
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

async function readManagerCredentials(stateDir) {
  let config;
  try {
    config = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
  } catch {
    // The caller reports a stable connection error below.
  }
  if (typeof config?.managerToken !== 'string' || config.managerToken.length < 32) {
    throw cliError(
      'MANAGER_TOKEN_UNAVAILABLE',
      'Manager authentication token is unavailable',
      'Run the fixed connect command once.'
    );
  }
  let identity;
  try {
    identity = validateManagerIdentityPin(config.managerIdentity);
  } catch {
    throw cliError(
      'MANAGER_IDENTITY_INVALID',
      'Manager public identity pin is unavailable or invalid',
      'Restore the original Manager state or run the fixed connect command with a fresh state directory.'
    );
  }
  return { token: config.managerToken, identity };
}

async function verifyManagerEndpoint(config, identity, timeoutMs = 2_500) {
  const nonce = createIdentityNonce();
  let proof;
  try {
    proof = await requestJson(config.baseUrl, '/v1/identity/challenge', {
      method: 'POST',
      body: { nonce },
      timeoutMs
    });
    verifyManagerIdentityProof(proof, identity, {
      service: MANAGER_SERVICE,
      version: VERSION,
      apiVersion: API_VERSION,
      host: config.host,
      port: config.port,
      nonce
    });
  } catch (error) {
    if (error?.code === 'MANAGER_UNREACHABLE') throw error;
    throw cliError(
      typeof error?.code === 'string' && error.code.startsWith('MANAGER_IDENTITY_')
        ? error.code
        : 'MANAGER_IDENTITY_UNVERIFIED',
      'The service on the Manager port did not prove the pinned Manager identity.',
      'Stop the untrusted local service or restore the original Manager state, then retry.'
    );
  }
  return proof;
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
    throw cliError(
      'MANAGER_UNREACHABLE',
      redactSensitiveText(`Manager request failed: ${error.message}`),
      'Retry the fixed connect command once.'
    );
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
    throw cliError(
      detail.code || `HTTP_${response.status}`,
      redactSensitiveText(detail.message || `Manager returned ${response.status}`)
    );
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
  const spawnFailure = new Promise((_, reject) => {
    child.once('error', () => reject(cliError(
      'MANAGER_START_FAILED',
      'Manager process could not be started',
      'Check the Node.js runtime and retry the fixed connect command once.'
    )));
  });
  child.unref();
  return { health: await Promise.race([waitForManager(config), spawnFailure]), started: true };
}

async function serve(config, json) {
  const manager = await startManager({
    host: config.host,
    port: config.port,
    dataDir: config.stateDir,
    dashboardDir: resolve(ROOT, 'dashboard'),
    taskServiceFactory(taskOptions) {
      return createTaskService(taskOptions);
    }
  });
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const pidFile = join(config.stateDir, 'manager.json');
  const shutdownFailureFile = join(config.stateDir, 'manager-shutdown-failure.json');
  const pidRecord = { pid: process.pid, version: VERSION, baseUrl: manager.baseUrl };
  await rm(shutdownFailureFile, { force: true }).catch(() => {});
  await writeFile(pidFile, `${JSON.stringify(pidRecord)}\n`, { mode: 0o600 });
  emit({ ok: true, event: 'manager-ready', version: VERSION, pid: process.pid, baseUrl: manager.baseUrl }, json);

  let stopPromise;
  const stop = (trigger) => {
    if (stopPromise) return stopPromise;
    stopPromise = shutdownManagerProcess({
      manager,
      pidFile,
      failureFile: shutdownFailureFile,
      pidRecord,
      trigger
    });
    return stopPromise;
  };
  const stopAndExit = (trigger) => {
    void stop(trigger).then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`${JSON.stringify({
          ok: false,
          error: {
            code: error?.code || 'MANAGER_STOP_FAILED',
            message: redactSensitiveText(error?.message || 'Manager shutdown failed').slice(0, 2_000)
          }
        })}\n`);
        process.exit(1);
      }
    );
  };
  process.once('SIGINT', () => stopAndExit('SIGINT'));
  process.once('SIGTERM', () => stopAndExit('SIGTERM'));
  await manager.shutdownRequested;
  stopAndExit('api');
  await new Promise(() => {});
}

async function loadInput(raw) {
  if (raw === undefined) return {};
  if (raw.startsWith('@')) {
    return JSON.parse(await readFile(resolve(raw.slice(1)), 'utf8'));
  }
  return JSON.parse(raw);
}

async function stageTaskModule(config, modulePath) {
  const requested = isAbsolute(modulePath) ? modulePath : resolve(modulePath);
  const metadata = await lstat(requested).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || !requested.toLowerCase().endsWith('.mjs')) {
    throw cliError('INVALID_TASK_MODULE', 'Task module must be a regular .mjs file');
  }
  if (metadata.size < 1 || metadata.size > 2 * 1024 * 1024) {
    throw cliError('INVALID_TASK_MODULE_SIZE', 'Task module must contain 1 byte to 2 MiB');
  }
  const source = await readFile(requested);
  const sha256 = createHash('sha256').update(source).digest('hex');
  const inbox = join(config.stateDir, 'task-inbox');
  const staged = join(inbox, `${sha256}.mjs`);
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  await writeFile(staged, source, { flag: 'wx', mode: 0o600 }).catch((error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  const stagedSource = await readFile(staged);
  if (createHash('sha256').update(stagedSource).digest('hex') !== sha256) {
    throw cliError('TASK_MODULE_STAGE_CONFLICT', 'Staged task module failed its integrity check');
  }
  return staged;
}

async function apiContext(options) {
  const config = settings(options);
  await ensureManager(config);
  const credentials = await readManagerCredentials(config.stateDir);
  await verifyManagerEndpoint(config, credentials.identity);
  return { config, token: credentials.token, identity: credentials.identity };
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
    if (isSettledTerminalTask(task)) return task;
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
  const credentials = await readManagerCredentials(config.stateDir);
  await verifyManagerEndpoint(config, credentials.identity);
  const token = credentials.token;
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
  const registration = options['skip-mcp-registration']
    ? { ok: true, command: 'install', skipped: true, results: [] }
    : await createRegistrar({
      home: options.home,
      stateDir: options['registration-state-dir'],
      entrypoint: resolve(ROOT, 'src', 'mcp', 'stdio.mjs')
    }).install();
  if (!registration.ok) {
    throw cliError(
      'MCP_REGISTRATION_FAILED',
      'Task Master could not safely register one or more detected Agent hosts.',
      'Read the registration result, resolve the named conflict, and rerun connect once.'
    );
  }
  const pairing = await requestJson(config.baseUrl, '/v1/pair/authorize', {
    method: 'POST', body: {}, token
  });
  const dashboardAuthorization = await requestJson(config.baseUrl, '/v1/dashboard/authorize', {
    method: 'POST', body: {}, token
  });
  const result = {
    ok: true,
    version: VERSION,
    manager: { ...connection.health, startedNow: connection.started },
    acceptance,
    mcpRegistration: registration,
    extensionPairing: {
      pairingCode: pairing.pairingCode,
      expiresInMs: pairing.expiresInMs,
      nextAction: 'Enter this one-time code in the Task Master extension panel.'
    },
    extensionPath: resolve(ROOT, 'extension'),
    dashboard: `${config.baseUrl}/dashboard#${new URLSearchParams({ code: dashboardAuthorization.code })}`,
    nextAction: registration.results?.some((item) => item.status === 'registered_pending_restart')
      ? 'Restart or reload the registered Agent host once, then use Task Master MCP tools.'
      : 'List profiles, then ask for the browser task.'
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
      const pidFile = join(config.stateDir, 'manager.json');
      let recorded;
      try {
        recorded = JSON.parse(await readFile(pidFile, 'utf8'));
      } catch (readError) {
        if (readError?.code === 'ENOENT') {
          emit({ ok: true, stopped: false, message: 'Manager is not running' }, json);
          return;
        }
        throw cliError('MANAGER_PID_UNAVAILABLE', 'Manager PID record is unreadable; shutdown status is unconfirmed.');
      }
      throw cliError(
        'MANAGER_SHUTDOWN_UNCONFIRMED',
        `Recorded Manager process ${recorded.pid || 'unknown'} is unreachable without a clean shutdown proof.`,
        `Keep ${pidFile} intact, inspect manager-shutdown-failure.json, and recover explicitly; Task Master will never signal a persisted PID.`
      );
    }
    throw error;
  }
  const credentials = await readManagerCredentials(config.stateDir);
  await verifyManagerEndpoint(config, credentials.identity);
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
  const pidFile = join(config.stateDir, 'manager.json');
  let gracefulRequested = false;
  try {
    const accepted = await requestJson(config.baseUrl, '/v1/manager/shutdown', {
      method: 'POST',
      body: {},
      token: credentials.token,
      timeoutMs: 10_000
    });
    if (
      accepted?.accepted !== true ||
      accepted?.state !== 'stopping' ||
      accepted?.pid !== recorded.pid ||
      accepted?.identityFingerprint !== credentials.identity.fingerprint
    ) {
      throw cliError(
        'INVALID_MANAGER_SHUTDOWN_RESPONSE',
        'Manager returned an invalid graceful-shutdown acknowledgement.'
      );
    }
    gracefulRequested = true;
  } catch (error) {
    // A persisted PID is not a process identity: it may have been reused after
    // the authenticated endpoint disappeared. Fail closed instead of ever
    // signaling an unrelated process on macOS/Linux.
    throw error;
  }
  const deadline = Date.now() + 270_000;
  while (Date.now() < deadline) {
    try {
      await health(config, 500);
    } catch (error) {
      if (error.code === 'MANAGER_UNREACHABLE') {
        const cleanShutdown = await waitForManagerShutdownProof(pidFile, recorded);
        if (!cleanShutdown) {
          throw cliError(
            'MANAGER_SHUTDOWN_UNCONFIRMED',
            `Manager process ${recorded.pid} became unreachable without publishing a clean shutdown proof`,
            `Keep the Manager state directory intact and inspect ${join(config.stateDir, 'manager-shutdown-failure.json')} before restarting.`
          );
        }
        emit({ ok: true, stopped: true, graceful: gracefulRequested, pid: recorded.pid }, json);
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
      kind: options.kind || 'persistent',
      defaultBehavior: options.behavior || 'fast',
      headless: options.headless === true || options.headless === 'true',
      ...(options.access ? { access: options.access } : {}),
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
    if (options.access !== undefined) body.access = options.access;
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
  const result = await requestJson(context.config.baseUrl, route, {
    method,
    token: context.token,
    ...(action === 'open' ? { timeoutMs: 75_000 } : {}),
    ...(action === 'close' ? { timeoutMs: 45_000 } : {})
  });
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
    if (!options.type) throw cliError('TASK_TYPE_REQUIRED', '--type is required');
    if (options.module) {
      const modulePath = await stageTaskModule(context.config, options.module);
      await requestJson(context.config.baseUrl, '/v1/task-types/install', {
        method: 'POST',
        body: { name: options.type, modulePath },
        token: context.token
      });
    }
    const idempotencyKey = options['request-key'] || `cli-${randomUUID()}`;
    emit({ event: 'task-submitting', taskType: options.type, idempotencyKey }, json);
    const body = {
      profileId: options.profile,
      taskType: options.type,
      input: await loadInput(options.input),
      idempotencyKey,
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
  if (action === 'resume') {
    if (!options['resume-key']) throw cliError('RESUME_KEY_REQUIRED', 'task resume requires --resume-key KEY');
    const result = await requestJson(
      context.config.baseUrl,
      `/v1/tasks/${encodeURIComponent(taskId)}/resume`,
      { method: 'POST', body: { resumeKey: options['resume-key'] }, token: context.token }
    );
    emit({ ok: true, event: 'task-resumed', ...result }, json);
    if (options.detach) return;
    const terminal = await followTask(context, taskId, json, options);
    emit({ ok: terminal.state === 'completed', event: 'task-finished', task: terminal }, json);
    if (terminal.state !== 'completed') process.exitCode = 1;
    return;
  }
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
  if (action === 'continue') {
    const result = await requestJson(context.config.baseUrl, `/v1/tasks/${encodeURIComponent(taskId)}/continue`, {
      method: 'POST',
      token: context.token,
      body: {
        ...(options['request-id'] ? { requestId: options['request-id'] } : {}),
        ...(options.note ? { note: options.note } : {})
      }
    });
    emit({ ok: true, ...result }, json);
    return;
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown task command: ${action}`);
}

async function taskTypeCommand(action, args, options, json) {
  const context = await apiContext(options);
  if (action === 'list') {
    const query = new URLSearchParams();
    if (options.query) query.set('query', options.query);
    if (options.domain) query.set('domain', options.domain);
    if (options.intent) query.set('intent', options.intent);
    const suffix = query.size ? `?${query}` : '';
    const result = await requestJson(context.config.baseUrl, `/v1/task-types${suffix}`, { token: context.token });
    emit({ ok: true, ...result }, json);
    return;
  }
  if (action === 'describe') {
    const taskType = args[0];
    if (!taskType) throw cliError('TASK_TYPE_REQUIRED', 'task-types describe requires a task type');
    const result = await requestJson(
      context.config.baseUrl,
      `/v1/task-types/${encodeURIComponent(taskType)}`,
      { token: context.token }
    );
    emit({ ok: true, ...result }, json);
    return;
  }
  if (action === 'install') {
    if (!options.type) throw cliError('TASK_TYPE_REQUIRED', '--type is required');
    if (!options.module) throw cliError('TASK_MODULE_REQUIRED', '--module is required');
    const modulePath = await stageTaskModule(context.config, options.module);
    const result = await requestJson(context.config.baseUrl, '/v1/task-types/install', {
      method: 'POST',
      body: { name: options.type, modulePath },
      token: context.token
    });
    emit({ ok: true, ...result }, json);
    return;
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown task-types command: ${action}`);
}

function publicPack(pack) {
  return {
    name: pack.name,
    version: pack.version,
    ...(pack.title ? { title: pack.title } : {}),
    ...(pack.description ? { description: pack.description } : {}),
    tasks: pack.tasks
  };
}

async function taskPackCommand(action, args, options, json) {
  const location = args[0];
  if (!location) throw cliError('TASK_PACK_PATH_REQUIRED', `task-packs ${action} requires a path`);
  if (action === 'validate') {
    const loaded = await readTaskPack(location);
    emit({ ok: true, taskPack: publicPack(loaded.pack) }, json);
    return;
  }
  if (action === 'scaffold') {
    if (!options.name) throw cliError('TASK_PACK_NAME_REQUIRED', '--name is required');
    const created = await scaffoldTaskPack(location, { name: options.name });
    emit({ ok: true, taskPack: publicPack(created.pack) }, json);
    return;
  }
  if (action === 'install') {
    const loaded = await readTaskPack(location);
    const context = await apiContext(options);
    const modules = [];
    for (const module of loaded.modules) {
      modules.push({ name: module.name, modulePath: await stageTaskModule(context.config, module.modulePath) });
    }
    const result = await requestJson(context.config.baseUrl, '/v1/task-packs/install', {
      method: 'POST',
      token: context.token,
      body: {
        name: loaded.pack.name,
        version: loaded.pack.version,
        ...(loaded.pack.title ? { title: loaded.pack.title } : {}),
        ...(loaded.pack.description ? { description: loaded.pack.description } : {}),
        modules
      }
    });
    emit({ ok: true, ...result }, json);
    return;
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown task-packs command: ${action}`);
}

async function artifactCommand(action, args, options, json) {
  const taskId = args[0];
  if (!taskId) throw cliError('TASK_ID_REQUIRED', `artifacts ${action} requires a task ID`);
  const context = await apiContext(options);
  if (action === 'list') {
    const result = await requestJson(
      context.config.baseUrl,
      `/v1/tasks/${encodeURIComponent(taskId)}/artifacts`,
      { token: context.token }
    );
    emit({ ok: true, ...result }, json);
    return;
  }
  if (action === 'read') {
    const artifactId = options.artifact || args[1];
    if (!artifactId) throw cliError('ARTIFACT_ID_REQUIRED', 'artifacts read requires --artifact ARTIFACT_ID');
    const query = new URLSearchParams({
      offset: String(options.offset ?? 0),
      maxBytes: String(options['max-bytes'] ?? 48 * 1024)
    });
    const result = await requestJson(
      context.config.baseUrl,
      `/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}?${query}`,
      { token: context.token }
    );
    emit({ ok: true, ...result }, json);
    return;
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown artifacts command: ${action}`);
}

async function mcpCommand(action, options, json) {
  const registrar = createRegistrar({
    ...(options.home ? { home: options.home } : {}),
    ...(options['registration-state-dir'] ? { stateDir: options['registration-state-dir'] } : {}),
    entrypoint: resolve(ROOT, 'src', 'mcp', 'stdio.mjs')
  });
  const common = {
    dryRun: options['dry-run'] === true || options['dry-run'] === 'true',
    ...(options.hosts ? { hostKeys: options.hosts } : {})
  };
  const result = action === 'status'
    ? await registrar.status(common)
    : action === 'register'
      ? await registrar.install(common)
      : action === 'unregister'
        ? await registrar.uninstall(common)
        : action === 'rollback'
          ? await registrar.rollback({
            dryRun: common.dryRun,
            ...(options.transaction ? { transactionId: options.transaction } : {})
          })
          : (() => { throw cliError('UNKNOWN_COMMAND', `Unknown mcp command: ${action}`); })();
  emit(result, json);
  if (!result.ok) process.exitCode = 2;
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
  if (command === 'task-types') return taskTypeCommand(positionals.shift() || 'list', positionals, options, json);
  if (command === 'task-packs') return taskPackCommand(positionals.shift() || 'validate', positionals, options, json);
  if (command === 'task') return taskCommand(positionals.shift() || 'list', positionals, options, json);
  if (command === 'artifacts') return artifactCommand(positionals.shift() || 'list', positionals, options, json);
  if (command === 'mcp') return mcpCommand(positionals.shift() || 'status', options, json);
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
    error: {
      code: error.code || 'TASKMASTER_FAILED',
      message: redactSensitiveText(error.message)
    },
    nextAction: redactSensitiveText(
      error.nextAction || 'Read the error, correct the stated cause, and retry the same command once.'
    )
  };
  if (options.json === true || options.json === 'true') {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  process.exitCode = 1;
});
