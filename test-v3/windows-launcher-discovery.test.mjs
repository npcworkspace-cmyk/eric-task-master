import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  Find-TaskMasterLauncher -DefaultRoot $scenario.defaultRoot -PortableRoot @($scenario.portableRoots) -ReadInstallations { $scenario.installations } -ReadCommands { @($scenario.commands) } -ReadManager { [pscustomobject]@{ state = $scenario.manager } }
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
    assert.equal(value.launcher, registered);
    assert.equal(value.nextAction, 'verify_existing_launcher');
    assert.equal(value.canFreshInstall, false);
  }
  await assert.rejects(access(path.join(registeredRoot, 'bin', 'unexpected-invocation')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(path.dirname(old), 'unexpected-invocation')), { code: 'ENOENT' });
  assert.equal(await readFile(canary, 'utf8'), 'retained-login-canary');
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
  assert.equal(found.launcher, portable);
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

test('loopback probing recognizes Task Master, preserves uncertainty, and distinguishes connection refusal', windowsOnly, async (t) => {
  let recognized = true;
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(recognized
      ? { ok: true, apiVersion: 3, pid: 123, stateId: 'state_fixture' }
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
