#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOperationsHarness, ROOT, pause } from '../test-v3/fixtures/fast-operations/harness.mjs';
import { socialReplyBatch, advertisingBatch, websiteBatch, SIMULATED_SELECTORS as S } from '../src/runtime/operations-workflows.mjs';

const execFile = promisify(execFileCallback);
const outputDir = path.resolve(process.env.TASKMASTER_FAST_OUTPUT || process.argv[2] || path.join(ROOT, 'outputs', `fast-operations-${Date.now()}`));
const checks = [];
const timings = [];
const record = (name, detail = {}) => { checks.push({ name, passed: true, ...detail }); process.stdout.write(`${JSON.stringify({ check: name, passed: true })}\n`); };
const quantile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
let h;
let failure;
let cleanup;
try {
  h = await createOperationsHarness({ outputDir, label: `fast-${Date.now()}` });
  await h.cli(['profiles', 'mode', h.profile.id, '--mode', 'batch']);
  const main = await h.start('social', {
    hostAdapter: { executable: process.execPath, args: [path.join(ROOT, 'test-v3/fixtures/fast-operations/host-adapter.mjs')] },
    schedule: { timezone: 'Asia/Shanghai', nextAt: new Date(Date.now() + 1500).toISOString(), intervalMs: 3600000, maxRunsPerWindow: 4, misfire: 'once' }
  });
  assert.equal(main.mode, 'operations');
  assert.equal((await h.cli(['profiles', 'list'])).profiles.find((item) => item.id === h.profile.id).modePolicy, 'batch');
  record('explicit prompt operations mode overrides Profile batch default for this task only');
  const taskId = main.taskId;
  const firstStarted = performance.now();
  assert.equal((await h.navigate(main.id, `${h.fixture.origin}/social`)).status, 'confirmed');
  timings.push({ phase: 'first-navigation', elapsedMs: performance.now() - firstStarted });
  const initial = await h.observe(main.id, { scope: '#context', maxChars: 2500, requestDecision: { summary: 'Review isolated community rules and approve a response', context: { postId: 'post-1', conversationId: 'thread-1' } } });
  assert.equal(initial.status, 'confirmed');
  assert.ok(initial.result.items.some((item) => item.text.includes('Human review required')));
  assert.ok(!JSON.stringify(initial).includes('secret-sentinel'));
  record('scoped observation retains community rules and excludes private fixtures');
  const delta = await h.observe(main.id, { scope: '#context', maxChars: 2500, baselineId: initial.result.baselineId });
  assert.equal(delta.result.delta, true); assert.equal(delta.result.items.length, 0);
  const reset = await h.observe(main.id, { scope: '#context', baselineId: 'invalid-baseline' });
  assert.equal(reset.result.baselineReset, true);
  record('quiet delta and invalid baseline reset');
  await pause(500);
  let eventRows = (await h.cli(['ops', 'events', main.id])).events;
  const review = eventRows.find((event) => event.type === 'decision.required' && event.dedupeKey.startsWith('review:'));
  assert.ok(review);
  const observation = await h.observe(main.id, { scope: '#context' });
  const replyText = 'Approved isolated reply: reliability and clear instructions matter.';
  const social = socialReplyBatch({ decision: { approved: true, id: 'social-decision-1', reason: 'Test operator approved exact text', ruleEvidence: 'Human review required' }, selectors: S.social, record: { platform: 'local-simulation', communityId: 'community-1', postId: 'post-1', conversationId: 'thread-1', readThrough: 'comment-1' }, replyText });
  assert.equal((await h.decide(main.id, review, social, observation)).status, 'confirmed');
  assert.equal((await h.state()).replies.length, 1);
  const afterSocial = await h.cli(['ops', 'get', main.id]);
  assert.equal(afterSocial.taskId, taskId);
  assert.ok(afterSocial.actions.filter((action) => action.kind === 'social.reply').every((action) => action.status === 'confirmed'));
  assert.ok(afterSocial.records.some((item) => item.kind === 'social'));
  record('real CLI → Manager → worker → Chrome → durable action → main decision → same task reply closure', { taskId });
  const watcher = await h.command(main.id, 'wait', { watch: true, watchId: 'follow-up', condition: { target: { selector: '#follow-up' }, text: 'A reader replied' }, eventType: 'social.follow-up', pollMs: 200 });
  assert.equal(watcher.status, 'confirmed');
  await h.control({ followUp: 'A reader replied' });
  assert.equal((await h.navigate(main.id, `${h.fixture.origin}/new-entry/social`)).status, 'confirmed');
  await pause(350);
  eventRows = (await h.cli(['ops', 'events', main.id])).events;
  assert.ok(eventRows.some((event) => event.type === 'social.follow-up'));
  const scheduled = eventRows.find((event) => event.type === 'scheduled');
  assert.ok(scheduled, 'real Manager scheduler produced an event');
  await h.cli(['ops', 'ack', main.id, '--input', JSON.stringify({ eventId: scheduled.id })]);
  const scheduledCommand = `scheduled-inspect-${Date.now()}`;
  await h.cli(['ops', 'decide', main.id, '--input', JSON.stringify({ eventId: scheduled.id, authorizationVersion: 1, summary: 'Main test driver chooses read-only scheduled inspection', command: { commandId: scheduledCommand, kind: 'observe', payload: { scope: '#follow-up' } } })]);
  const scheduledDone = await h.waitOperation(main.id, (op) => op.commands.some((item) => item.commandId === scheduledCommand && item.reply));
  assert.equal(scheduledDone.taskId, taskId);
  record('schedule → durable event → explicit receipt → main-Agent supplied decision → same worker continuation');
  record('page watcher rebounds after changed entry path and detects follow-up');
  const fullObservation = await h.observe(main.id, { maxItems: 80 });
  assert.ok(!JSON.stringify(fullObservation).includes('secret-sentinel'));
  const screenshot = await h.command(main.id, 'screenshot', { target: { selector: '#context' } });
  assert.equal(screenshot.status, 'confirmed'); assert.ok(screenshot.evidenceRef?.endsWith('.png'));
  record('bounded region screenshot artifact');
  await h.control({ longRules: true });
  assert.equal((await h.navigate(main.id, `${h.fixture.origin}/social`)).status, 'confirmed');
  let ruleChunk = await h.observe(main.id, { scope: '#rules', maxItems: 1, maxChars: 4000 });
  assert.equal(ruleChunk.status, 'confirmed');
  const originalRuleLength = ruleChunk.result.items[0].textRange.total;
  assert.ok(originalRuleLength > 4000);
  assert.ok(ruleChunk.result.omitted.textCharacters > 0);
  let ruleText = ruleChunk.result.items[0].text;
  let chunks = 1;
  while (ruleChunk.result.items[0].textContinuation) {
    assert.ok(chunks < 10, 'long-rule continuation must make bounded progress');
    ruleChunk = await h.observe(main.id, { ...ruleChunk.result.items[0].textContinuation, maxChars: 4000 });
    assert.equal(ruleChunk.status, 'confirmed');
    ruleText += ruleChunk.result.items[0].text; chunks += 1;
  }
  assert.equal(ruleText.length, originalRuleLength);
  assert.ok(ruleText.endsWith('END-OF-LONG-RULES'));
  assert.equal(ruleChunk.result.items[0].textRange.end, originalRuleLength);
  record('long community rules disclose truncation and scoped textOffset continuation recovers the exact complete text', { chunks, originalRuleLength });
  await h.control({ longRules: false });
  assert.equal((await h.navigate(main.id, `${h.fixture.origin}/social`)).status, 'confirmed');
  await h.cli(['ops', 'takeover', main.id]);
  const denied = await h.cli(['ops', 'command', main.id, '--input', JSON.stringify({ commandId: 'during-takeover', kind: 'batch', payload: social })], { expectedFailure: true });
  assert.ok(denied.error);
  await h.cli(['ops', 'resume', main.id]);
  await h.waitOperation(main.id, (op) => op.pending === null && op.task?.state === 'waiting');
  const staleBatch = await h.command(main.id, 'batch', social, { pageId: observation.pageId, pageVersion: observation.pageVersion });
  assert.equal(staleBatch.reason, 'OBSERVATION_REQUIRED');
  record('human takeover is a pause lock, not an execution mode; resume invalidates old observations');
  // Comparable mechanical work. Both variants use the same page and write no external resource.
  const benchmark = async (batched, trial) => {
    const started = performance.now();
    let obs = await h.observe(main.id, { scope: '#reply' });
    assert.equal(obs.status, 'confirmed');
    const actions = [1, 2, 3].map((step) => ({ actionId: `bench-${batched}-${trial}-${step}`, type: 'fill', effect: false, target: { selector: '#reply' }, value: `benchmark-${trial}-${step}`, expected: { target: { selector: '#reply' }, value: `benchmark-${trial}-${step}` } }));
    if (batched) assert.equal((await h.command(main.id, 'batch', { preconditions: [{ target: { selector: '#rules' }, includes: 'Human review' }], stopConditions: [], actions, verify: [actions.at(-1).expected] }, { pageId: obs.pageId, pageVersion: obs.pageVersion })).status, 'confirmed');
    else for (const [index, action] of actions.entries()) {
      assert.equal((await h.command(main.id, 'batch', { preconditions: [{ target: { selector: '#rules' }, includes: 'Human review' }], stopConditions: [], actions: [action], verify: [action.expected] }, { pageId: obs.pageId, pageVersion: obs.pageVersion })).status, 'confirmed');
      if (index < actions.length - 1) { obs = await h.observe(main.id, { scope: '#reply' }); assert.equal(obs.status, 'confirmed'); }
    }
    assert.equal((await h.command(main.id, 'wait', { condition: actions.at(-1).expected, timeoutMs: 1000 })).status, 'confirmed');
    timings.push({ phase: batched ? 'warm-batched' : 'warm-stepwise', trial, elapsedMs: performance.now() - started, logicalCommandRoundtrips: batched ? 3 : 7, status: 'confirmed', finalValue: actions.at(-1).value });
  };
  for (let trial = 0; trial < 3; trial += 1) { await benchmark(false, trial); await benchmark(true, trial); }
  record('same-page stepwise versus bounded batch timing samples', { repeatsPerVariant: 3, measurement: 'CLI/browser wall time; model latency/token unavailable' });
  await h.stop(main.id);
  await h.cli(['profiles', 'mode', h.profile.id, '--mode', 'auto']);
  const skillMode = await h.start('social', { mode: 'auto', skillMode: 'operations', intent: 'finite' });
  assert.equal(skillMode.mode, 'operations');
  await h.stop(skillMode.id);
  const finite = await h.start('social', { mode: 'batch' });
  assert.equal(finite.mode, 'batch');
  assert.equal((await h.navigate(finite.id, `${h.fixture.origin}/social`)).status, 'confirmed');
  await h.waitOperation(finite.id, (op) => op.task?.state === 'finished');
  await h.stop(finite.id);
  record('Profile auto uses Skill operational intent; explicit batch finishes after one finite action group');

  for (const platform of ['Google', 'Meta']) {
    await h.control({ meta: platform === 'Meta', insufficient: false });
    const ads = await h.start('ads', { businessContext: { currency: { selector: '#currency', expected: 'USD' }, budgetType: { selector: '#budget-type', expected: 'daily' }, dataAsOf: { selector: '#data-as-of' } } });
    assert.equal((await h.navigate(ads.id, `${h.fixture.origin}/ads`)).status, 'confirmed');
    const inspected = await h.observe(ads.id, { requestDecision: { summary: `Inspect ${platform}-labelled simulated performance before budget change` } });
    const before = (await h.state()).budget;
    const dataAsOf = inspected.result.items.find((item) => item.domId === 'data-as-of')?.text;
    assert.ok(Number.isFinite(Date.parse(dataAsOf)), 'exact data-as-of field must be readable');
    const batch = advertisingBatch({ decision: { approved: true, id: `${platform}-decision`, reason: 'Isolated bounded adjustment' }, selectors: S.ads, record: { platform, accountId: 'account-1', campaignId: 'campaign-1', before, currency: 'USD', budgetType: 'daily', dataRange: 'last 7 days', dataAsOf, attribution: '7-day click', sufficient: true }, nextBudget: before + 5 });
    const event = (await h.cli(['ops', 'events', ads.id])).events.find((item) => item.dedupeKey.startsWith('review:'));
    assert.equal((await h.decide(ads.id, event, batch, inspected)).status, 'confirmed');
    assert.equal((await h.state()).budget, before + 5);
    await h.control({ insufficient: true });
    assert.equal((await h.navigate(ads.id, `${h.fixture.origin}/new-entry/ads`)).status, 'confirmed');
    const insufficient = await h.observe(ads.id);
    const blocked = await h.command(ads.id, 'batch', { ...batch, actions: batch.actions.map((action) => ({ ...action, actionId: `${action.actionId}-insufficient` })) }, { pageId: insufficient.pageId, pageVersion: insufficient.pageVersion });
    assert.equal(blocked.reason, 'PRECONDITION_FAILED');
    record(`${platform}-labelled simulated inspect → decision → adjust → readback → insufficient-data stop`, { before, after: before + 5, dataAsOfRead: Boolean(dataAsOf) });
    await h.stop(ads.id);
  }
  await h.control({ insufficient: false });
  const site = await h.start('site');
  assert.equal((await h.navigate(site.id, `${h.fixture.origin}/site`)).status, 'confirmed');
  const inspected = await h.observe(site.id, { requestDecision: { summary: 'Review domain/resource/original setting and rollback before save' } });
  const siteBatch = websiteBatch({ decision: { approved: true, id: 'site-decision', reason: 'Isolated configuration test' }, selectors: S.site, record: { accountId: 'account-1', domain: 'example.test', resourceId: 'config-1', before: 'old-value', rollback: 'Restore old-value through same authorized form' }, nextValue: 'new-value' });
  const siteEvent = (await h.cli(['ops', 'events', site.id])).events.find((item) => item.dedupeKey.startsWith('review:'));
  assert.equal((await h.decide(site.id, siteEvent, siteBatch, inspected)).status, 'confirmed');
  let saved = await h.cli(['ops', 'get', site.id]);
  assert.equal(saved.records.at(-1).propagation, 'pending');
  await h.control({ effective: true });
  assert.equal((await h.navigate(site.id, `${h.fixture.origin}/new-entry/site`)).status, 'confirmed');
  assert.equal((await h.command(site.id, 'wait', { condition: { target: { selector: '#propagation' }, text: 'effective' }, timeoutMs: 1500 })).status, 'confirmed');
  record('website identity/original → decision → save/readback → separate propagation/effective check with rollback evidence');
  await h.control({ disconnectAfterSubmit: true });
  const unknownObs = await h.observe(site.id);
  const unknownBatch = websiteBatch({ decision: { approved: true, id: 'site-unknown', reason: 'Submit-then-disconnect injection' }, selectors: S.site, record: { accountId: 'account-1', domain: 'example.test', resourceId: 'config-1', before: 'new-value', rollback: 'Restore new-value' }, nextValue: 'uncertain-value' });
  assert.equal((await h.command(site.id, 'batch', unknownBatch, { pageId: unknownObs.pageId, pageVersion: unknownObs.pageVersion })).status, 'unknown');
  assert.equal((await h.state()).config, 'uncertain-value');
  const effectCount = (await h.state()).effects.length;
  const retry = await h.cli(['ops', 'command', site.id, '--input', JSON.stringify({ commandId: 'must-not-retry', kind: 'batch', payload: unknownBatch })], { expectedFailure: true });
  assert.ok(retry.error);
  assert.equal((await h.state()).effects.length, effectCount);
  await h.control({ disconnectAfterSubmit: false });
  // Navigation is itself a page mutation and is blocked while write status is unknown.
  // A fresh readback is obtained by the human/test browser refresh control at the fixture.
  const current = await h.observe(site.id);
  const uncertain = (await h.cli(['ops', 'get', site.id])).actions.filter((item) => ['initiated', 'unknown'].includes(item.status)).map((item) => item.actionId);
  const unresolved = await h.command(site.id, 'reconcile', { actionIds: uncertain, verify: [{ target: { selector: '#current-value' }, text: 'uncertain-value' }] });
  assert.equal(unresolved.reason, 'RECONCILE_UNRESOLVED');
  const reconciled = await h.command(site.id, 'reconcile', { actionIds: uncertain, refresh: true, verify: [{ target: { selector: '#current-value' }, text: 'uncertain-value' }] });
  assert.equal(reconciled.status, 'confirmed');
  assert.equal((await h.state()).effects.length, effectCount);
  record('submit-then-disconnect persists unknown effect; stale readback rejected; refreshed readback reconciles without replay', { uncertainActionIds: uncertain, effectsAfterRetry: effectCount, pageVersion: current.pageVersion });
  await h.stop(site.id);
  const storeSource = await readFile(path.join(h.stateDir, 'operations', 'operations.json'), 'utf8');
  assert.ok(!storeSource.includes('secret-sentinel'));
  record('saved operation ledger excludes secret sentinels');
} catch (error) { failure = { code: error.code || 'FAST_ACCEPTANCE_FAILED', message: error.message, stack: error.stack }; }
finally { if (h) cleanup = await h.finish(); }
await mkdir(outputDir, { recursive: true });
const revision = await execFile('git', ['rev-parse', 'HEAD'], { cwd: ROOT, windowsHide: true }).then((value) => value.stdout.trim()).catch(() => null);
const summary = Object.fromEntries(['warm-stepwise', 'warm-batched'].map((phase) => {
  const values = timings.filter((row) => row.phase === phase).map((row) => row.elapsedMs);
  return [phase, { samples: values.length, medianMs: values.length ? quantile(values, 0.5) : null, p95Ms: values.length ? quantile(values, 0.95) : null }];
}));
const report = { ok: !failure && cleanup?.ok === true, checkedAt: new Date().toISOString(), revision, sourceDirty: true, isolatedStateDir: h?.stateDir, installedRuntimeModified: false, checks, timings, summary, cleanup, model: { mainAgentRequests: 'unobservable in script-driven fixture', actualInputTokens: 'unobservable', actualOutputTokens: 'unobservable', reasoningTime: 'unobservable' }, capabilityBoundary: { tested: 'local stateful simulation through real Task Master CLI/Manager/worker/Chrome', nativeCodexSessionEnded: 'adapter-required; unverified', nativeCodexAppClosed: 'adapter-required; unverified', realPlatforms: 'not authorized or tested', real24HourSoak: 'separate gate' }, ...(failure ? { error: failure } : {}) };
await writeFile(path.join(outputDir, 'acceptance-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
