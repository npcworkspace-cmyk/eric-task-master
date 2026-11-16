import { redactSensitiveValue, sliceRedactedText } from './redaction.mjs';

const PAGE_FIELDS = ['pageId', 'pageVersion', 'url', 'title'];
const NAMED_ROLES = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'option', 'heading', 'slider', 'spinbutton']);
const CHECKED_ROLES = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);
const ROLE_BY_TAG = { button: 'button', a: 'link', input: 'textbox', textarea: 'textbox', select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading', li: 'listitem', dialog: 'dialog' };
const STATE_FIELDS = ['disabled', 'checked', 'selected', 'expanded', 'pressed', 'required', 'invalid', 'readonly', 'editable', 'modal', 'multiline'];
const GENERIC_TAGS = new Set(['body', 'main', 'section', 'article', 'div', 'span', 'form', 'table', 'tbody', 'tr', 'td', 'ul', 'ol', 'p']);
const EMPTY_CONTAINER_TAGS = new Set(['body', 'main', 'section', 'article', 'div', 'form', 'table', 'tbody', 'tr', 'td', 'ul', 'ol']);

function routineCommand(reply) {
  if (typeof reply.commandId !== 'string' || reply.status !== 'confirmed' || typeof reply.pageId !== 'string' || typeof reply.pageVersion !== 'string') return false;
  if (reply.operationStatus && reply.operationStatus !== 'running') return false;
  if (reply.pending || reply.pauseReason || reply.unresolvedActionCount > 0 || reply.unresolvedActions?.length) return false;
  if (reply.result?.actions?.some(action => action?.status !== 'confirmed' && !(action?.status === undefined && action?.matched === true))) return false;
  return ![reply, reply.result, reply.observation, reply.result?.observation].some(value => value && typeof value === 'object'
    && (value.needsDecision || value.reason || value.error || value.code || value.warning || value.warnings?.length || value.automationPaused || value.humanOwned || value.revoked));
}

function compactSuccessReceipt(reply) {
  if (!routineCommand(reply)) return;
  for (const key of ['operationId', 'taskId']) delete reply[key];
  if (reply.operationStatus === 'running') delete reply.operationStatus;
  for (const key of ['evidenceRef', 'reason', 'pending', 'pauseReason']) if (reply[key] === null) delete reply[key];
  if (reply.needsDecision === false) delete reply.needsDecision;
  if (reply.unresolvedActionCount === 0) delete reply.unresolvedActionCount;
  if (Array.isArray(reply.unresolvedActions) && !reply.unresolvedActions.length) delete reply.unresolvedActions;
  const identity = reply.identityStatus;
  // Absence defaults to NOT website-account-verified, never to verified.
  if (identity?.scope === 'profile' && identity.websiteAccountVerified === false
    && Object.keys(identity).length === 2) delete reply.identityStatus;
  const result = reply.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return;
  if (typeof result.elapsedMs === 'number') delete result.elapsedMs;
  if (Array.isArray(result.actions)) {
    for (const action of result.actions) if (action?.matched === true && typeof action.elapsedMs === 'number') delete action.elapsedMs;
    const retained = result.actions.filter(action => action?.status !== 'confirmed' || Object.keys(action).some(key => !['actionId', 'status'].includes(key)));
    if (!retained.length) delete result.actions;
    else if (retained.length !== result.actions.length) { result.actionCount = result.actions.length; result.actions = retained; }
  }
  const verification = result.verification;
  if (verification && verification.matched === null && verification.businessResultVerified === false
    && Object.keys(verification).every(key => ['matched', 'businessResultVerified'].includes(key))) delete result.verification;
  if (!Object.keys(result).length) delete reply.result;
}

function insufficient(message, reply) {
  const compactReceipt = {};
  for (const key of ['id', 'operationId', 'taskId', 'commandId', 'status', 'operationStatus', 'pageId', 'pageVersion']) {
    if (typeof reply?.[key] === 'string') compactReceipt[key] = reply[key].slice(0, 256);
  }
  const unresolved = reply?.unresolvedActions ?? reply?.unresolved;
  if (Array.isArray(unresolved)) compactReceipt.unresolvedActionCount = unresolved.length;
  if (Number.isSafeInteger(reply?.unresolvedActionCount)) compactReceipt.unresolvedActionCount = reply.unresolvedActionCount;
  Object.assign(compactReceipt, { needsDecision: true, reason: 'OUTPUT_CONTEXT_INSUFFICIENT', fullReceiptRequired: true });
  return Object.assign(new Error(message), { code: 'CONTEXT_INSUFFICIENT', compactReceipt });
}
function integer(value, fallback, maximum, name, minimum = 1) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw Object.assign(new Error(`${name} must be an integer from ${minimum} to ${maximum}`), { code: 'INVALID_COMMAND' });
  return result;
}

function compactItem(item, page) {
  const result = {};
  const privateItem = item.private === true || item.sensitive === true || item.dataPrivate === true || Object.hasOwn(item, 'data-private');
  const role = item.role || ROLE_BY_TAG[item.tag];
  if (item.ref) result.ref = item.ref;
  // Peer-page scenes can deliberately have no executable ref. In that case the
  // selector is still necessary; never remove the only available target path.
  else if (item.selector) result.selector = item.selector;
  if (role) result.role = role;
  else if (item.tag && (!GENERIC_TAGS.has(item.tag) || !item.ref && !item.selector)) result.tag = item.tag;
  if (item.domId && !item.ref && !item.selector) result.domId = item.domId;
  const name = item.name ?? (NAMED_ROLES.has(role) ? item.text : undefined);
  if (name !== undefined && name !== null && name !== '') result.name = privateItem ? '[REDACTED]' : name;
  if (Object.hasOwn(item, 'value')) result.value = privateItem ? '[REDACTED]' : item.value;
  for (const field of ['name', 'value']) {
    const range = item[`${field}Range`];
    if (range && (range.start > 0 || range.end < range.total)) result[`${field}Range`] = { ...range };
    if (item[`${field}Continuation`]) {
      const original = item[`${field}Continuation`];
      const { scope, ref, ...rest } = original;
      result[`${field}Continuation`] = { ...(item.ref ? { ref: item.ref } : { scope: scope || item.selector }), ...rest };
    }
  }
  if (item.nameExact === false) result.nameExact = false;
  for (const field of ['name', 'value']) if (typeof result[field] === 'string' && result[field].length > 512 && (item.ref || item.selector)
    && !(item[`${field}Range`] && item[`${field}Range`].end < item[`${field}Range`].total)) {
    const full = result[field];
    const preview = sliceRedactedText(full, 0, 512);
    if (preview.length < full.length) {
      const start = item[`${field}Range`]?.start || 0;
      result[field] = preview;
      result[`${field}Range`] = { start, end: start + preview.length, total: item[`${field}Range`]?.total ?? full.length };
      result[`${field}Continuation`] = { ...(item.ref ? { ref: item.ref } : { scope: item.selector }), detail: 'full', fields: [field], [`${field}Offset`]: start + preview.length,
        [`max${field[0].toUpperCase()}${field.slice(1)}Chars`]: 512, maxItems: 1,
        ...(page.pageId ? { textPageId: page.pageId } : {}), ...(page.pageVersion ? { textPageVersion: page.pageVersion } : {}) };
      if (field === 'name') result.nameExact = false;
    }
  }
  for (const key of STATE_FIELDS) {
    if (!Object.hasOwn(item, key) || item[key] === null || item[key] === undefined) continue;
    if (item[key] === false && !['expanded', 'pressed', 'selected'].includes(key) && !(key === 'checked' && CHECKED_ROLES.has(role))) continue;
    result[key] = item[key];
  }
  for (const key of ['href', 'level', 'warning', 'error', 'description']) if (item[key] !== undefined && item[key] !== null) result[key] = item[key];
  if (typeof item.text === 'string' && item.text !== '' && (item.text !== name || item.textRange && (item.textRange.start > 0 || item.textRange.end < item.textRange.total))) {
    result.text = privateItem ? '[REDACTED]' : item.text;
  }
  if (typeof result.text === 'string' && item.textRange && (item.textRange.start > 0 || item.textRange.end < item.textRange.total || item.textRange.total !== result.text.length)) result.textRange = { ...item.textRange };
  if (item.textContinuation) result.textContinuation = continuation(item, result, page);
  if (result.text === result.value && typeof result.value === 'string' && !result.textRange && !result.textContinuation
    && !result.valueRange && !result.valueContinuation) delete result.text;
  return result;
}

function continuation(source, item, page) {
  const original = source.textContinuation || {};
  return {
    ...(source.ref ? { ref: source.ref } : { scope: original.scope || source.selector }),
    detail: 'full', fields: ['text'], textMode: original.textMode || source.textMode || 'full',
    textOffset: item.textRange?.end ?? original.textOffset ?? 0, maxItems: 1,
    ...(original.textPageId || page.pageId ? { textPageId: original.textPageId || page.pageId } : {}),
    ...(original.textPageVersion || page.pageVersion ? { textPageVersion: original.textPageVersion || page.pageVersion } : {})
  };
}

function sceneLike(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.items)
    && (typeof value.pageVersion === 'string' || typeof value.pageId === 'string' || Number.isSafeInteger(value.total) && value.omitted && value.items.every(item => item?.ref || item?.selector));
}

// Generic fallback for legacy full scenes. Only remove an ancestor aggregate
// when all of its text is already represented by included descendant text.
function deduplicate(items, originals) {
  const normalized = text => String(text || '').replace(/\s+/gu, '');
  for (let i = 0; i < items.length; i++) {
    const original = originals[i], item = items[i];
    if (!original.selector || !item.text || original.textRange?.start || original.textRange && original.textRange.end < original.textRange.total) continue;
    if (original.role || original.name || ['button', 'a', 'input', 'textarea', 'select'].includes(original.tag)) continue;
    const descendants = originals.map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.selector?.startsWith(`${original.selector} > `))
      .filter(({ candidate }, index, all) => !all.some(({ candidate: parent }, other) => other !== index && candidate.selector.startsWith(`${parent.selector} > `)));
    if (descendants.length && normalized(original.text) === normalized(descendants.map(({ candidate }) => candidate.text || candidate.name || '').join(''))) {
      delete item.text; delete item.textRange; delete item.textContinuation;
    }
  }
}

/** A presentation-only copy. Durable/internal replies must never use this as storage. */
export function compactOperationsReply(fullReply, options = {}) {
  const maxChars = integer(options.maxChars, 4000, 64000, 'maxChars', 512);
  const maxItems = integer(options.maxItems, 60, 200, 'maxItems');
  const safe = redactSensitiveValue(fullReply, { maxDepth: 64, maxItems: Number.MAX_SAFE_INTEGER });
  if (!safe || typeof safe !== 'object') {
    if ((JSON.stringify(safe)?.length || 0) > maxChars) throw insufficient('Reply value exceeds the compact budget; request explicit full detail', safe);
    return safe;
  }
  const scenes = [];
  const walk = (value, inherited = {}) => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(item => walk(item, inherited));
    const page = { ...inherited };
    for (const key of PAGE_FIELDS) if (value[key] !== undefined) page[key] = value[key];
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'items' && sceneLike(value)) continue;
      result[key] = walk(child, page);
    }
    if (sceneLike(value)) {
      const candidates = value.items.map(item => compactItem(item, page));
      deduplicate(candidates, value.items);
      result.items = [];
      scenes.push({ output: result, original: value, candidates, page, consumed: 0, redundant: 0 });
    }
    return result;
  };
  const result = walk(safe);
  const main = scenes.find(scene => scene.output === result.observation || scene.output === result.result?.observation || scene.output === result.result || scene.output === result);
  if (main && main.output !== result && !Array.isArray(result)) {
    for (const key of PAGE_FIELDS) {
      if (result[key] === undefined && main.output[key] !== undefined) result[key] = main.output[key];
      if (result[key] === main.output[key]) delete main.output[key];
    }
  }
  const receipts = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(receipts); return; }
    Object.values(value).forEach(receipts);
    compactSuccessReceipt(value);
  };
  receipts(result);
  const update = scene => {
    const { original, output, candidates, consumed, redundant } = scene;
    const extra = candidates.length - consumed;
    const before = original.omitted?.before ?? original.offset ?? 0;
    const originalAfter = original.omitted?.after ?? Math.max(0, (original.total ?? candidates.length) - (original.offset || 0) - candidates.length);
    const redundantCount = (original.omitted?.redundant || 0) + redundant;
    output.omitted = { ...(original.omitted || {}), before, after: originalAfter + extra,
      textCharacters: output.items.reduce((sum, item) => sum + (item.textRange ? Math.max(0, item.textRange.total - (item.textRange.end - item.textRange.start)) : 0), 0), ...(redundantCount ? { redundant: redundantCount } : {}) };
    output.continuation = extra ? { offset: original.delta ? 0 : (original.offset || 0) + consumed, detail: 'full' } : original.continuation || null;
    if (output.offset === 0) delete output.offset;
    if (!original.delta && !before && !output.omitted.after && original.total === output.items.length + redundantCount) delete output.total;
    else if (original.total !== undefined) output.total = original.total;
    for (const key of ['before', 'after', 'textCharacters', 'redundant']) if (output.omitted[key] === 0) delete output.omitted[key];
    if (!Object.keys(output.omitted).length) delete output.omitted;
    if (output.continuation === null) delete output.continuation;
  };
  for (const scene of scenes) update(scene);
  const length = () => JSON.stringify(result).length;
  if (length() > maxChars) throw insufficient('Reply safety/status envelope exceeds the compact budget; request explicit full detail', safe);
  for (const scene of scenes) {
    for (let i = 0; i < scene.candidates.length && scene.output.items.length < maxItems; i++) {
      const source = scene.original.items[i], candidate = scene.candidates[i];
      if (EMPTY_CONTAINER_TAGS.has(source.tag)
        && Object.keys(candidate).every(key => ['ref', 'selector', 'tag', 'domId'].includes(key))) {
        scene.consumed += 1; scene.redundant += 1; update(scene); continue;
      }
      const item = { ...candidate, ...(candidate.textRange ? { textRange: { ...candidate.textRange } } : {}) };
      scene.output.items.push(item); scene.consumed += 1; update(scene);
      if (length() <= maxChars) continue;
      if (typeof item.text === 'string' && item.text && (source.ref || source.selector)
        && !(source.textRange && source.textRange.end < source.textRange.total)) {
        const originalText = item.text;
        const start = item.textRange?.start || 0;
        const total = item.textRange?.total ?? originalText.length;
        let low = 0, high = originalText.length, best = -1;
        const setText = count => {
          item.text = sliceRedactedText(originalText, 0, count);
          item.textRange = { start, end: start + item.text.length, total };
          item.textContinuation = continuation(source, item, scene.page);
          update(scene);
        };
        while (low <= high) {
          const middle = Math.floor((low + high) / 2); setText(middle);
          if (length() <= maxChars) { best = middle; low = middle + 1; } else high = middle - 1;
        }
        if (best >= 1) { setText(best); continue; }
      }
      scene.output.items.pop(); scene.consumed -= 1; update(scene); break;
    }
    if (scene.candidates.length > scene.redundant && !scene.output.items.length && scenes.length === 1) throw insufficient('Compact budget cannot preserve one item and its continuation', safe);
  }
  if (length() > maxChars) throw insufficient('Reply safety/status envelope exceeds the compact budget', safe);
  return result;
}
