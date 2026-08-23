#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.ERIC_TASK_MASTER_ROOT,
  resolve(here, '..', '..', '..'),
  process.cwd()
].filter(Boolean);

function isProjectRoot(candidate) {
  const packagePath = join(candidate, 'package.json');
  if (!existsSync(packagePath)) return false;
  try {
    return JSON.parse(readFileSync(packagePath, 'utf8')).name === 'eric-task-master';
  } catch {
    return false;
  }
}

const root = candidates.find(isProjectRoot);
if (!root) {
  process.stderr.write(JSON.stringify({
    ok: false,
    error: 'TASKMASTER_ROOT_NOT_FOUND',
    nextAction: 'Set ERIC_TASK_MASTER_ROOT to the cloned eric-task-master repository.'
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
