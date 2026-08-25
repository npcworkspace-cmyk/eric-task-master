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
    defaultBehavior: 'fast',
    headless: true,
    browserEngine: 'chrome'
  });

  assert.equal(created.name, 'Research');
  assert.equal(created.kind, 'persistent');
  assert.equal(created.state, 'idle');
  assert.equal(created.headless, true);
  assert.equal(created.browserEngine, 'chrome');
  assert.match(created.id, /^profile_[a-f0-9]{32}$/);
  assert.equal(created.userDataDir, join(config.profilesRoot, created.id));

  const updated = await store.update(created.id, {
    name: 'Research primary',
    defaultBehavior: 'adaptive',
    headless: false
  });
  assert.equal(updated.name, 'Research primary');
  assert.equal(updated.defaultBehavior, 'adaptive');

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

test('ProfileStore rejects an explicitly empty access value', async (t) => {
  const { store } = await fixture(t);

  await assert.rejects(
    store.create({ name: 'Invalid empty access' }, { access: '' }),
    { code: 'INVALID_PROFILE_ACCESS' }
  );
  assert.deepEqual(await store.list(), []);
});

test('ProfileStore creates ephemeral templates and migrates pre-kind records to persistent', async (t) => {
  const { config, store } = await fixture(t);
  const temporary = await store.create({ name: 'Anonymous work', kind: 'ephemeral' });
  assert.equal(temporary.kind, 'ephemeral');
  assert.equal(temporary.browserEngine, 'chromium');

  const data = JSON.parse(await readFile(config.filePath, 'utf8'));
  delete data.profiles[0].kind;
  await writeFile(config.filePath, `${JSON.stringify(data)}\n`);
  const reopened = new ProfileStore(config);
  await reopened.init();
  assert.equal((await reopened.get(temporary.id)).kind, 'persistent');

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
  assert.equal(persisted.version, 2);
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

test('Profile access revocation is atomic with scoped lease acquisition', async (t) => {
  const { store } = await fixture(t);
  const profile = await store.create(
    { name: 'Shared access race' },
    { ownerClientId: 'agent-a', access: 'shared' }
  );

  await store.acquireLease(profile.id, 'task:agent-b', {
    pid: 701,
    ttlMs: 1_000,
    authorizedClientId: 'agent-b'
  });
  await assert.rejects(
    store.update(profile.id, { access: 'private' }),
    { code: 'PROFILE_IN_USE', statusCode: 409 }
  );
  assert.equal((await store.get(profile.id)).access, 'shared');
  await store.releaseLease(profile.id, 'task:agent-b');
  assert.equal((await store.update(profile.id, { access: 'private' })).access, 'private');
  await assert.rejects(
    store.acquireLease(profile.id, 'task:agent-b-again', {
      pid: 702,
      ttlMs: 1_000,
      authorizedClientId: 'agent-b'
    }),
    { code: 'PROFILE_ACCESS_DENIED', statusCode: 403 }
  );
  const ownerLease = await store.acquireLease(profile.id, 'task:agent-a', {
    pid: 703,
    ttlMs: 1_000,
    authorizedClientId: 'agent-a'
  });
  assert.equal(ownerLease.lease.ownerId, 'task:agent-a');
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
