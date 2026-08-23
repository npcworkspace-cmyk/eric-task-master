import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../examples/tasks/durable-delay-task.mjs';

test('durable-delay resumes after the last checkpoint without repeating completed units', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-durable-delay-resume-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const initialEvents = [
    { current: 1, total: 3, at: '2026-08-24T00:00:01.000Z' },
    { current: 2, total: 3, at: '2026-08-24T00:00:02.000Z' }
  ];
  let saved = {
    stage: 'delay',
    current: 2,
    total: 3,
    delayMs: 10,
    events: initialEvents
  };
  const waited = [];
  const progressed = [];
  const checkpoint = async (data) => { saved = structuredClone(data); };
  checkpoint.read = async () => structuredClone(saved);

  const result = await run({
    input: { steps: 3, delayMs: 10 },
    outputDir,
    action: { wait: async (milliseconds) => waited.push(milliseconds) },
    progress: async (record) => progressed.push(record),
    checkpoint
  });

  assert.deepEqual(waited, [10]);
  assert.deepEqual(progressed.map((item) => item.current), [3]);
  assert.equal(saved.current, 3);
  assert.equal(saved.events.length, 3);
  assert.equal(result.summary, 'Completed 3 durable progress steps');
  const artifact = JSON.parse(await readFile(path.join(outputDir, 'durable-delay.json'), 'utf8'));
  assert.deepEqual(artifact.events.slice(0, 2), initialEvents);
  assert.equal(artifact.events.length, 3);
});
