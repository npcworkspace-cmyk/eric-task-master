import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertSelectedSkillVersion, planSkillUpgrade, replaceSelectedSkill, selectedSkillDirectory } from '../src/lib/skill-sync.mjs';
import { removeTestTree } from './test-fs.mjs';

async function makeSkill(directory, version, extra = '') {
  await mkdir(path.join(directory, 'scripts'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: eric-task-master\nmetadata: { version: "${version}" }\n---\n${extra}\n`);
  await writeFile(path.join(directory, 'LICENSE'), `license-${version}`);
  await writeFile(path.join(directory, 'scripts', 'find-launcher.ps1'), `locator-${version}`);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-skill-upgrade-'));
  t.after(() => removeTestTree(root));
  const source = path.join(root, 'package', 'eric-task-master');
  const destination = path.join(root, 'agent', 'skills', 'eric-task-master');
  await makeSkill(source, '4.0.2');
  return { root, source, destination, selection: { directory: destination, required: true } };
}

test('upgrade replaces the complete installed Skill, verifies it, and preserves the old directory outside active skills', async (t) => {
  const f = await fixture(t);
  await makeSkill(f.destination, '4.0.1', 'original text');
  await writeFile(path.join(f.destination, 'old-extra.txt'), 'preserve this in backup');
  await assert.rejects(assertSelectedSkillVersion('4.0.2', f.selection), { code: 'SKILL_VERSION_MISMATCH' });
  assert.equal((await planSkillUpgrade('4.0.2', f)).state, 'replacement-required');
  const result = await replaceSelectedSkill('4.0.2', f);
  assert.equal(result.state, 'replaced');
  assert.equal(result.previousVersion, '4.0.1');
  assert.equal(await readFile(path.join(result.backup, 'old-extra.txt'), 'utf8'), 'preserve this in backup');
  assert.match(await readFile(path.join(result.backup, 'SKILL.md'), 'utf8'), /4\.0\.1/u);
  assert.equal(await readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), await readFile(path.join(f.source, 'SKILL.md'), 'utf8'));
  assert.deepEqual((await readdir(f.destination)).sort(), ['LICENSE', 'SKILL.md', 'scripts']);
  assert.equal((await assertSelectedSkillVersion('4.0.2', f.selection)).state, 'current');
  assert.equal((await replaceSelectedSkill('4.0.2', f)).state, 'current');
});

test('upgrade refuses a newer or unrecognized Skill without replacing it', async (t) => {
  const f = await fixture(t);
  await makeSkill(f.destination, '4.0.3');
  const before = await readFile(path.join(f.destination, 'SKILL.md'), 'utf8');
  await assert.rejects(replaceSelectedSkill('4.0.2', f), { code: 'SKILL_DOWNGRADE_REFUSED' });
  assert.equal(await readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), before);
  await writeFile(path.join(f.destination, 'SKILL.md'), '---\nname: another-skill\nmetadata: { version: "4.0.1" }\n---\n');
  await assert.rejects(replaceSelectedSkill('4.0.2', f), { code: 'SKILL_IDENTITY_INVALID' });
});

test('upgrade does not invent a Skill installation and rejects an explicit missing path', async (t) => {
  const f = await fixture(t);
  const optional = { directory: f.destination, required: false };
  assert.equal((await assertSelectedSkillVersion('4.0.2', optional)).state, 'not-installed');
  assert.equal((await replaceSelectedSkill('4.0.2', { source: f.source, selection: optional })).state, 'not-installed');
  await assert.rejects(replaceSelectedSkill('4.0.2', f), { code: 'SKILL_NOT_INSTALLED' });
});

test('an existing upgrade lock is never removed or bypassed', async (t) => {
  const f = await fixture(t);
  await makeSkill(f.destination, '4.0.1');
  const lock = path.join(path.dirname(f.destination), '.eric-task-master-upgrade.lock');
  await writeFile(lock, 'another-owner');
  await assert.rejects(replaceSelectedSkill('4.0.2', f), { code: 'SKILL_UPGRADE_BUSY' });
  assert.equal(await readFile(lock, 'utf8'), 'another-owner');
  assert.match(await readFile(path.join(f.destination, 'SKILL.md'), 'utf8'), /4\.0\.1/u);
});

test('upgrade refuses to replace a linked Skill directory', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, 'other-agent-skill');
  await makeSkill(target, '4.0.1');
  await mkdir(path.dirname(f.destination), { recursive: true });
  await symlink(target, f.destination, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(replaceSelectedSkill('4.0.2', f), { code: 'SKILL_LOCATION_INVALID' });
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /4\.0\.1/u);
});

test('a configured external Skill directory must be an absolute Task Master Skill path', () => {
  const requested = path.join(os.tmpdir(), 'agent', 'eric-task-master');
  assert.deepEqual(selectedSkillDirectory({ environment: { ERIC_TASK_MASTER_SKILL_DIR: requested } }),
    { directory: path.resolve(requested), required: true });
  assert.throws(() => selectedSkillDirectory({ environment: { ERIC_TASK_MASTER_SKILL_DIR: 'other/skill' } }),
    { code: 'SKILL_LOCATION_INVALID' });
});
