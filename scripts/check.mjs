#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/contracts.mjs';
import { assertReleaseWorkflowPolicy } from './release-workflow-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function staticChecks() {
  const packageJson = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(ROOT, 'package-lock.json'), 'utf8'));
  const license = await readFile(resolve(ROOT, 'LICENSE'), 'utf8');
  invariant(packageJson.version === VERSION, 'package.json version drift');
  invariant(lock.version === VERSION && lock.packages?.['']?.version === VERSION, 'package-lock.json version drift');
  invariant(packageJson.license === 'MIT', 'package license drift');
  invariant(/^MIT License\r?\n/.test(license), 'MIT license file is missing or malformed');
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
  const extensionRemoved = await access(resolve(ROOT, 'extension'))
    .then(() => false, (error) => error?.code === 'ENOENT');
  invariant(extensionRemoved, 'extension directory or payload must not be shipped');
  await access(resolve(ROOT, 'scripts', 'taskmaster.mjs'));
  const [launcher, bootstrapPolicy, manager, taskWorker, taskService, workflow, releaseWorkflow] = await Promise.all([
    readFile(resolve(ROOT, 'scripts', 'taskmaster.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'scripts', 'bootstrap-policy.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'manager.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'runtime', 'task-worker.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'runtime', 'task-service.mjs'), 'utf8'),
    readFile(resolve(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFile(resolve(ROOT, '.github', 'workflows', 'release.yml'), 'utf8')
  ]);
  const releaseCreation = releaseWorkflow.indexOf('gh release create');
  const mainPublicationRecheck = releaseWorkflow.indexOf('MAIN_SHA_NOW=');
  const releaseVersionChecks = [...releaseWorkflow.matchAll(/scripts\/assert-release-version\.mjs/g)]
    .map((match) => match.index);
  assertReleaseWorkflowPolicy(releaseWorkflow);
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
    !manager.includes('/v1/pair/extension') &&
      !manager.includes('(open|close|session)') &&
      !manager.includes('validatedSessionBundle') &&
      !taskService.includes('importSession'),
    'extension or session-transfer runtime must remain removed'
  );
  invariant(
    workflow.includes('windows-latest') && workflow.includes('macos-latest') &&
      workflow.includes('ubuntu-24.04') && workflow.includes('node: [20, 22]') &&
      workflow.includes('branches: [main, "upgrade/**"]') && workflow.includes('pull_request:'),
    'cross-platform release matrix drift'
  );
  invariant(
    workflow.includes('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1') &&
      workflow.includes('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020') &&
      workflow.includes('actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a') &&
      releaseWorkflow.includes('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1') &&
      releaseWorkflow.includes('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020'),
    'workflows must use the audited pinned Node 24 Actions runtime'
  );
  invariant(
    releaseWorkflow.includes('workflow_dispatch:') &&
      !releaseWorkflow.includes('workflow_run:') &&
      releaseWorkflow.includes('release_sha:') &&
      releaseWorkflow.includes('confirm_version:') &&
      releaseWorkflow.includes('confirm_immutable:'),
    'release workflow must require an explicit manual version and commit'
  );
  invariant(
    releaseWorkflow.includes('ref: ${{ inputs.release_sha }}') &&
      releaseWorkflow.includes('RELEASE_SHA: ${{ inputs.release_sha }}') &&
      releaseWorkflow.includes('CONFIRM_VERSION: ${{ inputs.confirm_version }}') &&
      releaseWorkflow.includes('CONFIRM_IMMUTABLE: ${{ inputs.confirm_immutable }}'),
    'release workflow must package the exact verified commit'
  );
  invariant(
    releaseWorkflow.includes('git archive --format=zip') &&
      releaseWorkflow.includes('ARCHIVE_MTIME="@$(git show -s --format=%ct "${RELEASE_SHA}")"') &&
      releaseWorkflow.includes('--mtime="${ARCHIVE_MTIME}"') &&
      releaseWorkflow.includes('cmp "dist/eric-task-master-skill-v${VERSION}.zip"') &&
      !releaseWorkflow.includes('HEAD:extension') &&
      releaseWorkflow.includes('HEAD:skills/eric-task-master') &&
      releaseWorkflow.includes('SHA256SUMS'),
    'release archive or checksum boundary drift'
  );
  invariant(
    releaseWorkflow.includes('group: manual-release-${{ github.repository }}') &&
      !releaseWorkflow.match(/group:\s*manual-release[^\r\n]*inputs\.confirm_version/) &&
      releaseWorkflow.includes('MAIN_SHA_NOW=') &&
      releaseWorkflow.includes('CI_RUN_NOW=') &&
      releaseVersionChecks.length >= 2 &&
      releaseVersionChecks.at(-1) > mainPublicationRecheck &&
      releaseVersionChecks.at(-1) < releaseCreation,
    'release publication must be globally serialized and revalidated immediately before draft creation'
  );
  invariant(
    releaseWorkflow.includes('actions: read') && releaseWorkflow.includes('contents: write') &&
      releaseWorkflow.includes('/git/ref/heads/main') &&
      releaseWorkflow.includes('/actions/workflows/ci.yml/runs?') &&
      releaseWorkflow.includes('gh release create') &&
      releaseWorkflow.includes('--draft') && releaseWorkflow.includes('gh release edit') &&
      releaseWorkflow.includes('--draft=false') && releaseWorkflow.includes('TAG_SHA') &&
      releaseWorkflow.includes('--jq .immutable') &&
      !releaseWorkflow.includes('--clobber'),
    'release publication must be scoped and immutable'
  );
  await Promise.all([
    access(resolve(ROOT, 'scripts', 'commercial-acceptance.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'semantic-observer.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'task-pack.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'user-handoff.mjs')),
    access(resolve(ROOT, 'docs', 'RELEASE-GATE.md'))
  ]);
  const codeFiles = [
    'src/manager.mjs',
    'src/runtime/task-service.mjs',
    'src/runtime/task-worker.mjs',
    'src/runtime/profile-worker.mjs'
  ];
  const forbidden = /chrome\.debugger|newCDPSession|connectOverCDP|Runtime\.evaluate|puppeteer/i;
  for (const relative of codeFiles) {
    const source = await readFile(resolve(ROOT, relative), 'utf8');
    invariant(!forbidden.test(source), `${relative} bypasses the pure Playwright boundary`);
  }

  const [skill, skillRuntimeSource, skillLicense, skillWrapper, readme, readmeZh] = await Promise.all([
    readFile(resolve(ROOT, 'skills', 'eric-task-master', 'SKILL.md'), 'utf8'),
    readFile(resolve(ROOT, 'skills', 'eric-task-master', 'runtime.json'), 'utf8'),
    readFile(resolve(ROOT, 'skills', 'eric-task-master', 'LICENSE'), 'utf8'),
    readFile(resolve(ROOT, 'skills', 'eric-task-master', 'scripts', 'taskmaster.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'README.md'), 'utf8'),
    readFile(resolve(ROOT, 'README.zh-CN.md'), 'utf8')
  ]);
  const skillRuntime = JSON.parse(skillRuntimeSource);
  invariant(skill.startsWith('---\nname: eric-task-master\n'), 'Skill frontmatter is invalid');
  invariant(
    skillLicense.replaceAll('\r\n', '\n') === license.replaceAll('\r\n', '\n'),
    'Standalone Skill license must match the project MIT license'
  );
  invariant(
    skillRuntime.runtimeName === packageJson.name && skillRuntime.runtimeVersion === VERSION &&
      skillRuntime.releaseTag === `v${VERSION}` && skillWrapper.includes('TASKMASTER_RUNTIME_VERSION_MISMATCH'),
    'Skill and runtime version contract drift'
  );
  invariant(skill.includes('node scripts/taskmaster.mjs connect --json'), 'Skill lacks the fixed startup command');
  invariant(
    skill.includes('taskmaster_task_types_describe') && skill.includes('taskmaster_tasks_continue') &&
      skill.includes('taskmaster_dashboard_open') && skill.includes('clickable Dashboard link'),
    'Skill lacks progressive discovery, same-task handoff, or the fixed Dashboard link contract'
  );
  invariant(
    readme.includes('[简体中文](./README.zh-CN.md)') && readmeZh.includes('[English](./README.md)'),
    'Bilingual README navigation drift'
  );
  invariant(
    readme.includes('node scripts/taskmaster.mjs connect --json') &&
      readmeZh.includes('node scripts/taskmaster.mjs connect --json') &&
      readme.includes('https://github.com/npcworkspace-cmyk/eric-task-master') &&
      readmeZh.includes('https://github.com/npcworkspace-cmyk/eric-task-master'),
    'GitHub-to-task bootstrap contract drift'
  );
  invariant(
    workflow.includes('TASKMASTER_ACCEPTANCE_PERSISTENT_ENGINE: chrome'),
    'cross-platform CI must exercise the stable Chrome persistent-Profile path'
  );
  const immutablePreflight = releaseWorkflow.indexOf('repos/${GITHUB_REPOSITORY}/immutable-releases');
  const immutableRecheck = releaseWorkflow.lastIndexOf('repos/${GITHUB_REPOSITORY}/immutable-releases');
  invariant(
    immutablePreflight >= 0 && immutableRecheck > immutablePreflight && releaseCreation > immutableRecheck &&
      releaseWorkflow.includes('secrets.RELEASE_ADMIN_TOKEN') &&
      releaseWorkflow.includes('scripts/assert-release-version.mjs') &&
      releaseWorkflow.includes('${SKILL_PREFIX}/LICENSE') &&
      releaseWorkflow.includes('${SKILL_PREFIX}/runtime.json'),
    'release preflight, monotonic version, or standalone Skill archive proof drift'
  );
  return { passed: 35, total: 35 };
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
