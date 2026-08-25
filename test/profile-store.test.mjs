import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProfileStore } from '../src/lib/profile-store.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'eric-task-master-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    filePath: join(root, 'profiles.json'),
    profilesRoot: join(root, 'profiles'),
    ...options
  };
  const store = new ProfileStore(config);
  await store.init();
  return { root, config, store };
}

test('ProfileStore persists CRUD data and rejects ambiguous names', async (t) => {
  const { config, store } = await fixture(t);
  const created = await store.create({
    name: '  Research  ',
    headless: true,
    browserEngine: 'chrome'
  });

  assert.equal(created.name, 'Research');
  assert.equal(created.kind, 'persistent');
  assert.equal(created.state, 'idle');
  assert.equal(created.headless, true);
  assert.equal(created.browserEngine, 'chrome');
  assert.equal(created.defaultBehavior, 'human');
  assert.match(created.id, /^profile_[a-f0-9]{32}$/);
  assert.equal(created.userDataDir, join(config.profilesRoot, created.id));

  const updated = await store.update(created.id, {
    name: 'Research primary',
    headless: false
  });
  assert.equal(updated.name, 'Research primary');
  assert.equal(updated.defaultBehavior, 'human');

  await assert.rejects(
    store.update(created.id, { defaultBehavior: 'human' }),
    { code: 'PERSISTENT_BEHAVIOR_FIXED' }
  );

  await assert.rejects(
    store.create({ name: 'research PRIMARY' }),
    { code: 'PROFILE_NAME_EXISTS', statusCode: 409 }
  );
  await assert.rejects(
    store.update(created.id, { userDataDir: 'elsewhere' }),
    { code: 'INVALID_PROFILE_PATCH' }
  );
  await assert.rejects(
    store.update(created.id, { browserEngine: 'chromium' }),
    { code: 'INVALID_PROFILE_PATCH' }
  );

  const reopened = new ProfileStore(config);
  await reopened.init();
  assert.deepEqual(await reopened.get(created.id), updated);

  const removed = await reopened.remove(created.id);
  assert.equal(removed.id, created.id);
  await assert.rejects(reopened.get(created.id), { code: 'PROFILE_NOT_FOUND' });
});

test('ProfileStore ignores legacy ownership and access without persisting either field', async (t) => {
  const { store } = await fixture(t);
  const profile = await store.create(
    { name: 'Globally shared' },
    { ownerClientId: 'legacy-agent', access: 'private' }
  );
  assert.equal(Object.hasOwn(profile, 'ownerClientId'), false);
  assert.equal(Object.hasOwn(profile, 'access'), false);
  const unchanged = await store.update(profile.id, { access: 'private' });
  assert.equal(Object.hasOwn(unchanged, 'access'), false);
});

test('ProfileStore creates ephemeral templates and migrates pre-kind records to persistent', async (t) => {
  const { config, store } = await fixture(t);
  const temporary = await store.create({ name: 'Anonymous work', kind: 'ephemeral' });
  assert.equal(temporary.kind, 'ephemeral');
  assert.equal(temporary.browserEngine, 'chromium');
  assert.equal(temporary.defaultBehavior, 'adaptive');
  assert.equal(
    (await store.update(temporary.id, { defaultBehavior: 'fast' })).defaultBehavior,
    'fast'
  );

  const data = JSON.parse(await readFile(config.filePath, 'utf8'));
  delete data.profiles[0].kind;
  await writeFile(config.filePath, `${JSON.stringify(data)}\n`);
  const reopened = new ProfileStore(config);
  await reopened.init();
  const migrated = await reopened.get(temporary.id);
  assert.equal(migrated.kind, 'persistent');
  assert.equal(migrated.defaultBehavior, 'human');

  await assert.rejects(
    reopened.create({ name: 'Invalid kind', kind: 'private' }),
    { code: 'INVALID_PROFILE_KIND' }
  );
  await assert.rejects(
    reopened.update(temporary.id, { kind: 'ephemeral' }),
    { code: 'INVALID_PROFILE_PATCH' }
  );
});

test('ProfileStore defaults new engines by kind and migrates legacy channels without fallback', async (t) => {
  const { config, store } = await fixture(t);
  const persistent = await store.create({ name: 'Persistent default' });
  const ephemeral = await store.create({ name: 'Ephemeral default', kind: 'ephemeral' });
  assert.equal(persistent.browserEngine, 'chrome');
  assert.equal(ephemeral.browserEngine, 'chromium');
  assert.equal(persistent.defaultBehavior, 'human');
  assert.equal(ephemeral.defaultBehavior, 'adaptive');
  await assert.rejects(
    store.create({ name: 'Unsafe persistent', defaultBehavior: 'adaptive' }),
    { code: 'PERSISTENT_BEHAVIOR_FIXED' }
  );

  const data = JSON.parse(await readFile(config.filePath, 'utf8'));
  data.version = 1;
  delete data.profiles[0].browserEngine;
  data.profiles[0].browserChannel = 'chrome';
  delete data.profiles[1].browserEngine;
  data.profiles[1].browserChannel = 'chromium';
  await writeFile(config.filePath, `${JSON.stringify(data)}\n`);

  const migrated = new ProfileStore(config);
  await migrated.init();
  assert.equal((await migrated.get(persistent.id)).browserEngine, 'chrome');
  assert.equal((await migrated.get(ephemeral.id)).browserEngine, 'chromium');
  const persisted = JSON.parse(await readFile(config.filePath, 'utf8'));
  assert.equal(persisted.version, 4);
  assert.equal(persisted.profiles.some((profile) => Object.hasOwn(profile, 'browserChannel')), false);

  persisted.version = 1;
  delete persisted.profiles[0].browserEngine;
  persisted.profiles[0].browserChannel = 'chrome-beta';
  await writeFile(config.filePath, `${JSON.stringify(persisted)}\n`);
  const before = await readFile(config.filePath, 'utf8');
  const rejected = new ProfileStore(config);
  await assert.rejects(rejected.init(), { code: 'PROFILE_ENGINE_MIGRATION_REQUIRED' });
  assert.equal(await readFile(config.filePath, 'utf8'), before);
});

test('ProfileStore rejects incomplete v2/v3 engine metadata without rewriting the store', async (t) => {
  const { config, store } = await fixture(t);
  await store.create({ name: 'Versioned engine', browserEngine: 'chrome' });
  const baseline = JSON.parse(await readFile(config.filePath, 'utf8'));

  for (const version of [2, 3]) {
    for (const corruption of ['missing-engine', 'legacy-channel']) {
      const data = structuredClone(baseline);
      data.version = version;
      if (corruption === 'missing-engine') delete data.profiles[0].browserEngine;
      else data.profiles[0].browserChannel = 'chrome';
      const before = `${JSON.stringify(data)}\n`;
      await writeFile(config.filePath, before);

      const reopened = new ProfileStore(config);
      await assert.rejects(
        reopened.init(),
        { code: 'PROFILE_ENGINE_MIGRATION_REQUIRED', statusCode: 409 }
      );
      assert.equal(
        await readFile(config.filePath, 'utf8'),
        before,
        `v${version} ${corruption} must remain byte-for-byte unchanged`
      );
    }
  }
});

test('ProfileStore enforces exclusive leases and recovers only expired dead owners', async (t) => {
  let currentTime = Date.parse('2026-08-23T00:00:00.000Z');
  const livingPids = new Set([101]);
  const { store } = await fixture(t, {
    now: () => currentTime,
    processAlive: async (pid) => livingPids.has(pid)
  });
  const profile = await store.create({ name: 'Lease test' });

  let leased = await store.acquireLease(profile.id, 'task:one', { pid: 101, ttlMs: 1_000 });
  assert.equal(leased.state, 'leased');
  assert.equal(leased.lease.ownerId, 'task:one');
  await assert.rejects(
    store.acquireLease(profile.id, 'task:two', { pid: 202, ttlMs: 1_000 }),
    { code: 'PROFILE_LEASED', statusCode: 409 }
  );

  currentTime += 2_000;
  await assert.rejects(
    store.acquireLease(profile.id, 'task:two', { pid: 202, ttlMs: 1_000 }),
    { code: 'PROFILE_LEASED', statusCode: 409 }
  );

  livingPids.delete(101);
  leased = await store.acquireLease(profile.id, 'task:two', { pid: 202, ttlMs: 1_000 });
  assert.equal(leased.lease.ownerId, 'task:two');
  await assert.rejects(
    store.releaseLease(profile.id, 'task:one'),
    { code: 'LEASE_OWNER_MISMATCH', statusCode: 409 }
  );
  assert.equal(await store.releaseLease(profile.id, 'task:two'), true);
  assert.equal((await store.get(profile.id)).state, 'idle');

  const opened = await store.acquireLease(
    profile.id,
    `profile-open:${profile.id}`,
    { pid: 303, ttlMs: 1_000 }
  );
  assert.equal(opened.state, 'open');
  await assert.rejects(store.remove(profile.id), { code: 'PROFILE_IN_USE', statusCode: 409 });
  await store.releaseLease(profile.id, `profile-open:${profile.id}`);
  assert.equal((await store.get(profile.id)).state, 'idle');
});

test('ProfileStore lease acquisition cannot overwrite a concurrent same-owner renewal', async (t) => {
  let currentTime = Date.parse('2026-08-23T00:00:00.000Z');
  let announceProbe;
  let releaseProbe;
  const probeStarted = new Promise((resolve) => { announceProbe = resolve; });
  const probeBarrier = new Promise((resolve) => { releaseProbe = resolve; });
  const { store } = await fixture(t, {
    now: () => currentTime,
    processAlive: async (pid) => {
      if (pid === 101) {
        announceProbe();
        await probeBarrier;
        return false;
      }
      return true;
    }
  });
  const profile = await store.create({ name: 'Lease CAS race' });
  await store.acquireLease(profile.id, 'task:owner-a', { pid: 101, ttlMs: 1_000 });
  currentTime += 2_000;

  const contender = store.acquireLease(profile.id, 'task:owner-b', { pid: 303, ttlMs: 1_000 });
  await probeStarted;
  const renewed = await store.acquireLease(profile.id, 'task:owner-a', { pid: 202, ttlMs: 60_000 });
  assert.equal(renewed.lease.pid, 202);
  releaseProbe();

  await assert.rejects(contender, { code: 'PROFILE_LEASED', statusCode: 409 });
  const final = await store.get(profile.id);
  assert.equal(final.lease.ownerId, 'task:owner-a');
  assert.equal(final.lease.pid, 202);
  assert.equal(final.lease.expiresAt, renewed.lease.expiresAt);
});

test('ProfileStore migrates private ownership metadata in place and keeps global lease exclusion', async (t) => {
  const { config, store } = await fixture(t);
  const profile = await store.create(
    { name: 'Global lease' },
    { ownerClientId: 'agent-a', access: 'private' }
  );
  const before = JSON.parse(await readFile(config.filePath, 'utf8'));
  before.version = 3;
  before.profiles[0].ownerClientId = 'agent-a';
  before.profiles[0].createdBy = 'agent-a';
  before.profiles[0].access = 'private';
  const originalPath = before.profiles[0].userDataDir;
  await writeFile(join(originalPath, 'login-state-marker.txt'), 'preserved');
  await writeFile(config.filePath, `${JSON.stringify(before)}\n`);

  const migrated = new ProfileStore(config);
  await migrated.init();
  const migratedProfile = await migrated.get(profile.id);
  assert.equal(migratedProfile.userDataDir, originalPath);
  assert.equal(await readFile(join(originalPath, 'login-state-marker.txt'), 'utf8'), 'preserved');
  assert.equal(Object.hasOwn(migratedProfile, 'ownerClientId'), false);
  assert.equal(Object.hasOwn(migratedProfile, 'createdBy'), false);
  assert.equal(Object.hasOwn(migratedProfile, 'access'), false);
  const persisted = JSON.parse(await readFile(config.filePath, 'utf8'));
  assert.equal(persisted.version, 4);

  await migrated.acquireLease(profile.id, 'task:agent-b', {
    pid: 701,
    ttlMs: 1_000,
    authorizedClientId: 'agent-b'
  });
  await assert.rejects(
    migrated.acquireLease(profile.id, 'task:agent-a', {
      pid: 702,
      ttlMs: 1_000,
      authorizedClientId: 'agent-a'
    }),
    { code: 'PROFILE_LEASED', statusCode: 409 }
  );
  await migrated.releaseLease(profile.id, 'task:agent-b');
  const nextLease = await migrated.acquireLease(profile.id, 'task:agent-a', {
    pid: 703,
    ttlMs: 1_000,
    authorizedClientId: 'agent-a'
  });
  assert.equal(nextLease.lease.ownerId, 'task:agent-a');
});

test('ProfileStore startup clears an expired lease after proving its process absent', async (t) => {
  let currentTime = Date.parse('2026-08-23T00:00:00.000Z');
  const root = await mkdtemp(join(tmpdir(), 'eric-task-master-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    filePath: join(root, 'profiles.json'),
    profilesRoot: join(root, 'profiles'),
    now: () => currentTime,
    processAlive: async () => false
  };
  const first = new ProfileStore(config);
  await first.init();
  const profile = await first.create({ name: 'Recovery' });
  await first.acquireLease(profile.id, 'task:abandoned', { pid: 404, ttlMs: 1_000 });

  currentTime += 2_000;
  const reopened = new ProfileStore(config);
  await reopened.init();
  const recovered = await reopened.get(profile.id);
  assert.equal(recovered.state, 'idle');
  assert.equal(recovered.lease, null);
});

test('ProfileStore never TTL-reclaims a session import lease without confirmed cleanup', async (t) => {
  let currentTime = Date.parse('2026-08-23T00:00:00.000Z');
  const root = await mkdtemp(join(tmpdir(), 'eric-task-master-cleanup-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    filePath: join(root, 'profiles.json'),
    profilesRoot: join(root, 'profiles'),
    now: () => currentTime,
    processAlive: async () => false
  };
  const first = new ProfileStore(config);
  await first.init();
  const profile = await first.create({ name: 'Cleanup proof' });
  await first.acquireLease(profile.id, 'session-import:cleanup-proof', {
    pid: 505,
    ttlMs: 1_000,
    cleanupRequired: true
  });

  currentTime += 2_000;
  const reopened = new ProfileStore(config);
  await reopened.init();
  const blocked = await reopened.get(profile.id);
  assert.equal(blocked.lease.ownerId, 'session-import:cleanup-proof');
  assert.equal(blocked.lease.cleanupRequired, true);
  await assert.rejects(
    reopened.acquireLease(profile.id, 'task:other', { pid: 606, ttlMs: 1_000 }),
    { code: 'PROFILE_CLEANUP_UNCONFIRMED', statusCode: 409 }
  );
  await reopened.markCleanupUnknown(profile.id, 'session-import:cleanup-proof');
  assert.equal((await reopened.get(profile.id)).state, 'error');
  await assert.rejects(
    reopened.releaseLease(profile.id, 'session-import:cleanup-proof'),
    { code: 'CLEANUP_PROOF_REQUIRED', statusCode: 409 }
  );
  assert.equal(await reopened.releaseLease(
    profile.id,
    'session-import:cleanup-proof',
    { cleanupConfirmed: true }
  ), true);
  assert.equal((await reopened.get(profile.id)).state, 'idle');
});
