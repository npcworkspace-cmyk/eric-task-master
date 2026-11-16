export const FAST_REFERENCE_ENGINE = 'etm_ref';
const registrations = new WeakMap();

// A native selector resolves the originally observed node on every Playwright
// actionability poll. No ordinal CSS path, DOM attribute or replacement match.
export function fastReferenceEngine() {
  const queryAll = (root, selector) => {
    let binding;
    try { binding = JSON.parse(selector); } catch { return []; }
    if (!binding || typeof binding.key !== 'string' || typeof binding.ref !== 'string') return [];
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const state = doc?.defaultView?.[binding.key];
    const node = state?.references?.get(binding.ref);
    if (!node?.isConnected || node.ownerDocument !== doc || state.ids.get(node) !== binding.ref ||
        !(root === doc || root === node || root.contains(node))) throw new Error('ETM_STALE_REFERENCE: Original target was detached or replaced');
    return [node];
  };
  return { query: (root, selector) => queryAll(root, selector)[0] || null, queryAll };
}

export async function registerFastReferenceSelector(playwright) {
  const selectors = playwright?.selectors;
  // Worker unit models may implement only Chromium launch. Real bundled
  // Playwright registers here before context/page creation; refs never fall
  // back to CSS if an unsupported adapter omits selector-engine support.
  if (!selectors?.register) return false;
  let registered = registrations.get(selectors);
  if (!registered) {
    registered = Promise.resolve().then(() => selectors.register(FAST_REFERENCE_ENGINE, fastReferenceEngine));
    registrations.set(selectors, registered);
    registered.catch(() => { registrations.delete(selectors); });
  }
  await registered;
  return true;
}
