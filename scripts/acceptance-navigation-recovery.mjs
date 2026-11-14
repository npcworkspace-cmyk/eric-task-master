#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOperationsHarness, ROOT } from '../test-v3/fixtures/fast-operations/harness.mjs';
import { assertFreshLiveOutput, transportFixture } from './acceptance-live-chaos.mjs';

const outputDir = path.resolve(process.argv[2] || path.join(ROOT, '..', 'outputs', `navigation-recovery-${Date.now()}`));
await assertFreshLiveOutput(outputDir);
const checks = [];
let h, failure, cleanup;
const add = (name, details = {}) => { checks.push({ name, passed: true, ...details }); process.stdout.write(`${JSON.stringify({ check: name, passed: true })}\n`); };
try {
  h = await createOperationsHarness({ outputDir, label: 'non-effect-navigation-recovery', startFixture: transportFixture });
  const operation = await h.start('social', { authorization: {
    accountId: 'account-1', resourceIds: ['post-1', 'config-1'], origins: [h.fixture.origin],
    allowedActions: ['navigate'], expiresAt: new Date(Date.now() + 3600000).toISOString()
  } });
  const taskId = operation.taskId;
  const first = await h.navigate(operation.id, h.fixture.origin + '/social');
  assert.equal(first.status, 'confirmed');
  const pageId = first.pageId;
  const destination = h.fixture.origin + '/site';
  const expected = { url: destination };
  const actionId = 'social-to-site-navigation-unknown';
  await h.control({ networkLoss: true });
  const source = await h.observe(operation.id, { scope: '#context' });
  assert.equal(source.status, 'confirmed');
  const interrupted = await h.command(operation.id, 'batch', {
    preconditions: [{ url: h.fixture.origin + '/social' }], stopConditions: [],
    actions: [{ actionId, type: 'navigate', effect: false, value: destination, expected }], verify: [expected]
  }, { commandId: 'navigation-under-get-network-loss', pageId: source.pageId, pageVersion: source.pageVersion });
  assert.equal(interrupted.status, 'unknown');
  let current = await h.cli(['ops', 'get', operation.id]);
  const original = current.actions.find((row) => row.actionId === actionId);
  assert.equal(original.resourceId, 'post-1'); assert.equal(original.kind, 'navigate'); assert.equal(original.effect, false);
  assert.equal((await h.state()).effects.length, 0);
  add('real social→site GET interruption records source post-1 and exact original destination, with zero external save');
  await h.control({ networkLoss: false });
  const wrongUrl = await h.command(operation.id, 'reconcile', { url: h.fixture.origin + '/social', actionIds: [actionId], verify: [{ url: h.fixture.origin + '/social' }] }, { commandId: 'reject-source-url-as-navigation-success' });
  assert.equal(wrongUrl.status, 'stopped');
  assert.equal((await h.cli(['ops', 'get', operation.id])).actions.find((row) => row.actionId === actionId).status, 'unknown');
  add('returning to source and checking an unrelated URL cannot falsely confirm navigation', { reason: wrongUrl.reason });
  const wrongResource = await h.command(operation.id, 'reconcile', { url: h.fixture.origin + '/ads', actionIds: [actionId], verify: [{ url: h.fixture.origin + '/ads' }] }, { commandId: 'reject-out-of-scope-readback-resource' });
  assert.equal(wrongResource.status, 'stopped');
  assert.equal((await h.cli(['ops', 'get', operation.id])).actions.find((row) => row.actionId === actionId).status, 'unknown');
  add('actual destination resource outside authorization is rejected', { reason: wrongResource.reason });
  await h.control({ accountChanged: true });
  const wrongAccount = await h.command(operation.id, 'reconcile', { url: destination, actionIds: [actionId], verify: [expected] }, { commandId: 'reject-changed-actual-account' });
  assert.equal(wrongAccount.status, 'stopped');
  assert.equal((await h.cli(['ops', 'get', operation.id])).actions.find((row) => row.actionId === actionId).status, 'unknown');
  add('exact URL still cannot bypass actual account protection', { reason: wrongAccount.reason });
  await h.control({ accountChanged: false });
  const recovered = await h.command(operation.id, 'reconcile', { url: destination, actionIds: [actionId], verify: [expected] }, { commandId: 'verify-original-authorized-navigation-target' });
  assert.equal(recovered.status, 'confirmed');
  assert.deepEqual(recovered.result.identity, { accountId: 'account-1', resourceId: 'config-1' });
  current = await h.cli(['ops', 'get', operation.id]);
  const reconciled = current.actions.find((row) => row.actionId === actionId);
  assert.equal(reconciled.status, 'confirmed'); assert.equal(reconciled.resourceId, 'post-1');
  assert.equal(reconciled.destinationReadback.resourceId, 'config-1'); assert.equal(reconciled.destinationReadback.url, destination);
  assert.equal(reconciled.destinationReadback.accountId, 'account-1');
  assert.equal(current.taskId, taskId); assert.equal(recovered.pageId, pageId);
  add('exact original target plus fresh authorized destination identity reconciles without overwriting source identity', { taskId, sourceResourceId: reconciled.resourceId, destinationReadback: reconciled.destinationReadback });
  const after = await h.observe(operation.id, { scope: '#current-value' });
  assert.equal(after.status, 'confirmed');
  const probe = await h.command(operation.id, 'batch', { preconditions: [expected], stopConditions: [], actions: [{ actionId: 'read-only-continuation-after-navigation', type: 'read', target: { selector: '#current-value' } }], verify: [{ target: { selector: '#current-value' }, text: 'old-value' }] }, { commandId: 'same-session-read-only-continuation', pageId: after.pageId, pageVersion: after.pageVersion });
  assert.equal(probe.status, 'confirmed');
  current = await h.waitOperation(operation.id, (row) => row.task?.state === 'waiting' && row.pending === null);
  assert.equal(current.taskId, taskId); assert.equal(probe.pageId, pageId);
  const fixture = await h.state(); assert.equal(fixture.effects.length, 0); assert.equal(fixture.config, 'old-value');
  assert.equal(h.fixture.effectAudit.length, 0);
  assert.equal(current.actions.filter((row) => row.effect !== false).length, 0);
  assert.equal(current.actions.some((row) => ['initiated', 'unknown'].includes(row.status)), false);
  add('original task/page really resumes guarded read-only work; no /api save was ever issued', { taskId, pageId, externalEffects: fixture.effects.length, httpApiRequests: h.fixture.effectAudit.length });
  await writeFile(path.join(outputDir, 'reconciled-navigation-evidence.json'), JSON.stringify({ original, recovered, reconciled, continuation: probe, taskId, pageId }, null, 2));
} catch (error) { failure = { code: error.code || 'NAVIGATION_RECOVERY_FAILED', message: error.message, stack: error.stack }; }
finally { if (h) cleanup = await h.finish(); }
const report = { ok: !failure && cleanup?.ok === true, checkedAt: new Date().toISOString(), outputDir, checks, cleanup, boundary: 'Script-driven isolated functional regression only. No live-root coverage or eight-hour gate claim. Original pre-header transport fault fixture is unchanged.', ...(failure ? { error: failure } : {}) };
await writeFile(path.join(outputDir, 'navigation-recovery-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
