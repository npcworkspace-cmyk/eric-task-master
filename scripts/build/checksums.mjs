#!/usr/bin/env node
import { readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs, sha256File } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const directory = resolve(args.dir || 'dist');
const output = resolve(args.output || join(directory, 'SHA256SUMS'));
const outputName = basename(output);
const entries = (await readdir(directory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== outputName)
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, 'en'));
if (entries.length === 0) throw new Error(`No release files found in ${directory}`);
const lines = [];
for (const entry of entries) lines.push(`${await sha256File(join(directory, entry))}  ${entry}`);
await writeFile(output, `${lines.join('\n')}\n`);
process.stdout.write(`${JSON.stringify({ ok: true, output, files: entries.length })}\n`);
