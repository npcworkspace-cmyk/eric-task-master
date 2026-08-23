#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const playwrightPackage = resolve(root, 'node_modules', 'playwright', 'package.json');
  if (!existsSync(playwrightPackage)) {
    reportBootstrap('bootstrap-progress', { step: 'install-node-dependencies' });
    await run(
      'npm',
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      'DEPENDENCY_INSTALL_FAILED'
    );
  }
  if (!existsSync(playwrightPackage)) {
    const error = new Error('Playwright was not installed after npm ci');
    error.code = 'PLAYWRIGHT_NOT_INSTALLED';
    throw error;
  }

  const { chromium } = await import('playwright');
  if (!existsSync(chromium.executablePath())) {
    reportBootstrap('bootstrap-progress', { step: 'install-playwright-chromium' });
    await run(
      process.execPath,
      [resolve(root, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'],
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
    nextAction: 'Confirm network access and Node.js 20+, then rerun the exact same connect command once.'
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
