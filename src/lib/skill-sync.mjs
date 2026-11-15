import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledSkill = fileURLToPath(new URL('../../skills/eric-task-master/', import.meta.url));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function failure(code, message, nextAction) {
  return Object.assign(new Error(message), { code, nextAction });
}

export function selectedSkillDirectory({ environment = process.env, home = os.homedir() } = {}) {
  const requested = environment.ERIC_TASK_MASTER_SKILL_DIR;
  const codexRoot = environment.CODEX_HOME || path.join(home, '.codex');
  if (requested && (!path.isAbsolute(requested) || path.basename(requested).toLowerCase() !== 'eric-task-master')) {
    throw failure('SKILL_LOCATION_INVALID', 'ERIC_TASK_MASTER_SKILL_DIR must be an absolute eric-task-master Skill directory');
  }
  if (!requested && !path.isAbsolute(codexRoot)) {
    throw failure('SKILL_LOCATION_INVALID', 'The selected Codex Skill home is not an absolute path');
  }
  return { directory: path.resolve(requested || path.join(codexRoot, 'skills', 'eric-task-master')), required: Boolean(requested) };
}

async function readSkill(directory, { required = true } = {}) {
  let entry;
  try { entry = await lstat(directory); } catch (error) {
    if (error.code === 'ENOENT') {
      try {
        await lstat(path.join(path.dirname(directory), '.eric-task-master-upgrade.lock'));
        throw failure('SKILL_UPGRADE_BUSY', 'A Task Master Skill replacement is in progress');
      } catch (lockError) { if (lockError.code !== 'ENOENT') throw lockError; }
    }
    if (error.code === 'ENOENT' && !required) return null;
    if (error.code === 'ENOENT') throw failure('SKILL_NOT_INSTALLED', `Task Master Skill not found: ${directory}`);
    throw error;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw failure('SKILL_LOCATION_INVALID', `Task Master Skill is not a normal directory: ${directory}`);
  }
  const text = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  const name = frontmatter && /^name:\s*([^\r\n]+)\s*$/mu.exec(frontmatter)?.[1]?.trim();
  const version = frontmatter && /^metadata:\s*\{[^\r\n]*\bversion:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?/mu.exec(frontmatter)?.[1];
  if (name !== 'eric-task-master' || !semver.test(version || '')) {
    throw failure('SKILL_IDENTITY_INVALID', `Task Master Skill identity or version is invalid: ${directory}`);
  }
  return { directory, version };
}

export function assertAgentSkillLoaded(version, selection = selectedSkillDirectory(), environment = process.env) {
  if (!(environment.CODEX_THREAD_ID || environment.ERIC_TASK_MASTER_AGENT_ID)) return;
  if (environment.ERIC_TASK_MASTER_AGENT_SKILL_VERSION !== version) {
    throw failure('AGENT_SKILL_REFRESH_REQUIRED', 'This Agent must load the current Task Master Skill before starting new work',
      `Read ${path.join(selection.directory, 'SKILL.md')} in full, follow its Agent version setup, then retry. The rejected request was not executed.`);
  }
}

function compareVersions(a, b) {
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

async function fingerprint(directory) {
  const entries = [];
  async function walk(relative = '') {
    const names = (await readdir(path.join(directory, relative), { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const item of names) {
      const next = path.join(relative, item.name);
      if (item.isDirectory()) {
        entries.push(`directory:${next.split(path.sep).join('/')}`);
        await walk(next);
      } else if (item.isFile()) {
        const bytes = await readFile(path.join(directory, next));
        entries.push(`file:${next.split(path.sep).join('/')}:${createHash('sha256').update(bytes).digest('hex')}`);
      } else {
        throw failure('SKILL_LOCATION_INVALID', `Task Master Skill contains an unsupported link or file: ${path.join(directory, next)}`);
      }
    }
  }
  await walk();
  return entries.join('\n');
}

export async function assertSelectedSkillVersion(version, selection = selectedSkillDirectory()) {
  const installed = await readSkill(selection.directory, { required: selection.required });
  if (installed && installed.version !== version) {
    throw failure('SKILL_VERSION_MISMATCH', `Installed Skill ${installed.version} does not match Task Master ${version}`,
      'Finish active work and run taskmaster manager start --upgrade with the current launcher before starting new work.');
  }
  return installed ? { state: 'current', version } : { state: 'not-installed' };
}

export async function planSkillUpgrade(version, {
  source = bundledSkill, selection = selectedSkillDirectory()
} = {}) {
  const packaged = await readSkill(source);
  if (packaged.version !== version) throw failure('BUNDLED_SKILL_MISMATCH', `Bundled Skill ${packaged.version} does not match runtime ${version}`);
  const sourceFingerprint = await fingerprint(source);
  const installed = await readSkill(selection.directory, { required: selection.required });
  if (!installed) return { state: 'not-installed', selection };
  if (compareVersions(installed.version, version) > 0) {
    throw failure('SKILL_DOWNGRADE_REFUSED', `Installed Skill ${installed.version} is newer than runtime ${version}`);
  }
  const matches = installed.version === version && sourceFingerprint === await fingerprint(selection.directory);
  return { state: matches ? 'current' : 'replacement-required', selection, installedVersion: installed.version, source, sourceFingerprint };
}

export async function replaceSelectedSkill(version, options = {}) {
  let plan = await planSkillUpgrade(version, options);
  if (plan.state !== 'replacement-required') return { state: plan.state, version: plan.state === 'current' ? version : null };
  const destination = plan.selection.directory;
  const parent = path.dirname(destination);
  if (parent === path.parse(parent).root) throw failure('SKILL_LOCATION_INVALID', 'Skill parent cannot be a filesystem root');
  const lockPath = path.join(parent, '.eric-task-master-upgrade.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw failure('SKILL_UPGRADE_BUSY', 'Another Task Master Skill upgrade is in progress or requires recovery');
    throw error;
  }
  const stage = path.join(parent, `.eric-task-master-stage-${randomUUID()}`);
  let stageOwned = false;
  try {
    plan = await planSkillUpgrade(version, options);
    if (plan.state !== 'replacement-required') return { state: plan.state, version: plan.state === 'current' ? version : null };
    await mkdir(stage);
    stageOwned = true;
    await cp(plan.source, stage, { recursive: true, force: true });
    if (await fingerprint(stage) !== plan.sourceFingerprint || (await readSkill(stage)).version !== version) {
      throw failure('SKILL_COPY_MISMATCH', 'Staged Task Master Skill differs from the bundled Skill');
    }
    const backupParent = path.basename(parent).toLowerCase() === 'skills' ? path.dirname(parent) : parent;
    if (backupParent === path.parse(backupParent).root) throw failure('SKILL_LOCATION_INVALID', 'Skill backup parent cannot be a filesystem root');
    const backupRoot = path.join(backupParent, 'eric-task-master-skill-backups');
    await mkdir(backupRoot, { recursive: true });
    const backupEntry = await lstat(backupRoot);
    if (!backupEntry.isDirectory() || backupEntry.isSymbolicLink()) {
      throw failure('SKILL_LOCATION_INVALID', 'Skill backup location is not a normal directory');
    }
    const backup = path.join(backupRoot, `${plan.installedVersion}-${randomUUID()}`);
    await rename(destination, backup);
    try {
      await rename(stage, destination);
      stageOwned = false;
    } catch (error) {
      await rename(backup, destination);
      throw error;
    }
    if (await fingerprint(destination) !== plan.sourceFingerprint || (await readSkill(destination)).version !== version) {
      throw failure('SKILL_COPY_MISMATCH', `Installed Skill verification failed; previous Skill remains at ${backup}`);
    }
    return { state: 'replaced', version, previousVersion: plan.installedVersion, backup };
  } finally {
    try { if (stageOwned) await rm(stage, { recursive: true, force: true }); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
