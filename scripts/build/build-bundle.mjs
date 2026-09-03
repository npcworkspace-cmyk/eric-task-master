#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { ROOT, parseArgs, run } from './lib.mjs';

const targetByHost = new Map([
  ['win32/x64', 'windows-x64'],
  ['darwin/arm64', 'macos-arm64'],
  ['darwin/x64', 'macos-x64'],
  ['linux/arm64', 'linux-arm64'],
  ['linux/x64', 'linux-x64']
]);

const args = parseArgs(process.argv.slice(2));
const detectedTarget = targetByHost.get(`${process.platform}/${process.arch}`);
const target = args.target || detectedTarget;
if (!target) throw new Error(`No distribution target for ${process.platform}/${process.arch}`);
if (target !== detectedTarget) {
  throw new Error(`Target ${target} must be built on its native host; current target is ${detectedTarget || 'unsupported'}`);
}

const stageRoot = resolve(args.stage || join(ROOT, 'dist', 'stage', target));
const outputRoot = resolve(args.out || join(ROOT, 'dist', 'release'));
const bundleRoot = join(stageRoot, 'eric-task-master');

await run(process.execPath, [
  join(ROOT, 'scripts', 'build', 'stage-runtime.mjs'),
  '--target', target,
  '--out', stageRoot
]);
await run(process.execPath, [
  join(ROOT, 'scripts', 'build', 'verify-bundle.mjs'),
  '--bundle', bundleRoot
]);

if (process.platform === 'win32') {
  await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', join(ROOT, 'scripts', 'build', 'package-windows.ps1'),
    '-StageRoot', stageRoot,
    '-OutputDir', outputRoot
  ]);
} else {
  const packager = process.platform === 'darwin' ? 'package-macos.sh' : 'package-linux.sh';
  await run('bash', [join(ROOT, 'scripts', 'build', packager), stageRoot, outputRoot]);
}
await run(process.execPath, [
  join(ROOT, 'scripts', 'build', 'export-metadata.mjs'),
  '--bundle', bundleRoot,
  '--out', outputRoot
]);
await run(process.execPath, [
  join(ROOT, 'scripts', 'build', 'checksums.mjs'),
  '--dir', outputRoot,
  '--output', join(outputRoot, `SHA256SUMS-${target}`)
]);

process.stdout.write(`${JSON.stringify({ ok: true, target, stageRoot, outputRoot })}\n`);
