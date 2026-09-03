#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, exists, readJson } from './lib.mjs';

const expectedTargets = ['linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64'];
const lock = await readJson(join(ROOT, 'scripts', 'build', 'runtime-lock.json'));
const actualTargets = Object.keys(lock.targets || {}).sort();
if (JSON.stringify(actualTargets) !== JSON.stringify(expectedTargets)) {
  throw new Error(`Distribution targets differ: ${actualTargets.join(', ')}`);
}
if (!/^22\.\d+\.\d+$/u.test(lock.nodeVersion)) throw new Error('Bundled Node must be an exact Node 22 LTS version');
for (const [target, spec] of Object.entries(lock.targets)) {
  if (!/^[a-f0-9]{64}$/u.test(spec.sha256)) throw new Error(`${target} lacks a pinned Node SHA-256`);
  if (!spec.archive.includes(lock.nodeVersion)) throw new Error(`${target} archive does not match Node ${lock.nodeVersion}`);
}

const required = [
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  'docs/INSTALLERS.md',
  'scripts/build/build-bundle.mjs',
  'scripts/build/fixtures/bare-playwright-task.mjs',
  'scripts/build/stage-runtime.mjs',
  'scripts/build/verify-bundle.mjs',
  'scripts/build/package-windows.ps1',
  'scripts/build/package-macos.sh',
  'scripts/build/package-linux.sh',
  'scripts/install/windows/installer.iss',
  'scripts/install/macos/preinstall',
  'scripts/install/linux/preinst'
];
for (const entry of required) {
  if (!(await exists(join(ROOT, ...entry.split('/'))))) throw new Error(`Missing distribution file: ${entry}`);
}

const packageJson = await readJson(join(ROOT, 'package.json'));
if (Object.keys(packageJson.dependencies || {}).some((name) => name.includes('modelcontextprotocol'))) {
  throw new Error('MCP dependencies cannot enter the CLI-only distribution');
}
if (!packageJson.dependencies?.playwright) throw new Error('Playwright must be a pinned production dependency');
if (/^[~^*]|\bx\b/iu.test(packageJson.dependencies.playwright)) {
  throw new Error('Playwright must use an exact version');
}

const [stage, verifier, smokeTask, windowsSmoke, macSmoke, linuxSmoke, windowsPackager, macPackager, linuxPackager, collector, ci, release] = await Promise.all([
  readFile(join(ROOT, 'scripts', 'build', 'stage-runtime.mjs'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'build', 'verify-bundle.mjs'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'build', 'fixtures', 'bare-playwright-task.mjs'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'install', 'smoke-windows.ps1'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'install', 'smoke-macos.sh'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'install', 'smoke-linux.sh'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'build', 'package-windows.ps1'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'build', 'package-macos.sh'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'build', 'package-linux.sh'), 'utf8'),
  readFile(join(ROOT, 'scripts', 'build', 'collect-release-assets.mjs'), 'utf8'),
  readFile(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
  readFile(join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
]);
for (const [source, fragments] of [
  [windowsPackager, ['windows-x64-portable.zip', 'windows-x64-setup.exe']],
  [macPackager, ['-${target}.pkg', '--scripts "${package_scripts}"', 'install/macos']],
  [linuxPackager, ['-${target}.deb', '-${target}-portable.tar.gz', 'DEBIAN/preinst', 'install/linux']],
  [collector, ['windows-x64-portable.zip', 'windows-x64-setup.exe', 'macos-arm64.pkg', 'macos-x64.pkg', 'linux-x64.deb', 'linux-arm64.deb']],
  [ci, ['name: release-${{ matrix.target }}']],
  [release, ["--pattern 'release-*'", '--sha "${RELEASE_SHA}"']],
  [stage, ['set "NODE_OPTIONS="', 'set "NODE_PATH="', 'unset NODE_OPTIONS NODE_PATH']],
  [verifier, ['__eric_task_master_host_injection_must_not_load__', 'hostNodeInjectionIsolated: true']],
  [smokeTask, ['process.env.NODE_OPTIONS || process.env.NODE_PATH', 'hostNodeInjectionIsolated: true']],
  [windowsSmoke, ['__eric_task_master_host_injection_must_not_load__', 'hostNodeInjectionIsolated = $true', 'nativeUpgrade = \'passed\'']],
  [macSmoke, ['__eric_task_master_host_injection_must_not_load__', 'hostNodeInjectionIsolated":true', '"nativeUpgrade":"passed"']],
  [linuxSmoke, ['__eric_task_master_host_injection_must_not_load__', 'hostNodeInjectionIsolated":true', '"nativeUpgrade":"passed"']]
]) {
  for (const fragment of fragments) {
    if (!source.includes(fragment)) throw new Error(`Release asset contract lacks ${fragment}`);
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, node: lock.nodeVersion, targets: actualTargets })}\n`);
