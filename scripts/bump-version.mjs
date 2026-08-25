#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextVersion } from '../src/lib/semver.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packagePath = resolve(root, 'package.json');
const lockPath = resolve(root, 'package-lock.json');
const skillRuntimePath = resolve(root, 'skills', 'eric-task-master', 'runtime.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const current = packageJson.version;
const requested = process.argv[2];

if (!requested) {
  throw new Error('Usage: npm run version:bump -- <patch|minor|major|x.y.z>');
}

const next = nextVersion(current, requested);
const skillRuntime = JSON.parse(await readFile(skillRuntimePath, 'utf8'));
if (skillRuntime.runtimeName !== packageJson.name || skillRuntime.runtimeVersion !== current) {
  throw new Error('Skill runtime contract does not match the current package version');
}
packageJson.version = next;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
lock.version = next;
if (!lock.packages?.['']) {
  throw new Error('package-lock.json is missing the root package record');
}
lock.packages[''].version = next;
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

skillRuntime.runtimeVersion = next;
skillRuntime.releaseTag = `v${next}`;
await writeFile(skillRuntimePath, `${JSON.stringify(skillRuntime, null, 2)}\n`);

const replacements = [
  ['src/contracts.mjs', `export const VERSION = '${current}';`, `export const VERSION = '${next}';`],
  ['README.md', `Version: **${current}**`, `Version: **${next}**`],
  ['README.zh-CN.md', `版本：**${current}**`, `版本：**${next}**`]
];

for (const [relative, from, to] of replacements) {
  const file = resolve(root, relative);
  const source = await readFile(file, 'utf8');
  if (!source.includes(from)) throw new Error(`${relative} does not contain ${from}`);
  await writeFile(file, source.replace(from, to));
}

process.stdout.write(JSON.stringify({ previous: current, version: next }) + '\n');
