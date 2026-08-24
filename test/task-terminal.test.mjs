import assert from 'node:assert/strict';
import test from 'node:test';
import { isSettledTerminalTask } from '../src/contracts.mjs';

test('task followers stop only after terminal cleanup is durably settled', () => {
  for (const state of ['completed', 'failed', 'cancelled']) {
    assert.equal(isSettledTerminalTask({ state, cleanup: { settled: true } }), true);
    assert.equal(isSettledTerminalTask({ state, cleanup: { settled: false } }), false);
    assert.equal(isSettledTerminalTask({
      state,
      cleanup: { settled: false, managerRestartObserved: true }
    }), false);
  }
  assert.equal(isSettledTerminalTask({ state: 'running', cleanup: { settled: true } }), false);
  assert.equal(isSettledTerminalTask(null), false);
});
