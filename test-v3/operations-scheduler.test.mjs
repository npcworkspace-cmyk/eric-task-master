import assert from 'node:assert/strict';
import test from 'node:test';
import { scheduleDue, validateSchedule } from '../src/lib/operations-scheduler.mjs';
const base = { timezone: 'Asia/Shanghai', nextAt: '2026-11-14T13:00:00Z', intervalMs: 60000, misfire: 'once', maxRunsPerWindow: 2, allowedWindow: { start: '20:00', end: '06:00' } };
test('timezone-aware overnight windows coalesce sleep misses and cap frequency', () => {
  validateSchedule(base);
  const now = Date.parse('2026-11-14T14:00:00Z');
  const due = scheduleDue(base, now); assert.equal(due.fire, true); assert.equal(due.driftMs, 3600000); assert.equal(due.next.nextAt, '2026-11-14T14:01:00.000Z');
  assert.equal(scheduleDue(due.next, now), null);
  assert.equal(scheduleDue({ ...base, misfire: 'skip' }, now).fire, false);
  assert.equal(scheduleDue({ ...base, windowKey: '2026-11-14', windowRuns: 2 }, now).fire, false);
  assert.equal(scheduleDue(base, Date.parse('2026-11-15T02:00:00Z')).fire, false);
});
test('invalid timezone, interval, window and expiry are rejected', () => {
  for (const override of [{ timezone: 'Not/AZone' }, { intervalMs: 0 }, { maxRunsPerWindow: 0 }, { expiresAt: 'wrong' }, { allowedWindow: { start: '30:00', end: '04:00' } }]) assert.throws(() => validateSchedule({ ...base, ...override }));
});
