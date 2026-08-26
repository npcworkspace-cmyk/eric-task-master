import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { preflightTaskPack, scaffoldTaskPack } from '../src/lib/task-pack.mjs';
import { TASK_RECIPES } from '../src/lib/task-recipes.mjs';

test('all production recipes scaffold and pass isolated module preflight without registration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-recipes-'));
  try {
    for (const recipe of TASK_RECIPES) {
      const location = path.join(root, recipe);
      const created = await scaffoldTaskPack(location, { name: `recipe-${recipe}`, recipe });
      assert.equal(created.pack.tasks[0].name, `recipe-${recipe}.${recipe}.v1`);
      const checked = await preflightTaskPack(location);
      assert.equal(checked.ok, true, `${recipe}: ${JSON.stringify(checked.checks)}`);
      assert.equal(checked.checks.length, 1);
      assert.equal(checked.checks[0].ok, true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
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
