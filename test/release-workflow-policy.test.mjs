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

function moveLineAfterChecksums(source, line) {
  const lineWithIndent = `          ${line}`;
  const lineStart = source.indexOf(lineWithIndent);
  const lineEnd = source.indexOf('\n', lineStart) + 1;
  const checksum = '(cd dist && sha256sum ./*.zip > SHA256SUMS)';
  const withoutLine = `${source.slice(0, lineStart)}${source.slice(lineEnd)}`;
  const checksumStart = withoutLine.indexOf(checksum);
  const checksumEnd = withoutLine.indexOf('\n', checksumStart) + 1;
  assert.ok(lineStart >= 0 && lineEnd > lineStart && checksumStart >= 0 && checksumEnd > checksumStart);
  return `${withoutLine.slice(0, checksumEnd)}${lineWithIndent}\n${withoutLine.slice(checksumEnd)}`;
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
    ['source archive uses the Skill subtree', source
      .replace('--output="dist/eric-task-master-v${VERSION}.zip" HEAD', '--output="dist/eric-task-master-v${VERSION}.zip" HEAD:skills/eric-task-master')
      .replace('--output="dist/eric-task-master-v${VERSION}.repro.zip" HEAD', '--output="dist/eric-task-master-v${VERSION}.repro.zip" HEAD:skills/eric-task-master')],
    ['source reproducibility file survives checksums', moveLineAfterChecksums(
      source,
      'rm "dist/eric-task-master-v${VERSION}.repro.zip"'
    )],
    ['Skill reproducibility file survives checksums', moveLineAfterChecksums(
      source,
      'rm "dist/eric-task-master-skill-v${VERSION}.repro.zip"'
    )],
    ['persisted checkout credential', source.replace('persist-credentials: false', 'persist-credentials: true')],
    ['expanded workflow permissions', source.replace('  contents: write', '  contents: write\n  issues: write')]
  ]);
  for (const [name, mutation] of mutations) {
    await t.test(name, () => assert.throws(() => assertReleaseWorkflowPolicy(mutation)));
  }
});
