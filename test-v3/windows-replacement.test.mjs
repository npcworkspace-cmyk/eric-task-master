import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { removeTestTree } from './test-fs.mjs';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const helper = path.join(ROOT, 'src', 'lib', 'replace-legacy-launcher.ps1');
const activationHelper = path.join(ROOT, 'src', 'lib', 'activate-upgrade.ps1');
const windows = { skip: process.platform !== 'win32' };

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-legacy-replacement-'));
  t.after(() => removeTestTree(temp));
  const root = path.join(temp, 'Eric Task Master');
  const legacy = `${root} v3`;
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await writeFile(path.join(root, 'release-manifest.json'), JSON.stringify({ product: 'eric-task-master', version: '4.0.1' }));
  await writeFile(path.join(root, 'bin', 'taskmaster.cmd'), '@echo off\r\necho current-launcher %*\r\n');
  const invoke = (mode, version = '4.0.2') => execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-AppRoot', root, '-NewVersion', version, '-Mode', mode
  ], { windowsHide: true, timeout: 30_000 });
  const runLegacy = () => {
    const launcher = path.join(legacy, 'bin', 'taskmaster.cmd').replaceAll("'", "''");
    return execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `& '${launcher}' ops schema --json; exit $LASTEXITCODE`], { windowsHide: true, timeout: 10_000 });
  };
  return { temp, root, legacy, invoke, runLegacy };
}

test('replacement preserves the old installation and makes a stale Windows path invoke the current launcher', windows, async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.legacy, 'app'), { recursive: true });
  await mkdir(path.join(f.legacy, 'bin'));
  await writeFile(path.join(f.legacy, 'release-manifest.json'), JSON.stringify({ product: 'eric-task-master', version: '3.1.11' }));
  await writeFile(path.join(f.legacy, 'app', 'package.json'), JSON.stringify({ name: 'eric-task-master', version: '3.1.11' }));
  await writeFile(path.join(f.legacy, 'bin', 'taskmaster.cmd'), '@echo old-launcher\r\n');
  await writeFile(path.join(f.legacy, 'user-sentinel.txt'), 'preserve me');
  await f.invoke('Validate');
  const applied = JSON.parse((await f.invoke('Apply')).stdout.trim());
  assert.equal(applied.ok, true);
  assert.equal(await readFile(path.join(applied.backup, 'user-sentinel.txt'), 'utf8'), 'preserve me');
  assert.match((await f.runLegacy()).stdout, /current-launcher ops schema --json/u);
  assert.deepEqual((await readdir(f.legacy)).sort(), ['.taskmaster-legacy.json', 'bin']);
  await f.invoke('Apply');
  assert.equal((await readdir(f.temp)).filter((name) => name.startsWith('.Eric Task Master-retired-')).length, 1);
  await unlink(path.join(f.root, 'bin', 'taskmaster.cmd'));
  await assert.rejects(f.runLegacy(), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stderr, /current installation is missing/u);
    assert.doesNotMatch(error.stdout, /old-launcher/u);
    return true;
  });
});

test('replacement refuses unknown legacy folders and newer installations without moving either', windows, async (t) => {
  const f = await fixture(t);
  await mkdir(f.legacy);
  await writeFile(path.join(f.legacy, 'personal.txt'), 'do not touch');
  await assert.rejects(f.invoke('Validate'));
  assert.equal(await readFile(path.join(f.legacy, 'personal.txt'), 'utf8'), 'do not touch');
  await writeFile(path.join(f.root, 'release-manifest.json'), JSON.stringify({ product: 'eric-task-master', version: '4.0.3' }));
  await assert.rejects(f.invoke('Validate'), (error) => {
    assert.match(error.stderr, /Refusing to downgrade/u);
    return true;
  });
  assert.equal(await readFile(path.join(f.legacy, 'personal.txt'), 'utf8'), 'do not touch');
});

test('an installation without a previous v3 directory does not create one', windows, async (t) => {
  const f = await fixture(t);
  await f.invoke('Validate');
  await f.invoke('Apply');
  assert.equal((await readdir(f.temp)).includes('Eric Task Master v3'), false);
});

test('Windows activation succeeds only when the actual Manager and selected Skill result is complete', windows, async (t) => {
  const f = await fixture(t);
  const launcher = path.join(f.root, 'bin', 'taskmaster.cmd');
  const invoke = () => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', activationHelper, '-AppRoot', f.root, '-ExpectedVersion', '4.0.2'], { windowsHide: true, timeout: 30_000 });
  await writeFile(launcher, '@echo off\r\necho {"ok":true,"manager":{"version":"4.0.2"},"skill":{"state":"current"}}\r\n');
  assert.equal(JSON.parse((await invoke()).stdout).manager.version, '4.0.2');
  await writeFile(launcher, '@echo off\r\necho {"ok":true,"manager":{"version":"4.0.1"},"skill":{"state":"current"}}\r\n');
  await assert.rejects(invoke(), (error) => {
    assert.equal(error.code, 20);
    assert.match(error.stderr, /activation is incomplete/u);
    return true;
  });
});
