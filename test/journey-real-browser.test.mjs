import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { chromium } from 'playwright';
import { createActionHelper } from '../src/lib/behavior.mjs';
import { createJourneyHelper } from '../src/lib/journey.mjs';

const TEST_TIMING = Object.freeze({
  cautiousBeforeAction: [1, 2],
  cautiousAfterAction: [1, 2],
  beforeAction: [1, 2],
  afterAction: [1, 2],
  hoverPause: [1, 2],
  clickDelay: [1, 2],
  mouseSteps: [14, 16],
  mouseStepPause: [1, 2],
  mouseCorrectionSteps: [4, 5],
  keyDelay: [1, 2],
  selectionKeyPause: [1, 2],
  wordPause: [1, 2],
  punctuationPause: [1, 2],
  scrollPause: [1, 2],
  scrollGesturePause: [1, 2],
  readingBase: [1, 2],
  readingPerWord: [1, 2],
  readingMaximum: 100
});

function htmlPage(pageNumber) {
  if (pageNumber === 2) {
    return '<!doctype html><title>Page two</title><h1>Page two reached</h1><p id="scroll-count"></p>' +
      '<script>document.querySelector("#scroll-count").textContent = sessionStorage.getItem("scroll-count") || "0";</script>';
  }
  const rows = Array.from({ length: 90 }, (_, index) => (
    `<p>Visible catalog row ${index + 1}: enough content to require deliberate viewport traversal.</p>`
  )).join('');
  return `<!doctype html>
    <title>Page one</title>
    <style>body{font:16px sans-serif;max-width:760px;margin:auto}p{min-height:42px}a{display:inline-block;padding:18px}</style>
    <h1>Page one</h1>
    ${rows}
    <a id="next" href="/page-2">Next page</a>
    <script>
      let count = Number(sessionStorage.getItem('scroll-count') || 0);
      addEventListener('scroll', () => sessionStorage.setItem('scroll-count', String(++count)), { passive: true });
    </script>`;
}

test('real Chromium traverses the rendered page before clicking a visible pagination control', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1',
  timeout: 45_000
}, async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(htmlPage(request.url === '/page-2' ? 2 : 1));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    const action = createActionHelper({
      page,
      mode: 'human',
      strictVisibleTraversal: true,
      random: () => 0.5,
      timing: TEST_TIMING
    });
    const journey = createJourneyHelper({
      page,
      action,
      random: () => 0.5
    });
    const address = server.address();
    await journey.open(`http://127.0.0.1:${address.port}/page-1`);
    const next = page.getByRole('link', { name: 'Next page' });
    const initialBox = await next.boundingBox();
    assert.ok(initialBox.y > 620, 'pagination control must begin below the viewport');

    await journey.nextPage(next, {
      timeoutMs: 10_000,
      verify: ({ after }) => after.url.endsWith('/page-2')
    });

    assert.equal(await page.locator('h1').textContent(), 'Page two reached');
    assert.ok(Number(await page.locator('#scroll-count').textContent()) > 0);
    const audit = journey.assertComplete();
    assert.equal(audit.score, 10);
    assert.ok(audit.primitives.targetTraversals > 0);
    assert.ok(audit.primitives.wheelEvents >= audit.primitives.scrollGestures * 3);
    assert.ok(audit.primitives.pointerMoves >= 14);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
