import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { VERSION } from '../src/contracts.mjs';
import { createOperationsHarness, ROOT, pause } from './fixtures/fast-operations/harness.mjs';

const execFile = promisify(execFileCallback);

test('live Manager and Worker acknowledge the reserved dialog scene despite unrelated DOM updates', { timeout: 30000 }, async (t) => {
  const outputDir = path.join(ROOT, 'artifacts', 'fast-dialog-scene', String(Date.now()));
  const h = await createOperationsHarness({ outputDir, label: 'live-dialog-scene',
    executeFile: (executable, args, options) => execFile(executable, args, { ...options, env: { ...options.env,
      ERIC_TASK_MASTER_AGENT_ID: 'live-dialog-scene-test', ERIC_TASK_MASTER_AGENT_SKILL_VERSION: VERSION,
      ERIC_TASK_MASTER_SKILL_DIR: path.join(ROOT, 'skills', 'eric-task-master') } }),
    startFixture: async () => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><title>Live dialog scene</title><h1>Local dialog test</h1>'
          + '<button onclick="document.querySelector(\'#status\').textContent=confirm(\'Local synthetic confirmation\')?\'accepted\':\'cancelled\'">Open local confirm</button>'
          + '<p id="status">not opened</p><p id="counter">0</p><script>let n=0;setInterval(()=>document.querySelector(\'#counter\').textContent=String(++n),25)</script>');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
    }
  });
  t.after(async () => { const cleanup = await h.finish(); assert.equal(cleanup.ok, true, JSON.stringify(cleanup)); });
  const operation = await h.start('site', { authorization: undefined, identity: null });
  await h.navigate(operation.id, `${h.fixture.origin}/`);
  const interrupted = await h.command(operation.id, 'batch', { actions: [{ type: 'click', effect: false, target: { role: 'button', name: 'Open local confirm' } }] });
  assert.equal(interrupted.reason, 'UNEXPECTED_DIALOG');
  const observed = await h.observe(operation.id);
  await pause(150);
  const acknowledgement = await h.command(operation.id, 'control', { action: 'acknowledge-dialog', reason: 'Observed the cancelled synthetic confirmation; no external effect was submitted.' },
    { pageId: observed.pageId, pageVersion: observed.pageVersion });
  const actual = await h.cli(['ops', 'get', operation.id]);
  await writeFile(path.join(outputDir, 'dialog-scene-report.json'), JSON.stringify({ interrupted, observed, acknowledgement,
    records: actual.records.filter(record => record.kind === 'dialog-acknowledgement') }, null, 2));
  assert.equal(acknowledgement.status, 'confirmed', JSON.stringify(acknowledgement));
  assert.equal(acknowledgement.result.requiresObservation, true);
  const stored = actual.records.find(record => record.kind === 'dialog-acknowledgement');
  assert.ok(stored, 'the real Manager must commit the acknowledgement, not a stub ACK');
  assert.equal(stored.pageVersion, observed.pageVersion, 'the receipt binds the exact scene reserved by the Agent');
  assert.equal(typeof acknowledgement.result.pageVersion, 'string');
  assert.notEqual(acknowledgement.result.pageVersion, observed.pageVersion, 'live unrelated mutations must really have occurred');
});
