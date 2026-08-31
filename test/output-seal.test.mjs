import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertOutputTreeUnchanged,
  compareOutputSnapshots,
  createOutputSeal,
  outputSealLimitsForBudget,
  snapshotOutputTree
} from '../src/lib/output-seal.mjs';

test('completion seal limits include the separate diagnostic reserve', () => {
  assert.deepEqual(outputSealLimitsForBudget({
    maxBytes: 100,
    maxFiles: 4,
    maxEntries: 20,
    maxDepth: 3,
    diagnosticReserveBytes: 25,
    diagnosticReserveFiles: 2,
    checkIntervalMs: 100
  }), {
    maxBytes: 125,
    maxFiles: 6,
    maxEntries: 20,
    maxDepth: 3
  });
});

async function temporaryOutput(t, prefix = 'taskmaster-output-seal-') {
  const workspace = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const output = path.join(workspace, 'output');
  await mkdir(output);
  return { workspace, output };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function driftFrom(expected, actual) {
  try {
    assertOutputTreeUnchanged(expected, actual);
  } catch (error) {
    assert.equal(error.code, 'TASK_OUTPUT_CHANGED_AFTER_COMPLETION');
    return error.drift;
  }
  assert.fail('Expected the output seal comparison to detect drift');
}

test('output snapshot is content-addressed, portable, and stably sorted', async (t) => {
  const { workspace, output } = await temporaryOutput(t);
  await mkdir(path.join(output, 'nested'));
  await writeFile(path.join(output, 'z-last.txt'), 'zeta');
  await writeFile(path.join(output, 'nested', 'middle.txt'), 'middle');
  await writeFile(path.join(output, 'a-first.txt'), 'alpha');

  const snapshot = await snapshotOutputTree({ root: output });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.files, 3);
  assert.equal(snapshot.bytes, 5 + 6 + 4);
  assert.deepEqual(snapshot.directories, ['nested']);
  assert.deepEqual(snapshot.entries, [
    { relativePath: 'a-first.txt', sizeBytes: 5, sha256: sha256('alpha') },
    { relativePath: 'nested/middle.txt', sizeBytes: 6, sha256: sha256('middle') },
    { relativePath: 'z-last.txt', sizeBytes: 4, sha256: sha256('zeta') }
  ]);
  assert.equal(typeof snapshot.rootIdentity.dev, 'string');
  assert.equal(typeof snapshot.rootIdentity.ino, 'string');
  assert.equal(typeof snapshot.rootIdentity.birthtimeNs, 'string');
  assert.equal(JSON.stringify(snapshot).includes(path.resolve(workspace)), false);
  assert.equal(snapshot.directories.every((entry) => !path.isAbsolute(entry)), true);
  assert.equal(snapshot.entries.every((entry) => !path.isAbsolute(entry.relativePath)), true);

  const roundTripped = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(compareOutputSnapshots(snapshot, roundTripped), { changed: false, drift: [] });
  assert.equal(assertOutputTreeUnchanged(snapshot, roundTripped), roundTripped);
});

test('output seal precisely reports added files', async (t) => {
  const { output } = await temporaryOutput(t);
  await writeFile(path.join(output, 'kept.txt'), 'kept');
  const before = await snapshotOutputTree({ root: output });
  await writeFile(path.join(output, 'added.txt'), 'new');
  const after = await snapshotOutputTree({ root: output });
  const drift = driftFrom(before, after);
  assert.deepEqual(drift.map(({ kind, relativePath }) => ({ kind, relativePath })), [
    { kind: 'added', relativePath: 'added.txt' }
  ]);
});

test('output seal precisely reports same-size content rewrites', async (t) => {
  const { output } = await temporaryOutput(t);
  const filePath = path.join(output, 'result.txt');
  await writeFile(filePath, 'alpha');
  const before = await snapshotOutputTree({ root: output });
  await writeFile(filePath, 'omega');
  const after = await snapshotOutputTree({ root: output });
  const drift = driftFrom(before, after);
  assert.deepEqual(drift.map(({ kind, relativePath, fields }) => ({ kind, relativePath, fields })), [
    { kind: 'modified', relativePath: 'result.txt', fields: ['sha256'] }
  ]);
});

test('output seal precisely reports deleted files', async (t) => {
  const { output } = await temporaryOutput(t);
  const filePath = path.join(output, 'deleted.txt');
  await writeFile(filePath, 'gone');
  const before = await snapshotOutputTree({ root: output });
  await rm(filePath);
  const after = await snapshotOutputTree({ root: output });
  const drift = driftFrom(before, after);
  assert.deepEqual(drift.map(({ kind, relativePath }) => ({ kind, relativePath })), [
    { kind: 'removed', relativePath: 'deleted.txt' }
  ]);
});

test('output seal precisely reports added, removed, and renamed empty directories', async (t) => {
  const { output } = await temporaryOutput(t);
  const before = await snapshotOutputTree({ root: output });
  await mkdir(path.join(output, 'empty-original'));
  const added = await snapshotOutputTree({ root: output });
  assert.deepEqual(driftFrom(before, added), [
    { kind: 'directory_added', relativePath: 'empty-original' }
  ]);

  await rename(path.join(output, 'empty-original'), path.join(output, 'empty-renamed'));
  const renamed = await snapshotOutputTree({ root: output });
  assert.deepEqual(driftFrom(added, renamed), [
    { kind: 'directory_removed', relativePath: 'empty-original' },
    { kind: 'directory_added', relativePath: 'empty-renamed' }
  ]);

  await rm(path.join(output, 'empty-renamed'), { recursive: true });
  const removed = await snapshotOutputTree({ root: output });
  assert.deepEqual(driftFrom(renamed, removed), [
    { kind: 'directory_removed', relativePath: 'empty-renamed' }
  ]);
});

test('output seal rejects symbolic links instead of following them', async (t) => {
  const { workspace, output } = await temporaryOutput(t);
  const outside = path.join(workspace, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'outside');
  try {
    await symlink(outside, path.join(output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(snapshotOutputTree({ root: output }), {
    code: 'TASK_OUTPUT_ENTRY_UNSAFE'
  });
});

test('output seal rejects files with multiple hard links', async (t) => {
  const { output } = await temporaryOutput(t);
  const original = path.join(output, 'original.txt');
  await writeFile(original, 'shared inode');
  try {
    await link(original, path.join(output, 'alias.txt'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`hard links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(snapshotOutputTree({ root: output }), {
    code: 'TASK_OUTPUT_ENTRY_UNSAFE'
  });
});

test('output seal binds the original root identity across both snapshots', async (t) => {
  const { workspace, output } = await temporaryOutput(t);
  const fileName = 'same.txt';
  await writeFile(path.join(output, fileName), 'same bytes');
  const seal = await createOutputSeal({ root: output });
  const displaced = path.join(workspace, 'displaced');
  await rename(output, displaced);
  await mkdir(output);
  await writeFile(path.join(output, fileName), 'same bytes');

  await assert.rejects(seal.verify(), (error) => {
    assert.equal(error.code, 'TASK_OUTPUT_CHANGED_AFTER_COMPLETION');
    assert.equal(error.drift[0].kind, 'root_identity_changed');
    return true;
  });
});

test('output seal enforces byte and file budgets before publishing a snapshot', async (t) => {
  const { output } = await temporaryOutput(t);
  await writeFile(path.join(output, 'a.txt'), 'four');
  await writeFile(path.join(output, 'b.txt'), 'five!');
  await assert.rejects(snapshotOutputTree({
    root: output,
    limits: { maxBytes: 3, maxFiles: 10, maxEntries: 10, maxDepth: 8 }
  }), { code: 'TASK_OUTPUT_BUDGET_EXCEEDED' });
  await assert.rejects(snapshotOutputTree({
    root: output,
    limits: { maxBytes: 100, maxFiles: 1, maxEntries: 10, maxDepth: 8 }
  }), { code: 'TASK_OUTPUT_BUDGET_EXCEEDED' });
});

test('output seal enforces bounded entry count and recursion depth', async (t) => {
  const first = await temporaryOutput(t, 'taskmaster-output-seal-entries-');
  await writeFile(path.join(first.output, 'a.txt'), 'a');
  await writeFile(path.join(first.output, 'b.txt'), 'b');
  await assert.rejects(snapshotOutputTree({
    root: first.output,
    limits: { maxBytes: 100, maxFiles: 10, maxEntries: 1, maxDepth: 8 }
  }), { code: 'TASK_OUTPUT_SCAN_LIMIT_EXCEEDED' });

  const second = await temporaryOutput(t, 'taskmaster-output-seal-depth-');
  await mkdir(path.join(second.output, 'one', 'two'), { recursive: true });
  await writeFile(path.join(second.output, 'one', 'two', 'deep.txt'), 'deep');
  await assert.rejects(snapshotOutputTree({
    root: second.output,
    limits: { maxBytes: 100, maxFiles: 10, maxEntries: 10, maxDepth: 1 }
  }), { code: 'TASK_OUTPUT_SCAN_LIMIT_EXCEEDED' });
});
