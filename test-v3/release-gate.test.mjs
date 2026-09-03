import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function source(relative) {
  return readFile(path.join(ROOT, ...relative.split('/')), 'utf8');
}

function count(sourceText, fragment) {
  return sourceText.split(fragment).length - 1;
}

test('CI exercises the complete gate on every advertised native target', async () => {
  const ci = await source('.github/workflows/ci.yml');
  assert.match(ci, /push:\s*\r?\n\s+branches: \[main, "v\*", "upgrade\/\*\*"\]/u);
  assert.match(ci, /\r?\n  pull_request:\s*\r?\n/u);
  assert.match(ci, /\r?\n  workflow_dispatch:\s*\r?\n/u);

  const targets = new Map([
    ['windows-x64', 'windows-2025'],
    ['macos-arm64', 'macos-15'],
    ['macos-x64', 'macos-15-intel'],
    ['linux-x64', 'ubuntu-24.04'],
    ['linux-arm64', 'ubuntu-24.04-arm']
  ]);
  for (const [target, runner] of targets) {
    const pair = new RegExp(`- target: ${target}\\r?\\n\\s+os: ${runner}`, 'u');
    assert.match(ci, pair, `${target} must use ${runner}`);
    assert.equal(count(ci, `- target: ${target}`), 1, `${target} must occur once`);
  }
  assert.equal(count(ci, 'npm run check'), 2, 'both Linux and non-Linux paths must run the complete gate');
  assert.match(ci, /name: release-\$\{\{ matrix\.target \}\}/u);
  assert.match(ci, /Install, start, stop, and uninstall Windows package/u);
  assert.match(ci, /Install, start, stop, and uninstall macOS package/u);
  assert.match(ci, /Install, start, stop, and uninstall Linux package/u);
});

test('CodeQL produces same-SHA main push evidence', async () => {
  const codeql = await source('.github/workflows/codeql.yml');
  assert.match(codeql, /push:\s*\r?\n\s+branches: \[main, "v\*", "stability\/\*\*", "upgrade\/\*\*"\]/u);
  assert.match(codeql, /github\/codeql-action\/init@/u);
  assert.match(codeql, /github\/codeql-action\/analyze@/u);
});

test('release requires successful CI and CodeQL runs for the exact current main SHA', async () => {
  const release = await source('.github/workflows/release.yml');
  assert.match(release, /test "\$\{MAIN_SHA\}" = "\$\{RELEASE_SHA\}"/u);
  assert.match(release, /actions\/workflows\/ci\.yml\/runs\?branch=main&event=push&status=completed&per_page=100/u);
  assert.match(release, /actions\/workflows\/codeql\.yml\/runs\?branch=main&event=push&status=completed&per_page=100/u);
  assert.ok(count(release, '.head_sha == "\'"${RELEASE_SHA}"\'"') >= 2, 'workflow lookup must filter both runs by exact SHA');
  assert.match(release, /"CODEQL_RUN_ID=\$\{CODEQL_RUN_ID\}"/u);
  assert.match(release, /gh run download "\$\{CI_RUN_ID\}"[^\n]*--pattern 'release-\*'/u);
  assert.match(release, /--sha "\$\{RELEASE_SHA\}"/u);

  assert.ok(count(release, 'actions/runs/${CI_RUN_ID}') >= 2, 'CI proof must be checked again before publish');
  assert.ok(count(release, 'actions/runs/${CODEQL_RUN_ID}') >= 2, 'CodeQL proof must be checked again before publish');

  const publish = release.slice(release.indexOf('- name: Publish one immutable unsigned Release'));
  const create = publish.indexOf('gh release create');
  assert.ok(create > 0, 'release creation command is missing');
  assert.ok(publish.indexOf('actions/runs/${CI_RUN_ID}') < create, 'CI proof must precede release creation');
  assert.ok(publish.indexOf('actions/runs/${CODEQL_RUN_ID}') < create, 'CodeQL proof must precede release creation');
  assert.ok(publish.indexOf('git/ref/heads/main') < create, 'current main must be rechecked before release creation');
  assert.ok(publish.indexOf('git/ref/tags/${TAG}') < create, 'tag absence must be rechecked before release creation');
});

test('release documentation describes the enforced proof and artifact contract', async () => {
  const guide = await source('docs/RELEASE-GATE.md');
  for (const fragment of [
    'exact current `main` SHA',
    '`.github/workflows/ci.yml`',
    '`.github/workflows/codeql.yml`',
    '`npm run check`',
    '`release-windows-x64`',
    '`release-macos-arm64`',
    '`release-macos-x64`',
    '`release-linux-x64`',
    '`release-linux-arm64`',
    'does not rebuild the native Manager packages',
    'currently unsigned'
  ]) assert.ok(guide.includes(fragment), `release guide lacks: ${fragment}`);
});
