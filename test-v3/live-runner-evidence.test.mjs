import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertFreshLiveOutput, auditBusinessEffects, businessContinuationEvidence, businessRefusalAllowed, liveEvidenceSourceHashes, runLiveChaos, transportFixture } from '../scripts/acceptance-live-chaos.mjs';
import { popupDecisionGate, runLivePopups } from '../scripts/acceptance-live-popups.mjs';
import { startPopupFixture } from './fixtures/live-chaos/popups.mjs';
import { removeTestTree } from './test-fs.mjs';

test('popup defer never calls the completion/retirement path and keeps the same challenge pending', async () => {
  const fixture = await startPopupFixture();
  try {
    await fixture.inject({ challengeId: 'pending-login', scenarioId: 'login-security' });
    let resolutions = 0;
    const result = await popupDecisionGate({ disposition: 'defer' }, async () => { resolutions += 1; await fixture.retire('pending-login'); return { outcome: 'correctly_refused' }; });
    assert.equal(result.accepted, false); assert.equal(result.deferred, true); assert.equal(result.outcome, undefined);
    assert.equal(resolutions, 0); assert.equal(fixture.state.active.id, 'pending-login'); assert.equal(fixture.state.active.retired, undefined);
  } finally { await fixture.close(); }
});

test('both real runner entrypoints reject existing evidence before creating browser or overwriting files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etm-live-output-'));
  try {
    const original = '{"oldEvidence":true}'; await writeFile(path.join(directory, 'report.json'), original);
    await assert.rejects(runLiveChaos({ outputDir: directory, durationMs: 5000, slotMs: 1000, sampleMs: 1000 }), { code: 'OUTPUT_NOT_FRESH' });
    await assert.rejects(runLivePopups({ outputDir: directory, durationMs: 24000, sampleMs: 1000 }), { code: 'OUTPUT_NOT_FRESH' });
    assert.deepEqual(await readdir(directory), ['report.json']);
    assert.equal(await readFile(path.join(directory, 'report.json'), 'utf8'), original);
  } finally { await removeTestTree(directory); }
});

test('fresh output is atomically claimed and cannot be silently reused after partial startup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'etm-live-claim-'));
  try { await assertFreshLiveOutput(directory); await assert.rejects(assertFreshLiveOutput(directory), { code: 'OUTPUT_NOT_FRESH' }); }
  finally { await removeTestTree(directory); }
});

test('fingerprint binds both runners, product, package lock and imported fixture/harness sources', async () => {
  const hashes = await liveEvidenceSourceHashes();
  for (const file of ['scripts/acceptance-live-chaos.mjs', 'scripts/acceptance-live-popups.mjs', 'src/runtime/fast-session.mjs', 'src/runtime/fast-cursor.mjs', 'package.json', 'package-lock.json', 'test-v3/fixtures/live-chaos/popups.mjs', 'test-v3/fixtures/live-chaos/popup-plan.mjs', 'test-v3/fixtures/fast-operations/harness.mjs', 'test-v3/fixtures/fast-operations/server.mjs']) assert.match(hashes[file], /^[a-f0-9]{64}$/u, file);
});

test('refusal cannot satisfy ordinary inspection, reply, changed-entry, network recovery or restart coverage', () => {
  for (const scenario of ['quiet-scheduled-inspection', 'new-reply-data-burst', 'moved-entry-stale-targets', 'slow-network-unknown-result', 'declared-manager-restart']) assert.equal(businessRefusalAllowed(scenario), false);
  for (const scenario of ['changed-before-insufficient-data', 'login-identity-permission-change', 'human-takeover']) assert.equal(businessRefusalAllowed(scenario), true);
});

test('confirmed arbitrary command or cleared flags cannot replace actual healthy same-session continuation', () => {
  const base = { scenarioId: 'quiet-scheduled-inspection', current: { taskId: 'same', status: 'running', pending: null, manualLock: false, task: { state: 'waiting', waiting: { reason: 'operations-command' } } }, previousTaskId: 'same', requestTaskId: 'same', probe: { status: 'confirmed' }, commands: [{ reply: { status: 'confirmed' }, envelope: { kind: 'observe' } }] };
  assert.equal(businessContinuationEvidence(base).ok, true);
  assert.equal(businessContinuationEvidence({ ...base, probe: null }).ok, false);
  assert.equal(businessContinuationEvidence({ ...base, current: { ...base.current, status: 'paused' } }).ok, false);
  assert.equal(businessContinuationEvidence({ ...base, current: { ...base.current, taskId: 'replacement' } }).ok, false);
  assert.equal(businessContinuationEvidence({ ...base, scenarioId: 'declared-manager-restart' }).ok, false);
  const restarted = { ...base, scenarioId: 'declared-manager-restart', current: { ...base.current, taskId: 'new' }, requestTaskId: 'new', commands: [{ reply: { status: 'confirmed' }, envelope: { kind: 'control', payload: { action: 'resume' } } }] };
  const result = businessContinuationEvidence(restarted);
  assert.equal(result.ok, true); assert.equal(result.sameSessionRecovered, false); assert.equal(result.newHealthySegment.taskId, 'new');
  assert.equal(businessContinuationEvidence({ ...restarted, commands: base.commands }).ok, false);
});

function evidence() {
  const expected = { target: { selector: '#current-value' }, text: 'new' };
  return { fixture: { effects: [{ path: '/api/config', at: '2026-11-15T00:00:01Z' }] }, oracle: { effectCountBefore: 0 },
    effectAudit: [{ id: 'http-1', complete: true, effectApplied: true, effectIndex: 0, path: '/api/config', arrivedAt: '2026-11-15T00:00:01Z', body: { value: 'new' }, before: 'old', after: 'new', unknown: false }],
    rootActions: [{ actionId: 'save-1', commandId: 'cmd-1', status: 'confirmed', kind: 'site.configure', accountId: 'account-1', resourceId: 'config-1', before: 'old', proposed: 'new', startedAt: '2026-11-15T00:00:00Z' }],
    commands: [{ commandId: 'cmd-1', envelope: { payload: { actions: [{ actionId: 'save-1', kind: 'site.configure', type: 'click', proposed: 'new', expected }] } } }],
    authorization: { accountId: 'account-1', resourceIds: ['config-1'], allowedActions: ['site.configure'] } };
}

test('every independent HTTP effect must match exactly one actual authorized root business action', () => {
  const good = evidence(); assert.equal(auditBusinessEffects(good).ok, true);
  const duplicate = evidence(); duplicate.fixture.effects.push({ path: '/api/config', at: '2026-11-15T00:00:02Z' }); duplicate.effectAudit.push({ ...duplicate.effectAudit[0], id: 'http-2', effectIndex: 1, arrivedAt: '2026-11-15T00:00:02Z', before: 'new' });
  const repeated = auditBusinessEffects(duplicate); assert.equal(repeated.ok, false); assert.equal(repeated.unknown, false); assert.match(repeated.reason, /duplicate|unmatched/u);
  const unauthorized = evidence(); unauthorized.authorization.allowedActions = []; assert.equal(auditBusinessEffects(unauthorized).ok, false);
  const missing = evidence(); missing.effectAudit = []; assert.equal(auditBusinessEffects(missing).ok, false); assert.equal(auditBusinessEffects(missing).unknown, true);
  const wrongResource = evidence(); wrongResource.rootActions[0].resourceId = 'foreign'; assert.equal(auditBusinessEffects(wrongResource).ok, false);
  const noEffect = evidence(); noEffect.fixture.effects = []; assert.equal(auditBusinessEffects(noEffect).ok, false);
});

test('real loopback duplicate HTTP submissions are retained separately; fixture is not deduped or fault-softened', async () => {
  const fixture = await transportFixture();
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(fixture.origin + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'new' }) });
      assert.equal(response.status, 200); await response.json();
    }
    assert.equal(fixture.state.effects.length, 2); assert.equal(fixture.effectAudit.length, 2);
    assert.deepEqual(fixture.effectAudit.map((row) => row.effectIndex), [0, 1]);
    assert.deepEqual(fixture.effectAudit.map((row) => row.body), [{ value: 'new' }, { value: 'new' }]);
    assert.ok(fixture.effectAudit.every((row) => row.complete && row.effectApplied && !row.unknown));
    const tested = evidence(); tested.fixture = fixture.state; tested.effectAudit = fixture.effectAudit;
    tested.rootActions[0].before = fixture.effectAudit[0].before;
    tested.rootActions[0].startedAt = new Date(Date.parse(fixture.effectAudit[0].arrivedAt) - 1).toISOString();
    const audit = auditBusinessEffects(tested);
    assert.equal(audit.ok, false); assert.equal(audit.matches.length, 1); assert.equal(audit.effectIndex, 1);
  } finally { await fixture.close(); }
});
