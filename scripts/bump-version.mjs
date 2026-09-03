#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function parse(value) {
  const match = semver.exec(String(value));
  if (!match) throw new Error(`Invalid stable semantic version: ${value}`);
  return match.slice(1).map(Number);
}

const packagePath = resolve(root, 'package.json');
const lockPath = resolve(root, 'package-lock.json');
const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
const current = packageJson.version;
const [major, minor, patch] = parse(current);
const requested = process.argv[2];
if (!requested) throw new Error('Usage: npm run version:bump -- <patch|minor|major|x.y.z>');

const next = requested === 'patch'
  ? `${major}.${minor}.${patch + 1}`
  : requested === 'minor'
    ? `${major}.${minor + 1}.0`
    : requested === 'major'
      ? `${major + 1}.0.0`
      : requested;
const nextParts = parse(next);
if (nextParts.every((part, index) => part === [major, minor, patch][index])) {
  throw new Error('The next version must differ from the current version');
}

packageJson.version = next;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
lock.version = next;
if (!lock.packages?.['']) throw new Error('package-lock.json is missing the root package record');
lock.packages[''].version = next;
await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

const contractsPath = resolve(root, 'src', 'contracts.mjs');
const contracts = await readFile(contractsPath, 'utf8');
const marker = `export const VERSION = '${current}';`;
if (!contracts.includes(marker)) throw new Error('src/contracts.mjs version does not match package.json');
await writeFile(contractsPath, contracts.replace(marker, `export const VERSION = '${next}';`));

for (const relative of ['README.md', 'README.zh-CN.md', 'docs/INSTALLERS.md']) {
  const file = resolve(root, relative);
  const source = await readFile(file, 'utf8');
  await writeFile(file, source.replaceAll(`v${current}`, `v${next}`));
}

process.stdout.write(`${JSON.stringify({ previous: current, version: next })}\n`);
