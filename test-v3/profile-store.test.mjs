import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeTestTree } from './test-fs.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';

test('reinstall keeps registered Profiles and adopts retained directories without changing login data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-reinstall-'));
  t.after(() => removeTestTree(root));
  const filePath = path.join(root, 'profiles.json');
  const profilesRoot = path.join(root, 'profiles');
  const options = { filePath, profilesRoot, profileUsageProbe: async () => 'inactive' };
  const original = new ProfileStore(options);
  await original.init();
  const first = await original.create({ name: 'Default' });
  const second = await original.create({ name: 'Research' });
  await original.update(second.id, { isDefault: true });
  const savedLogin = path.join(first.userDataDir, 'Local State');
  await writeFile(savedLogin, 'retained-login-data');

  const orphanId = `profile_${'c'.repeat(32)}`;
  const orphanDir = path.join(profilesRoot, orphanId);
  await mkdir(orphanDir);
  await writeFile(path.join(orphanDir, 'Local State'), 'orphan-login-data');
  await mkdir(path.join(profilesRoot, 'profile_invalid'));
  await writeFile(path.join(profilesRoot, `profile_${'d'.repeat(32)}`), 'not a directory');

  const reinstalled = new ProfileStore(options);
  await reinstalled.init();
  const profiles = await reinstalled.list();
  assert.equal(profiles.length, 3);
  assert.equal((await reinstalled.getDefault()).id, second.id);
  assert.equal((await reinstalled.get(first.id)).name, 'Default');
  assert.equal((await reinstalled.get(orphanId)).name, `Recovered ${orphanId}`);
  assert.equal((await reinstalled.get(orphanId)).state, 'idle');
  assert.equal(await readFile(savedLogin, 'utf8'), 'retained-login-data');
  assert.equal(await readFile(path.join(orphanDir, 'Local State'), 'utf8'), 'orphan-login-data');

  const restarted = new ProfileStore(options);
  await restarted.init();
  assert.equal((await restarted.list()).length, 3, 'repeated startup must not duplicate recovered Profiles');
  assert.equal((await restarted.get(orphanId)).name, `Recovered ${orphanId}`);
});

test('a proven state-directory alias preserves names, defaults and login bytes when rebasing Profile paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-alias-'));
  t.after(() => removeTestTree(root));
  const originalRoot = path.join(root, 'old-location');
  const physicalRoot = path.join(root, 'physical-location');
  const firstStore = new ProfileStore({ filePath: path.join(originalRoot, 'profiles.json'),
    profilesRoot: path.join(originalRoot, 'profiles'), profileUsageProbe: async () => 'inactive' });
  await firstStore.init();
  const first = await firstStore.create({ name: 'Account A' });
  const second = await firstStore.create({ name: 'Account B default' });
  await firstStore.update(second.id, { isDefault: true });
  await writeFile(path.join(first.userDataDir, 'Local State'), 'login-byte-canary');
  await rename(originalRoot, physicalRoot);
  const options = { filePath: path.join(physicalRoot, 'profiles.json'), profilesRoot: path.join(physicalRoot, 'profiles'),
    pathAliases: [path.join(originalRoot, 'profiles')], profileUsageProbe: async () => 'inactive' };
  const rebased = new ProfileStore(options);
  await rebased.init();
  assert.equal((await rebased.get(first.id)).name, first.name);
  assert.equal((await rebased.get(second.id)).name, second.name);
  assert.equal((await rebased.getDefault()).id, second.id);
  assert.equal((await rebased.get(first.id)).userDataDir, path.join(physicalRoot, 'profiles', first.id));
  assert.equal(await readFile(path.join(physicalRoot, 'profiles', first.id, 'Local State'), 'utf8'), 'login-byte-canary');
  const restarted = new ProfileStore(options);
  await restarted.init();
  assert.deepEqual((await restarted.list()).map((item) => item.id), [first.id, second.id]);
});

test('a state-directory alias never adopts arbitrary outside Profile paths', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-alias-reject-'));
  t.after(() => removeTestTree(root));
  const profileId = 'profile_' + 'a'.repeat(32);
  await writeFile(path.join(root, 'profiles.json'), JSON.stringify({ version: 1, defaultProfileId: profileId,
    profiles: [{ id: profileId, name: 'Untrusted outside', userDataDir: path.join(root, 'unrelated', profileId) }], deletions: [] }));
  const store = new ProfileStore({ filePath: path.join(root, 'profiles.json'), profilesRoot: path.join(root, 'profiles'),
    pathAliases: [path.join(root, 'owned-old-location', 'profiles')], profileUsageProbe: async () => 'inactive' });
  await store.init();
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.getDefault(), null);
});

test('directory-only recovery lists every Profile, requires a new default, and quarantines active Chrome', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-directory-only-'));
  t.after(() => removeTestTree(root));
  const profilesRoot = path.join(root, 'profiles');
  const firstId = `profile_${'a'.repeat(32)}`;
  const secondId = `profile_${'b'.repeat(32)}`;
  await mkdir(path.join(profilesRoot, firstId), { recursive: true });
  await mkdir(path.join(profilesRoot, secondId));
  await writeFile(path.join(profilesRoot, firstId, 'Local State'), 'first-session');
  await writeFile(path.join(profilesRoot, secondId, 'Local State'), 'second-session');
  let secondUsage = 'unknown';
  const store = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot,
    profileUsageProbe: async (userDataDir) => userDataDir.endsWith(secondId) ? secondUsage : 'inactive'
  });
  await store.init();
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.getDefault(), null, 'an unknown former default must not select the wrong login');
  assert.equal((await store.get(firstId)).state, 'idle');
  assert.equal((await store.get(secondId)).state, 'error');
  assert.equal((await store.get(secondId)).lease.identityUntrusted, true);
  await assert.rejects(store.acquireLease(secondId, {
    ownerId: 'task:recovery', kind: 'task', pid: process.pid, nonce: 'recovery-nonce'
  }), { code: 'PROFILE_CLEANUP_UNCONFIRMED' });
  secondUsage = 'active';
  assert.deepEqual(await store.recoverExpiredLeases(), []);
  assert.equal((await store.get(secondId)).state, 'error');
  secondUsage = 'inactive';
  assert.deepEqual(await store.recoverExpiredLeases(), [secondId]);
  assert.equal((await store.get(secondId)).state, 'idle');
  assert.equal(await readFile(path.join(profilesRoot, firstId, 'Local State'), 'utf8'), 'first-session');
  assert.equal(await readFile(path.join(profilesRoot, secondId, 'Local State'), 'utf8'), 'second-session');
});

test('ProfileStore reaps dead leases after cleanup proof or inactive Profile expiry', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-profile-'));
  t.after(() => removeTestTree(root));
  let clock = Date.now();
  const alive = new Set();
  let profileUsage = 'inactive';
  const store = new ProfileStore({
    filePath: path.join(root, 'profiles.json'),
    profilesRoot: path.join(root, 'profiles'),
    now: () => clock,
    processAlive: (pid) => alive.has(pid),
    profileUsageProbe: async () => profileUsage
  });
  await store.init();

  const first = await store.create({ name: 'Default Chrome' });
  const second = await store.create({ name: 'Research' });
  assert.equal((await store.getDefault()).id, first.id);
  await store.update(second.id, { isDefault: true, name: 'Research Login' });
  assert.equal((await store.getDefault()).name, 'Research Login');

  alive.add(101);
  const leased = await store.acquireLease(first.id, {
    ownerId: 'task:one',
    kind: 'task',
    taskId: 'task_one',
    pid: 101,
    nonce: 'nonce-one',
    ttlMs: 2_000
  });
  assert.equal(leased.state, 'leased');
  await assert.rejects(
    store.acquireLease(first.id, {
      ownerId: 'task:two', kind: 'task', taskId: 'task_two', pid: 102, nonce: 'nonce-two', ttlMs: 2_000
    }),
    { code: 'PROFILE_LEASED' }
  );

  assert.deepEqual(await store.recoverExpiredLeases(), []);
  alive.delete(101);
  assert.deepEqual(await store.recoverExpiredLeases(), []);
  assert.equal((await store.get(first.id)).state, 'error');
  await assert.rejects(
    store.releaseLease(first.id, {
      ownerId: 'task:one', nonce: 'nonce-one', generation: leased.lease.generation
    }),
    { code: 'PROFILE_CLEANUP_UNCONFIRMED' }
  );
  clock += 2_001;
  profileUsage = 'active';
  assert.deepEqual(await store.recoverExpiredLeases(), []);
  assert.equal((await store.get(first.id)).state, 'error');
  profileUsage = 'unknown';
  assert.deepEqual(await store.recoverExpiredLeases(), []);
  assert.equal((await store.get(first.id)).state, 'error');
  profileUsage = false;
  assert.deepEqual(await store.recoverExpiredLeases(), [first.id]);
  assert.equal((await store.get(first.id)).state, 'idle');

  alive.add(102);
  const confirmedLease = await store.acquireLease(first.id, {
    ownerId: 'task:three', kind: 'task', taskId: 'task_three', pid: 102,
    nonce: 'nonce-three', ttlMs: 2_000
  });
  alive.delete(102);
  assert.equal(await store.confirmLeaseCleanup(first.id, {
    ownerId: 'task:three', nonce: 'nonce-three', generation: confirmedLease.lease.generation
  }), true);
  assert.deepEqual(await store.recoverExpiredLeases(), [first.id]);
  assert.equal((await store.get(first.id)).state, 'idle');

  assert.equal(await store.confirmLeaseCleanup(first.id, {
    ownerId: 'task:one', nonce: 'nonce-one', generation: leased.lease.generation
  }), false);

  await store.remove(first.id);
  assert.equal((await store.list()).length, 1);
});

test('legacy leases without a trustworthy identity stay quarantined until the exact Profile is inactive', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-legacy-profile-'));
  t.after(() => removeTestTree(root));
  const profilesRoot = path.join(root, 'profiles');
  const profileId = `profile_${'a'.repeat(32)}`;
  const userDataDir = path.join(profilesRoot, profileId);
  await mkdir(userDataDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const filePath = path.join(root, 'profiles.json');
  await writeFile(filePath, `${JSON.stringify({
    version: 1,
    defaultProfileId: profileId,
    profiles: [{
      id: profileId,
      name: 'Legacy Chrome',
      userDataDir,
      state: 'leased',
      leaseGeneration: 7,
      lease: {
        ownerId: 'task:legacy-v2',
        kind: 'task',
        pid: 99101,
        generation: 7,
        acquiredAt: timestamp,
        heartbeatAt: timestamp,
        expiresAt: timestamp
      },
      createdAt: timestamp,
      updatedAt: timestamp
    }]
  }, null, 2)}\n`);

  let usage = 'active';
  const store = new ProfileStore({
    filePath,
    profilesRoot,
    processAlive: () => false,
    profileUsageProbe: async () => usage
  });
  await store.init();
  let migrated = await store.get(profileId);
  assert.equal(migrated.state, 'error');
  assert.equal(migrated.lease.identityUntrusted, true);

  usage = 'unknown';
  assert.deepEqual(await store.recoverExpiredLeases(), []);
  assert.ok((await store.get(profileId)).lease);

  usage = 'inactive';
  assert.deepEqual(await store.recoverExpiredLeases(), [profileId]);
  migrated = await store.get(profileId);
  assert.equal(migrated.state, 'idle');
  assert.equal(migrated.lease, null);
});

test('Profile deletion journal resumes every crash phase on restart', async (t) => {
  const roots = [];
  t.after(async () => {
    await Promise.all(roots.map((root) => removeTestTree(root)));
  });
  for (const phase of ['before-rename', 'after-rename', 'after-record-removal']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `taskmaster-profile-delete-${phase}-`));
    roots.push(root);
    const profilesRoot = path.join(root, 'profiles');
    const profileId = `profile_${phase === 'before-rename' ? 'b' : phase === 'after-rename' ? 'c' : 'd'}`.padEnd(40, phase === 'before-rename' ? 'b' : phase === 'after-rename' ? 'c' : 'd');
    const deletionId = `delete_${'e'.repeat(32)}`;
    const userDataDir = path.join(profilesRoot, profileId);
    const tombstonePath = path.join(profilesRoot, `.deleting-${profileId}-${deletionId}`);
    await mkdir(userDataDir, { recursive: true });
    await writeFile(path.join(userDataDir, 'Profile Data'), 'state');
    if (phase !== 'before-rename') await rename(userDataDir, tombstonePath);
    const timestamp = new Date().toISOString();
    const profile = {
      id: profileId,
      name: `Crash ${phase}`,
      userDataDir,
      state: 'deleting',
      lease: null,
      leaseGeneration: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastUsedAt: null
    };
    await writeFile(path.join(root, 'profiles.json'), `${JSON.stringify({
      version: 1,
      defaultProfileId: phase === 'after-record-removal' ? null : profileId,
      profiles: phase === 'after-record-removal' ? [] : [profile],
      deletions: [{
        id: deletionId,
        profileId,
        userDataDir,
        tombstonePath,
        createdAt: timestamp
      }]
    }, null, 2)}\n`);

    const store = new ProfileStore({
      filePath: path.join(root, 'profiles.json'),
      profilesRoot,
      processAlive: () => false,
      profileUsageProbe: async () => 'inactive'
    });
    await store.init();
    assert.deepEqual(await store.list(), [], phase);
    assert.equal((await store.snapshot()).deletions.length, 0, phase);
    await assert.rejects(access(userDataDir), { code: 'ENOENT' });
    await assert.rejects(access(tombstonePath), { code: 'ENOENT' });
  }
});
