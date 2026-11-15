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

const lock = JSON.parse(await readFile(lockPath, 'utf8'));
if (!lock.packages?.['']) throw new Error('package-lock.json is missing the root package record');
if (lock.version !== current || lock.packages[''].version !== current) {
  throw new Error('package-lock.json version does not match package.json');
}

const contractsPath = resolve(root, 'src', 'contracts.mjs');
const contracts = await readFile(contractsPath, 'utf8');
const marker = `export const VERSION = '${current}';`;
if (!contracts.includes(marker)) throw new Error('src/contracts.mjs version does not match package.json');

const pending = [[contractsPath, contracts.replace(marker, `export const VERSION = '${next}';`)]];
for (const [relative, before, after] of [
  ['dashboard/dashboard.js', `const DASHBOARD_RUNTIME_VERSION = '${current}';`, `const DASHBOARD_RUNTIME_VERSION = '${next}';`],
  ['dashboard/index.html', `/dashboard/dashboard.js?v=${current}`, `/dashboard/dashboard.js?v=${next}`]
]) {
  const file = resolve(root, relative);
  const source = await readFile(file, 'utf8');
  if (!source.includes(before)) throw new Error(`${relative} version does not match package.json`);
  pending.push([file, source.replace(before, after)]);
}

for (const relative of ['README.md', 'README.zh-CN.md', 'docs/INSTALLERS.md']) {
  const file = resolve(root, relative);
  const source = await readFile(file, 'utf8');
  pending.push([file, source.replaceAll(current, next)]);
}

const skillPath = resolve(root, 'skills', 'eric-task-master', 'SKILL.md');
const skill = await readFile(skillPath, 'utf8');
if (!skill.includes(`version: "${current}"`) || !skill.includes(`ERIC_TASK_MASTER_AGENT_SKILL_VERSION=${current}`)) {
  throw new Error('Driving Skill metadata or Agent acknowledgement version does not match package.json');
}
pending.push([skillPath, skill.replaceAll(current, next)]);

// Check every required version marker before changing any files. This avoids
// leaving a half-bumped tree when a newly added component is out of sync.
packageJson.version = next;
lock.version = next;
lock.packages[''].version = next;
pending.unshift([packagePath, `${JSON.stringify(packageJson, null, 2)}\n`], [lockPath, `${JSON.stringify(lock, null, 2)}\n`]);
for (const [file, content] of pending) await writeFile(file, content);

process.stdout.write(`${JSON.stringify({ previous: current, version: next })}\n`);
