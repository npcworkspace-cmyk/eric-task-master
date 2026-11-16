import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFastBrowser, fastError, boundedInteger, delay, validateFastCondition } from './fast-browser.mjs';
import { redactSensitiveValue } from '../lib/redaction.mjs';
import { createSingleSendTransport, validateTransport } from './single-send-transport.mjs';
import { ACTION_TYPES, MAX_BATCH_ACTIONS, actionHasEffect, normalizeOperationsCommand, sameDocument } from '../lib/operations-actions.mjs';
import { scopeIncludes } from '../lib/operations-contracts.mjs';
import { createOperationsDiagnostics } from '../lib/operations-diagnostics.mjs';

const leases = new WeakMap();
const KINDS = new Set(['observe', 'batch', 'wait', 'screenshot', 'tabs', 'select-tab', 'reconcile', 'control']);

function list(value, name, maximum = 24) {
  if (!Array.isArray(value) || value.length > maximum) throw fastError('INVALID_COMMAND', `${name} must be an array of at most ${maximum} items`);
  return value;
}

// Internal reference paths must not consume the Agent's small wire budget and
// hide otherwise compact controls. Explicit caller budgets/full captures keep
// their existing meaning; multi-scene capture shares one bounded allowance.
function observationOptions(options = {}, maxChars, captureMaxChars = 24000) {
  return { ...(maxChars ? { maxChars } : {}),
    ...(options.detail !== 'full' && options.maxChars === undefined && options.captureMaxChars === undefined ? { captureMaxChars } : {}), ...options };
}

function waitCondition(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fastError('INVALID_CONDITION', 'Wait needs a structured condition');
  if (payload.condition !== undefined) return payload.condition;
  const { timeoutMs, pollMs, watch, watchId, once, deadline, eventType, summary, priority, health, cancelWatch, type, ...condition } = payload;
  return condition;
}

function validateWait(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fastError('INVALID_CONDITION', 'Wait needs a structured condition');
  if (payload.type === 'download') {
    if (payload.watch || payload.condition !== undefined || Object.keys(waitCondition(payload)).length) throw fastError('INVALID_CONDITION', 'Download waits cannot silently ignore a DOM condition or start a DOM watcher');
    return;
  }
  if (payload.type !== undefined) throw fastError('INVALID_CONDITION', 'Unsupported wait type');
  validateFastCondition(waitCondition(payload));
}

export function validateFastCommand(command) {
  command = normalizeOperationsCommand(command);
  if (!command || command.schemaVersion !== 1 || typeof command.commandId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/u.test(command.commandId) || !KINDS.has(command.kind)) {
    throw fastError('INVALID_COMMAND', 'Expected a versioned, uniquely identified bounded command');
  }
  if (Buffer.byteLength(JSON.stringify(command)) > 128 * 1024) throw fastError('COMMAND_TOO_LARGE', 'Command exceeds 128 KiB');
  if (command.kind === 'batch') {
    const payload = command.payload || {};
    list(payload.preconditions, 'preconditions').forEach(validateFastCondition);
    list(payload.stopConditions ?? [], 'stopConditions').forEach(validateFastCondition);
    const actions = list(payload.actions, 'actions', MAX_BATCH_ACTIONS);
    list(payload.verify, 'verify').forEach(validateFastCondition);
    if (!actions.length) throw fastError('INVALID_COMMAND', 'Batch needs at least one supported action');
    const seen = new Set();
    for (const action of actions) {
      if (!action || typeof action.actionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,160}$/u.test(action.actionId) || seen.has(action.actionId) || !ACTION_TYPES.includes(action.type)) throw fastError('INVALID_ACTION', 'Actions require unique identifiers and supported primitive types');
      seen.add(action.actionId);
      if (action.preconditions !== undefined) list(action.preconditions, 'action preconditions').forEach(validateFastCondition);
      for (const field of ['guard', 'expected']) if (action[field] !== undefined) validateFastCondition(action[field]);
      if (action.type === 'wait') validateWait(action.value);
    }
    boundedInteger(payload.timeoutMs, 20000, 60000, 'timeoutMs');
  }
  if (command.kind === 'wait' && !command.payload.health && !command.payload.cancelWatch) validateWait(command.payload);
  if (command.kind === 'reconcile') list(command.payload.verify ?? [], 'verify').forEach(validateFastCondition);
  return command;
}

function sameAcknowledgementScene(first, second) {
  if (first === second) return true;
  // The final component is ordinary DOM mutation revision. Keep both the
  // browser epoch (which changes on dialogs/actions) and document identity:
  // unrelated live counters must not make a cancelled dialog unacknowledgeable.
  const context = (version) => typeof version === 'string' && version.split(':').length >= 3 ? version.split(':').slice(0, -1).join(':') : null;
  const a = context(first), b = context(second);
  return Boolean(a && b && a === b);
}

const localReceiptTypes = new Set(['click', 'hover', 'fill', 'type', 'key', 'select', 'scroll', 'drag', 'navigate', 'back', 'forward', 'reload', 'new-tab', 'close-tab']);

export function createFastSession(runtime) {
  const { context, page, input = {}, signal, outputDir, durable: persist = async () => { throw fastError('DURABILITY_UNAVAILABLE', 'Manager persistence acknowledgement is required'); } } = runtime;
  const operationId = input.operationId;
  let mode = input.mode || 'operations';
  let cursorExplicit = typeof input.showCursor === 'boolean';
  let cursorEnabled = cursorExplicit ? input.showCursor : mode === 'operations';
  let humanOwned = Boolean(input.takeover);
  let freshObservation = false;
  let activeCommand = null;
  const durable = (type, payload) => activeCommand?.trace
    ? activeCommand.trace.measure(type === 'authorize' ? 'authority' : `durable:${type}`, () => persist(type, payload), { actionId: payload?.actionId })
    : persist(type, payload);
  let disposed = false;
  let terminal = false;
  let commandResultUnknown = null;
  let authority = input.authorization || {};
  let writeUnknown = Boolean(input.reconcileRequired);
  let lastReadCommand = null;
  let lastObservation = null;
  let startupNavigationAvailable = !humanOwned;
  const attempted = new Set(input.completedActionIds || []);
  const watches = new Map();
  const eventKeys = new Map();
  const pendingEvents = new Set();
  const abortController = new AbortController();
  const publish = async (event) => {
    if (disposed) return;
    const dedupeKey = event.dedupeKey || `${event.type}:${operationId}`;
    const old = eventKeys.get(dedupeKey);
    if (old && Date.now() - old < 1000 && event.priority !== 'high') return;
    eventKeys.set(dedupeKey, Date.now());
    while (eventKeys.size > 128) eventKeys.delete(eventKeys.keys().next().value);
    const promise = durable('event', { operationId, ...event, dedupeKey });
    pendingEvents.add(promise);
    try { await promise; } finally { pendingEvents.delete(promise); }
  };
  const browser = runtime.browserAdapter || createFastBrowser({ page, context, signal, outputDir, showCursor: cursorEnabled, onEvent: publish });
  let transport = null;
  const transportReady = input.singleSendTransport === true ? Promise.resolve().then(async () => {
    if (!runtime.singleSendPolicyReady || input.browserSelection?.kind !== 'profile') throw fastError('TRANSPORT_CONTEXT_UNSUPPORTED', 'Single-send transport requires the explicitly selected owned context with service workers blocked');
    transport = await createSingleSendTransport({ context, signal, onBlocked: publish, authorizeForward: async (binding, metadata) => {
      check();
      if (activeCommand?.command.commandId !== binding.commandId || humanOwned) throw fastError('TRANSPORT_STOPPED', 'Original action no longer owns the page');
      const scope = await protectedScope(binding.command);
      const ack = await durable('transport-forward', { operationId, commandId: binding.commandId, actionId: binding.actionId, authorizationVersion: binding.command.authorizationVersion,
        ...scope.identity, origin: new URL(scope.state.url).origin, pageId: scope.state.pageId, pageVersion: scope.state.pageVersion, ...metadata });
      check();
      if (!ack?.acknowledged || humanOwned) throw fastError('TRANSPORT_STOPPED', 'Current forwarding authorization was not confirmed');
    } });
  }) : Promise.resolve();
  transportReady.catch(() => {});
  const abort = () => { terminal = true; activeCommand?.controller.abort(signal?.reason || fastError('TASK_STOPPED', 'Stopped')); abortController.abort(); transport?.pause(true); void browser.pauseCursor?.(true); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const check = () => {
    if (signal?.aborted || terminal || disposed) throw signal?.reason || fastError('TASK_STOPPED', 'Session stopped');
    if (activeCommand?.controller.signal.aborted) throw activeCommand.controller.signal.reason || fastError('TASK_STOPPED', 'Command stopped');
  };
  const conditions = async (values, expected, ensure = check) => {
    ensure();
    for (const condition of values) {
      ensure();
      const matched = await browser.condition(condition);
      ensure();
      if (matched !== expected) return false;
    }
    return true;
  };
  const assertPage = async (command, { version = false } = {}) => {
    check();
    const state = await browser.meta();
    if (command.pageId && command.pageId !== state.pageId) throw fastError('STALE_OBSERVATION', 'Selected page identity changed');
    const observedVersion = command.pageVersion || lastObservation?.pageVersion;
    if (version && (!sameDocument(observedVersion, state.pageVersion) || !command.pageId && lastObservation?.pageId !== state.pageId)) throw fastError('STALE_OBSERVATION', 'Selected document changed; observe the current page before acting');
    if (browser.unsafe) throw fastError(browser.unsafe, 'Unexpected page state; inspect and reconcile before continuing');
    return state;
  };
  const refreshAuthority = async (command, details = {}) => {
    check();
    const approval = await durable('authorize', { operationId, commandId: command.commandId, authorizationVersion: command.authorizationVersion, kind: command.kind === 'batch' ? 'observe' : command.kind, effect: false, ...details });
    authority = approval.authorization || approval;
    if (authority.revokedAt || (authority.scope !== 'profile' || authority.expiresAt != null) && (!Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= Date.now())) throw fastError('AUTHORIZATION_EXPIRED', 'Authorization is revoked or expired');
    if (command.authorizationVersion !== authority.version) throw fastError('AUTHORIZATION_CHANGED', 'Authorization version changed');
    if (details.origin && !scopeIncludes(authority.origins, details.origin)) throw fastError('ORIGIN_OUT_OF_SCOPE', 'Page origin is outside authorization');
    check();
    return authority;
  };
  const protectedScope = async (command, { bootstrap = false, backgroundRead = false, readOnly = false } = {}) => {
    const state = await browser.meta();
    const background = backgroundRead ? { backgroundRead: true } : {};
    if (state.url === 'about:blank' && bootstrap) {
      await refreshAuthority(command, background);
      return { state: { pageId: state.pageId, pageVersion: state.pageVersion, url: 'about:blank', title: '' }, identity: null, bootstrap: true };
    }
    let origin;
    try { const url = new URL(state.url); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); origin = url.origin; }
    catch { throw fastError('ORIGIN_OUT_OF_SCOPE', 'Page has no authorized HTTP(S) origin'); }
    // Check origin with current Manager authority before reading business identity or content.
    await refreshAuthority(command, { origin, ...background });
    let identity, identityStatus;
    if (authority.scope === 'profile') {
      identity = { accountId: authority.accountId, resourceId: state.url };
      identityStatus = { scope: 'profile', websiteAccountVerified: false };
      if (!scopeIncludes(authority.resourceIds, identity.resourceId)) throw fastError('RESOURCE_OUT_OF_SCOPE', 'Page URL is outside the configured resource scope');
    } else {
      try {
        identity = await browser.identity(input.identity, { timeoutMs: readOnly ? 0 : 5000 });
        if (!identity?.accountId || !identity.resourceId) throw fastError('IDENTITY_UNVERIFIED', 'Actual account/resource identity is not ready');
        if (identity.accountId !== authority.accountId) throw fastError('ACCOUNT_CHANGED', 'Page account is outside authorization');
        if (!scopeIncludes(authority.resourceIds, identity.resourceId)) throw fastError('RESOURCE_OUT_OF_SCOPE', 'Page resource is outside authorization');
        if (command.payload?.resourceId && command.payload.resourceId !== identity.resourceId) throw fastError('RESOURCE_OUT_OF_SCOPE', 'Requested resource does not match actual page evidence');
        identityStatus = { scope: 'identity', verified: true };
      } catch (error) {
        if (!readOnly) throw error;
        // Inspection is how an Agent discovers account menus and diagnoses an
        // outdated selector. A missing identity must not hide that very page.
        return { state, identity: null, identityStatus: { scope: 'identity', verified: false, reason: error.code || 'IDENTITY_UNVERIFIED', details: error.details || null }, bootstrap: false };
      }
      // Strict identity was read from the browser across an asynchronous gap;
      // revalidate it. Profile identity above is derived synchronously from the
      // authority just returned, so repeating that same RPC adds no new check.
      await refreshAuthority(command, { origin, ...identity, ...background });
    }
    for (const [name, eventType, code] of [['loginExpired', 'login.expired', 'LOGIN_EXPIRED'], ['permissionChanged', 'permission.changed', 'PERMISSION_CHANGED']]) {
      if (input.safetyConditions?.[name] && await browser.condition(input.safetyConditions[name])) {
        await publish({ type: eventType, dedupeKey: `safety:${eventType}:${operationId}`, summary: 'Configured page safety condition requires main Agent review', priority: 'high' });
        if (!readOnly) throw fastError(code, 'Configured page safety condition prevents effects; inspect the current page');
        identityStatus.warning = code;
      }
    }
    return { state, identity, identityStatus, bootstrap: false };
  };
  const authorize = async (command, action, identity, url, localReceipt = false) => {
    check();
    const approval = await durable('authorize', {
      operationId, commandId: command.commandId, actionId: action.actionId,
      authorizationVersion: command.authorizationVersion,
      kind: action.kind || action.type, primitive: action.type, effect: actionHasEffect(action),
      ...(localReceipt ? { localReceipt: true } : {}),
      accountId: identity?.accountId || authority.accountId,
      resourceId: identity?.resourceId || null,
      origin: new URL(['navigate', 'new-tab'].includes(action.type) && action.value ? action.value : url).origin,
      proposed: action.proposed ?? action.value, before: action.before,
      businessKey: action.businessKey, currency: action.currency, budgetType: action.budgetType,
      field: action.field, dataAsOf: action.dataAsOf, dataRange: action.dataRange, attribution: action.attribution,
      interaction: action.interaction, observedReplyToId: action.observedReplyToId
    });
    authority = approval.authorization || approval;
    if (approval.takeover || approval.automationPaused || humanOwned) throw fastError('MANUAL_TAKEOVER', 'Human owns this page');
    if (authority.revokedAt || (authority.expiresAt && Date.parse(authority.expiresAt) <= Date.now())) throw fastError('AUTHORIZATION_EXPIRED', 'Authorization is revoked or expired');
    if (command.authorizationVersion !== authority.version) throw fastError('AUTHORIZATION_CHANGED', 'Authorization version changed');
    if (identity && authority.accountId !== identity.accountId) throw fastError('ACCOUNT_CHANGED', 'Page account does not match authorization');
    if (identity?.resourceId && !scopeIncludes(authority.resourceIds, identity.resourceId)) throw fastError('RESOURCE_OUT_OF_SCOPE', 'Page resource is outside authorization');
    const origin = new URL(['navigate', 'new-tab'].includes(action.type) && action.value ? action.value : url).origin;
    if (!scopeIncludes(authority.origins, origin)) throw fastError('ORIGIN_OUT_OF_SCOPE', 'Target origin is outside authorization');
    if (!scopeIncludes(authority.allowedActions, action.kind || action.type)) throw fastError('ACTION_NOT_ALLOWED', 'Action is outside authorization');
    check();
    return authority;
  };
  const waitFor = async (payload, commandSignal = activeCommand?.controller.signal || abortController.signal, groupDeadlineAt = Infinity) => {
    const timeoutMs = boundedInteger(payload.timeoutMs, 5000, 60000, 'timeoutMs');
    const pollMs = boundedInteger(payload.pollMs, 200, 2000, 'pollMs', 25);
    const started = performance.now(), deadlineAt = Math.min(started + timeoutMs, groupDeadlineAt);
    const remaining = () => {
      check();
      if (commandSignal?.aborted) throw commandSignal.reason || fastError('TASK_STOPPED', 'Wait stopped');
      const left = deadlineAt - performance.now();
      if (left <= 0) throw fastError('CONDITION_TIMEOUT', 'Local condition did not become true before its deadline');
      return Math.ceil(left);
    };
    if (payload.type === 'download') {
      const download = await browser.page.waitForEvent('download', { timeout: remaining() });
      remaining();
      const failure = await download.failure();
      remaining();
      if (failure) throw fastError('DOWNLOAD_FAILED', 'Download failed');
      return { matched: true, type: 'download', suggestedFilename: download.suggestedFilename(), elapsedMs: Math.round(performance.now() - started) };
    }
    for (;;) {
      remaining();
      try {
        if (activeCommand) await protectedScope(activeCommand.command, { readOnly: true });
        remaining();
        if (browser.unsafe) throw fastError(browser.unsafe, 'Unexpected page state during wait');
        const matched = await browser.condition(waitCondition(payload));
        remaining();
        if (matched) return { matched: true, elapsedMs: Math.round(performance.now() - started) };
      } catch (error) {
        if (error.code !== 'OBSERVATION_UNAVAILABLE' && !/execution context was destroyed|cannot find context/iu.test(error.message || '')) throw error;
      }
      await delay(Math.min(pollMs, remaining()), commandSignal);
    }
  };
  const startWatch = async (payload) => {
    if (watches.size >= 8) throw fastError('WATCH_LIMIT', 'At most eight local watchers per session');
    const watchId = payload.watchId || `watch_${randomUUID().slice(0, 12)}`;
    if (watches.has(watchId)) throw fastError('WATCH_EXISTS', 'Watcher already exists');
    const pollMs = boundedInteger(payload.pollMs, 1000, 30000, 'pollMs', 100);
    const controller = new AbortController();
    const sourceCommand = activeCommand.command;
    const watcher = { controller, lastCheckAt: null, checks: 0, healthy: true, matched: false, pageId: null };
    watches.set(watchId, watcher);
    watcher.done = (async () => {
      let lastEpoch;
      let unavailableSince = null;
      while (!controller.signal.aborted && !disposed && !terminal) {
        try {
          if (payload.deadline && Date.now() >= Date.parse(payload.deadline)) {
            await publish({ type: 'watch.deadline', dedupeKey: `deadline:${watchId}`, summary: 'Watcher deadline reached', priority: 'high', payload: { watchId } });
            break;
          }
          const { state } = await protectedScope(sourceCommand, { backgroundRead: true });
          const currentEpoch = state.pageVersion.split(':').slice(1, -1).join(':');
          if (lastEpoch && currentEpoch !== lastEpoch) await publish({ type: 'watch.rebound', dedupeKey: `rebound:${watchId}:${currentEpoch}`, summary: 'Watcher rebound after navigation', payload: { watchId } });
          lastEpoch = currentEpoch;
          watcher.pageId = state.pageId; watcher.lastCheckAt = new Date().toISOString(); watcher.checks += 1; watcher.healthy = true;
          const matched = await browser.condition(waitCondition(payload));
          unavailableSince = null;
          if (matched && !watcher.matched) await publish({ type: payload.eventType || 'watch.changed', dedupeKey: `${watchId}:${state.pageVersion}`, summary: payload.summary || 'Defined page condition matched', priority: payload.priority || 'normal', payload: { watchId, pageId: state.pageId, pageVersion: state.pageVersion } });
          watcher.matched = matched;
          if (matched && payload.once) break;
        } catch (error) {
          if (controller.signal.aborted || disposed || terminal) break;
          watcher.healthy = false;
          const transient = error.code === 'OBSERVATION_UNAVAILABLE' || /execution context was destroyed|cannot find context|navigation/iu.test(error.message || '');
          if (transient) {
            unavailableSince ??= Date.now();
            if (Date.now() - unavailableSince < 5000) { try { await delay(Math.min(pollMs, 250), controller.signal); } catch { break; } continue; }
          }
          await publish({ type: error.code === 'BROWSER_DISCONNECTED' ? 'browser.disconnected' : 'watch.failed', dedupeKey: `watch-failed:${watchId}`, summary: error.code || 'OBSERVATION_UNAVAILABLE', priority: 'high', payload: { watchId } });
          break;
        }
        try { await delay(pollMs, controller.signal); } catch { break; }
      }
    })();
    watcher.done.catch(() => { watcher.healthy = false; });
    return { watchId, healthy: true, pollMs };
  };
  const control = ({ action, mode: nextMode } = {}) => {
    if (action === 'stop') { terminal = true; activeCommand?.controller.abort(fastError('TASK_STOPPED', 'Session stopped')); abortController.abort(); transport?.pause(true); void browser.pauseCursor?.(true); }
    if (action === 'takeover' || action === 'pause') {
      humanOwned = true; activeCommand?.controller.abort(fastError('MANUAL_TAKEOVER', 'Human took over or paused the page'));
      transport?.pause(true);
      void browser.pauseCursor?.(true);
      for (const watcher of watches.values()) watcher.controller.abort();
    } else if (action === 'resume') { humanOwned = false; transport?.pause(false); mode = nextMode || mode; if (!cursorExplicit) { cursorEnabled = mode === 'operations'; void browser.setCursorEnabled?.(cursorEnabled); } void browser.pauseCursor?.(false); }
    freshObservation = false;
    lastObservation = null;
    startupNavigationAvailable = false;
    browser.invalidate();
    return { mode, automationPaused: humanOwned, cursorEnabled, requiresObservation: true };
  };
  const handleControl = (value = {}) => {
    if (value.action === 'cursor') {
      if (typeof value.visible !== 'boolean') throw fastError('INVALID_COMMAND', 'Cursor visibility must be boolean');
      cursorExplicit = true; cursorEnabled = value.visible;
      return Promise.resolve(browser.setCursorEnabled?.(cursorEnabled)).then(() => ({ mode, automationPaused: humanOwned, cursorEnabled }));
    }
    return control(value);
  };
  const unsubscribe = runtime.onControl?.(handleControl);
  let lastSafetyIssue = null;
  let guardianUnavailableSince = null;
  const guardian = (async () => {
    while (!disposed && !terminal && !abortController.signal.aborted) {
      try { await delay(1000, abortController.signal); } catch { break; }
      if (disposed || terminal || activeCommand || !freshObservation || humanOwned || !input.identity || !lastReadCommand) continue;
      let issue = null;
      try {
        const { state } = await protectedScope(lastReadCommand, { bootstrap: true, backgroundRead: true });
        if (state.url === 'about:blank') continue;
        if (input.safetyConditions?.loginExpired && await browser.condition(input.safetyConditions.loginExpired)) issue = 'login.expired';
        else if (input.safetyConditions?.permissionChanged && await browser.condition(input.safetyConditions.permissionChanged)) issue = 'permission.changed';
        else {
          const identity = await browser.identity(input.identity);
          if (identity.accountId !== authority.accountId || identity.resourceId && !authority.resourceIds?.includes(identity.resourceId)) issue = 'identity.changed';
        }
        guardianUnavailableSince = null;
      } catch (error) {
        if (error.code === 'OBSERVATION_UNAVAILABLE' || /execution context was destroyed|cannot find context|navigation/iu.test(error.message || '')) {
          guardianUnavailableSince ??= Date.now();
          if (Date.now() - guardianUnavailableSince < 5000) continue;
        }
        issue = error.code === 'LOGIN_EXPIRED' ? 'login.expired' : error.code === 'PERMISSION_CHANGED' ? 'permission.changed' : error.code === 'BROWSER_DISCONNECTED' ? 'browser.disconnected' : 'watch.failed';
      }
      if (issue && issue !== lastSafetyIssue) {
        freshObservation = false;
        await publish({ type: issue, dedupeKey: `safety:${issue}:${operationId}`, summary: 'Current browser context needs main Agent review', priority: 'high' });
      }
      lastSafetyIssue = issue;
    }
  })();
  guardian.catch(() => { freshObservation = false; });

  async function batch(command) {
    const payload = command.payload;
    const started = performance.now();
    const timeoutMs = boundedInteger(payload.timeoutMs, 20000, 60000, 'timeoutMs');
    const deadlineAt = started + timeoutMs;
    const remaining = (cap = Infinity) => {
      check();
      const left = deadlineAt - performance.now();
      if (left <= 0) throw fastError('CONDITION_TIMEOUT', 'Action group exceeded its bounded duration');
      return Math.min(cap, Math.ceil(left));
    };
    const within = async operation => { remaining(); const value = await operation(); remaining(); return value; };
    if (humanOwned) throw fastError('MANUAL_TAKEOVER', 'Human owns this page');
    if (writeUnknown && payload.actions.some(actionHasEffect)) throw fastError('RECONCILE_REQUIRED', 'A previous effect is unresolved; inspect/read back before another effect');
    const openingNavigation = startupNavigationAvailable && authority.scope === 'profile' && payload.actions.length === 1 && ['navigate', 'new-tab'].includes(payload.actions[0].type) && !actionHasEffect(payload.actions[0]) && !humanOwned;
    if (!freshObservation && !openingNavigation) throw fastError('OBSERVATION_REQUIRED', 'Read the current page before target-based actions; a general session can open its first URL directly');
    startupNavigationAvailable = false;
    await within(() => assertPage(command, { version: freshObservation }));
    const initialScope = await within(() => protectedScope(command, { bootstrap: true, readOnly: !payload.actions.some(actionHasEffect) }));
    if (initialScope.bootstrap && authority.scope !== 'profile' && (payload.actions.length !== 1 || payload.actions[0].type !== 'navigate')) throw fastError('BOOTSTRAP_NAVIGATION_REQUIRED', 'A strict-identity session starts with one authorized navigation before account-bound effects');
    const results = [];
    const expectedMatched = new Set();
    const verifyExpected = async (action) => {
      if (action.expected === undefined) return;
      await within(() => activeCommand.trace.measure('verification', () => waitFor({ condition: action.expected, timeoutMs: remaining(5000) }, undefined, deadlineAt), { actionId: action.actionId, actionType: action.type }));
      expectedMatched.add(action.actionId);
    };
    const pending = [];
    activeCommand.pending = pending;
    if (!await conditions(payload.preconditions, true, remaining)) throw fastError('PRECONDITION_FAILED', 'Batch precondition no longer holds');
    for (const action of payload.actions) {
      remaining();
      if (action.pageId && action.pageId !== (await within(() => browser.meta())).pageId) await within(() => browser.selectTab(action.pageId));
      const state = await within(() => assertPage({ ...command, pageId: action.pageId }));
      const scope = await within(() => protectedScope(command, { bootstrap: state.url === 'about:blank', readOnly: !actionHasEffect(action) }));
      if (action.preconditions && !await conditions(action.preconditions, true, remaining)) throw fastError('PRECONDITION_FAILED', 'Action precondition no longer holds');
      for (const condition of payload.stopConditions || []) if (await within(() => browser.condition(condition))) throw fastError('STOP_CONDITION', 'Configured stop condition matched');
      if (action.type === 'read' || action.type === 'locate') {
        const text = await within(() => browser.read(action.target));
        await verifyExpected(action);
        results.push({ actionId: action.actionId, text, ...(expectedMatched.has(action.actionId) ? { expectedMatched: true } : {}) });
        continue;
      }
      if (action.type === 'wait') {
        const waitTimeoutMs = boundedInteger(action.value.timeoutMs, 5000, 60000, 'timeoutMs');
        const result = await within(() => waitFor({ ...action.value, timeoutMs: Math.min(waitTimeoutMs, remaining(60000)) }, undefined, deadlineAt));
        await verifyExpected(action);
        results.push({ actionId: action.actionId, ...result, ...(expectedMatched.has(action.actionId) ? { expectedMatched: true } : {}) });
        continue;
      }
      if (attempted.has(action.actionId)) throw fastError('ACTION_ALREADY_ATTEMPTED', 'Action identifier has already been initiated; reconcile rather than retry');
      await within(() => activeCommand.trace.measure('target-resolution', () => browser.validateAction?.(action, remaining(5000)), { actionId: action.actionId, actionType: action.type }));
      const identity = scope.identity;
      if (action.guard && !await within(() => browser.condition(action.guard))) throw fastError('RESOURCE_CHANGED', 'Current resource no longer matches the approved before-value');
      if (action.beforeTarget && String(await within(() => browser.read(action.beforeTarget))).trim() !== String(action.before)) throw fastError('RESOURCE_CHANGED', 'Before-value readback differs from the approved change');
      for (const [field, spec] of Object.entries(scope.bootstrap || !actionHasEffect(action) ? {} : input.businessContext || {})) {
        const actual = String(await within(() => browser.read({ selector: spec.selector }))).trim();
        if (spec.expected !== undefined && actual !== String(spec.expected)) throw fastError('BUSINESS_CONTEXT_CHANGED', `Page ${field} changed`);
        if (action[field] !== undefined && actual !== String(action[field])) throw fastError('BUSINESS_CONTEXT_CHANGED', `Action ${field} differs from page evidence`);
      }
      if (action.interaction) {
        const interaction = action.interaction;
        if (interaction.replyToId === interaction.postId && interaction.postId === identity?.resourceId) action.observedReplyToId = identity.resourceId;
        else {
          const evidence = interaction.replyToEvidence;
          if (!evidence?.target || !evidence.expectedId || evidence.expectedId !== interaction.replyToId) throw fastError('INTERACTION_EVIDENCE_REQUIRED', 'A new reply target requires explicit observed identity evidence');
          action.observedReplyToId = await within(() => browser.readIdentifier(evidence.target, evidence.attribute));
          if (action.observedReplyToId !== interaction.replyToId) throw fastError('INTERACTION_TARGET_CHANGED', 'Observed reply target differs from the approved conversation object');
        }
      }
      const beforeAction = await within(() => browser.meta());
      if (!sameDocument(beforeAction.pageVersion, state.pageVersion) || beforeAction.pageId !== state.pageId) throw fastError('STALE_OBSERVATION', 'Document changed during safety checks; observe again');
      if (action.transport && !transport) throw fastError('TRANSPORT_NOT_ENABLED', 'This operation did not explicitly enable single-send transport');
      const guarded = transport && action.effect !== false;
      if (guarded) {
        if (!['click', 'fill', 'select', 'key'].includes(action.type)) throw fastError('TRANSPORT_ACTION_UNSUPPORTED', 'Only known JSON UI submissions can use a forward guard');
        validateTransport(action.transport, { pageUrl: state.url, origins: authority.origins });
      }
      let localReceipt = action.effect === false && localReceiptTypes.has(action.type) && !action.transport && !action.interaction;
      const record = {
        actionId: action.actionId, commandId: command.commandId, operationId,
        authorizationVersion: command.authorizationVersion, accountId: identity?.accountId || authority.accountId,
        pageId: beforeAction.pageId, pageVersion: beforeAction.pageVersion,
        resourceId: identity?.resourceId || null, businessKey: action.businessKey,
        transport: action.transport || null,
        expected: action.expected || null, expectedIdentity: identity, beforeTarget: action.beforeTarget || null, interaction: action.interaction ? { ...action.interaction, observedReplyToId: action.observedReplyToId } : null,
        kind: action.kind || action.type, before: action.before ?? null,
        proposed: action.proposed ?? (action.type === 'fill' ? '[input omitted]' : action.value) ?? null,
        reason: action.reason || '', effect: actionHasEffect(action), status: 'prepared', startedAt: new Date().toISOString()
      };
      if (localReceipt) record.origin = new URL(['navigate', 'new-tab'].includes(action.type) && action.value ? action.value : state.url).origin;
      // Keep buffered evidence well below the 128 KiB result channel. The
      // estimate reserves duplicated expected/readback fields and scene data;
      // oversized local preparation uses the original durable path before act.
      if (localReceipt) localReceipt = Buffer.byteLength(JSON.stringify(activeCommand.localActions)) + 3 * Buffer.byteLength(JSON.stringify(record)) + 2048 <= 32 * 1024;
      if (!localReceipt) { await within(() => authorize(command, action, identity, state.url)); await within(() => durable('action', record)); }
      remaining();
      // Authorization is re-read after the first ACK, immediately before the irreversible boundary.
      await within(() => authorize(command, action, identity, state.url, localReceipt));
      if (!localReceipt) { remaining(); await durable('action', { ...record, status: 'initiated' }); }
      attempted.add(action.actionId);
      if (record.effect) pending.push(record);
      try {
        remaining();
        if (guarded) await within(() => transport.arm({ page: browser.page, pageId: beforeAction.pageId, url: state.url, command, commandId: command.commandId, actionId: action.actionId, guard: action.transport }));
        const actionResult = await within(() => activeCommand.trace.measure('browser-action', () => browser.act(action, remaining(10000), { ...beforeAction, deadlineAt }), { actionId: action.actionId, actionType: action.type }));
        if (guarded) record.transportResult = await within(() => transport.finish(action.actionId, remaining(10000)));
        remaining();
        if (browser.unsafe) throw fastError(browser.unsafe, 'Unexpected dialog interrupted the action group');
        const after = await within(() => browser.meta());
        const expectedUrl = action.expected?.url;
        if (after.url !== state.url && after.url !== expectedUrl && !['navigate', 'back', 'forward', 'reload', 'new-tab', 'close-tab', 'click', 'key'].includes(action.type)) throw fastError('UNEXPECTED_NAVIGATION', 'Navigation was not declared by the main Agent');
        const afterScope = await within(() => protectedScope(command, { bootstrap: true, readOnly: !record.effect }));
        if (scope.bootstrap && afterScope.identity) { record.accountId = afterScope.identity.accountId; record.resourceId = afterScope.identity.resourceId; record.expectedIdentity = afterScope.identity; }
        await verifyExpected(action);
        if (record.effect && authority.scope !== 'profile' && action.type !== 'navigate') {
          const afterIdentity = await within(() => browser.identity(input.identity));
          if (afterIdentity.accountId !== identity.accountId || afterIdentity.resourceId !== identity.resourceId) throw fastError('ACCOUNT_CHANGED', 'Page identity changed after an action');
        }
        if (!record.effect) {
          const receipt = { ...record, status: 'confirmed', confirmedAt: new Date().toISOString(), verification: { condition: action.expected || null, matched: action.expected ? true : null, method: 'browser-action-completed' } };
          if (localReceipt) activeCommand.localActions.push({ ...receipt, after: { pageId: afterScope.state.pageId, pageVersion: afterScope.state.pageVersion, url: afterScope.state.url, ...afterScope.identity } });
          else await durable('action', receipt);
        }
        results.push({ actionId: action.actionId, status: record.effect ? 'initiated' : 'confirmed', ...(actionResult ? { result: actionResult } : {}), ...(expectedMatched.has(action.actionId) ? { expectedMatched: true } : {}) });
      } catch (error) {
        transport?.disarm(action.actionId);
        const cause = error.code || (['navigate', 'back', 'forward', 'reload', 'new-tab'].includes(action.type) ? 'NAVIGATION_FAILED' : 'ACTION_FAILED');
        const details = { actionId: action.actionId, actionType: action.type, phase: error.details?.phase || activeCommand.trace.summary().phase || 'browser-action', cause, message: error.message, ...error.details };
        if (record.effect) { writeUnknown = true; throw fastError('WRITE_RESULT_UNKNOWN', 'Effect result is uncertain; inspect/read back before another effect', details); }
        const failed = { ...record, status: 'failed', verification: { code: cause, details } };
        if (localReceipt) activeCommand.localActions.push(failed);
        else await durable('action', failed).catch(() => {});
        throw fastError(cause, error.message, details);
      }
    }
    if (!await conditions(payload.verify, true, remaining)) {
      writeUnknown = pending.length > 0;
      throw fastError(pending.length ? 'WRITE_RESULT_UNKNOWN' : 'RESULT_UNVERIFIED', 'Final result was not positively verified');
    }
    const groupMatched = payload.verify.length > 0;
    // Dispatch and proof completed in budget. Required receipt writes still
    // finish: a late successful confirmation ACK must not undo verified truth.
    for (const record of [...pending]) {
      const verified = groupMatched || expectedMatched.has(record.actionId);
      try { await durable('action', { ...record, status: 'confirmed', confirmedAt: new Date().toISOString(), verification: { conditions: payload.verify,
        ...(expectedMatched.has(record.actionId) ? { actionExpected: record.expected, expectedMatched: true } : {}),
        matched: verified ? true : null, businessResultVerified: verified, method: verified ? 'readback' : 'browser-action-completed' } }); }
      catch { writeUnknown = true; throw fastError('WRITE_RESULT_UNKNOWN', 'Completion acknowledgement was lost; reconcile persisted state'); }
      pending.splice(pending.indexOf(record), 1);
    }
    if (payload.businessRecord) await durable('business-record', { ...payload.businessRecord, operationId });
    pending.length = 0;
    const effects = payload.actions.filter(actionHasEffect);
    const effectsMatched = effects.length > 0 && effects.every(action => expectedMatched.has(action.actionId));
    return { actions: results.map((value) => value.status === 'initiated' ? { ...value, status: 'confirmed' } : value),
      verification: { matched: groupMatched || expectedMatched.size ? true : null, businessResultVerified: groupMatched || effectsMatched,
        ...(groupMatched ? { groupMatched: true } : {}), ...(expectedMatched.size ? { actionExpectedMatched: expectedMatched.size } : {}) }, elapsedMs: Math.round(performance.now() - started) };
  }

  async function execute(raw) {
    if (commandResultUnknown) throw fastError('COMMAND_RESULT_UNKNOWN', 'Inspect the original stored command before starting more work', { commandId: commandResultUnknown });
    const command = validateFastCommand(raw);
    if (command.operationId !== operationId) throw fastError('OPERATION_MISMATCH', 'Command belongs to another operation');
    if (activeCommand) throw fastError('PAGE_BUSY', 'A command already owns this page');
    const leasePage = browser.page || page;
    const owner = leases.get(leasePage);
    if (owner && owner !== api) throw fastError('PAGE_BUSY', 'Another executor owns this page');
    leases.set(leasePage, api);
    const localActions = [];
    const trace = createOperationsDiagnostics();
    activeCommand = { command, controller: new AbortController(), localActions, trace };
    browser.setStageRecorder?.((entry) => trace.mark(entry.stage, entry.event, entry));
    const saveDiagnostics = async (reason) => {
      const summary = { ...trace.summary(), reason, recordedThrough: 'pre-result-commit' };
      if (!outputDir) return summary;
      const evidenceRef = `operations-diagnostic-${randomUUID()}.json`;
      try {
        await writeFile(path.join(outputDir, evidenceRef), JSON.stringify({ commandId: command.commandId, reason, ...trace.snapshot() }), { flag: 'wx', mode: 0o600 });
        return { ...summary, evidenceRef };
      } catch { return { ...summary, evidenceUnavailable: true }; }
    };
    let reply;
    try {
      await transportReady;
      check();
      let result;
      const payload = command.payload || {};
      if (command.kind === 'observe') {
        const scope = await protectedScope(command, { bootstrap: true, readOnly: true });
        if (scope.bootstrap) result = { ...scope.state, bootstrap: true, items: [], total: 0, omitted: { before: 0, after: 0, textCharacters: 0 } };
        else if (payload.pageIds) {
          list(payload.pageIds, 'pageIds', 4);
          if (authority.scope !== 'profile') throw fastError('MULTI_TAB_SCOPE_REQUIRED', 'Concurrent tab inspection uses a Profile-scoped session; strict identity reads select one scoped page');
          for (const pageId of payload.pageIds) {
            const tab = browser.tabs().find((item) => item.pageId === pageId);
            if (!tab || !scopeIncludes(authority.origins, new URL(tab.url).origin) || !scopeIncludes(authority.resourceIds, tab.url)) throw fastError('ORIGIN_OUT_OF_SCOPE', 'A requested tab is outside this operation scope', { pageId });
          }
          result = await browser.observePages(payload.pageIds, payload);
        }
        else if (payload.scopes) {
          list(payload.scopes, 'scopes', 4);
          result = await Promise.all(payload.scopes.map((scope) => browser.observe(observationOptions({ ...payload, scopes: undefined, scope }, undefined, Math.floor(24000 / payload.scopes.length)))));
        } else result = await trace.measure('observation', () => browser.observe(observationOptions(payload)));
        await protectedScope(command, { bootstrap: true, readOnly: true });
        freshObservation = true;
        startupNavigationAvailable = false;
        lastObservation = await browser.meta();
        lastReadCommand = command;
        if (payload.requestDecision) await publish({ type: 'decision.required', dedupeKey: `review:${command.commandId}`, summary: String(payload.requestDecision.summary || 'Main Agent review required').slice(0, 500), priority: 'normal', payload: { commandId: command.commandId, businessKind: input.businessKind, context: payload.requestDecision.context || null } });
      } else if (command.kind === 'batch') {
        result = await batch(command);
        const scope = await protectedScope(command, { bootstrap: true, readOnly: true });
        result.observation = scope.bootstrap ? { ...scope.state, items: [], total: 0, bootstrap: true } : await trace.measure('observation', () => browser.observe(observationOptions(payload.observation, 6000)));
        freshObservation = true; lastObservation = await browser.meta();
      }
      else if (command.kind === 'wait') {
        await protectedScope(command, { readOnly: true });
        if (payload.cancelWatch) { const watcher = watches.get(payload.cancelWatch); watcher?.controller.abort(); await watcher?.done; watches.delete(payload.cancelWatch); result = { cancelled: Boolean(watcher) }; }
        else if (payload.health) result = { watches: [...watches].map(([watchId, { checks, healthy, lastCheckAt }]) => ({ watchId, checks, healthy, lastCheckAt })), browser: browser.metrics?.() || null };
        else if (payload.watch) result = await startWatch(payload);
        else result = await waitFor(payload);
      } else if (command.kind === 'tabs') {
        await protectedScope(command, { bootstrap: true, readOnly: true });
        result = browser.inspectTabs ? await browser.inspectTabs() : browser.tabs();
      }
      else if (command.kind === 'select-tab') {
        await refreshAuthority(command); await browser.selectTab(payload.pageId || payload);
        const scope = await protectedScope(command, { bootstrap: true, readOnly: true });
        result = scope.bootstrap ? scope.state : await browser.observe(observationOptions(payload.observation, 6000));
        freshObservation = true; lastObservation = await browser.meta();
      }
      else if (command.kind === 'control') {
        if (payload.action === 'acknowledge-dialog') {
          if (!command.pageId || !command.pageVersion || typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 2000) throw fastError('INVALID_DIALOG_ACKNOWLEDGEMENT', 'Fresh page identity/version and an explicit decision reason are required');
          const before = await browser.meta();
          if (before.pageId !== command.pageId || !sameAcknowledgementScene(before.pageVersion, command.pageVersion)) throw fastError('STALE_OBSERVATION', 'Observe this interruption again before acknowledging it');
          if (browser.unsafe !== 'UNEXPECTED_DIALOG') throw fastError('DIALOG_ACKNOWLEDGEMENT_NOT_APPLICABLE', 'Only the current unexpected-dialog interruption can be acknowledged');
          const token = browser.unsafeToken;
          const scope = await protectedScope(command);
          // Manager binds the receipt to the exact scene reserved by the Agent.
          // The live scene was checked above; unrelated revisions may differ.
          const acknowledgement = await durable('dialog-acknowledgement', { operationId, commandId: command.commandId, pageId: command.pageId, pageVersion: command.pageVersion, reason: payload.reason.trim(), ...scope.identity, origin: new URL(scope.state.url).origin });
          if (acknowledgement?.acknowledged !== true) throw fastError('DIALOG_ACKNOWLEDGEMENT_UNCONFIRMED', 'Manager did not confirm this interruption acknowledgement');
          const after = await browser.meta();
          if (!sameAcknowledgementScene(after.pageVersion, before.pageVersion) || browser.unsafeToken !== token) throw fastError('STALE_OBSERVATION', 'Page or interruption changed while acknowledgement was being persisted');
          if (browser.clearUnsafe(token) === false) throw fastError('DIALOG_ACKNOWLEDGEMENT_NOT_APPLICABLE', 'Interruption changed before acknowledgement');
          if (acknowledgement.localUncertaintyCleared === true) writeUnknown = false;
          else if (acknowledgement.remainingUnresolvedActionIds?.length) writeUnknown = true;
          freshObservation = false;
          result = { acknowledged: true, requiresObservation: true, automationPaused: humanOwned, pageId: before.pageId, pageVersion: after.pageVersion };
        } else result = await handleControl(payload);
      }
      else if (command.kind === 'screenshot') {
        await protectedScope(command, { bootstrap: true, readOnly: true });
        const beforeCapture = await browser.meta();
        const fileName = `observation-${randomUUID()}.png`;
        const masks = [];
        if (browser.page.locator) masks.push(browser.page.locator('input[type="password"],input[type="email"],input[autocomplete="one-time-code"],[data-private]'));
        const options = { fullPage: false, timeout: 5000, mask: masks };
        let bytes;
        const captureWithoutCursor = (capture) => browser.withoutCursor ? browser.withoutCursor(capture) : capture();
        if (payload.target) bytes = await captureWithoutCursor(async () => (await browser.locator(payload.target)).screenshot(options));
        else if (payload.clip) {
          const { x, y, width, height } = payload.clip || {};
          if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || width * height > 16000000) throw fastError('INVALID_COMMAND', 'Invalid screenshot region');
          bytes = await captureWithoutCursor(() => browser.page.screenshot({ ...options, clip: { x, y, width, height } }));
        } else bytes = await captureWithoutCursor(() => browser.page.screenshot(options));
        if (bytes.length > 5 * 1024 * 1024) throw fastError('EVIDENCE_TOO_LARGE', 'Screenshot exceeds 5 MiB');
        await writeFile(path.join(outputDir, fileName), bytes, { flag: 'wx', mode: 0o600 });
        const afterCapture = await browser.meta();
        if (beforeCapture.pageId !== afterCapture.pageId || !sameDocument(beforeCapture.pageVersion, afterCapture.pageVersion)) throw fastError('STALE_OBSERVATION', 'Document changed during screenshot; inspect the new scene');
        freshObservation = true; lastObservation = afterCapture; startupNavigationAvailable = false;
        result = { evidenceRef: fileName, privacy: 'Password/email/one-time-code and data-private regions masked; other visible data remains in the selected region' };
      } else if (command.kind === 'reconcile') {
        if (payload.refresh || payload.url) {
          const current = await browser.meta();
          const target = new URL(payload.url || current.url);
          if (!['http:', 'https:'].includes(target.protocol)) throw fastError('ORIGIN_OUT_OF_SCOPE', 'Reconciliation navigation requires an authorized HTTP(S) origin');
          await refreshAuthority(command, { origin: target.origin });
          if (payload.refresh || target.href !== current.url) await browser.refresh(target.href);
        }
        const scope = await protectedScope(command);
        if (!Array.isArray(payload.verify) || !payload.verify.length || !await conditions(payload.verify, true)) throw fastError('RECONCILE_UNRESOLVED', 'Current resource does not confirm the proposed result');
        const afterScope = await protectedScope(command);
        if (JSON.stringify(afterScope.identity) !== JSON.stringify(scope.identity)) throw fastError('ACCOUNT_CHANGED', 'Reconciliation identity changed during readback');
        result = { matched: true, outcome: payload.outcome || 'applied', reason: typeof payload.reason === 'string' ? payload.reason.trim() : '', verification: payload.verify, identity: afterScope.identity, url: afterScope.state.url, observation: await browser.observe({ scope: payload.scope }) };
        await durable('reconciliation', { operationId, commandId: command.commandId, actionIds: payload.actionIds || [], result });
        writeUnknown = false; freshObservation = true; lastObservation = await browser.meta();
      }
      const finalScope = command.kind === 'control' ? {} : await protectedScope(command, { bootstrap: true, readOnly: true });
      reply = { commandId: command.commandId, status: 'confirmed', ...finalScope.state, ...(finalScope.identityStatus ? { identityStatus: finalScope.identityStatus } : {}), result, evidenceRef: result?.evidenceRef || null, needsDecision: false, reason: null };
      if (payload.diagnostics === true) reply.diagnostics = await saveDiagnostics('requested');
    } catch (error) {
      if (activeCommand.pending?.length) {
        writeUnknown = true;
        for (const record of activeCommand.pending) await durable('action', { ...record, status: 'unknown', verification: { code: error.details?.cause || error.code || 'GROUP_INTERRUPTED', details: error.details || null } }).catch(() => {});
        error = fastError('WRITE_RESULT_UNKNOWN', 'An external-effect group was interrupted; inspect/read back before another effect', { cause: error.code || 'GROUP_INTERRUPTED', ...error.details, pendingActionIds: activeCommand.pending.map((record) => record.actionId) });
      }
      let meta = {}; try { const current = await browser.meta(); meta = { pageId: current.pageId, pageVersion: current.pageVersion }; } catch { /* do not expose URL/title from an unauthorized page */ }
      const unknown = error.code === 'WRITE_RESULT_UNKNOWN';
      reply = { commandId: command.commandId, status: unknown ? 'unknown' : 'stopped', ...meta, result: { code: error.code || 'EXECUTION_FAILED', message: error.message, ...(error.details ? { details: error.details } : {}) }, evidenceRef: null, needsDecision: true, reason: error.code || 'EXECUTION_FAILED' };
      freshObservation = false;
      // Return a fresh diagnostic scene in the same round trip when its origin
      // is still readable. No action is retried and an unknown effect stays locked.
      try {
        const scope = await protectedScope(command, { bootstrap: true, readOnly: true });
        if (!scope.bootstrap) reply.observation = await browser.observe(observationOptions({}, 4000));
        if (scope.identityStatus) reply.identityStatus = scope.identityStatus;
        lastObservation = await browser.meta(); freshObservation = !humanOwned;
      } catch { /* revoked/out-of-scope contexts do not expose page contents */ }
      await publish({ type: unknown ? 'action.unknown' : 'decision.required', dedupeKey: `decision:${command.commandId}`, summary: reply.reason, priority: 'high', payload: { commandId: command.commandId, reason: reply.reason } }).catch(() => {});
      reply.diagnostics = await saveDiagnostics(reply.reason);
    } finally {
      browser.setStageRecorder?.(null);
      activeCommand = null;
      if (leases.get(leasePage) === api) leases.delete(leasePage);
    }
    const safe = redactSensitiveValue(reply);
    try { await trace.measure('result-commit', () => durable('command-result', localActions.length ? { ...safe, localActions: redactSensitiveValue(localActions) } : safe)); }
    catch {
      commandResultUnknown = command.commandId; writeUnknown = true; terminal = true;
      throw fastError('COMMAND_RESULT_UNKNOWN', 'Command result persistence was not acknowledged; inspect the original stored command without resubmitting it', { commandId: command.commandId });
    }
    return safe;
  }
  const api = {
    execute, control: handleControl,
    ready: () => transportReady,
    get mode() { return mode; },
    get automationPaused() { return humanOwned; },
    get cursorEnabled() { return cursorEnabled; },
    get unresolved() { return writeUnknown; },
    async dispose() {
      disposed = true; activeCommand?.controller.abort(); abortController.abort();
      await transportReady.catch(() => {}); await transport?.dispose();
      for (const watcher of watches.values()) watcher.controller.abort();
      await Promise.allSettled([...watches.values()].map((watcher) => watcher.done));
      await guardian.catch(() => {});
      await Promise.allSettled([...pendingEvents]);
      watches.clear(); eventKeys.clear();
      signal?.removeEventListener('abort', abort); if (typeof unsubscribe === 'function') unsubscribe();
      await browser.dispose();
      if (leases.get(page) === api) leases.delete(page);
    }
  };
  return api;
}

export async function runFastSession(runtime) {
  const session = createFastSession(runtime);
  let completedBatches = 0;
  try {
    await session.ready();
    await runtime.durable('event', { operationId: runtime.input.operationId, type: 'session.ready', dedupeKey: `ready:${runtime.input.operationId}`, summary: 'Persistent browser session ready', priority: 'normal' });
    while (!runtime.signal.aborted) {
      const command = await runtime.wait({ reason: 'operations-command', data: { operationId: runtime.input.operationId, mode: session.mode, requiresReconciliation: session.unresolved } });
      if (!command) continue;
      if (command.kind === 'control' && command.payload?.action === 'stop') return { status: 'stopped' };
      try {
        const result = await session.execute(command);
        if (command.kind === 'batch' && result.status === 'confirmed') completedBatches += 1;
        if (session.mode === 'batch' && completedBatches >= boundedInteger(runtime.input.commandLimit, 1, 100, 'commandLimit')) return { status: 'finished', completedBatches };
      }
      catch (error) {
        if (error.code === 'COMMAND_RESULT_UNKNOWN') throw error;
        await runtime.durable('command-result', { commandId: command.commandId, status: 'stopped', needsDecision: true, reason: error.code || 'EXECUTION_FAILED', result: { code: error.code || 'EXECUTION_FAILED', message: error.message } });
      }
    }
  } finally { await session.dispose(); }
  return { status: 'stopped' };
}
