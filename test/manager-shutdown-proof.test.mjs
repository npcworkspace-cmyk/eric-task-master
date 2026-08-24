import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { waitForManagerShutdownProof } from '../src/lib/manager-shutdown-proof.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'taskmaster-manager-stop-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'manager.json');
  const record = { pid: 43210, version: '1.0.0', baseUrl: 'http://127.0.0.1:19946' };
  await writeFile(pidFile, `${JSON.stringify(record)}\n`);
  return { pidFile, record };
}

test('Manager stop succeeds only after the serving process removes its own PID record', async (t) => {
  const { pidFile, record } = await fixture(t);
  const removal = setTimeout(() => void unlink(pidFile).catch(() => {}), 25);
  t.after(() => clearTimeout(removal));

  assert.equal(await waitForManagerShutdownProof(pidFile, record, {
    timeoutMs: 500,
    pollMs: 10
  }), true);
});

test('an unreachable Manager with a retained PID record is not reported cleanly stopped', async (t) => {
  const { pidFile, record } = await fixture(t);

  assert.equal(await waitForManagerShutdownProof(pidFile, record, {
    timeoutMs: 30,
    pollMs: 5
  }), false);
  assert.deepEqual(JSON.parse(await readFile(pidFile, 'utf8')), record);
});

test('a replaced or malformed PID record never proves shutdown', async (t) => {
  const { pidFile, record } = await fixture(t);
  await writeFile(pidFile, '{not-json');
  assert.equal(await waitForManagerShutdownProof(pidFile, record, { timeoutMs: 10 }), false);

  await writeFile(pidFile, `${JSON.stringify({ ...record, pid: record.pid + 1 })}\n`);
  assert.equal(await waitForManagerShutdownProof(pidFile, record, { timeoutMs: 10 }), false);
});
