import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOutputBudget } from '../src/lib/output-budget.mjs';
import { removeTestTree } from './test-fs.mjs';

test('dense progress checks reuse one scan and its interval cache while forced checks see new files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-budget-cache-'));
  t.after(() => removeTestTree(root));
  const budget = await createOutputBudget({ root, limits: { maxBytes: 100, checkIntervalMs: 60_000 } });
  const snapshots = await Promise.all(Array.from({ length: 50 }, () =>
    budget.assertWithinBudget({ allowCached: true })));
  assert.equal(snapshots[0].files, 0);
  assert.ok(snapshots.every((snapshot) => snapshot === snapshots[0]), 'concurrent progress shares one scan');
  await writeFile(path.join(root, 'result.txt'), 'hello');
  assert.equal(await budget.assertWithinBudget({ allowCached: true }), snapshots[0]);
  const final = await budget.assertWithinBudget();
  assert.equal(final.files, 1);
  assert.equal(final.bytes, 5);
  assert.notEqual(final, snapshots[0]);
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(101));
  await assert.rejects(budget.assertWithinBudget(), { code: 'TASK_OUTPUT_BUDGET_EXCEEDED' });
  await assert.rejects(budget.assertWithinBudget({ allowCached: true }), { code: 'TASK_OUTPUT_BUDGET_EXCEEDED' });
});

test('progress refreshes an expired budget snapshot without requiring an explicit safety scan', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-budget-expiry-'));
  t.after(async () => { t.mock.timers.reset(); await removeTestTree(root); });
  t.mock.timers.enable({ apis: ['Date'], now: 1_750_000_000_000 });
  const budget = await createOutputBudget({ root, limits: { checkIntervalMs: 5_000 } });
  const first = await budget.assertWithinBudget();
  await writeFile(path.join(root, 'result.txt'), 'new');
  assert.equal(await budget.assertWithinBudget({ allowCached: true }), first);
  t.mock.timers.tick(5_000);
  const refreshed = await budget.assertWithinBudget({ allowCached: true });
  assert.equal(refreshed.files, 1);
  assert.equal(refreshed.bytes, 3);
  assert.notEqual(refreshed, first);
});
