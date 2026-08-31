#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/contracts.mjs';
import { assertReleaseWorkflowPolicy } from './release-workflow-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSION_TEST_FILES = Object.freeze([
  'test/action-arbiter.test.mjs',
  'test/extension-action-coordinator.test.mjs',
  'test/observation-facade.test.mjs',
  'test/persistent-extension-real-browser.test.mjs',
  'test/runtime-budgets.test.mjs',
  'test/user-handoff.test.mjs',
  'test/cooldown.test.mjs',
  'test/task-service.test.mjs',
  'test/output-seal.test.mjs',
  'tests/runtime-budget-browser.test.mjs'
]);
const EXTENSION_OUTPUT_TAIL_LIMIT = 64 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExtensionAcceptanceGate({ packageJson, workflow, checkSource, extensionTests }) {
  const extensionStageInvocation = ['await runExtension', 'Acceptance();'].join('');
  invariant(
    packageJson.scripts?.['acceptance:extensions'] === 'node scripts/check.mjs --extensions-only',
    'independent extension acceptance command drift'
  );
  invariant(
    checkSource.split(extensionStageInvocation).length - 1 >= 2 &&
      checkSource.includes("'extension-acceptance'"),
    'full release check no longer executes the named extension acceptance stage'
  );
  invariant(
    (workflow.match(/TASKMASTER_EXTENSION_REPORT:/gu) || []).length === 2 &&
      workflow.includes('artifacts/extension-acceptance.json') &&
      workflow.includes('if: always()') &&
      (checkSource.match(/EXTENSION_ACCEPTANCE_NOT_COMPLETED/gu) || []).length >= 2,
    'cross-platform CI no longer retains extension acceptance or failure evidence'
  );
  invariant(
    extensionTests.get('test/action-arbiter.test.mjs')?.includes('TASK_ACTION_REENTRANT') &&
      extensionTests.get('test/action-arbiter.test.mjs')?.includes('cancellation during resume validation') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('cannot replay after release') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('navigation releases') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('expired extension lease poisons') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('receipt gates the next FIFO action until verified') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('mismatch in any completion triple field') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('cannot be granted before the Task trigger settles') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('request or grant before expectation registration') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('pause freezes an awaiting extension handoff') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('pause cannot report paused while an extension lease is active') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('preserves extension-first FIFO arrival') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('preserves Task-first FIFO arrival') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('200 same-tick rounds') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('500 seeded mixed Task and extension admission rounds') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('does not expire behind a valid long Task action') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('never pre-acquires the pause boundary') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('does not inherit the external extension queue capacity') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('before completion seal still runs and gates completion') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('completion seal cancels a pre-queue boundary admission') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('every close caller joins the same in-flight boundary release') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('close drains a queued request release') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('can never publish a late grant') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('blocked in durable started persistence') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('blocked in durable terminal persistence') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('never creates a fake receipt') &&
      extensionTests.get('test/extension-action-coordinator.test.mjs')?.includes('EXTENSION_COMPLETION_CHECKPOINT_REQUIRED') &&
      extensionTests.get('test/observation-facade.test.mjs')?.includes("locator('#capture-target').screenshot()") &&
      extensionTests.get('test/observation-facade.test.mjs')?.includes('ignores Task tampering with WeakMap prototype methods') &&
      extensionTests.get('test/observation-facade.test.mjs')?.includes('ignores Task tampering with WeakSet prototype methods') &&
      extensionTests.get('test/observation-facade.test.mjs')?.includes("observed.page.screenshot({ animations: 'disabled' })") &&
      extensionTests.get('test/observation-facade.test.mjs')?.includes('observed.page.pdf()') &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes('TASKMASTER_REAL_BROWSER') &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes('participant-scoped-request-ids') &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes('pre-existing-iframe') &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes('real-worker-extension-handoff-gates-task-takeover') &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes('checkpointLinkedReceipt') &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes('unresolved-extension-effect-blocks-resume-replay') &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes("'storage', 'tabs', 'scripting', 'host-permissions'") &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes('unintegrated-extension-is-not-forced-into-fifo') &&
      extensionTests.get('test/persistent-extension-real-browser.test.mjs')?.includes('stale-extension-grant') &&
      extensionTests.get('test/runtime-budgets.test.mjs')?.includes('gates Journey and task capture before any Playwright call') &&
      extensionTests.get('test/runtime-budgets.test.mjs')?.includes('checkpoint admitted before an extension receipt') &&
      extensionTests.get('test/runtime-budgets.test.mjs')?.includes('effect resolution ingress seals when task code returns') &&
      extensionTests.get('test/runtime-budgets.test.mjs')?.includes('task cancellation rejects effect resolution') &&
      extensionTests.get('test/runtime-budgets.test.mjs')?.includes('every task receives a read-only Page and browser mutations require the action facade') &&
      extensionTests.get('test/runtime-budgets.test.mjs')?.includes('a delayed standalone Page mutation cannot run after task return') &&
      extensionTests.get('test/runtime-budgets.test.mjs')?.includes('task completion rejects a fire-and-forget user handoff') &&
      extensionTests.get('test/runtime-budgets.test.mjs')?.includes('task completion rejects a fire-and-forget cooldown') &&
      extensionTests.get('test/user-handoff.test.mjs')?.includes('continuation reporting is joined and cancellation prevents a late running state') &&
      extensionTests.get('test/user-handoff.test.mjs')?.includes('sealing a handoff while request publication is in flight blocks waiting state and progress') &&
      extensionTests.get('test/cooldown.test.mjs')?.includes('cooldown admission is synchronous, single-instance, and seal blocks late publication') &&
      extensionTests.get('test/cooldown.test.mjs')?.includes('sealing an active cooldown suppresses completed and running publications') &&
      extensionTests.get('test/task-service.test.mjs')?.includes('Manager lifecycle is monotonic against late Worker state after cancel and completion claim') &&
      extensionTests.get('test/task-service.test.mjs')?.includes('Manager rejects output changes made after the Worker claims completion') &&
      extensionTests.get('test/task-service.test.mjs')?.includes('production completion fails closed when the Worker omits its pre-claim output seal') &&
      extensionTests.get('test/output-seal.test.mjs')?.includes('TASK_OUTPUT_CHANGED_AFTER_COMPLETION') &&
      extensionTests.get('test/output-seal.test.mjs')?.includes('output seal precisely reports added, removed, and renamed empty directories') &&
      extensionTests.get('tests/runtime-budget-browser.test.mjs')?.includes('real Worker freezes Locator.prototype before Task import') &&
      extensionTests.get('tests/runtime-budget-browser.test.mjs')?.includes('ChannelOwner.prototype._wrapApiCall was replaceable'),
    'extension serialization, idempotency, navigation, or real-browser acceptance coverage drift'
  );
}

async function staticChecks() {
  const packageJson = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(ROOT, 'package-lock.json'), 'utf8'));
  const license = await readFile(resolve(ROOT, 'LICENSE'), 'utf8');
  const changelog = await readFile(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
  const extensionSources = await Promise.all(
    EXTENSION_TEST_FILES.map((relative) => readFile(resolve(ROOT, relative), 'utf8'))
  );
  const extensionTests = new Map(
    EXTENSION_TEST_FILES.map((relative, index) => [relative, extensionSources[index]])
  );
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
    extensionCoordinator,
    observationFacade,
    acceptance,
    builtinAcceptanceTask,
    builtinReadPageTask,
    builtinObservePageTask,
    checkSource,
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
    taskPacksReference,
    taskRuntimeReference
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
    readFile(resolve(ROOT, 'src', 'lib', 'extension-action-coordinator.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'src', 'lib', 'observation-facade.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'scripts', 'acceptance.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'examples', 'tasks', 'acceptance-task.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'examples', 'tasks', 'read-page-task.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'examples', 'tasks', 'observe-page-task.mjs'), 'utf8'),
    readFile(resolve(ROOT, 'scripts', 'check.mjs'), 'utf8'),
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
    readFile(resolve(ROOT, 'skills', 'eric-task-master', 'references', 'task-packs.md'), 'utf8'),
    readFile(resolve(ROOT, 'skills', 'eric-task-master', 'references', 'task-runtime.md'), 'utf8')
  ]);
  const releaseCreation = releaseWorkflow.indexOf('gh release create');
  const mainPublicationRecheck = releaseWorkflow.indexOf('MAIN_SHA_NOW=');
  const releaseVersionChecks = [...releaseWorkflow.matchAll(/scripts\/assert-release-version\.mjs/g)]
    .map((match) => match.index);
  assertReleaseWorkflowPolicy(releaseWorkflow);
  invariant(
    [builtinAcceptanceTask, builtinReadPageTask, builtinObservePageTask]
      .every((source) => source.includes('capture.viewport({ file:') && !source.includes('.screenshot(')),
    'built-in tasks bypass the runtime-owned viewport capture boundary'
  );
  assertExtensionAcceptanceGate({
    packageJson,
    workflow,
    checkSource,
    extensionTests
  });
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
      interactionContract.includes('TASK_PACK_EXTENSION_HANDOFF_INCOMPLETE') &&
      journey.includes('TASK_INTERACTION_CONTRACT_FAILED') &&
      observationFacade.includes('TASK_UI_ACTION_REQUIRES_JOURNEY') &&
      observationFacade.includes('Object.freeze(Object.create(null))') &&
      observationFacade.includes('return reject(surface, property)') &&
      observationFacade.includes('const PAGE_BLOCKED_METHODS') &&
      observationFacade.includes("'pdf', 'pickLocator'") &&
      observationFacade.includes("'screenshot', 'scrollIntoViewIfNeeded'") &&
      observationFacade.includes('function wrapEventValue(event, value)') &&
      observationFacade.includes("if (event === 'response') return wrapResponse(value)") &&
      observationFacade.includes('function wrappedWaitPredicate(event, predicate, facade)') &&
      observationFacade.includes("members.set('contentFrame'") &&
      observationFacade.includes("members.set('owner'") &&
      observationFacade.includes("members.set('localStorage', wrapWebStorage") &&
      interactionContract.includes("operation: 'arbitrary in-page JavaScript evaluation'") &&
      taskWorker.includes('createObservationFacade') &&
      taskWorker.includes('const extensionFlow = Object.freeze({') &&
      taskWorker.includes('extensionCoordinator.expectCompletion(options)') &&
      taskWorker.includes('extensionCoordinator.resolveCompletion(receiptId, resolution)') &&
      taskWorker.includes('activeExtensionCoordinator?.checkpointContext?.()') &&
      taskWorker.includes('const extensionHandoffAtAdmission = activeExtensionCoordinator?.checkpointContext?.() || null') &&
      taskWorker.includes('activeExtensionCoordinator.checkpointCompleted(') &&
      taskWorker.includes('queueCheckpointBoundary') &&
      taskWorker.includes('normalizeCheckpointData') &&
      taskWorker.includes('onExtensionEffect: (event) => recordEffectEvent(event)') &&
      taskWorker.includes('const assertResumeCheckpointConsumed = () => {') &&
      taskWorker.includes('acquireExtensionBoundary: ({ signal: admissionSignal } = {}) => {') &&
      taskWorker.includes('return pauseGate.acquire({ signal: admissionSignal });') &&
      taskWorker.includes('reservation = actionArbiter.reserve(operation)') &&
      taskWorker.includes('const coordinated = extensionCoordinator.run(operation, () => reservation.execute(async () => {') &&
      taskWorker.includes('await reservation.cancel()') &&
      taskWorker.includes('sealCheckpointBoundary();') &&
      taskWorker.includes("error.code = 'TASK_CHECKPOINT_AFTER_COMPLETION'") &&
      taskWorker.includes('sealEffectResolutionBoundary();') &&
      taskWorker.includes("error.code = 'TASK_EFFECT_AFTER_COMPLETION'") &&
      taskWorker.includes('if (executionSignal.aborted) throw effectResolutionAbortError();') &&
      taskWorker.includes("viewport: (options = {}) => runExclusiveAction('capture-viewport'") &&
      taskWorker.includes("animations: 'allow'") && taskWorker.includes("caret: 'initial'") &&
      taskWorker.includes('extensionCoordinator?.pause()') &&
      taskWorker.includes('extensionCoordinator?.resume()') &&
      taskWorker.includes("safeSend({ type: 'output_seal', snapshot: outputSeal })") &&
      taskService.includes("'TASK_OUTPUT_SEAL_MISSING'") &&
      taskService.includes('requireWorkerOutputSeal') &&
      extensionCoordinator.includes("waiter.phase = 'awaiting-extension'") &&
      extensionCoordinator.includes("waiter.phase = 'extension-active'") &&
      extensionCoordinator.includes("extensionGrantState = 'active'") &&
      extensionCoordinator.includes("extensionBoundaryState: requiresExtensionBoundary ? 'idle' : 'ready'") &&
      extensionCoordinator.includes("if (candidate.extensionBoundaryState === 'idle')") &&
      extensionCoordinator.includes('candidate.prepareExtensionBoundary();') &&
      extensionCoordinator.includes('const inFlightOperations = new Set()') &&
      extensionCoordinator.includes('function raceLifecycle(candidate)') &&
      extensionCoordinator.includes('if (closePromise) return closePromise') &&
      extensionCoordinator.includes('completionEffectPending') &&
      extensionCoordinator.includes('extension-grant-lifecycle-race') &&
      extensionCoordinator.includes('EXTENSION_COMPLETION_CHECKPOINT_REQUIRED') &&
      taskWorker.includes('extensionFlow,') &&
      taskWorker.includes('journey.assertComplete()') &&
      acceptance.includes('interaction-audit.json') &&
      acceptance.includes('audit.score === 10') &&
      taskPacksReference.includes('## Mandatory extension coexistence contract') &&
      ['PACK-EXT-01', 'PACK-EXT-02', 'PACK-EXT-03', 'PACK-EXT-04', 'PACK-EXT-05', 'PACK-EXT-06', 'PACK-EXT-07', 'PACK-EXT-08']
        .every((rule) => taskPacksReference.split(rule).length - 1 === 1) &&
      taskPacksReference.includes('are equal FIFO peers') &&
      taskPacksReference.includes('participantId') && taskPacksReference.includes('requestId') &&
      taskPacksReference.includes('does not reduce extension permissions') &&
      taskPacksReference.includes('wait for the durable `paused` state') &&
      taskPacksReference.includes('`waiting_user` is not equivalent to `paused`') &&
      taskPacksReference.includes('Release or reported outcome alone is not success proof') &&
      taskPacksReference.includes('register the exact expectation') &&
      taskPacksReference.includes('must not blindly restore, duplicate, or overwrite an extension action') &&
      taskRecipes.includes('Runtime owns browser/extension coordination; visible mutations stay in journey; extension-dependent steps use extensionFlow.') &&
      taskRuntimeReference.includes('Cooperative extensions and Task Master are equal FIFO peers') &&
      taskRuntimeReference.includes('extensionFlow.expectCompletion') &&
      taskRuntimeReference.includes('extensionFlow.resolveCompletion') &&
      taskRuntimeReference.includes('participantId + requestId + operation') &&
      taskRuntimeReference.includes('Worker seals all lifecycle and action ingress') &&
      baseSkill.includes("must also follow the reference's mandatory extension coexistence contract"),
    'mandatory Human Journey, extension coexistence, read-only observation, or interaction-audit boundary drift'
  );
  invariant(
    !manager.includes('/v1/pair/extension') &&
      !manager.includes('(open|close|session)') &&
      !manager.includes('validatedSessionBundle') &&
      !taskService.includes('importSession'),
    'extension control-plane or session-transfer runtime must remain removed'
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
  return { passed: 54, total: 54 };
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

function runCaptured(command, args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const chunks = [];
    const remember = (chunk) => {
      chunks.push(String(chunk));
      const joined = chunks.join('');
      if (joined.length > EXTENSION_OUTPUT_TAIL_LIMIT) {
        chunks.splice(0, chunks.length, joined.slice(-EXTENSION_OUTPUT_TAIL_LIMIT));
      }
    };
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      remember(chunk);
    });
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk);
      remember(chunk);
    });
    child.once('error', (error) => {
      error.outputTail = chunks.join('');
      rejectRun(error);
    });
    child.once('exit', (code, signal) => {
      const outputTail = chunks.join('');
      if (code === 0) resolveRun({ outputTail });
      else {
        const error = new Error(`${command} ${args.join(' ')} exited with ${signal || code}`);
        error.outputTail = outputTail;
        rejectRun(error);
      }
    });
  });
}

async function writeExtensionReport(report) {
  const requested = process.env.TASKMASTER_EXTENSION_REPORT;
  if (!requested) return;
  const target = resolve(ROOT, requested);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'w' });
}

async function readExtensionReport() {
  const requested = process.env.TASKMASTER_EXTENSION_REPORT;
  if (!requested) return null;
  try {
    return JSON.parse(await readFile(resolve(ROOT, requested), 'utf8'));
  } catch {
    return null;
  }
}

async function writePendingExtensionReport() {
  const createdAt = new Date().toISOString();
  await writeExtensionReport({
    schemaVersion: 1,
    stage: 'extension-acceptance',
    version: VERSION,
    ok: false,
    state: 'pending',
    createdAt,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    realBrowser: true,
    testFiles: [...EXTENSION_TEST_FILES],
    failure: {
      code: 'EXTENSION_ACCEPTANCE_NOT_COMPLETED',
      message: 'The release gate did not complete the independent extension acceptance stage.'
    }
  });
}

async function runExtensionAcceptance() {
  const startedAt = new Date();
  const baseReport = {
    schemaVersion: 1,
    stage: 'extension-acceptance',
    version: VERSION,
    startedAt: startedAt.toISOString(),
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    realBrowser: true,
    testFiles: [...EXTENSION_TEST_FILES]
  };
  try {
    await runCaptured(
      process.execPath,
      ['--test', '--test-concurrency=1', ...EXTENSION_TEST_FILES],
      { TASKMASTER_REAL_BROWSER: '1', TASKMASTER_EXTENSION_STAGE: '1' }
    );
    const browserAcceptance = await readExtensionReport();
    if (process.env.TASKMASTER_EXTENSION_REPORT) {
      invariant(
        browserAcceptance?.ok === true && browserAcceptance?.summary?.passed === 17,
        'real MV3 extension acceptance did not publish its 17/17 evidence'
      );
    }
    const completedAt = new Date();
    const report = {
      ...baseReport,
      ok: true,
      ...(browserAcceptance ? { browserAcceptance } : {}),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime()
    };
    await writeExtensionReport(report);
    process.stdout.write(`${JSON.stringify({ stage: 'extension-acceptance', ok: true })}\n`);
    return report;
  } catch (error) {
    const completedAt = new Date();
    const browserAcceptance = await readExtensionReport();
    await writeExtensionReport({
      ...baseReport,
      ok: false,
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startedAt.getTime(),
      ...(browserAcceptance && browserAcceptance.state !== 'pending' ? { browserAcceptance } : {}),
      failure: {
        code: 'EXTENSION_ACCEPTANCE_FAILED',
        message: error.message,
        outputTail: String(error.outputTail || '').slice(-EXTENSION_OUTPUT_TAIL_LIMIT)
      }
    });
    throw error;
  }
}

try {
  await writePendingExtensionReport();
  if (process.argv[2] === '--extensions-only') {
    const [packageJson, workflow, checkSource, ...extensionSources] = await Promise.all([
      readFile(resolve(ROOT, 'package.json'), 'utf8').then(JSON.parse),
      readFile(resolve(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
      readFile(resolve(ROOT, 'scripts', 'check.mjs'), 'utf8'),
      ...EXTENSION_TEST_FILES.map((relative) => readFile(resolve(ROOT, relative), 'utf8'))
    ]);
    assertExtensionAcceptanceGate({
      packageJson,
      workflow,
      checkSource,
      extensionTests: new Map(EXTENSION_TEST_FILES.map((relative, index) => [relative, extensionSources[index]]))
    });
    await runExtensionAcceptance();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: VERSION,
      stages: ['extension-acceptance']
    })}\n`);
  } else {
    const staticResult = await staticChecks();
    process.stdout.write(`${JSON.stringify({ stage: 'static', ok: true, ...staticResult })}\n`);
    await run(process.execPath, ['--test', '--test-concurrency=1'], { TASKMASTER_REAL_BROWSER: '1' });
    await runExtensionAcceptance();
    await run(process.execPath, [resolve(ROOT, 'scripts', 'acceptance.mjs')]);
    await run(process.execPath, [resolve(ROOT, 'scripts', 'dashboard-acceptance.mjs')]);
    await run(process.execPath, [resolve(ROOT, 'scripts', 'commercial-acceptance.mjs')]);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      version: VERSION,
      stages: [
        'static',
        'tests',
        'extension-acceptance',
        'acceptance',
        'dashboard-acceptance',
        'commercial-acceptance'
      ]
    })}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    error: { code: 'CHECK_FAILED', message: error.message },
    nextAction: 'Fix the first failing stage and rerun npm run check.'
  })}\n`);
  process.exitCode = 1;
}
