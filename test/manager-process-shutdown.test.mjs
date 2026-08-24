import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shutdownManagerProcess } from '../src/lib/manager-process-shutdown.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-process-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = join(root, 'manager.json');
  const failureFile = join(root, 'manager-shutdown-failure.json');
  const pidRecord = { pid: 1234, version: '1.0.0', baseUrl: 'http://127.0.0.1:19946' };
  await writeFile(pidFile, `${JSON.stringify(pidRecord)}\n`);
  return { pidFile, failureFile, pidRecord };
}

test('successful Manager cleanup removes the PID proof only after stop resolves', async (t) => {
  const files = await fixture(t);
  let releaseStop;
  const stopBarrier = new Promise((resolveStop) => { releaseStop = resolveStop; });
  const stopping = shutdownManagerProcess({
    manager: { async stop() { await stopBarrier; } },
    ...files,
    trigger: 'api'
  });

  assert.deepEqual(JSON.parse(await readFile(files.pidFile, 'utf8')), files.pidRecord);
  releaseStop();
  await stopping;
  await assert.rejects(readFile(files.pidFile), { code: 'ENOENT' });
  await assert.rejects(readFile(files.failureFile), { code: 'ENOENT' });
});

test('failed Manager cleanup preserves the PID proof and writes redacted evidence', async (t) => {
  const files = await fixture(t);
  const marker = 'shutdown-secret-8wC4';
  await assert.rejects(
    shutdownManagerProcess({
      manager: {
        async stop() {
          throw Object.assign(new Error(`managerToken=${marker}`), { code: 'PROFILE_CLEANUP_FAILED' });
        }
      },
      ...files,
      trigger: 'api'
    }),
    { code: 'PROFILE_CLEANUP_FAILED' }
  );

  assert.deepEqual(JSON.parse(await readFile(files.pidFile, 'utf8')), files.pidRecord);
  const evidenceText = await readFile(files.failureFile, 'utf8');
  const evidence = JSON.parse(evidenceText);
  assert.equal(evidence.trigger, 'api');
  assert.equal(evidence.error.code, 'PROFILE_CLEANUP_FAILED');
  assert.equal(evidenceText.includes(marker), false);
  assert.match(evidence.error.message, /\[REDACTED\]/);
});
