import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { startFixtureServer } from './fixtures/fast-operations/server.mjs';
import { startPopupFixture } from './fixtures/live-chaos/popups.mjs';

const attack = '</script><script>globalThis.injected=true</script>"\'&<>';
const post = (origin, route, body) => fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map((match) => match[1]);

test('single-send boundary page uses fixed code for all modes and rejects unknown query ids', async () => {
  const source = await readFile(new URL('../scripts/acceptance-single-send-boundaries.mjs', import.meta.url), 'utf8');
  let handler;
  const modes = ['normal', 'double', 'late', 'wrong-body', 'wrong-url', 'iframe', 'newtab', 'auth', 'redirect', 'stop-during-auth', 'takeover-during-auth', 'revoke-during-auth', 'hold'];
  const cases = new Map(modes.map((mode) => [`case-${mode}`, { mode }]));
  vm.runInNewContext(source.slice(source.indexOf('const server = http.createServer('), source.indexOf('\nawait new Promise((resolve) => server.listen')), { http: { createServer(callback) { handler = callback; } }, URL, cases });
  const page = async (id) => {
    let status, html;
    await handler({ method: 'GET', url: '/page?id=' + encodeURIComponent(id) }, { writeHead(code) { status = code; }, end(value) { html = value; } });
    return { status, html };
  };
  assert.equal((await page(attack)).status, 400);
  const baseline = (await page('case-normal')).html;
  for (const mode of modes) {
    const { status, html } = await page(`case-${mode}`);
    assert.equal(status, 200); assert.equal(html, baseline);
    const sends = [], elements = new Map(['#save', '#state', '#child'].map((id) => [id, {}]));
    const fetch = async (url, options) => { sends.push({ url, ...options }); return {}; };
    elements.get('#child').contentWindow = { fetch };
    const document = { querySelector: (id) => elements.get(id), body: { append() {} }, createElement() { return { submit() { sends.push({ url: this.action, method: this.method, target: this.target }); } }; } };
    const context = { URL, location: { href: `http://localhost/page?id=case-${mode}` }, window: {}, document, fetch, setTimeout(callback) { callback(); } };
    vm.runInNewContext(scripts(html)[0], context);
    await elements.get('#save').onclick();
    assert.equal(context.window.settled, true);
    assert.equal(sends.length, ['double', 'late'].includes(mode) ? 2 : 1, mode);
    for (const send of sends) assert.equal(send.url, `/api/save?id=case-${mode}`);
    if (mode === 'auth') assert.equal(sends[0].headers.authorization, 'synthetic-not-a-secret');
    if (mode === 'wrong-body') assert.equal(JSON.parse(sends[0].body).value, 'wrong');
    if (mode === 'newtab') assert.equal(sends[0].target, '_blank');
  }
});

test('popup challenge id stays text/data and close action preserves the exact id', async () => {
  const fixture = await startPopupFixture();
  try {
    await fixture.inject({ challengeId: attack, scenarioId: 'new-tab', oracle: { private: true } });
    const href = fixture.origin + '/popup?challengeId=' + encodeURIComponent(attack);
    const html = await fetch(href).then((response) => response.text());
    assert.equal(scripts(html).length, 1);
    assert.ok(!html.includes(attack));
    assert.ok(!html.includes('oracle'));
    const button = {}, status = {}; let closed = false;
    const context = { URL, location: { href }, document: { querySelector: (id) => id === '#close-tab' ? button : status }, fetch: (route, options) => fetch(fixture.origin + route, options), window: { close() { closed = true; } } };
    vm.runInNewContext(scripts(html)[0], context);
    await button.onclick();
    assert.equal(context.injected, undefined);
    assert.equal(closed, true);
    assert.equal(status.textContent, `closed:${attack}`);
    assert.equal(fixture.state.effects[0].challengeId, attack);
    assert.equal(fixture.state.effects[0].action, 'close-tab');
  } finally { await fixture.close(); }
});

test('fast fixture separates executable code, preserves independent effects and pre-header disconnect', async () => {
  const fixture = await startFixtureServer();
  try {
    const script = await fetch(fixture.origin + '/fixture.js').then((response) => response.text());
    await post(fixture.origin, '/control', { followUp: attack, currency: attack, manualBudget: attack, dialog: true, ambiguous: true, longRules: true });
    await post(fixture.origin, '/api/reply', { text: attack });
    await post(fixture.origin, '/api/reply', { text: attack });
    await post(fixture.origin, '/api/config', { value: attack });
    assert.equal(fixture.state.effects.length, 3);
    assert.equal(fixture.state.replies.length, 2);
    for (const kind of ['social', 'ads', 'site']) {
      const html = await fetch(fixture.origin + '/' + kind).then((response) => response.text());
      assert.ok(!html.includes(attack));
      assert.ok(html.includes('&lt;/script&gt;'));
      assert.equal(scripts(html).length, 0);
      assert.equal((html.match(/<script src="\/fixture.js"><\/script>/gu) || []).length, 1);
      assert.ok(html.includes('data-dialog="true" data-ambiguous="true"'));
      if (kind === 'social') assert.ok(html.includes('END-OF-LONG-RULES'));
    }
    assert.equal(await fetch(fixture.origin + '/fixture.js').then((response) => response.text()), script);
    for (const [buttonId, inputId, route] of [['#publish', '#reply', '/api/reply'], ['#save-budget', '#budget', '/api/budget'], ['#save-config', '#config-value', '/api/config']]) {
      const nodes = new Map([buttonId, inputId, '#reply-result', '#current-budget', '#current-value', '#saved', '#permission-error'].map((id) => [id, { value: id === '#budget' ? '123' : attack, hidden: true }]));
      let alerts = 0, clones = 0, requests = 0;
      nodes.get(buttonId).cloneNode = () => ({}); nodes.get(buttonId).after = () => { clones++; };
      const document = { body: { dataset: { dialog: 'true', ambiguous: 'true' } }, querySelector: (id) => nodes.get(id === 'button' ? buttonId : id) };
      const context = { document, alert() { alerts++; }, fetch: async (url, options) => { assert.equal(url, route); requests++; return fetch(fixture.origin + url, options); } };
      vm.runInNewContext(script, context);
      assert.equal(clones, 1);
      await nodes.get(buttonId).onclick(); assert.equal(alerts, 1); assert.equal(requests, 0);
      document.body.dataset.dialog = 'false';
      await nodes.get(buttonId).onclick(); assert.equal(requests, 1);
      assert.equal(context.injected, undefined);
      assert.equal(nodes.get('#permission-error').hidden, true);
      if (buttonId === '#publish') assert.equal(nodes.get('#reply-result').textContent, attack);
      if (buttonId === '#save-budget') assert.equal(nodes.get('#current-budget').textContent, 123);
      if (buttonId === '#save-config') assert.equal(nodes.get('#current-value').textContent, attack);
      if (buttonId === '#save-config') assert.equal(nodes.get('#saved').textContent, 'saved');
    }
    await post(fixture.origin, '/control', { permission: true });
    assert.equal((await post(fixture.origin, '/api/reply', { text: 'blocked' })).status, 403);
    assert.equal(fixture.state.effects.length, 6);
    await post(fixture.origin, '/control', { permission: false, disconnectAfterSubmit: true });
    await assert.rejects(post(fixture.origin, '/api/reply', { text: 'accepted-before-disconnect' }));
    assert.equal(fixture.state.effects.length, 7);
    assert.equal(fixture.state.replies.at(-1).text, 'accepted-before-disconnect');
  } finally { await fixture.close(); }
});
