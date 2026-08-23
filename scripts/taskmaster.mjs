#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapNextAction, playwrightInstallArguments } from './bootstrap-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function reportBootstrap(event, detail) {
  process.stderr.write(`${JSON.stringify({ event, ...detail })}\n`);
}

function run(command, commandArgs, code) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      shell: process.platform === 'win32' && command === 'npm'
    });
    child.once('error', (error) => {
      rejectRun(Object.assign(error, { code }));
    });
    child.once('exit', (exitCode, signal) => {
      if (exitCode === 0) {
        resolveRun();
        return;
      }
      const error = new Error(`${command} exited with ${signal || exitCode}`);
      error.code = code;
      rejectRun(error);
    });
  });
}

async function bootstrapConnect() {
  if (args[0] !== 'connect') return;
  const expectedDependencies = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).dependencies || {};
  const installedDependenciesMatch = Object.entries(expectedDependencies).every(([name, version]) => {
    const packagePath = resolve(root, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(packagePath)) return false;
    try {
      return JSON.parse(readFileSync(packagePath, 'utf8')).version === version;
    } catch {
      return false;
    }
  });
  if (!installedDependenciesMatch) {
    reportBootstrap('bootstrap-progress', { step: 'install-node-dependencies' });
    await run(
      'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      'DEPENDENCY_INSTALL_FAILED'
    );
  }
  const playwrightPackage = resolve(root, 'node_modules', 'playwright', 'package.json');
  if (!existsSync(playwrightPackage)) {
    const error = new Error('Runtime dependencies were not installed after npm ci');
    error.code = 'RUNTIME_DEPENDENCIES_NOT_INSTALLED';
    throw error;
  }

  const { chromium } = await import('playwright');
  if (!existsSync(chromium.executablePath())) {
    reportBootstrap('bootstrap-progress', { step: 'install-playwright-chromium' });
    await run(
      process.execPath,
      playwrightInstallArguments(resolve(root, 'node_modules', 'playwright', 'cli.js')),
      'BROWSER_INSTALL_FAILED'
    );
  }
  if (!existsSync(chromium.executablePath())) {
    const error = new Error('Playwright Chromium is unavailable after installation');
    error.code = 'BROWSER_NOT_INSTALLED';
    throw error;
  }
}

let child;
try {
  await bootstrapConnect();
  child = spawn(
    process.execPath,
    [resolve(root, 'src', 'cli.mjs'), ...args],
    {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true
    }
  );
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: error.code || 'TASKMASTER_BOOTSTRAP_FAILED',
      message: error.message
    },
    nextAction: bootstrapNextAction(error)
  })}\n`);
  process.exit(1);
}

child.once('error', (error) => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: {
      code: 'TASKMASTER_LAUNCH_FAILED',
      message: error.message
    },
    nextAction: 'Confirm Node.js is installed, then rerun the same command once.'
  })}\n`);
  process.exit(1);
});

child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
