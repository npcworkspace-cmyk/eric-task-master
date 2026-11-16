import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createFastBrowser, compactObservation, observationDelta, boundedInteger, delay } from '../src/runtime/fast-browser.mjs';

test('compact observations preserve envelope, identify omissions and never default to HTML', () => {
  const result = compactObservation({ pageId: 'p', pageVersion: 'v', total: 200, items: Array.from({ length: 200 }, (_, index) => ({ ref: `r${index}`, text: 'text '.repeat(100) })) }, { maxChars: 1000, maxItems: 4 });
  assert.ok(JSON.stringify(result).length <= 1000);
  assert.equal(result.pageId, 'p');
  assert.ok(result.omitted.after > 0);
  assert.ok(result.continuation.offset > 0);
  assert.equal(result.html, undefined);
});

test('budget refuses to truncate necessary safety metadata', () => {
  assert.throws(() => compactObservation({ pageId: 'p'.repeat(800), total: 0, items: [] }, { maxChars: 512 }), { code: 'CONTEXT_INSUFFICIENT' });
});

test('delta reports additions, modifications and removals without asserting truncated data absent', () => {
  const previous = { items: [{ ref: '1', text: 'old' }, { ref: '2', text: 'same' }, { ref: '3', text: 'removed' }] };
  const current = { items: [{ ref: '1', text: 'new' }, { ref: '2', text: 'same' }, { ref: '4', text: 'added' }], omitted: { after: 0 } };
  const delta = observationDelta(previous, current);
  assert.deepEqual(delta.items.map((item) => item.ref), ['1', '4']);
  assert.deepEqual(delta.removed, ['3']);
  assert.equal(delta.unchanged, 1);
});

test('partial observation windows reset the baseline instead of inventing removed targets', () => {
  const full = { items: [{ ref: '1', text: 'first' }, { ref: '2', text: 'second' }], total: 2, offset: 0, omitted: { before: 0, after: 0 } };
  const partial = { items: [{ ref: '1', text: 'first' }], total: 2, offset: 0, omitted: { before: 0, after: 1 }, continuation: { offset: 1 } };
  for (const [previous, current] of [[full, partial], [partial, full], [full, { ...full, omitted: { before: 0, after: 0, textCharacters: 5 } }]]) {
    const result = observationDelta(previous, current);
    assert.equal(result.baselineReset, true); assert.equal(result.delta, undefined); assert.equal(result.removed, undefined);
    assert.deepEqual(result.items, current.items);
  }
});

test('bounded wait is cancelled immediately and numeric bounds reject infinities', async () => {
  const controller = new AbortController();
  const waiting = delay(10000, controller.signal);
  controller.abort(new Error('cancelled'));
  await assert.rejects(waiting, /cancelled/u);
  assert.throws(() => boundedInteger(Infinity, 1, 10, 'n'), { code: 'INVALID_COMMAND' });
});

test('long rules retain exact original length, omitted characters and a resumable text range', () => {
  const value = compactObservation({ total: 1, items: [{ ref: 'rules', selector: '#rules', text: 'a'.repeat(2000), textRange: { start: 0, end: 2000, total: 5000 }, textContinuation: { scope: '#rules', textOffset: 2000, maxItems: 1 } }] }, { maxChars: 4000 });
  assert.equal(value.omitted.after, 0);
  assert.equal(value.omitted.textCharacters, 3000);
  assert.equal(value.items[0].textRange.total, 5000);
  assert.deepEqual(value.items[0].textContinuation, { scope: '#rules', textOffset: 2000, maxItems: 1 });
  const smaller = compactObservation({ total: 1, items: [{ ref: 'rules', selector: '#rules', text: 'a'.repeat(2000), textRange: { start: 0, end: 2000, total: 5000 } }] }, { maxChars: 1200 });
  assert.ok(smaller.items[0].text.length < 2000);
  assert.equal(smaller.items[0].textContinuation.textOffset, smaller.items[0].textRange.end);
  assert.equal(smaller.omitted.textCharacters, 5000 - smaller.items[0].text.length);
});

test('tab switching cannot discard another page native-dialog interruption', async () => {
  const makePage = () => Object.assign(new EventEmitter(), { isClosed: () => false, bringToFront: async () => {}, url: () => 'http://fixture.test/social', evaluate: async () => ({ epoch: 'doc', revision: 1, url: 'http://fixture.test/social', title: 'fixture' }) });
  const first = makePage(), second = makePage();
  const browser = createFastBrowser({ page: first, context: { pages: () => [first, second] } });
  const firstId = (await browser.meta()).pageId;
  first.emit('dialog', { message: () => 'Unexpected', dismiss: async () => {} });
  assert.equal(browser.unsafe, 'UNEXPECTED_DIALOG');
  const secondId = browser.tabs().find((row) => row.pageId !== firstId).pageId;
  await browser.selectTab(secondId); assert.equal(browser.unsafe, null);
  await browser.selectTab(firstId); assert.equal(browser.unsafe, 'UNEXPECTED_DIALOG');
  assert.equal(browser.clearUnsafe('wrong-token'), false);
  assert.equal(browser.unsafe, 'UNEXPECTED_DIALOG');
  await browser.dispose();
});

test('DOM actions use native actionability without a redundant preparatory stable-frame wait', async () => {
  const calls = [];
  let visible = true, enabled = true;
  const target = { count: async () => 1, isVisible: async () => visible, isEnabled: async () => enabled,
    scrollIntoViewIfNeeded: async () => calls.push('scroll'),
    click: async (options) => { assert.notEqual(options.force, true); calls.push('click'); },
    fill: async (value) => calls.push(`fill:${value}`) };
  const page = Object.assign(new EventEmitter(), { isClosed: () => false, locator: () => target, evaluate: async () => ({}) });
  const browser = createFastBrowser({ page, context: { pages: () => [page] } });
  await browser.act({ type: 'click', target: { selector: '#save' } });
  await browser.act({ type: 'fill', target: { selector: '#note' }, value: 'checked' });
  assert.deepEqual(calls, ['click', 'fill:checked']);
  await browser.act({ type: 'scroll', target: { selector: '#save' } });
  assert.deepEqual(calls, ['click', 'fill:checked', 'scroll']);
  visible = false;
  await assert.rejects(browser.act({ type: 'click', target: { selector: '#save' } }), { code: 'TARGET_NOT_ACTIONABLE' });
  visible = true; enabled = false;
  await assert.rejects(browser.act({ type: 'click', target: { selector: '#save' } }), { code: 'TARGET_NOT_ACTIONABLE' });
  assert.equal(calls.filter((value) => value === 'click').length, 1);
  await browser.dispose();
});

test('select-tab activates the uniquely identified native Chrome tab', async () => {
  const activated = [];
  const makePage = (name) => Object.assign(new EventEmitter(), { isClosed: () => false, url: () => `http://fixture.test/${name}`, title: async () => name,
    bringToFront: async () => activated.push(name), evaluate: async () => ({ epoch: name, revision: 1 }) });
  const first = makePage('first'), second = makePage('second');
  const browser = createFastBrowser({ page: first, context: { pages: () => [first, second] } });
  await browser.selectTab({ title: 'second' });
  assert.equal(browser.page, second);
  assert.deepEqual(activated, ['second']);
  await browser.dispose();
});
