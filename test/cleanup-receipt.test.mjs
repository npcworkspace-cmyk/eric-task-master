import assert from 'node:assert/strict';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyCleanupReceipt, writeCleanupReceipt } from '../src/lib/cleanup-receipt.mjs';

test('cleanup receipt verification is bound to one stable regular file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-cleanup-receipt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, 'task.json');
  const expected = {
    kind: 'task',
    taskId: 'task_receipt_test',
    attempt: 1,
    workerPid: process.pid
  };
  await writeCleanupReceipt(receiptPath, expected);
  assert.equal(await verifyCleanupReceipt(receiptPath, expected), true);

  const aliasPath = path.join(root, 'alias.json');
  await link(receiptPath, aliasPath);
  assert.equal(await verifyCleanupReceipt(receiptPath, expected), false);
  await rm(aliasPath);
  assert.equal(await verifyCleanupReceipt(receiptPath, expected), true);

  await writeFile(receiptPath, '{"version":1}\n');
  assert.equal(await verifyCleanupReceipt(receiptPath, expected), false);
});
