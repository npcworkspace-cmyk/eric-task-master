import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRegistry } from '../src/lib/agent-registry.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'eric-task-master-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = join(root, 'agents.json');
  const registry = new AgentRegistry({ filePath, ...options });
  await registry.init();
  return { filePath, registry };
}

test('AgentRegistry persists stable identities without persisting credentials', async (t) => {
  let now = Date.parse('2026-08-26T00:00:00.000Z');
  const { filePath, registry } = await fixture(t, { now: () => now });
  const registered = await registry.register({
    clientId: 'codex.primary',
    name: 'Codex Primary',
    token: 'must-not-persist'
  });
  assert.deepEqual(
    {
      agentId: registered.agentId,
      clientId: registered.clientId,
      displayName: registered.displayName,
      name: registered.name,
      status: registered.status,
      connectionCount: registered.connectionCount,
      lastSeenAt: registered.lastSeenAt
    },
    {
      agentId: 'codex.primary',
      clientId: 'codex.primary',
      displayName: 'Codex Primary',
      name: 'Codex Primary',
      status: 'registered',
      connectionCount: 0,
      lastSeenAt: null
    }
  );

  now += 1_000;
  const touched = await registry.touch('codex.primary', {
    displayName: 'Codex Desktop',
    connectionId: 'desktop-1'
  });
  assert.equal(touched.status, 'online');
  assert.equal(touched.connectionCount, 1);
  assert.equal(touched.displayName, 'Codex Desktop');
  assert.equal(touched.registeredAt, registered.registeredAt);

  const raw = await readFile(filePath, 'utf8');
  assert.equal(/must-not-persist|agentToken|tokenHash|"token"/u.test(raw), false);
  const reopened = new AgentRegistry({ filePath, now: () => now });
  await reopened.init();
  assert.equal((await reopened.get('codex.primary')).displayName, 'Codex Desktop');
});

test('AgentRegistry tracks concurrent connections and derives bounded presence and work status', async (t) => {
  let now = Date.parse('2026-08-26T01:00:00.000Z');
  const { registry } = await fixture(t, { now: () => now, onlineTtlMs: 5_000 });
  await registry.register({ clientId: 'workbuddy.local', displayName: 'WorkBuddy' });
  await Promise.all([
    registry.touch('workbuddy.local', { connectionId: 'window-1' }),
    registry.touch('workbuddy.local', { connectionId: 'window-2' }),
    registry.touch('workbuddy.local', { connectionId: 'window-3' })
  ]);
  assert.equal((await registry.get('workbuddy.local')).connectionCount, 3);

  const working = await registry.get('workbuddy.local', {
    activityByClientId: new Map([['workbuddy.local', {
      currentTaskIds: ['task_a', 'task_a', 'task_b'],
      currentProfileIds: ['profile_a'],
      queueDepth: 2
    }]])
  });
  assert.equal(working.status, 'working');
  assert.deepEqual(working.currentTaskIds, ['task_a', 'task_b']);
  assert.deepEqual(working.currentProfileIds, ['profile_a']);
  assert.equal(working.queueDepth, 2);

  assert.equal(await registry.disconnect('workbuddy.local', { connectionId: 'window-2' }), true);
  assert.equal((await registry.get('workbuddy.local')).connectionCount, 2);
  now += 5_001;
  assert.equal((await registry.get('workbuddy.local')).status, 'offline');
  assert.equal((await registry.get('workbuddy.local')).connectionCount, 0);
});

test('AgentRegistry revoke and restore are durable, idempotent, and require fresh presence', async (t) => {
  let now = Date.parse('2026-08-26T02:00:00.000Z');
  const { filePath, registry } = await fixture(t, { now: () => now });
  await registry.register({
    clientId: 'claude.host',
    displayName: 'Claude',
    connectionId: 'host-1'
  });
  const revoked = await registry.revoke('claude.host', { reason: 'Owner disabled this host' });
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.connectionCount, 0);
  assert.equal(await registry.isRevoked('claude.host'), true);
  await assert.rejects(
    registry.touch('claude.host', { connectionId: 'host-1' }),
    { code: 'AGENT_REVOKED', statusCode: 403 }
  );
  await assert.rejects(registry.requireActive('claude.host'), { code: 'AGENT_REVOKED' });
  await assert.rejects(
    registry.register({ clientId: 'claude.host', name: 'Renamed while revoked' }),
    { code: 'AGENT_REVOKED', statusCode: 403 }
  );
  assert.equal(
    (await registry.revoke('claude.host')).revokedReason,
    'Owner disabled this host'
  );

  now += 1_000;
  const restored = await registry.restore('claude.host');
  assert.equal(restored.status, 'offline');
  assert.equal(restored.connectionCount, 0);
  assert.equal(await registry.isRevoked('claude.host'), false);
  assert.equal((await registry.touch('claude.host', { connectionId: 'host-1' })).status, 'online');

  const reopened = new AgentRegistry({ filePath, now: () => now });
  await reopened.init();
  assert.equal((await reopened.get('claude.host')).status, 'online');
});

test('AgentRegistry rejects corrupt versions and removes accidental legacy credential fields', async (t) => {
  const { filePath, registry } = await fixture(t);
  await registry.register({ clientId: 'pi.local', name: 'Pi' });
  const data = JSON.parse(await readFile(filePath, 'utf8'));
  data.agents[0].token = 'legacy-secret';
  data.agents[0].tokenHash = 'legacy-hash';
  await writeFile(filePath, `${JSON.stringify(data)}\n`);

  const sanitized = new AgentRegistry({ filePath });
  await sanitized.init();
  const source = await readFile(filePath, 'utf8');
  assert.equal(source.includes('legacy-secret'), false);
  assert.equal(source.includes('legacy-hash'), false);

  const unsupported = JSON.parse(source);
  unsupported.version = 99;
  await writeFile(filePath, `${JSON.stringify(unsupported)}\n`);
  const before = await readFile(filePath, 'utf8');
  const rejected = new AgentRegistry({ filePath });
  await assert.rejects(rejected.init(), {
    code: 'AGENT_REGISTRY_VERSION_UNSUPPORTED',
    statusCode: 409
  });
  assert.equal(await readFile(filePath, 'utf8'), before);
});
