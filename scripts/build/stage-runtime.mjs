#!/usr/bin/env node
import { chmod, copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ROOT,
  copyApplication,
  download,
  ensureEmpty,
  exists,
  hashTree,
  parseArgs,
  readJson,
  run,
  sha256File,
  writeJson
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const target = args.target;
const outputRoot = resolve(args.out || join(ROOT, 'dist', 'stage', target || 'unknown'));
const lock = await readJson(join(ROOT, 'scripts', 'build', 'runtime-lock.json'));
const spec = lock.targets[target];
if (!spec) throw new Error(`Unsupported target: ${String(target)}`);
if (process.platform !== spec.platform || process.arch !== spec.arch) {
  throw new Error(`Target ${target} must be staged on ${spec.platform}/${spec.arch}; current host is ${process.platform}/${process.arch}`);
}

const packageJson = await readJson(join(ROOT, 'package.json'));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
  throw new Error(`Invalid package version: ${String(packageJson.version)}`);
}

await ensureEmpty(outputRoot);
const workRoot = join(outputRoot, '.work');
const extractRoot = join(workRoot, 'node');
const archivePath = join(workRoot, spec.archive);
const bundleRoot = join(outputRoot, 'eric-task-master');
const appRoot = join(bundleRoot, 'app');
await mkdir(extractRoot, { recursive: true });

await download(`https://nodejs.org/dist/v${lock.nodeVersion}/${spec.archive}`, archivePath);
const actualArchiveHash = await sha256File(archivePath);
if (actualArchiveHash !== spec.sha256) {
  throw new Error(`Node runtime checksum mismatch for ${spec.archive}`);
}

const tarArgs = spec.archive.endsWith('.tar.gz')
  ? ['-xzf', archivePath, '-C', extractRoot]
  : spec.archive.endsWith('.tar.xz')
    ? ['-xJf', archivePath, '-C', extractRoot]
    : ['-xf', archivePath, '-C', extractRoot];
await run('tar', tarArgs);
const extractedEntries = (await readdir(extractRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
if (extractedEntries.length !== 1) throw new Error('Node archive must contain one root directory');
const nodeSourceRoot = join(extractRoot, extractedEntries[0].name);

await mkdir(join(bundleRoot, 'runtime'), { recursive: true });
const bundledNode = join(bundleRoot, 'runtime', spec.platform === 'win32' ? 'node.exe' : 'node');
await copyFile(join(nodeSourceRoot, ...spec.nodeBinary.split('/')), bundledNode);
if (spec.platform !== 'win32') await chmod(bundledNode, 0o755);
await copyFile(join(nodeSourceRoot, 'LICENSE'), join(bundleRoot, 'runtime', 'NODE-LICENSE'));

await copyApplication(ROOT, appRoot);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
await run(npmCommand, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: appRoot,
  shell: process.platform === 'win32',
  env: {
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    npm_config_cache: join(workRoot, 'npm-cache'),
    npm_config_update_notifier: 'false'
  }
});

const forbiddenBrowserPaths = [
  join(appRoot, 'node_modules', 'playwright-core', '.local-browsers'),
  join(appRoot, 'node_modules', 'playwright', '.local-browsers'),
  join(bundleRoot, 'ms-playwright')
];
for (const path of forbiddenBrowserPaths) {
  if (await exists(path)) throw new Error(`Bundled browser payload is forbidden: ${path}`);
}

await mkdir(join(bundleRoot, 'bin'), { recursive: true });
if (spec.platform === 'win32') {
  await writeFile(
    join(bundleRoot, 'bin', 'taskmaster.cmd'),
    '@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\src\\cli.mjs" %*\r\n'
  );
} else {
  const launcher = `#!/bin/sh
set -eu
unset NODE_OPTIONS NODE_PATH
SOURCE="$0"
while [ -h "$SOURCE" ]; do
  DIR="$(CDPATH= cd -P -- "$(dirname -- "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  case "$SOURCE" in /*) ;; *) SOURCE="$DIR/$SOURCE" ;; esac
done
ROOT_DIR="$(CDPATH= cd -P -- "$(dirname -- "$SOURCE")/.." && pwd)"
exec "$ROOT_DIR/runtime/node" "$ROOT_DIR/app/src/cli.mjs" "$@"
`;
  const launcherPath = join(bundleRoot, 'bin', 'taskmaster');
  await writeFile(launcherPath, launcher);
  await chmod(launcherPath, 0o755);
}

const lockPackages = (await readJson(join(appRoot, 'package-lock.json'))).packages || {};
const productionPackages = Object.entries(lockPackages)
  .filter(([path, value]) => path && path.startsWith('node_modules/') && value?.dev !== true)
  .map(([path, value]) => ({
    name: path.slice('node_modules/'.length),
    version: value.version,
    license: value.license || 'NOASSERTION'
  }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));
const notices = [
  'Eric Task Master third-party runtime notices',
  '',
  `Node.js ${lock.nodeVersion} — see runtime/NODE-LICENSE`,
  ...productionPackages.map((item) => `${item.name} ${item.version} — ${item.license}`),
  '',
  'Complete package license files remain inside app/node_modules.'
].join('\n');
await writeFile(join(bundleRoot, 'THIRD_PARTY_NOTICES.txt'), `${notices}\n`);

const documentNamespace = `https://github.com/npcworkspace-cmyk/eric-task-master/releases/v${packageJson.version}/${target}`;
await writeJson(join(bundleRoot, 'sbom.spdx.json'), {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `eric-task-master-${packageJson.version}-${target}`,
  documentNamespace,
  creationInfo: {
    created: process.env.SOURCE_DATE_ISO || new Date(0).toISOString(),
    creators: ['Tool: eric-task-master-stage-runtime']
  },
  packages: [
    {
      SPDXID: 'SPDXRef-Package-eric-task-master',
      name: packageJson.name,
      versionInfo: packageJson.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: packageJson.license || 'NOASSERTION'
    },
    {
      SPDXID: 'SPDXRef-Package-node',
      name: 'node',
      versionInfo: lock.nodeVersion,
      downloadLocation: `https://nodejs.org/dist/v${lock.nodeVersion}/${spec.archive}`,
      filesAnalyzed: false,
      licenseConcluded: 'MIT',
      licenseDeclared: 'MIT',
      checksums: [{ algorithm: 'SHA256', checksumValue: spec.sha256 }]
    },
    ...productionPackages.map((item, index) => ({
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: item.name,
      versionInfo: item.version,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      licenseDeclared: item.license
    }))
  ],
  relationships: [
    {
      spdxElementId: 'SPDXRef-Package-eric-task-master',
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: 'SPDXRef-Package-node'
    },
    ...productionPackages.map((_, index) => ({
      spdxElementId: 'SPDXRef-Package-eric-task-master',
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: `SPDXRef-Package-${index + 1}`
    }))
  ]
});

await rm(workRoot, { recursive: true, force: true });
const tree = await hashTree(bundleRoot, { exclude: ['release-manifest.json'] });
await writeJson(join(bundleRoot, 'release-manifest.json'), {
  schemaVersion: 1,
  product: packageJson.name,
  version: packageJson.version,
  target,
  platform: spec.platform,
  arch: spec.arch,
  gitSha: process.env.GITHUB_SHA || process.env.RELEASE_SHA || 'local',
  node: {
    version: lock.nodeVersion,
    archive: basename(spec.archive),
    sha256: spec.sha256
  },
  browser: {
    bundled: false,
    requiredChannel: 'chrome',
    note: 'Google Chrome is discovered on the target machine and is not redistributed.'
  },
  signature: {
    signed: false,
    note: 'No Apple Developer ID or Windows Authenticode secrets are configured.'
  },
  tree
});

process.stdout.write(`${JSON.stringify({ ok: true, target, version: packageJson.version, bundleRoot, tree })}\n`);
