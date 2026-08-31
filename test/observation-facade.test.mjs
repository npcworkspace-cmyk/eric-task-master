import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { chromium } from 'playwright';
import {
  createObservationCapability,
  createObservationFacade,
  createObservationLocatorUnwrapper
} from '../src/lib/observation-facade.mjs';

test('Task Pack observation facade permits reads and blocks browser mutations', async () => {
  const violations = [];
  let rawLocatorHandlerInstalled = false;
  const frameLocator = {
    owner() { return locator; },
    locator() { return locator; }
  };
  const locator = {
    async innerText() { return 'readable'; },
    async evaluate(callback) { return callback({ textContent: 'safe', value: 'existing value' }); },
    async click() { throw new Error('raw click should not run'); },
    contentFrame() { return frameLocator; },
    first() { return this; }
  };
  const page = {
    locator() { return locator; },
    frames() { return []; },
    url() { return 'https://example.test'; },
    async goto() { throw new Error('raw goto should not run'); },
    async evaluate(callback, ...args) { return args.length ? callback(...args) : undefined; },
    async addLocatorHandler() { rawLocatorHandlerInstalled = true; },
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
  const capability = createObservationCapability();
  const unwrapLocator = createObservationLocatorUnwrapper(capability);
  const observed = createObservationFacade({
    page,
    context,
    capability,
    onViolation: (event) => violations.push(event)
  });

  const visible = observed.page.locator('body').first();
  assert.equal(await visible.innerText(), 'readable');
  await assert.rejects(visible.evaluate((node) => node.textContent), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  await assert.rejects(observed.page.evaluate(() => document.title), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  assert.equal(unwrapLocator(visible), locator);
  assert.deepEqual(await observed.context.cookies(), []);
  assert.equal(observed.context.pages()[0], observed.page);

  await assert.rejects(observed.page.goto('https://example.test/next'), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  await assert.rejects(observed.page.click('#next'), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(observed.page.$('#next'), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(visible.click(), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(visible.contentFrame().owner().click(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  await assert.rejects(observed.page.addLocatorHandler(visible, () => {}), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  await assert.rejects(observed.context.newPage(), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(observed.context.newCDPSession(page), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  await assert.rejects(
    observed.page.evaluate(() => { document.querySelector('input').value = 'pasted'; }),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(
    observed.page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('eric-task-master:extension-action-request-v2'));
    }),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(
    visible.evaluate((node) => node.click()),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  const evaluationTarget = {
    value: 'existing',
    dispatchEvent() { this.value = 'dispatched'; }
  };
  await assert.rejects(
    observed.page.evaluate((node) => Reflect.get(node, 'value'), evaluationTarget),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(
    observed.page.evaluate((node) => Reflect.set(node, 'value', 'reflected'), evaluationTarget),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(
    observed.page.evaluate(
      (node) => Object.defineProperty(node, 'value', { value: 'defined' }),
      evaluationTarget
    ),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(
    observed.page.evaluate((node) => node['dispatchEvent']({ type: 'change' }), evaluationTarget),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(
    observed.page.evaluate(
      (node) => Reflect.apply(node.dispatchEvent, node, [{ type: 'change' }]),
      evaluationTarget
    ),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  assert.equal(evaluationTarget.value, 'existing');
  assert.equal(rawLocatorHandlerInstalled, false);
  assert.throws(() => observed.page.mouse, { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });
  const surfaces = violations.map((event) => `${event.surface}.${event.operation}`);
  for (const expected of [
    'Page.goto', 'Page.click', 'Page.$', 'Page.evaluate', 'Page.addLocatorHandler',
    'Locator.click', 'Locator.evaluate', 'BrowserContext.newPage',
    'BrowserContext.newCDPSession', 'Page.mouse'
  ]) assert.equal(surfaces.includes(expected), true, expected);
});

test('event observations and wait predicates never expose raw browser handles', async () => {
  let popupClicks = 0;
  let frameFills = 0;
  let chooserWrites = 0;
  let dialogAccepts = 0;
  let downloadWrites = 0;
  const popup = Object.assign(new EventEmitter(), {
    async click() { popupClicks += 1; },
    url() { return 'https://example.test/popup'; },
    frames() { return []; }
  });
  const frame = {
    async fill() { frameFills += 1; },
    childFrames() { return []; },
    page() { return popup; }
  };
  const chooser = {
    async setFiles() { chooserWrites += 1; },
    page() { return popup; }
  };
  const worker = Object.assign(new EventEmitter(), {
    async evaluate(callback, ...args) { return callback(...args); },
    async evaluateHandle() { throw new Error('raw handle should not escape'); },
    url() { return 'https://example.test/worker.js'; }
  });
  const handle = {
    async evaluate(callback, ...args) { return callback({ textContent: 'safe' }, ...args); },
    async evaluateHandle() { throw new Error('raw handle should not escape'); },
    async asElement() { throw new Error('raw element should not escape'); },
    async jsonValue() { return { textContent: 'safe' }; }
  };
  let request;
  let response;
  request = {
    frame() { return frame; },
    method() { return 'GET'; },
    url() { return 'https://example.test/data'; },
    async response() { return response; },
    redirectedFrom() { return null; },
    redirectedTo() { return null; },
    serviceWorker() { return worker; }
  };
  response = {
    frame() { return frame; },
    request() { return request; },
    status() { return 200; },
    url() { return 'https://example.test/data'; }
  };
  const consoleMessage = {
    args() { return [handle]; },
    page() { return popup; },
    text() { return 'loaded'; },
    type() { return 'log'; }
  };
  const dialog = {
    async accept() { dialogAccepts += 1; },
    async dismiss() { dialogAccepts += 1; },
    message() { return 'Continue?'; },
    page() { return popup; },
    type() { return 'confirm'; }
  };
  const download = {
    async cancel() { downloadWrites += 1; },
    async delete() { downloadWrites += 1; },
    async saveAs() { downloadWrites += 1; },
    page() { return popup; },
    suggestedFilename() { return 'report.csv'; },
    url() { return 'https://example.test/report.csv'; }
  };
  const webError = {
    error() { return new Error('page failed'); },
    page() { return popup; }
  };
  const page = Object.assign(new EventEmitter(), {
    frames() { return [frame]; },
    workers() { return [worker]; },
    locator() { return { async innerText() { return 'readable'; } }; },
    async waitForEvent(event, options) {
      const candidate = event === 'popup' ? popup : event === 'framenavigated' ? frame : chooser;
      if (typeof options === 'function') await options(candidate);
      else if (typeof options?.predicate === 'function') await options.predicate(candidate);
      return candidate;
    }
  });
  const context = Object.assign(new EventEmitter(), {
    pages() { return [page]; },
    serviceWorkers() { return [worker]; },
    async waitForEvent(event, options) {
      const candidate = event === 'page' ? popup : worker;
      if (typeof options?.predicate === 'function') await options.predicate(candidate);
      return candidate;
    }
  });
  const observed = createObservationFacade({ page, context });

  let eventPopup;
  let listenerThis;
  observed.page.on('popup', function (candidate) {
    eventPopup = candidate;
    listenerThis = this;
  });
  page.emit('popup', popup);
  assert.equal(listenerThis, observed.page);
  assert.equal(eventPopup.url(), 'https://example.test/popup');
  await assert.rejects(eventPopup.click(), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });

  let removedListenerCalls = 0;
  const removedListener = () => { removedListenerCalls += 1; };
  observed.page.on('popup', removedListener).off('popup', removedListener);
  page.emit('popup', popup);
  assert.equal(removedListenerCalls, 0);

  let predicatePopup;
  const waitedPopup = await observed.page.waitForEvent('popup', {
    predicate(candidate) {
      predicatePopup = candidate;
      return candidate.url().endsWith('/popup');
    }
  });
  assert.equal(predicatePopup, waitedPopup);
  await assert.rejects(waitedPopup.click(), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });

  let observedFrame;
  observed.page.once('framenavigated', (candidate) => { observedFrame = candidate; });
  page.emit('framenavigated', frame);
  await assert.rejects(observedFrame.fill('#field', 'value'), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });

  let observedChooser;
  observed.page.once('filechooser', (candidate) => { observedChooser = candidate; });
  page.emit('filechooser', chooser);
  await assert.rejects(observedChooser.setFiles('secret.txt'), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });

  let observedContextPage;
  observed.context.once('page', (candidate) => { observedContextPage = candidate; });
  context.emit('page', popup);
  await assert.rejects(observedContextPage.click(), { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' });

  let predicateWorker;
  const waitedWorker = await observed.context.waitForEvent('serviceworker', {
    predicate(candidate) {
      predicateWorker = candidate;
      return candidate.url().endsWith('/worker.js');
    }
  });
  assert.equal(predicateWorker, waitedWorker);
  await assert.rejects(
    waitedWorker.evaluate((value) => value, 'readable'),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(
    waitedWorker.evaluate((node) => Reflect.set(node, 'value', 'mutated'), { value: 'safe' }),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(waitedWorker.evaluateHandle(() => ({})), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });

  let observedRequest;
  observed.page.once('request', (candidate) => { observedRequest = candidate; });
  page.emit('request', request);
  assert.equal(observedRequest.method(), 'GET');
  assert.equal(observedRequest.url(), 'https://example.test/data');
  await assert.rejects(observedRequest.frame().fill('#field', 'value'), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });

  const observedResponse = await observedRequest.response();
  assert.equal(observedResponse.status(), 200);
  assert.equal(observedResponse.request(), observedRequest);
  await assert.rejects(observedResponse.frame().fill('#field', 'value'), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });

  let eventResponse;
  observed.page.once('response', (candidate) => { eventResponse = candidate; });
  page.emit('response', response);
  assert.equal(eventResponse.url(), 'https://example.test/data');
  assert.equal(eventResponse.request(), observedRequest);

  let observedConsole;
  observed.page.once('console', (candidate) => { observedConsole = candidate; });
  page.emit('console', consoleMessage);
  assert.equal(observedConsole.text(), 'loaded');
  await assert.rejects(observedConsole.page().click(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  const [observedHandle] = observedConsole.args();
  assert.deepEqual(await observedHandle.jsonValue(), { textContent: 'safe' });
  await assert.rejects(
    observedHandle.evaluate((node) => node.textContent),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(
    observedHandle.evaluate((node) => Reflect.set(node, 'textContent', 'changed')),
    { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' }
  );
  await assert.rejects(observedHandle.asElement(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });

  let observedDialog;
  observed.context.once('dialog', (candidate) => { observedDialog = candidate; });
  context.emit('dialog', dialog);
  assert.equal(observedDialog.message(), 'Continue?');
  await assert.rejects(observedDialog.page().click(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  await assert.rejects(observedDialog.accept(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });

  let observedDownload;
  observed.page.once('download', (candidate) => { observedDownload = candidate; });
  page.emit('download', download);
  assert.equal(observedDownload.suggestedFilename(), 'report.csv');
  await assert.rejects(observedDownload.page().click(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  await observedDownload.saveAs('report.csv');

  let observedWebError;
  observed.context.once('weberror', (candidate) => { observedWebError = candidate; });
  context.emit('weberror', webError);
  assert.equal(observedWebError.error().message, 'page failed');
  await assert.rejects(observedWebError.page().click(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });

  assert.throws(() => observed.page.removeAllListeners('popup'), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  assert.equal(popupClicks, 0);
  assert.equal(frameFills, 0);
  assert.equal(chooserWrites, 0);
  assert.equal(dialogAccepts, 0);
  assert.equal(downloadWrites, 1);
});

test('extension-enabled legacy modules are read-only outside the serialized action facade', async () => {
  const locator = { async click() {} };
  const page = {
    locator() { return locator; },
    async click() {},
    async evaluate() {}
  };
  const context = { pages() { return [page]; }, async newPage() {} };
  const capability = createObservationCapability();
  const unwrapLocator = createObservationLocatorUnwrapper(capability);
  const observed = createObservationFacade({ page, context, requiredFacade: 'action', capability });

  assert.equal(unwrapLocator(observed.page.locator('button')), locator);
  await assert.rejects(observed.page.click('button'), {
    code: 'TASK_UI_ACTION_REQUIRES_ACTION',
    message: /use the action facade/u
  });
  await assert.rejects(observed.context.newPage(), {
    code: 'TASK_UI_ACTION_REQUIRES_ACTION'
  });
});

test('locator unwrapping is scoped to the Worker-owned observation capability', async () => {
  const locator = { async click() {} };
  const page = { locator() { return locator; } };
  const context = { pages() { return [page]; } };
  const workerCapability = createObservationCapability();
  const observed = createObservationFacade({ page, context, capability: workerCapability });
  const observedLocator = observed.page.locator('button');

  const workerUnwrap = createObservationLocatorUnwrapper(workerCapability);
  assert.equal(workerUnwrap(observedLocator), locator);

  // Task code can import the public factory, but its new capability owns a
  // different WeakMap and therefore cannot unwrap the Worker's proxy.
  const taskImportedCapability = createObservationCapability();
  const taskUnwrap = createObservationLocatorUnwrapper(taskImportedCapability);
  assert.equal(taskUnwrap(observedLocator), observedLocator);
  assert.notEqual(taskUnwrap(observedLocator), locator);
  await assert.rejects(taskUnwrap(observedLocator).click(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
  assert.throws(
    () => createObservationLocatorUnwrapper(Object.freeze({})),
    /valid observation capability/u
  );
  assert.throws(
    () => createObservationFacade({ page, context, capability: Object.freeze({}) }),
    /valid observation capability/u
  );
});

test('observation capability ignores Task tampering with WeakMap prototype methods', async () => {
  const locator = { marker: 'raw-locator', async click() {} };
  const page = { locator() { return locator; } };
  const context = { pages() { return [page]; } };
  const originalGet = WeakMap.prototype.get;
  const originalSet = WeakMap.prototype.set;
  const originalHas = WeakMap.prototype.has;
  const captured = [];
  let observedLocator;
  let unwrappedLocator;

  WeakMap.prototype.get = function (key) {
    const value = Reflect.apply(originalGet, this, [key]);
    if (key === locator || value === locator) captured.push({ operation: 'get', key, value });
    return value;
  };
  WeakMap.prototype.set = function (key, value) {
    if (key === locator || value === locator) captured.push({ operation: 'set', key, value });
    return Reflect.apply(originalSet, this, [key, value]);
  };
  WeakMap.prototype.has = function (key) {
    if (key === locator) captured.push({ operation: 'has', key });
    return Reflect.apply(originalHas, this, [key]);
  };

  try {
    const capability = createObservationCapability();
    const observed = createObservationFacade({ page, context, capability });
    observedLocator = observed.page.locator('button');
    unwrappedLocator = createObservationLocatorUnwrapper(capability)(observedLocator);
  } finally {
    WeakMap.prototype.get = originalGet;
    WeakMap.prototype.set = originalSet;
    WeakMap.prototype.has = originalHas;
  }

  assert.deepEqual(captured, []);
  assert.equal(unwrappedLocator, locator);
  assert.notEqual(observedLocator, locator);
  await assert.rejects(observedLocator.click(), {
    code: 'TASK_UI_ACTION_REQUIRES_JOURNEY'
  });
});

test('unknown event rejection ignores Task tampering with WeakSet prototype methods', () => {
  const page = new EventEmitter();
  const context = { pages() { return [page]; } };
  const observed = createObservationFacade({ page, context });
  const rawEvent = Object.create({ privateEvent: true });
  rawEvent.value = 'must-not-escape';
  const originalHas = WeakSet.prototype.has;
  const originalAdd = WeakSet.prototype.add;
  const originalDelete = WeakSet.prototype.delete;
  const captured = [];
  let emittedError;

  const inspect = (candidate, operation) => {
    if (candidate === rawEvent) captured.push(operation);
  };
  WeakSet.prototype.has = function (value) {
    inspect(value, 'has');
    return Reflect.apply(originalHas, this, [value]);
  };
  WeakSet.prototype.add = function (value) {
    inspect(value, 'add');
    return Reflect.apply(originalAdd, this, [value]);
  };
  WeakSet.prototype.delete = function (value) {
    inspect(value, 'delete');
    return Reflect.apply(originalDelete, this, [value]);
  };

  try {
    observed.page.on('private-event', () => {});
    page.emit('private-event', rawEvent);
  } catch (error) {
    emittedError = error;
  } finally {
    WeakSet.prototype.has = originalHas;
    WeakSet.prototype.add = originalAdd;
    WeakSet.prototype.delete = originalDelete;
  }

  assert.deepEqual(captured, []);
  assert.equal(emittedError?.code, 'TASK_UI_ACTION_REQUIRES_JOURNEY');
  assert.equal(emittedError?.surface, 'Event');
  assert.equal(emittedError?.operation, 'private-event');
});

test('real Playwright observation objects fail closed across public, predicate, and meta escapes', async (t) => {
  const server = http.createServer((request, response) => {
    if (request.url === '/ping' || request.url?.startsWith('/ping?')) {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/worker.js') {
      response.setHeader('content-type', 'text/javascript');
      response.end("self.addEventListener('message', () => console.log('worker-observation')); setInterval(() => {}, 1000);");
      return;
    }
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><body><iframe srcdoc="<input id=inside value=before>"></iframe><input id=q value=before></body>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close().catch(() => {}));
  const page = await context.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  const observed = createObservationFacade({ page, context });
  const blocked = { code: 'TASK_UI_ACTION_REQUIRES_JOURNEY' };

  assert.throws(() => observed.page._mainFrame, blocked);
  assert.throws(() => observed.context._pages, blocked);
  assert.throws(() => observed.page.setMaxListeners(20), blocked);
  await assert.rejects(observed.page.$eval('body', (element) => {
    element.dataset.pageEvalEscape = 'mutated';
  }), blocked);
  await assert.rejects(observed.page.mainFrame().$eval('body', (element) => {
    element.dataset.frameEvalEscape = 'mutated';
  }), blocked);
  assert.equal(await page.getAttribute('body', 'data-page-eval-escape'), null);
  assert.equal(await page.getAttribute('body', 'data-frame-eval-escape'), null);

  const observedLocator = observed.page.locator('#q');
  assert.notEqual(observedLocator.page(), page);
  await assert.rejects(observedLocator.page().evaluate(() => {}), blocked);
  await assert.rejects(observedLocator.waitForFunction((element) => {
    element.dataset.waitEscape = 'mutated';
    return true;
  }), blocked);
  const normalized = await observedLocator.normalize();
  await assert.rejects(normalized.fill('mutated'), blocked);
  assert.equal(await page.locator('#q').inputValue(), 'before');

  const observedFrameLocator = observed.page.locator('body').frameLocator('iframe');
  await assert.rejects(observedFrameLocator.locator('#inside').fill('mutated'), blocked);
  assert.equal(await page.frameLocator('iframe').locator('#inside').inputValue(), 'before');

  await page.evaluate(() => localStorage.setItem('observation-read', 'safe'));
  assert.equal(await observed.page.localStorage.getItem('observation-read'), 'safe');
  await assert.rejects(observed.page.localStorage.setItem('observation-write', 'blocked'), blocked);
  assert.equal(await page.evaluate(() => localStorage.getItem('observation-write')), null);
  await assert.rejects(observed.context.setStorageState({ cookies: [], origins: [] }), blocked);
  assert.throws(() => observed.context.credentials, blocked);
  assert.throws(() => observed.page.screencast, blocked);

  await page.evaluate(() => console.log('observation-console'));
  const consoleMessage = (await observed.page.consoleMessages())
    .find((candidate) => candidate.text() === 'observation-console');
  assert.ok(consoleMessage);
  assert.notEqual(consoleMessage.page(), page);
  await assert.rejects(consoleMessage.page().evaluate(() => {}), blocked);
  await assert.rejects(observed.page.clearConsoleMessages(), blocked);
  assert.ok((await page.consoleMessages()).some((candidate) => candidate.text() === 'observation-console'));

  await page.evaluate(() => fetch('/ping?source=requests'));
  await page.waitForTimeout(25);
  const observedRequest = (await observed.page.requests())
    .find((candidate) => candidate.url().endsWith('/ping?source=requests'));
  assert.ok(observedRequest);
  assert.notEqual(observedRequest.frame().page(), page);
  assert.throws(() => observedRequest.setMaxListeners(20), blocked);
  await assert.rejects(observedRequest.frame().page().evaluate(() => {}), blocked);

  let requestPredicateObserved = false;
  const requestPromise = observed.page.waitForRequest(async (candidate) => {
    if (!candidate.url().endsWith('/ping?source=predicate-request')) return false;
    requestPredicateObserved = true;
    assert.notEqual(candidate.frame().page(), page);
    await assert.rejects(candidate.frame().page().evaluate(() => {}), blocked);
    return true;
  });
  await page.evaluate(() => fetch('/ping?source=predicate-request'));
  await requestPromise;
  assert.equal(requestPredicateObserved, true);

  let responsePredicateObserved = false;
  const responsePromise = observed.page.waitForResponse(async (candidate) => {
    if (!candidate.url().endsWith('/ping?source=predicate-response')) return false;
    responsePredicateObserved = true;
    assert.notEqual(candidate.frame().page(), page);
    await assert.rejects(candidate.frame().page().evaluate(() => {}), blocked);
    return true;
  });
  await page.evaluate(() => fetch('/ping?source=predicate-response'));
  await responsePromise;
  assert.equal(responsePredicateObserved, true);

  const rawWorkerPromise = page.waitForEvent('worker');
  await page.evaluate(() => {
    globalThis.observationWorker = new Worker('/worker.js');
  });
  const rawWorker = await rawWorkerPromise;
  const workerMessagePromise = observed.page.waitForEvent('console', {
    predicate: (candidate) => candidate.text() === 'worker-observation' && Boolean(candidate.worker()),
    timeout: 5_000
  });
  await page.evaluate(() => globalThis.observationWorker.postMessage('observe'));
  const workerMessage = await workerMessagePromise;
  assert.ok(workerMessage.worker());
  assert.notEqual(workerMessage.worker(), rawWorker);
  await assert.rejects(workerMessage.worker().evaluate(() => {}), blocked);

  await page.setContent(`<!doctype html><style>
    @keyframes observation-test { from { opacity: .99; } to { opacity: 1; } }
    body { min-height: 6000px; animation: observation-test 30s linear; }
  </style><div id="capture-target" style="margin-top:3500px">target</div>`);
  await page.evaluate(() => {
    document.body.addEventListener('animationend', () => {
      document.body.dataset.observationAnimationEnded = 'yes';
    });
    addEventListener('beforeprint', () => {
      document.body.dataset.observationBeforePrint = 'yes';
    });
    scrollTo(0, 0);
  });
  const scrollBeforeCapture = await page.evaluate(() => scrollY);
  await assert.rejects(observed.page.locator('#capture-target').screenshot(), blocked);
  assert.equal(await page.evaluate(() => scrollY), scrollBeforeCapture);
  await assert.rejects(observed.page.screenshot({ animations: 'disabled' }), blocked);
  await assert.rejects(observed.page.pdf(), blocked);
  assert.equal(await page.getAttribute('body', 'data-observation-animation-ended'), null);
  assert.equal(await page.getAttribute('body', 'data-observation-before-print'), null);

  await assert.rejects(observed.page[Symbol.asyncDispose](), blocked);
  await assert.rejects(observed.context[Symbol.asyncDispose](), blocked);
  assert.equal(page.isClosed(), false);
  assert.equal(context.isClosed(), false);
});
