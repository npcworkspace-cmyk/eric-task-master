#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from '../src/contracts.mjs';
import { createOperationsHarness, ROOT, pause } from '../test-v3/fixtures/fast-operations/harness.mjs';

const execFile = promisify(execFileCallback);
const outputDir = path.resolve(process.argv[2] || path.join(ROOT, '..', 'outputs', `ops-usability-${Date.now()}`));
await mkdir(outputDir, { recursive: true });
const checks = [], timings = [];
const report = { version: VERSION, startedAt: new Date().toISOString(), checks, timings, realAccountsUsed: false, actualModelCalls: 0, actualTokenUsage: null };
let h, baseline, failure;
let currentHost = 'codex-contract';
let sequence = 0;
const add = (name, evidence = {}) => { checks.push({ name, passed: true, ...evidence }); process.stdout.write(`${JSON.stringify({ check: name, passed: true })}\n`); };
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function startFixture() {
  const state = { submissions: [], cue: false };
  let origin;
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname === '/state') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(state)); return; }
      if (url.pathname === '/control') {
        let source = ''; for await (const chunk of request) source += chunk;
        Object.assign(state, JSON.parse(source)); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(state)); return;
      }
      if (url.pathname === '/submit' && request.method === 'POST') {
        let source = ''; for await (const chunk of request) source += chunk;
        const body = JSON.parse(source); state.submissions.push(body);
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ text: body.text })); return;
      }
      if (url.pathname === '/export') {
        response.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="verified-report.csv"' });
        response.end('status,count\nverified,1\n'); return;
      }
      const beta = url.pathname === '/beta';
      const bench = url.pathname === '/bench';
      const title = beta ? 'Operations Beta' : bench ? 'Operations Benchmark' : 'Operations Alpha';
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><link rel="canonical" href="${origin}${url.pathname}"><style>body{font:16px Arial;padding:24px}#editor{border:1px solid gray;min-height:45px}#source,#destination{padding:10px;border:1px solid #777;margin:8px}#coordinate{position:fixed;right:20px;top:20px;width:120px;height:40px}</style></head><body><h1>${title}</h1><span id="account">test-account</span><div id="editor" contenteditable="true"></div><input id="plain-input"><select id="choice"><option value="one">One</option><option value="two">Two</option></select><button id="submit">Submit local test</button><button id="reject" onclick="document.getElementById('rejection').textContent='Rejected before request'">Reject before sending</button><p id="rejection">Not attempted</p><p id="receipt"></p><button id="hover">Hover</button><p id="hovered"></p><a id="download" href="/export" download>Download report</a><input id="upload" type="file" hidden><p id="uploaded"></p><div id="source" draggable="true">Drag source</div><div id="destination">Drop target</div><p id="dropped"></p><p id="noise">0</p><p id="signal">wait</p><button id="coordinate" onclick="document.getElementById('coordinate-result').textContent='clicked'">Coordinate</button><p id="coordinate-result"></p><script>document.getElementById('submit').onclick=async()=>{const text=document.getElementById('editor').innerText;const r=await fetch('/submit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});document.getElementById('receipt').textContent=(await r.json()).text};document.getElementById('hover').onmouseover=()=>document.getElementById('hovered').textContent='hovered';document.getElementById('upload').onchange=(e)=>document.getElementById('uploaded').textContent=e.target.files[0].name;document.getElementById('source').ondragstart=(e)=>e.dataTransfer.setData('text/plain','source');document.getElementById('destination').ondragover=(e)=>e.preventDefault();document.getElementById('destination').ondrop=(e)=>{e.preventDefault();document.getElementById('dropped').textContent=e.dataTransfer.getData('text/plain')};${bench ? '' : `let n=0;setInterval(()=>document.getElementById('noise').textContent=String(++n),40);setInterval(()=>fetch('/state').then(r=>r.json()).then(s=>{const next=s.cue?'go':'wait';if(document.getElementById('signal').textContent!==next)document.getElementById('signal').textContent=next}),100);`}</script></body></html>`;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html);
    } catch (error) { response.writeHead(500); response.end(error.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, state, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

try {
  h = await createOperationsHarness({ outputDir: path.join(outputDir, 'current'), label: 'simple-ops-acceptance', startFixture,
    executeFile: (executable, args, options) => execFile(executable, args, { ...options, env: { ...options.env, ERIC_TASK_MASTER_AGENT_ID: currentHost, ERIC_TASK_MASTER_AGENT_SKILL_VERSION: VERSION, ERIC_TASK_MASTER_SKILL_DIR: path.join(ROOT, 'skills/eric-task-master') } })
  });
  const started = performance.now();
  const operation = await h.cli(['ops', 'start', '--goal', 'Local acceptance: one Profile, multiple tabs, complete files and retained scene']);
  assert.ok(operation.id); assert.equal(operation.authorization.scope, 'profile'); assert.equal(operation.browserSelection.profileId, h.profile.id);
  const send = async (body, { file = false } = {}) => {
    let input = JSON.stringify(body);
    if (file) { const name = path.join(outputDir, `输入 ${++sequence}.json`); await writeFile(name, input, 'utf8'); input = `@${name}`; }
    const result = await h.cli(['ops', 'command', operation.id, '--input', input]);
    assert.equal(result.status, 'confirmed', JSON.stringify(result)); return result;
  };
  const alpha = `${h.fixture.origin}/alpha`;
  let reply = await send({ kind: 'batch', payload: { actions: [{ type: 'navigate', value: alpha }], verify: [{ url: alpha }] } });
  report.startToFirstObservationMs = performance.now() - started;
  report.operationId = operation.id; report.taskId = operation.taskId; report.profileId = h.profile.id;
  add('default Profile startup without website authorization boilerplate', { elapsedMs: report.startToFirstObservationMs });
  assert.ok(reply.result.observation.items.some((item) => item.domId === 'editor'));
  const editorRef = reply.result.observation.items.find((item) => item.domId === 'editor').ref;
  await pause(180); // Real DOM noise, not a mocked page-version assertion.
  const text = '跨 Agent 富文本测试';
  reply = await send({ kind: 'batch', payload: { actions: [{ type: 'fill', target: { ref: editorRef }, value: text, effect: false, expected: { target: { selector: '#editor' }, value: text } }, { type: 'key', value: 'End', effect: false }, { type: 'type', value: '!', effect: false }], verify: [{ target: { selector: '#editor' }, text: `${text}!` }] } }, { file: true });
  assert.ok(reply.result.observation); add('contenteditable fill/value readback, global keys and typing survive live DOM noise');
  const targetText = `${text}!`;
  await send({ kind: 'batch', payload: { actions: [{ type: 'click', target: { selector: '#submit' }, expected: { target: { selector: '#receipt' }, text: targetText } }], verify: [{ target: { selector: '#receipt' }, text: targetText }] } });
  assert.deepEqual(h.fixture.state.submissions, [{ text: targetText }]); add('one local submission with independent server-side effect count and positive readback');
  const rejected = await h.cli(['ops', 'command', operation.id, '--input', JSON.stringify({ kind: 'batch', payload: { timeoutMs: 1500, actions: [{ type: 'click', target: { selector: '#reject' }, expected: { target: { selector: '#rejection' }, text: 'Submitted' } }] } })]);
  assert.equal(rejected.status, 'unknown'); assert.equal(rejected.result.details.cause, 'CONDITION_TIMEOUT'); assert.equal(rejected.unresolvedActions.length, 1);
  const readback = await send({ kind: 'reconcile', payload: { actionIds: [rejected.unresolvedActions[0].actionId], outcome: 'not-applied', reason: 'This application rejected the request before dispatch; actual rejected status and independent server audit establish no submission occurred', verify: [{ target: { selector: '#rejection' }, text: 'Rejected before request' }] } });
  assert.equal(readback.result.outcome, 'not-applied'); assert.equal(h.fixture.state.submissions.length, 1);
  const resolved = await h.cli(['ops', 'get', operation.id]);
  assert.equal(resolved.actions.find((action) => action.actionId === rejected.unresolvedActions[0].actionId).status, 'failed');
  add('definite non-application is read back and audited as failed without replay; the same task continues');

  for (const host of ['codex-contract', 'dsh-contract', 'generic-cli-contract']) {
    currentHost = host;
    await send({ kind: 'batch', payload: { actions: [{ type: 'fill', effect: false, target: { selector: '#plain-input' }, value: `same-contract-${host}`, expected: { target: { selector: '#plain-input' }, value: `same-contract-${host}` } }] } }, { file: true });
  }
  add('three independent Agent caller identities share the same UTF-8 file/CLI contract', { actualModelHostsInvoked: false });

  reply = await send({ kind: 'batch', payload: { actions: [{ type: 'new-tab', value: `${h.fixture.origin}/beta` }] } });
  const betaId = reply.pageId;
  const tabs = await send({ kind: 'tabs' });
  assert.equal(tabs.result.length, 2); assert.ok(tabs.result.every((tab) => tab.title && tab.url));
  const alphaId = tabs.result.find((tab) => tab.title === 'Operations Alpha').pageId;
  const parallel = await send({ kind: 'observe', payload: { pageIds: [alphaId, betaId], maxChars: 4000 } });
  assert.equal(parallel.result.length, 2); assert.equal(parallel.pageId, betaId); assert.ok(parallel.result.every((page) => page.referenceMode === 'selectors-with-pageId'));
  await send({ kind: 'select-tab', payload: { titleIncludes: 'Alpha' } });
  await send({ kind: 'batch', payload: { actions: [{ pageId: alphaId, type: 'fill', effect: false, target: { selector: '#plain-input' }, value: 'alpha draft' }, { pageId: betaId, type: 'fill', effect: false, target: { selector: '#plain-input' }, value: 'beta draft' }], verify: [{ target: { selector: '#plain-input' }, value: 'beta draft' }] } });
  add('tab titles/URLs, unique automatic selection, parallel reads and cross-tab actions reuse one Profile/task');

  await send({ kind: 'batch', payload: { actions: [{ type: 'hover', target: { selector: '#hover' }, expected: { target: { selector: '#hovered' }, text: 'hovered' } }, { type: 'select', target: { selector: '#choice' }, value: 'two', effect: false, expected: { target: { selector: '#choice' }, value: 'two' } }, { type: 'drag', target: { selector: '#source' }, to: { selector: '#destination' }, effect: false, expected: { target: { selector: '#dropped' }, text: 'source' } }] } });
  add('hover, select and drag use native browser actions with readback');
  const uploadPath = path.join(outputDir, 'authorized-upload.txt'); await writeFile(uploadPath, 'Local authorized fixture only.');
  await send({ kind: 'batch', payload: { actions: [{ type: 'upload', target: { selector: '#upload' }, value: uploadPath, effect: false, expected: { target: { selector: '#uploaded' }, text: 'authorized-upload.txt' } }] } });
  const download = await send({ kind: 'batch', payload: { actions: [{ type: 'download', target: { selector: '#download' } }] } });
  const evidenceRef = download.result.actions[0].result.evidenceRef;
  const file = await h.cli(['files', operation.taskId, '--read', evidenceRef]);
  assert.equal(Buffer.from(file.artifact.data, 'base64').toString('utf8'), 'status,count\nverified,1\n');
  add('hidden file upload and complete download artifact are verified by bytes', { evidenceRef });
  const screenshot = await send({ kind: 'screenshot' });
  const shot = await h.cli(['files', operation.taskId, '--read', screenshot.evidenceRef]);
  const png = Buffer.from(shot.artifact.data, 'base64'); assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const width = png.readUInt32BE(16);
  await send({ kind: 'batch', payload: { actions: [{ type: 'click', target: { x: width - 70, y: 40 }, expected: { target: { selector: '#coordinate-result' }, text: 'clicked' } }] } });
  add('viewport screenshot defaults and bounded coordinate interaction produce real evidence');

  await send({ kind: 'batch', payload: { actions: [{ type: 'navigate', value: `${h.fixture.origin}/bench` }] } });
  const warm = [];
  for (let index = 0; index < 5; index++) {
    const value = `warm-${index}`;
    const before = h.calls.length, tick = performance.now();
    await send({ kind: 'batch', payload: { actions: [{ type: 'fill', effect: false, target: { selector: '#plain-input' }, value, expected: { target: { selector: '#plain-input' }, value } }], verify: [{ target: { selector: '#plain-input' }, value }] } });
    warm.push(performance.now() - tick); timings.push({ version: VERSION, sample: index, cliCalls: h.calls.length - before, elapsedMs: warm.at(-1) });
  }
  report.warmMedianMs = median(warm); add('warm action, verification and next observation use one CLI round trip', { medianMs: report.warmMedianMs });

  await send({ kind: 'batch', payload: { actions: [{ type: 'navigate', value: `${h.fixture.origin}/alpha` }] } });
  await send({ kind: 'wait', payload: { watch: true, once: true, watchId: 'wake-only-on-change', pollMs: 100, condition: { target: { selector: '#signal' }, text: 'go' }, summary: 'Local fixture changed' } });
  const eventCursor = (await h.cli(['ops', 'events', operation.id])).nextCursor;
  const listening = h.cli(['ops', 'listen', operation.id, '--after', String(eventCursor), '--timeout', '5000']);
  await pause(350);
  const injectedAt = performance.now(); await h.control({ cue: true });
  const delivered = await listening;
  assert.ok(delivered.events.some((event) => event.type === 'watch.changed'));
  const current = await h.cli(['ops', 'get', operation.id]);
  assert.equal(current.counters.hostCalls, 0); assert.equal(current.task.state, 'waiting');
  const profiles = await h.cli(['profiles', 'list']); assert.equal(profiles.profiles.length, 1);
  add('local listener returns on actual change without model calls; unfinished task and tabs remain alive', { detectionAndDeliveryMs: performance.now() - injectedAt, managerHostCalls: current.counters.hostCalls, taskState: current.task.state });
  if (process.platform === 'win32' && Number.isSafeInteger(h.manager.pid)) {
    const script = `$rows=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name);$owned=[Collections.Generic.HashSet[int]]::new();[void]$owned.Add(${h.manager.pid});do{$added=0;foreach($row in $rows){if($owned.Contains([int]$row.ParentProcessId) -and $owned.Add([int]$row.ProcessId)){$added++}}}while($added -gt 0);$components=@(Get-Process -Id @($owned) -ErrorAction SilentlyContinue | ForEach-Object {[ordered]@{pid=$_.Id;name=$_.ProcessName;workingSetBytes=$_.WorkingSet64}});[ordered]@{components=$components;workingSetBytes=($components|Measure-Object -Property workingSetBytes -Sum).Sum}|ConvertTo-Json -Depth 4 -Compress`;
    const sampled = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 });
    report.resources = { ...JSON.parse(sampled.stdout.trim()), workload: 'One owned Profile, two tabs with 40ms DOM noise and local watcher', comparison: 'This is a point-in-time Windows working-set sample, not an idle or cross-version benchmark' };
  }

  if (process.env.TASKMASTER_BASELINE_CLI) {
    const baselineCli = path.resolve(process.env.TASKMASTER_BASELINE_CLI);
    baseline = await createOperationsHarness({ outputDir: path.join(outputDir, 'baseline'), label: 'prior-runtime-baseline', startFixture,
      executeFile: (executable, args, options) => execFile(executable, [baselineCli, ...args.slice(1)], { ...options, env: { ...options.env, ERIC_TASK_MASTER_AGENT_ID: 'baseline-contract', ERIC_TASK_MASTER_AGENT_SKILL_VERSION: '4.0.2', ERIC_TASK_MASTER_SKILL_DIR: path.resolve(path.dirname(baselineCli), '../skills/eric-task-master') } })
    });
    const resource = `${baseline.fixture.origin}/bench`;
    const old = await baseline.start('site', { authorization: { accountId: 'test-account', resourceIds: [resource], origins: [baseline.fixture.origin], allowedActions: ['navigate', 'fill'], expiresAt: new Date(Date.now() + 600000).toISOString() }, identity: { account: { selector: '#account' }, resource: { selector: 'link[rel="canonical"]', attribute: 'href' } } });
    assert.equal((await baseline.navigate(old.id, resource)).status, 'confirmed');
    const samples = [];
    for (let index = 0; index < 5; index++) {
      const value = `warm-${index}`, before = baseline.calls.length, tick = performance.now();
      const observation = await baseline.observe(old.id);
      const result = await baseline.command(old.id, 'batch', { preconditions: [{ url: resource }], stopConditions: [], actions: [{ actionId: `baseline-fill-${index}`, type: 'fill', effect: false, target: { selector: '#plain-input' }, value, expected: { target: { selector: '#plain-input' }, value } }], verify: [{ target: { selector: '#plain-input' }, value }] }, { pageId: observation.pageId, pageVersion: observation.pageVersion });
      assert.equal(result.status, 'confirmed'); samples.push(performance.now() - tick);
      timings.push({ version: '4.0.2', sample: index, cliCalls: baseline.calls.length - before, elapsedMs: samples.at(-1) });
    }
    report.baselineMedianMs = median(samples); report.warmReductionPercent = 100 * (1 - report.warmMedianMs / report.baselineMedianMs);
    add('same local fill and positive readback measured against installed 4.0.2', { previousMedianMs: report.baselineMedianMs, currentMedianMs: report.warmMedianMs, reductionPercent: report.warmReductionPercent, comparisonIsNotChatGPTBenchmark: true });
  }
} catch (error) { failure = error; report.error = { code: error.code, message: error.message, stack: error.stack }; }
finally {
  report.cleanup = { current: h ? await h.finish() : null, baseline: baseline ? await baseline.finish() : null };
  report.ok = !failure && Object.values(report.cleanup).every((value) => !value || value.ok);
  report.finishedAt = new Date().toISOString(); await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify({ ok: report.ok, checks: checks.length, outputDir, error: report.error, cleanup: report.cleanup })}\n`);
  if (!report.ok) process.exitCode = 1;
}
