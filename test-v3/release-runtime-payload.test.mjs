import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { ROOT, copyApplication } from '../scripts/build/lib.mjs';

const operationDocs = ['docs/OPERATIONS-OUTPUT.md', 'docs/OPERATIONS-PERSISTENCE.md', 'docs/OPERATIONS-STREAM.md'];
const execFileAsync = promisify(execFile);

test('distributed application includes the same-version Skill and a loadable online adapter without test artifacts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskmaster-v4-payload-'));
  try {
    await copyApplication(ROOT, directory);
    const packageJson = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const skill = await readFile(path.join(directory, 'skills/eric-task-master/SKILL.md'), 'utf8');
    assert.ok(skill.includes(`version: "${packageJson.version}"`));
    for (const relative of ['scripts/codex-host-adapter.mjs', 'docs/CODEX-HOST-ADAPTER.md',
      ...operationDocs,
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

test('bundle verification rejects each missing operations contract before runtime execution', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'taskmaster-v4-required-docs-'));
  try {
    const runtimeNode = process.platform === 'win32' ? 'node.exe' : 'node';
    const required = ['app/src/cli.mjs', 'app/scripts/codex-host-adapter.mjs', 'app/docs/CODEX-HOST-ADAPTER.md',
      ...operationDocs.map((relative) => `app/${relative}`),
      'app/skills/eric-task-master/SKILL.md', 'app/skills/eric-task-master/scripts/find-launcher.ps1',
      'app/node_modules/playwright/package.json', `runtime/${runtimeNode}`, 'runtime/NODE-LICENSE',
      'THIRD_PARTY_NOTICES.txt', 'sbom.spdx.json'];
    for (const omitted of operationDocs) {
      const bundle = path.join(directory, path.basename(omitted, '.md'));
      for (const relative of required) {
        if (relative === `app/${omitted}`) continue;
        const destination = path.join(bundle, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, 'fixture');
      }
      await writeFile(path.join(bundle, 'app/package.json'), JSON.stringify({ version: '4.2.1' }));
      await writeFile(path.join(bundle, 'release-manifest.json'), JSON.stringify({
        version: '4.2.1', platform: process.platform,
        browser: { bundled: false, requiredChannel: 'chrome' }, signature: { signed: false }
      }));
      await assert.rejects(execFileAsync(process.execPath, [path.join(ROOT, 'scripts/build/verify-bundle.mjs'), '--bundle', bundle],
        { windowsHide: true, timeout: 10_000 }), (error) => {
        assert.equal(error.code, 1);
        assert.ok(error.stderr.includes(`Bundle is missing ${path.join(bundle, 'app', omitted)}`), error.stderr);
        return true;
      });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
