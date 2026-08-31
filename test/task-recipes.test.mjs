import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { preflightTaskPack, scaffoldTaskPack } from '../src/lib/task-pack.mjs';
import { TASK_RECIPES } from '../src/lib/task-recipes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('all production recipes scaffold and pass isolated module preflight without registration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-recipes-'));
  try {
    for (const recipe of TASK_RECIPES) {
      const location = path.join(root, recipe);
      const created = await scaffoldTaskPack(location, { name: `recipe-${recipe}`, recipe });
      assert.equal(created.pack.tasks[0].name, `recipe-${recipe}.${recipe}.v1`);
      const source = await readFile(path.join(location, 'tasks', `${recipe}-v1.mjs`), 'utf8');
      assert.match(source, /Runtime owns browser\/extension coordination; visible mutations stay in journey; extension-dependent steps use extensionFlow\./u);
      const checked = await preflightTaskPack(location);
      assert.equal(checked.ok, true, `${recipe}: ${JSON.stringify(checked.checks)}`);
      assert.equal(checked.checks.length, 1);
      assert.equal(checked.checks[0].ok, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('published Task Pack guidance pins the extension coexistence contract', async () => {
  const guidance = await readFile(
    path.join(ROOT, 'skills', 'eric-task-master', 'references', 'task-packs.md'),
    'utf8'
  );
  for (const rule of [
    'PACK-EXT-01', 'PACK-EXT-02', 'PACK-EXT-03', 'PACK-EXT-04',
    'PACK-EXT-05', 'PACK-EXT-06', 'PACK-EXT-07'
  ]) {
    assert.equal(guidance.split(rule).length - 1, 1, `${rule} must appear exactly once`);
  }
  for (const token of [
    'taskmaster-cooperative-v2', 'participantId', 'requestId', 'operation',
    'extensionFlow.expectCompletion', 'extensionFlow.resolveCompletion',
    'Release or reported outcome alone is not success proof', '`waiting_user`', '`paused`'
  ]) {
    assert.equal(guidance.includes(token), true, `guidance must include ${token}`);
  }
});

test('recipe scaffold rejects unknown recipes before creating a Task Pack', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-recipe-invalid-'));
  try {
    await assert.rejects(
      scaffoldTaskPack(path.join(root, 'pack'), { name: 'invalid-pack', recipe: 'invented' }),
      { code: 'INVALID_TASK_RECIPE' }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
