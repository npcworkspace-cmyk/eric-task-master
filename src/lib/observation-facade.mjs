export class ObservationMutationError extends Error {
  constructor(surface, operation, requiredFacade = 'journey') {
    super(`${surface}.${String(operation)} is unavailable to Task Packs; use the ${requiredFacade} facade`);
    this.name = 'ObservationMutationError';
    this.code = requiredFacade === 'journey'
      ? 'TASK_UI_ACTION_REQUIRES_JOURNEY'
      : 'TASK_UI_ACTION_REQUIRES_ACTION';
    this.surface = surface;
    this.operation = String(operation);
  }
}

// Task modules share the Worker realm. Capture the WeakMap intrinsics before a
// task can replace WeakMap.prototype methods and observe capability internals.
const weakMapGet = Function.call.bind(WeakMap.prototype.get);
const weakMapSet = Function.call.bind(WeakMap.prototype.set);
const weakMapHas = Function.call.bind(WeakMap.prototype.has);
const weakSetHas = Function.call.bind(WeakSet.prototype.has);
const weakSetAdd = Function.call.bind(WeakSet.prototype.add);
const weakSetDelete = Function.call.bind(WeakSet.prototype.delete);
const CAPABILITY_LOCATORS = new WeakMap();
const BLOCKED_PROPERTY = Symbol('blocked observation property');

export function createObservationCapability() {
  const capability = Object.freeze(Object.create(null));
  weakMapSet(CAPABILITY_LOCATORS, capability, new WeakMap());
  return capability;
}

export function createObservationLocatorUnwrapper(capability) {
  const rawLocators = weakMapGet(CAPABILITY_LOCATORS, capability);
  if (!rawLocators) throw new TypeError('A valid observation capability is required');
  return (locator) => weakMapGet(rawLocators, locator) || locator;
}

const EVENT_LISTENER_ADD = ['addListener', 'on', 'once', 'prependListener', 'prependOnceListener'];
const EVENT_LISTENER_REMOVE = ['off', 'removeListener'];

const PAGE_BLOCKED_METHODS = [
  '$', '$$', '$eval', '$$eval', 'addInitScript', 'addLocatorHandler', 'addScriptTag',
  'addStyleTag', 'bringToFront', 'cancelPickLocator', 'check', 'clearConsoleMessages',
  'clearPageErrors', 'click', 'close', 'dblclick', 'dispatchEvent', 'dragAndDrop',
  'emulateMedia', 'evaluate', 'evaluateHandle', 'exposeBinding', 'exposeFunction',
  'fill', 'focus', 'goBack', 'goForward', 'goto', 'hideHighlight', 'hover', 'pause',
  'pdf', 'pickLocator', 'press', 'reload', 'removeLocatorHandler', 'requestGC', 'route',
  'routeFromHAR', 'routeWebSocket', 'selectOption', 'setChecked', 'setContent',
  'setDefaultNavigationTimeout', 'setDefaultTimeout', 'setExtraHTTPHeaders', 'setInputFiles',
  'setViewportSize', 'screenshot', 'tap', 'type', 'uncheck', 'unroute', 'unrouteAll', 'waitForFunction',
  'waitForSelector'
];
const PAGE_BLOCKED_SYNC_METHODS = ['emit', 'listeners', 'rawListeners', 'removeAllListeners', 'setMaxListeners'];
const PAGE_BLOCKED_PROPERTIES = [
  'clock', 'coverage', 'keyboard', 'mouse', 'request', 'screencast', 'touchscreen'
];

const CONTEXT_BLOCKED_METHODS = [
  'addCookies', 'addInitScript', 'clearCookies', 'clearPermissions', 'close',
  'exposeBinding', 'exposeFunction', 'grantPermissions', 'newCDPSession', 'newPage', 'route',
  'routeFromHAR', 'routeWebSocket', 'setDefaultNavigationTimeout', 'setDefaultTimeout',
  'setExtraHTTPHeaders', 'setGeolocation', 'setHTTPCredentials', 'setOffline', 'setStorageState',
  'unroute', 'unrouteAll'
];
const CONTEXT_BLOCKED_SYNC_METHODS = ['emit', 'listeners', 'rawListeners', 'removeAllListeners', 'setMaxListeners'];
const CONTEXT_BLOCKED_PROPERTIES = ['browser', 'clock', 'credentials', 'debugger', 'request', 'tracing'];

const FRAME_BLOCKED_METHODS = [
  '$', '$$', '$eval', '$$eval', 'addScriptTag', 'addStyleTag', 'check', 'click', 'dblclick',
  'dispatchEvent', 'dragAndDrop', 'evaluate', 'evaluateHandle', 'fill', 'focus',
  'frameElement', 'goto', 'hover', 'press', 'selectOption', 'setChecked', 'setContent',
  'setInputFiles', 'tap', 'type', 'uncheck', 'waitForFunction', 'waitForNavigation',
  'waitForSelector'
];
const FRAME_BLOCKED_SYNC_METHODS = [
  ...EVENT_LISTENER_ADD, ...EVENT_LISTENER_REMOVE, 'emit', 'listeners', 'rawListeners',
  'removeAllListeners', 'setMaxListeners'
];

const LOCATOR_BLOCKED_METHODS = [
  'blur', 'check', 'clear', 'click', 'dblclick', 'dispatchEvent', 'dragTo', 'drop',
  'elementHandle', 'elementHandles', 'evaluate', 'evaluateAll', 'evaluateHandle', 'fill',
  'focus', 'hideHighlight', 'highlight', 'hover', 'press', 'pressSequentially',
  'screenshot', 'scrollIntoViewIfNeeded', 'selectOption', 'selectText', 'setChecked', 'setInputFiles',
  'tap', 'type', 'uncheck', 'waitForFunction'
];

function unwrappedLocatorOptions(options, unwrapLocator) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return options;
  return {
    ...options,
    ...(options.has ? { has: unwrapLocator(options.has) } : {}),
    ...(options.hasNot ? { hasNot: unwrapLocator(options.hasNot) } : {})
  };
}

export function createObservationFacade({
  page,
  context,
  onViolation = () => {},
  requiredFacade = 'journey',
  capability = createObservationCapability()
} = {}) {
  if (!page || !context) throw new TypeError('page and context are required');
  const rawLocators = weakMapGet(CAPABILITY_LOCATORS, capability);
  if (!rawLocators) throw new TypeError('A valid observation capability is required');
  const unwrapLocator = (locator) => weakMapGet(rawLocators, locator) || locator;

  const caches = Object.freeze({
    page: new WeakMap(),
    context: new WeakMap(),
    frame: new WeakMap(),
    locator: new WeakMap(),
    frameLocator: new WeakMap(),
    worker: new WeakMap(),
    request: new WeakMap(),
    response: new WeakMap(),
    handle: new WeakMap(),
    consoleMessage: new WeakMap(),
    dialog: new WeakMap(),
    download: new WeakMap(),
    fileChooser: new WeakMap(),
    video: new WeakMap(),
    webError: new WeakMap(),
    webSocket: new WeakMap(),
    webStorage: new WeakMap()
  });
  const listenerCache = new WeakMap();
  let contextFacade;

  function reject(surface, operation) {
    const error = new ObservationMutationError(surface, operation, requiredFacade);
    try {
      onViolation({ surface, operation: String(operation), code: error.code });
    } catch {}
    throw error;
  }

  function makeFacade(surface, raw, cache, build) {
    if (!raw || typeof raw !== 'object') return raw;
    if (weakMapHas(cache, raw)) return weakMapGet(cache, raw);
    const members = new Map();
    const target = Object.freeze(Object.create(null));
    let facade;
    facade = new Proxy(target, {
      get(_target, property) {
        if (property === 'then') return undefined;
        if (property === Symbol.toStringTag) return surface;
        if (property === Symbol.asyncDispose) {
          return async () => reject(surface, 'Symbol.asyncDispose');
        }
        if (typeof property !== 'string') return undefined;
        if (members.has(property)) {
          const member = members.get(property);
          if (member === BLOCKED_PROPERTY) return reject(surface, property);
          return member;
        }
        return reject(surface, property);
      },
      getPrototypeOf() {
        return null;
      },
      set() {
        return reject(surface, 'set');
      },
      defineProperty() {
        return reject(surface, 'defineProperty');
      },
      deleteProperty() {
        return reject(surface, 'deleteProperty');
      },
      setPrototypeOf() {
        return reject(surface, 'setPrototypeOf');
      }
    });
    weakMapSet(cache, raw, facade);
    build(members, facade, raw);
    return facade;
  }

  function addReadMethods(members, raw, names) {
    for (const name of names) {
      if (typeof raw[name] === 'function') members.set(name, (...args) => raw[name](...args));
    }
  }

  function addBlockedMethods(members, surface, names, { synchronous = false } = {}) {
    for (const name of names) {
      members.set(name, synchronous
        ? () => reject(surface, name)
        : async () => reject(surface, name));
    }
  }

  function eventListener(raw, event, listener, facade) {
    if (typeof listener !== 'function') return listener;
    let byEvent = weakMapGet(listenerCache, raw);
    if (!byEvent) {
      byEvent = new Map();
      weakMapSet(listenerCache, raw, byEvent);
    }
    let byListener = byEvent.get(event);
    if (!byListener) {
      byListener = new WeakMap();
      byEvent.set(event, byListener);
    }
    let wrapped = weakMapGet(byListener, listener);
    if (!wrapped) {
      wrapped = function (...args) {
        return Reflect.apply(listener, facade, args.map((value) => wrapEventValue(event, value)));
      };
      weakMapSet(byListener, listener, wrapped);
    }
    return wrapped;
  }

  function waitForEventArgs(raw, event, args, facade) {
    if (!args.length) return args;
    const next = [...args];
    if (typeof next[0] === 'function') {
      next[0] = eventListener(raw, event, next[0], facade);
    } else if (next[0] && typeof next[0] === 'object' && typeof next[0].predicate === 'function') {
      next[0] = {
        ...next[0],
        predicate: eventListener(raw, event, next[0].predicate, facade)
      };
    }
    return next;
  }

  function addEventMethods(members, raw, facade, { waitForEvent = true } = {}) {
    for (const name of EVENT_LISTENER_ADD) {
      if (typeof raw[name] !== 'function') continue;
      members.set(name, (event, listener) => {
        raw[name](event, eventListener(raw, event, listener, facade));
        return facade;
      });
    }
    for (const name of EVENT_LISTENER_REMOVE) {
      if (typeof raw[name] !== 'function') continue;
      members.set(name, (event, listener) => {
        raw[name](event, eventListener(raw, event, listener, facade));
        return facade;
      });
    }
    if (waitForEvent && typeof raw.waitForEvent === 'function') {
      members.set('waitForEvent', async (event, ...args) => wrapEventValue(
        event,
        await raw.waitForEvent(event, ...waitForEventArgs(raw, event, args, facade))
      ));
    }
  }

  function safePlainValue(surface, operation, value, seen = new WeakSet()) {
    if (value === null || value === undefined || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
      return value;
    }
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Date) return new Date(value.getTime());
    if (value instanceof Error) {
      const copy = new Error(value.message);
      copy.name = value.name;
      if (value.stack) copy.stack = value.stack;
      return copy;
    }
    if (Array.isArray(value)) {
      if (weakSetHas(seen, value)) return reject(surface, operation);
      weakSetAdd(seen, value);
      const result = value.map((item) => safePlainValue(surface, operation, item, seen));
      weakSetDelete(seen, value);
      return result;
    }
    if (typeof value !== 'object') return reject(surface, operation);
    if (weakSetHas(seen, value)) return reject(surface, operation);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return reject(surface, operation);
    weakSetAdd(seen, value);
    const result = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      result[key] = safePlainValue(surface, operation, item, seen);
    }
    weakSetDelete(seen, value);
    return Object.freeze(result);
  }

  function wrapWorker(raw) {
    return makeFacade('Worker', raw, caches.worker, (members, facade, target) => {
      addBlockedMethods(members, 'Worker', ['close', 'evaluate', 'evaluateHandle']);
      addBlockedMethods(members, 'Worker', ['emit', 'listeners', 'rawListeners', 'removeAllListeners', 'setMaxListeners'], {
        synchronous: true
      });
      addReadMethods(members, target, ['url']);
      addEventMethods(members, target, facade);
    });
  }

  function wrapFileChooser(raw) {
    return makeFacade('FileChooser', raw, caches.fileChooser, (members, _facade, target) => {
      addBlockedMethods(members, 'FileChooser', ['element', 'setFiles']);
      addReadMethods(members, target, ['isMultiple']);
      if (typeof target.page === 'function') members.set('page', () => wrapPage(target.page()));
    });
  }

  function wrapRequest(raw) {
    return makeFacade('Request', raw, caches.request, (members, _facade, target) => {
      addBlockedMethods(members, 'Request', ['emit', 'listeners', 'rawListeners', 'removeAllListeners', 'setMaxListeners'], {
        synchronous: true
      });
      addReadMethods(members, target, [
        'allHeaders', 'failure', 'headerValue', 'headers', 'headersArray', 'isNavigationRequest',
        'method', 'postData', 'postDataBuffer', 'postDataJSON', 'resourceType', 'sizes', 'timing', 'url'
      ]);
      if (typeof target.frame === 'function') members.set('frame', () => wrapFrame(target.frame()));
      if (typeof target.response === 'function') {
        members.set('response', async () => wrapResponse(await target.response()));
      }
      if (typeof target.existingResponse === 'function') {
        members.set('existingResponse', () => wrapResponse(target.existingResponse()));
      }
      for (const name of ['redirectedFrom', 'redirectedTo']) {
        if (typeof target[name] === 'function') members.set(name, () => wrapRequest(target[name]()));
      }
      if (typeof target.serviceWorker === 'function') {
        members.set('serviceWorker', () => wrapWorker(target.serviceWorker()));
      }
    });
  }

  function wrapResponse(raw) {
    return makeFacade('Response', raw, caches.response, (members, _facade, target) => {
      addBlockedMethods(members, 'Response', ['emit', 'listeners', 'rawListeners', 'removeAllListeners', 'setMaxListeners'], {
        synchronous: true
      });
      addReadMethods(members, target, [
        'allHeaders', 'body', 'finished', 'fromServiceWorker', 'headerValue', 'headerValues',
        'headers', 'headersArray', 'httpVersion', 'json', 'ok', 'securityDetails', 'serverAddr',
        'status', 'statusText', 'text', 'url'
      ]);
      if (typeof target.frame === 'function') members.set('frame', () => wrapFrame(target.frame()));
      if (typeof target.request === 'function') members.set('request', () => wrapRequest(target.request()));
    });
  }

  function wrapHandle(raw) {
    return makeFacade('JSHandle', raw, caches.handle, (members, _facade, target) => {
      addBlockedMethods(members, 'JSHandle', ['asElement', 'evaluate', 'evaluateHandle']);
      addBlockedMethods(members, 'JSHandle', ['emit', 'listeners', 'rawListeners', 'removeAllListeners', 'setMaxListeners'], {
        synchronous: true
      });
      addReadMethods(members, target, ['dispose', 'jsonValue', 'toString']);
      if (typeof target.getProperty === 'function') {
        members.set('getProperty', async (...args) => wrapHandle(await target.getProperty(...args)));
      }
      if (typeof target.getProperties === 'function') {
        members.set('getProperties', async (...args) => {
          const properties = await target.getProperties(...args);
          return new Map([...properties].map(([key, candidate]) => [key, wrapHandle(candidate)]));
        });
      }
    });
  }

  function wrapConsoleMessage(raw) {
    return makeFacade('ConsoleMessage', raw, caches.consoleMessage, (members, _facade, target) => {
      addReadMethods(members, target, ['location', 'text', 'timestamp', 'type']);
      if (typeof target.args === 'function') members.set('args', () => target.args().map(wrapHandle));
      if (typeof target.page === 'function') members.set('page', () => wrapPage(target.page()));
      if (typeof target.worker === 'function') members.set('worker', () => wrapWorker(target.worker()));
    });
  }

  function wrapDialog(raw) {
    return makeFacade('Dialog', raw, caches.dialog, (members, _facade, target) => {
      addBlockedMethods(members, 'Dialog', ['accept', 'dismiss']);
      addReadMethods(members, target, ['defaultValue', 'message', 'type']);
      if (typeof target.page === 'function') members.set('page', () => wrapPage(target.page()));
    });
  }

  function wrapDownload(raw) {
    return makeFacade('Download', raw, caches.download, (members, _facade, target) => {
      addBlockedMethods(members, 'Download', ['cancel', 'delete']);
      addReadMethods(members, target, [
        'createReadStream', 'failure', 'path', 'saveAs', 'suggestedFilename', 'url'
      ]);
      if (typeof target.page === 'function') members.set('page', () => wrapPage(target.page()));
    });
  }

  function wrapVideo(raw) {
    return makeFacade('Video', raw, caches.video, (members, _facade, target) => {
      addBlockedMethods(members, 'Video', ['delete']);
      addReadMethods(members, target, ['path', 'saveAs']);
    });
  }

  function wrapWebError(raw) {
    return makeFacade('WebError', raw, caches.webError, (members, _facade, target) => {
      addReadMethods(members, target, ['error']);
      if (typeof target.page === 'function') members.set('page', () => wrapPage(target.page()));
    });
  }

  function wrapWebSocket(raw) {
    return makeFacade('WebSocket', raw, caches.webSocket, (members, facade, target) => {
      addBlockedMethods(members, 'WebSocket', ['emit', 'listeners', 'rawListeners', 'removeAllListeners', 'setMaxListeners'], {
        synchronous: true
      });
      addReadMethods(members, target, ['isClosed', 'url']);
      addEventMethods(members, target, facade);
    });
  }

  function wrapWebStorage(raw, surface) {
    return makeFacade(surface, raw, caches.webStorage, (members, _facade, target) => {
      addBlockedMethods(members, surface, ['clear', 'removeItem', 'setItem']);
      addReadMethods(members, target, ['getItem', 'items']);
    });
  }

  function wrapEventValue(event, value) {
    if (!value || typeof value !== 'object') return value;
    if (['page', 'popup', 'backgroundpage'].includes(event)) return wrapPage(value);
    if (['frameattached', 'framedetached', 'framenavigated'].includes(event)) return wrapFrame(value);
    if (event === 'filechooser') return wrapFileChooser(value);
    if (event === 'serviceworker' || event === 'worker') return wrapWorker(value);
    if (['request', 'requestfailed', 'requestfinished'].includes(event)) return wrapRequest(value);
    if (event === 'response') return wrapResponse(value);
    if (event === 'console') return wrapConsoleMessage(value);
    if (event === 'dialog') return wrapDialog(value);
    if (event === 'download') return wrapDownload(value);
    if (event === 'weberror') return wrapWebError(value);
    if (event === 'websocket') return wrapWebSocket(value);
    return safePlainValue('Event', event, value);
  }

  function wrapFrameLocator(raw) {
    return makeFacade('FrameLocator', raw, caches.frameLocator, (members, _facade, target) => {
      for (const name of ['first', 'frameLocator', 'last', 'nth']) {
        if (typeof target[name] === 'function') members.set(name, (...args) => wrapFrameLocator(target[name](...args)));
      }
      if (typeof target.owner === 'function') members.set('owner', (...args) => wrapLocator(target.owner(...args)));
      for (const name of [
        'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId',
        'getByText', 'getByTitle'
      ]) {
        if (typeof target[name] === 'function') members.set(name, (...args) => wrapLocator(target[name](...args)));
      }
      if (typeof target.locator === 'function') {
        members.set('locator', (selector, options) => wrapLocator(
          target.locator(unwrapLocator(selector), unwrappedLocatorOptions(options, unwrapLocator))
        ));
      }
    });
  }

  function wrapLocator(raw) {
    const facade = makeFacade('Locator', raw, caches.locator, (members, _facade, target) => {
      addBlockedMethods(members, 'Locator', LOCATOR_BLOCKED_METHODS);
      addReadMethods(members, target, [
        'allInnerTexts', 'allTextContents', 'ariaSnapshot', 'boundingBox', 'count', 'description',
        'getAttribute', 'innerHTML', 'innerText', 'inputValue', 'isChecked', 'isDisabled',
        'isEditable', 'isEnabled', 'isHidden', 'isVisible', 'textContent',
        'toString', 'waitFor'
      ]);
      for (const name of [
        'describe', 'first', 'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole',
        'getByTestId', 'getByText', 'getByTitle', 'last', 'nth'
      ]) {
        if (typeof target[name] === 'function') members.set(name, (...args) => wrapLocator(target[name](...args)));
      }
      for (const name of ['and', 'or']) {
        if (typeof target[name] === 'function') {
          members.set(name, (candidate) => wrapLocator(target[name](unwrapLocator(candidate))));
        }
      }
      if (typeof target.filter === 'function') {
        members.set('filter', (options) => wrapLocator(target.filter(unwrappedLocatorOptions(options, unwrapLocator))));
      }
      if (typeof target.locator === 'function') {
        members.set('locator', (selector, options) => wrapLocator(
          target.locator(unwrapLocator(selector), unwrappedLocatorOptions(options, unwrapLocator))
        ));
      }
      if (typeof target.frameLocator === 'function') {
        members.set('frameLocator', (...args) => wrapFrameLocator(target.frameLocator(...args)));
      }
      if (typeof target.contentFrame === 'function') {
        members.set('contentFrame', (...args) => wrapFrameLocator(target.contentFrame(...args)));
      }
      if (typeof target.all === 'function') members.set('all', async (...args) => (await target.all(...args)).map(wrapLocator));
      if (typeof target.normalize === 'function') {
        members.set('normalize', async (...args) => wrapLocator(await target.normalize(...args)));
      }
      if (typeof target.page === 'function') members.set('page', () => wrapPage(target.page()));
    });
    if (facade && typeof facade === 'object') weakMapSet(rawLocators, facade, raw);
    return facade;
  }

  function wrapFrame(raw) {
    return makeFacade('Frame', raw, caches.frame, (members, _facade, target) => {
      addBlockedMethods(members, 'Frame', FRAME_BLOCKED_METHODS);
      addBlockedMethods(members, 'Frame', FRAME_BLOCKED_SYNC_METHODS, { synchronous: true });
      addReadMethods(members, target, [
        'content', 'getAttribute', 'innerHTML', 'innerText', 'inputValue', 'isChecked',
        'isDetached', 'isDisabled', 'isEditable', 'isEnabled', 'isHidden', 'isVisible',
        'name', 'textContent', 'title', 'url', 'waitForLoadState', 'waitForTimeout', 'waitForURL'
      ]);
      for (const name of [
        'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId',
        'getByText', 'getByTitle'
      ]) {
        if (typeof target[name] === 'function') members.set(name, (...args) => wrapLocator(target[name](...args)));
      }
      if (typeof target.locator === 'function') {
        members.set('locator', (selector, options) => wrapLocator(
          target.locator(unwrapLocator(selector), unwrappedLocatorOptions(options, unwrapLocator))
        ));
      }
      if (typeof target.frameLocator === 'function') {
        members.set('frameLocator', (...args) => wrapFrameLocator(target.frameLocator(...args)));
      }
      if (typeof target.childFrames === 'function') members.set('childFrames', () => target.childFrames().map(wrapFrame));
      if (typeof target.parentFrame === 'function') members.set('parentFrame', () => wrapFrame(target.parentFrame()));
      if (typeof target.page === 'function') members.set('page', () => wrapPage(target.page()));
    });
  }

  function wrappedWaitPredicate(event, predicate, facade) {
    if (typeof predicate !== 'function') return predicate;
    return async (candidate) => Reflect.apply(predicate, facade, [wrapEventValue(event, candidate)]);
  }

  function wrapPage(raw) {
    return makeFacade('Page', raw, caches.page, (members, facade, target) => {
      addBlockedMethods(members, 'Page', PAGE_BLOCKED_METHODS);
      addBlockedMethods(members, 'Page', PAGE_BLOCKED_SYNC_METHODS, { synchronous: true });
      addReadMethods(members, target, [
        'ariaSnapshot', 'content', 'getAttribute', 'innerHTML', 'innerText', 'inputValue',
        'isChecked', 'isClosed', 'isDisabled', 'isEditable', 'isEnabled', 'isHidden',
        'isVisible', 'textContent', 'title', 'url', 'viewportSize',
        'waitForLoadState', 'waitForTimeout', 'waitForURL'
      ]);
      for (const property of PAGE_BLOCKED_PROPERTIES) {
        if (!(property in target)) continue;
        members.set(property, BLOCKED_PROPERTY);
      }
      if (target.localStorage && typeof target.localStorage === 'object') {
        members.set('localStorage', wrapWebStorage(target.localStorage, 'Page.localStorage'));
      }
      if (target.sessionStorage && typeof target.sessionStorage === 'object') {
        members.set('sessionStorage', wrapWebStorage(target.sessionStorage, 'Page.sessionStorage'));
      }
      for (const name of [
        'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole', 'getByTestId',
        'getByText', 'getByTitle'
      ]) {
        if (typeof target[name] === 'function') members.set(name, (...args) => wrapLocator(target[name](...args)));
      }
      if (typeof target.locator === 'function') {
        members.set('locator', (selector, options) => wrapLocator(
          target.locator(unwrapLocator(selector), unwrappedLocatorOptions(options, unwrapLocator))
        ));
      }
      if (typeof target.frameLocator === 'function') {
        members.set('frameLocator', (...args) => wrapFrameLocator(target.frameLocator(...args)));
      }
      if (typeof target.frames === 'function') members.set('frames', () => target.frames().map(wrapFrame));
      if (typeof target.frame === 'function') members.set('frame', (...args) => wrapFrame(target.frame(...args)));
      if (typeof target.mainFrame === 'function') members.set('mainFrame', () => wrapFrame(target.mainFrame()));
      if (typeof target.opener === 'function') members.set('opener', async () => wrapPage(await target.opener()));
      if (typeof target.context === 'function') members.set('context', () => contextFacade);
      if (typeof target.workers === 'function') members.set('workers', () => target.workers().map(wrapWorker));
      if (typeof target.video === 'function') members.set('video', () => wrapVideo(target.video()));
      if (typeof target.consoleMessages === 'function') {
        members.set('consoleMessages', async (...args) => (await target.consoleMessages(...args)).map(wrapConsoleMessage));
      }
      if (typeof target.pageErrors === 'function') {
        members.set('pageErrors', async (...args) => (await target.pageErrors(...args)).map((error) => (
          safePlainValue('Page', 'pageErrors', error)
        )));
      }
      if (typeof target.requests === 'function') {
        members.set('requests', async (...args) => (await target.requests(...args)).map(wrapRequest));
      }
      if (typeof target.waitForNavigation === 'function') {
        members.set('waitForNavigation', async (...args) => wrapResponse(await target.waitForNavigation(...args)));
      }
      if (typeof target.waitForRequest === 'function') {
        members.set('waitForRequest', async (predicate, options) => wrapRequest(await target.waitForRequest(
          wrappedWaitPredicate('request', predicate, facade), options
        )));
      }
      if (typeof target.waitForResponse === 'function') {
        members.set('waitForResponse', async (predicate, options) => wrapResponse(await target.waitForResponse(
          wrappedWaitPredicate('response', predicate, facade), options
        )));
      }
      addEventMethods(members, target, facade);
    });
  }

  function wrapContext(raw) {
    return makeFacade('BrowserContext', raw, caches.context, (members, facade, target) => {
      addBlockedMethods(members, 'BrowserContext', CONTEXT_BLOCKED_METHODS);
      addBlockedMethods(members, 'BrowserContext', CONTEXT_BLOCKED_SYNC_METHODS, { synchronous: true });
      addReadMethods(members, target, ['cookies', 'isClosed']);
      for (const property of CONTEXT_BLOCKED_PROPERTIES) {
        if (!(property in target)) continue;
        members.set(property, BLOCKED_PROPERTY);
      }
      if (typeof target.storageState === 'function') {
        members.set('storageState', async (options) => {
          if (options && (typeof options !== 'object' || Object.keys(options).length > 0)) {
            return reject('BrowserContext', 'storageState');
          }
          return target.storageState();
        });
      }
      if (typeof target.pages === 'function') members.set('pages', () => target.pages().map(wrapPage));
      if (typeof target.backgroundPages === 'function') {
        members.set('backgroundPages', () => target.backgroundPages().map(wrapPage));
      }
      if (typeof target.serviceWorkers === 'function') {
        members.set('serviceWorkers', () => target.serviceWorkers().map(wrapWorker));
      }
      addEventMethods(members, target, facade);
    });
  }

  contextFacade = wrapContext(context);
  return Object.freeze({
    page: wrapPage(page),
    context: contextFacade,
    locator: wrapLocator
  });
}
