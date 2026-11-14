#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CLI, ROOT, createOperationsHarness } from '../test-v3/fixtures/fast-operations/harness.mjs';
import { SIMULATED_SELECTORS, websiteBatch } from '../src/runtime/operations-workflows.mjs';
import { jsonTransport } from '../src/runtime/single-send-transport.mjs';

const execute = promisify(execFileCallback);
const samePath = (left, right) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);

export function packagedInvocation(bundleRoot, program, args, options = {}) {
  assert.ok(samePath(program, process.execPath), 'Only the harness source-node CLI invocation may be redirected');
  assert.ok(Array.isArray(args) && samePath(args[0], CLI), 'Only the known Task Master CLI may be redirected');
  const appRoot = path.join(path.resolve(bundleRoot), 'app');
  return { program: path.join(path.resolve(bundleRoot), 'runtime', 'node.exe'), args: [path.join(appRoot, 'src', 'cli.mjs'), ...args.slice(1)],
    options: { ...options, cwd: appRoot, windowsHide: true } };
}

export async function runPackagedOperations({ bundleRoot, outputDir } = {}) {
  if (process.platform !== 'win32') throw new Error('This smoke is specifically for a Windows portable bundle');
  if (!bundleRoot || !outputDir) throw new Error('Usage: node scripts/acceptance-packaged-operations.mjs BUNDLE_ROOT NEW_OUTPUT_DIR');
  bundleRoot = await realpath(path.resolve(bundleRoot)); outputDir = path.resolve(outputDir);
  const relative = path.relative(bundleRoot, outputDir);
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Smoke output must stay outside the immutable bundle');
  await mkdir(outputDir, { recursive: true });
  assert.deepEqual(await readdir(outputDir), [], 'Choose a fresh empty output directory; no existing state or Manager will be reused');
  const bundleNode = path.join(bundleRoot, 'runtime', 'node.exe'); const bundleCli = path.join(bundleRoot, 'app', 'src', 'cli.mjs');
  await access(bundleNode); await access(bundleCli);
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, 'release-manifest.json'), 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(bundleRoot, 'app', 'package.json'), 'utf8'));
  const sourcePackage = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.platform, 'win32'); assert.equal(packageJson.name, 'eric-task-master'); assert.equal(packageJson.version, manifest.version); assert.equal(packageJson.version, sourcePackage.version);
  const checks = []; const invocations = [];
  let harness; let failure = null; let cleanup = null;
  const startedAt = new Date().toISOString();
  const record = (name, details = {}) => { checks.push({ name, passed: true, at: new Date().toISOString(), ...details }); process.stdout.write(`${JSON.stringify({ check: name, passed: true })}\n`); };
  const packagedExecute = async (program, args, options) => {
    const invocation = packagedInvocation(bundleRoot, program, args, options);
    // Record paths/command names only; never child environment, tokens or input bodies.
    invocations.push({ program: invocation.program, cli: invocation.args[0], command: invocation.args.slice(1, 3), cwd: invocation.options.cwd });
    return execute(invocation.program, invocation.args, invocation.options);
  };
  try {
    harness = await createOperationsHarness({ outputDir: path.join(outputDir, 'runtime'), label: `packaged-ops-${Date.now()}`, executeFile: packagedExecute });
    const manager = await harness.managerMetadata();
    assert.equal(manager.version, manifest.version); assert.equal(manager.scope, 'project'); assert.ok(samePath(manager.stateDirEffective, harness.stateDir));
    record('portable Node/CLI starts the expected package version in fresh isolated project state', { version: manager.version, managerPid: manager.pid, stateDir: harness.stateDir });

    const operation = await harness.start('site', { mode: 'operations', singleSendTransport: true });
    assert.equal(operation.mode, 'operations'); assert.equal(operation.cursorEnabled, true); assert.equal(operation.task.cursorEnabled, true); assert.equal(operation.task.operationId, operation.id);
    assert.equal((await harness.navigate(operation.id, `${harness.fixture.origin}/site`)).status, 'confirmed');
    const observation = await harness.observe(operation.id, { scope: 'body', maxChars: 5000 });
    assert.equal(observation.status, 'confirmed'); assert.ok(observation.result.items.some((item) => String(item.text).includes('example.test')));
    record('packaged operations session performs real navigation and scoped observation with default-on cursor', { operationId: operation.id, taskId: operation.taskId });

    const beforeToggle = await harness.cli(['ops', 'get', operation.id]);
    for (const visible of [false, true]) {
      const updated = await harness.cli(['ops', 'update', operation.id, '--input', JSON.stringify({ showCursor: visible })]);
      assert.equal(updated.cursorEnabled, visible); assert.equal(updated.task.cursorEnabled, visible); assert.equal(updated.mode, 'operations');
      assert.equal(updated.manualLock, beforeToggle.manualLock); assert.deepEqual(updated.authorization, beforeToggle.authorization); assert.deepEqual(updated.counters, beforeToggle.counters);
    }
    record('portable operation cursor preference toggles through CLI/Manager without changing authority or execution mode');

    const before = (await harness.state()).config; const next = 'packaged-smoke-approved-value';
    const fresh = await harness.observe(operation.id, { scope: 'body' });
    const batch = websiteBatch({ decision: { approved: true, id: 'packaged-local-save', reason: 'Explicit infrastructure smoke against the isolated local fixture only' },
      selectors: SIMULATED_SELECTORS.site, record: { accountId: 'account-1', domain: 'example.test', resourceId: 'config-1', before, rollback: `Restore ${before}` }, nextValue: next,
      transport: jsonTransport(`${harness.fixture.origin}/api/config`, { value: next }) });
    const result = await harness.command(operation.id, 'batch', batch, { pageId: fresh.pageId, pageVersion: fresh.pageVersion });
    assert.equal(result.status, 'confirmed'); assert.equal((await harness.state()).config, next); assert.equal((await harness.state()).effects.length, 1);
    const saved = await harness.cli(['ops', 'get', operation.id]);
    assert.equal(saved.taskId, operation.taskId); assert.ok(saved.actions.some((action) => action.kind === 'site.configure' && action.status === 'confirmed' && action.verification?.matched === true));
    assert.equal(saved.actions.find((action) => action.kind === 'site.configure').transportForward?.bodySha256, batch.actions.at(-1).transport.bodySha256);
    const readback = await harness.observe(operation.id, { scope: '#current-value' }); assert.equal(readback.status, 'confirmed'); assert.ok(readback.result.items.some((item) => item.text === next));
    record('portable Worker executes one bounded local configuration save and confirms independent fixture plus browser readback', { externalEffects: 1, finalValue: next, sameTaskId: saved.taskId });
    await harness.stop(operation.id);

    for (const options of [{ mode: 'batch' }, { mode: 'batch', showCursor: true }]) {
      const finite = await harness.start('site', options);
      assert.equal(finite.cursorEnabled, options.showCursor === true); assert.equal(finite.task.cursorEnabled, options.showCursor === true);
      assert.equal((await harness.observe(finite.id)).status, 'confirmed');
      assert.equal((await harness.navigate(finite.id, `${harness.fixture.origin}/site`)).status, 'confirmed');
      const finished = await harness.waitOperation(finite.id, (value) => value.task?.state === 'finished');
      assert.equal(finished.task.result.completedBatches, 1);
      record(options.showCursor ? 'portable explicit batch cursor override is honored and finite task ends' : 'portable batch cursor defaults off and finite task ends', { operationId: finite.id, taskId: finite.taskId, cursorEnabled: finite.cursorEnabled });
    }
    const profile = (await harness.cli(['profiles', 'list'])).profiles.find((item) => item.id === harness.profile.id);
    assert.equal(profile.modePolicy, 'auto');
    record('portable smoke leaves the isolated Profile policy unchanged and never targets installed/shared state');
  } catch (error) { failure = { code: error.code || 'PACKAGED_OPERATIONS_SMOKE_FAILED', message: error.message, stack: error.stack }; }
  finally { if (harness) cleanup = await harness.finish().catch((error) => ({ ok: false, errors: [{ message: error.message }] })); }
  const report = { ok: !failure && cleanup?.ok === true, startedAt, finishedAt: new Date().toISOString(), bundleRoot, bundleNode, bundleCli, outputDir,
    version: manifest.version, declaredBundleTreeSha256: manifest.tree?.sha256 || null, treeVerification: 'delegated to existing scripts/build/verify-bundle.mjs; not reimplemented here',
    checks, invocations, cleanup, ...(failure ? { error: failure } : {}),
    boundary: { packageDifferenceSmokeOnly: true, fixture: 'isolated local website simulation', installedRuntimeModified: false, sharedManagerTouched: false, realAccountsTouched: false, repeatsFullSuite: false } };
  await writeFile(path.join(outputDir, 'packaged-operations-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: report.ok, reportPath: path.join(outputDir, 'packaged-operations-report.json'), checks: checks.length, cleanup: cleanup?.ok })}\n`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--self-test')) {
    const root = path.resolve('bundle-test-only'); const args = [CLI, 'ops', 'get', 'op1', '--state-dir', 'isolated', '--json']; const env = { ONLY_TEST_MARKER: 'preserved' };
    const result = packagedInvocation(root, process.execPath, args, { cwd: ROOT, env });
    assert.equal(result.program, path.join(root, 'runtime', 'node.exe')); assert.equal(result.args[0], path.join(root, 'app', 'src', 'cli.mjs')); assert.deepEqual(result.args.slice(1), args.slice(1)); assert.equal(result.options.env, env); assert.equal(result.options.cwd, path.join(root, 'app')); assert.equal(result.options.windowsHide, true);
    assert.throws(() => packagedInvocation(root, process.execPath, ['unrelated.mjs']));
    process.stdout.write(`${JSON.stringify({ ok: true, invocationRedirectOnly: true, argumentsAndIsolationPreserved: true, noBundleOrBrowserStarted: true })}\n`);
  } else {
    const report = await runPackagedOperations({ bundleRoot: process.argv[2], outputDir: process.argv[3] }); if (!report.ok) process.exitCode = 1;
  }
}
