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
import { assertSafeTaskInput, HttpTaskMasterClient } from './mcp/taskmaster-client.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = fileURLToPath(import.meta.url);
const HELP = `eric-task-master ${VERSION}

Usage:
  taskmaster connect [--force-acceptance] [--json]
  taskmaster status [--json]
  taskmaster dashboard-open [TASK_ID] [--json]
  taskmaster manager stop [--json]
  taskmaster profiles list [--json]
  taskmaster profiles create --name NAME [--kind persistent|ephemeral] [--engine chrome|chromium] [--behavior fast|adaptive|human] [--access private|shared] [--headless]
  taskmaster profiles update PROFILE_ID [--name NAME] [--behavior MODE] [--access private|shared]
  taskmaster profiles open|close PROFILE_ID
  taskmaster task-types list [--query TEXT] [--domain HOST] [--intent INTENT] [--json]
  taskmaster task-types describe TASK_TYPE [--json]
  taskmaster task-types install --type NAME --module PATH [--json]
  taskmaster task-packs validate PATH [--json]
  taskmaster task-packs scaffold PATH --name PACK_NAME [--json]
  taskmaster task-packs install PATH [--json]
  taskmaster task list [--json]
  taskmaster task start --profile ID --type TYPE --request-key KEY [--input JSON] [--json]
  taskmaster task run --profile ID --type TYPE [--module PATH] [--input JSON] [--request-key KEY]
  taskmaster task status|wait|follow|cancel TASK_ID [--json]
  taskmaster task continue TASK_ID [--request-id ID] [--note TEXT] [--json]
  taskmaster task resume TASK_ID --resume-key KEY [--detach] [--json]
  taskmaster artifacts list TASK_ID [--json]
  taskmaster artifacts read TASK_ID --artifact ARTIFACT_ID [--offset N] [--max-bytes N]
  taskmaster mcp status|register|unregister|rollback [--json]

Task start accepts registered task types only and returns immediately. Task wait is bounded to 30 seconds.
Agent-scoped commands require --agent-id STABLE_ID (or ERIC_TASK_MASTER_CLIENT_ID). Use a distinct stable ID per independent Agent; the same ID intentionally shares its private Profiles and tasks.
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
      'Restore the state directory that belongs to the running Manager, or stop it from its verified owning installation; then retry the fixed connect command once. Do not invent another controller or production port.'
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

async function verifyManagerEndpoint(config, identity, timeoutMs = 2_500, expectedVersion = VERSION) {
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
      version: expectedVersion,
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

async function health(config, timeoutMs = 1_500, expectedVersion = VERSION) {
  const result = await requestJson(config.baseUrl, '/v1/health', { timeoutMs });
  if (result.service !== 'eric-task-master') {
    throw cliError('PORT_OCCUPIED', `Port ${config.port} belongs to another service`);
  }
  if (expectedVersion !== null && result.version !== expectedVersion) {
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
  let migratedFrom;
  try {
    return { health: await health(config), started: false };
  } catch (error) {
    if (error.code === 'MANAGER_VERSION_MISMATCH') {
      const stopped = await shutdownManager(config, { requireIdle: true });
      migratedFrom = stopped.version;
    } else if (error.code !== 'MANAGER_UNREACHABLE') {
      throw error;
    }
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
  return {
    health: await Promise.race([waitForManager(config), spawnFailure]),
    started: true,
    ...(migratedFrom ? { migratedFrom } : {})
  };
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

async function agentContext(options) {
  const clientId = options['agent-id'] || process.env.ERIC_TASK_MASTER_CLIENT_ID;
  if (!clientId) {
    throw cliError(
      'AGENT_ID_REQUIRED',
      'Agent-scoped CLI commands require --agent-id STABLE_ID or ERIC_TASK_MASTER_CLIENT_ID.',
      'Choose one stable ID for this Agent, add --agent-id STABLE_ID, and reuse it on every scoped command.'
    );
  }
  const config = settings(options);
  await ensureManager(config);
  const clientName = options['agent-name'] || process.env.ERIC_TASK_MASTER_CLIENT_NAME || 'Task Master CLI';
  return {
    config,
    client: new HttpTaskMasterClient({
      baseUrl: config.baseUrl,
      stateDir: config.stateDir,
      clientId,
      clientName
    })
  };
}

async function dashboardOpenCommand(args, options, json) {
  const context = await agentContext(options);
  const taskId = args[0];
  const result = await context.client.openDashboard(taskId);
  emit({ ok: true, ...result }, json);
}

async function waitTask(context, taskId, options) {
  const waitMs = Number(options['wait-ms'] ?? 30_000);
  return context.client.waitTask(taskId, { waitMs });
}

async function followTask(context, taskId, json, options = {}) {
  const pollMs = Number(options['poll-ms'] ?? 1_000);
  const timeoutMs = Number(options['wait-ms'] ?? 24 * 60 * 60 * 1_000);
  if (!Number.isInteger(pollMs) || pollMs < 100 || pollMs > 30_000) {
    throw cliError('INVALID_POLL_INTERVAL', '--poll-ms must be an integer from 100 to 30000');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 7 * 24 * 60 * 60 * 1_000) {
    throw cliError('INVALID_FOLLOW_TIMEOUT', '--wait-ms for task follow must be an integer from 1000 to 604800000');
  }
  const deadline = Date.now() + timeoutMs;
  let previous;
  while (Date.now() < deadline) {
    const task = await context.client.getTask(taskId);
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
  const dashboardAuthorization = await requestJson(config.baseUrl, '/v1/dashboard/authorize', {
    method: 'POST', body: {}, token
  });
  const result = {
    ok: true,
    version: VERSION,
    manager: {
      ...connection.health,
      startedNow: connection.started,
      ...(connection.migratedFrom ? { migratedFrom: connection.migratedFrom } : {})
    },
    acceptance,
    mcpRegistration: registration,
    dashboard: `${config.baseUrl}/dashboard#${new URLSearchParams({ code: dashboardAuthorization.code })}`,
    nextAction: 'Match this Agent host in mcpRegistration.results. For registered_pending_restart, reload it once; for registered, use taskmaster_status then taskmaster_profiles_list. For needs_adapter, run node scripts/taskmaster.mjs status --agent-id STABLE_ID --agent-name AGENT_NAME --json, then profiles list with the same identity. Do not mix MCP and CLI identities. After status and Profile discovery succeed, ask for the browser task.'
  };
  emit(result, json);
  return result;
}

async function shutdownManager(config, { requireIdle = false } = {}) {
  let running;
  try {
    running = await health(config, 1_500, null);
  } catch (error) {
    if (error.code === 'MANAGER_UNREACHABLE') {
      const pidFile = join(config.stateDir, 'manager.json');
      let recorded;
      try {
        recorded = JSON.parse(await readFile(pidFile, 'utf8'));
      } catch (readError) {
        if (readError?.code === 'ENOENT') {
          return { ok: true, stopped: false, message: 'Manager is not running' };
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
  await verifyManagerEndpoint(config, credentials.identity, 2_500, running.version);
  if (requireIdle) {
    const counts = running.counts;
    const countKeys = ['active', 'queued', 'waitingUser', 'stalled'];
    if (
      !counts ||
      countKeys.some((key) => !Number.isInteger(counts[key]) || counts[key] < 0)
    ) {
      throw cliError(
        'MANAGER_UPGRADE_STATUS_UNAVAILABLE',
        `Manager ${running.version} did not provide a trustworthy idle-state summary.`,
        'Finish or stop the older Manager explicitly, then rerun connect once.'
      );
    }
    const { profiles } = await requestJson(config.baseUrl, '/v1/profiles', {
      token: credentials.token
    });
    if (!Array.isArray(profiles)) {
      throw cliError(
        'MANAGER_UPGRADE_STATUS_UNAVAILABLE',
        `Manager ${running.version} did not provide a trustworthy Profile summary.`,
        'Finish or stop the older Manager explicitly, then rerun connect once.'
      );
    }
    const busyTasks = countKeys.reduce((total, key) => total + counts[key], 0);
    const busyProfiles = profiles.filter((profile) => profile?.state !== 'idle').length;
    if (busyTasks > 0 || busyProfiles > 0) {
      throw cliError(
        'MANAGER_UPGRADE_BUSY',
        `Manager ${running.version} still has ${busyTasks} active/queued tasks and ${busyProfiles} non-idle Profiles.`,
        'Wait for those tasks and Profiles to settle, then rerun the exact same connect command once.'
      );
    }
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
      const observed = await health(config, 500, null);
      if (
        observed.pid !== recorded.pid ||
        observed.version !== recorded.version ||
        (observed.baseUrl !== undefined && observed.baseUrl !== recorded.baseUrl)
      ) {
        throw cliError(
          'MANAGER_SHUTDOWN_REPLACED',
          'The Manager endpoint changed identity while shutdown was in progress.'
        );
      }
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
        return {
          ok: true,
          stopped: true,
          graceful: gracefulRequested,
          pid: recorded.pid,
          version: running.version
        };
      }
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw cliError('MANAGER_STOP_TIMEOUT', `Manager process ${recorded.pid} did not stop in time`);
}

async function stopManager(options, json) {
  const result = await shutdownManager(settings(options));
  emit(result, json);
  return result;
}

async function profileCommand(action, args, options, json) {
  const context = await agentContext(options);
  if (action === 'list') {
    emit({ ok: true, profiles: await context.client.listProfiles() }, json);
    return;
  }
  if (action === 'create') {
    if (!options.name) throw cliError('PROFILE_NAME_REQUIRED', '--name is required');
    const body = {
      name: options.name,
      kind: options.kind || 'persistent',
      headless: options.headless === true || options.headless === 'true',
      ...(options.behavior ? { defaultBehavior: options.behavior } : {}),
      ...(options.access ? { access: options.access } : {}),
      ...(options.engine ? { browserEngine: options.engine } : {})
    };
    emit({ ok: true, profile: await context.client.createProfile(body) }, json);
    return;
  }
  const profileId = args[0];
  if (!profileId) throw cliError('PROFILE_ID_REQUIRED', `profiles ${action} requires a profile ID`);
  if (action === 'update') {
    const body = {};
    if (options.name !== undefined) body.name = options.name;
    if (options.behavior !== undefined) body.defaultBehavior = options.behavior;
    if (options.headless !== undefined) body.headless = options.headless === true || options.headless === 'true';
    if (options.access !== undefined) body.access = options.access;
    emit({ ok: true, profile: await context.client.updateProfile(profileId, body) }, json);
    return;
  }
  if (action === 'open' || action === 'close') {
    const profile = action === 'open'
      ? await context.client.openProfile(profileId)
      : await context.client.closeProfile(profileId);
    emit({ ok: true, profile }, json);
    return;
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown profiles command: ${action}`);
}

async function taskCommand(action, args, options, json) {
  const context = await agentContext(options);
  if (action === 'list') {
    emit({ ok: true, ...await context.client.listTasks() }, json);
    return;
  }
  if (action === 'run' || action === 'start') {
    if (!options.profile) throw cliError('PROFILE_ID_REQUIRED', '--profile is required');
    if (!options.type) throw cliError('TASK_TYPE_REQUIRED', '--type is required');
    if (action === 'start' && options.module) {
      throw cliError(
        'REGISTERED_TASK_TYPE_REQUIRED',
        'task start accepts registered task types only; --module is not supported'
      );
    }
    if (action === 'start' && !options['request-key']) {
      throw cliError('REQUEST_KEY_REQUIRED', 'task start requires a stable --request-key KEY');
    }
    if (options.module) {
      const admin = await apiContext(options);
      const modulePath = await stageTaskModule(admin.config, options.module);
      await requestJson(admin.config.baseUrl, '/v1/task-types/install', {
        method: 'POST',
        body: { name: options.type, modulePath },
        token: admin.token
      });
    }
    const idempotencyKey = options['request-key'] || `cli-${randomUUID()}`;
    if (action === 'run') emit({ event: 'task-submitting', taskType: options.type, idempotencyKey }, json);
    const input = await loadInput(options.input);
    assertSafeTaskInput(input);
    const body = {
      profileId: options.profile,
      taskType: options.type,
      input,
      idempotencyKey,
      ...(options.timeout ? { timeoutMs: Number(options.timeout) } : {})
    };
    const { taskId, dashboardUrl, task } = await context.client.startTask(body);
    emit({ ok: true, event: 'task-started', taskId, dashboardUrl, task }, json);
    if (action === 'start' || options.detach) return;
    const terminal = await followTask(context, task.id, json, options);
    emit({ ok: terminal.state === 'completed', event: 'task-finished', task: terminal }, json);
    if (terminal.state !== 'completed') process.exitCode = 1;
    return;
  }
  const taskId = args[0];
  if (!taskId) throw cliError('TASK_ID_REQUIRED', `task ${action} requires a task ID`);
  if (action === 'resume') {
    if (!options['resume-key']) throw cliError('RESUME_KEY_REQUIRED', 'task resume requires --resume-key KEY');
    const result = await context.client.resumeTask({ taskId, resumeKey: options['resume-key'] });
    emit({ ok: true, event: 'task-resumed', ...result }, json);
    if (options.detach) return;
    const terminal = await followTask(context, taskId, json, options);
    emit({ ok: terminal.state === 'completed', event: 'task-finished', task: terminal }, json);
    if (terminal.state !== 'completed') process.exitCode = 1;
    return;
  }
  if (action === 'status') {
    emit({ ok: true, task: await context.client.getTask(taskId) }, json);
    return;
  }
  if (action === 'wait') {
    emit({ ok: true, ...await waitTask(context, taskId, options) }, json);
    return;
  }
  if (action === 'follow') {
    const terminal = await followTask(context, taskId, json, options);
    emit({ ok: terminal.state === 'completed', event: 'task-finished', task: terminal }, json);
    if (terminal.state !== 'completed') process.exitCode = 1;
    return;
  }
  if (action === 'cancel') {
    emit({ ok: true, task: await context.client.cancelTask(taskId) }, json);
    return;
  }
  if (action === 'continue') {
    const task = await context.client.continueTask({
      taskId,
      ...(options['request-id'] ? { requestId: options['request-id'] } : {}),
      ...(options.note ? { note: options.note } : {})
    });
    emit({ ok: true, task }, json);
    return;
  }
  throw cliError('UNKNOWN_COMMAND', `Unknown task command: ${action}`);
}

async function taskTypeCommand(action, args, options, json) {
  if (action === 'list') {
    const context = await agentContext(options);
    const taskTypes = await context.client.listTaskTypes({
      ...(options.query ? { query: options.query } : {}),
      ...(options.domain ? { domain: options.domain } : {}),
      ...(options.intent ? { intent: options.intent } : {})
    });
    emit({ ok: true, taskTypes }, json);
    return;
  }
  if (action === 'describe') {
    const context = await agentContext(options);
    const taskType = args[0];
    if (!taskType) throw cliError('TASK_TYPE_REQUIRED', 'task-types describe requires a task type');
    emit({ ok: true, taskType: await context.client.describeTaskType(taskType) }, json);
    return;
  }
  if (action === 'install') {
    if (!options.type) throw cliError('TASK_TYPE_REQUIRED', '--type is required');
    if (!options.module) throw cliError('TASK_MODULE_REQUIRED', '--module is required');
    const admin = await apiContext(options);
    const modulePath = await stageTaskModule(admin.config, options.module);
    const result = await requestJson(admin.config.baseUrl, '/v1/task-types/install', {
      method: 'POST',
      body: { name: options.type, modulePath },
      token: admin.token
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
  const context = await agentContext(options);
  if (action === 'list') {
    emit({ ok: true, artifacts: await context.client.listArtifacts(taskId) }, json);
    return;
  }
  if (action === 'read') {
    const artifactId = options.artifact || args[1];
    if (!artifactId) throw cliError('ARTIFACT_ID_REQUIRED', 'artifacts read requires --artifact ARTIFACT_ID');
    const result = await context.client.readArtifact({
      taskId,
      artifactId,
      offset: Number(options.offset ?? 0),
      maxBytes: Number(options['max-bytes'] ?? 48 * 1024)
    });
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
  if (command === 'dashboard-open') return dashboardOpenCommand(positionals, options, json);
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
    const context = await agentContext(options);
    emit({ ok: true, status: await context.client.getStatus() }, json);
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
