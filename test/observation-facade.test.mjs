import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createObservationFacade,
  unwrapObservationLocator
} from '../src/lib/observation-facade.mjs';

test('Task Pack observation facade permits reads and blocks browser mutations', async () => {
  const violations = [];
  const locator = {
    async innerText() { return 'readable'; },
    async click() { throw new Error('raw click should not run'); },
    first() { return this; }
  };
  const page = {
    locator() { return locator; },
    frames() { return []; },
    url() { return 'https://example.test'; },
    async goto() { throw new Error('raw goto should not run'); },
    async click() { throw new Error('raw page click should not run'); },
    async $() { throw new Error('raw ElementHandle should not escape'); },
    mouse: { async wheel() {} }
  };
  const context = {
    pages() { return [page]; },
    async cookies() { return []; },
    async newPage() { throw new Error('raw newPage should not run'); },
    async newCDPSession() { throw new Error('raw CDP session should not run'); }
  };
  const observed = createObservationFacade({
    page,
    context,
    onViolation: (event) => violations.push(event)
  });

  const visible = observed.page.locator('body').first();
  assert.equal(await visible.innerText(), 'readable');
  assert.equal(unwrapObservationLocator(visible), locator);
  assert.deepEqual(await observed.context.cookies(), []);
  assert.equal(observed.context.pages()[0], observed.page);

  await assert.rejects(observed.page.goto('https://example.test/next'), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  await assert.rejects(observed.page.click('#next'), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(observed.page.$('#next'), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(visible.click(), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(observed.context.newPage(), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(observed.context.newCDPSession(page), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  assert.throws(() => observed.page.mouse, { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  assert.deepEqual(violations.map((event) => `${event.surface}.${event.operation}`), [
    'Page.goto',
    'Page.click',
    'Page.$',
    'Locator.click',
    'BrowserContext.newPage',
    'BrowserContext.newCDPSession',
    'Page.mouse'
  ]);
});
