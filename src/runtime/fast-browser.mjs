import { randomUUID } from 'node:crypto';
import { redactSensitiveText, redactSensitiveValue } from '../lib/redaction.mjs';

export function fastError(code, message, details) {
  return Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
}

export function boundedInteger(value, fallback, maximum, name, minimum = 1) {
  const number = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw fastError('INVALID_COMMAND', `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || fastError('TASK_STOPPED', 'Stopped')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

// Runs only in the page. No credentials, input values or full HTML are collected.
function pageSnapshot({ key, scope, maxItems, offset, fields, textOffset = 0, maxTextChars = 2000 }) {
  let state = window[key];
  if (!state || state.document !== document) {
    state?.observer?.disconnect();
    state = { document, epoch: `${Date.now()}-${Math.random()}`, revision: 0, ids: new WeakMap(), next: 0 };
    state.observer = new MutationObserver(() => { state.revision += 1; });
    state.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    window[key] = state;
  }
  const pending = state.observer.takeRecords();
  if (pending.length) state.revision += 1;
  const roots = scope ? document.querySelectorAll(scope) : [document.body];
  if (roots.length !== 1 || !roots[0]) return { unsupported: true, scopeMatches: roots.length };
  const root = roots[0];
  const all = [root, ...root.querySelectorAll('a,button,input,select,textarea,[role],h1,h2,h3,p,li,[data-fast-context],[data-account-id],[data-resource-id],[data-error]')];
  const visible = all.filter((el) => {
    if (!(el instanceof Element) || el.closest('script,style,[hidden],[aria-hidden="true"]')) return false;
    return el.getClientRects().length > 0;
  });
  const pathFor = (el) => {
    const parts = [];
    while (el && el !== document.documentElement) {
      const tag = el.tagName.toLowerCase();
      const siblings = el.parentElement ? [...el.parentElement.children].filter((item) => item.tagName === el.tagName) : [];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(el) + 1})`);
      el = el.parentElement;
    }
    return `html > ${parts.join(' > ')}`;
  };
  const items = visible.slice(offset, offset + maxItems).map((el) => {
    if (!state.ids.has(el)) state.ids.set(el, `r${++state.next}`);
    const sensitive = el.matches('input[type="password"],input[type="email"],input[autocomplete="one-time-code"],[data-private]') || /password|token|secret|otp|verification.?code/i.test(`${el.name || ''} ${el.id || ''}`);
    const result = { ref: state.ids.get(el), selector: pathFor(el), tag: el.tagName.toLowerCase(), domId: sensitive ? null : el.id || null };
    if (!fields || fields.includes('text')) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('script,style,[hidden],[aria-hidden="true"],[data-private],input[type="password"],input[autocomplete="one-time-code"]').forEach((node) => node.remove());
      const fullText = sensitive ? '[REDACTED]' : (el.getAttribute('aria-label') || clone.textContent || '').trim();
      result.text = fullText.slice(textOffset, textOffset + maxTextChars);
      result.textRange = { start: Math.min(textOffset, fullText.length), end: Math.min(textOffset + maxTextChars, fullText.length), total: fullText.length };
      result.textContinuation = result.textRange.end < fullText.length ? { scope: result.selector, textOffset: result.textRange.end, maxItems: 1 } : null;
    }
    if (!fields || fields.includes('state')) {
      result.role = el.getAttribute('role');
      result.disabled = el.matches(':disabled,[aria-disabled="true"]');
      result.checked = Boolean(el.checked);
    }
    return result;
  });
  return { url: location.href, title: document.title, epoch: state.epoch, revision: state.revision, items, total: visible.length, offset };
}

export function compactObservation(snapshot, { maxChars = 12000, maxItems = 60, offset = 0 } = {}) {
  boundedInteger(maxChars, 12000, 64000, 'maxChars', 512);
  boundedInteger(maxItems, 60, 200, 'maxItems');
  boundedInteger(offset, 0, 100000, 'offset', 0);
  const safe = redactSensitiveValue(snapshot);
  const items = [];
  const envelope = { ...safe, items, omitted: { before: offset, after: Math.max(0, safe.total - offset), textCharacters: 0 }, continuation: null };
  if (JSON.stringify(envelope).length > maxChars) throw fastError('CONTEXT_INSUFFICIENT', 'Observation safety envelope exceeds the requested budget');
  for (const original of safe.items.slice(0, maxItems)) {
    const item = { ...original };
    if (typeof item.text === 'string' && !item.textRange) item.textRange = { start: 0, end: item.text.length, total: item.text.length };
    items.push(item);
    const setText = (text) => {
      item.text = text;
      item.textRange = { ...item.textRange, end: item.textRange.start + text.length };
      item.textContinuation = item.textRange.end < item.textRange.total ? { scope: item.selector, textOffset: item.textRange.end, maxItems: 1, ...(safe.pageId && safe.pageVersion ? { textPageId: safe.pageId, textPageVersion: safe.pageVersion } : {}) } : null;
    };
    if (typeof item.text === 'string') {
      const originalText = item.text;
      setText('');
      const remaining = maxChars - JSON.stringify(envelope).length - 120;
      if (remaining < 1 && originalText.length) { items.pop(); break; }
      setText(originalText.slice(0, Math.max(0, remaining)));
      // JSON escaping can occupy more than one output character per text character.
      while (item.text.length && JSON.stringify(envelope).length > maxChars - 80) setText(item.text.slice(0, Math.max(0, item.text.length - Math.max(1, Math.ceil(item.text.length / 4)))));
    }
    if (JSON.stringify(envelope).length > maxChars - 80) { items.pop(); break; }
  }
  envelope.omitted.after = Math.max(0, safe.total - offset - items.length);
  if (safe.items.length && !items.length) throw fastError('CONTEXT_INSUFFICIENT', 'Requested observation budget cannot preserve one item and its omission metadata');
  envelope.omitted.textCharacters = items.reduce((sum, item) => sum + (item.textRange ? item.textRange.total - (item.textRange.end - item.textRange.start) : 0), 0);
  envelope.continuation = envelope.omitted.after ? { offset: offset + items.length } : null;
  return envelope;
}

export function observationDelta(previous, current) {
  const old = new Map(previous.items.map((item) => [item.ref, JSON.stringify(item)]));
  const next = new Map(current.items.map((item) => [item.ref, JSON.stringify(item)]));
  return {
    ...current,
    items: current.items.filter((item) => old.get(item.ref) !== JSON.stringify(item)),
    removed: previous.items.filter((item) => !next.has(item.ref)).map((item) => item.ref),
    unchanged: current.items.filter((item) => old.get(item.ref) === JSON.stringify(item)).length,
    delta: true
  };
}

export function createFastBrowser({ page: initialPage, context, signal, onEvent = async () => {} }) {
  const key = `__etm_${randomUUID().replaceAll('-', '')}`;
  const ids = new WeakMap();
  const refs = new Map();
  const baselines = new Map();
  const attached = new Map();
  let page = initialPage;
  let epoch = 0;
  let disposed = false;
  let unsafe = null;
  const id = (value) => { if (!ids.has(value)) ids.set(value, `page_${randomUUID().slice(0, 12)}`); return ids.get(value); };
  const emit = (type, summary) => { void Promise.resolve(onEvent({ type, summary, priority: 'high', dedupeKey: `${type}:${id(page)}:${epoch}` })).catch(() => {}); };
  const attach = (value) => {
    if (attached.has(value)) return;
    const navigation = (frame) => { if (frame === value.mainFrame?.()) { epoch += 1; refs.clear(); } };
    const dialog = (dialogValue) => { unsafe = 'UNEXPECTED_DIALOG'; epoch += 1; refs.clear(); emit('page.dialog', redactSensitiveText(dialogValue.message()).slice(0, 250)); void dialogValue.dismiss().catch(() => {}); };
    const close = () => { epoch += 1; emit('browser.disconnected', 'Selected page closed'); };
    value.on?.('framenavigated', navigation); value.on?.('dialog', dialog); value.on?.('close', close);
    attached.set(value, { navigation, dialog, close });
  };
  attach(page);
  const active = () => {
    if (signal?.aborted) throw signal.reason || fastError('TASK_STOPPED', 'Stopped');
    if (disposed || page.isClosed?.()) throw fastError('BROWSER_DISCONNECTED', 'Browser page unavailable');
  };
  const meta = async () => {
    active();
    try {
      const value = await page.evaluate(pageSnapshot, { key, scope: null, maxItems: 0, offset: 0 });
      return { pageId: id(page), pageVersion: `${epoch}:${value.epoch}:${value.revision}`, url: value.url, title: value.title };
    } catch (error) {
      throw fastError('OBSERVATION_UNAVAILABLE', 'Page structure is unavailable; request a scoped screenshot or inspect the current page', { cause: error.code });
    }
  };
  const locator = async (target) => {
    active();
    if (!target || typeof target !== 'object') throw fastError('INVALID_TARGET', 'A structured target is required');
    let value;
    if (target.ref) {
      const ref = refs.get(target.ref);
      const current = await meta();
      if (!ref || ref.pageVersion !== current.pageVersion || ref.pageId !== current.pageId) throw fastError('STALE_OBSERVATION', 'Target reference expired; observe the page again');
      value = page.locator(ref.selector);
      if (await value.count() === 1 && !await value.evaluate((element, data) => window[data.key]?.ids.get(element) === data.ref, { key, ref: target.ref })) {
        throw fastError('STALE_OBSERVATION', 'Target element changed');
      }
    } else if (target.selector && typeof target.selector === 'string' && target.selector.length <= 2000) value = page.locator(target.selector);
    else if (target.role && typeof target.name === 'string') value = page.getByRole(target.role, { name: target.name, exact: true });
    else if (typeof target.text === 'string') value = page.getByText(target.text, { exact: true });
    else throw fastError('INVALID_TARGET', 'Use selector, exact role/name, exact text or a fresh reference');
    const count = await value.count();
    if (count !== 1) throw fastError(count ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND', `Target matched ${count} elements`);
    return value;
  };
  const condition = async (value) => {
    active();
    if (!value || typeof value !== 'object') throw fastError('INVALID_CONDITION', 'Condition must be an object');
    if (value.url !== undefined) return page.url() === value.url;
    if (value.urlPrefix !== undefined) return page.url().startsWith(value.urlPrefix);
    let target;
    try { target = await locator(value.target || { selector: value.selector }); }
    catch (error) { if (error.code === 'TARGET_NOT_FOUND') return value.state === 'absent'; throw error; }
    if (value.state === 'absent') return false;
    if (value.state === 'actionable') return await target.isVisible() && await target.isEnabled();
    if (value.state === 'hidden') return !await target.isVisible();
    if (value.attribute) return await target.getAttribute(value.attribute) === String(value.equals);
    if (value.value !== undefined) return await target.inputValue() === String(value.value);
    if (value.text !== undefined) return (await target.innerText()).trim() === String(value.text);
    if (value.includes !== undefined) return (await target.innerText()).includes(String(value.includes));
    return await target.isVisible();
  };
  return {
    meta, locator, condition,
    get page() { return page; },
    get unsafe() { return unsafe; },
    clearUnsafe() { unsafe = null; },
    invalidate() { epoch += 1; refs.clear(); baselines.clear(); },
    async observe(options = {}) {
      active();
      const maxItems = boundedInteger(options.maxItems, 60, 200, 'maxItems');
      const offset = boundedInteger(options.offset, 0, 100000, 'offset', 0);
      const textOffset = boundedInteger(options.textOffset, 0, 10000000, 'textOffset', 0);
      const maxTextChars = boundedInteger(options.maxTextChars, 2000, 8000, 'maxTextChars');
      let snapshot;
      try { snapshot = await page.evaluate(pageSnapshot, { key, scope: options.scope || null, maxItems, offset, fields: options.fields, textOffset, maxTextChars }); }
      catch { throw fastError('OBSERVATION_UNAVAILABLE', 'Structure unavailable; use a scoped screenshot'); }
      if (snapshot.unsupported) throw fastError('CONTEXT_INSUFFICIENT', `Observation scope matched ${snapshot.scopeMatches} elements`);
      const version = `${epoch}:${snapshot.epoch}:${snapshot.revision}`;
      if (options.textPageId && options.textPageId !== id(page) || options.textPageVersion && options.textPageVersion !== version) throw fastError('STALE_OBSERVATION', 'Text continuation changed; restart the scoped read before combining context');
      let current = compactObservation({ ...snapshot, epoch: undefined, revision: undefined, pageId: id(page), pageVersion: version }, { ...options, maxItems, offset });
      for (const item of current.items) refs.set(item.ref, { ...item, pageId: id(page), pageVersion: version });
      if (refs.size > 1000) { const recent = [...refs.entries()].slice(-200); refs.clear(); for (const [k, v] of recent) refs.set(k, v); }
      const scopeKey = JSON.stringify([options.scope || null, offset, maxItems, options.fields || null, textOffset, maxTextChars]);
      const previous = baselines.get(options.baselineId);
      const baselineId = `observation_${randomUUID().slice(0, 12)}`;
      const original = current;
      if (options.baselineId && previous?.scopeKey === scopeKey && previous.value.pageId === current.pageId && previous.documentEpoch === snapshot.epoch) current = observationDelta(previous.value, current);
      else if (options.baselineId) current = { ...current, baselineReset: true };
      baselines.set(baselineId, { value: original, scopeKey, documentEpoch: snapshot.epoch });
      while (baselines.size > 16) baselines.delete(baselines.keys().next().value);
      return { ...current, baselineId, ...(unsafe ? { warning: unsafe } : {}) };
    },
    async read(target) {
      const value = await locator(target);
      const text = redactSensitiveText(await value.innerText());
      if (text.length > 8000) throw fastError('CONTEXT_INSUFFICIENT', 'Text exceeds the bounded direct read; use scoped observe with textOffset continuation', { totalCharacters: text.length });
      return text;
    },
    async readIdentifier(target, attribute) {
      const value = await locator(target);
      const result = attribute ? await value.getAttribute(attribute) : (await value.innerText()).trim();
      if (!result || result.length > 256) throw fastError('IDENTITY_UNVERIFIED', 'Object identity is missing or unbounded');
      return result;
    },
    async refresh(url) {
      active();
      if (url) await page.goto(url, { timeout: 10000, waitUntil: 'domcontentloaded' });
      else await page.reload({ timeout: 10000, waitUntil: 'domcontentloaded' });
      epoch += 1; refs.clear(); baselines.clear();
    },
    async identity(config) {
      if (!config?.account?.selector || !config.resource?.selector) throw fastError('IDENTITY_UNVERIFIED', 'Configure actual page account and resource identity selectors before protected operations');
      const read = async (spec) => {
        const value = await locator({ selector: spec.selector });
        return String(spec.attribute ? await value.getAttribute(spec.attribute) : (await value.innerText()).trim());
      };
      return { accountId: await read(config.account), resourceId: config.resource ? await read(config.resource) : null };
    },
    async validateAction(action) {
      if (action.type === 'navigate' || action.type === 'scroll' && !action.target) return;
      const value = await locator(action.target);
      if (!await value.isVisible() || !await value.isEnabled()) throw fastError('TARGET_NOT_ACTIONABLE', 'Target is not visible and enabled');
    },
    async act(action, timeoutMs = 5000) {
      active();
      if (action.type === 'navigate') {
        const url = new URL(action.value);
        if (!['http:', 'https:'].includes(url.protocol)) throw fastError('INVALID_TARGET', 'Navigation requires HTTP(S)');
        await page.goto(url.href, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      } else if (action.type === 'scroll' && !action.target) {
        const delta = action.value || {};
        if (![delta.x || 0, delta.y || 0].every((n) => Number.isFinite(n) && Math.abs(n) <= 10000)) throw fastError('INVALID_TARGET', 'Scroll is bounded to 10000 pixels');
        await page.mouse.wheel(delta.x || 0, delta.y || 0);
      } else {
        const value = await locator(action.target);
        if (!await value.isVisible() || !await value.isEnabled()) throw fastError('TARGET_NOT_ACTIONABLE', 'Target is not visible and enabled');
        if (action.type === 'click') await value.click({ timeout: timeoutMs });
        else if (action.type === 'fill') await value.fill(String(action.value), { timeout: timeoutMs });
        else if (action.type === 'select') await value.selectOption(action.value, { timeout: timeoutMs });
        else if (action.type === 'key') await value.press(String(action.value), { timeout: timeoutMs });
        else if (action.type === 'scroll') await value.scrollIntoViewIfNeeded({ timeout: timeoutMs });
        else throw fastError('INVALID_ACTION', 'Unsupported action type');
      }
      epoch += 1;
      refs.clear();
    },
    tabs() { return context.pages().filter((value) => !value.isClosed()).map((value) => ({ pageId: id(value), url: redactSensitiveText(value.url()), selected: value === page })); },
    metrics() { return { pages: context.pages().filter((value) => !value.isClosed()).length, attachedPages: attached.size, targetReferences: refs.size, observationBaselines: baselines.size, selectedPageListeners: Object.fromEntries(['framenavigated', 'dialog', 'close'].map((event) => [event, page.listenerCount?.(event) ?? null])) }; },
    async selectTab(pageId) {
      const next = context.pages().find((value) => id(value) === pageId && !value.isClosed());
      if (!next) throw fastError('TARGET_NOT_FOUND', 'Selected tab does not exist');
      page = next; attach(page); epoch += 1; refs.clear(); baselines.clear(); unsafe = null;
      return meta();
    },
    async dispose() {
      disposed = true;
      for (const [value, handlers] of attached) {
        value.off?.('framenavigated', handlers.navigation); value.off?.('dialog', handlers.dialog); value.off?.('close', handlers.close);
        if (!value.isClosed?.()) await value.evaluate((storageKey) => { window[storageKey]?.observer?.disconnect(); delete window[storageKey]; }, key).catch(() => {});
      }
      attached.clear(); refs.clear(); baselines.clear();
    }
  };
}
