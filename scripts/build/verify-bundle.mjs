#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { exists, hashTree, parseArgs, readJson } from './lib.mjs';

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const bundleRoot = resolve(args.bundle || '');
const manifest = await readJson(join(bundleRoot, 'release-manifest.json'));
const packageJson = await readJson(join(bundleRoot, 'app', 'package.json'));
if (packageJson.version !== manifest.version) throw new Error('Bundle and package versions differ');
if (manifest.browser?.bundled !== false || manifest.browser?.requiredChannel !== 'chrome') {
  throw new Error('Distribution must use separately installed Google Chrome');
}
if (manifest.signature?.signed !== false) throw new Error('Unsigned build metadata is inconsistent');
for (const forbidden of [
  join(bundleRoot, 'app', 'node_modules', 'playwright-core', '.local-browsers'),
  join(bundleRoot, 'app', 'node_modules', 'playwright', '.local-browsers'),
  join(bundleRoot, 'ms-playwright')
]) {
  if (await exists(forbidden)) throw new Error(`Unexpected browser payload: ${forbidden}`);
}
for (const required of [
  join(bundleRoot, 'app', 'src', 'cli.mjs'),
  join(bundleRoot, 'app', 'node_modules', 'playwright', 'package.json'),
  join(bundleRoot, 'runtime', manifest.platform === 'win32' ? 'node.exe' : 'node'),
  join(bundleRoot, 'runtime', 'NODE-LICENSE'),
  join(bundleRoot, 'THIRD_PARTY_NOTICES.txt'),
  join(bundleRoot, 'sbom.spdx.json')
]) {
  if (!(await exists(required))) throw new Error(`Bundle is missing ${required}`);
}

const tree = await hashTree(bundleRoot, { exclude: ['release-manifest.json'] });
if (tree.files !== manifest.tree.files || tree.sha256 !== manifest.tree.sha256) {
  throw new Error('Bundle tree does not match release-manifest.json');
}

const nodeBinary = join(bundleRoot, 'runtime', manifest.platform === 'win32' ? 'node.exe' : 'node');
const nodeVersion = (await execFileAsync(nodeBinary, ['--version'], { windowsHide: true })).stdout.trim();
if (nodeVersion !== `v${manifest.node.version}`) throw new Error(`Bundled Node version is ${nodeVersion}`);
await execFileAsync(nodeBinary, [join(bundleRoot, 'app', 'src', 'cli.mjs'), '--help'], {
  cwd: join(bundleRoot, 'app'),
  windowsHide: true,
  timeout: 30_000,
  maxBuffer: 2 * 1024 * 1024
});

const launcherPath = join(bundleRoot, 'bin', manifest.platform === 'win32' ? 'taskmaster.cmd' : 'taskmaster');
const launcherSource = await readFile(launcherPath, 'utf8');
if (manifest.platform === 'win32') {
  if (!launcherSource.includes('set "NODE_OPTIONS="') || !launcherSource.includes('set "NODE_PATH="')) {
    throw new Error('Windows launcher does not isolate the bundled runtime from host Node injection');
  }
} else if (!launcherSource.includes('unset NODE_OPTIONS NODE_PATH')) {
  throw new Error('Unix launcher does not isolate the bundled runtime from host Node injection');
}
const poisonedEnvironment = {
  ...process.env,
  NODE_OPTIONS: '--require=__eric_task_master_host_injection_must_not_load__',
  NODE_PATH: join(bundleRoot, '__host_node_path_must_not_be_used__')
};
if (manifest.platform === 'win32') {
  await execFileAsync(launcherPath, ['--help'], {
    cwd: bundleRoot,
    env: poisonedEnvironment,
    shell: true,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
} else {
  await execFileAsync(launcherPath, ['--help'], {
    cwd: bundleRoot,
    env: poisonedEnvironment,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

const taskRoot = await mkdtemp(join(tmpdir(), 'eric-task-master-bundle-'));
const taskModules = join(taskRoot, 'node_modules');
try {
  await symlink(
    join(bundleRoot, 'app', 'node_modules'),
    taskModules,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const taskModule = join(taskRoot, 'task.mjs');
  await writeFile(taskModule, [
    "import { chromium } from 'playwright';",
    "if (typeof chromium?.launchPersistentContext !== 'function') throw new Error('Playwright chromium API is unavailable');",
    "process.stdout.write('bare-playwright-import-ok\\n');",
    ''
  ].join('\n'));
  const result = await execFileAsync(nodeBinary, [taskModule], {
    cwd: taskRoot,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
  if (result.stdout.trim() !== 'bare-playwright-import-ok') {
    throw new Error('Bare Playwright import did not complete');
  }
} finally {
  await unlink(taskModules).catch(() => {});
  await rm(taskRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({
  ok: true,
  target: manifest.target,
  version: manifest.version,
  embeddedNode: nodeVersion,
  browserBundled: false,
  barePlaywrightImport: true,
  hostNodeInjectionIsolated: true,
  tree
})}\n`);
