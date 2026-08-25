import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TaskTypeRegistry } from '../src/lib/task-type-registry.mjs';

function source(name) {
  return `export const meta = { name: ${JSON.stringify(name)}, version: '1.0.0', readOnly: true };\nexport async function run() { return { summary: 'ok', evidence: [] }; }\n`;
}

test('task type lifecycle hides deprecated drafts and points callers to one active replacement', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-lifecycle-'));
  try {
    const modules = path.join(root, 'modules');
    await mkdir(modules);
    const oldPath = path.join(modules, 'old.mjs');
    const nextPath = path.join(modules, 'next.mjs');
    await writeFile(oldPath, source('flow.old'));
    await writeFile(nextPath, source('flow.next'));
    const registry = new TaskTypeRegistry({
      filePath: path.join(root, 'types.json'),
      snapshotRoot: path.join(root, 'snapshots'),
      allowedRoots: [modules]
    });
    await registry.install({ name: 'flow.old', modulePath: oldPath });
    await registry.install({ name: 'flow.next', modulePath: nextPath });
    const deprecated = await registry.deprecate('flow.old', { replacedBy: 'flow.next' });
    assert.equal(deprecated.lifecycle, 'deprecated');
    assert.equal(deprecated.replacedBy, 'flow.next');
    assert.deepEqual((await registry.listSummaries()).map((item) => item.name), ['flow.next']);
    await assert.rejects(registry.resolve('flow.old'), { code: 'TASK_TYPE_DEPRECATED', statusCode: 409 });
    assert.equal((await registry.describe('flow.old')).lifecycle, 'deprecated');
    assert.equal((await registry.restore('flow.old')).lifecycle, 'active');
    assert.deepEqual((await registry.listSummaries()).map((item) => item.name), ['flow.next', 'flow.old']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
