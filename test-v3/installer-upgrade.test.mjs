import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function source(relative) {
  return readFile(path.join(ROOT, ...relative.split('/')), 'utf8');
}

function occurrences(value, fragment) {
  return value.split(fragment).length - 1;
}

test('Windows upgrade stops the managed installation and replaces only managed application payload', async () => {
  const installer = await source('scripts/install/windows/installer.iss');
  for (const payload of ['app', 'bin', 'runtime']) {
    assert.match(installer, new RegExp(`Name: "\\{app\\}\\\\${payload}"; Check: IsManagedUpgradeRoot`, 'u'));
  }
  assert.doesNotMatch(installer, /Name: "\{app\}\\\*"/u);
  assert.match(installer, /function IsManagedUpgradeRoot\(\): Boolean;/u);
  assert.match(installer, /function PrepareToInstall\(var NeedsRestart: Boolean\): String;/u);
  assert.match(installer, /taskmaster\.cmd/u);
  assert.match(installer, /manager stop --json/u);
  assert.match(installer, /StopStarted := Exec\(/u);
  assert.match(installer, /ExpandConstant\('\{cmd\}'\)/u);
  assert.doesNotMatch(installer, /StopStarted := ShellExec\(/u);
  assert.match(installer, /waituntilterminated/u);
  assert.match(installer, /previous Eric Task Master Manager could not be stopped safely/u);
  assert.doesNotMatch(installer, /ERIC_TASK_MASTER_HOME|\\eric-task-master(?:\\|')/u);
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
    assert.match(preinstall, /manager_pids\(\)/u);
    assert.match(preinstall, /kill -TERM/u);
    assert.match(preinstall, /previous Manager did not exit cleanly/u);
    assert.match(preinstall, /rm -rf "\$\{app_root\}"/u);
    assert.doesNotMatch(preinstall, /ERIC_TASK_MASTER_HOME|XDG_DATA_HOME|\.local\/share|\/Users\/[^']+\/Library/u);
  }
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
