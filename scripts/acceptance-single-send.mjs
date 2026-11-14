#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOperationsHarness, pause } from '../test-v3/fixtures/fast-operations/harness.mjs';
import { startFixtureServer } from '../test-v3/fixtures/fast-operations/server.mjs';
import { websiteBatch, socialReplyBatch, advertisingBatch, SIMULATED_SELECTORS as S } from '../src/runtime/operations-workflows.mjs';
import { jsonTransport } from '../src/runtime/single-send-transport.mjs';
import { isProcessAlive } from '../src/lib/process-tree.mjs';

const output = path.resolve(process.argv[2]); await mkdir(output, { recursive: true }); assert.deepEqual(await readdir(output), []);
const checks = [], snapshots = []; let h, failure, cleanup;
const record = (name, details = {}) => { checks.push({ name, ...details }); process.stdout.write(`${JSON.stringify({ check: name, ...details })}\n`); };
async function fixture(options) {
  const f = await startFixtureServer(options); const handler = f.server.listeners('request')[0]; f.server.removeListener('request', handler);
  // Preserve original pre-header socket.destroy and every independent effect.
  // This wrapper adds ONLY the separately declared post-header failure variant.
  f.server.on('request', (req, res) => {
    if (req.method === 'POST' && req.url === '/api/config' && f.state.flags.postHeader) {
      const end = res.end.bind(res), head = res.writeHead.bind(res);
      res.writeHead = (status, headers) => head(status, { ...headers, 'content-length': '4096' });
      res.end = () => { res.flushHeaders(); res.write('{"incomplete":'); setTimeout(() => req.socket.destroy(), 30); res.end = end; return res; };
    }
    void handler(req, res);
  }); return f;
}
async function submit(op, batch) {
  const obs = await h.observe(op.id); assert.equal(obs.status, 'confirmed');
  return h.command(op.id, 'batch', batch, { pageId: obs.pageId, pageVersion: obs.pageVersion });
}
function siteBatch(id, value, before) { return websiteBatch({ decision: { approved: true, id, reason: 'Explicit isolated single-send regression' }, selectors: S.site,
  record: { domain: 'example.test', accountId: 'account-1', resourceId: 'config-1', before, rollback: `Restore ${before}` }, nextValue: value, transport: jsonTransport(`${h.fixture.origin}/api/config`, { value }) }); }
try {
  h = await createOperationsHarness({ outputDir: path.join(output, 'runtime'), label: 'single-send', startFixture: fixture });
  for (const kind of ['social', 'ads', 'site']) {
    const op = await h.start(kind, { singleSendTransport: true }); assert.equal((await h.navigate(op.id, `${h.fixture.origin}/${kind}`)).status, 'confirmed');
    const before = await h.state(); let batch;
    if (kind === 'social') batch = socialReplyBatch({ decision: { approved: true, id: 'guard-social', reason: 'Local regression', ruleEvidence: 'Human review required' }, selectors: S.social,
      record: { platform: 'local', communityId: 'community-1', postId: 'post-1', conversationId: 'thread-1' }, replyText: 'single guarded reply', transport: jsonTransport(`${h.fixture.origin}/api/reply`, { text: 'single guarded reply' }) });
    if (kind === 'ads') batch = advertisingBatch({ decision: { approved: true, id: 'guard-ads', reason: 'Local regression' }, selectors: S.ads,
      record: { platform: 'Google', accountId: 'account-1', campaignId: 'campaign-1', currency: 'USD', budgetType: 'daily', before: before.budget, dataRange: 'last 7 days', dataAsOf: new Date().toISOString(), attribution: '7-day click', sufficient: true }, nextBudget: 105, transport: jsonTransport(`${h.fixture.origin}/api/budget`, { value: 105 }) });
    if (kind === 'site') batch = siteBatch('guard-site', 'single guarded configuration', before.config);
    const reply = await submit(op, batch); assert.equal(reply.status, 'confirmed', JSON.stringify(reply));
    const after = await h.state(); assert.equal(after.effects.length - before.effects.length, 1);
    const persisted = await h.cli(['ops', 'get', op.id]); const action = persisted.actions.find((a) => a.actionId === batch.actions.at(-1).actionId);
    assert.ok(action.transportForward); assert.equal(action.status, 'confirmed'); assert.equal(persisted.taskId, op.taskId); snapshots.push(persisted);
    record(`${kind} actual CLI/Manager/Worker/Chrome guarded UI submission`, { independentEffects: 1, status: reply.status }); await h.stop(op.id);
  }
  for (const fault of ['pre-header', 'post-header']) {
    const op = await h.start('site', { singleSendTransport: true }); assert.equal((await h.navigate(op.id, `${h.fixture.origin}/site`)).status, 'confirmed');
    await h.control({ disconnectAfterSubmit: fault === 'pre-header', postHeader: fault === 'post-header' });
    const before = await h.state(); const value = `unknown-${fault}`; const batch = siteBatch(`guard-${fault}`, value, before.config);
    const reply = await submit(op, batch); assert.equal(reply.status, 'unknown', JSON.stringify(reply));
    const after = await h.state(); assert.equal(after.effects.length - before.effects.length, 1); assert.equal(after.config, value);
    const original = await h.cli(['ops', 'get', op.id]); const ids = original.actions.filter((a) => ['initiated', 'unknown'].includes(a.status)).map((a) => a.actionId); assert.ok(ids.length);
    const replay = await h.cli(['ops', 'command', op.id, '--input', JSON.stringify({ commandId: `no-replay-${fault}`, kind: 'batch', payload: batch })], { expectedFailure: true }); assert.ok(replay.error);
    await h.control({ disconnectAfterSubmit: false, postHeader: false });
    if (fault === 'pre-header') {
      const manager = await h.managerMetadata(); const lock = JSON.parse(await readFile(path.join(h.stateDir, '.manager.lock'), 'utf8')); assert.equal(lock.pid, manager.pid); assert.equal(path.resolve(manager.stateDirEffective), path.resolve(h.stateDir));
      const tasks = JSON.parse(await readFile(path.join(h.stateDir, 'tasks/tasks.json'), 'utf8')); const worker = tasks.tasks.find((t) => t.id === op.taskId); assert.ok(worker?.workerPid);
      process.kill(manager.pid, 'SIGKILL');
      for (let n = 0; n < 150 && (isProcessAlive(manager.pid) || isProcessAlive(worker.workerPid)); n++) await pause(200);
      assert.equal(isProcessAlive(worker.workerPid), false); await h.cli(['manager', 'start']);
      for (let n = 0; n < 150; n++) { const p = (await h.cli(['profiles', 'list'])).profiles.find((p) => p.id === h.profile.id); if (p?.state === 'idle' && !p.lease) break; await pause(500); }
    }
    const readback = await h.command(op.id, 'reconcile', { url: `${h.fixture.origin}/site`, actionIds: ids, verify: batch.verify }); assert.equal(readback.status, 'confirmed', JSON.stringify(readback));
    const recovered = await h.cli(['ops', 'get', op.id]); assert.equal((await h.state()).effects.length, after.effects.length);
    if (fault === 'pre-header') {
      assert.notEqual(recovered.taskId, op.taskId); assert.equal(recovered.runtimeOptions.singleSendTransport, true); assert.equal(recovered.browserSelection.kind, 'profile');
      // Input is deliberately cleared/not exposed by publicTask. A new guarded
      // submission proves the recreated Worker actually applied both policies.
      const continued = siteBatch('after-restart-guarded', 'healthy-new-worker-value', value);
      assert.equal((await submit(recovered, continued)).status, 'confirmed'); assert.equal((await h.state()).effects.length, after.effects.length + 1);
      record('new Worker actually retains owned context policy and accepts one distinct guarded UI submission after reconciliation', { independentEffects: 1 });
    }
    else assert.equal(recovered.taskId, op.taskId);
    assert.equal((await h.observe(op.id, { scope: '#current-value' })).status, 'confirmed'); snapshots.push(recovered);
    record(`${fault} unknown is not replayed; exact same-resource readback${fault === 'pre-header' ? ' after actual Manager/Worker restart' : ' in same task'}`, { independentEffects: 1, status: reply.status }); await h.stop(op.id);
  }
} catch (e) { failure = { code: e.code, message: e.message, stack: e.stack }; }
finally { if (h) cleanup = await h.finish().catch((e) => ({ ok: false, message: e.message })); }
const report = { ok: !failure && cleanup?.ok === true, checks, snapshots, failure, cleanup, boundary: 'Isolated infrastructure acceptance decisions, not root live challenge decisions; no real accounts, server dedupe or generic exactly-once claim' };
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); process.stdout.write(`${JSON.stringify({ ok: report.ok, checks: checks.length, cleanup, failure })}\n`); if (!report.ok) process.exitCode = 1;
