import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OperationalJournal } from '../src/lib/operational-journal.mjs';

test('operational journal rotates, bounds, and redacts diagnostic events', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = new OperationalJournal({
    stateDir: root,
    maxBytes: 420,
    maxFiles: 3,
    now: () => Date.parse('2026-08-29T00:00:00.000Z')
  });

  for (let index = 0; index < 12; index += 1) {
    await journal.append({
      level: 'error',
      component: 'manager',
      event: 'request.failed',
      requestId: `req_${String(index).padStart(16, '0')}`,
      method: 'POST',
      pathname: '/v1/tasks?token=LEAK42',
      statusCode: 400,
      code: 'TASK_INPUT_SCHEMA_FAILED',
      message: `Task input failed token=LEAK42 C:\\private\\task-${index}.json https://example.com/a?secret=LEAK42`
    });
  }

  const recent = await journal.readRecent({ limit: 3 });
  assert.equal(recent.length, 3);
  assert.equal(recent.every((entry) => entry.pathname === '/v1/tasks'), true);
  assert.equal(recent.every((entry) => entry.code === 'TASK_INPUT_SCHEMA_FAILED'), true);
  assert.equal(JSON.stringify(recent).includes('LEAK42'), false);
  assert.equal(JSON.stringify(recent).includes('C:\\private'), false);
  assert.equal(JSON.stringify(recent).includes('?secret='), false);

  const files = await readdir(join(root, 'logs'));
  assert.deepEqual(files.sort(), ['manager-events.1.jsonl', 'manager-events.2.jsonl', 'manager-events.jsonl']);
  const sources = await Promise.all(files.map((name) => readFile(join(root, 'logs', name), 'utf8')));
  assert.equal(sources.join('').includes('LEAK42'), false);
  assert.equal(sources.join('').includes('C:\\private'), false);
});

test('operational journal refuses a linked file instead of redirecting diagnostic writes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'taskmaster-journal-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, 'outside.txt');
  const logs = join(root, 'state', 'logs');
  const journalPath = join(logs, 'manager-events.jsonl');
  await mkdir(logs, { recursive: true });
  await writeFile(outside, 'keep\n');
  await link(outside, journalPath);
  const journal = new OperationalJournal({ stateDir: join(root, 'state') });

  await assert.rejects(journal.append({ level: 'error', event: 'request.failed' }), /private regular file/u);
  assert.equal(await readFile(outside, 'utf8'), 'keep\n');
});
