import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import { createFastBrowser } from '../src/runtime/fast-browser.mjs';
import { FAST_REFERENCE_ENGINE, fastReferenceEngine } from '../src/runtime/fast-reference-selector.mjs';

test('fresh stable r1 survives the original 53-observation Node-cache threshold with 19 new refs per scene', async t => {
  let observations = 0;
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'http://fixture.test/cache',
    evaluate: async (_fn, args) => {
      if (typeof args === 'string') return {};
      const meta = { epoch: 'one-document', revision: 1, url: page.url(), title: 'Cache fixture' };
      if (!args?.maxItems) return { ...meta, items: [], total: 0, offset: 0 };
      const items = [{ ref: 'r1', selector: '#stable', role: 'button', name: 'Stable header' },
        ...Array.from({ length: 19 }, (_, index) => ({ ref: `r${observations * 19 + index + 2}`, selector: `#new-${index}`, role: 'button', name: `New ${observations}-${index}` }))];
      observations += 1;
      return { ...meta, items, total: items.length, offset: 0 };
    }, locator: () => ({ count: async () => 1, innerText: async () => 'Stable header' }) });
  const browser = createFastBrowser({ page, context: { pages: () => [page] } });
  t.after(() => browser.dispose());
  for (let index = 0; index < 65; index++) {
    const current = await browser.observe();
    assert.equal(current.items[0].ref, 'r1');
    assert.equal(current.omitted.after, 0);
    assert.equal(await browser.read({ ref: 'r1' }), 'Stable header', `fresh ref must remain executable at observation ${index + 1}`);
    assert.ok(browser.metrics().targetReferences <= 1000);
  }
  assert.equal(browser.metrics().targetReferences, 1000);
});

test('actual pageSnapshot registry promotes all current DOM refs before its own 1000-entry eviction', async t => {
  class ElementModel {
    constructor(tagName, text = '') { this.tagName = tagName; this.textContent = text; this.children = []; this.labels = []; this.isConnected = true; }
    closest() { return null; }
    matches() { return false; }
    getClientRects() { return [{}]; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    querySelectorAll() { return this.children; }
    cloneNode() { return { tagName: this.tagName, textContent: this.textContent, querySelectorAll: () => [] }; }
  }
  const html = new ElementModel('HTML'), body = new ElementModel('BODY', 'Stable container'), header = new ElementModel('BUTTON', 'Stable header');
  html.children = [body]; body.parentElement = html; body.children = [header]; header.parentElement = body;
  const window = {}, document = { nodeType: 9, body, documentElement: html, title: 'Page registry fixture', defaultView: window,
    getElementById: () => null, querySelectorAll: () => [body] };
  for (const node of [html, body, header]) node.ownerDocument = document;
  const realm = vm.createContext({ window, document, Element: ElementModel, location: { href: 'http://fixture.test/registry' },
    MutationObserver: class { observe() {} takeRecords() { return []; } disconnect() {} } });
  let key;
  const engine = fastReferenceEngine();
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'http://fixture.test/registry',
    evaluate: async (fn, payload) => { realm.payload = payload; if (payload?.key) key = payload.key; return vm.runInContext(`(${fn.toString()})(payload)`, realm); },
    locator: selector => {
      assert.ok(selector.startsWith(`${FAST_REFERENCE_ENGINE}=`));
      const binding = selector.slice(FAST_REFERENCE_ENGINE.length + 1), resolve = () => engine.query(document, binding);
      return { count: async () => resolve() ? 1 : 0, innerText: async () => resolve().textContent };
    } });
  const browser = createFastBrowser({ page, context: { pages: () => [page] } });
  t.after(() => browser.dispose());
  const first = await browser.observe();
  const headerRef = first.items.find(item => item.name === 'Stable header').ref;
  const state = window[key];
  for (let index = 0; state.references.size < 1000; index++) {
    const old = new ElementModel('BUTTON', `Historical ${index}`), ref = `historical_${index}`;
    old.ownerDocument = document; state.ids.set(old, ref); state.references.set(ref, old);
  }
  body.children = [header, ...Array.from({ length: 19 }, (_, index) => {
    const node = new ElementModel('BUTTON', `New ${index}`); node.parentElement = body; node.ownerDocument = document; return node;
  })];
  const fresh = await browser.observe();
  assert.equal(fresh.items.length, 21);
  assert.equal(state.references.size, 1000);
  assert.equal(state.references.has('historical_0'), false);
  assert.equal(await browser.read({ ref: headerRef }), 'Stable header');
  for (const item of fresh.items) {
    assert.equal(state.references.has(item.ref), true, `actual pageSnapshot must retain fresh ${item.ref}`);
    assert.equal(engine.query(document, JSON.stringify({ key, ref: item.ref })), state.references.get(item.ref));
  }
});
