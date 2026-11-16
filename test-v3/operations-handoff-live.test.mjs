import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import test from 'node:test';
import { VERSION } from '../src/contracts.mjs';
import { CLI, ROOT, createOperationsHarness, isolatedHarnessEnvironment } from './fixtures/fast-operations/harness.mjs';

const execute = promisify(execFileCallback);
const agentA = 'handoff-cli-context-a', agentB = 'handoff-cli-context-b';
const draft = 'Authorized synthetic handoff draft';
const savedText = `Saved once: ${draft}`;
const capture = { scope: 'main', maxItems: 20, maxChars: 3500 };
const scene = (reply) => reply.observation || reply.result?.observation || reply.result;
const environment = (stateDir, agentId, inherited = process.env) => ({ ...isolatedHarnessEnvironment(stateDir, inherited),
  ERIC_TASK_MASTER_AGENT_ID: agentId, ERIC_TASK_MASTER_AGENT_SKILL_VERSION: VERSION,
  ERIC_TASK_MASTER_SKILL_DIR: path.join(ROOT, 'skills', 'eric-task-master') });
async function bounded(promise, milliseconds, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function cliAs(receipt, agentId, args) {
  const result = await execute(receipt.launcher.executable, [receipt.launcher.entry, ...args, '--state-dir', receipt.stateDir, '--json'], {
    cwd: ROOT, env: environment(receipt.stateDir, agentId), windowsHide: true, timeout: 45000, maxBuffer: 12 * 1024 * 1024 });
  return JSON.parse(result.stdout.trim());
}
function openStream(receipt, agentId) {
  const child = spawn(receipt.launcher.executable, [receipt.launcher.entry, 'ops', 'stream', receipt.operationId,
    '--state-dir', receipt.stateDir, '--json'], { cwd: ROOT, env: environment(receipt.stateDir, agentId),
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = []; let stderr = '', ended = false;
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const waiter = pending.shift();
    if (!waiter) return;
    try { waiter.resolve(JSON.parse(line)); } catch (error) { waiter.reject(error); }
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', (error) => { for (const waiter of pending.splice(0)) waiter.reject(error); reject(error); });
    child.once('close', (code) => {
      ended = true; lines.close();
      for (const waiter of pending.splice(0)) waiter.reject(new Error(`CLI stream closed before reply (${code}): ${stderr}`));
      resolve({ code, stderr });
    });
  });
  return { child, agentId,
    async command(value) {
      assert.equal(ended, false); assert.equal(pending.length, 0, 'only one reviewed command may be in flight');
      const reply = new Promise((resolve, reject) => pending.push({ resolve, reject }));
      child.stdin.write(JSON.stringify(value) + '\n');
      return bounded(reply, 45000, 'CLI command did not return within its existing request boundary');
    },
    async close() { if (!ended) child.stdin.end(); return bounded(completed, 15000, 'CLI EOF did not settle'); },
    terminate() { if (!ended) child.kill(); }
  };
}

async function startHandoffFixture({ stateFile }) {
  const state = { submissions: 0, wrongActions: 0, note: '' };
  const server = http.createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 4096) throw new Error('Fixture request too large'); }
      if (request.method === 'POST' && request.url === '/save') {
        const value = JSON.parse(raw);
        if (value.note !== draft) state.wrongActions++;
        state.submissions++; state.note = String(value.note);
      } else if (request.method === 'POST' && request.url === '/wrong') state.wrongActions++;
      else if (request.method === 'GET' && request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' });
        response.end('<!doctype html><title>Independent CLI handoff</title><main><h1>Local handoff fixture</h1>'
          + `<label>Note<input id="note" aria-label="Note" value="${state.note}"></label>`
          + '<button id="save">Submit once</button><button id="wrong">Wrong target</button>'
          + `<p id="status" role="status" aria-label="Save result">${state.submissions ? savedText : 'Not submitted'}</p></main>`
          + '<script>document.querySelector("#save").onclick=async()=>{await fetch("/save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({note:document.querySelector("#note").value})});document.querySelector("#status").textContent="Submitted; explicit readback required"};'
          + 'document.querySelector("#wrong").onclick=()=>fetch("/wrong",{method:"POST",body:"{}"});</script>');
        return;
      } else if (!(request.method === 'GET' && request.url === '/state')) { response.writeHead(404); response.end('{}'); return; }
      await writeFile(stateFile, JSON.stringify(state, null, 2));
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(state));
    } catch (error) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

// This receiver is deliberately passed only a serialized, secret-free handoff
// receipt: no previous scene object, ref map or materialized delta cache.
async function receiveHandoff(receiptFile, streams) {
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  assert.equal(receipt.hasSceneCache, false); assert.equal(receipt.scene, undefined); assert.equal(receipt.items, undefined);
  const manager = (await cliAs(receipt, agentB, ['manager', 'status'])).manager;
  assert.equal(manager.pid, receipt.managerPid);
  const status = await cliAs(receipt, agentB, ['status', receipt.taskId]);
  const task = status.task || status;
  assert.equal(task.id, receipt.taskId); assert.equal(task.operationId, receipt.operationId); assert.equal(task.profileId, receipt.profile.id);
  assert.ok(['running', 'waiting'].includes(task.state), 'EOF must not have stopped the real Worker');
  const current = await cliAs(receipt, agentB, ['ops', 'get', receipt.operationId, '--detail', 'compact']);
  assert.equal(current.id, receipt.operationId); assert.equal(current.taskId, receipt.taskId);
  assert.equal(current.browserSelection.profileId, receipt.profile.id);
  const stream = openStream(receipt, agentB); streams.add(stream);
  const freshBody = { commandId: 'handoff-b-fresh-observe', kind: 'observe', payload: { ...capture } };
  assert.equal(Object.hasOwn(freshBody.payload, 'baselineId'), false);
  const fresh = await stream.command(freshBody), freshScene = scene(fresh);
  assert.equal(fresh.status, 'confirmed'); assert.equal(freshScene.delta, undefined);
  assert.equal(fresh.pageId, receipt.pageId, 'the original browser page must survive across CLI processes');
  assert.ok(freshScene.items.some((item) => item.role === 'textbox' && item.name === 'Note' && item.value === receipt.authorizedDraft));
  const submit = freshScene.items.find((item) => item.role === 'button' && item.name === 'Submit once');
  assert.ok(submit?.ref, 'receiver B discovers its target from its own fresh scene');
  const history = await cliAs(receipt, agentB, ['ops', 'get', receipt.operationId, '--command', receipt.lastCommandId, '--detail', 'full']);
  assert.equal(history.command.reply.commandId, receipt.lastCommandId);
  assert.equal(scene(history.command.reply).delta, true, 'full retrieval restores the original delta, not a fabricated full past scene');
  const submitId = 'handoff-b-submit', actionId = 'handoff-b-submit-action';
  // The fixture commits the one POST but deliberately withholds the expected UI
  // text until a fresh readback. The induced unknown is an acceptance case, not
  // an unexpected business failure. Native/default action deadlines stay intact.
  const uncertain = await stream.command({ commandId: submitId, kind: 'batch', payload: {
    actions: [{ actionId, type: 'click', target: { ref: submit.ref }, expected: receipt.expectedSave }], verify: [receipt.expectedSave] } });
  assert.equal(uncertain.status, 'unknown'); assert.equal(uncertain.reason, 'WRITE_RESULT_UNKNOWN');
  const uncertainRead = await cliAs(receipt, agentB, ['ops', 'get', receipt.operationId, '--command', submitId, '--detail', 'full']);
  assert.equal(uncertainRead.command.status, 'unknown');
  assert.deepEqual(uncertainRead.unresolvedActions.map((item) => item.actionId), [actionId]);
  const blocked = await stream.command({ commandId: 'handoff-b-prohibited-replay', kind: 'batch', payload: {
    actions: [{ actionId: 'handoff-b-prohibited-replay-action', type: 'click', target: { role: 'button', name: 'Submit once' } }] } });
  assert.equal(blocked.ok, false); assert.equal(blocked.error.code, 'RECONCILIATION_REQUIRED');
  const readback = await stream.command({ commandId: 'handoff-b-readback-only', kind: 'reconcile', payload: {
    url: receipt.url, refresh: true, actionIds: [actionId], verify: [receipt.expectedSave],
    reason: 'Read the committed synthetic server result after intentionally withheld UI confirmation; do not submit again.' } });
  assert.equal(readback.status, 'confirmed'); assert.equal(readback.result.matched, true);
  const audit = await cliAs(receipt, agentB, ['ops', 'get', receipt.operationId, '--detail', 'full']);
  assert.equal(audit.id, receipt.operationId); assert.equal(audit.taskId, receipt.taskId); assert.equal(audit.browserSelection.profileId, receipt.profile.id);
  assert.equal(audit.actions.find((item) => item.actionId === actionId).status, 'confirmed');
  assert.equal(audit.actions.some((item) => item.effect !== false && ['initiated', 'unknown'].includes(item.status)), false);
  assert.equal(audit.commands.some((item) => item.commandId === 'handoff-b-prohibited-replay'), false, 'prohibited replay was never reserved or executed');
  assert.equal(audit.commands.find((item) => item.commandId === submitId).reply.status, 'unknown', 'original uncertain receipt must remain truthful after reconciliation');
  const ended = await stream.close();
  assert.equal(ended.code, 1, 'the deliberate rejected line remains reflected in the stream exit code');
  return { streamPid: stream.child.pid, freshCommandId: fresh.commandId, samePage: fresh.pageId === receipt.pageId,
    freshObserveWithoutBaseline: true, historicalDeltaExact: true, inducedUnknown: uncertain.status,
    prohibitedReplay: blocked.error.code, reconciled: readback.status, originalUnknownReceiptRetained: true };
}

test('real independent CLI A/B contexts hand off one live operation without scene cache or replaying an unknown submission', { timeout: 90000 }, async (t) => {
  const outputDir = path.join(ROOT, 'artifacts', 'operations-handoff-live', String(Date.now())), streams = new Set();
  const h = await createOperationsHarness({ outputDir, label: 'independent-cli-handoff', startFixture: startHandoffFixture,
    executeFile: (executable, args, options) => execute(executable, args, { ...options, env: environment(options.env.ERIC_TASK_MASTER_HOME, agentA, options.env) }) });
  t.after(async () => {
    for (const stream of streams) { try { await stream.close(); } catch { stream.terminate(); } }
    const cleanup = await h.finish(); assert.equal(cleanup.ok, true, JSON.stringify(cleanup));
  });
  const operation = await h.start('site', { authorization: undefined, identity: null });
  const route = { launcher: { executable: process.execPath, entry: CLI }, stateDir: h.stateDir, operationId: operation.id };
  const stream = openStream(route, agentA); streams.add(stream);
  const opened = await stream.command({ commandId: 'handoff-a-open', kind: 'batch', payload: {
    actions: [{ type: 'navigate', effect: false, value: `${h.fixture.origin}/` }], observation: capture } });
  assert.equal(opened.status, 'confirmed');
  const note = scene(opened).items.find((item) => item.role === 'textbox' && item.name === 'Note'); assert.ok(note?.ref);
  const prepared = await stream.command({ commandId: 'handoff-a-draft', kind: 'batch', payload: {
    actions: [{ type: 'fill', effect: false, target: { ref: note.ref }, value: draft,
      expected: { target: { role: 'textbox', name: 'Note' }, value: draft } }], observation: capture } });
  assert.equal(prepared.status, 'confirmed'); assert.ok(scene(prepared).baselineId);
  const delta = await stream.command({ commandId: 'handoff-a-last-delta', kind: 'observe', payload: { ...capture, baselineId: scene(prepared).baselineId } });
  assert.equal(delta.status, 'confirmed'); assert.equal(scene(delta).delta, true);
  assert.equal(delta.operationId, undefined, 'last compact reply alone deliberately lacks the operation route');
  const ended = await stream.close(); assert.equal(ended.code, 0, ended.stderr);
  const task = (await h.cli(['status', operation.taskId])).task;
  const events = await h.cli(['ops', 'events', operation.id]);
  const receipt = { ...route, version: VERSION, taskId: operation.taskId, profile: { id: h.profile.id, name: h.profile.name },
    managerPid: h.manager.pid, pageId: delta.pageId, pageVersion: delta.pageVersion, lastCommandId: delta.commandId,
    latestStatus: delta.status, taskAfter: task.eventSequence, operationAfter: events.nextCursor,
    hasSceneCache: false, previousBaselineId: scene(delta).baselineId, authorizedDraft: draft, url: `${h.fixture.origin}/`,
    expectedSave: { target: { role: 'status', name: 'Save result' }, text: savedText },
    nextStep: 'Refresh status/get and observe without a baseline, submit only this authorized draft once, read back uncertainty without replay.' };
  assert.doesNotMatch(JSON.stringify(receipt), /managerToken|authorization|password|cookie|bearer|"items"|"scene"/iu);
  const receiptFile = path.join(outputDir, 'handoff-receipt.json'); await writeFile(receiptFile, JSON.stringify(receipt, null, 2));
  const received = await receiveHandoff(receiptFile, streams);
  assert.notEqual(stream.child.pid, received.streamPid, 'A and B must use separate CLI processes');
  const actual = await h.state();
  assert.deepEqual(actual, { submissions: 1, wrongActions: 0, note: draft });
  await writeFile(path.join(outputDir, 'handoff-report.json'), JSON.stringify({ version: VERSION, passed: true,
    evidenceScope: 'Actual Manager/Worker/Chrome with independent CLI processes and Agent identity labels; scripted acceptance, NOT two AI models handing off semantic reasoning.',
    sameOperation: operation.id, sameTask: operation.taskId, sameProfile: h.profile.id,
    sender: { agentId: agentA, streamPid: stream.child.pid, eofExitCode: ended.code }, receiver: { agentId: agentB, ...received },
    actual, caveat: 'Unknown was deliberately induced by withholding UI confirmation after one successful POST; explicit readback resolved it. No network disconnect or automatic effect retry.' }, null, 2));
});
