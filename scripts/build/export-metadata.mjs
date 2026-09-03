#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, readJson } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const bundle = resolve(args.bundle || '');
const output = resolve(args.out || '');
const manifest = await readJson(join(bundle, 'release-manifest.json'));
const prefix = `eric-task-master-v${manifest.version}-${manifest.target}`;
await mkdir(output, { recursive: true });
const assets = [
  [join(bundle, 'release-manifest.json'), join(output, `${prefix}.manifest.json`)],
  [join(bundle, 'sbom.spdx.json'), join(output, `${prefix}.spdx.json`)]
];
for (const [source, destination] of assets) await copyFile(source, destination);
process.stdout.write(`${JSON.stringify({ ok: true, target: manifest.target, assets: assets.map(([, path]) => path) })}\n`);
