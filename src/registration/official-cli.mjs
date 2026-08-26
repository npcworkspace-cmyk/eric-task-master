import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fingerprint, SERVER_NAME } from './formats.mjs';

const OUTPUT_LIMIT = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const TERMINATION_GRACE_MS = 2_000;

async function resolveWindowsLaunch(command, args, env) {
  const pathEntries = String(env.PATH || '').split(';').filter(Boolean);
  const extensions = String(env.PATHEXT || '.COM;.EXE;.CMD;.BAT').split(';').filter(Boolean);
  const candidates = isAbsolute(command) || /[\\/]/u.test(command)
    ? [resolve(command)]
    : pathEntries.flatMap((directory) => (
      extname(command) ? [join(directory, command)] : extensions.map((extension) => join(directory, `${command}${extension.toLowerCase()}`))
    ));
  let executable = null;
  for (const candidate of candidates) {
    const metadata = await lstat(candidate).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (metadata?.isFile() && !metadata.isSymbolicLink()) {
      executable = candidate;
      break;
    }
  }
  if (!executable) {
    throw Object.assign(new Error('Host MCP command could not be found'), { code: 'HOST_CLI_NOT_FOUND' });
  }
  if (!['.cmd', '.bat'].includes(extname(executable).toLocaleLowerCase('en-US'))) {
    return { command: executable, args };
  }

  // Never interpolate Task Master paths or JSON into cmd.exe. For the standard
  // npm Windows shim, resolve the package's declared JavaScript bin and launch
  // it directly with the current Node executable.
  const packageRoot = await realpath(join(dirname(executable), 'node_modules', 'openclaw')).catch(() => null);
  if (!packageRoot) {
    throw Object.assign(new Error('The OpenClaw Windows shim is not a verifiable npm package bin'), {
      code: 'HOST_CLI_SHIM_UNSUPPORTED'
    });
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw Object.assign(new Error('The OpenClaw npm package manifest is invalid'), {
      code: 'HOST_CLI_SHIM_UNSUPPORTED'
    });
  }
  const declaredBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.openclaw;
  if (typeof declaredBin !== 'string' || !declaredBin) {
    throw Object.assign(new Error('The OpenClaw npm package has no declared CLI bin'), {
      code: 'HOST_CLI_SHIM_UNSUPPORTED'
    });
  }
  const binPath = resolve(packageRoot, declaredBin);
  const realBinPath = await realpath(binPath).catch(() => null);
  const boundary = realBinPath ? relative(packageRoot, realBinPath) : null;
  if (!boundary || boundary.startsWith('..') || isAbsolute(boundary)) {
    throw Object.assign(new Error('The OpenClaw npm bin escapes its package directory'), {
      code: 'HOST_CLI_SHIM_UNSUPPORTED'
    });
  }
  const binMetadata = await lstat(realBinPath).catch(() => null);
  if (!binMetadata?.isFile() || binMetadata.isSymbolicLink()) {
    throw Object.assign(new Error('The OpenClaw npm bin is not a stable regular file'), {
      code: 'HOST_CLI_SHIM_UNSUPPORTED'
    });
  }
  return { command: process.execPath, args: [realBinPath, ...args] };
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolveWait(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

async function runTreeTerminator(command, args, env) {
  let killer;
  try {
    killer = spawn(command, args, {
      env,
      windowsHide: true,
      stdio: 'ignore'
    });
  } catch {
    return false;
  }
  const completion = new Promise((resolveCompletion) => {
    killer.once('exit', () => resolveCompletion(true));
    killer.once('error', () => resolveCompletion(false));
  });
  const timeout = new Promise((resolveTimeout) => {
    const timer = setTimeout(() => resolveTimeout(false), TERMINATION_GRACE_MS);
    timer.unref?.();
  });
  const completed = await Promise.race([completion, timeout]);
  if (!completed) killer.kill();
  return completed;
}

async function terminateProcessTree(child, { env, platform }) {
  if (!child.pid) return;
  if (platform === 'win32') {
    const windowsRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
    await runTreeTerminator(join(windowsRoot, 'System32', 'taskkill.exe'), [
      '/PID', String(child.pid), '/T', '/F'
    ], env);
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
  if (await waitForExit(child, TERMINATION_GRACE_MS)) return;
  if (platform === 'win32') child.kill();
  else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
  await waitForExit(child, TERMINATION_GRACE_MS);
}

export async function runHostCommand(command, args, {
  env = process.env,
  platform = process.platform,
  timeoutMs = COMMAND_TIMEOUT_MS
} = {}) {
  const launch = platform === 'win32'
    ? await resolveWindowsLaunch(command, args, env)
    : { command, args };
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      env,
      windowsHide: true,
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const chunks = [];
    let size = 0;
    let settled = false;
    let terminating = false;
    const timer = setTimeout(() => {
      void abort(Object.assign(new Error('Host MCP command timed out'), { code: 'HOST_CLI_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }

    async function abort(error) {
      if (settled || terminating) return;
      terminating = true;
      clearTimeout(timer);
      await terminateProcessTree(child, { env, platform });
      finish(error);
    }

    function countOutput(chunk) {
      size += chunk.length;
      if (size <= OUTPUT_LIMIT) return true;
      void abort(Object.assign(new Error('Host MCP command output exceeded the safe limit'), {
        code: 'HOST_CLI_OUTPUT_LIMIT'
      }));
      return false;
    }

    child.stdout.on('data', (chunk) => {
      if (!countOutput(chunk)) return;
      chunks.push(chunk);
    });
    // Host stderr can contain local configuration values. Drain it, but never
    // copy it into Task Master errors or registration state.
    child.stderr.on('data', (chunk) => { countOutput(chunk); });
    child.once('error', (error) => finish(Object.assign(new Error('Host MCP command could not start'), {
      code: error?.code === 'ENOENT' ? 'HOST_CLI_NOT_FOUND' : 'HOST_CLI_START_FAILED'
    })));
    child.once('exit', (code, signal) => {
      if (terminating) return;
      finish(null, {
        exitCode: Number.isInteger(code) ? code : null,
        signal: signal || null,
        stdout: Buffer.concat(chunks).toString('utf8')
      });
    });
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw Object.assign(new Error('Host MCP command returned invalid JSON'), {
      code: 'HOST_CLI_INVALID_RESPONSE'
    });
  }
}

function expectSuccess(result, operation) {
  if (result.exitCode === 0) return;
  throw Object.assign(new Error(`Host MCP ${operation} command failed`), {
    code: 'HOST_CLI_COMMAND_FAILED'
  });
}

function managedEntry(entry, managedEnvKeys = null) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw Object.assign(new Error('Host MCP command returned an invalid server definition'), {
      code: 'HOST_CLI_INVALID_RESPONSE'
    });
  }
  if (typeof entry.command !== 'string' || !entry.command) {
    throw Object.assign(new Error('Host MCP command omitted the stdio command'), {
      code: 'HOST_CLI_INVALID_RESPONSE'
    });
  }
  const args = entry.args === undefined ? [] : entry.args;
  const env = entry.env === undefined ? {} : entry.env;
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw Object.assign(new Error('Host MCP command returned invalid stdio arguments'), {
      code: 'HOST_CLI_INVALID_RESPONSE'
    });
  }
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || Object.values(env).some((value) => (
      !['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))
    ))) {
    throw Object.assign(new Error('Host MCP command returned invalid stdio environment metadata'), {
      code: 'HOST_CLI_INVALID_RESPONSE'
    });
  }
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
    throw Object.assign(new Error('Host MCP command returned invalid enablement metadata'), {
      code: 'HOST_CLI_INVALID_RESPONSE'
    });
  }
  const envKeys = managedEnvKeys || Object.keys(env);
  if (envKeys.some((key) => env[key] !== undefined && typeof env[key] !== 'string')) {
    throw Object.assign(new Error('Host MCP command returned invalid managed stdio environment metadata'), {
      code: 'HOST_CLI_INVALID_RESPONSE'
    });
  }
  return {
    command: entry.command,
    args: [...args],
    env: Object.fromEntries(envKeys
      .filter((key) => env[key] !== undefined)
      .map((key) => [key, env[key]]))
  };
}

function cloneFullEntry(entry, managedEnvKeys = null) {
  let encoded;
  try {
    encoded = JSON.stringify(entry);
  } catch {
    encoded = null;
  }
  if (!encoded || Buffer.byteLength(encoded) > OUTPUT_LIMIT) {
    throw Object.assign(new Error('Host MCP server definition is not safely serializable'), {
      code: 'HOST_CLI_INVALID_RESPONSE'
    });
  }
  const cloned = parseJson(encoded);
  managedEntry(cloned, managedEnvKeys);
  return cloned;
}

function desiredManagedEntry(desired, managedEnvKeys = null) {
  return managedEntry(desired, managedEnvKeys);
}

function mergedOwnedEntry(current, desired, managedEnvKeys = null) {
  const source = current ? cloneFullEntry(current, managedEnvKeys) : {};
  const currentEnv = source.env && typeof source.env === 'object' && !Array.isArray(source.env)
    ? source.env
    : {};
  const desiredEnv = desired.env && typeof desired.env === 'object' && !Array.isArray(desired.env)
    ? desired.env
    : {};
  const envKeys = managedEnvKeys || Object.keys(desiredEnv);
  const env = { ...currentEnv };
  for (const key of envKeys) {
    if (desiredEnv[key] !== undefined) env[key] = desiredEnv[key];
  }
  return cloneFullEntry({
    ...source,
    command: desired.command,
    args: [...desired.args],
    env
  }, managedEnvKeys);
}

function ownsEntry(entry, clientId) {
  const ids = [entry.env.TASKMASTER_CLIENT_ID, entry.env.ERIC_TASK_MASTER_CLIENT_ID]
    .filter((value) => typeof value === 'string');
  return ids.length > 0 && ids.every((value) => value === clientId);
}

export function createOfficialCliAdapter(host, {
  commandRunner = runHostCommand,
  env = process.env,
  platform = process.platform
} = {}) {
  if (host.key !== 'openclaw') {
    throw Object.assign(new Error(`No official CLI registration adapter exists for ${host.key}`), {
      code: 'HOST_ADAPTER_NOT_VERIFIED'
    });
  }
  const managedEnvKeys = host.managedEnvKeys || null;

  async function invoke(args) {
    return commandRunner(host.executable, args, { env, platform });
  }

  async function inspect(context) {
    // OpenClaw `mcp show <missing> --json` exits with a human-only stderr
    // message. Its verified machine-readable absence contract is the complete
    // registry returned by `mcp list --json`, so never infer absence from text.
    const result = await invoke(['mcp', 'list', '--json']);
    expectSuccess(result, 'inspection');
    const registry = parseJson(result.stdout);
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      throw Object.assign(new Error('Host MCP command returned an invalid server registry'), {
        code: 'HOST_CLI_INVALID_RESPONSE'
      });
    }
    const entry = Object.prototype.hasOwnProperty.call(registry, SERVER_NAME)
      ? registry[SERVER_NAME]
      : null;
    if (!entry) {
      return {
        state: 'absent',
        currentFingerprint: null,
        currentEntry: null,
        fullCurrentEntry: null,
        fullFingerprint: null
      };
    }
    const fullCurrentEntry = cloneFullEntry(entry, managedEnvKeys);
    const currentEntry = managedEntry(fullCurrentEntry, managedEnvKeys);
    const currentFingerprint = fingerprint(currentEntry);
    const fullFingerprint = fingerprint(fullCurrentEntry);
    if (fullCurrentEntry.enabled === false) {
      return ownsEntry(currentEntry, context.clientId)
        ? { state: 'disabled', currentFingerprint, currentEntry, fullCurrentEntry, fullFingerprint }
        : { state: 'conflict', currentFingerprint, currentEntry: null, fullCurrentEntry: null, fullFingerprint };
    }
    if (fingerprint(desiredManagedEntry(context.desired, managedEnvKeys)) === currentFingerprint) {
      return { state: 'registered', currentFingerprint, currentEntry, fullCurrentEntry, fullFingerprint };
    }
    if (ownsEntry(currentEntry, context.clientId)) {
      return { state: 'owned_outdated', currentFingerprint, currentEntry, fullCurrentEntry, fullFingerprint };
    }
    return { state: 'conflict', currentFingerprint, currentEntry: null, fullCurrentEntry: null, fullFingerprint };
  }

  async function set(entry) {
    const completeEntry = cloneFullEntry(entry, managedEnvKeys);
    const result = await invoke(['mcp', 'set', SERVER_NAME, JSON.stringify(completeEntry)]);
    expectSuccess(result, 'set');
  }

  async function unset() {
    const result = await invoke(['mcp', 'unset', SERVER_NAME]);
    expectSuccess(result, 'unset');
  }

  return {
    inspect,
    prepareEntry(context, currentEntry = null) {
      return mergedOwnedEntry(currentEntry, context.desired, managedEnvKeys);
    },
    async install(context, { expectedFullFingerprint = null, entry = null } = {}) {
      const before = await inspect(context);
      if (before.fullFingerprint !== expectedFullFingerprint) {
        throw Object.assign(new Error('Host MCP entry changed after registration preflight'), {
          code: 'HOST_CLI_CAS_MISMATCH'
        });
      }
      const nextEntry = entry || mergedOwnedEntry(before.fullCurrentEntry, context.desired, managedEnvKeys);
      await set(nextEntry);
      const verified = await inspect(context);
      if (verified.state !== 'registered' || verified.fullFingerprint !== fingerprint(cloneFullEntry(nextEntry, managedEnvKeys))) {
        throw Object.assign(new Error('Host MCP registration could not be verified'), {
          code: 'HOST_CLI_WRITE_VERIFY_FAILED'
        });
      }
      return verified;
    },
    async remove(context, { expectedFullFingerprint = null } = {}) {
      const before = await inspect(context);
      if (before.fullFingerprint !== expectedFullFingerprint) {
        throw Object.assign(new Error('Host MCP entry changed after removal preflight'), {
          code: 'HOST_CLI_CAS_MISMATCH'
        });
      }
      await unset();
      const verified = await inspect(context);
      if (verified.state !== 'absent') {
        throw Object.assign(new Error('Host MCP removal could not be verified'), {
          code: 'HOST_CLI_WRITE_VERIFY_FAILED'
        });
      }
      return verified;
    },
    async restore(context, entry, options = {}) {
      const before = await inspect(context);
      const fullComparison = Object.prototype.hasOwnProperty.call(options, 'expectedFullFingerprint');
      const actualFingerprint = fullComparison ? before.fullFingerprint : before.currentFingerprint;
      const expectedFingerprint = fullComparison
        ? options.expectedFullFingerprint
        : options.expectedFingerprint;
      if (actualFingerprint !== expectedFingerprint) {
        throw Object.assign(new Error('Host MCP entry changed before rollback'), {
          code: 'HOST_CLI_CAS_MISMATCH'
        });
      }
      if (entry) await set(entry);
      else {
        if (before.state !== 'absent') await unset();
      }
      const restored = await inspect(context);
      const restoredFingerprint = entry ? fingerprint(cloneFullEntry(entry, managedEnvKeys)) : null;
      if (restored.fullFingerprint !== restoredFingerprint) {
        throw Object.assign(new Error('Host MCP rollback could not be verified'), {
          code: 'HOST_CLI_WRITE_VERIFY_FAILED'
        });
      }
    },
    fingerprint: (entry) => entry ? fingerprint(managedEntry(entry, managedEnvKeys)) : null,
    fullFingerprint: (entry) => entry ? fingerprint(cloneFullEntry(entry, managedEnvKeys)) : null,
    desiredEntry: (desired) => desiredManagedEntry(desired, managedEnvKeys)
  };
}
