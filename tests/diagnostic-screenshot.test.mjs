import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  captureBoundedDiagnosticImage,
  MAX_AGENT_IMAGE_BYTES
} from '../src/lib/diagnostic-screenshot.mjs';

test('diagnostic image helper accepts an already-bounded complete JPEG', async () => {
  let evaluateCalled = false;
  const page = {
    async screenshot(options) {
      assert.equal(options.type, 'jpeg');
      assert.equal(options.fullPage, false);
      return Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    },
    async evaluate() {
      evaluateCalled = true;
    }
  };
  const image = await captureBoundedDiagnosticImage(page);
  assert.deepEqual([...image], [0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(evaluateCalled, false);
});

test('high-entropy Chromium viewport becomes one complete bounded JPEG', {
  skip: process.env.TASKMASTER_REAL_BROWSER !== '1'
}, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent('<canvas id="noise" width="1280" height="720"></canvas>');
  await page.evaluate(() => {
    const canvas = document.querySelector('#noise');
    const context = canvas.getContext('2d');
    const image = context.createImageData(canvas.width, canvas.height);
    for (let offset = 0; offset < image.data.length; offset += 65_536) {
      crypto.getRandomValues(image.data.subarray(offset, Math.min(image.data.length, offset + 65_536)));
    }
    context.putImageData(image, 0, 0);
  });

  const raw = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
  assert.ok(raw.length > MAX_AGENT_IMAGE_BYTES, 'fixture did not exercise the resize path');
  const bounded = await captureBoundedDiagnosticImage(page);
  assert.ok(bounded.length > 100);
  assert.ok(bounded.length <= MAX_AGENT_IMAGE_BYTES);
  assert.deepEqual([...bounded.subarray(0, 2)], [0xff, 0xd8]);

  await page.setContent(`<img id="result" src="data:image/jpeg;base64,${bounded.toString('base64')}">`);
  const dimensions = await page.locator('#result').evaluate((image) => ({
    width: image.naturalWidth,
    height: image.naturalHeight
  }));
  assert.ok(dimensions.width > 0 && dimensions.height > 0);
});
