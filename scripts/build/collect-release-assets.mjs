#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { listFiles, parseArgs } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.input || 'downloaded');
const output = resolve(args.output || 'dist');
const version = args.version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version || '')) throw new Error('A semantic --version is required');
const releaseSha = args.sha;
if (!/^[a-f0-9]{40}$/u.test(releaseSha || '')) throw new Error('An exact lowercase --sha is required');

const expected = [
  `eric-task-master-v${version}-windows-x64-portable.zip`,
  `eric-task-master-v${version}-windows-x64-setup.exe`,
  `eric-task-master-v${version}-macos-arm64.pkg`,
  `eric-task-master-v${version}-macos-x64.pkg`,
  `eric-task-master-v${version}-linux-x64.deb`,
  `eric-task-master-v${version}-linux-x64-portable.tar.gz`,
  `eric-task-master-v${version}-linux-arm64.deb`,
  `eric-task-master-v${version}-linux-arm64-portable.tar.gz`
];
const expectedTargets = ['linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64'];
const expectedMetadata = expectedTargets.flatMap((target) => [
  `eric-task-master-v${version}-${target}.manifest.json`,
  `eric-task-master-v${version}-${target}.spdx.json`
]);
const files = await listFiles(input);
const byName = new Map();
for (const relative of files) {
  const name = basename(relative);
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push(join(input, ...relative.split('/')));
}
for (const name of [...expected, ...expectedMetadata]) {
  const matches = byName.get(name) || [];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name}; found ${matches.length}`);
}

const targets = new Set();
for (const target of expectedTargets) {
  const name = `eric-task-master-v${version}-${target}.manifest.json`;
  const manifest = JSON.parse(await readFile(byName.get(name)[0], 'utf8'));
  if (manifest.version !== version) throw new Error(`Manifest version mismatch in ${name}`);
  if (manifest.target !== target) throw new Error(`Manifest target mismatch in ${name}`);
  if (manifest.gitSha !== releaseSha) throw new Error(`Manifest source SHA mismatch in ${name}`);
  if (manifest.signature?.signed !== false) throw new Error(`Unsigned release manifest is inconsistent in ${name}`);
  if (manifest.browser?.bundled !== false || manifest.browser?.requiredChannel !== 'chrome') {
    throw new Error(`Browser boundary mismatch in ${name}`);
  }
  const sbomName = `eric-task-master-v${version}-${target}.spdx.json`;
  const sbom = JSON.parse(await readFile(byName.get(sbomName)[0], 'utf8'));
  const rootPackage = sbom.packages?.find((item) => item.SPDXID === 'SPDXRef-Package-eric-task-master');
  const nodePackage = sbom.packages?.find((item) => item.SPDXID === 'SPDXRef-Package-node');
  if (sbom.spdxVersion !== 'SPDX-2.3' || rootPackage?.versionInfo !== version || !nodePackage?.versionInfo) {
    throw new Error(`SPDX inventory mismatch in ${sbomName}`);
  }
  targets.add(manifest.target);
}
if (JSON.stringify([...targets].sort()) !== JSON.stringify(expectedTargets)) {
  throw new Error(`Target manifests are incomplete: ${[...targets].sort().join(', ')}`);
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of [...expected, ...expectedMetadata]) {
  await copyFile(byName.get(name)[0], join(output, name));
}
await writeFile(join(output, 'UNSIGNED-BUILD.txt'), [
  `Eric Task Master v${version}`,
  '',
  'Windows and macOS artifacts are not code-signed; Linux packages are not repository-signed.',
  'The repository did not have Authenticode or Apple Developer ID credentials when this release was built.',
  'Verify every download against SHA256SUMS. CI is not a platform signature.',
  'CI validates installation, bundled Node, a bare Playwright task, stable Chrome launch, Manager lifecycle, and uninstall.',
  ''
].join('\n'));
process.stdout.write(`${JSON.stringify({
  ok: true,
  version,
  releaseSha,
  targets: expectedTargets,
  assets: expected.length + expectedMetadata.length + 1
})}\n`);
