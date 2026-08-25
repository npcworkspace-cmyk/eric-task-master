#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeContract = JSON.parse(readFileSync(join(here, '..', 'runtime.json'), 'utf8'));
const candidates = [
  process.env.ERIC_TASK_MASTER_ROOT,
  resolve(here, '..', '..', '..'),
  process.cwd()
].filter(Boolean);

function inspectProjectRoot(candidate) {
  const packagePath = join(candidate, 'package.json');
  if (!existsSync(packagePath)) return { compatible: false, found: false };
  try {
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const found = packageJson.name === runtimeContract.runtimeName;
    return {
      compatible: found && packageJson.version === runtimeContract.runtimeVersion,
      found,
      version: packageJson.version
    };
  } catch {
    return { compatible: false, found: false };
  }
}

const inspected = candidates.map((candidate) => ({ candidate, ...inspectProjectRoot(candidate) }));
const root = inspected.find((item) => item.compatible)?.candidate;
if (!root) {
  const mismatch = inspected.find((item) => item.found);
  process.stderr.write(JSON.stringify({
    ok: false,
    error: mismatch ? 'TASKMASTER_RUNTIME_VERSION_MISMATCH' : 'TASKMASTER_ROOT_NOT_FOUND',
    ...(mismatch ? { expected: runtimeContract.runtimeVersion, actual: mismatch.version } : {}),
    nextAction: `Clone ${runtimeContract.repository} at ${runtimeContract.releaseTag}, then set ERIC_TASK_MASTER_ROOT to that complete repository.`
  }) + '\n');
  process.exit(1);
}

const child = spawn(process.execPath, [join(root, 'scripts', 'taskmaster.mjs'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});

child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
