import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import * as playwright from 'playwright';
import { createFastBrowser } from '../src/runtime/fast-browser.mjs';
import { launchChromeProfile } from '../src/runtime/browser-engine.mjs';
import { compactOperationsReply } from '../src/lib/operations-reply.mjs';
import { redactSensitiveText } from '../src/lib/redaction.mjs';

test('real DOM compact capture, full refs, exact text continuations and private controls', { timeout: 30000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'etm-observation-detail-'));
  let context;
  t.after(async () => {
    await context?.close();
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('etm-observation-detail-'));
    await rm(resolved, { recursive: true, force: true });
  });
  context = await launchChromeProfile(playwright, { userDataDir: path.join(temporary, 'profile') }, { headless: true });
  const page = context.pages()[0] || await context.newPage();

  await t.test('aggregate body text is suppressed before budget while every control stays visible', async () => {
    await page.setContent('<!doctype html><title>Many controls</title><h1>Many controls</h1>' + Array.from({ length: 18 }, (_, i) => `<button>Action ${i}: ${'description '.repeat(12)}</button>`).join(''));
    const browser = createFastBrowser({ page, context });
    try {
      const compact = await browser.observe({ maxChars: 12000, maxItems: 60 });
      assert.equal(compact.items[0].text, '');
      assert.equal(compact.items.filter(item => item.role === 'button').length, 18);
      assert.equal(compact.omitted.after, 0);
      const body = compact.items[0];
      const full = await browser.observe({ ref: body.ref, detail: 'full', maxTextChars: 8000, maxChars: 16000 });
      assert.ok(full.items[0].text.includes('Action 0:'));
      assert.equal(full.items[0].textMode, 'full');
      const wire = compactOperationsReply({ status: 'confirmed', observation: compact });
      assert.equal(wire.observation.items.filter(item => item.role === 'button').length, 18);
      assert.equal(JSON.stringify(wire).includes('nth-of-type'), false);
    } finally { await browser.dispose(); }
  });

  await t.test('labelled status and alert retain actual DOM state text separately from accessible names', async () => {
    await page.setContent('<!doctype html><title>State text</title><p role="status" aria-label="保存状态">尚未保存；提交次数：0</p>'
      + '<p role="alert" aria-label="校验结果">备注不匹配，请重新核对</p>');
    const browser = createFastBrowser({ page, context });
    try {
      const observed = await browser.observe();
      const status = observed.items.find(item => item.role === 'status');
      assert.equal(status.name, '保存状态');
      assert.equal(status.text, '尚未保存；提交次数：0');
      const wire = compactOperationsReply({ status: 'confirmed', observation: observed });
      assert.equal(wire.observation.items.find(item => item.role === 'status').text, '尚未保存；提交次数：0');
      assert.equal(wire.observation.items.find(item => item.role === 'status').name, '保存状态');
      assert.equal(wire.observation.items.find(item => item.role === 'alert').text, '备注不匹配，请重新核对');
      assert.equal(wire.observation.items.find(item => item.role === 'alert').name, '校验结果');
      const full = await browser.observe({ ref: status.ref, detail: 'full', maxItems: 1 });
      assert.equal(full.items[0].text, '保存状态', 'explicit full keeps the legacy labelled representation');
    } finally { await browser.dispose(); }
  });

  await t.test('nested mixed-text rule chunks reconstruct the same source basis and full remains separate', async () => {
    const first = 'First rule. '.repeat(70), last = ' Last rule.'.repeat(70);
    await page.setContent(`<!doctype html><title>Rules</title><p id="rules">${first}<a href="#details">Represented child link</a>${last}</p>`);
    const browser = createFastBrowser({ page, context });
    try {
      const observed = await browser.observe({ scope: '#rules', maxItems: 3, maxTextChars: 400, maxChars: 4000 });
      let item = observed.items[0], reconstructed = item.text, next = item.textContinuation, chunks = 1;
      const ref = item.ref;
      assert.equal(item.textMode, 'own');
      assert.equal(observed.items[1].name, 'Represented child link');
      while (next) {
        assert.equal(next.textMode, 'own');
        const expanded = await browser.observe({ ...next, maxTextChars: 400, maxChars: 4000 });
        item = expanded.items[0];
        reconstructed += item.text;
        next = item.textContinuation;
        assert.ok(++chunks < 12);
      }
      assert.equal(reconstructed, `${first}${last}`.trim());
      assert.equal(item.textRange.end, item.textRange.total);
      const full = await browser.observe({ ref, detail: 'full', maxItems: 1, maxTextChars: 8000, maxChars: 12000 });
      assert.equal(full.items[0].text, `${first}Represented child link${last}`.trim());
    } finally { await browser.dispose(); }
  });

  await t.test('separate bounded capture budget keeps ten deep-selector controls before compact wire formatting', async () => {
    await page.setContent('<!doctype html><title>Deep selectors</title>' + '<div>'.repeat(32)
      + Array.from({ length: 10 }, (_, i) => `<button>Open record ${i}</button>`).join('') + '</div>'.repeat(32));
    const browser = createFastBrowser({ page, context });
    try {
      const narrow = await browser.observe({ maxChars: 6000 });
      assert.ok(narrow.omitted.after > 0, 'the explicit legacy raw budget is still honored');
      const captured = await browser.observe({ maxChars: 6000, captureMaxChars: 24000 });
      assert.ok(JSON.stringify(captured).length <= 24000);
      assert.equal(captured.items.filter(item => item.role === 'button').length, 10);
      assert.equal(captured.omitted.after, 0);
      const wire = compactOperationsReply({ status: 'confirmed', observation: captured });
      assert.ok(JSON.stringify(wire).length <= 4000);
      assert.equal(wire.observation.items.filter(item => item.role === 'button').length, 10);
      await assert.rejects(browser.observe({ captureMaxChars: 64001 }), { code: 'INVALID_COMMAND' });
    } finally { await browser.dispose(); }
  });

  await t.test('safe current values and semantic states survive while private ancestors never leak', async () => {
    await page.setContent('<!doctype html><title>Private controls</title><label for="note">Note</label><textarea id="note">current public note</textarea>'
      + '<label><input type="checkbox" id="agree">Agreed</label><button aria-expanded="false">Options</button>'
      + '<div contenteditable="true" role="textbox" aria-label="Rich note">Public <span role="emphasis">rich content</span></div>'
      + '<div data-private><div contenteditable="true" role="textbox" aria-label="Private note">private-content-123<span>private-child-456</span></div><input value="private-field-789"></div>'
      + '<input type="password" aria-label="Password" value="password-selected-abc"><input id="apiKey" value="api-key-xyz">');
    const browser = createFastBrowser({ page, context });
    try {
      const full = await browser.observe({ detail: 'full', maxChars: 12000 });
      const serialized = JSON.stringify(full);
      for (const secret of ['private-content-123', 'private-child-456', 'private-field-789', 'password-selected-abc', 'api-key-xyz']) assert.equal(serialized.includes(secret), false, secret);
      assert.equal(full.items.find(item => item.name === 'Note').value, 'current public note');
      assert.equal(full.items.find(item => item.name === 'Rich note').value, 'Public rich content');
      const wire = compactOperationsReply({ observation: full });
      assert.equal(wire.observation.items.find(item => item.role === 'checkbox').checked, false);
      assert.equal(wire.observation.items.find(item => item.name === 'Options').expanded, false);
    } finally { await browser.dispose(); }
  });

  await t.test('all six canonical secret patterns are redacted before tiny text chunks and ranges', async () => {
    const original = 'Intro\nAuthorization: Bearer auth-value-ABC\nCookie: sid=cookie-value-ABC; user=another-value\nCookie:\nservice-api-token=prefix-value-ABC\npassword="named-value-ABC"\nhttps://fixture.test/?access_token=query-value-ABC&x=1\nBearer bearer-value-ABC\nEnd';
    await page.setContent('<!doctype html><title>Secret rules</title><p id="rules"></p>');
    await page.locator('#rules').evaluate((element, text) => { element.textContent = text; }, original);
    const browser = createFastBrowser({ page, context });
    try {
      const expected = redactSensitiveText(original);
      for (const target of [1, 8, 16]) {
        let observed = await browser.observe({ scope: '#rules', fields: ['text'], maxItems: 1, maxTextChars: target, maxChars: 4000 });
        let item = observed.items[0], reconstructed = item.text, steps = 1;
        assert.equal(item.textRange.total, expected.length);
        while (item.textContinuation) {
          const previousEnd = item.textRange.end;
          observed = await browser.observe({ ...item.textContinuation, maxTextChars: target, maxChars: 4000 });
          item = observed.items[0];
          assert.equal(item.textRange.start, previousEnd);
          assert.ok(item.textRange.end > previousEnd);
          reconstructed += item.text;
          assert.ok(++steps < 300);
        }
        assert.equal(reconstructed, expected);
        assert.equal(reconstructed.includes('value-ABC'), false);
      }
    } finally { await browser.dispose(); }
  });

  await t.test('100k safe names and values stay bounded and reconstruct by ref without any input action', async () => {
    const large = 'public note '.repeat(8500);
    const longName = 'Accessible label '.repeat(6000);
    await page.setContent('<!doctype html><title>Large fields</title><textarea id="long" aria-label="Long note"></textarea><input id="named"><input aria-label="API Key" value="labelled-private-value-ABC">');
    await page.locator('#long').evaluate((element, value) => { element.value = value; }, large);
    await page.locator('#named').evaluate((element, name) => { element.setAttribute('aria-label', name); }, longName);
    const browser = createFastBrowser({ page, context });
    try {
      const captured = await browser.observe({ captureMaxChars: 24000 });
      assert.ok(JSON.stringify(captured).length < 24000);
      const valueItem = captured.items.find(item => item.name === 'Long note');
      const nameItem = captured.items.find(item => item.domId === 'named');
      assert.equal(valueItem.value.length, 512);
      assert.equal(valueItem.valueRange.total, large.length);
      assert.equal(nameItem.name.length, 512);
      assert.equal(nameItem.nameExact, false);
      assert.equal(JSON.stringify(captured).includes('labelled-private-value-ABC'), false);
      for (const [field, first, expected] of [['value', valueItem, large], ['name', nameItem, longName]]) {
        let item = first, reconstructed = item[field], steps = 0;
        while (item[`${field}Continuation`]) {
          const continuation = item[`${field}Continuation`];
          const result = await browser.observe({ ...continuation, [`max${field[0].toUpperCase()}${field.slice(1)}Chars`]: 8000, maxChars: 24000 });
          item = result.items[0];
          reconstructed += item[field];
          assert.ok(++steps < 20);
        }
        assert.equal(reconstructed, expected);
      }
      const wire = compactOperationsReply({ status: 'confirmed', observation: captured }, { maxChars: 6000 });
      assert.equal(wire.observation.items.find(item => item.name === 'Long note').valueRange.total, large.length);
      assert.equal(wire.observation.items.find(item => item.nameExact === false).nameContinuation.ref, nameItem.ref);
    } finally { await browser.dispose(); }
  });

  await t.test('generated source cuts never invent a secret boundary and arbitrary unsafe offsets reject', async () => {
    const source = 'AAAAAAmytoken=hello\nMidline XCookie: ordinary text\nEnd';
    await page.setContent('<!doctype html><title>Boundary stability</title><p id="rules"></p>');
    await page.locator('#rules').evaluate((element, text) => { element.textContent = text; }, source);
    const browser = createFastBrowser({ page, context });
    try {
      for (const target of [1, 8, 16]) {
        let observed = await browser.observe({ scope: '#rules', fields: ['text'], maxItems: 1, maxTextChars: target, maxChars: 4000 });
        let item = observed.items[0], reconstructed = item.text, pieces = 0;
        while (item.textContinuation) {
          observed = await browser.observe({ ...item.textContinuation, maxTextChars: target, maxChars: 4000 });
          item = observed.items[0]; reconstructed += item.text;
          assert.ok(++pieces < 100);
        }
        assert.equal(reconstructed, source);
      }
      await assert.rejects(browser.observe({ scope: '#rules', fields: ['text'], textOffset: 8, maxTextChars: 8 }), { code: 'UNSAFE_TEXT_OFFSET' });
    } finally { await browser.dispose(); }
  });

  await t.test('ref expansion rejects replaced elements instead of reading a new object at the old path', async () => {
    await page.setContent('<!doctype html><title>Stale refs</title><p id="target">Original</p>');
    const browser = createFastBrowser({ page, context });
    try {
      const before = await browser.observe();
      const ref = before.items.find(item => item.text === 'Original').ref;
      await page.evaluate(() => { document.querySelector('#target').outerHTML = '<p id="target">Replacement</p>'; });
      await assert.rejects(browser.observe({ ref, detail: 'full' }), { code: 'STALE_OBSERVATION' });
    } finally { await browser.dispose(); }
  });
});

test('optional native stage recorder excludes preflight and secrets and never changes execution', async () => {
  const events = [], order = [];
  let fail = false;
  const nativeError = Object.assign(new Error('native failed'), { code: 'NATIVE_TIMEOUT' });
  const target = { count: async () => { order.push('resolve'); return 1; }, isVisible: async () => true, isEnabled: async () => true,
    fill: async value => { order.push('native'); assert.equal(value, 'private-value'); if (fail) throw nativeError; } };
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, locator: () => target, evaluate: async () => ({}) });
  const browser = createFastBrowser({ page, context: { pages: () => [page] } });
  browser.setStageRecorder(event => { order.push(event.event); events.push(event); });
  await browser.act({ actionId: 'a1', type: 'fill', target: { selector: '#note' }, value: 'private-value' });
  assert.deepEqual(order, ['resolve', 'begin', 'native', 'end']);
  assert.equal(JSON.stringify(events).includes('private-value'), false);
  fail = true;
  await assert.rejects(browser.act({ actionId: 'a2', type: 'fill', target: { selector: '#note' }, value: 'private-value' }), error => error === nativeError);
  assert.equal(events.at(-1).event, 'fail');
  assert.equal(events.at(-1).code, 'NATIVE_TIMEOUT');
  browser.setStageRecorder(() => { throw new Error('diagnostic must not break action'); });
  fail = false;
  await browser.act({ actionId: 'a3', type: 'fill', target: { selector: '#note' }, value: 'private-value' });
  browser.setStageRecorder(null);
  await browser.dispose();
});
