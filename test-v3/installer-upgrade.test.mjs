import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { removeTestTree } from './test-fs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

async function source(relative) {
  return readFile(path.join(ROOT, ...relative.split('/')), 'utf8');
}

function occurrences(value, fragment) {
  return value.split(fragment).length - 1;
}

test('Windows upgrade and uninstall refuse an occupied runtime without stopping any Agent', async () => {
  const installer = await source('scripts/install/windows/installer.iss');
  for (const payload of ['app', 'bin', 'runtime']) {
    assert.match(installer, new RegExp(`Name: "\\{app\\}\\\\${payload}"; Check: IsManagedUpgradeRoot`, 'u'));
  }
  assert.doesNotMatch(installer, /Name: "\{app\}\\\*"/u);
  assert.match(installer, /function IsManagedUpgradeRoot\(\): Boolean;/u);
  assert.match(installer, /function PrepareToInstall\(var NeedsRestart: Boolean\): String;/u);
  assert.match(installer, /CheckRuntimeIdle/u);
  assert.match(installer, /function InitializeUninstall\(\): Boolean;/u);
  assert.match(installer, /CloseApplications=no/u);
  assert.doesNotMatch(installer, /manager stop|\[UninstallRun\]|StopStarted|Sleep\(1000\)/u);
  assert.doesNotMatch(installer, /ERIC_TASK_MASTER_HOME|\\eric-task-master(?:\\|')/u);
});

test('Windows installer puts its launcher first in user PATH and removes only that entry on uninstall', async () => {
  const installer = await source('scripts/install/windows/installer.iss');
  const addUserPath = installer.slice(
    installer.indexOf('procedure AddUserPath'),
    installer.indexOf('procedure RemoveUserPath')
  );
  const removeUserPath = installer.slice(
    installer.indexOf('procedure RemoveUserPath'),
    installer.indexOf('procedure CurStepChanged')
  );

  assert.match(installer, /function RemovePathEntry\(Value, Wanted: string\): string;/u);
  assert.match(addUserPath, /Remaining := RemovePathEntry\(Current, Wanted\);/u);
  assert.match(addUserPath, /Updated := Wanted;/u);
  assert.match(addUserPath, /Updated := Updated \+ ';' \+ Remaining;/u);
  assert.match(addUserPath, /RegWriteExpandStringValue\([^;]+, Updated\);/su);
  assert.doesNotMatch(addUserPath, /Current \+ Wanted|Wanted \+ Current/u);
  assert.match(removeUserPath, /Updated := RemovePathEntry\(Current, Wanted\);/u);
  assert.match(removeUserPath, /RegWriteExpandStringValue\([^;]+, Updated\);/su);
});

test('macOS and Linux packages run fail-closed preinstall replacement scripts', async () => {
  const [macPackage, linuxPackage, macPreinstall, linuxPreinstall] = await Promise.all([
    source('scripts/build/package-macos.sh'),
    source('scripts/build/package-linux.sh'),
    source('scripts/install/macos/preinstall'),
    source('scripts/install/linux/preinst')
  ]);
  assert.match(macPackage, /--scripts "\$\{package_scripts\}"/u);
  assert.match(macPackage, /install\/macos[\s\S]*preinstall/u);
  assert.match(linuxPackage, /DEBIAN\/preinst/u);
  for (const preinstall of [macPreinstall, linuxPreinstall]) {
    assert.match(preinstall, /runtime_pids\(\)/u);
    assert.match(preinstall, /processes="\$\(ps[^\n]+\)" \|\| return 1/u);
    assert.doesNotMatch(preinstall, /kill -TERM|manager stop/u);
    assert.match(preinstall, /runtime is still in use/u);
    assert.match(preinstall, /rm -rf "\$\{app_root\}"/u);
    assert.doesNotMatch(preinstall, /ERIC_TASK_MASTER_HOME|XDG_DATA_HOME|\.local\/share|\/Users\/[^']+\/Library/u);
  }
});

test('Linux package removal refuses occupied runtime and failed process inspection', async () => {
  const [packager, guard] = await Promise.all([
    source('scripts/build/package-linux.sh'), source('scripts/install/linux/prerm')
  ]);
  assert.match(packager, /DEBIAN\/prerm/u);
  assert.match(guard, /processes="\$\(ps[^\n]+\)" \|\| exit 1/u);
  assert.match(guard, /runtime is still in use/u);
  assert.doesNotMatch(guard, /kill|rm -|manager stop/u);
});

test('Windows runtime guard rejects a real live process and permits its exit', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-installer-guard-'));
  const runtime = path.join(root, 'runtime');
  await mkdir(runtime);
  const node = path.join(runtime, 'node.exe');
  await copyFile(process.execPath, node);
  const guard = path.join(ROOT, 'src/lib/assert-runtime-idle.ps1');
  const check = () => execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', guard, '-AppRoot', root], { windowsHide: true, timeout: 20_000 });
  const child = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; await removeTestTree(root); });
  await assert.rejects(check(), (error) => {
    assert.equal(error.code, 10);
    assert.match(error.stderr, /runtime is still in use/u);
    return true;
  });
  assert.equal(child.exitCode, null, 'guard must never stop another Agent process');
  child.kill();
  await exited;
  await check();
});

test('native installer smoke tests simulate stale v2 payload while preserving external state', async () => {
  const [windows, mac, linux] = await Promise.all([
    source('scripts/install/smoke-windows.ps1'),
    source('scripts/install/smoke-macos.sh'),
    source('scripts/install/smoke-linux.sh')
  ]);
  for (const smoke of [windows, mac, linux]) {
    assert.match(smoke, /stale-v2-mcp/u);
    assert.match(smoke, /stale-v2-task-pack/u);
    assert.match(smoke, /upgrade-state-sentinel/u);
    assert.match(smoke, /preserve-user-state/u);
    assert.match(smoke, /nativeUpgrade/u);
    assert.match(smoke, /staleV2PayloadRemoved/u);
    assert.match(smoke, /userStatePreserved/u);
  }
  assert.ok(occurrences(windows, 'Start-Process -FilePath $installerPath') >= 2);
  assert.match(windows, /windows-installer-first-install\.log/u);
  assert.match(windows, /windows-installer-upgrade\.log/u);
  assert.ok(occurrences(mac, 'installer -pkg "${package}" -target /') >= 2);
  assert.ok(occurrences(linux, 'dpkg -i "${package}"') >= 2);
});
