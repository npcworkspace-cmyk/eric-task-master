import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cleanManagedPath } from '../src/lib/space-cleanup.mjs';
import { removeTestTree } from './test-fs.mjs';

async function fixture(t) {
  // /var on macOS is itself a symlink; supply the actual narrow owned root.
  const folder = await mkdtemp(path.join(await realpath(os.tmpdir()), 'taskmaster-space-cleanup-'));
  t.after(() => removeTestTree(folder));
  const root = path.join(folder, 'owned');
  const outside = path.join(folder, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { folder, root, outside };
}

async function put(file, value = 'keep') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

const emptyResult = () => ({ bytes: 0, files: 0, skipped: [], failed: [] });
const directoryLink = (target, link) => symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

test('cleanup previews without changes and removes only the selected cache', async (t) => {
  const { root } = await fixture(t);
  const canaries = ['Cookies', 'Local Storage/leveldb/data', 'IndexedDB/database', 'Service Worker/CacheStorage/data', 'Extensions/addon/settings'];
  for (const name of canaries) await put(path.join(root, 'Default', name), `keep:${name}`);
  await put(path.join(root, 'Default', 'Cache', 'a'), 'abc');
  await put(path.join(root, 'Default', 'Cache', 'sub', 'b'), 'defgh');
  await mkdir(path.join(root, 'Default', 'Cache', 'empty'));
  const expected = { bytes: 8, files: 2, skipped: [], failed: [] };
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'Default/Cache' }), expected);
  assert.equal(await readFile(path.join(root, 'Default', 'Cache', 'a'), 'utf8'), 'abc');
  assert.ok((await lstat(path.join(root, 'Default', 'Cache', 'empty'))).isDirectory());
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'Default/Cache', preview: false }), expected);
  await assert.rejects(lstat(path.join(root, 'Default', 'Cache')), { code: 'ENOENT' });
  for (const name of canaries) assert.equal(await readFile(path.join(root, 'Default', name), 'utf8'), `keep:${name}`);
  assert.ok((await lstat(root)).isDirectory());
});

test('cleanup accepts a selected regular file and empty directory without counting directory bytes', async (t) => {
  const { root } = await fixture(t);
  await put(path.join(root, 'cache.bin'), 'four');
  await mkdir(path.join(root, 'empty'));
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'cache.bin', preview: false }), { ...emptyResult(), bytes: 4, files: 1 });
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'empty', preview: false }), emptyResult());
  await assert.rejects(lstat(path.join(root, 'empty')), { code: 'ENOENT' });
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'missing/cache', preview: false }), emptyResult());
});

test('cleanup rejects roots, traversal and invalid requests before changing anything', async (t) => {
  const { root, outside } = await fixture(t);
  await put(path.join(outside, 'canary'));
  for (const relativePath of ['', ' ', '.', '..', '../outside', 'a/../outside', 'a\\..\\outside', './cache', '/tmp/cache', '\\outside', 'C:\\cache', 'C:cache', 'cache\0bad', 'cache//child']) {
    await assert.rejects(cleanManagedPath({ root, relativePath, preview: false }), { code: 'INVALID_CLEANUP_PATH' });
  }
  await assert.rejects(cleanManagedPath({ root: path.parse(root).root, relativePath: 'cache' }), { code: 'INVALID_CLEANUP_PATH' });
  await assert.rejects(cleanManagedPath({ root: 'relative', relativePath: 'cache' }), { code: 'INVALID_CLEANUP_PATH' });
  await assert.rejects(cleanManagedPath({ root, relativePath: 'cache', preview: 'false' }), { code: 'INVALID_CLEANUP_PATH' });
  assert.equal(await readFile(path.join(outside, 'canary'), 'utf8'), 'keep');
});

test('cleanup refuses a linked root or ancestor even when the link remains inside the fixture', async (t) => {
  const { folder, root, outside } = await fixture(t);
  await put(path.join(outside, 'nested', 'canary'));
  await directoryLink(outside, path.join(root, 'alias'));
  await assert.rejects(cleanManagedPath({ root, relativePath: 'alias/nested', preview: false }), { code: 'INVALID_CLEANUP_PATH' });
  await assert.rejects(cleanManagedPath({ root: path.join(root, 'alias'), relativePath: 'nested', preview: false }), { code: 'INVALID_CLEANUP_PATH' });
  await directoryLink(root, path.join(folder, 'root-alias'));
  await assert.rejects(cleanManagedPath({ root: path.join(folder, 'root-alias'), relativePath: 'cache' }), { code: 'INVALID_CLEANUP_PATH' });
  assert.equal(await readFile(path.join(outside, 'nested', 'canary'), 'utf8'), 'keep');
});

test('normal cleanup skips target and inner junctions or symlinks without following them', async (t) => {
  const { root, outside } = await fixture(t);
  await put(path.join(outside, 'canary'), 'external');
  await put(path.join(root, 'cache', 'a'), 'delete');
  await directoryLink(outside, path.join(root, 'cache', 'linked'));
  const expected = { bytes: 6, files: 1, skipped: [{ path: 'cache/linked', reason: 'SYMLINK_OR_JUNCTION' }], failed: [] };
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'cache' }), expected);
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'cache', preview: false }), expected);
  assert.ok((await lstat(path.join(root, 'cache', 'linked'))).isSymbolicLink());
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'cache/linked', preview: false }), { ...emptyResult(), skipped: expected.skipped });
  assert.equal(await readFile(path.join(outside, 'canary'), 'utf8'), 'external');
});

test('trusted external parent aliases are canonicalized without allowing a linked root', async (t) => {
  const { folder, root, outside } = await fixture(t);
  await put(path.join(root, 'cache', 'a'), 'abc');
  await directoryLink(folder, path.join(outside, 'system-alias'));
  const aliasRoot = path.join(outside, 'system-alias', 'owned');
  assert.deepEqual(await cleanManagedPath({ root: aliasRoot, relativePath: 'cache', preview: false }), { ...emptyResult(), bytes: 3, files: 1 });
  await assert.rejects(lstat(path.join(root, 'cache')), { code: 'ENOENT' });
  assert.ok((await lstat(root)).isDirectory());
});

test('linkOnly unlinks only exact task node_modules and preserves shared dependencies', async (t) => {
  const { root, outside } = await fixture(t);
  await put(path.join(outside, 'playwright', 'index.js'), 'shared dependency');
  await directoryLink(outside, path.join(root, 'node_modules'));
  const expected = { ...emptyResult(), files: 1 };
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'node_modules', linkOnly: true }), expected);
  assert.ok((await lstat(path.join(root, 'node_modules'))).isSymbolicLink());
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'node_modules', linkOnly: true, preview: false }), expected);
  await assert.rejects(lstat(path.join(root, 'node_modules')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(outside, 'playwright', 'index.js'), 'utf8'), 'shared dependency');
  assert.deepEqual(await cleanManagedPath({ root, relativePath: 'node_modules', linkOnly: true, preview: false }), emptyResult());
});

test('linkOnly cannot be used as general deletion or traverse a linked ancestor', async (t) => {
  const { root, outside } = await fixture(t);
  await put(path.join(root, 'node_modules', 'keep.js'));
  for (const relativePath of ['cache', 'nested/node_modules']) {
    await assert.rejects(cleanManagedPath({ root, relativePath, linkOnly: true, preview: false }), { code: 'INVALID_CLEANUP_PATH' });
  }
  await assert.rejects(cleanManagedPath({ root, relativePath: 'node_modules', linkOnly: true, preview: false }), { code: 'INVALID_CLEANUP_PATH' });
  await directoryLink(root, path.join(outside, 'alias'));
  await assert.rejects(cleanManagedPath({ root: path.join(outside, 'alias'), relativePath: 'node_modules', linkOnly: true, preview: false }), { code: 'INVALID_CLEANUP_PATH' });
  assert.equal(await readFile(path.join(root, 'node_modules', 'keep.js'), 'utf8'), 'keep');
});

test('filesystem permission failures are reported without claiming deleted files', async (t) => {
  if (process.platform === 'win32') { t.skip('Windows chmod does not prohibit unlink; POSIX CI exercises directory permissions'); return; }
  if (process.getuid?.() === 0) { t.skip('root can bypass filesystem permission bits'); return; }
  const { root } = await fixture(t);
  const cache = path.join(root, 'cache');
  const file = path.join(cache, 'readonly');
  await put(file, 'keep');
  await chmod(cache, 0o500);
  try {
    const result = await cleanManagedPath({ root, relativePath: 'cache', preview: false });
    assert.equal(result.files, 0);
    assert.equal(result.bytes, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].path, 'cache/readonly');
    assert.match(result.failed[0].reason, /^(EPERM|EACCES)$/);
    assert.equal(await readFile(file, 'utf8'), 'keep');
  } finally { await chmod(cache, 0o700); }
});

test('operational unlink failure is reported while other regular files can still be cleaned', async (t) => {
  const { root } = await fixture(t);
  const blocked = path.join(root, 'cache', 'blocked');
  await put(blocked, 'keep');
  await put(path.join(root, 'cache', 'ok'), 'abc');
  const original = fs.unlink;
  const unlinkMock = t.mock.method(fs, 'unlink', async (file) => {
    if (file === blocked) throw Object.assign(new Error('injected operating-system refusal'), { code: 'EACCES' });
    return original(file);
  });
  syncBuiltinESMExports();
  try {
    const report = await cleanManagedPath({ root, relativePath: 'cache', preview: false });
    assert.deepEqual(report, { ...emptyResult(), bytes: 3, files: 1, failed: [{ path: 'cache/blocked', reason: 'EACCES' }] });
    assert.equal(await readFile(blocked, 'utf8'), 'keep');
  } finally {
    unlinkMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cleanup uses bounded leaf concurrency without overlapping recursive directories', async (t) => {
  const { root, outside } = await fixture(t);
  const cache = path.join(root, 'cache');
  await put(path.join(outside, 'canary'), 'external');
  await put(path.join(root, 'Cookies'), 'login');
  for (const directory of ['', 'nested', 'nested/deeper', 'sibling']) {
    for (let index = 0; index < 9; index += 1) await put(path.join(cache, directory, `file-${index}`), 'abc');
  }
  await directoryLink(outside, path.join(cache, 'linked'));
  const preview = await cleanManagedPath({ root, relativePath: 'cache' });
  assert.equal(preview.files, 36);
  assert.equal(await readFile(path.join(cache, 'file-0'), 'utf8'), 'abc');
  const originalUnlink = fs.unlink;
  const originalRmdir = fs.rmdir;
  let active = 0;
  let maximum = 0;
  const activeDirectories = new Set();
  const unlinkMock = t.mock.method(fs, 'unlink', async (file) => {
    active += 1;
    maximum = Math.max(maximum, active);
    activeDirectories.add(path.dirname(file));
    try {
      assert.equal(activeDirectories.size, 1, 'finish leaves before entering another directory');
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await originalUnlink(file);
    } finally {
      active -= 1;
      if (!active) activeDirectories.clear();
    }
  });
  const rmdirMock = t.mock.method(fs, 'rmdir', async (file) => {
    assert.equal(active, 0, 'wait for every child deletion before removing its directory');
    return originalRmdir(file);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await cleanManagedPath({ root, relativePath: 'cache', preview: false }), preview);
    assert.ok(maximum >= 2, 'independent leaf deletions overlap');
    assert.ok(maximum <= 4, `leaf concurrency is bounded: ${maximum}`);
    assert.equal(await readFile(path.join(outside, 'canary'), 'utf8'), 'external');
    assert.equal(await readFile(path.join(root, 'Cookies'), 'utf8'), 'login');
    assert.ok((await lstat(path.join(cache, 'linked'))).isSymbolicLink());
    await assert.rejects(lstat(path.join(cache, 'nested')), { code: 'ENOENT' });
    await assert.rejects(lstat(path.join(cache, 'sibling')), { code: 'ENOENT' });
  } finally {
    unlinkMock.mock.restore();
    rmdirMock.mock.restore();
    syncBuiltinESMExports();
  }
});

test('cleanup preserves entries that change between readdir classification and visit', async (t) => {
  for (const preview of [true, false]) {
    const { root } = await fixture(t);
    const cache = path.join(root, 'cache');
    const becameDirectory = path.join(cache, 'file-to-directory');
    const becameFile = path.join(cache, 'directory-to-file');
    await put(becameDirectory, 'old');
    await mkdir(becameFile);
    const original = fs.readdir;
    let changed = false;
    const readdirMock = t.mock.method(fs, 'readdir', async (file, options) => {
      const children = await original(file, options);
      if (file === cache && !changed) {
        changed = true;
        await fs.unlink(becameDirectory);
        await put(path.join(becameDirectory, 'canary'), 'new directory');
        await fs.rmdir(becameFile);
        await writeFile(becameFile, 'new file');
      }
      return children;
    });
    syncBuiltinESMExports();
    try {
      const result = await cleanManagedPath({ root, relativePath: 'cache', preview });
      assert.equal(result.files, 0);
      assert.equal(result.bytes, 0);
      assert.deepEqual(result.skipped, []);
      assert.deepEqual(result.failed.map((failure) => failure.path).sort(), ['cache/directory-to-file', 'cache/file-to-directory']);
      assert.ok(result.failed.every((failure) => failure.reason === 'PATH_CHANGED'));
      assert.equal(await readFile(path.join(becameDirectory, 'canary'), 'utf8'), 'new directory');
      assert.equal(await readFile(becameFile, 'utf8'), 'new file');
    } finally {
      readdirMock.mock.restore();
      syncBuiltinESMExports();
    }
  }
});
