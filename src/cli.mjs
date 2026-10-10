#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { access, appendFile, mkdir, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION, DEFAULT_HOST, DEFAULT_PORT, PROFILE_ACTION_TIMEOUT_MS, TERMINAL_TASK_STATES, VERSION } from './contracts.mjs';
import { isProcessAlive } from './lib/process-tree.mjs';
import { ManagerLock } from './lib/manager-lock.mjs';
import { consolidateLegacySharedState } from './lib/state-upgrade.mjs';
import { defaultDataDirectory, startManager } from './manager.mjs';
import { managerOwnershipProof, managerRecoveryProof, managerStateId, readManagerConfig } from './lib/manager-state.mjs';
import {
  chooseDefaultState, projectStateEnvironment, readDefaultStateLocation, readStateEndpoint,
  rememberDefaultStateLocation, stateEnvironment, writeStateEndpoint
} from './lib/state-directory.mjs';
import { redactSensitiveText, redactSensitiveValue } from './lib/redaction.mjs';

const CLI_PATH = fileURLToPath(import.meta.url);
const HELP = `Eric Task Master ${VERSION}

Fast path:
  taskmaster run JOB.mjs [--profile NAME_OR_ID] [--input JSON_OR_@FILE] [--label TEXT] [--request-key KEY] [--detach]

Tasks:
  taskmaster follow TASK_ID [--after SEQUENCE] [--wait-ms 0..60000]
  taskmaster status [TASK_ID]
  taskmaster stop TASK_ID
  taskmaster resume TASK_ID [--probe PROBE_ID] [--value JSON_OR_@FILE]
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
  taskmaster manager start [--upgrade]
  taskmaster manager foreground|status|stop|recover

All commands accept --json. Manager starts automatically when needed.
panel opens the Dashboard; panel --json returns its URL without opening a browser.
Compatible running Managers are reused, including manager start. --upgrade is explicit and idle-only.
Data is independent of the application and Agent host. Defaults share one selected state.
--state-dir DIR isolates a project and discovers its own port unless --port is supplied.
follow --wait-ms returns current state and an after cursor when the wait expires.`;

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

async function settings(options = {}, { serving = false } = {}) {
  const host = options.host || process.env.ERIC_TASK_MASTER_HOST || DEFAULT_HOST;
  if (host !== DEFAULT_HOST) throw cliError('LOOPBACK_REQUIRED', `Manager must use ${DEFAULT_HOST}`);
  const explicitState = Boolean(options['state-dir'] || process.env.ERIC_TASK_MASTER_HOME);
  const shared = options.shared === true || !explicitState;
  const environment = stateEnvironment();
  const location = !explicitState ? await readDefaultStateLocation(environment) : null;
  const requestedStateDir = path.resolve(options['state-request'] || options['state-dir'] ||
    process.env.ERIC_TASK_MASTER_HOME || location?.stateDir || defaultDataDirectory());
  const projectEnvironment = !shared ? projectStateEnvironment(requestedStateDir, environment) : null;
  const projectLocation = projectEnvironment ? await readDefaultStateLocation(projectEnvironment) : null;
  const stateDir = projectLocation?.stateDir || path.resolve(options['state-dir'] ||
    process.env.ERIC_TASK_MASTER_HOME || location?.stateDir || defaultDataDirectory());
  const explicitPort = options.port !== undefined || process.env.ERIC_TASK_MASTER_PORT !== undefined;
  const autoPort = !shared && !explicitPort && !serving;
  let port = autoPort ? 0 : parseIntegerOption(
    options.port ?? process.env.ERIC_TASK_MASTER_PORT ?? location?.port ?? DEFAULT_PORT,
    { name: '--port', minimum: serving ? 0 : 1, maximum: 65_535 }
  );
  if (autoPort) {
    const endpoint = await readStateEndpoint(stateDir);
    if (endpoint && isProcessAlive(endpoint.pid)) port = endpoint.port;
  }
  return {
    host, port, stateDir, baseUrl: `http://${host}:${port}`,
    shared, autoPort, discoverDefault: shared && !explicitState, environment,
    identityDir: projectLocation?.identityDir || location?.identityDir || stateDir,
    requestedStateDir, projectEnvironment,
    stateDirAliases: options['state-alias'] ? [path.resolve(options['state-alias'])] :
      projectLocation?.identityDir !== undefined && projectLocation.identityDir !== stateDir ? [projectLocation.identityDir] : []
  };
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

async function requestJson(config, pathname, { method = 'GET', body, token, timeoutMs = 30_000, refreshAuth = true } = {}) {
  let response;
  let source;
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
    source = await response.text();
  } catch (error) {
    throw Object.assign(cliError('MANAGER_UNREACHABLE', `Manager request failed: ${error.message}`), { cause: error });
  }
  let payload = {};
  try {
    payload = source ? JSON.parse(source) : {};
  } catch {
    throw cliError('INVALID_MANAGER_RESPONSE', `Manager returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    if (refreshAuth && token && response.status === 401 && payload.error?.code === 'AUTH_REQUIRED') {
      const credentials = await readManagerCredentials(config).catch(() => null);
      if (credentials?.stateId && credentials.token !== token) {
        const current = await health(config);
        if (current.apiVersion === API_VERSION) {
          // AUTH_REQUIRED is returned before dispatch. Refresh once for a long
          // follow/request that began before an on-disk token rotation.
          return requestJson(config, pathname, {
            method, body, token: credentials.token, timeoutMs, refreshAuth: false
          });
        }
      }
    }
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

async function rawHealth(config, timeoutMs = 1_500, nonce = null) {
  if (config.projectEnvironment) {
    const location = await readDefaultStateLocation(config.projectEnvironment);
    if (location) {
      config.stateDir = location.stateDir;
      config.identityDir = location.identityDir;
    }
  }
  if (config.autoPort) {
    const endpoint = await readStateEndpoint(config.stateDir);
    if (endpoint && isProcessAlive(endpoint.pid)) {
      config.port = endpoint.port;
      config.baseUrl = endpoint.baseUrl;
    }
  }
  if (!config.port) throw cliError('MANAGER_UNREACHABLE', 'The project Manager has not published its endpoint');
  const result = await requestJson(config, '/v1/health' + (nonce ? '?nonce=' + encodeURIComponent(nonce) : ''), { timeoutMs });
  if (result.service !== 'eric-task-master') throw cliError('PORT_OCCUPIED', 'Manager port belongs to another service');
  return result;
}

async function readManagerCredentials(config) {
  try {
    const value = await readManagerConfig(path.join(config.stateDir, 'config.json'));
    const physicalDir = path.dirname(await realpath(path.join(config.stateDir, 'config.json')));
    return {
      token: value.managerToken,
      stateId: managerStateId(value.stateInstanceId, config.identityDir || config.stateDir),
      stateDirectoryId: managerStateId(value.stateInstanceId, physicalDir),
      stateDirEffective: physicalDir
    };
  } catch {
    throw cliError('MANAGER_TOKEN_UNAVAILABLE', 'Manager local token is unavailable');
  }
}

async function readToken(config) {
  return (await readManagerCredentials(config)).token;
}

function managerStateMismatch(manager, config, credentials = null) {
  const error = cliError(
    'MANAGER_STATE_MISMATCH',
    'The running Manager does not own the current local state',
    manager?.stateChanged === true
      ? 'Run taskmaster manager start. An idle stale Manager will be replaced automatically; active work is never terminated automatically.'
      : 'This port belongs to a Manager with another state view. Check the OS user, --state-dir and --port; keep the existing Profiles and do not reinstall. Stop that exact Manager only after confirming it has no active work, then start from the intended state.'
  );
  error.manager = manager;
  error.details = {
    stateDir: path.resolve(config.stateDir), port: config.port,
    expectedStateId: credentials?.stateId ?? null,
    actualStateId: manager?.stateId ?? null,
    managerVersion: manager?.version ?? null,
    stateChanged: manager?.stateChanged === true,
    ...(manager?.stateDirectoryId ? {
      expectedDirectoryId: credentials?.stateDirectoryId ?? null,
      actualDirectoryId: manager.stateDirectoryId,
      stateDirEffective: credentials?.stateDirEffective ?? null
    } : {})
  };
  return error;
}

async function health(config, timeoutMs = 1_500) {
  const result = await rawHealth(config, timeoutMs);
  if (config.discoverDefault && typeof result.stateId === 'string') {
    try {
      const selected = await chooseDefaultState({ environment: config.environment, manager: result });
      config.stateDir = selected.stateDir;
      config.identityDir = selected.identityDir;
      config.stateDirAliases = selected.identityDir === selected.stateDir ? [] : [selected.identityDir];
    } catch (error) {
      if (error.code !== 'MANAGER_STATE_MISMATCH') throw error;
      throw managerStateMismatch(result, config);
    }
  }
  let mismatch = result.stateChanged === true;
  let credentials = null;
  if (typeof result.stateId === 'string') {
    if (result.stateDirectoryId && typeof result.stateDirLogical === 'string' && path.isAbsolute(result.stateDirLogical)) {
      config.identityDir = path.resolve(result.stateDirLogical);
    }
    credentials = await readManagerCredentials(config);
    mismatch ||= credentials.stateId !== result.stateId;
    if (result.stateDirectoryId) {
      mismatch ||= credentials.stateDirectoryId !== result.stateDirectoryId;
      if (result.stateChanged !== true &&
          credentials.stateDirEffective.toLowerCase() !== result.stateDirEffective?.toLowerCase()) mismatch = true;
      if (!mismatch || result.stateChanged === true) {
        if (!result.capabilities?.includes('manager.owner-proof')) {
          throw cliError('MANAGER_OWNER_UNVERIFIED', 'Manager cannot prove ownership of the advertised state location');
        }
        const nonce = randomUUID();
        const proven = await rawHealth(config, timeoutMs, nonce);
        const expected = managerOwnershipProof(credentials.token, result, nonce);
        const supplied = typeof proven.ownerProof === 'string' ? proven.ownerProof : '';
        if (!expected || supplied.length !== expected.length ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
          throw cliError('MANAGER_OWNER_UNVERIFIED', 'Manager state ownership proof did not match; no credentials were sent');
        }
      }
    }
  }
  if (mismatch) throw managerStateMismatch(result, config, credentials);
  return result;
}

async function prepareStateForStart(config, { upgrade = false } = {}) {
  if (config.discoverDefault) {
    const selected = await chooseDefaultState({ environment: config.environment });
    config.stateDir = selected.stateDir;
    config.identityDir = selected.identityDir;
    config.stateDirAliases = selected.identityDir === selected.stateDir ? [] : [selected.identityDir];
  }
  if (config.autoPort) {
    config.port = 0;
    config.baseUrl = 'http://' + config.host + ':0';
  }
  if (upgrade) await consolidateLegacySharedState(config);
}

async function rememberSharedState(config, manager) {
  if (!config.shared || manager.scope === 'project') return;
  // Legacy Managers have no ownership proof. Validate the retained credentials
  // against a read-only protected request before recording a shared location.
  if (!manager.stateDirectoryId) {
    await requestJson(config, '/v1/status', { token: await readToken(config) });
  }
  let launcher = null;
  const candidate = path.resolve(path.dirname(CLI_PATH), '..', '..', 'bin',
    process.platform === 'win32' ? 'taskmaster.cmd' : 'taskmaster');
  try {
    await access(candidate);
    launcher = await realpath(candidate);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const credentials = await readManagerCredentials(config);
  await rememberDefaultStateLocation({
    stateDir: credentials.stateDirEffective, identityDir: config.identityDir || config.stateDir,
    port: config.port, ...(launcher ? { launcher } : {})
  }, config.environment);
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

export async function startBackgroundManager(config, options = {}) {
  if (!config.projectEnvironment) return spawnBackgroundManager(config, options);
  // A lexical AppData path can resolve to different stores in different hosts.
  // This short bootstrap lock is deliberately outside AppData, unlike the
  // lifetime lock held inside the selected physical data project.
  const bootstrap = new ManagerLock(config.projectEnvironment.locatorFile + '.startup.lock');
  try {
    await bootstrap.acquire();
  } catch (error) {
    if (!['MANAGER_ALREADY_RUNNING', 'MANAGER_LOCK_BUSY'].includes(error.code)) throw error;
    return (options.waitForReady || waitForManager)(config);
  }
  try {
    try { return await health(config); } catch (error) {
      if (error.code !== 'MANAGER_UNREACHABLE') throw error;
    }
    return await spawnBackgroundManager(config, options);
  } finally {
    await bootstrap.release();
  }
}

async function spawnBackgroundManager(config, {
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
      ...(config.shared ? ['--shared'] : []),
      ...(config.stateDirAliases?.[0] ? ['--state-alias', config.stateDirAliases[0]] : []),
      ...(config.projectEnvironment ? ['--state-request', config.requestedStateDir] : []),
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
  // Observe early rejection while descriptor cleanup yields; the await below still propagates it.
  readyOrFailed.catch(() => {});
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
    if (managerPid && !isProcessAlive(managerPid)) return true;
    try {
      await rawHealth(config, 500);
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

async function recoverChangedManager(config, mismatch, startManager, { force = false } = {}) {
  const current = mismatch.manager;
  if (!current?.capabilities?.includes('manager.state-recovery') ||
      current.stateChanged !== true || typeof current.recoveryNonce !== 'string') throw mismatch;
  const { token } = await readManagerCredentials(config);
  const proof = managerRecoveryProof(token, current.stateId, current.recoveryNonce, { force });
  if (!proof) throw mismatch;
  try {
    await requestJson(config, '/v1/manager/recover', {
      method: 'POST',
      body: { force, proof },
      timeoutMs: force ? 90_000 : 30_000
    });
  } catch (error) {
    if (error.code === 'RECOVERY_PROOF_REQUIRED' || error.code === 'MANAGER_STATE_CURRENT') {
      // Another local client may already have recovered it, or a brief config
      // rewrite may have completed. Recheck identity without sending a token.
      const settled = await health(config).catch(() => null);
      if (settled?.apiVersion === API_VERSION) return settled;
      mismatch.nextAction = 'Another state directory owns this loopback port. Use its matching --state-dir/--port or stop that Manager explicitly.';
      throw mismatch;
    }
    if (error.code === 'MANAGER_BUSY') {
      error.nextAction = 'The stale Manager still has active work or an open Profile. Run taskmaster manager recover to contain that work explicitly, then reload the current state.';
    }
    throw error;
  }
  if (!(await waitForManagerStop(config, 20_000, current.pid))) {
    throw cliError(
      'MANAGER_RECOVERY_TIMEOUT',
      'The stale Manager accepted recovery but did not stop in time',
      'Close the stale Manager process, then run taskmaster manager start again.'
    );
  }
  return startManager(config);
}

export async function ensureManager(config, { startManager = startBackgroundManager, maintainVersion = false } = {}) {
  let current;
  try {
    current = await health(config);
  } catch (error) {
    if (error.code === 'MANAGER_UNREACHABLE') {
      await prepareStateForStart(config, { upgrade: maintainVersion });
      const started = await startManager(config);
      await rememberSharedState(config, started);
      return started;
    }
    if (error.code === 'MANAGER_STATE_MISMATCH') {
      const recovered = await recoverChangedManager(config, error, startManager);
      await rememberSharedState(config, recovered);
      return recovered;
    }
    throw error;
  }
  if (current.apiVersion !== API_VERSION) {
    throw cliError(
      'MANAGER_API_INCOMPATIBLE',
      `Running Manager API ${current.apiVersion} is incompatible with ${API_VERSION}`,
      'Finish or stop the existing work, stop the Manager with its compatible CLI, then run manager start.'
    );
  }
  if (!maintainVersion || current.version === VERSION) {
    await rememberSharedState(config, current);
    return current;
  }
  const runningVersion = String(current.version || '').split('.').map(Number);
  const installedVersion = VERSION.split('.').map(Number);
  if (runningVersion.length !== 3 || !runningVersion.every(Number.isSafeInteger)) {
    throw cliError('MANAGER_VERSION_UNVERIFIED', 'Manager version cannot be compared safely for an explicit upgrade');
  }
  if (runningVersion.some((part, index) => part !== installedVersion[index])) {
    const index = runningVersion.findIndex((part, offset) => part !== installedVersion[offset]);
    if (runningVersion[index] > installedVersion[index]) {
      throw cliError('MANAGER_DOWNGRADE_REFUSED', 'An older Agent CLI cannot downgrade the shared Manager');
    }
  }
  if (!current.capabilities?.includes('manager.idle-stop')) {
    throw cliError(
      'MANAGER_CAPABILITY_UNAVAILABLE',
      `Manager ${current.version || 'unknown'} cannot guard an idle version replacement`,
      'Keep using the compatible running Manager. To update, finish the existing work, close its Profiles, explicitly run taskmaster manager stop, then taskmaster manager start.'
    );
  }

  const token = await readToken(config);
  const status = await requestJson(config, '/v1/status', { token });
  const activeTasks = Number(status.tasks?.running || 0) + Number(status.tasks?.queued || 0);
  if (activeTasks > 0) {
    throw cliError(
      'MANAGER_VERSION_MISMATCH',
      `Manager ${current.version || 'unknown'} has ${activeTasks} active task(s) and cannot be replaced by CLI ${VERSION}`,
      'Let the active tasks finish or stop them, then run taskmaster manager start --upgrade.'
    );
  }
  const { profiles } = await requestJson(config, '/v1/profiles', { token });
  if (!Array.isArray(profiles)) {
    throw cliError('INVALID_MANAGER_RESPONSE', 'Manager did not return its Profiles for version maintenance');
  }
  const occupiedProfiles = profiles.filter((profile) => profile.lease || ['opening', 'open', 'closing'].includes(profile.state));
  if (occupiedProfiles.length) {
    throw cliError(
      'MANAGER_VERSION_MISMATCH',
      `Manager ${current.version || 'unknown'} has ${occupiedProfiles.length} occupied Profile(s) and cannot be replaced by CLI ${VERSION}`,
      'Close the occupied Profiles, then run taskmaster manager start --upgrade. Existing task and Profile controls remain available.'
    );
  }
  await requestJson(config, '/v1/manager/stop', { method: 'POST', body: { onlyIfIdle: true }, token });
  if (!(await waitForManagerStop(config, 20_000, current.pid))) {
    throw cliError(
      'MANAGER_VERSION_MISMATCH',
      `Manager ${current.version || 'unknown'} did not stop for the CLI ${VERSION} upgrade`,
      'Stop the old Manager manually, then run the command again.'
    );
  }
  await prepareStateForStart(config, { upgrade: maintainVersion });
  const started = await startManager(config);
  await rememberSharedState(config, started);
  return started;
}

async function apiContext(options) {
  const config = await settings(options);
  const manager = await ensureManager(config);
  return { config, token: await readToken(config), manager };
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

async function followTask(taskId, options, json, existingContext = null) {
  if (!taskId) throw cliError('TASK_ID_REQUIRED', 'follow requires TASK_ID');
  let after = parseIntegerOption(options.after ?? 0, {
    name: '--after', minimum: 0, maximum: Number.MAX_SAFE_INTEGER
  });
  const waitMs = options['wait-ms'] === undefined ? null : parseIntegerOption(options['wait-ms'], {
    name: '--wait-ms', minimum: 0, maximum: 60_000
  });
  const context = existingContext || await apiContext(options);
  const deadline = waitMs === null ? Infinity : Date.now() + waitMs;
  let lastState = null;
  let historyWarningEmitted = false;
  const returnSnapshot = () => {
    emit({ ok: true, task: lastState, state: lastState.state, attention: null, after }, json);
    return lastState;
  };
  while (true) {
    const previousAfter = after;
    let result;
    try {
      result = await requestJson(
        context.config,
        `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${after}&limit=500`,
        {
          token: context.token,
          timeoutMs: lastState && waitMs !== null ? Math.max(1, Math.min(30_000, deadline - Date.now())) : 30_000
        }
      );
    } catch (error) {
      if (lastState && waitMs !== null && Date.now() >= deadline && error.cause?.name === 'TimeoutError') return returnSnapshot();
      throw error;
    }
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
    let attention = null;
    for (const event of result.events) {
      after = Math.max(after, event.sequence);
      if (event.type === 'task.event' && event.data?.type === 'verification.probe') {
        if (result.task.state !== 'waiting' || result.task.waiting?.id !== event.data.waitId ||
            result.task.waiting?.probeId !== event.data.probeId || result.task.waiting?.automaticPaused) continue;
        attention = event.data;
      }
      if (event.type === 'task.event' && event.data?.type === 'verification.paused') {
        if (result.task.state !== 'waiting' || result.task.waiting?.id !== event.data.waitId ||
            !result.task.waiting?.automaticPaused) continue;
        attention = { ...event.data, needsAgentDecision: false, manualResumeRequired: true };
      }
      emit(json ? { ok: true, taskId, event } : event, json);
    }
    if (Number.isSafeInteger(result.nextAfter)) after = Math.max(after, result.nextAfter);
    lastState = result.task;
    const hasMore = Number.isSafeInteger(lastState.eventSequence)
      ? after < lastState.eventSequence
      : result.events.length === 500;
    if (hasMore && after <= previousAfter) {
      throw cliError('INVALID_EVENT_RESPONSE', 'Manager did not advance the task event cursor');
    }
    if (TERMINAL_TASK_STATES.has(lastState.state) && !hasMore) break;
    if (lastState.state === 'waiting' && lastState.waiting?.automaticPaused && !hasMore) {
      attention ||= { type: 'verification.paused', ...lastState.waiting, needsAgentDecision: false, manualResumeRequired: true };
    }
    if (waitMs !== null && lastState.state === 'waiting' && !hasMore) {
      attention ||= { type: 'task.waiting', ...lastState.waiting };
    }
    if (attention) {
      emit(json ? { ok: true, task: lastState, state: lastState.state, attention, after } : { task: lastState, state: lastState.state, attention, after }, json);
      return lastState;
    }
    if (Date.now() >= deadline) return returnSnapshot();
    if (hasMore) continue;
    const remainingWaitMs = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, remainingWaitMs)));
    // The final wait completes this call even if the OS timer wakes a little early.
    if (remainingWaitMs <= 500 || Date.now() >= deadline) return returnSnapshot();
  }
  emit(json ? { ok: true, task: lastState, state: lastState.state, after } : { task: lastState, state: lastState.state, after }, json);
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
  const requestKey = options['request-key'];
  if (requestKey !== undefined && (typeof requestKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(requestKey))) {
    throw cliError('INVALID_REQUEST_KEY', '--request-key requires 1-160 letters, digits, dots, underscores, colons or hyphens, starting with a letter or digit');
  }
  const body = {
    modulePath,
    ...(options.profile ? { profileId: options.profile } : {}),
    ...(options.label ? { label: options.label } : {}),
    input: await parseJsonInput(options.input),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(outputBudget === undefined ? {} : { outputBudget }),
    ...(requestKey === undefined ? {} : { requestKey })
  };
  const context = await apiContext(options);
  if (requestKey !== undefined && !context.manager.capabilities?.includes('task.request-key')) {
    throw cliError(
      'MANAGER_CAPABILITY_UNAVAILABLE',
      `Manager ${context.manager.version || 'unknown'} does not support --request-key`,
      'Finish the existing work and close its Profiles, then run taskmaster manager start --upgrade to update the Manager. Task controls remain available.'
    );
  }
  const created = await requestJson(context.config, '/v1/tasks', {
    method: 'POST',
    body,
    token: context.token,
    timeoutMs: 60_000
  });
  emit(json ? created : created.task, json);
  if (options.detach === true || options.detach === 'true') return created.task;
  return followTask(created.task.id, options, json, context);
}

async function taskAction(action, taskId, options, json) {
  if (!taskId) throw cliError('TASK_ID_REQUIRED', `${action} requires TASK_ID`);
  if (options.probe !== undefined &&
      (typeof options.probe !== 'string' || !options.probe.trim() || options.probe.length > 160)) {
    throw cliError('INVALID_PROBE_ID', '--probe requires a non-empty probe ID');
  }
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
        ...(action === 'resume' && options.probe !== undefined ? { probeId: options.probe } : {}),
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
      method: 'POST', body: { action }, token: context.token,
      timeoutMs: action === 'open' ? PROFILE_ACTION_TIMEOUT_MS : 45_000
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

async function serveCommand(config, json, { onReady = async () => {} } = {}) {
  const manager = await startManager({
    host: config.host, port: config.port, dataDir: config.stateDir,
    identityDir: config.stateDirAliases[0] || config.identityDir,
    scope: config.shared ? 'shared' : 'project', stateDirAliases: config.stateDirAliases
  });
  try {
    await writeStateEndpoint(manager.stateLocation.stateDirEffective, {
      pid: process.pid, version: VERSION, baseUrl: manager.baseUrl
    });
    if (config.projectEnvironment) {
      await rememberDefaultStateLocation({
        stateDir: manager.stateLocation.stateDirEffective,
        identityDir: manager.stateLocation.stateDirLogical,
        port: manager.address.port
      }, config.projectEnvironment);
    }
    await onReady();
  } catch (error) {
    await manager.stop();
    throw error;
  }
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
  // Retain the last endpoint for diagnostics. Discovery checks its live PID;
  // deleting it after releasing the lifetime lock could erase a successor's endpoint.
}

async function managerCommand(action, options, json) {
  const config = await settings(options);
  if (action === 'foreground') {
    try {
      const current = await health(config);
      emit({ ok: true, manager: current, reused: true }, json);
      return;
    } catch (error) { if (error.code !== 'MANAGER_UNREACHABLE') throw error; }
    await prepareStateForStart(config);
    if (config.projectEnvironment) {
      const bootstrap = new ManagerLock(config.projectEnvironment.locatorFile + '.startup.lock');
      try { await bootstrap.acquire(); } catch (error) {
        if (!['MANAGER_ALREADY_RUNNING', 'MANAGER_LOCK_BUSY'].includes(error.code)) throw error;
        emit({ ok: true, manager: await waitForManager(config), reused: true }, json);
        return;
      }
      try {
        try {
          const current = await health(config);
          emit({ ok: true, manager: current, reused: true }, json);
          return;
        } catch (error) { if (error.code !== 'MANAGER_UNREACHABLE') throw error; }
        return await serveCommand(config, json, { onReady: () => bootstrap.release() });
      } finally { await bootstrap.release(); }
    }
    return serveCommand(config, json);
  }
  if (action === 'start') {
    const current = await ensureManager(config, { maintainVersion: options.upgrade === true });
    emit({ ok: true, manager: current }, json);
    return;
  }
  if (action === 'status') {
    const current = await health(config);
    emit({ ok: true, manager: current }, json);
    return;
  }
  if (action === 'recover') {
    let current;
    try { current = await health(config); } catch (error) {
      if (error.code !== 'MANAGER_STATE_MISMATCH') throw error;
      current = error.manager;
    }
    if (current.apiVersion !== API_VERSION) {
      throw cliError('MANAGER_API_INCOMPATIBLE', `Manager API ${current.apiVersion} is incompatible with ${API_VERSION}`);
    }
    const credentials = typeof current.stateId === 'string' ? await readManagerCredentials(config) : null;
    if (current.stateChanged !== true) {
      if (typeof current.stateId === 'string') {
        if (credentials.stateId !== current.stateId) throw managerStateMismatch(current, config, credentials);
      } else {
        // Older Managers cannot advertise or recover credential drift. Verify
        // their protected API before claiming that no recovery is needed.
        try {
          await requestJson(config, '/v1/status', { token: await readToken(config) });
        } catch (error) {
          if (error.code !== 'AUTH_REQUIRED') throw error;
          throw cliError(
            'LEGACY_MANAGER_RESTART_REQUIRED',
            'The older Manager has stale local credentials and cannot recover them while running',
            'Close the old Task Master Manager and its task windows, or restart the computer, then rerun the installer and taskmaster manager start. Keep the existing state directory.'
          );
        }
      }
      emit({ ok: true, manager: current, recovered: false }, json);
      return;
    }
    const recovered = await recoverChangedManager(
      config,
      managerStateMismatch(current, config, credentials),
      startBackgroundManager,
      { force: true }
    );
    emit({ ok: true, manager: recovered, recovered: true }, json);
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
    await requestJson(config, '/v1/manager/stop', {
      method: 'POST', body: options['if-idle'] === true ? { onlyIfIdle: true } : {}, token
    });
    const managerPid = Number.isSafeInteger(current.pid) && current.pid > 0 ? current.pid : null;
    const deadline = Date.now() + 20_000;
    let stopObservation = null;
    while (Date.now() < deadline) {
      if (managerPid && !isProcessAlive(managerPid)) {
        emit({ ok: true, state: 'stopped' }, json);
        return;
      }
      try {
        const observed = await health(config, 500);
        stopObservation = { state: observed.state, pid: observed.pid };
      } catch (error) {
        stopObservation = { error: error.code };
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
    const error = cliError('MANAGER_STOP_TIMEOUT', 'Manager did not stop in time');
    error.details = { pid: managerPid, processAlive: managerPid ? isProcessAlive(managerPid) : null, lastObservation: stopObservation };
    throw error;
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
    assertAllowedOptions(options, ['shared', 'state-alias', 'state-request']);
    return serveCommand(await settings(options, { serving: true }), json);
  }
  if (command === 'run') {
    assertAllowedOptions(options, ['detach', 'input', 'label', 'max-bytes', 'max-entries', 'max-files', 'profile', 'request-key', 'timeout']);
    return runCommand(args, options, json);
  }
  if (command === 'follow') {
    assertAllowedOptions(options, ['after', 'wait-ms']);
    return followTask(args[0], options, json);
  }
  if (command === 'status') {
    assertAllowedOptions(options);
    return statusCommand(args[0], options, json);
  }
  if (command === 'stop' || command === 'resume' || command === 'delete') {
    assertAllowedOptions(options, command === 'resume' ? ['value', 'probe'] : []);
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
    const action = args.shift() || 'status';
    assertAllowedOptions(options, action === 'start' ? ['upgrade', 'shared'] :
      action === 'foreground' ? ['shared'] : action === 'stop' ? ['if-idle'] : []);
    return managerCommand(action, options, json);
  }
  if (command === 'panel') {
    assertAllowedOptions(options);
    const context = await apiContext(options);
    const url = `${context.config.baseUrl}/dashboard`;
    if (!json) openUrl(url);
    return emit({ ok: true, url }, json);
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
