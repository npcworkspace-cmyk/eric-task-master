import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createFastBrowser, validateFastCondition } from '../src/runtime/fast-browser.mjs';

async function fixture(t) {
  const state = { count: 1, visible: true, enabled: true, text: 'Saved', value: 'approved', attributes: {}, inputReads: 0,
    element: { tagName: 'INPUT', type: 'checkbox', checked: false, indeterminate: false, isContentEditable: false, multiple: false, selectedOptions: [] } };
  state.element.getAttribute = name => state.attributes[name] ?? null;
  const target = { count: async () => state.count, isVisible: async () => state.visible, isEnabled: async () => state.enabled,
    evaluate: async fn => fn(state.element), getAttribute: async name => state.attributes[name] ?? null,
    innerText: async () => state.text, inputValue: async () => { state.inputReads++; return state.value; } };
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'http://fixture.test/result', locator: () => target, evaluate: async () => ({}) });
  const browser = createFastBrowser({ page, context: { pages: () => [page] } });
  t.after(() => browser.dispose());
  return { browser, state, target: { selector: '#target' } };
}

test('condition validator rejects unknown predicates/states/types and contradictory absence before browser work', () => {
  const target = { selector: '#target' };
  for (const value of [null, [], {}, { pass: true }, { target, ready: true }, { target, state: 'checked' }, { target, state: 'ready' },
    { target, checked: 'yes' }, { target, text: {} }, { target, includes: '' }, { target, value: [] }, { target, values: [1] },
    { target, attribute: 'data-state' }, { target, equals: 'saved' }, { target, value: 'a', values: ['a'] },
    { target, state: 'absent', text: 'Saved' }, { target: { selector: '#target', checked: true } }, { target, selector: '#other' },
    { url: 'http://fixture.test/result', text: 'Saved' }, { urlPrefix: '' }]) {
    assert.throws(() => validateFastCondition(value), { code: 'INVALID_CONDITION' }, JSON.stringify(value));
  }
  const valid = { url: 'http://fixture.test/result', target, state: 'actionable', text: 'Saved', attribute: 'data-state', equals: 'saved' };
  assert.equal(validateFastCondition(valid), valid); assert.deepEqual(valid.target, target);
  assert.equal(validateFastCondition({ selector: '#target', state: 'absent' }).state, 'absent');
});

test('composed URL, target state, text, value and attribute predicates are all required, not first-match success', async t => {
  const { browser, state, target } = await fixture(t);
  state.attributes['data-state'] = 'saved';
  const condition = { url: 'http://fixture.test/result', urlPrefix: 'http://fixture.test/', target, state: 'actionable',
    text: 'Saved', includes: 'ave', value: 'approved', attribute: 'data-state', equals: 'saved', checked: false };
  assert.equal(await browser.condition(condition), true);
  state.text = 'Not saved'; assert.equal(await browser.condition(condition), false); state.text = 'Saved';
  state.value = 'wrong'; assert.equal(await browser.condition(condition), false); state.value = 'approved';
  state.attributes['data-state'] = 'wrong'; assert.equal(await browser.condition(condition), false); state.attributes['data-state'] = 'saved';
  state.enabled = false; assert.equal(await browser.condition(condition), false); state.enabled = true;
  state.element.checked = true; assert.equal(await browser.condition(condition), false); state.element.checked = false;
  assert.equal(await browser.condition({ ...condition, urlPrefix: 'http://other.test/' }), false);
  await assert.rejects(browser.condition({ url: 'http://other.test/', target, unexpectedProof: true }), { code: 'INVALID_CONDITION' });
});

test('checkbox and ARIA checked state is actual state, never visibility or an invented unchecked default', async t => {
  const { browser, state, target } = await fixture(t);
  assert.equal(await browser.condition({ target, checked: true }), false);
  assert.equal(await browser.condition({ target, checked: false }), true);
  state.element.indeterminate = true;
  assert.equal(await browser.condition({ target, checked: 'mixed' }), true);
  assert.equal(await browser.condition({ target, checked: false }), false);
  state.element.indeterminate = false; state.element.tagName = 'DIV'; state.attributes.role = 'switch';
  await assert.rejects(browser.condition({ target, checked: false }), { code: 'INVALID_CONDITION' });
  state.attributes['aria-checked'] = 'false'; assert.equal(await browser.condition({ target, checked: false }), true);
  state.attributes['aria-checked'] = 'true'; assert.equal(await browser.condition({ target, checked: true }), true);
  state.attributes['aria-checked'] = 'invalid'; await assert.rejects(browser.condition({ target, checked: false }), { code: 'INVALID_CONDITION' });
  delete state.attributes.role; delete state.attributes['aria-checked'];
  await assert.rejects(browser.condition({ target, checked: false }), { code: 'INVALID_CONDITION' });
});

test('multiple select proof requires the complete selected value multiset; scalar inputValue cannot certify it', async t => {
  const { browser, state, target } = await fixture(t);
  state.element.tagName = 'SELECT'; state.element.multiple = true;
  state.element.selectedOptions = [{ value: 'a' }, { value: 'b' }]; state.value = 'a';
  await assert.rejects(browser.condition({ target, value: 'a' }), { code: 'INVALID_CONDITION' });
  assert.equal(state.inputReads, 0);
  assert.equal(await browser.condition({ target, values: ['b', 'a'] }), true);
  assert.equal(await browser.condition({ target, values: ['a'] }), false);
  assert.equal(await browser.condition({ target, values: ['a', 'a', 'b'] }), false);
  state.element.selectedOptions = []; assert.equal(await browser.condition({ target, values: [] }), true);
  state.element.tagName = 'INPUT'; state.element.multiple = false;
  await assert.rejects(browser.condition({ target, values: [] }), { code: 'INVALID_CONDITION' });
});

test('absence, hidden, attached and default-visible targets preserve exact unique-match semantics', async t => {
  const { browser, state, target } = await fixture(t);
  state.count = 0;
  assert.equal(await browser.condition({ target, state: 'absent' }), true);
  assert.equal(await browser.condition({ target, state: 'hidden' }), false);
  assert.equal(await browser.condition({ target }), false);
  state.count = 1; state.visible = false;
  assert.equal(await browser.condition({ target, state: 'hidden' }), true);
  assert.equal(await browser.condition({ target, state: 'attached' }), true);
  assert.equal(await browser.condition({ target }), false);
  assert.equal(await browser.condition({ target, state: 'absent' }), false);
  state.count = 2;
  await assert.rejects(browser.condition({ target, state: 'visible' }), { code: 'AMBIGUOUS_TARGET' });
});
