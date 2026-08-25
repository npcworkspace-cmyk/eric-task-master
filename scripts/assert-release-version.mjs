#!/usr/bin/env node
import { stdin } from 'node:process';
import { compareSemver, parseSemver } from '../src/lib/semver.mjs';

const candidate = process.argv[2];
parseSemver(candidate);

let source = '';
stdin.setEncoding('utf8');
for await (const chunk of stdin) source += chunk;

const published = source
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => value.startsWith('v') ? value.slice(1) : value)
  .filter((value) => {
    try {
      parseSemver(value);
      return true;
    } catch {
      return false;
    }
  });

for (const version of published) {
  if (compareSemver(candidate, version) <= 0) {
    throw new Error(`Release version ${candidate} must be greater than published version ${version}`);
  }
}

process.stdout.write(`${JSON.stringify({ ok: true, candidate, compared: published.length })}\n`);
