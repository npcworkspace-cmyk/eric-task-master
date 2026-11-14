import assert from 'node:assert/strict';
import test from 'node:test';
import { POPUP_FAMILIES, popupPlan, FOUR_HOURS, EIGHT_HOURS } from './fixtures/live-chaos/popup-plan.mjs';
import { seededPlan, businessAcceptanceGates } from '../scripts/acceptance-live-chaos.mjs';
import { popupAcceptanceGates } from '../scripts/acceptance-live-popups.mjs';

test('four-hour popup plan is bounded, seeded, covers each family three times and includes prompt/confirm', () => {
  const plan = popupPlan({ seed: 'test-popup-plan' });
  assert.deepEqual(plan, popupPlan({ seed: 'test-popup-plan' }));
  assert.notDeepEqual(plan, popupPlan({ seed: 'another-seed' }));
  assert.equal(plan.length, 24);
  for (const family of POPUP_FAMILIES) assert.equal(plan.filter((row) => row.scenarioId === family).length, 3);
  for (const row of plan) {
    const jitter = row.atMs - (row.sequence - 1) * 10 * 60000;
    assert.ok(jitter >= 60000 && jitter <= 6 * 60000);
    assert.ok(row.atMs < FOUR_HOURS);
  }
  assert.ok(plan.some((row) => row.variant === 'prompt'));
  assert.ok(plan.some((row) => row.variant === 'confirm'));
});

test('four-hour business defaults to duration/24 slots, 24 cases and eight families each three times', () => {
  const plan = seededPlan('four-hour-business');
  assert.deepEqual(plan, seededPlan('four-hour-business', { durationMs: FOUR_HOURS, slotMs: 600000 }));
  assert.equal(plan.length, 24);
  const families = new Set(plan.map((row) => row.scenarioId)); assert.equal(families.size, 8);
  for (const family of families) assert.equal(plan.filter((row) => row.scenarioId === family).length, 3);
  for (const [index, row] of plan.entries()) { assert.ok(row.dueAfterMs >= index * 600000 + 60000); assert.ok(row.dueAfterMs <= index * 600000 + 360000); assert.ok(row.dueAfterMs < FOUR_HOURS); }
  for (const durationMs of [120000, EIGHT_HOURS]) assert.equal(seededPlan('four-hour-business', { durationMs }).length, 24);
  const historical = popupPlan({ seed: 'historical-eight-hour', durationMs: EIGHT_HOURS });
  assert.equal(historical.length, 24); assert.ok(historical.at(-1).atMs > FOUR_HOURS);
});

function completeEvidence(lane) {
  const families = lane === 'business' ? [...new Set(seededPlan('gate').map((row) => row.scenarioId))] : POPUP_FAMILIES;
  const coverage = Object.fromEntries(families.map((family) => [family, { injected: 3, genuineRootDecisions: 1 }]));
  const results = Array.from({ length: 24 }, () => ({ outcome: 'resolved', effectAudit: { ok: true } }));
  return { cleanup: { ok: true }, durationMs: FOUR_HOURS, actualElapsedMs: FOUR_HOURS, elapsedMs: FOUR_HOURS, gaps: [], outcomes: results, results, skippedSlots: [], skipped: [], nextSlot: 24, coverage, finalEffectAudit: { complete: true }, prohibitedEffects: 0, duplicateEffects: 0 };
}

for (const [lane, gate] of [['business', businessAcceptanceGates], ['popups', popupAcceptanceGates]]) test(`${lane} four-hour gate retains duration, coverage, root decisions, safety, continuity and cleanup requirements`, () => {
  const base = completeEvidence(lane); const passed = gate(base);
  assert.equal(passed.acceptanceGatePassed, true); assert.equal(passed.fourHourGatePassed, true); assert.equal(passed.eightHourGatePassed, false); assert.equal(passed.requiredDurationMs, 14400000); assert.equal(passed.shortSmokeOnly, false);
  for (const changed of [
    { actualElapsedMs: FOUR_HOURS - 1, elapsedMs: FOUR_HOURS - 1 },
    { durationMs: 120000, actualElapsedMs: 120000, elapsedMs: 120000 },
    { durationMs: FOUR_HOURS - 1 }, { cleanup: { ok: false } }, { cancelled: true }, { failure: { code: 'TEST_FAILURE' } },
    { gaps: [{ gapMs: 130000 }] }, { skippedSlots: [{}], skipped: [{}] }, { outcomes: base.outcomes.slice(1), results: base.results.slice(1) },
    { coverage: { ...base.coverage, [Object.keys(base.coverage)[0]]: { injected: 2, genuineRootDecisions: 1 } } },
    { coverage: { ...base.coverage, [Object.keys(base.coverage)[0]]: { injected: 3, genuineRootDecisions: 0 } } }
  ]) assert.equal(gate({ ...base, ...changed }).acceptanceGatePassed, false, JSON.stringify(changed));
  assert.equal(gate({ ...base, durationMs: 120000, actualElapsedMs: EIGHT_HOURS, elapsedMs: EIGHT_HOURS }).fourHourGatePassed, false, 'Compressed smoke cannot inherit a four-hour pass from cleanup wall time');
  assert.equal(gate({ ...base, durationMs: EIGHT_HOURS, actualElapsedMs: EIGHT_HOURS - 1, elapsedMs: EIGHT_HOURS - 1 }).eightHourGatePassed, false);
  assert.equal(gate({ ...base, durationMs: EIGHT_HOURS, actualElapsedMs: EIGHT_HOURS, elapsedMs: EIGHT_HOURS }).eightHourGatePassed, true);
  if (lane === 'business') {
    assert.equal(gate({ ...base, finalEffectAudit: { complete: false } }).acceptanceGatePassed, false);
    assert.equal(gate({ ...base, outcomes: base.outcomes.map((row, index) => index === 0 ? { ...row, effectAudit: { ok: false } } : row) }).acceptanceGatePassed, false);
  } else {
    assert.equal(gate({ ...base, prohibitedEffects: 1 }).acceptanceGatePassed, false); assert.equal(gate({ ...base, duplicateEffects: 1 }).acceptanceGatePassed, false);
  }
});
