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
  const changelog = await readFile(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
  invariant(packageJson.version === VERSION, 'package.json version drift');
  invariant(lock.version === VERSION && lock.packages?.['']?.version === VERSION, 'package-lock.json version drift');
  invariant(packageJson.license === 'MIT', 'package license drift');
  invariant(/^MIT License\r?\n/.test(license), 'MIT license file is missing or malformed');
  invariant(
    new RegExp(`^# Changelog\\r?\\n\\r?\\n## ${VERSION.replaceAll('.', '\\.')}(?: | -)`, 'u').test(changelog),
    'CHANGELOG latest version drift'
  );
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
  const [
    launcher,
    cli,
    bootstrapPolicy,
    manager,
    taskWorker,
    taskService,
    workflow,
    releaseWorkflow,
    dashboard,
    dashboardHtml,
    agentRegistry,
    dashboardSessions,
    taskRecipes,
    taskPack,
    taskTypeRegistry,
    interactionContract,
    journey,
    behavior,
    cooldown,
    observationFacade,
    acceptance,
    mcpStdio,
    mcpServer,
    mcpPublicView,
    mcpClient,
    mcpHostsDocument,
    notificationCenter,
    systemNotifier,
    contracts,
    architecture,
    releaseGate,
    baseSkill,
    taskPacksReference
  ] = await Promise.all([
    readFile(resolve(ROOT, 'scripts', 'taskmaster.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'cli.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'scripts', 'bootstrap-policy.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'manager.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'runtime', 'task-worker.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'runtime', 'task-service.mjs'), 'utf8'),
    readFile(resolve(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    readFile(resolve(ROOT, '.github', 'workflows', 'release.yml'), 'utf8'),
    readFile(resolve(ROOT, 'dashboard', 'dashboard.js'), 'utf8'),
    readFile(resolve(ROOT, 'dashboard', 'index.html'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'agent-registry.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'dashboard-session-store.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'task-recipes.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'task-pack.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'task-type-registry.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'interaction-contract.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'journey.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'behavior.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'cooldown.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'observation-facade.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'scripts', 'acceptance.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'mcp', 'stdio.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'mcp', 'server.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'mcp', 'public-view.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'mcp', 'taskmaster-client.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'docs', 'MCP-HOSTS.md'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'notification-center.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'system-notifier.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'contracts.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'ARCHITECTURE.md'), 'utf8'),
    readFile(resolve(ROOT, 'docs', 'RELEASE-GATE.md'), 'utf8'),
    readFile(resolve(ROOT, 'skills', 'eric-task-master', 'SKILL.md'), 'utf8'),
    readFile(resolve(ROOT, 'skills', 'eric-task-master', 'references', 'task-packs.md'), 'utf8')
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
    taskService.includes("{ name: 'surface-probe', modulePath: SURFACE_PROBE_TASK, discoverable: true }") &&
      journey.includes("async survey(options = {})") && behavior.includes("async survey(options = {})") &&
      taskWorker.includes("survey: guardedAction('survey')"),
    'bounded surface probe or central page-survey boundary drift'
  );
  invariant(
    manager.includes('DashboardSessionStore') && manager.includes('AgentRegistry') &&
      manager.includes('/v1/dashboard/summary') && manager.includes('/v1/agents'),
    'Owner session or Agent registry boundary drift'
  );
  invariant(
    dashboard.includes('bootstrapOwnerSession') && dashboard.includes('markAuthorizationRequired') &&
      dashboard.includes('expectedRevision') && dashboard.includes('deleteTaskRecord') &&
      dashboard.includes('taskDurations') && dashboardHtml.includes('data-view-panel="tasks"') &&
      dashboardHtml.includes('data-view-panel="profiles"') && dashboardHtml.includes('data-view-panel="assets"') &&
      dashboard.includes("request('/v1/task-assets')") && dashboard.includes('runAssetAction') &&
      manager.includes("url.pathname === '/v1/task-assets'") &&
      !dashboardHtml.includes('data-view-panel="overview"') && !dashboardHtml.includes('data-view-panel="agents"') &&
      !dashboard.includes("request('/v1/agents") && !dashboard.includes('/artifacts') &&
      !dashboard.includes('/timeline') && !dashboard.includes('/commands'),
    'Owner Console bootstrap, task timing, revision, deletion, or three-view asset contract drift'
  );
  invariant(
    notificationCenter.includes('const DEFAULT_REMINDER_MS = 30_000') &&
      notificationCenter.includes("task.userRequest?.kind === 'human_verification'") &&
      notificationCenter.includes("task.userRequest?.status === 'pending'") &&
      notificationCenter.includes('eligibilityCheck') && notificationCenter.includes('async claimTask(') &&
      manager.includes("url.pathname === '/v1/notifications'") &&
      manager.includes('listHumanVerificationRequests') && manager.includes('notificationEligibilityCheck') &&
      taskService.includes('USER_HANDOFF_OWNER_CLAIM_REQUIRED') &&
      dashboardHtml.includes('id="notification-drawer"') &&
      dashboard.includes("request('/v1/notifications')") && dashboard.includes('clearNotificationChannel'),
    'human-verification-only 30-second notification contract drift'
  );
  invariant(
    systemNotifier.includes("platform === 'win32'") &&
      systemNotifier.includes("platform === 'darwin'") &&
      systemNotifier.includes("platform === 'linux'") &&
      notificationCenter.includes("const CHANNELS = Object.freeze(['system', 'telegram', 'feishu'])"),
    'native, Telegram, or Feishu notification channel drift'
  );
  invariant(
    dashboard.includes("const LANGUAGE_STORAGE_KEY = 'eric-task-master-language'") &&
      (dashboard.match(/localStorage\.setItem\(/gu) || []).length === 1 &&
      dashboardHtml.includes('id="language-toggle"'),
    'Owner Console bilingual preference boundary drift'
  );
  invariant(
    behavior.includes('transientNavigationFailure') && behavior.includes('navigationRetries') &&
      taskWorker.includes('onNavigationCooldown') && cooldown.includes("options.signalKind || 'rate_limit'"),
    'bounded direct-navigation recovery contract drift'
  );
  invariant(
    agentRegistry.includes("status = 'revoked'") && dashboardSessions.includes('tokenHash') &&
      dashboardSessions.includes('safeEqual') && manager.includes('HttpOnly; SameSite=Strict'),
    'durable Agent registry or hardened Owner cookie contract drift'
  );
  invariant(
    taskService.includes('pauseTask') && taskService.includes('terminateTask') &&
      taskService.includes('publishTaskReport') && taskService.includes('claimAgentInbox'),
    'durable task control, report, or Agent inbox boundary drift'
  );
  invariant(
    taskService.includes('applyProfileBehavior') && taskService.includes("type: 'set_behavior'") &&
      taskService.includes('BEHAVIOR_LIVE_APPLY_TIMEOUT') &&
      taskWorker.includes("message?.type === 'set_behavior'") && taskWorker.includes('activeActionHelper.setMode') &&
      behavior.includes('wakePacingWaiters') && behavior.includes('return humanClick(locator, options)') &&
      !behavior.includes('usesHumanMechanics') &&
      dashboard.includes("['fast', 'auto', 'human']"),
    'live Profile behavior control or mandatory journey mechanics drift'
  );
  invariant(
    ['single-page', 'paginated-list', 'list-detail', 'resumable-batch', 'form-workflow']
      .every((recipe) => taskRecipes.includes(`'${recipe}'`)),
    'task authoring recipe boundary drift'
  );
  invariant(
    taskPack.includes('FULL_HUMAN_INTERACTION_CONTRACT') &&
      taskPack.includes('validateFullHumanPackSource') &&
      taskRecipes.includes("interactionContract: 'full-human-v1'") &&
      taskRecipes.includes('journey.nextPage') &&
      interactionContract.includes("FULL_HUMAN_INTERACTION_CONTRACT = 'full-human-v1'") &&
      journey.includes('TASK_INTERACTION_CONTRACT_FAILED') &&
      observationFacade.includes('TASK_UI_ACTION_REQUIRES_JOURNEY') &&
      taskWorker.includes('createObservationFacade') &&
      taskWorker.includes('journey.assertComplete()') &&
      acceptance.includes('interaction-audit.json') &&
      acceptance.includes('audit.score === 10'),
    'mandatory Human Journey, read-only observation, or interaction-audit boundary drift'
  );
  invariant(
    !manager.includes('/v1/pair/extension') &&
      !manager.includes('(open|close|session)') &&
      !manager.includes('validatedSessionBundle') &&
      !taskService.includes('importSession'),
    'extension or session-transfer runtime must remain removed'
  );
  invariant(
    mcpStdio.includes("from '@modelcontextprotocol/server/stdio'") &&
      mcpStdio.includes('serveStdio(') &&
      !/StreamableHTTPServerTransport|SSEServerTransport|createServer\s*\(/u.test(mcpStdio) &&
      !/StreamableHTTPServerTransport|SSEServerTransport/u.test(mcpServer),
    'Agent MCP must remain one per-host STDIO bridge; no HTTP/SSE MCP listener is allowed'
  );
  invariant(
    mcpServer.includes("name: 'taskmaster_task_packs_list'") &&
      mcpServer.includes('nextCursor') && mcpServer.includes('cursor: z.string()') &&
      mcpServer.includes("name: 'taskmaster_tasks_focus'") &&
      !mcpServer.includes('taskmaster_tasks_claim_user_request'),
    'read-only Task Pack discovery, focus, or Owner-only verification claim boundary drift'
  );
  const removedExternalCostSurface = /external(?:Cost|_cost|-cost)/iu;
  for (const [label, source] of [
    ['CLI', cli],
    ['launcher', launcher],
    ['Manager', manager],
    ['Worker', taskWorker],
    ['Task Pack runtime', taskPack],
    ['Task recipe runtime', taskRecipes],
    ['MCP STDIO', mcpStdio],
    ['MCP server', mcpServer],
    ['MCP public view', mcpPublicView],
    ['MCP client', mcpClient]
  ]) {
    invariant(!removedExternalCostSurface.test(source), `${label} still exposes the removed external-cost capability`);
  }
  invariant(
    contracts.includes("['external-cost-estimated', 'external-cost-actual'].includes(item?.label)") &&
      (contracts.match(/external(?:Cost|_cost|-cost)/giu) || []).length === 2 &&
      !/external(?:Cost|_cost)/u.test(contracts),
    'public task contracts must only retain the two legacy cost-evidence removal labels'
  );
  invariant(
    taskService.includes('const LEGACY_EXTERNAL_COST_FIELDS') &&
      taskService.includes('function migrateLegacyExternalCostState') &&
      taskService.includes("Object.hasOwn(body, 'externalCostBudget')") &&
      (taskService.match(/externalCost/gu) || []).length === 6 &&
      (taskService.match(/TASK_EXTERNAL_COST_UNSUPPORTED/gu) || []).length === 3 &&
      !/createExternalCostLedger|externalCostLedgerUsage|reserveExternalCost|settleExternalCost|externalCostTail|external_cost_request|external_cost_response|applyExternalCostOperation|validateExternalCostBudget|verifyExternalCostEvidence/u.test(taskService),
    'Task Service external-cost compatibility must remain migration-and-rejection only'
  );
  invariant(
    taskTypeRegistry.includes('function normalizeManagementRecord') &&
      taskTypeRegistry.includes("Object.hasOwn(source, 'externalCost')") &&
      (taskTypeRegistry.match(/externalCost/gu) || []).length === 6 &&
      (taskTypeRegistry.match(/TASK_EXTERNAL_COST_UNSUPPORTED/gu) || []).length === 4 &&
      !/boundedExternalCost|MAX_EXTERNAL_COST_PER_RUN|EXTERNAL_COST_CURRENCY/u.test(taskTypeRegistry),
    'Task type external-cost compatibility must remain migration-and-rejection only'
  );
  invariant(
    architecture.includes('Task Master 2.8.0 removes the generic paid-provider metadata') &&
      !architecture.includes('Paid task types declare a currency and task ceiling') &&
      baseSkill.includes('does not provide a generic paid-provider budget') &&
      !/externalCost\.(?:reserve|settle)/u.test(baseSkill) &&
      taskPacksReference.includes('does not price, authorize, meter, or reimburse external providers'),
    'Architecture and base Skill must describe the removed external-cost runtime consistently'
  );
  invariant(
    architecture.includes('relevant visible frame is unreadable, omitted, or errors') &&
      architecture.includes('hidden/decorative child frame that merely reaches the observation budget') &&
      taskPacksReference.includes('dense main document or a hidden/decorative child frame') &&
      releaseGate.includes('relevant visible unreadable/omitted/errored frames block scale'),
    'Surface-frame warning and blocking documentation drift'
  );
  invariant(
    !/(?:walmart|reddit|amazon|youtube|quora|fashion-media)/iu.test([
      architecture,
      baseSkill,
      taskPacksReference
    ].join('\n')),
    'Base architecture or Skill contains site-specific Pack logic'
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
    access(resolve(ROOT, 'scripts', 'dashboard-acceptance.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'semantic-observer.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'task-pack.mjs')),
    access(resolve(ROOT, 'src', 'lib', 'user-handoff.mjs')),
    access(resolve(ROOT, 'docs', 'RELEASE-GATE.md')),
    access(resolve(ROOT, 'tests', 'mcp', 'multi-host-e2e.test.mjs')),
    access(resolve(ROOT, 'tests', 'registration', 'json-host-hardening.test.mjs')),
    access(resolve(ROOT, 'tests', 'registration', 'openclaw-metadata.test.mjs'))
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
  invariant(
    skill.includes('node scripts/taskmaster.mjs connect --json') &&
      skill.includes('agent_host_reload_required') &&
      skill.includes('taskmaster_scale_prepare') &&
      skill.includes('taskmaster.mjs doctor --json'),
    'Skill lacks the fixed startup or Manager-migration reload contract'
  );
  invariant(
    skill.includes('taskmaster_task_types_describe') && skill.includes('taskmaster_tasks_continue') &&
      skill.includes('taskmaster_dashboard_open') && skill.includes('clickable Dashboard link') &&
      skill.includes('taskmaster_agent_inbox_claim') && skill.includes('taskmaster_task_report_publish'),
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
    !skill.includes('needs_adapter') && !readme.includes('needs_adapter') && !readmeZh.includes('needs_adapter') &&
      skill.includes('MCP is the default Agent path') &&
      mcpHostsDocument.includes('adapter_pending') && mcpHostsDocument.includes('extension_required') &&
      mcpHostsDocument.includes('registered_disabled') &&
      mcpHostsDocument.includes('ERIC_TASK_MASTER_RUNTIME_VERSION') &&
      mcpHostsDocument.includes('~/.workbuddy/mcp.json') &&
      mcpHostsDocument.includes('one local STDIO bridge') &&
      mcpHostsDocument.includes('openclaw mcp list/set/unset') &&
      mcpHostsDocument.includes('~/.codebuddy/.mcp.json`, `mcp.json`, then `.codebuddy.json'),
    'MCP-first Skill, host capability, or WorkBuddy registration documentation drift'
  );
  invariant(
    workflow.includes('TASKMASTER_ACCEPTANCE_PERSISTENT_ENGINE: chrome') &&
      workflow.includes('TASKMASTER_DASHBOARD_REPORT:') &&
      workflow.includes('TASKMASTER_DASHBOARD_SCREENSHOT:'),
    'cross-platform CI must exercise stable Chrome and retain Owner Console evidence'
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
  return { passed: 53, total: 53 };
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
  await run(process.execPath, [resolve(ROOT, 'scripts', 'dashboard-acceptance.mjs')]);
  await run(process.execPath, [resolve(ROOT, 'scripts', 'commercial-acceptance.mjs')]);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    version: VERSION,
    stages: ['static', 'tests', 'acceptance', 'dashboard-acceptance', 'commercial-acceptance']
  })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: { code: 'CHECK_FAILED', message: error.message },
    nextAction: 'Fix the first failing stage and rerun npm run check.'
  })}\n`);
  process.exitCode = 1;
}
