import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { removeTestTree } from './test-fs.mjs';

const execute = promisify(execFile);
const locator = fileURLToPath(new URL('../skills/eric-task-master/scripts/find-launcher.ps1', import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

async function powershell(source) {
  const encoded = Buffer.from(`. ${literal(locator)}\n${source}`, 'utf16le').toString('base64');
  const result = await execute('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], { windowsHide: true, timeout: 15_000 });
  return JSON.parse(result.stdout.trim());
}

async function discover(cases) {
  return powershell(`
$cases = ConvertFrom-Json ${literal(JSON.stringify(cases))}
$results = @($cases | ForEach-Object {
  $scenario = $_
  Find-TaskMasterLauncher -DefaultRoot $scenario.defaultRoot -PortableRoot @($scenario.portableRoots) -ReadSharedLocation {
    if ($scenario.sharedLocation) { $scenario.sharedLocation } else { [pscustomobject]@{ recorded = $false; unknown = $false } }
  } -ReadInstallations { $scenario.installations } -ReadCommands { @($scenario.commands) } -ReadManager {
    if ($scenario.manager -is [string]) { [pscustomobject]@{ state = $scenario.manager } }
    else { $scenario.manager }
  }
})
ConvertTo-Json -InputObject $results -Depth 4 -Compress
`);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'Task Master locator '));
  t.after(() => removeTestTree(root));
  return root;
}

function scenario(root, extra = {}) {
  return {
    defaultRoot: path.join(root, 'missing default'), portableRoots: [], commands: [], manager: 'absent',
    installations: { recorded: false, locations: [], unknown: false }, ...extra
  };
}

async function launcher(root) {
  const file = path.join(root, 'bin', 'taskmaster.cmd');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '@echo off\r\necho unexpected > "%~dp0unexpected-invocation"\r\nexit /b 99\r\n');
  return file;
}

test('registry finds a custom installation before stale PATH and never executes or modifies it', windowsOnly, async (t) => {
  const root = await fixture(t);
  const registeredRoot = path.join(root, 'Eric Task Master v3');
  const registered = await launcher(registeredRoot);
  const old = await launcher(path.join(root, 'old portable'));
  const canary = path.join(root, 'retained-profile-data');
  await writeFile(canary, 'retained-login-canary');
  const [result, missingPathResult] = await discover([
    scenario(root, { commands: [old], installations: { recorded: true, locations: [registeredRoot], unknown: false } }),
    scenario(root, { installations: { recorded: true, locations: [registeredRoot], unknown: false } })
  ]);
  for (const value of [result, missingPathResult]) {
    assert.equal(value.status, 'found');
    assert.equal(value.source, 'registry');
    // Windows can expand an 8.3 alias in an inherited temporary path.
    assert.ok(path.isAbsolute(value.launcher));
    assert.equal(await realpath(value.launcher), await realpath(registered));
    assert.equal(value.nextAction, 'verify_existing_launcher');
    assert.equal(value.canFreshInstall, false);
  }
  await assert.rejects(access(path.join(registeredRoot, 'bin', 'unexpected-invocation')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(path.dirname(old), 'unexpected-invocation')), { code: 'ENOENT' });
  assert.equal(await readFile(canary, 'utf8'), 'retained-login-canary');
});

test('a selected shared launcher survives stopped Manager and absent host registration without falling back to stale PATH', windowsOnly, async (t) => {
  const root = await fixture(t);
  const selected = await launcher(path.join(root, 'selected application'));
  const old = await launcher(path.join(root, 'stale application'));
  const [result, damaged, missing] = await discover([
    scenario(root, { commands: [old], sharedLocation: { recorded: true, unknown: false, launcher: selected } }),
    scenario(root, { commands: [old], sharedLocation: { recorded: true, unknown: true } }),
    scenario(root, { commands: [old], sharedLocation: { recorded: true, unknown: false, launcher: path.join(root, 'missing.cmd') } })
  ]);
  assert.equal(result.launcher, selected);
  assert.equal(result.source, 'shared-location');
  for (const rejected of [damaged, missing]) {
    assert.equal(rejected.status, 'unresolved');
    assert.equal(rejected.canFreshInstall, false);
    assert.equal(rejected.launcher, null);
  }
});

test('shared locator port is used for live Manager discovery instead of assuming 19946', windowsOnly, async (t) => {
  const root = await fixture(t);
  const current = await launcher(path.join(root, 'custom port application'));
  const result = await powershell(`
Find-TaskMasterLauncher -DefaultRoot ${literal(path.join(root, 'absent'))} -ReadSharedLocation {
  [pscustomobject]@{ recorded = $true; unknown = $false; port = 24321 }
} -ReadManager {
  param([int]$Port)
  if ($Port -ne 24321) { throw 'The selected shared port was ignored' }
  [pscustomobject]@{ state = 'present'; launcher = ${literal(current)} }
} | ConvertTo-Json -Compress
`);
  assert.equal(result.status, 'found');
  assert.equal(result.source, 'running-manager');
  assert.equal(result.launcher, current);
});

test('running Manager wins over stale PATH, missing registration, and an older registered installation', windowsOnly, async (t) => {
  const root = await fixture(t);
  const current = await launcher(path.join(root, 'running installation'));
  const oldRoot = path.join(root, 'older installation');
  const old = await launcher(oldRoot);
  const manager = { state: 'present', launcher: current, pid: 123, version: '3.1.7' };
  const results = await discover([
    scenario(root, { manager, commands: [old], defaultRoot: oldRoot }),
    scenario(root, { manager, commands: [old], installations: { recorded: true, locations: [oldRoot], unknown: false } })
  ]);
  for (const result of results) {
    assert.equal(result.status, 'found');
    assert.equal(result.source, 'running-manager');
    assert.equal(await realpath(result.launcher), await realpath(current));
    assert.equal(result.canFreshInstall, false);
  }
  for (const file of [current, old]) {
    await assert.rejects(access(path.join(path.dirname(file), 'unexpected-invocation')), { code: 'ENOENT' });
  }
});

test('an unlocatable running Manager never falls back to an older launcher', windowsOnly, async (t) => {
  const root = await fixture(t);
  const oldRoot = path.join(root, 'older installation');
  const old = await launcher(oldRoot);
  const results = await discover([
    scenario(root, { manager: { state: 'present', launcher: null }, commands: [old] }),
    scenario(root, { manager: { state: 'present', launcher: path.join(root, 'missing.cmd') },
      installations: { recorded: true, locations: [oldRoot], unknown: false } })
  ]);
  for (const result of results) {
    assert.equal(result.status, 'unresolved');
    assert.equal(result.canFreshInstall, false);
    assert.equal(result.managerState, 'present');
  }
});

test('missing launchers with installation evidence or uncertain discovery never authorize a fresh install', windowsOnly, async (t) => {
  const root = await fixture(t);
  const incomplete = path.join(root, 'incomplete application');
  await mkdir(incomplete);
  const results = await discover([
    scenario(root, { installations: { recorded: true, locations: [path.join(root, 'removed application')], unknown: false } }),
    scenario(root, { installations: { recorded: false, locations: [], unknown: true } }),
    scenario(root, { defaultRoot: incomplete }),
    scenario(root, { manager: 'present' }),
    scenario(root, { manager: 'unknown' })
  ]);
  for (const result of results) {
    assert.equal(result.status, 'unresolved');
    assert.equal(result.canFreshInstall, false);
    assert.equal(result.nextAction, 'report_locator_error');
  }
});

test('confirmed absence and a known nested portable extraction remain distinct', windowsOnly, async (t) => {
  const root = await fixture(t);
  const extraction = path.join(root, 'known extraction');
  const portable = await launcher(path.join(extraction, 'eric-task-master'));
  const [absent, found] = await discover([
    scenario(root), scenario(root, { portableRoots: [extraction] })
  ]);
  assert.equal(absent.status, 'absent');
  assert.equal(absent.canFreshInstall, true);
  assert.equal(absent.nextAction, 'fresh_install_if_requested');
  assert.equal(found.status, 'found');
  assert.ok(path.isAbsolute(found.launcher));
  assert.equal(await realpath(found.launcher), await realpath(portable));
  assert.equal(found.canFreshInstall, false);
});

test('registry discovery queries both exact uninstall records and keeps access failures uncertain', windowsOnly, async (t) => {
  const root = await fixture(t);
  const registeredRoot = path.join(root, 'registered application');
  const result = await powershell(`
$script:queried = @()
function Test-Path {
  param($LiteralPath)
  $script:queried += $LiteralPath
  if ($LiteralPath.StartsWith('HKLM:')) { throw 'Fixture registry access denied' }
  return $true
}
function Get-ItemProperty { [pscustomobject]@{ InstallLocation = ${literal(registeredRoot)} } }
$result = Get-TaskMasterInstallations
[pscustomobject]@{ discovery = $result; queried = $script:queried } | ConvertTo-Json -Depth 4 -Compress
`);
  assert.equal(result.discovery.recorded, true);
  assert.equal(result.discovery.unknown, true);
  assert.deepEqual(result.discovery.locations, [registeredRoot]);
  assert.deepEqual(result.queried, ['HKCU', 'HKLM'].map((hive) =>
    `${hive}:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{2DE24E8C-971F-4E00-9E32-9F66822B9CB7}_is1`));
});

test('failed or timed-out loopback queries do not confirm Manager absence', windowsOnly, async () => {
  const result = await powershell(`
$results = @('ConnectFailure', 'Timeout', 'ProtocolError' | ForEach-Object {
  $failureStatus = [System.Net.WebExceptionStatus]::$_
  function Invoke-RestMethod { throw [System.Net.WebException]::new('Fixture query failure', $failureStatus) }
  Get-TaskMasterManager
})
ConvertTo-Json -InputObject $results -Compress
`);
  assert.deepEqual(result.map((entry) => entry.state), ['unknown', 'unknown', 'unknown']);
});

test('live Manager discovery verifies its embedded runtime and package version without executing it', windowsOnly, async (t) => {
  const root = await fixture(t);
  const application = path.join(root, 'verified running application');
  const current = await launcher(application);
  const executable = path.join(application, 'runtime', 'node.exe');
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.join(application, 'app'), { recursive: true });
  await writeFile(executable, 'fixture runtime must not be executed');
  await writeFile(path.join(application, 'app', 'package.json'), JSON.stringify({ name: 'eric-task-master', version: '3.1.7' }));
  const result = await powershell(`
function Invoke-RestMethod { [pscustomobject]@{ ok = $true; service = 'eric-task-master'; apiVersion = 3; pid = 123; version = '3.1.7'; stateId = 'state_fixture' } }
function Get-CimInstance { [pscustomobject]@{ ExecutablePath = ${literal(executable)} } }
$verified = Get-TaskMasterManager
$script:fixtureVersion = 'older-version'
function Invoke-RestMethod { [pscustomobject]@{ ok = $true; service = 'eric-task-master'; apiVersion = 3; pid = 123; version = $script:fixtureVersion; stateId = 'state_fixture' } }
$wrongVersion = Get-TaskMasterManager
function Get-CimInstance { throw 'Fixture process query denied' }
$unreadableProcess = Get-TaskMasterManager
ConvertTo-Json -InputObject @($verified, $wrongVersion, $unreadableProcess) -Depth 4 -Compress
`);
  assert.equal(result[0].state, 'present');
  assert.equal(await realpath(result[0].launcher), await realpath(current));
  for (const entry of result.slice(1)) {
    assert.equal(entry.state, 'present');
    assert.equal(entry.launcher, null);
  }
  await assert.rejects(access(path.join(path.dirname(current), 'unexpected-invocation')), { code: 'ENOENT' });
  assert.equal(await readFile(executable, 'utf8'), 'fixture runtime must not be executed');
});

test('unrelated health and invalid process identifiers cannot select a launcher', windowsOnly, async () => {
  const results = await powershell(`
function Get-CimInstance { throw 'Must not query unrecognized process' }
$results = @(@(
  [pscustomobject]@{ service = 'other-service'; pid = 123 },
  [pscustomobject]@{ service = 'eric-task-master'; pid = '123 OR 1=1' }
) | ForEach-Object {
  $script:fixtureHealth = $_
  function Invoke-RestMethod { [pscustomobject]@{ ok = $true; service = $script:fixtureHealth.service; apiVersion = 3; pid = $script:fixtureHealth.pid; stateId = 'state_fixture' } }
  Get-TaskMasterManager
})
ConvertTo-Json -InputObject $results -Compress
`);
  assert.deepEqual(results.map((entry) => entry.state), ['unknown', 'unknown']);
});

test('loopback probing recognizes Task Master, preserves uncertainty, and distinguishes connection refusal', windowsOnly, async (t) => {
  let recognized = true;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(recognized
      ? { ok: true, service: 'eric-task-master', version: '3.1.7', apiVersion: 3, pid: 123, stateId: 'state_fixture' }
      : { ok: true, unrelated: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); });
  const port = server.address().port;
  assert.equal((await powershell(`Get-TaskMasterManager -Port ${port} | ConvertTo-Json -Compress`)).state, 'present');
  recognized = false;
  assert.equal((await powershell(`Get-TaskMasterManager -Port ${port} | ConvertTo-Json -Compress`)).state, 'unknown');
  await new Promise((resolve) => server.close(resolve));
  assert.equal((await powershell(`Get-TaskMasterManager -Port ${port} | ConvertTo-Json -Compress`)).state, 'absent');
});
