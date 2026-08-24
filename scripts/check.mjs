#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/contracts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function staticChecks() {
  const packageJson = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(ROOT, 'package-lock.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(ROOT, 'extension', 'manifest.json'), 'utf8'));
  invariant(packageJson.version === VERSION, 'package.json version drift');
  invariant(lock.version === VERSION && lock.packages?.['']?.version === VERSION, 'package-lock.json version drift');
  invariant(manifest.version === VERSION, 'extension manifest version drift');
  invariant(
    JSON.stringify(Object.keys(packageJson.dependencies || {}).sort()) ===
      JSON.stringify(['@modelcontextprotocol/server', 'playwright', 'zod'].sort()),
    'Runtime dependency boundary drift'
  );
  invariant(
    JSON.stringify(Object.keys(packageJson.devDependencies || {}).sort()) ===
      JSON.stringify(['@modelcontextprotocol/client']),
    'MCP protocol test dependency boundary drift'
  );
  invariant(!packageJson.dependencies?.['@modelcontextprotocol/sdk'], 'Legacy monolithic MCP SDK is forbidden');
  invariant(manifest.manifest_version === 3, 'extension must use Manifest V3');
  invariant(!manifest.content_scripts, 'extension must not register content scripts');
  invariant(!(manifest.permissions || []).includes('debugger'), 'extension must not request debugger');
  invariant(manifest.action?.default_icon?.['128'] === 'icons/icon-128.png', 'extension icon contract drift');
  await access(resolve(ROOT, 'scripts', 'taskmaster.mjs'));
  const [launcher, bootstrapPolicy, taskWorker, taskService, workflow] = await Promise.all([
    readFile(resolve(ROOT, 'scripts', 'taskmaster.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'scripts', 'bootstrap-policy.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'runtime', 'task-worker.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'runtime', 'task-service.mjs'), 'utf8'),
    readFile(resolve(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  ]);
  invariant(launcher.includes("['ci', '--ignore-scripts', '--no-audit', '--no-fund']"), 'fixed launcher lacks dependency bootstrap');
  invariant(
    launcher.includes('playwrightInstallArguments(') &&
      bootstrapPolicy.includes("'install'") && bootstrapPolicy.includes("'chromium'"),
    'fixed launcher lacks Chromium bootstrap'
  );
  invariant(
    taskWorker.includes('browser.newContext(') && taskWorker.includes('launchPersistentContext('),
    'persistent/ephemeral browser boundary drift'
  );
  invariant(
    taskService.includes('scheduleQueuedTasks') && taskService.includes('TASK_PROGRESS_STALLED'),
    'task scheduler or progress-health boundary drift'
  );
  invariant(
    workflow.includes('windows-latest') && workflow.includes('macos-latest') &&
      workflow.includes('ubuntu-24.04') && workflow.includes('node: [20, 22]'),
    'cross-platform release matrix drift'
  );
  await Promise.all([
    access(resolve(ROOT, 'scripts', 'commercial-acceptance.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'semantic-observer.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'task-pack.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'user-handoff.mjs')),
    access(resolve(ROOT, 'docs', 'RELEASE-GATE.md'))
  ]);
  await Promise.all([16, 32, 48, 128].map((size) => (
    access(resolve(ROOT, 'extension', 'icons', `icon-${size}.png`))
  )));

  const codeFiles = [
    'src/manager.mjs',
    'src/runtime/task-service.mjs',
    'src/runtime/task-worker.mjs',
    'src/runtime/profile-worker.mjs',
    'src/runtime/import-session-worker.mjs',
    'extension/service-worker.js',
    'extension/popup.js'
  ];
  const forbidden = /chrome\.debugger|newCDPSession|connectOverCDP|Runtime\.evaluate|puppeteer/i;
  for (const relative of codeFiles) {
    const source = await readFile(resolve(ROOT, relative), 'utf8');
    invariant(!forbidden.test(source), `${relative} bypasses the pure Playwright boundary`);
  }

  const skill = await readFile(resolve(ROOT, 'skills', 'eric-task-master', 'SKILL.md'), 'utf8');
  invariant(skill.startsWith('---\nname: eric-task-master\n'), 'Skill frontmatter is invalid');
  invariant(skill.includes('node scripts/taskmaster.mjs connect --json'), 'Skill lacks the fixed startup command');
  invariant(
    skill.includes('taskmaster_task_types_describe') && skill.includes('taskmaster_tasks_continue'),
    'Skill lacks progressive discovery or same-task handoff'
  );
  const popup = await readFile(resolve(ROOT, 'extension', 'popup.js'), 'utf8');
  invariant(popup.includes('http://127.0.0.1:19946'), 'extension and manager port contract drift');
  return { passed: 21, total: 21 };
}

function run(command, args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${args.join(' ')} exited with ${signal || code}`));
    });
  });
}

try {
  const staticResult = await staticChecks();
  process.stdout.write(`${JSON.stringify({ stage: 'static', ok: true, ...staticResult })}\n`);
  await run(process.execPath, ['--test', '--test-concurrency=1'], { TASKMASTER_REAL_BROWSER: '1' });
  await run(process.execPath, [resolve(ROOT, 'scripts', 'acceptance.mjs')]);
  await run(process.execPath, [resolve(ROOT, 'scripts', 'commercial-acceptance.mjs')]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: VERSION,
    stages: ['static', 'tests', 'acceptance', 'commercial-acceptance']
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: { code: 'CHECK_FAILED', message: error.message },
    nextAction: 'Fix the first failing stage and rerun npm run check.'
  })}\n`);
  process.exitCode = 1;
}
