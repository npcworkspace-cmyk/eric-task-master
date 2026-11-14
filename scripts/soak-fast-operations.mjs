#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { createOperationsHarness, ROOT, pause } from '../test-v3/fixtures/fast-operations/harness.mjs';
import { socialReplyBatch, SIMULATED_SELECTORS } from '../src/runtime/operations-workflows.mjs';

const execFile = promisify(execFileCallback);
const outputDir = path.resolve(process.env.TASKMASTER_FAST_OUTPUT || process.argv[2] || path.join(ROOT, 'outputs', `fast-soak-${Date.now()}`));
const durationMs = Number(process.env.TASKMASTER_SOAK_DURATION_MS || 24 * 3600000);
const sampleMs = Number(process.env.TASKMASTER_SOAK_SAMPLE_MS || 60000);
if (!Number.isSafeInteger(durationMs) || durationMs < 5000 || !Number.isSafeInteger(sampleMs) || sampleMs < 1000 || sampleMs > 60000) throw new Error('Use duration >=5000ms and sample interval 1000..60000ms');
const maxGapMs = Math.max(120000, sampleMs * 3);
const startedAt = new Date().toISOString();
let runStarted;
let lastSample;
let h;
let operation;
let failure;
let cleanup;
let cancelled = false;
let samples = 0;
let maxObservedGapMs = 0;
let initialResources;
let latestResources;
const interruptions = [];
const injections = [];
const controller = new AbortController();
const cancel = () => { cancelled = true; controller.abort(); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, cancel);

async function processResources(managerPid) {
  if (!Number.isSafeInteger(managerPid) || managerPid <= 0) return { observable: false, reason: 'Manager PID unavailable' };
  if (process.platform === 'win32') {
    // Only numeric ownership/resource fields leave this query. No command lines,
    // browser credentials or unrelated application details are recorded.
    const source = `$items=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime; $owned=[System.Collections.Generic.HashSet[int]]::new(); [void]$owned.Add(${managerPid}); do {$added=$false; foreach($item in $items){if($owned.Contains([int]$item.ParentProcessId) -and $owned.Add([int]$item.ProcessId)){$added=$true}}}while($added); @($items | Where-Object {$owned.Contains([int]$_.ProcessId)} | ForEach-Object {@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;rssBytes=[long]$_.WorkingSetSize;cpuMs=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000}}) | ConvertTo-Json -Compress`;
    const { stdout } = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    const parsed = JSON.parse(stdout || '[]');
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return { observable: true, processCount: rows.length, rssBytes: rows.reduce((sum, item) => sum + item.rssBytes, 0), cumulativeCpuMs: rows.reduce((sum, item) => sum + item.cpuMs, 0), pids: rows.map((item) => item.pid) };
  }
  const { stdout } = await execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,time='], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const rows = stdout.trim().split('\n').map((line) => { const [pid, parent, rssKb, cpuTime] = line.trim().split(/\s+/u); return { pid: Number(pid), parent: Number(parent), rssBytes: Number(rssKb) * 1024, cpuTime }; });
  const owned = new Set([managerPid]);
  let changed;
  do { changed = false; for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } } while (changed);
  const selected = rows.filter((row) => owned.has(row.pid));
  return { observable: true, processCount: selected.length, rssBytes: selected.reduce((sum, row) => sum + row.rssBytes, 0), pids: [...owned], cpuTimeByPid: selected.map(({ pid, cpuTime }) => ({ pid, cpuTime })) };
}

async function saveStatus(state, extra = {}) {
  await writeFile(path.join(outputDir, 'soak-status.json'), JSON.stringify({ schemaVersion: 1, state, pid: process.pid, startedAt, supervisedSince: runStarted ? new Date(runStarted).toISOString() : null, updatedAt: new Date().toISOString(), targetDurationMs: durationMs, actualElapsedMs: runStarted ? Date.now() - runStarted : 0, samples, maxGapMs, maxObservedGapMs, operationId: operation?.id, taskId: operation?.taskId, stateDir: h?.stateDir, fixtureOrigin: h?.fixture.origin, interruptions, injections, ...extra }, null, 2));
}

async function injection(name, fn) {
  const at = Date.now();
  await fn();
  injections.push({ name, passed: true, at: new Date(at).toISOString(), elapsedMs: Date.now() - at });
  await saveStatus('running');
}

try {
  await mkdir(outputDir, { recursive: true });
  await saveStatus('starting');
  h = await createOperationsHarness({ outputDir, label: `soak-${Date.now()}` });
  operation = await h.start('social', { safetyConditions: { loginExpired: { target: { selector: '#login-expired' }, state: 'visible' } }, schedule: { timezone: 'Asia/Shanghai', nextAt: new Date(Date.now() + Math.max(1000, sampleMs)).toISOString(), intervalMs: Math.max(60000, sampleMs), misfire: 'once', maxRunsPerWindow: 120 } });
  assert.equal((await h.navigate(operation.id, `${h.fixture.origin}/social`)).status, 'confirmed');
  const navigationAction = (await h.cli(['ops', 'get', operation.id])).actions.find((item) => item.kind === 'navigate').actionId;
  assert.equal((await h.command(operation.id, 'wait', { watch: true, watchId: 'soak-follow-up', pollMs: 1000, condition: { target: { selector: '#follow-up' }, text: 'soak-event' }, eventType: 'soak.business-event' })).status, 'confirmed');
  runStarted = Date.now(); lastSample = runStarted;
  while (!controller.signal.aborted && Date.now() - runStarted < durationMs) {
    const loopStarted = Date.now();
    const gap = loopStarted - lastSample;
    maxObservedGapMs = Math.max(maxObservedGapMs, gap);
    if (gap > maxGapMs) interruptions.push({ type: 'supervision-gap-or-suspend', at: new Date().toISOString(), gapMs: gap });
    lastSample = loopStarted;
    const elapsed = loopStarted - runStarted;
    operation = await h.cli(['ops', 'get', operation.id]);
    if (operation.task?.state !== 'waiting' || operation.task.waiting?.reason !== 'operations-command') throw new Error(`Unexpected idle task state: ${operation.task?.state}`);
    const heartbeatAgeMs = Date.now() - Date.parse(operation.task.heartbeatAt);
    if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > 30000) interruptions.push({ type: 'worker-heartbeat-gap', at: new Date().toISOString(), heartbeatAgeMs });
    const manager = await h.managerMetadata();
    latestResources = await processResources(manager.pid);
    if (!initialResources && latestResources.observable) initialResources = latestResources;
    if (initialResources && latestResources.observable && (latestResources.rssBytes > Math.max(4 * 1024 ** 3, initialResources.rssBytes + 1024 ** 3) || latestResources.processCount > initialResources.processCount + 12)) throw new Error('Owned process/RSS guard exceeded; inspect retained resource samples');
    const health = await h.command(operation.id, 'wait', { health: true });
    assert.equal(health.status, 'confirmed');
    const events = await h.cli(['ops', 'events', operation.id]);
    const sample = { at: new Date().toISOString(), elapsedMs: elapsed, heartbeatAgeMs, taskId: operation.taskId, taskState: operation.task.state, resources: latestResources, watcherHealth: health.result, pendingEvents: events.pending, hostCalls: operation.counters.hostCalls, actualTokens: { input: operation.counters.inputTokens, output: operation.counters.outputTokens }, monitor: { rssBytes: process.memoryUsage().rss, cpuUsage: process.cpuUsage() } };
    await appendFile(path.join(outputDir, 'resource-samples.jsonl'), `${JSON.stringify(sample)}\n`, { mode: 0o600 });
    samples += 1;
    if (!injections.some((item) => item.name === 'quiet-no-host-requests')) await injection('quiet-no-host-requests', async () => { assert.equal(operation.counters.hostCalls, 0); });
    if (elapsed >= durationMs * 0.05 && !injections.some((item) => item.name === 'event-burst-navigation')) await injection('event-burst-navigation', async () => {
      await h.control({ followUp: 'soak-event' });
      assert.equal((await h.navigate(operation.id, `${h.fixture.origin}/new-entry/social`)).status, 'confirmed');
      for (let index = 0; index < 3; index += 1) assert.equal((await h.command(operation.id, 'wait', { watch: true, watchId: `burst-${index}`, pollMs: 200, once: true, condition: { target: { selector: '#follow-up' }, text: 'soak-event' }, eventType: 'soak.burst' })).status, 'confirmed');
      await pause(300);
      assert.ok((await h.cli(['ops', 'events', operation.id])).events.some((item) => item.type === 'soak.business-event'));
    });
    if (elapsed >= durationMs * 0.1 && !injections.some((item) => item.name === 'login-expired-condition')) await injection('login-expired-condition', async () => {
      const effectsBefore = (await h.state()).effects.length;
      await h.control({ loginExpired: true });
      assert.equal((await h.navigate(operation.id, `${h.fixture.origin}/social`)).status, 'unknown');
      const denied = await h.observe(operation.id);
      assert.equal(denied.status, 'stopped'); assert.equal(denied.reason, 'LOGIN_EXPIRED');
      assert.ok((await h.cli(['ops', 'events', operation.id])).events.some((item) => item.type === 'login.expired'));
      assert.equal((await h.state()).effects.length, effectsBefore);
      const uncertain = (await h.cli(['ops', 'get', operation.id])).actions.filter((item) => ['initiated', 'unknown'].includes(item.status)).map((item) => item.actionId);
      await h.control({ loginExpired: false });
      assert.equal((await h.command(operation.id, 'reconcile', { actionIds: uncertain, refresh: true, verify: [{ url: `${h.fixture.origin}/social` }, { target: { selector: '#login-expired' }, state: 'hidden' }] })).status, 'confirmed');
    });
    if (elapsed >= durationMs * 0.15 && !injections.some((item) => item.name === 'account-identity-change')) await injection('account-identity-change', async () => {
      await h.control({ accountChanged: true });
      assert.equal((await h.navigate(operation.id, `${h.fixture.origin}/social`)).status, 'unknown');
      const obs = await h.observe(operation.id);
      assert.equal(obs.status, 'stopped');
      assert.equal(obs.reason, 'ACCOUNT_CHANGED');
      assert.equal(obs.result.items, undefined);
      const uncertain = (await h.cli(['ops', 'get', operation.id])).actions.filter((item) => ['initiated', 'unknown'].includes(item.status)).map((item) => item.actionId);
      await h.control({ accountChanged: false });
      // Explicit read-only refresh re-establishes real identity, not a guessed login state.
      assert.equal((await h.command(operation.id, 'reconcile', { actionIds: uncertain, refresh: true, verify: [{ url: `${h.fixture.origin}/social` }, { target: { selector: '[data-account-id]' }, attribute: 'data-account-id', equals: 'account-1' }] })).status, 'confirmed');
    });
    if (elapsed >= durationMs * 0.3 && !injections.some((item) => item.name === 'human-takeover-resume')) await injection('human-takeover-resume', async () => {
      await h.cli(['ops', 'takeover', operation.id]);
      const locked = await h.cli(['ops', 'get', operation.id]); assert.equal(locked.manualLock, true); assert.equal(locked.mode, 'operations');
      await h.cli(['ops', 'resume', operation.id]);
      await h.waitOperation(operation.id, (item) => item.pending === null && item.task?.state === 'waiting');
      assert.equal((await h.observe(operation.id)).status, 'confirmed');
    });
    if (elapsed >= durationMs * 0.2 && !injections.some((item) => item.name === 'submit-disconnect-reconcile')) await injection('submit-disconnect-reconcile', async () => {
      await h.control({ disconnectAfterSubmit: true });
      const obs = await h.observe(operation.id);
      const text = 'Explicit isolated soak fault-injection reply';
      const batch = socialReplyBatch({ decision: { id: `soak-submit-${runStarted}`, approved: true, ruleEvidence: 'Human review required', reason: 'Explicit isolated disconnect injection' }, selectors: SIMULATED_SELECTORS.social, record: { platform: 'local-simulation', communityId: 'community-1', postId: 'post-1', conversationId: 'thread-1' }, replyText: text });
      assert.equal((await h.command(operation.id, 'batch', batch, { pageId: obs.pageId, pageVersion: obs.pageVersion })).status, 'unknown');
      const affected = await h.cli(['ops', 'get', operation.id]);
      const actionIds = affected.actions.filter((item) => ['initiated', 'unknown'].includes(item.status)).map((item) => item.actionId);
      const effects = (await h.state()).effects.length;
      await h.control({ disconnectAfterSubmit: false });
      assert.equal((await h.command(operation.id, 'reconcile', { refresh: true, actionIds, verify: [{ target: { selector: '#reply-result' }, text }] })).status, 'confirmed');
      assert.equal((await h.state()).effects.length, effects);
    });
    if (elapsed >= durationMs * 0.5 && !injections.some((item) => item.name === 'manager-restart-reconcile')) await injection('manager-restart-reconcile', async () => {
      const previousTaskId = operation.taskId;
      await h.cli(['manager', 'stop']);
      await h.cli(['manager', 'start']);
      assert.equal((await h.observe(operation.id)).status, 'confirmed');
      assert.equal((await h.command(operation.id, 'reconcile', { url: `${h.fixture.origin}/social`, actionIds: [navigationAction], verify: [{ url: `${h.fixture.origin}/social` }, { target: { selector: '#rules' }, includes: 'Human review' }] })).status, 'confirmed');
      operation = await h.cli(['ops', 'get', operation.id]);
      assert.notEqual(operation.taskId, previousTaskId);
      assert.equal(operation.status, 'running');
      assert.equal((await h.command(operation.id, 'wait', { watch: true, watchId: 'after-restart', pollMs: 1000, condition: { target: { selector: '#follow-up' }, text: 'never-matches' } })).status, 'confirmed');
    });
    await saveStatus('running', { latestResources });
    const remaining = Math.min(sampleMs - (Date.now() - loopStarted), durationMs - (Date.now() - runStarted));
    for (let waited = 0; waited < remaining && !controller.signal.aborted; waited += 1000) await pause(Math.min(1000, remaining - waited));
    const stopFile = await readFile(path.join(outputDir, 'STOP'), 'utf8').catch(() => null);
    if (stopFile !== null) cancel();
  }
  if (!cancelled) await injection('cancel-cleanup', async () => { await h.stop(operation.id); });
} catch (error) { failure = { code: error.code || 'SOAK_FAILED', message: error.message, stack: error.stack }; }
finally { if (h) cleanup = await h.finish(); }
const actualElapsedMs = runStarted ? Date.now() - runStarted : 0;
const requiredInjections = ['quiet-no-host-requests', 'event-burst-navigation', 'login-expired-condition', 'account-identity-change', 'submit-disconnect-reconcile', 'human-takeover-resume', 'manager-restart-reconcile', 'cancel-cleanup'];
const functionalPassed = !failure && !cancelled && cleanup?.ok === true && requiredInjections.every((name) => injections.some((item) => item.name === name && item.passed));
const report = { ok: functionalPassed, preliminary24HourGatePassed: functionalPassed && actualElapsedMs >= 24 * 3600000 && durationMs >= 24 * 3600000 && interruptions.length === 0, startedAt, finishedAt: new Date().toISOString(), targetDurationMs: durationMs, actualElapsedMs, samples, maxGapMs, maxObservedGapMs, interruptions, injections, cleanup, cancelled, initialResources, latestResources, resourceGuard: 'owned RSS <= max(4GiB, first+1GiB), owned process count <= first+12; raw trend retained', actualModelTokens: 'unobservable; no estimate substituted', compatibility: 'isolated local fixture only; native Codex wakeup/real business not tested', ...(failure ? { error: failure } : {}) };
await writeFile(path.join(outputDir, 'soak-report.json'), JSON.stringify(report, null, 2));
await saveStatus(cancelled ? 'cancelled' : report.ok ? 'finished' : 'failed', { report });
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
