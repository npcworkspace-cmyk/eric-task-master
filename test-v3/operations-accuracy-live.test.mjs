import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { VERSION } from '../src/contracts.mjs';
import { createOperationsHarness, ROOT } from './fixtures/fast-operations/harness.mjs';

const execute = promisify(callback);
test('live CLI accuracy rejects false proof and stale targets, and reconciles one uncertain effect without replay', { timeout: 90000 }, async t => {
  const directory = path.join(ROOT, 'artifacts', 'accuracy-live', String(Date.now()));
  const state = { effects: 0, target: 0, wrong: 0 };
  const checks = [];
  const h = await createOperationsHarness({ outputDir: directory, label: 'accuracy-live',
    executeFile: (node, args, options) => execute(node, args, { ...options, env: { ...options.env,
      ERIC_TASK_MASTER_AGENT_ID: 'accuracy-live-test', ERIC_TASK_MASTER_AGENT_SKILL_VERSION: VERSION,
      ERIC_TASK_MASTER_SKILL_DIR: path.join(ROOT, 'skills', 'eric-task-master') } }),
    startFixture: async () => {
      const server = http.createServer((request, response) => {
        response.setHeader('cache-control', 'no-store');
        if (request.method === 'POST') {
          if (request.url === '/effect') state.effects++;
          else if (request.url === '/target') state.target++;
          else state.wrong++;
          response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(state)); return;
        }
        response.setHeader('content-type', 'text/html;charset=utf-8');
        response.end('<!doctype html><title>Accuracy fixture</title><h1>本机虚构资料</h1>'
          + '<label>备注<textarea id="note">旧值</textarea></label>'
          + '<label><input id="checked" type="checkbox">已核对</label>'
          + '<select id="multi" aria-label="多选项" multiple><option value="a" selected>A</option><option value="b" selected>B</option></select>'
          + '<div id="targets"><button id="target" onclick="fetch(\'/target\',{method:\'POST\'});document.querySelector(\'#local\').textContent=\'目标正确\'">原目标</button>'
          + '<button id="other" onclick="fetch(\'/wrong\',{method:\'POST\'})">其他目标</button></div>'
          + '<button onclick="document.querySelector(\'#targets\').append(document.querySelector(\'#target\'))">重排原节点</button>'
          + '<button onclick="const next=document.createElement(\'button\');next.id=\'target\';next.textContent=\'替换目标\';next.onclick=()=>fetch(\'/wrong\',{method:\'POST\'});document.querySelector(\'#target\').replaceWith(next)">替换原节点</button>'
          + '<button onclick="fetch(\'/wrong\',{method:\'POST\'})">重复名称</button><button onclick="fetch(\'/wrong\',{method:\'POST\'})">重复名称</button>'
          + '<button disabled onclick="fetch(\'/wrong\',{method:\'POST\'})">禁用目标</button>'
          + '<button onclick="fetch(\'/effect\',{method:\'POST\'})">提交一次</button>'
          + `<p id="status" role="status" aria-label="保存状态">${state.effects ? 'Confirmed saved' : 'Pending'}</p>`
          + '<p id="local">未操作</p>');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
    }
  });
  t.after(async () => { const cleanup = await h.finish(); assert.equal(cleanup.ok, true, JSON.stringify(cleanup)); });
  const operation = await h.start('site', { authorization: undefined, identity: null });
  const url = h.fixture.origin + '/';
  const action = (name, extra = {}) => ({ type: 'click', effect: false, target: { role: 'button', name }, ...extra });
  const batch = payload => h.command(operation.id, 'batch', payload);
  const check = (name, evidence) => checks.push({ name, passed: true, ...evidence });
  await h.navigate(operation.id, url);

  const invalid = await batch({ actions: [action('提交一次', { effect: true }),
    { type: 'wait', value: { condition: { target: { selector: '#checked' }, cheked: true } } }] });
  assert.equal(invalid.reason, 'INVALID_CONDITION'); assert.equal(state.effects, 0);
  check('unsupported later predicate rejects before the first effect', { reason: invalid.reason });

  const mismatch = await batch({ preconditions: [{ url, target: { selector: '#status' }, text: 'Confirmed saved' }], actions: [action('提交一次', { effect: true })] });
  assert.equal(mismatch.reason, 'PRECONDITION_FAILED'); assert.equal(state.effects, 0);
  check('matching URL cannot replace actual outcome text proof', { reason: mismatch.reason });

  const unchecked = await batch({ preconditions: [{ target: { selector: '#checked' }, checked: true }], actions: [action('提交一次', { effect: true })] });
  assert.equal(unchecked.reason, 'PRECONDITION_FAILED'); assert.equal(state.effects, 0);
  check('visible unchecked control does not prove checked', { reason: unchecked.reason });

  const before = await h.observe(operation.id, { scope: '#note' });
  const note = before.result.items.find(item => item.role === 'textbox');
  assert.equal(note.name, '备注'); assert.equal(note.value, '旧值');
  check('wrapped native label excludes the textarea value', { name: note.name, value: note.value });
  const filled = await batch({ actions: [{ type: 'fill', effect: false, target: { ref: note.ref }, value: '精确新值',
    expected: { target: { ref: note.ref }, value: '精确新值' } }] });
  assert.equal(filled.status, 'confirmed'); assert.equal(filled.result.actions[0].expectedMatched, true);
  check('same ref remains available for exact post-fill readback', { status: filled.status, expectedMatched: true });

  const targetScene = await h.observe(operation.id, { scope: '#targets' });
  const original = targetScene.result.items.find(item => item.name === '原目标').ref;
  assert.equal((await batch({ actions: [action('重排原节点')] })).status, 'confirmed');
  const reordered = await batch({ actions: [{ type: 'click', effect: false, target: { ref: original },
    expected: { target: { selector: '#local' }, text: '目标正确' } }] });
  assert.equal(reordered.status, 'confirmed'); assert.equal(state.target, 1); assert.equal(state.wrong, 0);
  check('reordering follows the same original node, not its former position', { target: state.target, wrong: state.wrong });
  assert.equal((await batch({ actions: [action('替换原节点')] })).status, 'confirmed');
  const stale = await batch({ actions: [{ type: 'click', effect: false, target: { ref: original } }] });
  assert.equal(stale.reason, 'STALE_OBSERVATION'); assert.equal(state.wrong, 0);
  check('replaced node stops rather than clicking a replacement', { reason: stale.reason, wrong: state.wrong });

  const ambiguous = await batch({ actions: [action('重复名称')] });
  assert.equal(ambiguous.reason, 'AMBIGUOUS_TARGET'); assert.equal(state.wrong, 0);
  check('ambiguous target refuses to choose one', { reason: ambiguous.reason });
  const disabled = await batch({ actions: [action('禁用目标')] });
  assert.equal(disabled.reason, 'TARGET_NOT_ACTIONABLE'); assert.equal(state.wrong, 0);
  check('disabled target refuses dispatch', { reason: disabled.reason });

  const scalar = await batch({ preconditions: [{ target: { selector: '#multi' }, value: 'a' }], actions: [action('提交一次', { effect: true })] });
  assert.equal(scalar.reason, 'INVALID_CONDITION'); assert.equal(state.effects, 0);
  check('first selected value cannot prove a complete multi-selection', { reason: scalar.reason });
  const wrongSet = await batch({ preconditions: [{ target: { selector: '#multi' }, values: ['a'] }], actions: [action('提交一次', { effect: true })] });
  assert.equal(wrongSet.reason, 'PRECONDITION_FAILED'); assert.equal(state.effects, 0);
  check('multi-selection proof checks the whole selected collection', { reason: wrongSet.reason });

  const expected = { url, target: { selector: '#status' }, text: 'Confirmed saved' };
  const uncertain = await batch({ actions: [action('提交一次', { actionId: 'one-external-effect', effect: true, expected })] });
  assert.equal(uncertain.status, 'unknown'); assert.equal(state.effects, 1);
  const blocked = await h.cli(['ops', 'command', operation.id, '--input', JSON.stringify({ commandId: 'new-id-must-not-replay', kind: 'batch',
    payload: { actions: [action('提交一次', { effect: true })] } })], { expectedFailure: true });
  assert.equal(blocked.error.code, 'RECONCILIATION_REQUIRED'); assert.equal(state.effects, 1);
  const reconciled = await h.command(operation.id, 'reconcile', { actionIds: ['one-external-effect'], refresh: true, verify: [expected],
    reason: 'Fresh server-rendered readback confirms the original one submitted result; never resubmitted.' });
  assert.equal(reconciled.status, 'confirmed'); assert.equal(state.effects, 1); assert.equal(state.wrong, 0);
  const audit = await h.cli(['ops', 'get', operation.id]);
  assert.equal(audit.actions.filter(item => item.effect !== false && ['initiated', 'unknown'].includes(item.status)).length, 0);
  assert.equal(audit.actions.find(item => item.actionId === 'one-external-effect').status, 'confirmed');
  check('uncertain outcome blocks a new ID and resolves by fresh readback only', { initiallyUnknown: true, blocked: blocked.error.code,
    reconciled: reconciled.status, effects: state.effects, wrong: state.wrong });
  assert.equal(checks.length, 12);
  await writeFile(path.join(directory, 'accuracy-checks.json'), JSON.stringify({ version: VERSION, checks, actual: state }, null, 2));
});
