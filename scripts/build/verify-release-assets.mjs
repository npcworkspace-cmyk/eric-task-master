#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, sha256File } from './lib.mjs';

async function inventory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) throw new Error(`Release assets must be regular files: ${directory}`);
  const names = entries.map((entry) => entry.name).sort();
  if (!names.includes('SHA256SUMS') || names.length < 2) throw new Error(`Missing release checksums or assets: ${directory}`);
  const hashes = new Map();
  for (const name of names) hashes.set(name, await sha256File(join(directory, name)));

  const checksumNames = new Set();
  const checksums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  for (const line of checksums.trimEnd().split('\n')) {
    const match = /^([0-9a-f]{64})  ([^/\\\r\n]+)$/u.exec(line);
    if (!match || match[2] === 'SHA256SUMS' || checksumNames.has(match[2])) {
      throw new Error(`Invalid or duplicate checksum entry in ${directory}`);
    }
    const [, hash, name] = match;
    checksumNames.add(name);
    if (hashes.get(name) !== hash) throw new Error(`Checksum mismatch: ${name} in ${directory}`);
  }
  if (checksumNames.size !== names.length - 1) throw new Error(`Incomplete release checksums: ${directory}`);
  return hashes;
}

export async function verifyReleaseAssets(expected, published) {
  const [original, released] = await Promise.all([inventory(expected), inventory(published)]);
  if (JSON.stringify([...original.keys()]) !== JSON.stringify([...released.keys()])) {
    throw new Error('Published asset names differ from the original tested release');
  }
  for (const [name, hash] of original) {
    if (released.get(name) !== hash) throw new Error(`Published asset bytes differ: ${name}`);
  }
  return { ok: true, assets: original.size, hashes: Object.fromEntries(original) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.expected || !args.published) throw new Error('--expected and --published are required');
  process.stdout.write(`${JSON.stringify(await verifyReleaseAssets(resolve(args.expected), resolve(args.published)))}\n`);
}
