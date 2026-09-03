import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { removeTestTree } from './test-fs.mjs';
import { ProfileStore } from '../src/lib/profile-store.mjs';

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
