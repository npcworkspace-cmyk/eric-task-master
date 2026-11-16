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

test('real CLI compact output keeps controls, values, complete expansion and full audit without re-execution', { timeout: 60000 }, async (t) => {
  const directory = path.join(ROOT, 'artifacts', 'output-live', String(Date.now()));
  const rules = '办理规则：' + '每一项都必须核对来源、对象和结果。'.repeat(90);
  const h = await createOperationsHarness({ outputDir: directory, label: 'output-capability',
    executeFile: (node, args, options) => execute(node, args, { ...options, env: { ...options.env,
      ERIC_TASK_MASTER_AGENT_ID: 'output-capability-test', ERIC_TASK_MASTER_AGENT_SKILL_VERSION: VERSION,
      ERIC_TASK_MASTER_SKILL_DIR: path.join(ROOT, 'skills', 'eric-task-master') } }),
    startFixture: async () => {
      const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' });
        response.end('<!doctype html><title>Output capability</title><main><h1>Output capability</h1>'
          + '<label>备注<input id="draft" aria-label="备注" value="原值"></label>'
          + '<label><input id="checked" type="checkbox">已核对</label>'
          + '<label>优先级<select aria-label="优先级"><option value="normal">普通</option><option value="high">高</option></select></label>'
          + '<p role="status" aria-label="读取结果">已加载，尚未提交</p>'
          + '<div data-private><p>PRIVATE_CANARY_7291</p><input value="PRIVATE_VALUE_7291"></div>'
          + '<p id="rules">' + rules + '</p>'
          + '<button onclick="document.querySelector(\'#draft\').outerHTML=\'<input id=draft aria-label=备注 value=替换后>\'">替换控件</button>'
          + '</main>');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
    }
  });
  t.after(async () => { const clean = await h.finish(); assert.equal(clean.ok, true, JSON.stringify(clean)); });
  const op = await h.start('site', { authorization: undefined, identity: null });
  const command = (kind, payload = {}) => h.cli(['ops', 'command', op.id, '--input', JSON.stringify({ kind, payload })]);
  const scene = reply => reply.observation || reply.result?.observation || reply.result;
  const open = await command('batch', { actions: [{ type: 'navigate', effect: false, value: h.fixture.origin }] });
  assert.equal(open.status, 'confirmed'); assert.ok(JSON.stringify(open).length < 4100);
  const serialized = JSON.stringify(open); assert.doesNotMatch(serialized, /PRIVATE_(?:CANARY|VALUE)_7291/);
  assert.ok(scene(open).items.some(item => item.role === 'textbox' && item.name === '备注' && item.value === '原值'));
  assert.ok(scene(open).items.some(item => item.role === 'checkbox' && item.checked === false));
  assert.ok(scene(open).items.some(item => item.role === 'status' && item.name === '读取结果' && item.text === '已加载，尚未提交'));
  assert.equal(scene(open).items.some(item => item.selector), false);
  const full = await h.cli(['ops', 'get', op.id, '--command', open.commandId, '--detail', 'full']);
  assert.ok(scene(full.command.reply).items.some(item => item.selector));
  const firstRules = await command('observe', { scope: '#rules', maxItems: 1, maxTextChars: 173 });
  let item = scene(firstRules).items[0], reconstructed = item.text, chunks = 1;
  while (item.textContinuation) {
    assert.ok(chunks++ < 32, 'continuation must make bounded progress');
    const next = await command('observe', item.textContinuation); item = scene(next).items[0]; reconstructed += item.text;
  }
  assert.equal(reconstructed, rules);
  const before = await command('observe', { scope: '#draft' }); const oldRef = scene(before).items[0].ref;
  const changed = await command('batch', { actions: [{ type: 'fill', effect: false, target: { ref: oldRef }, value: '批准的新值' }],
    verify: [{ target: { selector: '#draft' }, value: '批准的新值' }], observation: { scope: '#draft' } });
  assert.equal(changed.status, 'confirmed'); assert.equal(scene(changed).items[0].value, '批准的新值');
  const replaced = await command('batch', { actions: [{ type: 'click', effect: false, target: { role: 'button', name: '替换控件' } }] });
  assert.equal(replaced.status, 'confirmed');
  const stale = await command('observe', { ref: oldRef, detail: 'full' });
  assert.equal(stale.status, 'stopped'); assert.equal(stale.reason, 'STALE_OBSERVATION');
  const summary = await h.cli(['ops', 'get', op.id, '--detail', 'compact']);
  assert.ok(summary.commands.every(record => !record.reply)); assert.equal(summary.unresolvedActionCount, 0);
  const audit = await h.cli(['ops', 'get', op.id, '--detail', 'full']);
  assert.ok(audit.commands.length > chunks); assert.ok(audit.commands.find(record => record.commandId === open.commandId).reply);
  await writeFile(path.join(directory, 'capabilities.json'), JSON.stringify({ version: VERSION, compactChars: serialized.length, chunks,
    fullSelectorReadback: true, valuesAndState: true, staleRefRejected: true, privacy: true, historicalCommands: audit.commands.length }, null, 2));
});
