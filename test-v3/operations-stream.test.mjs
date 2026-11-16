import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/contracts.mjs';
import { managerStateId } from '../src/lib/manager-state.mjs';
import { operationCommandLines } from '../src/lib/operations-stream.mjs';
import { removeTestTree } from './test-fs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collect = async (input, maxBytes) => { const values = []; for await (const line of operationCommandLines(input, maxBytes)) values.push(line); return values; };

test('JSON line framing handles chunked Unicode, CRLF, empty lines and final EOF', async () => {
  const bytes = Buffer.from('{"value":"中文"}\r\n\n{"last":true}');
  assert.deepEqual(await collect(Readable.from([bytes.subarray(0, 12), bytes.subarray(12, 14), bytes.subarray(14)])), ['{"value":"中文"}', '', '{"last":true}']);
});

test('oversized JSON line fails before decoding/parsing and never yields its remainder', async () => {
  const input = Readable.from([Buffer.from('1234'), Buffer.from('56789\n{"mustNotRun":true}\n')]);
  await assert.rejects(collect(input, 8), { code: 'COMMAND_TOO_LARGE' });
});

async function fixture(t, respond) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-stream-'));
  const instance = 'stream-test-instance-00000001';
  const token = 's'.repeat(48);
  await writeFile(path.join(directory, 'config.json'), JSON.stringify({ managerToken: token, stateInstanceId: instance }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    const item = { method: req.method, url: req.url, authorization: req.headers.authorization };
    requests.push(item);
    if (req.url === '/v1/health') {
      res.end(JSON.stringify({ service: 'eric-task-master', version: VERSION, apiVersion: 3, pid: fixture.pid,
        stateId: managerStateId(instance, directory), stateChanged: false })); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    item.body = JSON.parse(body);
    await respond(item, res);
  });
  fixture.pid = 912345;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await removeTestTree(directory); });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), 'ops', 'stream', 'op_stream', '--state-dir', directory, '--port', String(server.address().port), '--json'], {
    cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '',
      ERIC_TASK_MASTER_HOME: directory, ERIC_TASK_MASTER_PORT: String(server.address().port),
      ERIC_TASK_MASTER_AGENT_ID: 'operations-stream-test', ERIC_TASK_MASTER_AGENT_SKILL_VERSION: VERSION,
      ERIC_TASK_MASTER_SKILL_DIR: path.join(ROOT, 'skills', 'eric-task-master') }
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr, replies: stdout.trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse) })); });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { child, requests, completed };
}
const confirmed = (item, res) => res.end(JSON.stringify({ ok: true, result: { commandId: item.body.commandId, status: 'confirmed', result: { echoed: item.body.kind } } }));

test('persistent CLI keeps common envelopes, ordered replies and selected Manager checks; EOF never stops work', { timeout: 10000 }, async t => {
  let active = 0, peak = 0;
  const f = await fixture(t, async (item, res) => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 15)); confirmed(item, res); active--; });
  f.child.stdin.end('{"commandId":"read-1","kind":"observe"}\n{"commandId":"read-2","kind":"tabs"}\n');
  const result = await f.completed;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.replies.map(r => r.commandId), ['read-1', 'read-2']);
  assert.equal(peak, 1);
  const submitted = f.requests.filter(r => r.method === 'POST');
  assert.equal(submitted.length, 2);
  assert.ok(submitted.every(r => r.url === '/v1/operations/op_stream/commands?waitMs=30000&detail=compact' && r.authorization === `Bearer ${'s'.repeat(48)}`));
  assert.ok(f.requests.filter(r => r.url === '/v1/health').length >= 3);
  assert.equal(f.requests.some(r => /actions|stop|resume/u.test(r.url)), false);
});

test('malformed lines and Manager rejections produce ordered errors without an implicit retry', { timeout: 10000 }, async t => {
  const f = await fixture(t, (item, res) => {
    if (item.body.commandId === 'write-1') { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: { code: 'RECONCILIATION_REQUIRED', message: 'Inspect the previous effect' } })); }
    else confirmed(item, res);
  });
  f.child.stdin.end('not-json\n{"commandId":"write-1","kind":"batch","payload":{"actions":[{"type":"click"}]}}\n{"commandId":"read-2","kind":"observe"}\n');
  const result = await f.completed;
  assert.equal(result.code, 1);
  assert.deepEqual(result.replies.map(r => r.error?.code || r.commandId), ['INVALID_JSON', 'RECONCILIATION_REQUIRED', 'read-2']);
  assert.deepEqual(f.requests.filter(r => r.method === 'POST').map(r => r.body.commandId), ['write-1', 'read-2']);
});

test('Manager process replacement ends the stream before a queued command can be submitted', { timeout: 10000 }, async t => {
  const f = await fixture(t, (item, res) => { fixture.pid++; confirmed(item, res); });
  f.child.stdin.end('{"commandId":"read-1","kind":"observe"}\n{"commandId":"write-2","kind":"batch","payload":{"actions":[{"type":"click"}]}}\n');
  const result = await f.completed;
  assert.equal(result.code, 1);
  assert.equal(result.replies[0].commandId, 'read-1');
  assert.equal(result.replies[1].error.code, 'MANAGER_SESSION_CHANGED');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 1);
});

test('oversized stdin command returns a bounded error and dispatches nothing', { timeout: 10000 }, async t => {
  const f = await fixture(t, () => assert.fail('oversized line must not dispatch'));
  f.child.stdin.end(`{"text":"${'x'.repeat(128 * 1024)}"}\n{"kind":"observe"}\n`);
  const result = await f.completed;
  assert.equal(result.code, 1);
  assert.equal(result.replies.length, 1);
  assert.equal(result.replies[0].error.code, 'COMMAND_TOO_LARGE');
  assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
});
