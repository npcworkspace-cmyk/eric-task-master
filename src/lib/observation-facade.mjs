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

const RAW_LOCATORS = new WeakMap();

export function unwrapObservationLocator(locator) {
  return RAW_LOCATORS.get(locator) || locator;
}

const PAGE_MUTATIONS = new Set([
  'addInitScript', 'bringToFront', 'close', 'emulateMedia', 'exposeBinding',
  'exposeFunction', 'goBack', 'goForward', 'goto', 'reload', 'route',
  'routeFromHAR', 'setContent', 'setDefaultNavigationTimeout',
  'setDefaultTimeout', 'setExtraHTTPHeaders', 'setViewportSize', 'unroute',
  'unrouteAll', 'check', 'click', 'dblclick', 'dispatchEvent', 'dragAndDrop',
  'fill', 'focus', 'hover', 'press', 'selectOption', 'setChecked',
  'setInputFiles', 'tap', 'type', 'uncheck'
]);
const PAGE_HANDLE_ESCAPES = new Set(['$', '$$', 'evaluateHandle', 'waitForSelector']);
const PAGE_INPUT_DEVICES = new Set(['keyboard', 'mouse', 'request', 'touchscreen']);
const PAGE_LOCATOR_BUILDERS = new Set([
  'frameLocator', 'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole',
  'getByTestId', 'getByText', 'getByTitle', 'locator'
]);

const LOCATOR_MUTATIONS = new Set([
  'blur', 'check', 'clear', 'click', 'dblclick', 'dispatchEvent', 'dragTo',
  'fill', 'focus', 'hover', 'press', 'pressSequentially', 'scrollIntoViewIfNeeded',
  'selectOption', 'setChecked', 'setInputFiles', 'tap', 'type', 'uncheck'
]);
const LOCATOR_ESCAPE_HATCHES = new Set(['elementHandle', 'elementHandles', 'evaluateHandle']);
const LOCATOR_BUILDERS = new Set([
  'and', 'filter', 'first', 'getByAltText', 'getByLabel', 'getByPlaceholder',
  'getByRole', 'getByTestId', 'getByText', 'getByTitle', 'last', 'locator', 'nth',
  'or'
]);

const FRAME_MUTATIONS = new Set([
  'addScriptTag', 'addStyleTag', 'check', 'click', 'dblclick', 'dispatchEvent',
  'dragAndDrop', 'fill', 'focus', 'goto', 'hover', 'press', 'selectOption',
  'setChecked', 'setContent', 'setInputFiles', 'tap', 'type', 'uncheck',
  'waitForNavigation'
]);
const FRAME_HANDLE_ESCAPES = new Set(['$', '$$', 'evaluateHandle', 'frameElement', 'waitForSelector']);
const FRAME_LOCATOR_BUILDERS = new Set([
  'frameLocator', 'getByAltText', 'getByLabel', 'getByPlaceholder', 'getByRole',
  'getByTestId', 'getByText', 'getByTitle', 'locator'
]);

const CONTEXT_MUTATIONS = new Set([
  'addCookies', 'addInitScript', 'clearCookies', 'clearPermissions', 'close',
  'exposeBinding', 'exposeFunction', 'grantPermissions', 'newPage', 'route',
  'routeFromHAR', 'setDefaultNavigationTimeout', 'setDefaultTimeout',
  'setExtraHTTPHeaders', 'setGeolocation', 'setHTTPCredentials', 'setOffline',
  'storageState', 'unroute', 'unrouteAll', 'newCDPSession'
]);

const EVALUATION_MUTATIONS = Object.freeze([
  /\.(?:click|focus|blur|submit|reset|remove|append|prepend|replaceWith|scrollIntoView)\s*\(/u,
  /\b(?:scrollTo|scrollBy|dispatchEvent)\s*\(/u,
  /\.(?:setAttribute|removeAttribute|toggleAttribute)\s*\(/u,
  /\.(?:value|checked|selectedIndex|innerHTML|outerHTML|innerText|textContent|className)\s*(?:\+\+|--|[+\-*/%]?=(?!=))/u,
  /\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(/u,
  /\bdocument\s*\.\s*(?:cookie|domain)\s*=(?!=)/u
]);

function evaluationMutates(callback) {
  const source = typeof callback === 'function' ? Function.prototype.toString.call(callback) : String(callback || '');
  return EVALUATION_MUTATIONS.some((pattern) => pattern.test(source));
}

function bindOrValue(target, property) {
  const value = Reflect.get(target, property, target);
  return typeof value === 'function' ? value.bind(target) : value;
}

export function createObservationFacade({
  page,
  context,
  onViolation = () => {},
  requiredFacade = 'journey'
} = {}) {
  if (!page || !context) throw new TypeError('page and context are required');
  const locatorCache = new WeakMap();
  const frameCache = new WeakMap();
  const pageCache = new WeakMap();
  const frameLocatorCache = new WeakMap();

  function reject(surface, operation) {
    const error = new ObservationMutationError(surface, operation, requiredFacade);
    try {
      onViolation({ surface, operation: String(operation), code: error.code });
    } catch {}
    throw error;
  }

  async function evaluateReadOnly(surface, operation, value, callback, args) {
    if (evaluationMutates(callback)) return reject(surface, operation);
    return value(callback, ...args);
  }

  function wrapFrameLocator(frameLocator) {
    if (!frameLocator || typeof frameLocator !== 'object') return frameLocator;
    if (frameLocatorCache.has(frameLocator)) return frameLocatorCache.get(frameLocator);
    const proxy = new Proxy(frameLocator, {
      get(target, property) {
        const value = bindOrValue(target, property);
        if (typeof value !== 'function') return value;
        if (property === 'frameLocator') return (...args) => wrapFrameLocator(value(...args));
        if (FRAME_LOCATOR_BUILDERS.has(property)) return (...args) => wrapLocator(value(...args));
        return value;
      }
    });
    frameLocatorCache.set(frameLocator, proxy);
    return proxy;
  }

  function wrapLocator(locator) {
    if (!locator || typeof locator !== 'object') return locator;
    if (locatorCache.has(locator)) return locatorCache.get(locator);
    const proxy = new Proxy(locator, {
      get(target, property) {
        if (LOCATOR_MUTATIONS.has(property) || LOCATOR_ESCAPE_HATCHES.has(property)) {
          return async () => reject('Locator', property);
        }
        const value = bindOrValue(target, property);
        if (typeof value !== 'function') return value;
        if (LOCATOR_BUILDERS.has(property)) return (...args) => wrapLocator(value(...args));
        if (property === 'all') return async (...args) => (await value(...args)).map(wrapLocator);
        if (property === 'evaluate' || property === 'evaluateAll') {
          return (callback, ...args) => evaluateReadOnly('Locator', property, value, callback, args);
        }
        return value;
      }
    });
    locatorCache.set(locator, proxy);
    RAW_LOCATORS.set(proxy, locator);
    return proxy;
  }

  function wrapFrame(frame) {
    if (!frame || typeof frame !== 'object') return frame;
    if (frameCache.has(frame)) return frameCache.get(frame);
    const proxy = new Proxy(frame, {
      get(target, property) {
        if (FRAME_MUTATIONS.has(property)) return async () => reject('Frame', property);
        if (FRAME_HANDLE_ESCAPES.has(property)) return async () => reject('Frame', property);
        const value = bindOrValue(target, property);
        if (typeof value !== 'function') return value;
        if (property === 'evaluate') {
          return (callback, ...args) => evaluateReadOnly('Frame', property, value, callback, args);
        }
        if (FRAME_LOCATOR_BUILDERS.has(property)) {
          return (...args) => property === 'frameLocator'
            ? wrapFrameLocator(value(...args))
            : wrapLocator(value(...args));
        }
        if (property === 'childFrames') return (...args) => value(...args).map(wrapFrame);
        if (property === 'parentFrame') return (...args) => wrapFrame(value(...args));
        if (property === 'page') return (...args) => wrapPage(value(...args));
        return value;
      }
    });
    frameCache.set(frame, proxy);
    return proxy;
  }

  function wrapPage(candidate) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    if (pageCache.has(candidate)) return pageCache.get(candidate);
    const proxy = new Proxy(candidate, {
      get(target, property) {
        if (PAGE_MUTATIONS.has(property)) return async () => reject('Page', property);
        if (PAGE_HANDLE_ESCAPES.has(property)) return async () => reject('Page', property);
        if (PAGE_INPUT_DEVICES.has(property)) return reject('Page', property);
        const value = bindOrValue(target, property);
        if (typeof value !== 'function') return value;
        if (property === 'evaluate') {
          return (callback, ...args) => evaluateReadOnly('Page', property, value, callback, args);
        }
        if (PAGE_LOCATOR_BUILDERS.has(property)) {
          return (...args) => property === 'frameLocator'
            ? wrapFrameLocator(value(...args))
            : wrapLocator(value(...args));
        }
        if (property === 'frames') return (...args) => value(...args).map(wrapFrame);
        if (property === 'frame') return (...args) => wrapFrame(value(...args));
        if (property === 'mainFrame') return (...args) => wrapFrame(value(...args));
        if (property === 'opener') return async (...args) => wrapPage(await value(...args));
        if (property === 'context') return () => contextProxy;
        if (property === 'waitForEvent') {
          return async (event, ...args) => {
            const result = await value(event, ...args);
            if (event === 'filechooser') {
              return new Proxy(result, {
                get(targetResult, resultProperty) {
                  if (resultProperty === 'setFiles') return async () => reject('FileChooser', resultProperty);
                  return bindOrValue(targetResult, resultProperty);
                }
              });
            }
            if (event === 'popup') return wrapPage(result);
            return result;
          };
        }
        return value;
      }
    });
    pageCache.set(candidate, proxy);
    return proxy;
  }

  const contextProxy = new Proxy(context, {
    get(target, property) {
      if (CONTEXT_MUTATIONS.has(property)) return async () => reject('BrowserContext', property);
      if (property === 'browser' || property === 'request') return reject('BrowserContext', property);
      const value = bindOrValue(target, property);
      if (typeof value !== 'function') return value;
      if (property === 'pages') return (...args) => value(...args).map(wrapPage);
      if (property === 'backgroundPages') return (...args) => value(...args).map(wrapPage);
      if (property === 'waitForEvent') {
        return async (event, ...args) => {
          const result = await value(event, ...args);
          return event === 'page' ? wrapPage(result) : result;
        };
      }
      return value;
    }
  });

  return Object.freeze({
    page: wrapPage(page),
    context: contextProxy,
    locator: wrapLocator
  });
}
