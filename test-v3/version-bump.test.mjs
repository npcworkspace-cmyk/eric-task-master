import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { VERSION } from '../src/contracts.mjs';
import { removeTestTree } from './test-fs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const files = [
  'package.json', 'package-lock.json', 'scripts/bump-version.mjs', 'src/contracts.mjs',
  'dashboard/dashboard.js', 'dashboard/index.html', 'README.md', 'README.zh-CN.md',
  'docs/INSTALLERS.md', 'skills/eric-task-master/SKILL.md'
];

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-version-bump-'));
  t.after(() => removeTestTree(directory));
  for (const file of files) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(ROOT, file), target);
  }
  return directory;
}

test('version bump keeps runtime, Dashboard, Skill and current deployment docs in sync', async (t) => {
  const directory = await fixture(t);
  const next = VERSION.split('.').map(Number);
  next[2] += 1;
  const nextVersion = next.join('.');
  await execute(process.execPath, [path.join(directory, 'scripts/bump-version.mjs'), 'patch'], { windowsHide: true });
  for (const file of files.filter((value) => !value.startsWith('scripts/'))) {
    const content = await readFile(path.join(directory, file), 'utf8');
    assert.ok(content.includes(nextVersion), `${file} did not get the new version`);
    assert.ok(!content.includes(VERSION), `${file} still has the old current version`);
  }
});

test('driving Skill follows a newer Latest only after replacing Manager and refuses a downgrade', async () => {
  const skill = await readFile(path.join(ROOT, 'skills/eric-task-master/SKILL.md'), 'utf8');
  assert.match(skill, /If it is newer than [0-9.]+, consult that release's deployment guide[\s\S]*replace and activate Manager[\s\S]*then load the matching Skill/u);
  assert.match(skill, /If Latest is older than [0-9.]+[\s\S]*stop and report rather than downgrade/u);
});

test('version bump validates all components before writing any file', async (t) => {
  const directory = await fixture(t);
  const broken = path.join(directory, 'dashboard/index.html');
  await writeFile(broken, (await readFile(broken, 'utf8')).replace(`/dashboard/dashboard.js?v=${VERSION}`, '/missing-version'));
  const before = await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')));
  await assert.rejects(execute(process.execPath, [path.join(directory, 'scripts/bump-version.mjs'), 'patch'], { windowsHide: true }));
  const after = await Promise.all(files.map((file) => readFile(path.join(directory, file), 'utf8')));
  assert.deepEqual(after, before);
});
