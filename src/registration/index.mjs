import { randomUUID } from 'node:crypto';
import { readdir, realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWrite,
  atomicWriteCas,
  pathExists,
  readJsonOptional,
  readOptionalFile,
  removeFileCas,
  sameFileSnapshot,
  sha256,
  writeJsonAtomic
} from './files.mjs';
import { adapterFor, desiredEntry } from './formats.mjs';
import { createHostDefinitions, DEFAULT_HOST_KEYS } from './hosts.mjs';
import { RegistrationLock } from './lock.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_SCHEMA_VERSION = 1;
const RETAINED_TRANSACTION_LIMIT = 20;
const TRANSACTION_ID_PATTERN = /^\d{10,}-[0-9a-f-]{36}$/;
const UNRESOLVED_TRANSACTION_STATES = new Set([
  'prepared',
  'applying',
  'rolling_back',
  'rollback_failed',
  'rollback_conflicted',
  'recovery_conflicted'
]);

function now() {
  return new Date().toISOString();
}

function errorDetail(error, fallbackCode = 'REGISTRATION_FAILED') {
  return { code: error?.code || fallbackCode, message: error?.message || String(error) };
}

function freshState(projectRoot) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    installationId: randomUUID(),
    projectRoot,
    createdAt: now(),
    updatedAt: now(),
    registrations: {},
    transactions: []
  };
}

function validateStateShape(state) {
  if (state === null) return;
  if (
    state.schemaVersion !== STATE_SCHEMA_VERSION ||
    typeof state.installationId !== 'string' ||
    typeof state.projectRoot !== 'string'
  ) {
    throw Object.assign(new Error('Registration state has an unsupported schema'), {
      code: 'INVALID_REGISTRATION_STATE'
    });
  }
  state.registrations ||= {};
  state.transactions ||= [];
  if (
    !state.registrations ||
    typeof state.registrations !== 'object' ||
    Array.isArray(state.registrations) ||
    !Array.isArray(state.transactions)
  ) {
    throw Object.assign(new Error('Registration state has invalid collections'), {
      code: 'INVALID_REGISTRATION_STATE'
    });
  }
}

async function comparableRoot(value, platform) {
  const resolved = resolve(value);
  const canonical = await realpath(resolved).catch((error) => {
    if (error?.code === 'ENOENT') return resolved;
    throw error;
  });
  return platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical;
}

async function sameProjectRoot(left, right, platform) {
  return await comparableRoot(left, platform) === await comparableRoot(right, platform);
}

async function validateState(state, projectRoot, platform) {
  validateStateShape(state);
  if (state === null) return;
  if (!await sameProjectRoot(state.projectRoot, projectRoot, platform)) {
    throw Object.assign(new Error(
      `Registration state belongs to ${state.projectRoot}; run relocate from that root before managing it here`
    ), { code: 'INSTALLATION_ROOT_MISMATCH' });
  }
}

function normalizeHostKeys(hostKeys) {
  if (hostKeys === undefined || hostKeys === null) return [...DEFAULT_HOST_KEYS];
  const values = Array.isArray(hostKeys) ? hostKeys : String(hostKeys).split(',');
  return [...new Set(values.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean))];
}

function publicHost(host, detected, status, extra = {}) {
  return {
    hostKey: host.key,
    displayName: host.displayName,
    support: host.support,
    detected,
    status,
    ...(host.configPath ? { configPath: host.configPath } : {}),
    ...extra
  };
}

export function createRegistrar(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const home = resolve(options.home || env.HOME || env.USERPROFILE || homedir());
  const projectRoot = resolve(options.projectRoot || ROOT);
  const executablePath = resolve(options.executablePath || process.execPath);
  const entrypoint = resolve(options.entrypoint || join(projectRoot, 'src', 'mcp', 'stdio.mjs'));
  const writeHostFile = options.writeHostFile || atomicWriteCas;
  const managerHome = resolve(env.ERIC_TASK_MASTER_HOME || join(home, '.eric-task-master'));
  const stateDir = resolve(options.stateDir || env.TASKMASTER_REGISTRATION_HOME || join(managerHome, 'registration'));
  const statePath = join(stateDir, 'state.json');
  const lockPath = join(stateDir, '.registration.lock');
  const registrationLockTimeoutMs = options.registrationLockTimeoutMs ?? 30_000;
  const lockFactory = options.registrationLockFactory
    || ((path, lockOptions) => new RegistrationLock(path, lockOptions));
  const pruneBackups = options.pruneBackups;
  const onMaintenanceWarning = options.onMaintenanceWarning || (() => {});
  const hosts = createHostDefinitions({ home, env, platform });
  const hostMap = new Map(hosts.map((host) => [host.key, host]));

  function select(hostKeys) {
    const keys = normalizeHostKeys(hostKeys);
    const unknown = keys.filter((key) => !hostMap.has(key));
    if (unknown.length) {
      throw Object.assign(new Error(`Unknown MCP host(s): ${unknown.join(', ')}`), {
        code: 'UNKNOWN_MCP_HOST'
      });
    }
    return keys.map((key) => hostMap.get(key));
  }

  async function withLock(operation) {
    const lock = lockFactory(lockPath, { timeoutMs: registrationLockTimeoutMs });
    await lock.acquire();
    let result;
    try {
      result = await operation();
    } catch (operationError) {
      try {
        await lock.release();
      } catch (releaseError) {
        operationError.lockReleaseError = errorDetail(releaseError, 'REGISTRATION_LOCK_RELEASE_FAILED');
      }
      throw operationError;
    }
    try {
      await lock.release();
    } catch (releaseError) {
      throw Object.assign(new Error(
        `Registration operation finished, but its cross-process lock could not be released: ${releaseError.message}`
      ), {
        code: 'REGISTRATION_LOCK_RELEASE_FAILED',
        operationResult: result,
        cause: releaseError
      });
    }
    return result;
  }

  async function loadState({ allowUnresolved = false, allowRootMismatch = false } = {}) {
    const state = await readJsonOptional(statePath);
    if (allowRootMismatch) validateStateShape(state);
    else await validateState(state, projectRoot, platform);
    if (!state) return null;
    await recoverInterruptedTransactions(state);
    const unresolved = state.transactions.find((transaction) => (
      UNRESOLVED_TRANSACTION_STATES.has(transaction.status)
    ));
    if (unresolved && !allowUnresolved) {
      throw Object.assign(new Error(
        `Registration transaction ${unresolved.id} requires an explicit rollback retry`
      ), {
        code: 'REGISTRATION_RECOVERY_REQUIRED',
        transactionId: unresolved.id
      });
    }
    return state;
  }

  async function saveState(state) {
    state.updatedAt = now();
    if (state.transactions.length > RETAINED_TRANSACTION_LIMIT) {
      let remainingToDrop = state.transactions.length - RETAINED_TRANSACTION_LIMIT;
      state.transactions = state.transactions.filter((transaction) => {
        if (remainingToDrop <= 0 || UNRESOLVED_TRANSACTION_STATES.has(transaction.status)) return true;
        remainingToDrop -= 1;
        return false;
      });
    }
    await writeJsonAtomic(statePath, state);
    try {
      if (pruneBackups) await pruneBackups(state);
      else await pruneBackupDirectories(state);
    } catch (error) {
      try {
        onMaintenanceWarning(errorDetail(error, 'REGISTRATION_BACKUP_PRUNE_FAILED'));
      } catch {
        // Retention reporting is best-effort after the durable state commit.
      }
    }
  }

  async function pruneBackupDirectories(state) {
    const backupRoot = join(stateDir, 'backups');
    const entries = await readdir(backupRoot, { withFileTypes: true }).catch((error) => {
      if (error?.code === 'ENOENT') return [];
      throw error;
    });
    const retained = new Set(state.transactions
      .filter((transaction) => (
        transaction.status === 'complete' || UNRESOLVED_TRANSACTION_STATES.has(transaction.status)
      ))
      .map((transaction) => transaction.id));
    for (const entry of entries) {
      if (!entry.isDirectory() || !TRANSACTION_ID_PATTERN.test(entry.name) || retained.has(entry.name)) continue;
      const candidate = resolve(backupRoot, entry.name);
      const boundary = relative(resolve(backupRoot), candidate);
      if (!boundary || boundary.startsWith('..') || isAbsolute(boundary)) continue;
      await rm(candidate, { recursive: true, force: true });
    }
  }

  function contextFor(host, installationId) {
    const desired = desiredEntry(host, installationId, executablePath, entrypoint);
    return {
      filePath: host.configPath,
      desired,
      clientId: desired.env.TASKMASTER_CLIENT_ID
    };
  }

  function beforeSnapshot(action, { includeIdentity = false } = {}) {
    return {
      exists: action.existedBefore,
      hash: action.beforeHash,
      ...(includeIdentity && action.beforeIdentity ? { identity: action.beforeIdentity } : {})
    };
  }

  function afterSnapshot(action) {
    return { exists: action.existsAfter, hash: action.afterHash };
  }

  function setRegistrationPhase(state, transaction, action, phase) {
    const registration = phase === 'before' ? action.registrationBefore : action.registrationAfter;
    if (registration) state.registrations[action.hostKey] = registration;
    else delete state.registrations[action.hostKey];
    if (phase === 'after' && !transaction.appliedHostKeys.includes(action.hostKey)) {
      transaction.appliedHostKeys.push(action.hostKey);
    }
    if (phase === 'before') {
      transaction.appliedHostKeys = transaction.appliedHostKeys.filter((key) => key !== action.hostKey);
    }
  }

  async function inspectRollbackAction(action) {
    const current = await readOptionalFile(action.configPath);
    if (sameFileSnapshot(current, beforeSnapshot(action))) {
      return { state: 'before', current };
    }
    if (sameFileSnapshot(current, afterSnapshot(action))) {
      return { state: 'after', current };
    }
    return { state: 'conflict', current };
  }

  async function recoverInterruptedTransactions(state) {
    const interrupted = state.transactions.filter((transaction) => (
      transaction.status === 'prepared' || transaction.status === 'applying'
    ));
    for (const transaction of interrupted) {
      const failures = [];
      const conflicts = [];
      for (const action of [...transaction.actions].reverse()) {
        try {
          const inspection = await inspectRollbackAction(action);
          if (inspection.state === 'before') {
            action.rollbackStatus = 'rolled_back';
            setRegistrationPhase(state, transaction, action, 'before');
            continue;
          }
          if (inspection.state === 'conflict') {
            action.rollbackStatus = 'rollback_conflict';
            conflicts.push({
              hostKey: action.hostKey,
              code: 'ROLLBACK_CONFLICT',
              message: 'Host configuration does not match the transaction before or after snapshot.'
            });
            continue;
          }
          await restoreAction(action, inspection.current);
          action.rollbackStatus = 'rolled_back';
          setRegistrationPhase(state, transaction, action, 'before');
        } catch (error) {
          action.rollbackStatus = 'rollback_failed';
          failures.push({ hostKey: action.hostKey, ...errorDetail(error) });
        }
      }
      transaction.rollbackFailures = failures;
      transaction.rollbackConflicts = conflicts;
      transaction.rolledBackAt = now();
      transaction.status = failures.length
        ? 'rollback_failed'
        : conflicts.length ? 'recovery_conflicted' : 'rolled_back_after_recovery';
      await saveState(state);
    }
  }

  async function relocate({ fromProjectRoot } = {}) {
    const state = await loadState({ allowRootMismatch: true });
    if (!state) {
      return failedGlobal('relocate', false, statePath, [], 'NO_REGISTRATION_STATE', 'No registration state exists.');
    }
    if (await sameProjectRoot(state.projectRoot, projectRoot, platform)) {
      return {
        ok: true,
        command: 'relocate',
        changed: false,
        installationId: state.installationId,
        projectRoot,
        statePath,
        nextAction: 'Run install to verify current host entries.'
      };
    }
    if (typeof fromProjectRoot !== 'string'
      || !await sameProjectRoot(fromProjectRoot, state.projectRoot, platform)) {
      return failedGlobal(
        'relocate',
        false,
        statePath,
        [],
        'RELOCATION_SOURCE_MISMATCH',
        `Confirm the previous project root exactly: ${state.projectRoot}`
      );
    }
    if (!await pathExists(entrypoint)) {
      return failedGlobal(
        'relocate',
        false,
        statePath,
        [],
        'MCP_ENTRYPOINT_MISSING',
        `MCP entrypoint not found: ${entrypoint}`
      );
    }
    const previousRoot = state.projectRoot;
    state.projectRoot = projectRoot;
    state.relocations = Array.isArray(state.relocations) ? state.relocations : [];
    state.relocations.push({ from: previousRoot, to: projectRoot, at: now() });
    state.relocations = state.relocations.slice(-20);
    await saveState(state);
    return {
      ok: true,
      command: 'relocate',
      changed: true,
      installationId: state.installationId,
      previousProjectRoot: previousRoot,
      projectRoot,
      statePath,
      nextAction: 'Run install to update owned host entries to the new absolute MCP entrypoint.'
    };
  }

  async function status({ hostKeys } = {}) {
    const selected = select(hostKeys);
    const state = await loadState();
    const results = [];
    for (const host of selected) {
      const registration = state?.registrations?.[host.key];
      const detected = registration ? true : await host.detect();
      if (host.support !== 'native') {
        results.push(publicHost(host, detected, detected ? 'needs_adapter' : 'not_installed', {
          reason: 'No verified native registration contract is enabled for this host.'
        }));
        continue;
      }
      if (!detected) {
        results.push(publicHost(host, false, 'not_installed'));
        continue;
      }
      const configPath = registration?.configPath || host.configPath;
      const file = await readOptionalFile(configPath);
      if (!file.exists) {
        results.push(publicHost({ ...host, configPath }, true, 'unregistered'));
        continue;
      }
      if (!state) {
        let hasNamedEntry = false;
        try {
          const probe = adapterFor(host.format).entryFingerprint(file.text, {
            filePath: configPath,
            clientId: '',
            desired: {}
          });
          hasNamedEntry = probe !== null;
        } catch (error) {
          results.push(publicHost({ ...host, configPath }, true, 'failed', { error: errorDetail(error) }));
          continue;
        }
        results.push(publicHost(
          { ...host, configPath },
          true,
          hasNamedEntry ? 'conflict' : 'unregistered',
          hasNamedEntry ? { reason: 'Named entry exists but no TaskMaster ownership state is available.' } : {}
        ));
        continue;
      }
      const context = contextFor({ ...host, configPath }, state.installationId);
      try {
        const inspection = adapterFor(host.format).inspect(file.text, context);
        if (
          inspection.state === 'owned_outdated'
          && registration
          && inspection.currentFingerprint !== registration.entryFingerprint
        ) {
          results.push(publicHost({ ...host, configPath }, true, 'conflict', {
            reason: 'The owned entry changed after installation.'
          }));
          continue;
        }
        const statusName = {
          absent: 'unregistered',
          registered: 'registered',
          owned_outdated: 'update_available',
          conflict: 'conflict'
        }[inspection.state];
        results.push(publicHost({ ...host, configPath }, true, statusName));
      } catch (error) {
        results.push(publicHost({ ...host, configPath }, true, 'failed', { error: errorDetail(error) }));
      }
    }
    return {
      ok: results.every((result) => result.status !== 'failed'),
      command: 'status',
      installationId: state?.installationId || null,
      statePath,
      results
    };
  }

  async function install({ dryRun = false, hostKeys } = {}) {
    const selected = select(hostKeys);
    const loaded = await loadState();
    const state = loaded || freshState(projectRoot);
    const results = [];
    const actions = [];
    let preflightFailed = false;

    for (const selectedHost of selected) {
      const previousRegistration = state.registrations[selectedHost.key];
      const host = previousRegistration
        ? { ...selectedHost, configPath: previousRegistration.configPath, format: previousRegistration.format }
        : selectedHost;
      const detected = previousRegistration ? true : await host.detect();
      if (host.support !== 'native') {
        results.push(publicHost(host, detected, detected ? 'needs_adapter' : 'not_installed', {
          reason: 'Skipped: adapter is not verified.'
        }));
        continue;
      }
      if (!detected) {
        results.push(publicHost(host, false, 'not_installed'));
        continue;
      }
      try {
        const before = await readOptionalFile(host.configPath);
        const context = contextFor(host, state.installationId);
        const adapter = adapterFor(host.format);
        const inspection = adapter.inspect(before.text, context);
        if (inspection.state === 'conflict') {
          preflightFailed = true;
          results.push(publicHost(host, true, 'conflict', {
            error: { code: 'REGISTRATION_CONFLICT', message: `Unowned ${host.key} entry uses the name eric-task-master.` }
          }));
          continue;
        }
        if (
          inspection.state === 'owned_outdated'
          && (!previousRegistration || inspection.currentFingerprint !== previousRegistration.entryFingerprint)
        ) {
          preflightFailed = true;
          results.push(publicHost(host, true, 'conflict', {
            error: {
              code: 'OWNED_ENTRY_CHANGED',
              message: 'The owned entry changed after installation; it was not overwritten.'
            }
          }));
          continue;
        }
        if (inspection.state === 'registered') {
          results.push(publicHost(host, true, 'registered', { changed: false }));
          continue;
        }
        const afterText = adapter.install(before.text, context);
        const afterBytes = Buffer.from(afterText, 'utf8');
        actions.push({
          host,
          context,
          before,
          afterBytes,
          afterHash: sha256(afterBytes),
          entryFingerprint: adapter.entryFingerprint(afterText, context),
          registrationBefore: previousRegistration || null
        });
        results.push(publicHost(host, true, dryRun ? 'would_register' : 'pending', { changed: !dryRun }));
      } catch (error) {
        preflightFailed = true;
        results.push(publicHost(host, true, 'failed', { error: errorDetail(error) }));
      }
    }

    if (preflightFailed) {
      return {
        ok: false,
        command: 'install',
        dryRun,
        changed: false,
        installationId: loaded?.installationId || null,
        statePath,
        results: results.map((result) => result.status === 'pending'
          ? { ...result, status: 'not_changed', changed: false }
          : result)
      };
    }
    if (actions.length && (!isAbsolute(executablePath) || !await pathExists(executablePath))) {
      return failedGlobal('install', dryRun, statePath, results, 'NODE_EXECUTABLE_MISSING', `Node executable not found: ${executablePath}`);
    }
    if (actions.length && (!isAbsolute(entrypoint) || !await pathExists(entrypoint))) {
      return failedGlobal('install', dryRun, statePath, results, 'MCP_ENTRYPOINT_MISSING', `MCP entrypoint not found: ${entrypoint}`);
    }
    if (dryRun || actions.length === 0) {
      return {
        ok: true,
        command: 'install',
        dryRun,
        changed: false,
        installationId: loaded?.installationId || (actions.length ? '(created during install)' : null),
        statePath,
        results
      };
    }

    const transaction = await prepareTransaction({ state, stateDir, operation: 'install', actions });
    try {
      transaction.status = 'applying';
      await saveState(state);
      for (const action of actions) {
        const recorded = transaction.actions.find((item) => item.hostKey === action.host.key);
        recorded.status = 'writing';
        transaction.currentHostKey = action.host.key;
        await saveState(state);
        await writeHostFile(action.host.configPath, action.afterBytes, {
          mode: action.before.exists ? action.before.mode : 0o600,
          expected: action.before
        });
        const written = await readOptionalFile(action.host.configPath);
        if (written.hash !== action.afterHash) throw Object.assign(new Error(`Write verification failed for ${action.host.configPath}`), {
          code: 'CONFIG_WRITE_VERIFY_FAILED'
        });
        recorded.status = 'applied';
        transaction.currentHostKey = null;
        setRegistrationPhase(state, transaction, recorded, 'after');
        await saveState(state);
      }
      transaction.status = 'complete';
      transaction.completedAt = now();
      await saveState(state);
      return {
        ok: true,
        command: 'install',
        dryRun: false,
        changed: true,
        installationId: state.installationId,
        transactionId: transaction.id,
        statePath,
        results: results.map((result) => result.status === 'pending'
          ? { ...result, status: 'registered_pending_restart', changed: true }
          : result)
      };
    } catch (error) {
      const rollback = await rollbackFailedTransaction(state, transaction, { cause: error });
      const rollbackByHost = new Map(rollback.results.map((result) => [result.hostKey, result]));
      return {
        ok: false,
        command: 'install',
        dryRun: false,
        changed: rollback.remainingChanged,
        installationId: state.installationId,
        transactionId: transaction.id,
        statePath,
        error: errorDetail(error),
        rollback,
        results: results.map((result) => result.status === 'pending'
          ? {
            ...result,
            status: rollbackByHost.get(result.hostKey)?.status || 'failed',
            changed: rollbackByHost.get(result.hostKey)?.remainingChanged === true,
            error: errorDetail(error)
          }
          : result)
      };
    }
  }

  async function uninstall({ dryRun = false, hostKeys } = {}) {
    const selected = select(hostKeys);
    const state = await loadState();
    if (!state) {
      return {
        ok: true,
        command: 'uninstall',
        dryRun,
        changed: false,
        installationId: null,
        statePath,
        results: selected.map((host) => publicHost(host, false, 'not_registered'))
      };
    }
    const actions = [];
    const results = [];
    let preflightFailed = false;
    for (const host of selected) {
      const registration = state.registrations[host.key];
      if (host.support !== 'native' && !registration) {
        const detected = await host.detect();
        results.push(publicHost(host, detected, detected ? 'needs_adapter' : 'not_installed'));
        continue;
      }
      if (!registration) {
        results.push(publicHost(host, await host.detect(), 'not_registered'));
        continue;
      }
      const registeredHost = { ...host, configPath: registration.configPath, format: registration.format };
      try {
        const before = await readOptionalFile(registration.configPath);
        if (!before.exists) {
          results.push(publicHost(registeredHost, true, 'already_absent', { changed: false }));
          continue;
        }
        const context = contextFor(registeredHost, state.installationId);
        const adapter = adapterFor(registration.format);
        const currentFingerprint = adapter.entryFingerprint(before.text, context);
        if (currentFingerprint === null) {
          results.push(publicHost(registeredHost, true, 'already_absent', { changed: false }));
          continue;
        }
        if (currentFingerprint !== registration.entryFingerprint) {
          preflightFailed = true;
          results.push(publicHost(registeredHost, true, 'conflict', {
            error: {
              code: 'OWNED_ENTRY_CHANGED',
              message: 'The registered entry changed after installation; it was not removed.'
            }
          }));
          continue;
        }
        const afterText = adapter.remove(before.text, context);
        const afterBytes = Buffer.from(afterText, 'utf8');
        actions.push({
          host: registeredHost,
          context,
          before,
          afterBytes,
          afterHash: sha256(afterBytes),
          entryFingerprint: null,
          registrationBefore: registration,
          registrationAfter: null
        });
        results.push(publicHost(registeredHost, true, dryRun ? 'would_unregister' : 'pending', { changed: !dryRun }));
      } catch (error) {
        preflightFailed = true;
        results.push(publicHost(registeredHost, true, 'failed', { error: errorDetail(error) }));
      }
    }
    if (preflightFailed) {
      return {
        ok: false,
        command: 'uninstall',
        dryRun,
        changed: false,
        installationId: state.installationId,
        statePath,
        results: results.map((result) => result.status === 'pending'
          ? { ...result, status: 'not_changed', changed: false }
          : result)
      };
    }
    if (dryRun || actions.length === 0) {
      if (!dryRun) {
        for (const result of results) {
          if (result.status === 'already_absent') delete state.registrations[result.hostKey];
        }
        await saveState(state);
      }
      return {
        ok: true,
        command: 'uninstall',
        dryRun,
        changed: false,
        installationId: state.installationId,
        statePath,
        results
      };
    }
    const transaction = await prepareTransaction({ state, stateDir, operation: 'uninstall', actions });
    try {
      transaction.status = 'applying';
      await saveState(state);
      for (const action of actions) {
        const recorded = transaction.actions.find((item) => item.hostKey === action.host.key);
        recorded.status = 'writing';
        transaction.currentHostKey = action.host.key;
        await saveState(state);
        await writeHostFile(action.host.configPath, action.afterBytes, {
          mode: action.before.mode,
          expected: action.before
        });
        const written = await readOptionalFile(action.host.configPath);
        if (written.hash !== action.afterHash) throw Object.assign(new Error(`Write verification failed for ${action.host.configPath}`), {
          code: 'CONFIG_WRITE_VERIFY_FAILED'
        });
        recorded.status = 'applied';
        transaction.currentHostKey = null;
        setRegistrationPhase(state, transaction, recorded, 'after');
        await saveState(state);
      }
      for (const result of results) {
        if (result.status === 'already_absent') delete state.registrations[result.hostKey];
      }
      transaction.status = 'complete';
      transaction.completedAt = now();
      await saveState(state);
      return {
        ok: true,
        command: 'uninstall',
        dryRun: false,
        changed: true,
        installationId: state.installationId,
        transactionId: transaction.id,
        statePath,
        results: results.map((result) => result.status === 'pending'
          ? { ...result, status: 'unregistered_pending_restart', changed: true }
          : result)
      };
    } catch (error) {
      const rollback = await rollbackFailedTransaction(state, transaction, { cause: error });
      const rollbackByHost = new Map(rollback.results.map((result) => [result.hostKey, result]));
      return {
        ok: false,
        command: 'uninstall',
        dryRun: false,
        changed: rollback.remainingChanged,
        installationId: state.installationId,
        transactionId: transaction.id,
        statePath,
        error: errorDetail(error),
        rollback,
        results: results.map((result) => result.status === 'pending'
          ? {
            ...result,
            status: rollbackByHost.get(result.hostKey)?.status || 'failed',
            changed: rollbackByHost.get(result.hostKey)?.remainingChanged === true,
            error: errorDetail(error)
          }
          : result)
      };
    }
  }

  async function rollback({ dryRun = false, transactionId } = {}) {
    const state = await loadState({ allowUnresolved: true });
    if (!state) return failedGlobal('rollback', dryRun, statePath, [], 'NO_REGISTRATION_STATE', 'No registration state exists.');
    const rollbackable = new Set([
      'complete',
      'rolling_back',
      'rollback_failed',
      'rollback_conflicted',
      'recovery_conflicted'
    ]);
    const transaction = transactionId
      ? state.transactions.find((candidate) => candidate.id === transactionId)
      : [...state.transactions].reverse().find((candidate) => rollbackable.has(candidate.status));
    if (!transaction) return failedGlobal('rollback', dryRun, statePath, [], 'TRANSACTION_NOT_FOUND', 'No rollbackable transaction was found.');
    if (!rollbackable.has(transaction.status)) {
      return failedGlobal('rollback', dryRun, statePath, [], 'TRANSACTION_NOT_ROLLBACKABLE', `Transaction ${transaction.id} is ${transaction.status}.`);
    }
    const inspections = new Map();
    const conflicts = [];
    const failures = [];
    for (const action of transaction.actions) {
      try {
        const inspection = await inspectRollbackAction(action);
        inspections.set(action.hostKey, inspection);
        if (inspection.state === 'conflict') {
          action.rollbackStatus = 'rollback_conflict';
          conflicts.push({
            hostKey: action.hostKey,
            code: 'ROLLBACK_CONFLICT',
            message: 'Host configuration changed after this transaction.'
          });
          continue;
        }
        if (inspection.state === 'before') {
          action.rollbackStatus = 'rolled_back';
          setRegistrationPhase(state, transaction, action, 'before');
          continue;
        }
        const backup = await readOptionalFile(action.backupPath);
        if (!backup.exists || backup.hash !== action.beforeHash) {
          throw Object.assign(new Error(`Registration backup is missing or changed: ${action.backupPath}`), {
            code: backup.exists ? 'REGISTRATION_BACKUP_CHANGED' : 'REGISTRATION_BACKUP_MISSING'
          });
        }
      } catch (error) {
        action.rollbackStatus = 'rollback_failed';
        failures.push({ hostKey: action.hostKey, ...errorDetail(error) });
      }
    }
    const preflightResults = transaction.actions.map((action) => {
      const failure = failures.find((item) => item.hostKey === action.hostKey);
      const conflict = conflicts.find((item) => item.hostKey === action.hostKey);
      if (failure) return { hostKey: action.hostKey, status: 'rollback_failed', error: failure };
      if (conflict) return { hostKey: action.hostKey, status: 'rollback_conflict', error: conflict };
      if (inspections.get(action.hostKey)?.state === 'before') {
        return { hostKey: action.hostKey, status: 'already_rolled_back' };
      }
      return { hostKey: action.hostKey, status: dryRun ? 'would_rollback' : 'pending' };
    });
    if (conflicts.length || failures.length) {
      transaction.status = failures.length ? 'rollback_failed' : 'rollback_conflicted';
      transaction.rollbackFailures = failures;
      transaction.rollbackConflicts = conflicts;
      if (!dryRun) await saveState(state);
      const remainingChanged = conflicts.length > 0 || failures.length > 0
        || [...inspections.values()].some((inspection) => inspection.state !== 'before');
      return {
        ok: false,
        command: 'rollback',
        dryRun,
        changed: remainingChanged,
        remainingChanged,
        installationId: state.installationId,
        transactionId: transaction.id,
        statePath,
        ...(failures.length ? { failures } : {}),
        ...(conflicts.length ? { conflicts } : {}),
        results: preflightResults
      };
    }
    if (dryRun) {
      return {
        ok: true,
        command: 'rollback',
        dryRun: true,
        changed: false,
        installationId: state.installationId,
        transactionId: transaction.id,
        statePath,
        results: preflightResults
      };
    }
    let restoredCount = 0;
    const runtimeFailures = [];
    const runtimeConflicts = [];
    transaction.status = 'rolling_back';
    await saveState(state);
    for (const action of [...transaction.actions].reverse()) {
      const inspection = inspections.get(action.hostKey);
      if (inspection?.state === 'before') continue;
      try {
        await restoreAction(action, inspection.current);
        action.rollbackStatus = 'rolled_back';
        setRegistrationPhase(state, transaction, action, 'before');
        restoredCount += 1;
        await saveState(state);
      } catch (error) {
        const current = await inspectRollbackAction(action).catch(() => ({ state: 'conflict' }));
        const detail = { hostKey: action.hostKey, ...errorDetail(error) };
        if (error?.code === 'CONFIG_CAS_MISMATCH' || current.state === 'conflict') {
          action.rollbackStatus = 'rollback_conflict';
          runtimeConflicts.push({
            hostKey: action.hostKey,
            code: 'ROLLBACK_CONFLICT',
            message: 'Host configuration changed while rollback was running.'
          });
        } else {
          action.rollbackStatus = 'rollback_failed';
          runtimeFailures.push(detail);
        }
        await saveState(state).catch(() => {});
      }
    }
    transaction.status = runtimeFailures.length
      ? 'rollback_failed'
      : runtimeConflicts.length ? 'rollback_conflicted' : 'rolled_back';
    transaction.rolledBackAt = now();
    transaction.rollbackFailures = runtimeFailures;
    transaction.rollbackConflicts = runtimeConflicts;
    await saveState(state);
    const results = transaction.actions.map((action) => {
      const failure = runtimeFailures.find((item) => item.hostKey === action.hostKey);
      const conflict = runtimeConflicts.find((item) => item.hostKey === action.hostKey);
      if (failure) return { hostKey: action.hostKey, status: 'rollback_failed', error: failure };
      if (conflict) return { hostKey: action.hostKey, status: 'rollback_conflict', error: conflict };
      return {
        hostKey: action.hostKey,
        status: inspections.get(action.hostKey)?.state === 'before' ? 'already_rolled_back' : 'rolled_back'
      };
    });
    const remainingChanged = results.some((result) => (
      result.status === 'rollback_failed' || result.status === 'rollback_conflict'
    ));
    return {
      ok: runtimeFailures.length === 0 && runtimeConflicts.length === 0,
      command: 'rollback',
      dryRun: false,
      changed: restoredCount > 0 || remainingChanged,
      remainingChanged,
      installationId: state.installationId,
      transactionId: transaction.id,
      statePath,
      ...(runtimeFailures.length ? {
        error: { code: 'ROLLBACK_FAILED', message: 'One or more host backups could not be restored.' },
        failures: runtimeFailures
      } : {}),
      ...(runtimeConflicts.length ? { conflicts: runtimeConflicts } : {}),
      results
    };
  }

  async function prepareTransaction({ state, stateDir: targetStateDir, operation, actions }) {
    const id = `${Date.now()}-${randomUUID()}`;
    const createdAt = now();
    const backupDir = join(targetStateDir, 'backups', id);
    const serializedActions = [];
    for (const action of actions) {
      const backupPath = join(backupDir, `${action.host.key}.before`);
      const metadataPath = join(backupDir, `${action.host.key}.json`);
      await atomicWrite(backupPath, action.before.bytes, { mode: 0o600 });
      await writeJsonAtomic(metadataPath, {
        schemaVersion: 1,
        hostKey: action.host.key,
        configPath: action.host.configPath,
        existedBefore: action.before.exists,
        modeBefore: action.before.mode,
        beforeIdentity: action.before.identity,
        beforeHash: action.before.hash,
        afterHash: action.afterHash
      });
      const registrationAfter = operation === 'install'
        ? {
          hostKey: action.host.key,
          configPath: action.host.configPath,
          format: action.host.format,
          clientId: action.context.clientId,
          entryFingerprint: action.entryFingerprint,
          command: action.context.desired.command,
          args: action.context.desired.args,
          installedAt: createdAt,
          transactionId: id
        }
        : null;
      serializedActions.push({
        hostKey: action.host.key,
        configPath: action.host.configPath,
        backupPath,
        metadataPath,
        existedBefore: action.before.exists,
        existsAfter: true,
        modeBefore: action.before.mode,
        beforeIdentity: action.before.identity,
        beforeHash: action.before.hash,
        afterHash: action.afterHash,
        registrationBefore: action.registrationBefore,
        registrationAfter,
        status: 'pending',
        rollbackStatus: null
      });
    }
    const transaction = {
      id,
      operation,
      status: 'prepared',
      createdAt,
      appliedHostKeys: [],
      currentHostKey: null,
      actions: serializedActions
    };
    state.transactions.push(transaction);
    await saveState(state);
    return transaction;
  }

  async function restoreAction(action, expectedCurrent) {
    const backup = await readOptionalFile(action.backupPath);
    if (!backup.exists) throw Object.assign(new Error(`Missing registration backup: ${action.backupPath}`), {
      code: 'REGISTRATION_BACKUP_MISSING'
    });
    if (backup.hash !== action.beforeHash) {
      throw Object.assign(new Error(`Registration backup integrity check failed: ${action.backupPath}`), {
        code: 'REGISTRATION_BACKUP_CHANGED'
      });
    }
    if (action.existedBefore) {
      await writeHostFile(action.configPath, backup.bytes, {
        mode: action.modeBefore,
        expected: expectedCurrent
      });
    } else {
      await removeFileCas(action.configPath, expectedCurrent);
    }
    const restored = await readOptionalFile(action.configPath);
    if (!sameFileSnapshot(restored, beforeSnapshot(action))) {
      throw Object.assign(new Error(`Rollback verification failed for ${action.configPath}`), {
        code: 'ROLLBACK_VERIFY_FAILED'
      });
    }
  }

  async function rollbackFailedTransaction(state, transaction, { cause } = {}) {
    const failures = [];
    const conflicts = [];
    const results = [];
    for (const action of [...transaction.actions].reverse()) {
      try {
        const inspection = await inspectRollbackAction(action);
        if (inspection.state === 'before') {
          action.rollbackStatus = 'rolled_back';
          setRegistrationPhase(state, transaction, action, 'before');
          results.push({ hostKey: action.hostKey, status: 'rolled_back', remainingChanged: false });
          await saveState(state);
          continue;
        }
        if (inspection.state === 'conflict') {
          const knownApplied = action.status === 'applied' || transaction.appliedHostKeys.includes(action.hostKey);
          const casRejectedBeforeWrite = cause?.code === 'CONFIG_CAS_MISMATCH' &&
            transaction.currentHostKey === action.hostKey &&
            !knownApplied;
          if (casRejectedBeforeWrite) {
            action.rollbackStatus = 'not_applied_external_change';
            results.push({
              hostKey: action.hostKey,
              status: 'not_applied_external_change',
              remainingChanged: false
            });
            await saveState(state);
            continue;
          }
          action.rollbackStatus = 'rollback_conflict';
          if (knownApplied) setRegistrationPhase(state, transaction, action, 'after');
          const detail = {
            hostKey: action.hostKey,
            code: 'ROLLBACK_CONFLICT',
            message: 'Host configuration changed after the registration write; automatic rollback did not overwrite it.'
          };
          conflicts.push(detail);
          results.push({
            hostKey: action.hostKey,
            status: 'rollback_conflict',
            remainingChanged: knownApplied,
            error: detail
          });
          await saveState(state);
          continue;
        }
        await restoreAction(action, inspection.current);
        action.rollbackStatus = 'rolled_back';
        setRegistrationPhase(state, transaction, action, 'before');
        results.push({ hostKey: action.hostKey, status: 'rolled_back', remainingChanged: false });
        await saveState(state);
      } catch (error) {
        action.rollbackStatus = 'rollback_failed';
        const detail = { hostKey: action.hostKey, ...errorDetail(error) };
        failures.push(detail);
        results.push({
          hostKey: action.hostKey,
          status: 'rollback_failed',
          remainingChanged: action.status === 'applied' || transaction.appliedHostKeys.includes(action.hostKey),
          error: detail
        });
      }
    }
    transaction.currentHostKey = null;
    transaction.status = failures.length
      ? 'rollback_failed'
      : conflicts.length ? 'rollback_conflicted' : 'rolled_back_after_failure';
    transaction.rolledBackAt = now();
    transaction.rollbackFailures = failures;
    transaction.rollbackConflicts = conflicts;
    await saveState(state).catch((error) => {
      failures.push({ hostKey: 'state', ...errorDetail(error) });
      transaction.status = 'rollback_failed';
    });
    const remainingChanged = results.some((result) => result.remainingChanged);
    return {
      ok: failures.length === 0 && conflicts.length === 0,
      changed: remainingChanged,
      remainingChanged,
      failures,
      conflicts,
      results
    };
  }

  return {
    home,
    projectRoot,
    executablePath,
    entrypoint,
    stateDir,
    statePath,
    hosts: hosts.map(({ detect, ...host }) => host),
    status: (options) => withLock(() => status(options)),
    install: (options) => withLock(() => install(options)),
    uninstall: (options) => withLock(() => uninstall(options)),
    rollback: (options) => withLock(() => rollback(options)),
    relocate: (options) => withLock(() => relocate(options))
  };
}

function failedGlobal(command, dryRun, statePath, results, code, message) {
  return {
    ok: false,
    command,
    dryRun,
    changed: false,
    statePath,
    error: { code, message },
    results: results.map((result) => result.status === 'pending'
      ? { ...result, status: 'not_changed', changed: false }
      : result)
  };
}
