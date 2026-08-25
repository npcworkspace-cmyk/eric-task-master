import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { assertReleaseWorkflowPolicy } from '../scripts/release-workflow-policy.mjs';

const workflowPath = path.resolve(import.meta.dirname, '..', '.github', 'workflows', 'release.yml');

function moveFinalImmutableStepBeforeBuild(source) {
  const stepStart = source.indexOf('      - name: Reverify immutable Release enforcement immediately before publication');
  const nextStep = source.indexOf('      - name: Create complete draft and publish immutable Release', stepStart);
  const buildStep = source.indexOf('      - name: Build reproducible release archives');
  assert.ok(stepStart >= 0 && nextStep > stepStart && buildStep >= 0);
  const step = source.slice(stepStart, nextStep);
  return `${source.slice(0, buildStep)}${step}${source.slice(buildStep, stepStart)}${source.slice(nextStep)}`;
}

test('release workflow policy accepts the audited publication path', async () => {
  const source = await readFile(workflowPath, 'utf8');
  assert.equal(assertReleaseWorkflowPolicy(source), true);
});

test('release workflow policy rejects publication and permission regressions', async (t) => {
  const source = await readFile(workflowPath, 'utf8');
  const mutations = new Map([
    ['active release cancellation', source.replace('cancel-in-progress: false', 'cancel-in-progress: true')],
    ['non-draft publication', source.replace(' dist/* --draft ', ' dist/* ')],
    ['partial asset upload', source.replace(' dist/* --draft ', ' "dist/eric-task-master-v${VERSION}.zip" --draft ')],
    ['unbound Release target', source.replace(' --target "${RELEASE_SHA}"', '')],
    ['early immutable recheck', moveFinalImmutableStepBeforeBuild(source)],
    ['non-Git source archive', source.replace(
      'git archive --format=zip --mtime="${ARCHIVE_MTIME}" --prefix="eric-task-master-v${VERSION}/"',
      'echo source-archive'
    )],
    ['persisted checkout credential', source.replace('persist-credentials: false', 'persist-credentials: true')],
    ['expanded workflow permissions', source.replace('  contents: write', '  contents: write\n  issues: write')]
  ]);
  for (const [name, mutation] of mutations) {
    await t.test(name, () => assert.throws(() => assertReleaseWorkflowPolicy(mutation)));
  }
});
