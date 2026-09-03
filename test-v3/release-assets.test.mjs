import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyReleaseAssets } from '../scripts/build/verify-release-assets.mjs';
import { removeTestTree } from './test-fs.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-release-assets-'));
  t.after(() => removeTestTree(root));
  return { expected: join(root, 'expected'), published: join(root, 'published') };
}

async function assets(directory, files = { 'installer.exe': 'tested bytes', 'skill.zip': 'skill bytes' }) {
  await mkdir(directory, { recursive: true });
  const checksums = [];
  for (const [name, value] of Object.entries(files).sort()) {
    await writeFile(join(directory, name), value);
    checksums.push(`${createHash('sha256').update(value).digest('hex')}  ${name}`);
  }
  await writeFile(join(directory, 'SHA256SUMS'), `${checksums.join('\n')}\n`);
}

test('published release must match every original asset and checksum byte', async (t) => {
  const { expected, published } = await fixture(t);
  await Promise.all([assets(expected), assets(published)]);
  const result = await verifyReleaseAssets(expected, published);
  assert.equal(result.ok, true);
  assert.equal(result.assets, 3);
  assert.match(result.hashes['installer.exe'], /^[0-9a-f]{64}$/u);
});

test('self-consistent but replaced published bytes fail comparison', async (t) => {
  const { expected, published } = await fixture(t);
  await assets(expected);
  await assets(published, { 'installer.exe': 'different bytes', 'skill.zip': 'skill bytes' });
  await assert.rejects(verifyReleaseAssets(expected, published), /Published asset bytes differ/u);
});

test('missing or extra assets fail even with valid checksums', async (t) => {
  const { expected, published } = await fixture(t);
  await assets(expected);
  await assets(published, { 'installer.exe': 'tested bytes' });
  await assert.rejects(verifyReleaseAssets(expected, published), /Published asset names differ/u);
  await assets(published, { 'installer.exe': 'tested bytes', 'skill.zip': 'skill bytes', 'extra.zip': 'extra' });
  await assert.rejects(verifyReleaseAssets(expected, published), /Published asset names differ/u);
});

test('corrupt, incomplete, duplicate, and unsafe checksum entries fail closed', async (t) => {
  const { expected, published } = await fixture(t);
  await assets(expected);
  const hash = createHash('sha256').update('tested bytes').digest('hex');
  for (const lines of [
    `${'0'.repeat(64)}  installer.exe\n`,
    `${hash}  installer.exe\n`,
    `${hash}  installer.exe\n${hash}  installer.exe\n`,
    `${hash}  ../installer.exe\n`,
    `${hash}  SHA256SUMS\n`
  ]) {
    await assets(published);
    await writeFile(join(published, 'SHA256SUMS'), lines);
    await assert.rejects(verifyReleaseAssets(expected, published), /checksum/iu);
  }
});

test('unexpected directories are not silently ignored', async (t) => {
  const { expected, published } = await fixture(t);
  await Promise.all([assets(expected), assets(published)]);
  await mkdir(join(published, 'nested'));
  await assert.rejects(verifyReleaseAssets(expected, published), /must be regular files/u);
});
