import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { redactSensitiveText, redactSensitiveValue, sensitiveTextRules, sensitiveDescriptorRules, sliceRedactedText } from '../lib/redaction.mjs';
import { sameDocument } from '../lib/operations-actions.mjs';
import { createFastCursor } from './fast-cursor.mjs';
import { FAST_REFERENCE_ENGINE } from './fast-reference-selector.mjs';

const TEXT_REDACTION_RULES = sensitiveTextRules();
const DESCRIPTOR_REDACTION_RULES = sensitiveDescriptorRules();

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

const CONDITION_KEYS = new Set(['target', 'selector', 'url', 'urlPrefix', 'state', 'attribute', 'equals', 'value', 'values', 'text', 'includes', 'checked']);
const CONDITION_STATES = new Set(['visible', 'hidden', 'absent', 'attached', 'actionable']);
const has = (value, key) => Object.hasOwn(value, key);
export function validateFastCondition(value) {
  const invalid = message => { throw fastError('INVALID_CONDITION', message); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Condition must be an object');
  for (const key of Object.keys(value)) if (!CONDITION_KEYS.has(key)) invalid(`Unsupported condition field: ${key}`);
  for (const key of ['url', 'urlPrefix']) if (has(value, key) && (typeof value[key] !== 'string' || !value[key])) invalid(`${key} must be a nonempty string`);
  if (has(value, 'state') && !CONDITION_STATES.has(value.state)) invalid('Unsupported condition state');
  if (has(value, 'target') && has(value, 'selector')) invalid('Use target or selector, not both');
  const target = value.target || (has(value, 'selector') ? { selector: value.selector } : null);
  if (target) {
    if (typeof target !== 'object' || Array.isArray(target)) invalid('Condition target must be structured');
    for (const key of Object.keys(target)) if (!['ref', 'selector', 'role', 'name', 'text'].includes(key)) invalid(`Unsupported condition target field: ${key}`);
    for (const key of ['ref', 'selector', 'role', 'name', 'text']) if (has(target, key) && typeof target[key] !== 'string') invalid(`Condition target ${key} must be a string`);
    const forms = Number(Boolean(target.ref)) + Number(Boolean(target.selector)) + Number(Boolean(target.role) && typeof target.name === 'string') + Number(has(target, 'text'));
    if (forms !== 1 || has(target, 'role') !== has(target, 'name')) invalid('Condition target must use one exact selector, role/name, text or ref');
    if (has(target, 'selector') && (!target.selector || target.selector.length > 2000)) invalid('Condition selector must contain 1-2000 characters');
  } else if (has(value, 'target') || has(value, 'selector')) invalid('Condition target is missing');
  if (!target && !has(value, 'url') && !has(value, 'urlPrefix')) invalid('Condition needs a target or URL predicate');
  const predicates = ['state', 'attribute', 'equals', 'value', 'values', 'text', 'includes', 'checked'];
  if (!target && predicates.some(key => has(value, key))) invalid('DOM predicates need a target');
  if (has(value, 'attribute') !== has(value, 'equals')) invalid('Attribute conditions require attribute and equals');
  if (has(value, 'attribute') && (typeof value.attribute !== 'string' || !value.attribute || value.attribute.length > 256)) invalid('Attribute name must contain 1-256 characters');
  const scalar = item => item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item);
  for (const key of ['value', 'equals']) if (has(value, key) && !scalar(value[key])) invalid(`${key} must be a finite scalar`);
  for (const key of ['text', 'includes']) if (has(value, key) && (typeof value[key] !== 'string' || key === 'includes' && !value[key])) invalid(`${key} must be ${key === 'includes' ? 'a nonempty string' : 'a string'}`);
  if (has(value, 'values') && (!Array.isArray(value.values) || value.values.some(item => typeof item !== 'string'))) invalid('values must be an array of exact selected strings');
  if (has(value, 'value') && has(value, 'values')) invalid('Use value or selected values, not both');
  if (has(value, 'checked') && typeof value.checked !== 'boolean' && value.checked !== 'mixed') invalid('checked must be boolean or mixed');
  if (value.state === 'absent' && ['attribute', 'value', 'values', 'text', 'includes', 'checked'].some(key => has(value, key))) invalid('Absent targets cannot also prove DOM content or state');
  return value;
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || fastError('TASK_STOPPED', 'Stopped')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

// Runs only in the page. Captures safe current values; sensitive controls are
// masked before slicing. No credentials or full HTML are collected.
function pageSnapshot({ key, cursorKey, scope, expectedRef, redactionRules = [], descriptorRules, maxItems, offset, fields, textMode = 'own', textOffset = 0, maxTextChars = 2000, valueOffset = 0, maxValueChars = 512, nameOffset = 0, maxNameChars = 512 }) {
  const owned = (node) => Boolean(window[cursorKey]?.ownedHosts.has(node));
  const relevant = (records) => records.some((record) => {
    if (owned(record.target)) return false;
    if (record.type === 'childList') return [...record.addedNodes, ...record.removedNodes].some((node) => !owned(node));
    return true;
  });
  let state = window[key];
  if (!state || state.document !== document) {
    state?.observer?.disconnect();
    state = { document, epoch: `${Date.now()}-${Math.random()}`, revision: 0, ids: new WeakMap(), references: new Map(), next: 0 };
    state.observer = new MutationObserver((records) => { if (relevant(records)) state.revision += 1; });
    state.observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
    window[key] = state;
  }
  const pending = state.observer.takeRecords();
  if (relevant(pending)) state.revision += 1;
  if (maxItems === 0 && !scope) return { url: location.href, title: document.title, epoch: state.epoch, revision: state.revision, items: [], total: 0, offset };
  const referenced = expectedRef && state.references.get(expectedRef);
  if (expectedRef && (!referenced?.isConnected || referenced.ownerDocument !== document || state.ids.get(referenced) !== expectedRef)) return { staleRef: true };
  const roots = expectedRef ? [referenced] : scope ? document.querySelectorAll(scope) : [document.body || document.documentElement];
  if (roots.length !== 1 || !roots[0]) return { unsupported: true, scopeMatches: roots.length };
  const root = roots[0];
  if (expectedRef && state.ids.get(root) !== expectedRef) return { staleRef: true };
  const redactors = redactionRules.map(({ source, flags, replacement }) => ({ pattern: new RegExp(source, flags), replacement }));
  const descriptor = descriptorRules && { direct: new RegExp(descriptorRules.direct.source, descriptorRules.direct.flags), compact: descriptorRules.compact.map(rule => new RegExp(rule.source, rule.flags)), named: new RegExp(descriptorRules.named.source, descriptorRules.named.flags) };
  const sensitiveName = value => {
    const name = String(value || '').trim();
    const compact = name.replace(/[-_\s]/g, '').toLowerCase();
    return Boolean(descriptor && (descriptor.direct.test(name) || descriptor.compact.some(pattern => pattern.test(compact)) || descriptor.named.test(name)));
  };
  const redact = (value) => {
    let result = String(value);
    for (const { pattern, replacement } of redactors) result = result.replace(pattern, replacement);
    return result;
  };
  const chunk = (value, start, limit) => {
    if (start >= value.length) return { text: '', range: { start: value.length, end: value.length, total: value.length } };
    const stable = text => redact(text) === text;
    if (!stable(value.slice(start))) throw new Error('UNSAFE_TEXT_OFFSET: Requested source offset creates a new secret boundary; restart from offset 0');
    const marker = '[REDACTED]';
    const spans = [];
    for (const { pattern } of redactors) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(value))) if (match[0].includes(marker)) spans.push([match.index, match.index + match[0].length]);
    }
    for (let at = value.indexOf(marker); at >= 0; at = value.indexOf(marker, at + marker.length)) spans.push([at, at + marker.length]);
    const merged = [];
    for (const span of spans.sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1);
      if (previous && span[0] < previous[1]) previous[1] = Math.max(previous[1], span[1]);
      else merged.push(span);
    }
    const target = Math.min(value.length, start + limit);
    const snap = (end, forward) => {
      for (const [from, finish] of merged) if (from < end && finish > end) { end = forward ? finish : from > start ? from : finish; break; }
      return end;
    };
    const safeEnd = end => end > start && stable(value.slice(start, end)) && stable(value.slice(end));
    const checked = new Set();
    for (const forward of [false, true]) for (let shift = 0; shift <= 32; shift++) {
      const end = snap(Math.min(value.length, Math.max(start, target + (forward ? shift : -shift))), forward);
      if (checked.has(end)) continue;
      checked.add(end);
      if (safeEnd(end)) return { text: value.slice(start, end), range: { start, end, total: value.length } };
    }
    throw new Error('CONTEXT_INSUFFICIENT: No redaction-stable boundary fits; request a larger full field read');
  };
  const observedSelector = 'a,button,input,select,textarea,[role],[contenteditable]:not([contenteditable="false"]),iframe,canvas,h1,h2,h3,p,li,dialog,[data-fast-context],[data-account-id],[data-resource-id],[data-error]';
  const all = [root, ...root.querySelectorAll(observedSelector)];
  const visible = all.filter((el) => {
    if (!(el instanceof Element) || owned(el) || el.closest('script,style,[hidden],[aria-hidden="true"]')) return false;
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
  const selected = visible.slice(offset, offset + maxItems);
  // Refresh this entire scene before pruning. It contains at most 200 nodes,
  // so every currently returned ref remains inside the 1000-entry registry.
  for (const el of selected) {
    if (!state.ids.has(el)) state.ids.set(el, `r${++state.next}`);
    state.references.delete(state.ids.get(el));
    state.references.set(state.ids.get(el), el);
  }
  while (state.references.size > 1000) state.references.delete(state.references.keys().next().value);
  const items = selected.map((el) => {
    const sensitive = Boolean(el.closest('[data-private]')) || el.matches('input[type="password"],input[type="email"],input[autocomplete="one-time-code"]') || /password|passwd|pwd|api.?key|token|secret|otp|verification.?code/i.test(`${el.name || ''} ${el.id || ''}`);
    const result = { ref: state.ids.get(el), selector: pathFor(el), tag: el.tagName.toLowerCase(), domId: sensitive ? null : el.id || null };
    const implicitRoles = { button: 'button', textarea: 'textbox', select: 'combobox', dialog: 'dialog', h1: 'heading', h2: 'heading', h3: 'heading', li: 'listitem' };
    const inputRoles = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', range: 'slider', number: 'spinbutton' };
    const role = el.getAttribute('role') || implicitRoles[result.tag] || (result.tag === 'a' && el.hasAttribute('href') ? 'link' : null) || (result.tag === 'input' ? inputRoles[el.type] || 'textbox' : null);
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,[hidden],[aria-hidden="true"],[data-private],input[type="password"],input[type="email"],input[autocomplete="one-time-code"]').forEach((node) => node.remove());
    const cleanText = clone.textContent || '';
    const labelText = (node) => {
      if (!node || node.closest('[data-private]')) return '';
      const copy = node.cloneNode(true);
      copy.querySelectorAll('[data-private],script,style,[hidden],[aria-hidden="true"]').forEach((child) => child.remove());
      if (node.tagName === 'LABEL') copy.querySelectorAll('input,textarea,select').forEach((child) => child.remove());
      return copy.textContent || '';
    };
    const label = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean).map((labelId) => {
      const labelled = document.getElementById(labelId);
      return labelText(labelled);
    }).join(' ').trim() || [...(el.labels || [])].map(labelText).join(' ').trim();
    const hasName = Boolean(label) || ['button', 'link', 'option', 'heading'].includes(role);
    const fullName = label || cleanText.trim() || (result.tag === 'input' ? String(el.value || '') : '');
    if (!fields || fields.includes('text')) {
      // A default scene reports each represented descendant once. A full read,
      // or an explicit textMode continuation, retains its exact source basis.
      if (textMode === 'own') clone.querySelectorAll(observedSelector).forEach((node) => node.remove());
      const fullText = sensitive ? '[REDACTED]' : redact((textMode === 'full' ? el.getAttribute('aria-label') || clone.textContent || '' : clone.textContent || '').trim());
      const slice = chunk(fullText, textOffset, maxTextChars);
      result.text = slice.text;
      result.textMode = textMode;
      result.textRange = slice.range;
      result.textContinuation = result.textRange.end < fullText.length ? { ref: result.ref, detail: 'full', fields: ['text'], textMode, textOffset: result.textRange.end, maxItems: 1 } : null;
    }
    const field = (name, value, start, limit) => {
      const slice = chunk(value, start, limit);
      result[name] = slice.text;
      if (slice.range.start > 0 || slice.range.end < slice.range.total) result[`${name}Range`] = slice.range;
      if (name === 'name' && (slice.range.start > 0 || slice.range.end < slice.range.total)) result.nameExact = false;
      if (slice.range.end < slice.range.total) result[`${name}Continuation`] = { ref: result.ref, detail: 'full', fields: [name], [`${name}Offset`]: slice.range.end, maxItems: 1, [`max${name[0].toUpperCase()}${name.slice(1)}Chars`]: limit };
    };
    if ((!fields || fields.includes('state') || fields.includes('name')) && hasName) {
      field('name', sensitive ? '[REDACTED]' : redact(fullName), nameOffset, maxNameChars);
    }
    if ((!fields || fields.includes('state') || fields.includes('value')) && (el.matches('input,textarea,[contenteditable]:not([contenteditable="false"])') || result.tag === 'select')) {
      field('value', sensitive || hasName && sensitiveName(fullName) ? '[REDACTED]' : redact(el.isContentEditable ? cleanText : String(el.value ?? '')), valueOffset, maxValueChars);
    }
    if (!fields || fields.includes('state')) {
      result.role = role;
      result.editable = el.matches('input,textarea,[contenteditable]:not([contenteditable="false"])');
      result.disabled = el.matches(':disabled,[aria-disabled="true"]');
      result.checked = el.indeterminate || el.getAttribute('aria-checked') === 'mixed' ? 'mixed' : el.hasAttribute('aria-checked') ? el.getAttribute('aria-checked') === 'true' : Boolean(el.checked);
      for (const attribute of ['expanded', 'pressed', 'selected', 'required', 'invalid', 'readonly', 'modal']) {
        const value = el.getAttribute(`aria-${attribute}`);
        if (value !== null) result[attribute] = value === 'true' ? true : value === 'false' ? false : value;
      }
      if (el.required) result.required = true;
      if (el.readOnly) result.readonly = true;
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
    for (const name of ['name', 'value']) if (item[`${name}Continuation`]) item[`${name}Continuation`] = { ...item[`${name}Continuation`], ...(safe.pageId && safe.pageVersion ? { textPageId: safe.pageId, textPageVersion: safe.pageVersion } : {}) };
    if (typeof item.text === 'string' && !item.textRange) item.textRange = { start: 0, end: item.text.length, total: item.text.length };
    items.push(item);
    const setText = (text, limit = text.length) => {
      item.text = sliceRedactedText(text, 0, limit);
      item.textRange = { ...item.textRange, end: item.textRange.start + item.text.length };
      item.textContinuation = item.textRange.end < item.textRange.total ? { ...(item.textMode && item.ref ? { ref: item.ref, detail: 'full', fields: ['text'], textMode: item.textMode } : { scope: item.selector }), textOffset: item.textRange.end, maxItems: 1, ...(safe.pageId && safe.pageVersion ? { textPageId: safe.pageId, textPageVersion: safe.pageVersion } : {}) } : null;
    };
    if (typeof item.text === 'string') {
      const originalText = item.text;
      setText('');
      const remaining = maxChars - JSON.stringify(envelope).length - 120;
      if (remaining < 1 && originalText.length) { items.pop(); break; }
      let limit = Math.max(0, remaining);
      setText(originalText, limit);
      // JSON escaping can occupy more than one output character per text character.
      while (item.text.length && JSON.stringify(envelope).length > maxChars - 80 && limit > 0) {
        limit = Math.max(0, limit - Math.max(1, Math.ceil(limit / 4)));
        setText(originalText, limit);
      }
      if (originalText.length && !item.text.length) { items.pop(); break; }
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
  const partial = snapshot => snapshot.offset > 0 || snapshot.omitted?.before > 0 || snapshot.omitted?.after > 0 || snapshot.omitted?.textCharacters > 0 ||
    snapshot.continuation || snapshot.items.some(item => ['text', 'name', 'value'].some(field => item[`${field}Range`]?.end < item[`${field}Range`]?.total));
  if (partial(previous) || partial(current)) return { ...current, baselineReset: true };
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

export function createFastBrowser({ page: initialPage, context, signal, outputDir, showCursor = false, onEvent = async () => {} }) {
  const key = `__etm_${randomUUID().replaceAll('-', '')}`;
  const ids = new WeakMap();
  const refs = new Map();
  const baselines = new Map();
  const attached = new Map();
  const unsafePages = new WeakMap();
  const intentionallyClosed = new WeakSet();
  const cursor = createFastCursor({ enabled: showCursor });
  let page = initialPage;
  let epoch = 0;
  let disposed = false;
  let stageRecorder = null;
  const nativeAction = async (action, perform, binding) => {
    const record = (event, error) => { try { stageRecorder?.({ stage: 'native-action', event, actionId: action.actionId, actionType: action.type, ...(error ? { code: error.code || error.name || 'ACTION_FAILED' } : {}) }); } catch { /* diagnostics cannot alter execution */ } };
    record('begin');
    try {
      active();
      if (unsafePages.has(page)) throw fastError(unsafePages.get(page).code, 'An unexpected dialog interrupted action preparation');
      if (binding && (page !== binding.page || epoch !== binding.epoch)) throw fastError('STALE_OBSERVATION', 'Page or control ownership changed during action preparation');
      const result = await perform(); record('end'); return result;
    }
    catch (error) {
      const failure = /\bETM_STALE_REFERENCE\b/u.test(error.message || '') ? fastError('STALE_OBSERVATION', 'The originally observed target was detached or replaced') : error;
      record('fail', failure); throw failure;
    }
  };
  const id = (value) => { if (!ids.has(value)) ids.set(value, `page_${randomUUID().slice(0, 12)}`); return ids.get(value); };
  const emit = (type, summary) => { void Promise.resolve(onEvent({ type, summary, priority: 'high', dedupeKey: `${type}:${id(page)}:${epoch}` })).catch(() => {}); };
  const attach = (value) => {
    if (attached.has(value)) return;
    const navigation = (frame) => { if (frame === value.mainFrame?.()) { epoch += 1; refs.clear(); void cursor.navigation(value); } };
    const dialog = (dialogValue) => { unsafePages.set(value, { code: 'UNEXPECTED_DIALOG', token: randomUUID() }); epoch += 1; refs.clear(); emit('page.dialog', redactSensitiveText(dialogValue.message()).slice(0, 250)); void dialogValue.dismiss().catch(() => {}); };
    const close = () => { epoch += 1; if (!intentionallyClosed.has(value)) emit('browser.disconnected', 'Selected page closed'); };
    value.on?.('framenavigated', navigation); value.on?.('dialog', dialog); value.on?.('close', close);
    attached.set(value, { navigation, dialog, close });
  };
  attach(page);
  void cursor.select(page);
  const active = () => {
    if (signal?.aborted) throw signal.reason || fastError('TASK_STOPPED', 'Stopped');
    if (disposed || page.isClosed?.()) throw fastError('BROWSER_DISCONNECTED', 'Browser page unavailable');
  };
  const meta = async () => {
    active();
    try {
      const value = await page.evaluate(pageSnapshot, { key, cursorKey: cursor.key, scope: null, maxItems: 0, offset: 0 });
      return { pageId: id(page), pageVersion: `${epoch}:${value.epoch}:${value.revision}`, url: value.url, title: value.title };
    } catch (error) {
      throw fastError('OBSERVATION_UNAVAILABLE', 'Page structure is unavailable; wait for navigation or inspect the current page', { cause: error.code || 'PAGE_EVALUATION_FAILED', message: redactSensitiveText(error.message || '').slice(0, 1000) });
    }
  };
  const locator = async (target, { timeoutMs = 0 } = {}) => {
    active();
    if (!target || typeof target !== 'object') throw fastError('INVALID_TARGET', 'A structured target is required');
    let value;
    if (target.ref) {
      const ref = refs.get(target.ref);
      const current = await meta();
      if (!ref || !sameDocument(ref.pageVersion, current.pageVersion) || ref.pageId !== current.pageId) throw fastError('STALE_OBSERVATION', 'Target document changed; observe the page again');
      value = page.locator(`${FAST_REFERENCE_ENGINE}=${JSON.stringify({ key, ref: target.ref })}`);
    } else if (target.selector && typeof target.selector === 'string' && target.selector.length <= 2000) value = page.locator(target.selector);
    else if (target.role && typeof target.name === 'string') value = page.getByRole(target.role, { name: target.name, exact: true });
    else if (typeof target.text === 'string') value = page.getByText(target.text, { exact: true });
    else throw fastError('INVALID_TARGET', 'Use selector, exact role/name, exact text or a fresh reference');
    let count;
    try { count = await value.count(); }
    catch (error) { if (/\bETM_STALE_REFERENCE\b/u.test(error.message || '')) throw fastError('STALE_OBSERVATION', 'The originally observed target was detached or replaced'); throw error; }
    if (target.ref && count !== 1) throw fastError('STALE_OBSERVATION', 'The originally observed target is no longer connected');
    if (!count && timeoutMs > 0) { await value.waitFor({ state: 'attached', timeout: timeoutMs }).catch(() => {}); count = await value.count(); }
    if (count !== 1) throw fastError(count ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND', `Target matched ${count} elements`, { target: redactSensitiveValue(target), matches: count });
    return value;
  };
  const condition = async (value) => {
    active();
    validateFastCondition(value);
    if (has(value, 'url') && page.url() !== value.url) return false;
    if (has(value, 'urlPrefix') && !page.url().startsWith(value.urlPrefix)) return false;
    if (!value.target && !value.selector) return true;
    let target;
    try { target = await locator(value.target || { selector: value.selector }); }
    catch (error) { if (error.code === 'TARGET_NOT_FOUND') return value.state === 'absent'; throw error; }
    if (value.state === 'absent') return false;
    if (value.state === 'actionable' && (!await target.isVisible() || !await target.isEnabled())) return false;
    if (value.state === 'hidden' && await target.isVisible()) return false;
    if (value.state === 'visible' && !await target.isVisible()) return false;
    if (has(value, 'attribute') && await target.getAttribute(value.attribute) !== (value.equals === null ? null : String(value.equals))) return false;
    if (has(value, 'checked')) {
      const state = await target.evaluate(element => {
        const role = element.getAttribute('role'), aria = element.getAttribute('aria-checked');
        const native = element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type);
        const supported = native || ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'].includes(role);
        return { supported, available: native && aria === null || ['true', 'false', 'mixed'].includes(aria), checked: element.indeterminate || aria === 'mixed' ? 'mixed' : aria !== null ? aria === 'true' : Boolean(element.checked) };
      });
      if (!state.supported || !state.available) throw fastError('INVALID_CONDITION', 'checked requires an actual checkable control with a known state');
      if (state.checked !== value.checked) return false;
    }
    if (has(value, 'value') || has(value, 'values')) {
      const state = await target.evaluate(element => ({ editable: element.isContentEditable, select: element.tagName === 'SELECT',
        multiple: element.tagName === 'SELECT' && element.multiple, values: element.tagName === 'SELECT' ? [...element.selectedOptions].map(option => option.value) : null }));
      if (has(value, 'values')) {
        if (!state.select) throw fastError('INVALID_CONDITION', 'values requires a native select control');
        if (JSON.stringify([...state.values].sort()) !== JSON.stringify([...value.values].sort())) return false;
      } else {
        if (state.multiple) throw fastError('INVALID_CONDITION', 'Multiple select proof requires exact values, not its first value');
        if ((state.editable ? await target.innerText() : await target.inputValue()) !== String(value.value)) return false;
      }
    }
    if (has(value, 'text') && (await target.innerText()).trim() !== value.text) return false;
    if (has(value, 'includes') && !(await target.innerText()).includes(value.includes)) return false;
    return !['state', 'attribute', 'value', 'values', 'text', 'includes', 'checked'].some(key => has(value, key)) ? await target.isVisible() : true;
  };
  return {
    meta, locator, condition,
    get page() { return page; },
    get unsafe() { return unsafePages.get(page)?.code || null; },
    get unsafeToken() { return unsafePages.get(page)?.token || null; },
    clearUnsafe(token) { const value = unsafePages.get(page); if (value?.code !== 'UNEXPECTED_DIALOG' || token && value.token !== token) return false; unsafePages.delete(page); return true; },
    setStageRecorder(value) { stageRecorder = typeof value === 'function' ? value : null; },
    setCursorEnabled: (value) => cursor.setEnabled(value),
    pauseCursor: (value) => cursor.setPaused(value),
    get cursorState() { return { enabled: cursor.enabled, paused: cursor.paused, position: cursor.position }; },
    withoutCursor: (capture) => cursor.without(page, capture),
    async positionCursor(target, { click = false } = {}) { return cursor.point(page, await locator(target), { click }); },
    invalidate() { epoch += 1; refs.clear(); baselines.clear(); },
    async observe(options = {}) {
      active();
      if (options.detail !== undefined && !['compact', 'full'].includes(options.detail)) throw fastError('INVALID_COMMAND', 'detail must be compact or full');
      const textMode = options.textMode || (options.detail === 'full' ? 'full' : 'own');
      if (!['own', 'full'].includes(textMode)) throw fastError('INVALID_COMMAND', 'textMode must be own or full');
      if (options.ref && options.scope) throw fastError('INVALID_COMMAND', 'Use either ref or scope, not both');
      let scope = options.scope || null;
      if (options.ref) { await locator({ ref: options.ref }); scope = refs.get(options.ref).selector; }
      const maxItems = boundedInteger(options.maxItems, 60, 200, 'maxItems');
      if (options.maxChars !== undefined) boundedInteger(options.maxChars, 12000, 64000, 'maxChars', 512);
      const captureMaxChars = boundedInteger(options.captureMaxChars, options.maxChars ?? 12000, 64000, 'captureMaxChars', 512);
      const offset = boundedInteger(options.offset, 0, 100000, 'offset', 0);
      const textOffset = boundedInteger(options.textOffset, 0, 10000000, 'textOffset', 0);
      const maxTextChars = boundedInteger(options.maxTextChars, 2000, 8000, 'maxTextChars');
      const valueOffset = boundedInteger(options.valueOffset, 0, 10000000, 'valueOffset', 0);
      const maxValueChars = boundedInteger(options.maxValueChars, 512, 8000, 'maxValueChars');
      const nameOffset = boundedInteger(options.nameOffset, 0, 10000000, 'nameOffset', 0);
      const maxNameChars = boundedInteger(options.maxNameChars, 512, 8000, 'maxNameChars');
      let snapshot;
      try { snapshot = await page.evaluate(pageSnapshot, { key, cursorKey: cursor.key, scope, expectedRef: options.ref, redactionRules: TEXT_REDACTION_RULES, descriptorRules: DESCRIPTOR_REDACTION_RULES, maxItems, offset, fields: options.fields, textMode, textOffset, maxTextChars, valueOffset, maxValueChars, nameOffset, maxNameChars }); }
      catch (error) {
        if (/\bUNSAFE_TEXT_OFFSET\b/u.test(error.message || '')) throw fastError('UNSAFE_TEXT_OFFSET', 'Requested source offset creates a secret boundary; restart this field from offset 0');
        if (/\bCONTEXT_INSUFFICIENT\b/u.test(error.message || '')) throw fastError('CONTEXT_INSUFFICIENT', 'No redaction-stable boundary fits; request a larger full field read');
        throw fastError('OBSERVATION_UNAVAILABLE', 'Structure unavailable; use a scoped screenshot');
      }
      if (snapshot.staleRef) throw fastError('STALE_OBSERVATION', 'Target element changed while expanding its reference');
      if (snapshot.unsupported) throw fastError('CONTEXT_INSUFFICIENT', `Observation scope matched ${snapshot.scopeMatches} elements`);
      const version = `${epoch}:${snapshot.epoch}:${snapshot.revision}`;
      if (options.textPageId && options.textPageId !== id(page) || options.textPageVersion && options.textPageVersion !== version) throw fastError('STALE_OBSERVATION', 'Text continuation changed; restart the scoped read before combining context');
      let current = compactObservation({ ...snapshot, epoch: undefined, revision: undefined, pageId: id(page), pageVersion: version }, { ...options, maxChars: captureMaxChars, maxItems, offset });
      for (const item of current.items) { refs.delete(item.ref); refs.set(item.ref, { ...item, pageId: id(page), pageVersion: version }); }
      while (refs.size > 1000) refs.delete(refs.keys().next().value);
      const scopeKey = JSON.stringify([scope, offset, maxItems, options.fields || null, textOffset, maxTextChars, textMode, captureMaxChars, valueOffset, maxValueChars, nameOffset, maxNameChars]);
      const previous = baselines.get(options.baselineId);
      const baselineId = `observation_${randomUUID().slice(0, 12)}`;
      const original = current;
      if (options.baselineId && previous?.scopeKey === scopeKey && previous.value.pageId === current.pageId && previous.documentEpoch === snapshot.epoch) current = observationDelta(previous.value, current);
      else if (options.baselineId) current = { ...current, baselineReset: true };
      baselines.set(baselineId, { value: original, scopeKey, documentEpoch: snapshot.epoch });
      while (baselines.size > 16) baselines.delete(baselines.keys().next().value);
      if (showCursor && !cursor.position) await cursor.point(page, null, { anchor: true });
      return { ...current, baselineId, ...(unsafePages.get(page) ? { warning: unsafePages.get(page).code } : {}) };
    },
    async observePages(pageIds, options = {}) {
      active();
      if (options.detail !== undefined && !['compact', 'full'].includes(options.detail)) throw fastError('INVALID_COMMAND', 'detail must be compact or full');
      const textMode = options.textMode || (options.detail === 'full' ? 'full' : 'own');
      if (!['own', 'full'].includes(textMode)) throw fastError('INVALID_COMMAND', 'textMode must be own or full');
      return Promise.all(pageIds.map(async (pageId) => {
        const value = context.pages().find((item) => id(item) === pageId && !item.isClosed());
        if (!value) throw fastError('TARGET_NOT_FOUND', 'Selected observation tab no longer exists', { pageId });
        const snapshot = await value.evaluate(pageSnapshot, { key, cursorKey: cursor.key, scope: options.scope || null, redactionRules: TEXT_REDACTION_RULES, descriptorRules: DESCRIPTOR_REDACTION_RULES, maxItems: boundedInteger(options.maxItems, 30, 200, 'maxItems'), offset: boundedInteger(options.offset, 0, 100000, 'offset', 0), textMode,
          textOffset: boundedInteger(options.textOffset, 0, 10000000, 'textOffset', 0), maxTextChars: boundedInteger(options.maxTextChars, 1000, 8000, 'maxTextChars'),
          valueOffset: boundedInteger(options.valueOffset, 0, 10000000, 'valueOffset', 0), maxValueChars: boundedInteger(options.maxValueChars, 512, 8000, 'maxValueChars'),
          nameOffset: boundedInteger(options.nameOffset, 0, 10000000, 'nameOffset', 0), maxNameChars: boundedInteger(options.maxNameChars, 512, 8000, 'maxNameChars') });
        if (snapshot.unsupported) throw fastError('CONTEXT_INSUFFICIENT', 'Tab observation scope is not unique', { pageId, matches: snapshot.scopeMatches });
        const version = `${epoch}:${snapshot.epoch}:${snapshot.revision}`;
        if (options.textPageId && options.textPageId !== pageId || options.textPageVersion && options.textPageVersion !== version) throw fastError('STALE_OBSERVATION', 'Text continuation changed; restart the scoped read before combining context');
        const result = compactObservation({ ...snapshot, epoch: undefined, revision: undefined, pageId, pageVersion: version }, { maxChars: options.maxChars ?? 4000, maxItems: options.maxItems ?? 30, offset: options.offset ?? 0 });
        // A reference belongs to the selected page's latest observation. Peer
        // tab reads use their selectors plus pageId; they never move selection.
        return { ...result, referenceMode: 'selectors-with-pageId', items: result.items.map(({ ref, ...item }) => {
          for (const name of ['text', 'name', 'value']) if (item[`${name}Continuation`]) { const { ref: continuationRef, ...continuation } = item[`${name}Continuation`]; item[`${name}Continuation`] = { ...continuation, scope: item.selector }; }
          return item;
        }) };
      }));
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
    async identity(config, { timeoutMs = 0 } = {}) {
      if (!config?.account?.selector || !config.resource?.selector) throw fastError('IDENTITY_UNVERIFIED', 'Configure actual page account and resource identity selectors before protected operations');
      const read = async (spec, field) => {
        let value;
        try { value = await locator({ selector: spec.selector }, { timeoutMs }); }
        catch (error) { error.details = { ...error.details, phase: 'identity', field }; throw error; }
        return String(spec.attribute ? await value.getAttribute(spec.attribute) : (await value.innerText()).trim());
      };
      return { accountId: await read(config.account, 'account'), resourceId: config.resource ? await read(config.resource, 'resource') : null };
    },
    async validateAction(action, timeoutMs = 5000) {
      if (['navigate', 'back', 'forward', 'reload', 'new-tab', 'close-tab'].includes(action.type) || ['scroll', 'key', 'type'].includes(action.type) && !action.target || action.target?.x !== undefined) return;
      const value = await locator(action.target, { timeoutMs });
      if (action.type !== 'upload' && !await value.isVisible() || !await value.isEnabled()) throw fastError('TARGET_NOT_ACTIONABLE', 'Target is not visible and enabled');
      if (action.type === 'drag') await locator(action.to, { timeoutMs });
      if (action.type === 'upload' && !(Array.isArray(action.value) ? action.value : [action.value]).every((file) => typeof file === 'string' && path.isAbsolute(file))) throw fastError('INVALID_TARGET', 'Upload requires explicitly authorized absolute file paths');
    },
    async act(action, timeoutMs = 5000, expectedScene) {
      active();
      const binding = { page, epoch };
      const deadlineAt = expectedScene?.deadlineAt;
      if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) throw fastError('INVALID_COMMAND', 'Action deadline must be a finite monotonic timestamp');
      const checkDeadline = () => {
        if (deadlineAt === undefined) return;
        const remaining = deadlineAt - performance.now();
        if (remaining <= 0) throw fastError('CONDITION_TIMEOUT', 'Action group deadline expired before native dispatch');
        timeoutMs = timeoutMs > 0 ? Math.min(timeoutMs, remaining) : remaining;
      };
      checkDeadline();
      if (expectedScene !== undefined) {
        const expectedPageId = expectedScene?.pageId, expectedVersion = expectedScene?.pageVersion;
        if (typeof expectedPageId !== 'string' || typeof expectedVersion !== 'string') throw fastError('INVALID_COMMAND', 'Expected action scene needs pageId and pageVersion');
        const current = await meta();
        if (page !== binding.page || epoch !== binding.epoch || current.pageId !== expectedPageId
          || !sameDocument(current.pageVersion, expectedVersion) || current.pageVersion.split(':')[0] !== expectedVersion.split(':')[0]) {
          throw fastError('STALE_OBSERVATION', 'Page, document or control ownership changed after the action was approved');
        }
        checkDeadline();
      }
      const native = perform => nativeAction(action, () => { checkDeadline(); return perform(); }, binding);
      let result;
      if (action.type === 'navigate') {
        await cursor.navigation(page);
        const url = new URL(action.value);
        if (!['http:', 'https:'].includes(url.protocol)) throw fastError('INVALID_TARGET', 'Navigation requires HTTP(S)');
        await native(() => page.goto(url.href, { timeout: timeoutMs, waitUntil: 'domcontentloaded' }));
      } else if (['back', 'forward', 'reload'].includes(action.type)) {
        await cursor.navigation(page);
        await native(() => page[action.type === 'back' ? 'goBack' : action.type === 'forward' ? 'goForward' : 'reload']({ timeout: timeoutMs, waitUntil: 'domcontentloaded' }));
      } else if (action.type === 'new-tab') {
        if (action.value && !['http:', 'https:'].includes(new URL(action.value).protocol)) throw fastError('INVALID_TARGET', 'New-tab navigation requires HTTP(S)');
        const next = await context.newPage();
        try {
          active();
          if (page !== binding.page || epoch !== binding.epoch) throw fastError('STALE_OBSERVATION', 'Page or control ownership changed while opening a tab');
        } catch (error) {
          await next.close().catch(() => {});
          throw error;
        }
        page = next; binding.page = next; refs.clear(); baselines.clear(); attach(page); await cursor.select(page);
        if (action.value) await native(() => page.goto(action.value, { timeout: timeoutMs, waitUntil: 'domcontentloaded' }));
        result = { pageId: id(page), url: page.url() };
      } else if (action.type === 'close-tab') {
        intentionallyClosed.add(page); await native(() => page.close());
        page = context.pages().find((value) => !value.isClosed()) || await context.newPage(); refs.clear(); baselines.clear(); attach(page); await cursor.select(page);
        result = { pageId: id(page), url: page.url() };
      } else if ((action.type === 'key' || action.type === 'type') && !action.target) {
        if (action.type === 'key') await native(() => page.keyboard.press(String(action.value)));
        else await native(() => page.keyboard.type(String(action.value)));
      } else if (action.type === 'scroll' && !action.target) {
        const delta = action.value || {};
        if (![delta.x || 0, delta.y || 0].every((n) => Number.isFinite(n) && Math.abs(n) <= 10000)) throw fastError('INVALID_TARGET', 'Scroll is bounded to 10000 pixels');
        await cursor.point(page, null, { anchor: true });
        await native(() => page.mouse.wheel(delta.x || 0, delta.y || 0));
      } else if (action.target?.x !== undefined) {
        const { x, y } = action.target;
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        if (![x, y].every(Number.isFinite) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) throw fastError('INVALID_TARGET', 'Coordinates must be inside the current viewport');
        await cursor.point(page, { boundingBox: async () => ({ x, y, width: 1, height: 1 }) }, { click: action.type === 'click' });
        if (action.type === 'click') await native(() => page.mouse.click(x, y, { button: action.button || 'left', clickCount: action.clickCount || 1 }));
        else if (action.type === 'hover') await native(() => page.mouse.move(x, y));
        else throw fastError('INVALID_TARGET', 'Coordinate targets support click and hover; other actions require a DOM target');
      } else {
        const value = await locator(action.target);
        if (action.type !== 'upload' && !await value.isVisible() || !await value.isEnabled()) throw fastError('TARGET_NOT_ACTIONABLE', 'Target is not visible and enabled');
        // Native locator actions already scroll and perform their own actionability
        // waits. A preparatory scroll duplicates stable-frame waits, even for fill.
        await cursor.point(page, value, { click: action.type === 'click' });
        if (action.type === 'click') await native(() => value.click({ timeout: timeoutMs, button: action.button || 'left', clickCount: action.clickCount || 1, modifiers: action.modifiers }));
        else if (action.type === 'hover') await native(() => value.hover({ timeout: timeoutMs }));
        else if (action.type === 'fill') await native(() => value.fill(String(action.value), { timeout: timeoutMs }));
        else if (action.type === 'type') await native(() => value.pressSequentially(String(action.value), { timeout: timeoutMs }));
        else if (action.type === 'select') await native(() => value.selectOption(action.value, { timeout: timeoutMs }));
        else if (action.type === 'key') await native(() => value.press(String(action.value), { timeout: timeoutMs }));
        else if (action.type === 'drag') { const destination = await locator(action.to, { timeoutMs }); await native(() => value.dragTo(destination, { timeout: timeoutMs })); }
        else if (action.type === 'upload') { await native(() => value.setInputFiles(action.value, { timeout: timeoutMs })); result = { uploadedFiles: Array.isArray(action.value) ? action.value.length : 1 }; }
        else if (action.type === 'download') {
          if (!outputDir) throw fastError('OUTPUT_DIRECTORY_REQUIRED', 'Download requires the task output directory');
          const waiting = page.waitForEvent('download', { timeout: timeoutMs });
          waiting.catch(() => {});
          await native(() => value.click({ timeout: timeoutMs }));
          const download = await waiting;
          const fileName = `download-${randomUUID()}-${path.basename(download.suggestedFilename()).replace(/[^A-Za-z0-9._-]/gu, '_').slice(-120) || 'file'}`;
          await download.saveAs(path.join(outputDir, fileName));
          if (await download.failure()) throw fastError('DOWNLOAD_FAILED', 'Browser download did not complete');
          result = { evidenceRef: fileName, suggestedFilename: download.suggestedFilename() };
        }
        else if (action.type === 'scroll') await native(() => value.scrollIntoViewIfNeeded({ timeout: timeoutMs }));
        else throw fastError('INVALID_ACTION', 'Unsupported action type');
      }
      epoch += 1;
      // Same-document references remain bound to their original node, allowing
      // exact post-action readback. Navigation/control/tab changes invalidate
      // them separately; replacement nodes never inherit a reference.
      return result;
    },
    tabs() { return context.pages().filter((value) => !value.isClosed()).map((value) => ({ pageId: id(value), url: redactSensitiveText(value.url()), selected: value === page })); },
    async inspectTabs() { return Promise.all(context.pages().filter((value) => !value.isClosed()).map(async (value) => ({ pageId: id(value), title: redactSensitiveText(await value.title().catch(() => '')), url: redactSensitiveText(value.url()), selected: value === page }))); },
    metrics() { return { pages: context.pages().filter((value) => !value.isClosed()).length, attachedPages: attached.size, targetReferences: refs.size, observationBaselines: baselines.size, cursor: { enabled: cursor.enabled, paused: cursor.paused, position: cursor.position }, selectedPageListeners: Object.fromEntries(['framenavigated', 'dialog', 'close'].map((event) => [event, page.listenerCount?.(event) ?? null])) }; },
    async selectTab(selection) {
      let pageId = typeof selection === 'string' ? selection : selection?.pageId;
      if (!pageId && selection && ['url', 'title', 'urlIncludes', 'titleIncludes'].some((key) => typeof selection[key] === 'string' && selection[key])) {
        const rows = await Promise.all(context.pages().filter((value) => !value.isClosed()).map(async (value) => ({ pageId: id(value), url: value.url(), title: await value.title().catch(() => '') })));
        const matches = rows.filter((row) => (!selection.url || row.url === selection.url) && (!selection.title || row.title === selection.title) && (!selection.urlIncludes || row.url.includes(selection.urlIncludes)) && (!selection.titleIncludes || row.title.includes(selection.titleIncludes)));
        if (matches.length !== 1) throw fastError(matches.length ? 'AMBIGUOUS_TARGET' : 'TARGET_NOT_FOUND', 'Tab selection must identify exactly one page', { matches: matches.length });
        pageId = matches[0].pageId;
      }
      const next = context.pages().find((value) => id(value) === pageId && !value.isClosed());
      if (!next) throw fastError('TARGET_NOT_FOUND', 'Selected tab does not exist');
      await next.bringToFront();
      await cursor.select(next); page = next; attach(page); epoch += 1; refs.clear(); baselines.clear();
      return meta();
    },
    async dispose() {
      disposed = true;
      stageRecorder = null;
      await cursor.dispose();
      for (const [value, handlers] of attached) {
        value.off?.('framenavigated', handlers.navigation); value.off?.('dialog', handlers.dialog); value.off?.('close', handlers.close);
        if (!value.isClosed?.()) await value.evaluate((storageKey) => { window[storageKey]?.observer?.disconnect(); delete window[storageKey]; }, key).catch(() => {});
      }
      attached.clear(); refs.clear(); baselines.clear();
    }
  };
}
