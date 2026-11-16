import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createFastBrowser } from '../src/runtime/fast-browser.mjs';

function fixture(t, { showCursor = false } = {}) {
  const state = { document: 'approved-document', revision: 1, url: 'http://fixture.test/editor' };
  const native = [], hooks = {};
  const target = { count: async () => 1, isVisible: async () => true, isEnabled: async () => { await hooks.enabled?.(); return true; },
    boundingBox: async () => ({ x: 20, y: 20, width: 40, height: 30 }),
    click: async options => { assert.notEqual(options.force, true); native.push({ type: 'click', options }); } };
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => state.url, mainFrame: () => 'main',
    evaluate: async (_fn, args) => {
      if (typeof args === 'string') return {};
      if (args?.action === 'point') { await hooks.cursor?.(); return { ...args.point, rendered: true }; }
      if (args?.key) {
        await hooks.meta?.();
        return { epoch: state.document, revision: state.revision, url: state.url, title: 'Dispatch fixture', items: [], total: 0, offset: 0 };
      }
      return { width: 800, height: 600 };
    },
    locator: () => target, getByRole: () => target,
    keyboard: { press: async value => native.push({ type: 'key', value }) },
    mouse: { click: async (x, y) => native.push({ type: 'coordinate', x, y }) } });
  const browser = createFastBrowser({ page, context: { pages: () => [page] }, showCursor });
  t.after(() => browser.dispose());
  return { state, native, hooks, page, browser };
}

const actions = [
  { type: 'click', target: { role: 'button', name: 'Save' } },
  { type: 'click', target: { selector: '#save' } },
  { type: 'key', value: 'Enter' },
  { type: 'click', target: { x: 40, y: 35 } }
];

test('approved pre-ACK scene rejects entry on a replacement document, even at the same URL, for every non-ref path', async t => {
  for (const changedOrigin of [false, true]) for (const [index, action] of actions.entries()) {
    await t.test(`${changedOrigin ? 'cross-origin' : 'same-URL'} path ${index}`, async child => {
      const f = fixture(child), expected = await f.browser.meta();
      f.state.document = 'replacement-document';
      if (changedOrigin) f.state.url = 'https://other.test/editor';
      f.page.emit('framenavigated', 'main');
      await assert.rejects(f.browser.act(action, 500, expected), { code: 'STALE_OBSERVATION' });
      assert.deepEqual(f.native, []);
    });
  }
});

test('ordinary DOM revision remains usable but an ownership generation change does not', async t => {
  const f = fixture(t);
  for (const action of actions) {
    const expected = await f.browser.meta();
    f.state.revision += 1;
    await f.browser.act(action, 500, expected);
  }
  assert.equal(f.native.length, actions.length);
  const expected = await f.browser.meta();
  f.browser.invalidate();
  await assert.rejects(f.browser.act(actions[2], 500, expected), { code: 'STALE_OBSERVATION' });
  assert.equal(f.native.length, actions.length);
});

test('method-entry ownership binding survives expected-scene meta and target-preparation await gaps', async t => {
  for (const gap of ['meta', 'enabled']) await t.test(gap, async child => {
    const f = fixture(child), expected = await f.browser.meta();
    f.hooks[gap] = () => { f.hooks[gap] = null; f.browser.invalidate(); };
    await assert.rejects(f.browser.act(actions[0], 500, expected), { code: 'STALE_OBSERVATION' });
    assert.deepEqual(f.native, []);
  });
});

test('native dispatch rechecks monotonic deadline after enabled/cursor waits and keeps a positive remaining cap', async t => {
  const original = globalThis.performance;
  let now = 1000;
  globalThis.performance = { now: () => now };
  t.after(() => { globalThis.performance = original; });
  for (const gap of ['enabled', 'cursor']) await t.test(gap, async child => {
    now = 1000;
    const f = fixture(child, { showCursor: gap === 'cursor' }), expected = { ...await f.browser.meta(), deadlineAt: 1100 };
    f.hooks[gap] = () => { now = 1101; };
    await assert.rejects(f.browser.act(actions[0], 500, expected), { code: 'CONDITION_TIMEOUT' });
    assert.deepEqual(f.native, []);
  });
  now = 1000;
  const f = fixture(t), expected = { ...await f.browser.meta(), deadlineAt: 1100 };
  f.hooks.enabled = () => { now = 1060; };
  await f.browser.act(actions[0], 500, expected);
  assert.equal(f.native[0].options.timeout, 40);
  assert.ok(f.native[0].options.timeout > 0);
  const expired = { ...await f.browser.meta(), deadlineAt: now };
  await assert.rejects(f.browser.act(actions[3], 500, expired), { code: 'CONDITION_TIMEOUT' });
  assert.equal(f.native.length, 1);
});

test('legacy act callers without expectedScene or deadline retain native behavior', async t => {
  const f = fixture(t);
  await f.browser.act(actions[0], 350);
  assert.equal(f.native[0].options.timeout, 350);
  await f.browser.act(actions[2]);
  assert.equal(f.native[1].type, 'key');
});
