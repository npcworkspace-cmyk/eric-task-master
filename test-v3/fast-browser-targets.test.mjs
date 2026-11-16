import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createFastBrowser } from '../src/runtime/fast-browser.mjs';
import { launchChromeProfile } from '../src/runtime/browser-engine.mjs';
import { FAST_REFERENCE_ENGINE, fastReferenceEngine } from '../src/runtime/fast-reference-selector.mjs';

test('reference engine follows one original node across reorder and rejects detached or replacement nodes', () => {
  const doc = { nodeType: 9, defaultView: {} }, state = { ids: new WeakMap(), references: new Map() };
  const node = { isConnected: true, ownerDocument: doc, ordinal: 1 };
  state.ids.set(node, 'r1'); state.references.set('r1', node); doc.defaultView.session = state;
  const engine = fastReferenceEngine(), binding = JSON.stringify({ key: 'session', ref: 'r1' });
  assert.equal(engine.query(doc, binding), node); assert.deepEqual(engine.queryAll(doc, binding), [node]);
  node.ordinal = 9; assert.equal(engine.query(doc, binding), node);
  node.isConnected = false;
  assert.throws(() => engine.query(doc, binding), /ETM_STALE_REFERENCE/u);
  const replacement = { isConnected: true, ownerDocument: doc, ordinal: 1 };
  state.references.set('r1', replacement);
  assert.throws(() => engine.query(doc, binding), /ETM_STALE_REFERENCE/u, 'copied position or ref text does not confer original node identity');
});

test('native ref selector registration completes once before any Profile context or page is created', async () => {
  const calls = [], playwright = { selectors: { register: async (name, source) => { assert.equal(name, FAST_REFERENCE_ENGINE); assert.equal(typeof source, 'function'); calls.push('register'); } },
    chromium: { launchPersistentContext: async () => { assert.deepEqual(calls, ['register']); calls.push('launch'); return {}; } } };
  await launchChromeProfile(playwright, { userDataDir: 'mock-profile' });
  assert.deepEqual(calls, ['register', 'launch']);
  playwright.chromium.launchPersistentContext = async () => { calls.push('next-launch'); return {}; };
  await launchChromeProfile(playwright, { userDataDir: 'mock-profile-2' });
  assert.deepEqual(calls, ['register', 'launch', 'next-launch']);
});

test('selector registration failure prevents Chrome launch instead of falling back to ordinal CSS', async () => {
  const cause = new Error('selector registration unavailable'); let launched = false;
  const playwright = { selectors: { register: async () => { throw cause; } }, chromium: { launchPersistentContext: async () => { launched = true; } } };
  await assert.rejects(launchChromeProfile(playwright, { userDataDir: 'mock-profile' }), error => error.code === 'CHROME_LAUNCH_FAILED' && error.cause === cause);
  assert.equal(launched, false);
});

async function fixture(t, { signal } = {}) {
  const doc = { nodeType: 9, defaultView: {} }, registry = { ids: new WeakMap(), references: new Map() }, engine = fastReferenceEngine();
  const effects = [], selectors = [], hooks = {};
  const nodes = ['r1', 'r2'].map((ref, index) => ({ ref, name: index ? 'Destination' : 'Note', isConnected: true, ownerDocument: doc,
    tagName: index ? 'DIV' : 'TEXTAREA', isContentEditable: false, value: index ? '' : 'old', visible: true, enabled: true, ordinal: index,
    getAttribute: () => null }));
  for (const node of nodes) { registry.ids.set(node, node.ref); registry.references.set(node.ref, node); }
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'http://fixture.test/editor', mainFrame: () => 'main',
    evaluate: async (_fn, args) => {
      if (typeof args === 'string') return {};
      if (!args?.key) return {};
      doc.defaultView[args.key] = registry;
      const meta = { epoch: 'stable-document', revision: 1, url: page.url(), title: 'Fixture' };
      if (!args.maxItems) return { ...meta, items: [], total: 0, offset: 0 };
      return { ...meta, items: nodes.filter(node => node.isConnected).map(node => ({ ref: node.ref, selector: `#ordinal-${node.ordinal}`, role: node.ref === 'r1' ? 'textbox' : 'button', name: node.name, text: node.value })), total: nodes.length, offset: 0 };
    },
    locator: selector => {
      selectors.push(selector); assert.ok(selector.startsWith(`${FAST_REFERENCE_ENGINE}=`));
      const binding = selector.slice(FAST_REFERENCE_ENGINE.length + 1), resolve = () => engine.query(doc, binding);
      const target = { resolve, count: async () => resolve() ? 1 : 0, isVisible: async () => { await hooks.visible?.(); return resolve().visible; },
        isEnabled: async () => { await hooks.enabled?.(); return resolve().enabled; }, evaluate: async fn => fn(resolve()),
        innerText: async () => resolve().value, inputValue: async () => resolve().value,
        fill: async (value, options) => { assert.notEqual(options.force, true); const node = resolve(); node.value = value; effects.push(['fill', node.ref]); },
        pressSequentially: async value => { const node = resolve(); node.value += value; effects.push(['type', node.ref]); },
        dragTo: async destination => { effects.push(['drag', resolve().ref, destination.resolve().ref]); },
        click: async options => { assert.notEqual(options.force, true); await hooks.native?.(); effects.push(['click', resolve().ref]); } };
      return target;
    } });
  const browser = createFastBrowser({ page, context: { pages: () => [page] }, signal });
  t.after(() => browser.dispose());
  await browser.observe();
  return { browser, page, nodes, effects, selectors, hooks };
}

test('same-node refs survive native fill/type and post-action verification; drag keeps native API parity', async t => {
  const f = await fixture(t);
  f.nodes[0].ordinal = 20;
  await f.browser.act({ type: 'fill', target: { ref: 'r1' }, value: 'verified' });
  assert.equal(await f.browser.condition({ target: { ref: 'r1' }, value: 'verified' }), true);
  await f.browser.act({ type: 'type', target: { ref: 'r1' }, value: ' next' });
  assert.equal(await f.browser.read({ ref: 'r1' }), 'verified next');
  await f.browser.act({ type: 'drag', target: { ref: 'r1' }, to: { ref: 'r2' } });
  assert.deepEqual(f.effects, [['fill', 'r1'], ['type', 'r1'], ['drag', 'r1', 'r2']]);
  assert.ok(f.selectors.every(selector => selector.startsWith(`${FAST_REFERENCE_ENGINE}=`)));
});

test('replacement during native locator action cannot retarget the old ordinal slot', async t => {
  const f = await fixture(t);
  f.hooks.native = () => { f.nodes[0].isConnected = false; };
  await assert.rejects(f.browser.act({ type: 'click', target: { ref: 'r1' } }), { code: 'STALE_OBSERVATION' });
  assert.deepEqual(f.effects, []);
});

test('abort, human/control invalidation and unexpected dialog during preparation prevent the native dispatch', async t => {
  for (const kind of ['abort', 'takeover', 'dialog']) await t.test(kind, async child => {
    const controller = new AbortController(), f = await fixture(child, { signal: controller.signal });
    f.hooks.enabled = () => {
      if (kind === 'abort') controller.abort(Object.assign(new Error('Stopped before dispatch'), { code: 'TASK_STOPPED' }));
      else if (kind === 'takeover') f.browser.invalidate();
      else f.page.emit('dialog', { message: () => 'Unexpected', dismiss: async () => {} });
    };
    await assert.rejects(f.browser.act({ type: 'click', target: { ref: 'r1' } }), { code: kind === 'abort' ? 'TASK_STOPPED' : kind === 'dialog' ? 'UNEXPECTED_DIALOG' : 'STALE_OBSERVATION' });
    assert.deepEqual(f.effects, []);
  });
});

test('interruption while opening a tab closes only the newly created unselected blank page', async t => {
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  const closed = [], existing = Object.assign(new EventEmitter(), { isClosed: () => false, close: async () => { closed.push('existing'); }, evaluate: async () => ({}) });
  const next = { close: async () => { closed.push('new'); } };
  const browser = createFastBrowser({ page: existing, context: { pages: () => [existing], newPage: async () => { entered(); await held; return next; } } });
  t.after(() => browser.dispose());
  const pending = browser.act({ type: 'new-tab', value: 'http://fixture.test/new' });
  await started; browser.invalidate(); release();
  await assert.rejects(pending, { code: 'STALE_OBSERVATION' });
  assert.equal(browser.page, existing); assert.deepEqual(closed, ['new']);
});
