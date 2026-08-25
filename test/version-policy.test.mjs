import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertVersionIncrease, compareSemver, nextVersion, parseSemver } from '../src/lib/semver.mjs';

test('semantic versions compare according to release precedence', () => {
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0);
  assert.equal(compareSemver('2.0.0-rc.2', '2.0.0-rc.1'), 1);
  assert.equal(compareSemver('2.0.0', '2.0.0-rc.99'), 1);
  assert.equal(compareSemver('2.0.0-A', '2.0.0-a'), -1);
  assert.equal(compareSemver('2.0.0-alpha-1', '2.0.0-alpha.1'), 1);
  assert.equal(compareSemver(`2.0.0-${'9'.repeat(80)}`, `2.0.0-${'8'.repeat(79)}`), 1);
  assert.equal(compareSemver('9007199254740993.0.0', '9007199254740992.0.0'), 1);
  assert.throws(() => parseSemver('02.0.0'));
});

test('version bumps reject equal or lower explicit versions', () => {
  assert.equal(nextVersion('2.0.0', 'patch'), '2.0.1');
  assert.equal(nextVersion('2.0.0', 'minor'), '2.1.0');
  assert.equal(nextVersion('2.0.0', 'major'), '3.0.0');
  assert.throws(() => nextVersion('2.0.0', '2.0.0'), /must increase monotonically/);
  assert.throws(() => nextVersion('2.0.0', '1.0.5'), /must increase monotonically/);
  assert.throws(() => nextVersion('2.0.0-a', '2.0.0-A'), /must increase monotonically/);
  assert.equal(assertVersionIncrease('2.0.0-rc.1', '2.0.0'), '2.0.0');
});

test('release version assertion rejects any non-increasing published version', () => {
  const script = path.resolve(import.meta.dirname, '..', 'scripts', 'assert-release-version.mjs');
  const accepted = spawnSync(process.execPath, [script, '2.0.0'], {
    input: 'v1.0.4\npreview\n',
    encoding: 'utf8'
  });
  assert.equal(accepted.status, 0, accepted.stderr);
  const rejected = spawnSync(process.execPath, [script, '2.0.0'], {
    input: 'v1.0.4\nv2.0.0\n',
    encoding: 'utf8'
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /must be greater than published version 2\.0\.0/);
});

test('release workflow revalidates version monotonicity immediately before publication', async () => {
  const workflow = await readFile(
    path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  const checks = [...workflow.matchAll(/scripts\/assert-release-version\.mjs/g)].map((match) => match.index);
  const mainRecheck = workflow.indexOf('MAIN_SHA_NOW=');
  const releaseCreate = workflow.indexOf('gh release create');
  assert.ok(checks.length >= 2, 'release workflow must check published versions at least twice');
  assert.ok(checks.at(-1) > mainRecheck, 'final version check must follow the main SHA recheck');
  assert.ok(checks.at(-1) < releaseCreate, 'final version check must precede Release creation');
});

test('standalone Skill wrapper rejects an incompatible runtime before launching it', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-skill-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillRoot = path.join(root, 'installed-skill');
  const scriptDir = path.join(skillRoot, 'scripts');
  const fakeRuntime = path.join(root, 'runtime');
  await mkdir(scriptDir, { recursive: true });
  await mkdir(fakeRuntime, { recursive: true });
  await copyFile(
    path.resolve(import.meta.dirname, '..', 'skills', 'eric-task-master', 'scripts', 'taskmaster.mjs'),
    path.join(scriptDir, 'taskmaster.mjs')
  );
  await copyFile(
    path.resolve(import.meta.dirname, '..', 'skills', 'eric-task-master', 'runtime.json'),
    path.join(skillRoot, 'runtime.json')
  );
  await writeFile(path.join(fakeRuntime, 'package.json'), JSON.stringify({
    name: 'eric-task-master',
    version: '1.0.4'
  }));

  const result = spawnSync(process.execPath, [path.join(scriptDir, 'taskmaster.mjs'), 'status'], {
    cwd: fakeRuntime,
    env: { ...process.env, ERIC_TASK_MASTER_ROOT: fakeRuntime },
    encoding: 'utf8'
  });
  assert.equal(result.status, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.error, 'TASKMASTER_RUNTIME_VERSION_MISMATCH');
  assert.equal(error.expected, '2.0.0');
  assert.equal(error.actual, '1.0.4');
});
