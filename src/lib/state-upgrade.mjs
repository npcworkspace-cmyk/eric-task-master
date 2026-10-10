import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ManagerLock } from './manager-lock.mjs';
import { readManagerConfig } from './manager-state.mjs';
import { probeChromeProfileUsage } from './process-tree.mjs';
import { assertStateOutsideApplication, rememberDefaultStateLocation } from './state-directory.mjs';

const PROFILE_ID = /^profile_[a-f0-9]{32}$/u;
const BROWSER_STATE_FILES = ['Local State', 'Default/Preferences', 'Default/Secure Preferences',
  'Default/Network/Cookies', 'Default/Cookies', 'Default/Login Data'];

function upgradeError(message) {
  return Object.assign(new Error(message), { code: 'MANAGER_STATE_UPGRADE_REQUIRED',
    nextAction: 'Keep the original data. The Owner must run manager start --upgrade with the same --state-dir, if any, from the host that can read the complete selected legacy view; do not recreate Profiles.' });
}

async function profilesAt(stateDir) {
  try {
    const value = JSON.parse(await readFile(path.join(stateDir, 'profiles.json'), 'utf8'));
    const deleting = new Set((value.deletions || []).map((record) => record.profileId));
    return (value.profiles || []).filter((profile) => PROFILE_ID.test(profile?.id || '') &&
      profile.kind !== 'ephemeral' && !deleting.has(profile.id));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function exists(file) {
  try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Check only records being rebased, once at Manager creation. Normal commands
// against an already-running Manager never scan or copy browser state.
export async function assertRetainedProfileView(stateDir, aliases) {
  if (!aliases.length) return;
  for (const profile of await profilesAt(stateDir)) {
    const oldRoot = aliases.find((alias) => typeof profile.userDataDir === 'string' &&
      path.resolve(profile.userDataDir) === path.resolve(alias, 'profiles', profile.id));
    if (!oldRoot) continue;
    const target = path.join(stateDir, 'profiles', profile.id);
    const source = path.join(oldRoot, 'profiles', profile.id);
    if (!await exists(target) && await exists(source)) throw upgradeError('The selected physical store omits a retained Profile directory');
    for (const relative of BROWSER_STATE_FILES) {
      if (!await exists(path.join(target, relative)) && await exists(path.join(source, relative))) {
        throw upgradeError('The selected physical store omits retained browser state from its legacy view');
      }
    }
  }
}

function excluded(relative) {
  return relative === '.manager.lock' || relative.startsWith('.manager.lock.');
}

async function stateTree(root) {
  const digest = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const visit = async (directory) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (excluded(relative)) continue;
      if (entry.isSymbolicLink()) throw upgradeError('Legacy state contains a link; automatic copying stopped safely');
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const content = createHash('sha256');
        for await (const chunk of createReadStream(file)) { content.update(chunk); bytes += chunk.length; }
        digest.update(relative).update('\0').update(content.digest('hex')).update('\0');
        files += 1;
      } else throw upgradeError('Legacy state contains an unsupported file type');
    }
  };
  await visit(root);
  return { files, bytes, sha256: digest.digest('hex') };
}

// This is an explicit Owner-upgrade operation, not an Agent startup path.
// Materialize the one verified Windows view; never merge two configurations.
export async function consolidateLegacySharedState(config, { profileUsageProbe = probeChromeProfileUsage } = {}) {
  const { environment } = config;
  if (environment?.platform !== 'win32' || (!config.shared && !config.projectEnvironment)) return;
  const relative = path.relative(environment.appDataRoot, config.stateDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return;
  const selected = path.resolve(config.stateDir);
  const target = config.shared ? path.resolve(environment.sharedRoot) : path.join(
    path.dirname(environment.locatorFile), 'project-state', path.basename(config.projectEnvironment.locatorFile, '.json'));
  const locationEnvironment = config.shared ? environment : config.projectEnvironment;
  const locationPort = config.port || 1;
  if (selected.toLowerCase() === target.toLowerCase()) return;
  if (!await exists(path.join(selected, 'config.json'))) return;
  await assertStateOutsideApplication(target);
  if (await exists(target)) throw upgradeError('The shared destination already exists; it will not be overwritten or merged');
  const source = path.resolve(config.identityDir || selected);
  const current = await readManagerConfig(path.join(selected, 'config.json'));
  const view = await readManagerConfig(path.join(source, 'config.json'));
  if (current.stateInstanceId !== view.stateInstanceId || current.managerToken !== view.managerToken ||
      await realpath(path.join(selected, 'config.json')) !== await realpath(path.join(source, 'config.json'))) {
    throw upgradeError('This Agent host does not expose the selected complete legacy state view');
  }
  const lock = new ManagerLock(path.join(selected, '.manager.lock'));
  await lock.acquire();
  const staging = path.join(path.dirname(target), '.state-upgrade-' + randomUUID());
  try {
    for (const profile of await profilesAt(source)) {
      if (profile.lease || ['opening', 'open', 'closing'].includes(profile.state) ||
          await profileUsageProbe(path.join(source, 'profiles', profile.id)) !== 'inactive') {
        throw upgradeError('A retained Profile is occupied or its inactivity could not be proven');
      }
    }
    // Pin the selected store before copying so another host cannot initialize
    // a blank default while the legacy store's lifetime lock is held.
    await rememberDefaultStateLocation({ stateDir: selected, identityDir: source, port: locationPort }, locationEnvironment);
    await mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
    await cp(source, staging, { recursive: true, dereference: true, force: false, errorOnExist: true, preserveTimestamps: true,
      filter: async (file) => {
        if (excluded(path.relative(source, file).split(path.sep).join('/'))) return false;
        if (file !== source && (await lstat(file)).isSymbolicLink()) throw upgradeError('Legacy state contains a link; copying stopped safely');
        return true;
      } });
    const before = await stateTree(source);
    const after = await stateTree(staging);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw upgradeError('The copied state did not match the complete source view');
    const copied = await readManagerConfig(path.join(staging, 'config.json'));
    if (copied.managerToken !== current.managerToken || copied.stateInstanceId !== current.stateInstanceId) {
      throw upgradeError('Legacy configuration changed during the copy');
    }
    const aliases = [...new Set([source, selected, ...(Array.isArray(copied.stateDirAliases) ? copied.stateDirAliases : [])])];
    if (aliases.length > 16 || aliases.some((alias) => typeof alias !== 'string' || !path.isAbsolute(alias))) {
      throw upgradeError('Legacy state aliases could not be preserved safely');
    }
    await writeFile(path.join(staging, 'config.json'), JSON.stringify({ ...copied, stateDirAliases: aliases }, null, 2) + '\n', { mode: 0o600 });
    await rename(staging, target);
    await rememberDefaultStateLocation({ stateDir: target, identityDir: source, port: locationPort }, locationEnvironment);
    config.stateDir = target;
    config.identityDir = source;
    config.stateDirAliases = [source];
  } catch (error) {
    error.details = { ...(error.details || {}), retainedSource: source, stagingDirectory: staging, destination: target };
    throw error;
  } finally { await lock.release(); }
}
