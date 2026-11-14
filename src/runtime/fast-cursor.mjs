import { randomUUID } from 'node:crypto';

export function cursorPoint(box, viewport) {
  if (!box || !viewport || ![box.x, box.y, box.width, box.height, viewport.width, viewport.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;
  const left = Math.max(0, box.x), right = Math.min(viewport.width, box.x + box.width);
  const top = Math.max(0, box.y), bottom = Math.min(viewport.height, box.y + box.height);
  return right > left && bottom > top ? { x: (left + right) / 2, y: (top + bottom) / 2 } : null;
}

// Decorative only: no Playwright mouse/focus APIs, input handlers or OS cursor.
export function createFastCursor({ enabled = false } = {}) {
  const key = `__etm_cursor_${randomUUID().replaceAll('-', '')}`;
  const touched = new Set();
  let preference = Boolean(enabled), paused = false, disposed = false, generation = 0;
  let selected = null;
  let lastPosition = null;
  const available = () => preference && !paused && !disposed;
  const evaluate = async (page, payload) => {
    if (!page || page.isClosed?.()) return null;
    touched.add(page);
    return page.evaluate(({ key: storageKey, action, point, click, visible }) => {
      let state = window[storageKey];
      if (!state) { state = { host: null, ownedHosts: new WeakSet(), hiddenDepth: 0, wantedVisible: false, animation: null }; window[storageKey] = state; }
      if (action === 'remove') { state.animation?.cancel(); state.animation = null; state.host?.remove(); state.host = null; state.wantedVisible = false; return { removed: true }; }
      if (action === 'capture-hide') { const wasVisible = Boolean(state.host && state.wantedVisible); state.hiddenDepth += 1; if (state.host) state.host.style.setProperty('visibility', 'hidden', 'important'); return { wasVisible }; }
      if (action === 'capture-restore') { state.hiddenDepth = Math.max(0, state.hiddenDepth - 1); if (state.host) state.host.style.setProperty('visibility', visible && state.wantedVisible && !state.hiddenDepth ? 'visible' : 'hidden', 'important'); return null; }
      if (action === 'hide') { state.wantedVisible = false; if (state.host) state.host.style.setProperty('visibility', 'hidden', 'important'); return null; }
      if (action !== 'point') return null;
      if (!state.host?.isConnected) {
        const host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'all:initial!important;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;user-select:none!important;';
        const shadow = host.attachShadow({ mode: 'closed' });
        shadow.innerHTML = '<style>:host{pointer-events:none}svg{position:fixed;left:0;top:0;width:22px;height:28px;overflow:visible;pointer-events:none;transition:transform 70ms linear;filter:drop-shadow(0 1px 2px #0005)}.ripple{position:fixed;left:-12px;top:-12px;width:24px;height:24px;border:2px solid #ff7a20;border-radius:50%;opacity:0;pointer-events:none;box-sizing:border-box}</style><div class="ripple"></div><svg viewBox="0 0 22 28"><path d="M2 1 L2 23 L8 17 L13 27 L17 25 L12 15 L21 15 Z" fill="#ff7a20" stroke="white" stroke-width="1.8"/></svg>';
        state.host = host; state.ownedHosts.add(host); state.pointer = shadow.querySelector('svg'); state.ripple = shadow.querySelector('.ripple');
        document.documentElement.append(host);
      }
      state.wantedVisible = true; state.host.style.setProperty('visibility', state.hiddenDepth ? 'hidden' : 'visible', 'important');
      state.pointer.style.transform = `translate(${point.x}px,${point.y}px)`;
      state.animation?.cancel(); state.animation = null;
      if (click) { state.ripple.style.transform = `translate(${point.x}px,${point.y}px)`; state.animation = state.ripple.animate([{ opacity: 0.9, scale: '0.5' }, { opacity: 0, scale: '1.7' }], { duration: 160, fill: 'none' }); }
      return { x: point.x, y: point.y, rendered: true };
    }, { key, ...payload });
  };
  const hide = (page = selected) => evaluate(page, { action: 'hide' }).catch(() => {});
  const remove = (page) => evaluate(page, { action: 'remove' }).catch(() => {});
  return {
    key,
    get enabled() { return preference; },
    get paused() { return paused; },
    get position() { return lastPosition; },
    async select(page) { generation += 1; if (selected && selected !== page) await remove(selected); selected = page; lastPosition = null; },
    async setEnabled(value) { preference = Boolean(value); generation += 1; if (!preference) await Promise.all([...touched].map((page) => evaluate(page, { action: 'remove' }))); },
    async setPaused(value) { paused = Boolean(value); generation += 1; if (paused) await remove(selected); },
    async navigation(page) { if (page === selected) { generation += 1; lastPosition = null; await remove(page); } },
    async point(page, locator, { click = false, anchor = false } = {}) {
      if (!available()) return { supported: false, reason: 'disabled-or-paused' };
      try {
        if (selected !== page) await this.select(page);
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const box = anchor ? { x: viewport.width / 2 - 1, y: viewport.height / 2 - 1, width: 2, height: 2 } : await locator.boundingBox();
        const point = cursorPoint(box, viewport);
        if (!point) { await hide(page); lastPosition = { supported: false, reason: 'no-reliable-visible-box' }; return lastPosition; }
        const atGeneration = generation;
        const result = await evaluate(page, { action: 'point', point, click });
        if (!available() || atGeneration !== generation) { await remove(page); return { supported: false, reason: 'state-changed' }; }
        lastPosition = { supported: true, ...result, anchor: anchor ? 'viewport-center' : null };
        return lastPosition;
      } catch { await hide(page); lastPosition = { supported: false, reason: 'position-unavailable' }; return lastPosition; }
    },
    async without(page, capture) {
      const atGeneration = generation;
      await evaluate(page, { action: 'capture-hide' });
      try { return await capture(); }
      finally { await evaluate(page, { action: 'capture-restore', visible: available() && atGeneration === generation && selected === page }).catch(() => {}); }
    },
    async dispose() { disposed = true; generation += 1; await Promise.allSettled([...touched].map(remove)); touched.clear(); selected = null; lastPosition = null; }
  };
}
