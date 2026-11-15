import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT, copyApplication } from '../scripts/build/lib.mjs';

test('distributed application includes the same-version Skill and a loadable online adapter without test artifacts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskmaster-v4-payload-'));
  try {
    await copyApplication(ROOT, directory);
    const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const skill = await readFile(path.join(directory, 'skills/eric-task-master/SKILL.md'), 'utf8');
    assert.ok(skill.includes(`version: "${packageJson.version}"`));
    for (const relative of ['scripts/codex-host-adapter.mjs', 'docs/CODEX-HOST-ADAPTER.md',
      'skills/eric-task-master/LICENSE', 'skills/eric-task-master/scripts/find-launcher.ps1']) {
      assert.deepEqual(await readFile(path.join(directory, relative)), await readFile(path.join(ROOT, relative)));
    }
    const adapter = await import(pathToFileURL(path.join(directory, 'scripts/codex-host-adapter.mjs')).href);
    assert.equal(typeof adapter.receiveEvent, 'function');
    assert.equal(typeof adapter.validateConfig, 'function');
    assert.equal(typeof adapter.workEvent, 'function');
    for (const excluded of ['test-v3', 'outputs', 'scripts/acceptance-autonomy-online.mjs']) {
      await assert.rejects(access(path.join(directory, excluded)), { code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
