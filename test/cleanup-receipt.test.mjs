import assert from 'node:assert/strict';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readCleanupReceipt, verifyCleanupReceipt, writeCleanupReceipt } from '../src/lib/cleanup-receipt.mjs';

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

test('task cleanup receipt carries a bounded final checkpoint seal for crash recovery', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-cleanup-checkpoint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const receiptPath = path.join(root, 'task.json');
  const checkpoint = {
    attempt: 2,
    savedAt: '2026-08-29T12:00:00.000Z',
    sha256: 'a'.repeat(64),
    sizeBytes: 128
  };
  const expected = {
    kind: 'task',
    taskId: 'task_checkpoint_receipt',
    attempt: 2,
    workerPid: process.pid
  };
  await writeCleanupReceipt(receiptPath, { ...expected, checkpoint });
  const receipt = await readCleanupReceipt(receiptPath, expected);
  assert.deepEqual(receipt.checkpoint, checkpoint);

  await assert.rejects(
    writeCleanupReceipt(path.join(root, 'invalid.json'), {
      ...expected,
      checkpoint: { ...checkpoint, sha256: 'not-a-hash' }
    }),
    { name: 'TypeError' }
  );
});
