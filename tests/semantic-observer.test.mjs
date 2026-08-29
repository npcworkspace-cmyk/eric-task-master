import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { createActionHelper } from '../src/lib/behavior.mjs';
import { createSemanticObserver } from '../src/lib/semantic-observer.mjs';

test('semantic observer creates bounded refs across frames and rejects stale navigation refs', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 30_000
}, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html>
    <title>Semantic fixture</title>
    <h1>Checkout</h1>
    <label>Email <input id="email" placeholder="name@example.com"></label>
    <input id="password" type="password" aria-label="Password" value="must-not-leak">
    <textarea aria-label="Notes">also-must-not-leak</textarea>
    <button id="save" onclick="this.dataset.clicked='yes'">Save</button>
    <a id="orders" href="https://example.com/orders?private=hidden">Orders</a>
    <iframe srcdoc="<button id='accept' onclick=&quot;this.dataset.clicked='yes'&quot;>Accept cookies</button>"></iframe>`);

  const action = createActionHelper({ page, mode: 'fast' });
  const semantic = createSemanticObserver({ page, action });
  const snapshot = await semantic.snapshot({ scope: 'full_page', maxNodes: 20, maxTextChars: 4_000 });
  assert.match(snapshot.id, /^snapshot_[a-f0-9]{32}$/u);
  assert.match(snapshot.content, /Checkout/u);
  assert.equal(snapshot.refs.some((item) => item.name === 'Accept cookies' && item.frame === 1), true);
  assert.equal(JSON.stringify(snapshot).includes('private=hidden'), false);
  assert.equal(JSON.stringify(snapshot).includes('must-not-leak'), false);

  const email = snapshot.refs.find((item) => item.name === 'Email');
  const save = snapshot.refs.find((item) => item.name === 'Save');
  const orders = snapshot.refs.find((item) => item.name === 'Orders');
  const accept = snapshot.refs.find((item) => item.name === 'Accept cookies');
  await semantic.fill(email.ref, 'agent@example.com', { snapshotId: snapshot.id });
  await semantic.click(save.ref, { snapshotId: snapshot.id });
  await semantic.click(accept.ref, { snapshotId: snapshot.id });
  assert.equal(await page.locator('#email').inputValue(), 'agent@example.com');
  assert.equal(await page.locator('#save').getAttribute('data-clicked'), 'yes');
  assert.equal(await page.frames()[1].locator('#accept').getAttribute('data-clicked'), 'yes');
  assert.equal(await semantic.href(orders.ref, { snapshotId: snapshot.id }), 'https://example.com/orders?private=hidden');

  const tightlyBounded = await semantic.snapshot({ scope: 'full_page', maxNodes: 2, maxTextChars: 100 });
  assert.equal(tightlyBounded.refs.length, 2);

  await page.goto('data:text/html,<title>Changed</title>');
  await assert.rejects(
    semantic.click(save.ref, { snapshotId: snapshot.id }),
    { code: 'SEMANTIC_SNAPSHOT_STALE' }
  );
});

test('semantic observer reserves budget for a challenge iframe after a dense main frame', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 30_000
}, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const dense = Array.from({ length: 150 }, (_, index) => `<button>Main ${index}</button><p>${'body '.repeat(80)}</p>`).join('');
  await page.setContent(`<!doctype html><title>Dense fixture</title>${dense}<iframe srcdoc="<button>Press and hold to verify you are human</button>"></iframe>`);
  const semantic = createSemanticObserver({ page, action: createActionHelper({ page, mode: 'fast' }) });
  const snapshot = await semantic.snapshot({ scope: 'full_page', maxNodes: 120, maxTextChars: 30_000 });
  assert.equal(snapshot.framesTotal, 2);
  assert.equal(snapshot.framesInspected, 2);
  assert.equal(snapshot.framesOmitted, 0);
  assert.equal(snapshot.refs.some((item) => item.frame === 1 && /Press and hold/u.test(item.name)), true);
});
