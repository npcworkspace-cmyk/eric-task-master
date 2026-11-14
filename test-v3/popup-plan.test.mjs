import assert from 'node:assert/strict';
import test from 'node:test';
import { POPUP_FAMILIES, popupPlan } from './fixtures/live-chaos/popup-plan.mjs';

test('eight-hour popup plan is bounded, seeded, covers each family three times and includes prompt/confirm', () => {
  const plan = popupPlan({ seed: 'test-popup-plan' });
  assert.deepEqual(plan, popupPlan({ seed: 'test-popup-plan' }));
  assert.notDeepEqual(plan, popupPlan({ seed: 'another-seed' }));
  assert.equal(plan.length, 24);
  for (const family of POPUP_FAMILIES) assert.equal(plan.filter((row) => row.scenarioId === family).length, 3);
  for (const row of plan) {
    const jitter = row.atMs - (row.sequence - 1) * 20 * 60000;
    assert.ok(jitter >= 2 * 60000 && jitter <= 12 * 60000);
  }
  assert.ok(plan.some((row) => row.variant === 'prompt'));
  assert.ok(plan.some((row) => row.variant === 'confirm'));
});
