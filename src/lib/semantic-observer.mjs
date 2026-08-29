import { randomUUID } from 'node:crypto';
import { redactSensitiveText } from './redaction.mjs';

const DEFAULT_MAX_NODES = 180;
const DEFAULT_MAX_TEXT_CHARS = 12_000;
const MAX_FRAMES = 16;

export class SemanticObserverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SemanticObserverError';
    this.code = code;
  }
}

function boundedInteger(value, fallback, minimum, maximum, field) {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new SemanticObserverError('INVALID_SEMANTIC_OPTIONS', `${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized;
}

function safeText(value, maximum = 500) {
  return redactSensitiveText(String(value || '').replace(/\s+/gu, ' ').trim()).slice(0, maximum);
}

function safePageUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'about:', 'data:'].includes(url.protocol)) return '';
    if (url.protocol === 'data:') return 'data:';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2_048);
  } catch {
    return '';
  }
}

function semanticLocator(descriptor) {
  const quoted = JSON.stringify(safeText(descriptor.name, 160));
  if (descriptor.testId) return `testid:${safeText(descriptor.testId, 160)}`;
  if (descriptor.label) return `label:${safeText(descriptor.label, 160)}`;
  if (descriptor.placeholder) return `placeholder:${safeText(descriptor.placeholder, 160)}`;
  if (descriptor.role && descriptor.name) return `role:${descriptor.role}[name=${quoted}]`;
  if (descriptor.href) {
    try {
      const url = new URL(descriptor.href, descriptor.frameUrl);
      return `href:${url.pathname}${url.search ? '?…' : ''}`.slice(0, 240);
    } catch {}
  }
  return `css:${safeText(descriptor.selector, 220)}`;
}

async function inspectFrame(frame, { scope, maxNodes, maxTextChars }) {
  return frame.evaluate(({ requestedScope, requestedNodes, requestedText }) => {
    const compact = (value, maximum = 500) => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, maximum);
    const visible = (element) => {
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      if (requestedScope === 'viewport') {
        return box.bottom >= 0 && box.right >= 0 && box.top <= innerHeight && box.left <= innerWidth;
      }
      return true;
    };
    const roleOf = (element) => {
      const explicit = element.getAttribute('role');
      if (explicit) return compact(explicit.split(/\s+/u)[0], 40).toLowerCase();
      const tag = element.tagName.toLowerCase();
      if (tag === 'a' && element.hasAttribute('href')) return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'input') {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        if (['button', 'submit', 'reset'].includes(type)) return 'button';
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        return 'textbox';
      }
      if (/^h[1-6]$/u.test(tag)) return 'heading';
      return tag;
    };
    const labelOf = (element) => {
      if (element.labels?.length) return compact([...element.labels].map((label) => label.innerText || label.textContent).join(' '), 300);
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        return compact(labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent || '').join(' '), 300);
      }
      return '';
    };
    const nameOf = (element) => {
      const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
      const buttonValue = element.tagName === 'INPUT' &&
        ['button', 'submit', 'reset'].includes((element.getAttribute('type') || 'text').toLowerCase())
        ? element.value
        : '';
      return compact(
        element.getAttribute('aria-label') || labelOf(element) || element.getAttribute('alt') ||
        element.getAttribute('title') || element.getAttribute('placeholder') || buttonValue ||
        (editable ? '' : element.innerText || element.textContent),
        300
      );
    };
    const escapeCss = (value) => globalThis.CSS?.escape
      ? globalThis.CSS.escape(value)
      : String(value).replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character.codePointAt(0).toString(16)} `);
    const selectorOf = (element) => {
      if (element.id && document.querySelectorAll(`#${escapeCss(element.id)}`).length === 1) {
        return `#${escapeCss(element.id)}`;
      }
      const parts = [];
      let current = element;
      while (current?.nodeType === Node.ELEMENT_NODE && current !== document.documentElement && parts.length < 8) {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? [...current.parentElement.children].filter((candidate) => candidate.tagName === current.tagName)
          : [];
        const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : '';
        parts.unshift(`${tag}${suffix}`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };

    const candidates = [...document.querySelectorAll([
      'a[href]', 'button', 'input', 'select', 'textarea', '[role]', '[contenteditable="true"]', '[tabindex]'
    ].join(','))].filter(visible).slice(0, requestedNodes);
    const nodes = candidates.map((element) => ({
      role: roleOf(element),
      name: nameOf(element),
      label: labelOf(element),
      placeholder: compact(element.getAttribute('placeholder'), 300),
      testId: compact(element.getAttribute('data-testid'), 300),
      href: element instanceof HTMLAnchorElement ? element.href : '',
      selector: selectorOf(element),
      disabled: Boolean(element.disabled) || element.getAttribute('aria-disabled') === 'true'
    }));

    const seen = new Set();
    const blocks = [];
    let characters = 0;
    for (const element of document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,article,[role="heading"],[role="alert"]')) {
      if (!visible(element)) continue;
      const text = compact(element.innerText || element.textContent, 1_000);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const remaining = requestedText - characters;
      if (remaining <= 0) break;
      blocks.push(text.slice(0, remaining));
      characters += Math.min(text.length, remaining);
    }
    return {
      title: compact(document.title, 500),
      url: location.href,
      nodes,
      blocks,
      truncated: candidates.length >= requestedNodes || characters >= requestedText
    };
  }, { requestedScope: scope, requestedNodes: maxNodes, requestedText: maxTextChars });
}

export function createSemanticObserver({ page, action, locatorTransform = (locator) => locator } = {}) {
  if (!page) throw new TypeError('page is required');
  let current = null;

  async function snapshot(options = {}) {
    const scope = options.scope === undefined ? 'viewport' : options.scope;
    if (!['viewport', 'full_page'].includes(scope)) {
      throw new SemanticObserverError('INVALID_SEMANTIC_OPTIONS', 'scope must be viewport or full_page');
    }
    const maxNodes = boundedInteger(options.maxNodes, DEFAULT_MAX_NODES, 1, 500, 'maxNodes');
    const maxTextChars = boundedInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS, 0, 50_000, 'maxTextChars');
    const refs = new Map();
    const publicRefs = [];
    const lines = [];
    let truncated = false;
    let frameErrors = 0;
    let remainingNodes = maxNodes;
    let remainingTextChars = maxTextChars;
    const allFrames = page.frames();
    const frames = allFrames.slice(0, MAX_FRAMES);
    let framesInspected = 0;
    let truncatedFrames = 0;
    for (const [frameIndex, frame] of frames.entries()) {
      if (remainingNodes <= 0 && remainingTextChars <= 0) {
        truncated = true;
        break;
      }
      let inspected;
      try {
        const remainingFrames = frames.length - frameIndex;
        inspected = await inspectFrame(frame, {
          scope,
          maxNodes: remainingNodes > 0 ? Math.max(1, Math.floor(remainingNodes / remainingFrames)) : 0,
          maxTextChars: remainingTextChars > 0 ? Math.max(1, Math.floor(remainingTextChars / remainingFrames)) : 0
        });
      } catch {
        frameErrors += 1;
        continue;
      }
      framesInspected += 1;
      if (inspected.truncated) truncatedFrames += 1;
      remainingNodes = Math.max(0, remainingNodes - inspected.nodes.length);
      remainingTextChars = Math.max(
        0,
        remainingTextChars - inspected.blocks.reduce((total, block) => total + block.length, 0)
      );
      truncated ||= Boolean(inspected.truncated);
      if (frames.length > 1) lines.push(`frame ${frameIndex}: ${safePageUrl(inspected.url) || '[unavailable]'}`);
      for (const descriptor of inspected.nodes) {
        const ref = `@${publicRefs.length + 1}`;
        const normalized = {
          ...descriptor,
          frame,
          frameIndex,
          frameUrl: inspected.url,
          name: safeText(descriptor.name, 300),
          role: safeText(descriptor.role, 40),
          selector: descriptor.selector
        };
        refs.set(ref, normalized);
        const item = {
          ref,
          role: normalized.role,
          name: normalized.name,
          locator: semanticLocator(normalized),
          disabled: normalized.disabled === true,
          frame: frameIndex
        };
        if (normalized.href) item.href = safePageUrl(normalized.href);
        publicRefs.push(item);
        lines.push(`${ref} ${normalized.role || 'element'} ${JSON.stringify(normalized.name)} [${item.locator}]${item.disabled ? ' disabled' : ''}`);
      }
      if (inspected.blocks.length) {
        lines.push('text:');
        for (const block of inspected.blocks) lines.push(`- ${safeText(block, 1_000)}`);
      }
    }
    const id = `snapshot_${randomUUID().replaceAll('-', '')}`;
    const content = lines.join('\n').slice(0, maxTextChars + maxNodes * 500);
    current = { id, pageUrl: page.url(), refs };
    return Object.freeze({
      id,
      url: safePageUrl(page.url()),
      title: safeText(await page.title().catch(() => ''), 500),
      content,
      refs: publicRefs,
      truncated,
      frameErrors,
      framesTotal: allFrames.length,
      framesInspected,
      truncatedFrames,
      framesOmitted: Math.max(0, allFrames.length - frames.length)
    });
  }

  function descriptor(ref, snapshotId) {
    if (!current || (snapshotId && snapshotId !== current.id)) {
      throw new SemanticObserverError('SEMANTIC_SNAPSHOT_STALE', 'Take a fresh semantic snapshot before using this ref');
    }
    if (page.url() !== current.pageUrl) {
      throw new SemanticObserverError('SEMANTIC_SNAPSHOT_STALE', 'Page navigation invalidated the semantic refs');
    }
    const normalizedRef = typeof ref === 'number' ? `@${ref}` : String(ref || '');
    const found = current.refs.get(normalizedRef);
    if (!found) throw new SemanticObserverError('SEMANTIC_REF_NOT_FOUND', `Semantic ref ${normalizedRef} was not found`);
    return found;
  }

  async function resolveRaw(ref, { snapshotId } = {}) {
    const found = descriptor(ref, snapshotId);
    const frame = found.frame;
    const candidates = [];
    if (found.testId) candidates.push(frame.getByTestId(found.testId));
    if (found.label) candidates.push(frame.getByLabel(found.label, { exact: true }));
    if (found.placeholder) candidates.push(frame.getByPlaceholder(found.placeholder, { exact: true }));
    if (found.role && found.name) {
      try {
        candidates.push(frame.getByRole(found.role, { name: found.name, exact: true }));
      } catch {}
    }
    if (found.selector) candidates.push(frame.locator(found.selector));
    for (const locator of candidates) {
      if (await locator.count().catch(() => 0) === 1) return locator;
    }
    throw new SemanticObserverError('SEMANTIC_REF_UNSTABLE', 'Semantic ref no longer resolves to exactly one element');
  }

  async function resolve(ref, options = {}) {
    return locatorTransform(await resolveRaw(ref, options));
  }

  async function href(ref, options = {}) {
    const locator = await resolveRaw(ref, options);
    const value = await locator.evaluate((element) => element.href || element.getAttribute('href'));
    if (!value) throw new SemanticObserverError('SEMANTIC_REF_HAS_NO_HREF', 'Semantic ref is not a navigable link');
    const absolute = new URL(value, page.url());
    if (!['http:', 'https:'].includes(absolute.protocol)) {
      throw new SemanticObserverError('SEMANTIC_REF_HAS_NO_HREF', 'Semantic ref does not target HTTP(S)');
    }
    return absolute.href;
  }

  return Object.freeze({
    snapshot,
    resolve,
    href,
    async click(ref, options = {}) {
      if (!action) throw new SemanticObserverError('SEMANTIC_ACTION_UNAVAILABLE', 'Semantic action helper is unavailable');
      return action.click(await resolveRaw(ref, options), options.actionOptions || {});
    },
    async fill(ref, value, options = {}) {
      if (!action) throw new SemanticObserverError('SEMANTIC_ACTION_UNAVAILABLE', 'Semantic action helper is unavailable');
      return action.fill(await resolveRaw(ref, options), value, options.actionOptions || {});
    },
    async navigate(ref, options = {}) {
      if (!action) throw new SemanticObserverError('SEMANTIC_ACTION_UNAVAILABLE', 'Semantic action helper is unavailable');
      if (typeof action.navigate === 'function') {
        return action.navigate(await resolveRaw(ref, options), options.navigationOptions || {});
      }
      return action.goto(await href(ref, options), options.navigationOptions || { waitUntil: 'domcontentloaded' });
    }
  });
}
