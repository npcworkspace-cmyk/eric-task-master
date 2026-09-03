#!/usr/bin/env node
import { stdin } from 'node:process';

const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function parse(value) {
  const match = pattern.exec(String(value));
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4] ? match[4].split('.') : []
  };
}

function compare(left, right) {
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumber = /^\d+$/u.test(a.prerelease[index]);
    const bNumber = /^\d+$/u.test(b.prerelease[index]);
    if (aNumber && bNumber) return Number(a.prerelease[index]) < Number(b.prerelease[index]) ? -1 : 1;
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

const candidate = process.argv[2];
parse(candidate);
let source = '';
stdin.setEncoding('utf8');
for await (const chunk of stdin) source += chunk;

const published = source
  .split(/\r?\n/u)
  .map((value) => value.trim().replace(/^v/u, ''))
  .filter(Boolean)
  .filter((value) => pattern.test(value));

for (const version of published) {
  if (compare(candidate, version) <= 0) {
    throw new Error(`Release version ${candidate} must be greater than published version ${version}`);
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, candidate, compared: published.length })}\n`);
