import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { managerStateId, readManagerConfig } from './manager-state.mjs';
import { replaceFileWithRetry } from './json-store.mjs';

const MAX_PACKAGES = 1_024;

function locationError(code, message) {
  return Object.assign(new Error(message), {
    code,
    nextAction: 'Keep existing data and Profiles. Select the intended --state-dir explicitly; do not reinstall or create replacement Profiles.'
  });
}

function absoluteDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || value.length > 32_768) {
    throw locationError('MANAGER_LOCATION_INVALID', 'Manager state location must be an absolute local path');
  }
  return path.resolve(value);
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function stateEnvironment({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const legacyRoot = platform === 'win32'
    ? path.join(local, 'eric-task-master')
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'eric-task-master')
      : path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'eric-task-master');
  return {
    platform,
    appDataRoot: platform === 'win32' ? path.dirname(local) : null,
    sharedRoot: platform === 'win32' ? path.join(home, '.eric-task-master', 'state') : legacyRoot,
    legacyRoot,
    packageRoot: platform === 'win32' ? path.join(local, 'Packages') : null,
    locatorFile: path.join(home, '.eric-task-master', 'default-state.json')
  };
}

export function projectStateEnvironment(stateDir, environment = stateEnvironment()) {
  if (environment.platform !== 'win32') return null;
  const requested = absoluteDirectory(stateDir);
  const relative = path.relative(environment.appDataRoot, requested);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const key = createHash('sha256').update(requested.toLowerCase()).digest('hex').slice(0, 32);
  return {
    ...environment,
    locatorFile: path.join(path.dirname(environment.locatorFile), 'projects', key + '.json')
  };
}

export async function assertStateOutsideApplication(stateDir) {
  const logical = absoluteDirectory(stateDir);
  let physical;
  for (let existing = logical; ;) {
    try {
      physical = path.resolve(await realpath(existing), path.relative(existing, logical));
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  for (const candidate of new Set([logical, physical])) {
    let directory = candidate;
    for (;;) {
      let packageJson;
      try { packageJson = JSON.parse(await readFile(path.join(directory, 'app', 'package.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
      if (packageJson?.name === 'eric-task-master') {
        throw locationError('MANAGER_STATE_IN_APPLICATION',
          'Manager data must be outside the replaceable Task Master application directory');
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
}

export async function inspectStateDirectory(root, { resolveFile = realpath, inspectDirectory = stat } = {}) {
  const identityDir = absoluteDirectory(root);
  const configPath = path.join(identityDir, 'config.json');
  try {
    await access(configPath);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const config = await readManagerConfig(configPath);
  if (typeof config.stateInstanceId !== 'string' || config.stateInstanceId.length < 16) {
    throw locationError('MANAGER_LOCATION_INVALID', 'Retained Manager state has no valid instance identity');
  }
  // Resolving the directory alone can retain the lexical MSIX view. The
  // configuration file identifies the physical store actually being read.
  const stateDir = path.dirname(await resolveFile(configPath));
  const [logical, physical] = await Promise.all([inspectDirectory(identityDir), inspectDirectory(stateDir)]);
  if (logical.dev !== physical.dev || logical.ino !== physical.ino) {
    throw locationError('MANAGER_LOCATION_INVALID', 'A configuration-only link cannot select another data directory');
  }
  return {
    stateDir, identityDir, config,
    stateId: managerStateId(config.stateInstanceId, identityDir),
    stateDirectoryId: managerStateId(config.stateInstanceId, stateDir)
  };
}

export async function readDefaultStateLocation(environment = stateEnvironment()) {
  let record;
  try {
    record = JSON.parse(await readFile(environment.locatorFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw locationError('MANAGER_LOCATION_INVALID', 'The shared state locator is unreadable or incomplete');
  }
  if (record.version !== 1 || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65_535) {
    throw locationError('MANAGER_LOCATION_INVALID', 'The shared state locator is invalid');
  }
  return {
    stateDir: absoluteDirectory(record.stateDir),
    identityDir: absoluteDirectory(record.identityDir),
    port: record.port,
    ...(record.launcher ? { launcher: absoluteDirectory(record.launcher) } : {})
  };
}

export async function rememberDefaultStateLocation(record, environment = stateEnvironment()) {
  const value = {
    version: 1,
    stateDir: absoluteDirectory(record.stateDir),
    identityDir: absoluteDirectory(record.identityDir),
    port: record.port,
    ...(record.launcher ? { launcher: absoluteDirectory(record.launcher) } : {})
  };
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw locationError('MANAGER_LOCATION_INVALID', 'The shared Manager port is invalid');
  }
  await mkdir(path.dirname(environment.locatorFile), { recursive: true, mode: 0o700 });
  const temporary = environment.locatorFile + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, environment.locatorFile);
        break;
      } catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        const current = await readDefaultStateLocation(environment).catch(() => null);
        if (current && samePath(current.stateDir, value.stateDir) &&
            samePath(current.identityDir, value.identityDir) && current.port === value.port &&
            current.launcher === value.launcher) break;
        if (attempt === 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (2 ** attempt)));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function knownDirectories(environment) {
  const directories = [environment.sharedRoot, environment.legacyRoot];
  if (environment.packageRoot) {
    let packages;
    try {
      packages = await readdir(environment.packageRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      packages = [];
    }
    if (packages.length > MAX_PACKAGES) {
      throw locationError('MANAGER_STATE_AMBIGUOUS', 'Too many packaged state locations to inspect safely');
    }
    for (const entry of packages) {
      if (!entry.isDirectory()) continue;
      directories.push(path.join(environment.packageRoot, entry.name, 'LocalCache', 'Local', 'eric-task-master'));
    }
  }
  return [...new Set(directories.map((directory) => path.resolve(directory)))];
}

export async function chooseDefaultState({ environment = stateEnvironment(), manager = null } = {}) {
  if (manager?.scope === 'project') {
    throw locationError('MANAGER_STATE_MISMATCH', 'A project Manager cannot replace the shared default Manager');
  }
  const pinned = await readDefaultStateLocation(environment);
  const directories = pinned
    ? [pinned.stateDir]
    : [...(manager?.stateDirEffective ? [absoluteDirectory(manager.stateDirEffective)] : []), ...await knownDirectories(environment)];
  const states = [];
  for (const directory of directories) {
    const inspected = await inspectStateDirectory(directory);
    if (!inspected) continue;
    if (!states.some((state) => samePath(state.stateDir, inspected.stateDir))) states.push(inspected);
  }
  if (manager) {
    if (manager.stateChanged === true && (pinned || manager.stateDirEffective)) {
      const selected = pinned?.stateDir || manager.stateDirEffective;
      const owned = states.find((state) => samePath(state.stateDir, selected));
      if (owned) return {
        stateDir: owned.stateDir, identityDir: pinned?.identityDir || manager.stateDirLogical,
        pinned: Boolean(pinned)
      };
    }
    const matches = [];
    for (const state of states) {
      const identityDirs = pinned
        ? [pinned.identityDir]
        : [manager.stateDirLogical, environment.legacyRoot, environment.sharedRoot, state.identityDir].filter(Boolean);
      if (manager.stateDirectoryId && state.stateDirectoryId !== manager.stateDirectoryId) continue;
      for (const identityDir of identityDirs) {
        if (managerStateId(state.config.stateInstanceId, identityDir) === manager.stateId) {
          matches.push({ stateDir: state.stateDir, identityDir: path.resolve(identityDir), pinned: Boolean(pinned) });
          break;
        }
      }
    }
    if (matches.length === 1) return matches[0];
    throw locationError(
      matches.length > 1 ? 'MANAGER_STATE_AMBIGUOUS' : 'MANAGER_STATE_MISMATCH',
      'The running Manager cannot be matched to one retained shared state'
    );
  }
  if (states.length > 1) {
    throw locationError('MANAGER_STATE_AMBIGUOUS', 'Multiple retained states exist; none was selected as the shared default');
  }
  if (states.length === 1) {
    return { stateDir: states[0].stateDir, identityDir: pinned?.identityDir || states[0].identityDir, pinned: Boolean(pinned) };
  }
  if (pinned) {
    // An absent selected store is not permission to create a different default.
    throw locationError('MANAGER_LOCATION_INVALID', 'The selected shared state configuration is missing');
  }
  return { stateDir: environment.sharedRoot, identityDir: environment.sharedRoot, pinned: false };
}

export async function readStateEndpoint(stateDir) {
  let record;
  try {
    record = JSON.parse(await readFile(path.join(stateDir, 'manager.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw locationError('MANAGER_LOCATION_INVALID', 'The project Manager endpoint is unreadable or incomplete');
  }
  let url;
  try { url = new URL(record.baseUrl); } catch {
    throw locationError('MANAGER_LOCATION_INVALID', 'The project Manager endpoint is invalid');
  }
  const port = Number(url.port || 80);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !Number.isSafeInteger(port) ||
      port < 1 || port > 65_535 || !Number.isSafeInteger(record.pid) || record.pid <= 0) {
    throw locationError('MANAGER_LOCATION_INVALID', 'The project Manager endpoint must be an owned loopback address');
  }
  return { port, baseUrl: url.origin, pid: record.pid };
}

export async function writeStateEndpoint(stateDir, record) {
  const destination = path.join(stateDir, 'manager.json');
  const temporary = destination + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    await replaceFileWithRetry(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
