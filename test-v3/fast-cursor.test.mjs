import assert from 'node:assert/strict';
import test from 'node:test';
import { createFastCursor, cursorPoint } from '../src/runtime/fast-cursor.mjs';

test('cursor uses actual viewport boxes, clips visible bounds and never guesses an invisible target', () => {
  assert.deepEqual(cursorPoint({ x: 20, y: 30, width: 100, height: 40 }, { width: 800, height: 600 }), { x: 70, y: 50 });
  assert.deepEqual(cursorPoint({ x: -20, y: 10, width: 40, height: 20 }, { width: 800, height: 600 }), { x: 10, y: 20 });
  assert.equal(cursorPoint({ x: 900, y: 10, width: 40, height: 20 }, { width: 800, height: 600 }), null);
  assert.equal(cursorPoint(null, { width: 800, height: 600 }), null);
});

test('disabled cursor never touches the page and pause retains the view preference', async () => {
  const cursor = createFastCursor();
  const page = { evaluate: () => { throw new Error('No decoration should run'); } };
  assert.deepEqual(await cursor.point(page, null), { supported: false, reason: 'disabled-or-paused' });
  await cursor.setEnabled(true); await cursor.setPaused(true);
  assert.equal(cursor.enabled, true); assert.equal(cursor.paused, true);
  assert.deepEqual(await cursor.point(page, null), { supported: false, reason: 'disabled-or-paused' });
  await cursor.dispose();
});
