import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createOperationsHarness, isolatedHarnessEnvironment } from './fixtures/fast-operations/harness.mjs';
import { removeTestTree } from './test-fs.mjs';

test('isolated harness removes inherited port rather than passing an invalid empty numeric option', () => {
  const inherited = { ERIC_TASK_MASTER_PORT: '19946', eric_task_master_port: '19947', ERIC_TASK_MASTER_HOME: 'shared-state', KEEP: 'yes' };
  const env = isolatedHarnessEnvironment('isolated-test-state', inherited);
  assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'ERIC_TASK_MASTER_PORT'), false);
  assert.equal(env.ERIC_TASK_MASTER_HOME, 'isolated-test-state');
  assert.equal(env.KEEP, 'yes');
  assert.equal(inherited.ERIC_TASK_MASTER_PORT, '19946');
});

for (const failedCommand of ['manager', 'profiles']) {
  test(`initialization failure at ${failedCommand} closes fixture and stops only isolated Manager`, async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), 'etm-fast-harness-'));
    const commands = [];
    let fixtureClosed = false;
    try {
      await assert.rejects(createOperationsHarness({ outputDir,
        startFixture: async () => ({ origin: 'http://127.0.0.1:1', close: async () => { fixtureClosed = true; } }),
        executeFile: async (_executable, args, options) => {
          const command = args[1]; const action = args[2];
          commands.push({ command, action, stateDir: args[args.indexOf('--state-dir') + 1] });
          assert.equal(Object.hasOwn(options.env, 'ERIC_TASK_MASTER_PORT'), false);
          if (command === failedCommand && action !== 'stop') throw new Error('injected startup failure');
          return { stdout: JSON.stringify({ ok: true, manager: { pid: 1 } }) + '\n' };
        }
      }), (error) => {
        assert.equal(error.startupCleanup.fixtureClosed, true);
        assert.equal(error.startupCleanup.managerStopRequested, true);
        return /injected startup failure/u.test(error.message);
      });
      assert.equal(fixtureClosed, true);
      const stop = commands.find((item) => item.command === 'manager' && item.action === 'stop');
      assert.equal(stop.stateDir, path.join(outputDir, 'isolated-state'));
    } finally { await removeTestTree(outputDir); }
  });
}
