import assert from 'node:assert/strict';
import test from 'node:test';
import { createOfficialCliAdapter } from '../../src/registration/official-cli.mjs';

const CLIENT_ID = 'installation:openclaw';
const MANAGED_ENV_KEYS = [
  'ERIC_TASK_MASTER_CLIENT_ID',
  'ERIC_TASK_MASTER_CLIENT_NAME',
  'TASKMASTER_CLIENT_ID',
  'TASKMASTER_CLIENT_NAME',
  'ERIC_TASK_MASTER_RUNTIME_VERSION'
];

function desired(version = '2.1.3') {
  return {
    command: '/runtime/node',
    args: ['/runtime/stdio.mjs'],
    env: {
      ERIC_TASK_MASTER_CLIENT_ID: CLIENT_ID,
      ERIC_TASK_MASTER_CLIENT_NAME: 'Eric Task Master / OpenClaw',
      TASKMASTER_CLIENT_ID: CLIENT_ID,
      TASKMASTER_CLIENT_NAME: 'Eric Task Master / OpenClaw',
      ERIC_TASK_MASTER_RUNTIME_VERSION: version
    }
  };
}

function metadataEntry(overrides = {}) {
  return {
    ...desired('2.1.2'),
    enabled: false,
    cwd: '/operator/work',
    toolFilter: { include: ['taskmaster_*'], exclude: ['taskmaster_profiles_delete'] },
    requestTimeoutMs: 12_000,
    connectionTimeoutMs: 3_000,
    supportsParallelToolCalls: true,
    codex: { agents: ['main'], defaultToolsApprovalMode: 'prompt' },
    futureHostField: { preserve: true },
    env: {
      ...desired('2.1.2').env,
      RETRIES: 3,
      FEATURE_FLAG: true
    },
    ...overrides
  };
}

function fixture(initialEntry) {
  let entry = initialEntry === null ? null : structuredClone(initialEntry);
  let mutations = 0;
  let beforeList = null;
  const runner = async (_command, args) => {
    if (args[1] === 'list') {
      if (beforeList) {
        const mutate = beforeList;
        beforeList = null;
        mutate(entry);
      }
      return {
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify(entry ? { 'eric-task-master': entry } : {})
      };
    }
    if (args[1] === 'set') {
      entry = JSON.parse(args[3]);
      mutations += 1;
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    if (args[1] === 'unset') {
      entry = null;
      mutations += 1;
      return { exitCode: 0, signal: null, stdout: '{}' };
    }
    throw new Error(`Unexpected OpenClaw fixture command: ${args.join(' ')}`);
  };
  const host = {
    key: 'openclaw',
    executable: 'openclaw',
    managedEnvKeys: MANAGED_ENV_KEYS
  };
  return {
    adapter: createOfficialCliAdapter(host, { commandRunner: runner, platform: 'linux', env: {} }),
    context: { desired: desired(), clientId: CLIENT_ID },
    entry: () => structuredClone(entry),
    mutations: () => mutations,
    mutateBeforeNextList(callback) { beforeList = callback; }
  };
}

test('OpenClaw inspection preserves complete metadata and reports an owned disabled entry explicitly', async () => {
  const original = metadataEntry();
  const setup = fixture(original);
  const inspection = await setup.adapter.inspect(setup.context);

  assert.equal(inspection.state, 'disabled');
  assert.deepEqual(inspection.fullCurrentEntry, original);
  assert.equal(inspection.currentEntry.env.RETRIES, undefined);
  assert.equal(inspection.currentEntry.env.FEATURE_FLAG, undefined);
  assert.equal(inspection.currentFingerprint, setup.adapter.fingerprint(original));

  const active = fixture({ ...original, enabled: true, env: desired().env });
  assert.equal((await active.adapter.inspect(active.context)).state, 'registered');
  const implicitActive = fixture({ ...original, enabled: undefined, env: desired().env });
  assert.equal((await implicitActive.adapter.inspect(implicitActive.context)).state, 'registered');
});

test('OpenClaw owned upgrade changes only managed fields and preserves host metadata and mixed-value env', async () => {
  const original = metadataEntry({ enabled: true });
  const setup = fixture(original);
  const before = await setup.adapter.inspect(setup.context);
  assert.equal(before.state, 'owned_outdated');

  const next = setup.adapter.prepareEntry(setup.context, before.fullCurrentEntry);
  assert.equal(next.command, desired().command);
  assert.deepEqual(next.args, desired().args);
  assert.equal(next.env.ERIC_TASK_MASTER_RUNTIME_VERSION, '2.1.3');
  assert.equal(next.env.RETRIES, 3);
  assert.equal(next.env.FEATURE_FLAG, true);
  for (const key of [
    'enabled', 'cwd', 'toolFilter', 'requestTimeoutMs', 'connectionTimeoutMs',
    'supportsParallelToolCalls', 'codex', 'futureHostField'
  ]) {
    assert.deepEqual(next[key], original[key]);
  }

  const installed = await setup.adapter.install(setup.context, {
    expectedFullFingerprint: before.fullFingerprint,
    entry: next
  });
  assert.equal(installed.state, 'registered');
  assert.deepEqual(setup.entry(), next);
  assert.equal(setup.mutations(), 1);
});

test('OpenClaw full-entry CAS blocks metadata races and rollback restores an exact disabled definition', async () => {
  const original = metadataEntry();
  const setup = fixture({ ...original, enabled: true, env: desired().env });
  const before = await setup.adapter.inspect(setup.context);
  const next = setup.adapter.prepareEntry(setup.context, before.fullCurrentEntry);
  setup.mutateBeforeNextList((entry) => { entry.cwd = '/concurrent/edit'; });
  await assert.rejects(
    setup.adapter.install(setup.context, {
      expectedFullFingerprint: before.fullFingerprint,
      entry: next
    }),
    { code: 'HOST_CLI_CAS_MISMATCH' }
  );
  assert.equal(setup.mutations(), 0);
  assert.equal(setup.entry().cwd, '/concurrent/edit');

  const rollbackSetup = fixture(next);
  const current = await rollbackSetup.adapter.inspect(rollbackSetup.context);
  await rollbackSetup.adapter.restore(rollbackSetup.context, original, {
    expectedFullFingerprint: current.fullFingerprint
  });
  assert.deepEqual(rollbackSetup.entry(), original);
  assert.equal((await rollbackSetup.adapter.inspect(rollbackSetup.context)).state, 'disabled');

  const removeSetup = fixture(next);
  const removeBefore = await removeSetup.adapter.inspect(removeSetup.context);
  removeSetup.mutateBeforeNextList((entry) => {
    entry.toolFilter = { include: ['changed_after_preflight'] };
  });
  await assert.rejects(
    removeSetup.adapter.remove(removeSetup.context, {
      expectedFullFingerprint: removeBefore.fullFingerprint
    }),
    { code: 'HOST_CLI_CAS_MISMATCH' }
  );
  assert.equal(removeSetup.mutations(), 0);
  assert.deepEqual(removeSetup.entry().toolFilter, { include: ['changed_after_preflight'] });
});
