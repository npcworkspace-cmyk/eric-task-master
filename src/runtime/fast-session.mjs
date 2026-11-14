import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFastBrowser, fastError, boundedInteger, delay } from './fast-browser.mjs';
import { redactSensitiveValue } from '../lib/redaction.mjs';

const leases = new WeakMap();
const KINDS = new Set(['observe', 'batch', 'wait', 'screenshot', 'tabs', 'select-tab', 'reconcile', 'control']);
const MUTATIONS = new Set(['click', 'fill', 'select', 'scroll', 'key', 'navigate']);

function list(value, name, maximum = 24) {
  if (!Array.isArray(value) || value.length > maximum) throw fastError('INVALID_COMMAND', `${name} must be an array of at most ${maximum} items`);
  return value;
}

export function validateFastCommand(command) {
  if (!command || command.schemaVersion !== 1 || typeof command.commandId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(command.commandId) || !KINDS.has(command.kind)) {
    throw fastError('INVALID_COMMAND', 'Expected a versioned, uniquely identified bounded command');
  }
  if (Buffer.byteLength(JSON.stringify(command)) > 128 * 1024) throw fastError('COMMAND_TOO_LARGE', 'Command exceeds 128 KiB');
  if (command.kind === 'batch') {
    const payload = command.payload || {};
    list(payload.preconditions, 'preconditions'); list(payload.stopConditions || [], 'stopConditions');
    const actions = list(payload.actions, 'actions', 16);
    list(payload.verify, 'verify');
    if (!payload.preconditions.length || !actions.length || !payload.verify.length) throw fastError('INVALID_COMMAND', 'Batch needs preconditions, actions and positive verification');
    const seen = new Set();
    for (const action of actions) {
      if (!action || typeof action.actionId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(action.actionId) || seen.has(action.actionId) || ![...MUTATIONS, 'read', 'locate', 'wait'].includes(action.type)) throw fastError('INVALID_ACTION', 'Actions require unique identifiers and supported primitive types');
      seen.add(action.actionId);
    }
    boundedInteger(payload.timeoutMs, 20000, 60000, 'timeoutMs');
  }
  return command;
}

export function createFastSession(runtime) {
  const { context, page, input = {}, signal, outputDir, durable = async () => { throw fastError('DURABILITY_UNAVAILABLE', 'Manager persistence acknowledgement is required'); } } = runtime;
  const operationId = input.operationId;
  let mode = input.mode || 'operations';
  let cursorExplicit = typeof input.showCursor === 'boolean';
  let cursorEnabled = cursorExplicit ? input.showCursor : mode === 'operations';
  let humanOwned = Boolean(input.takeover);
  let freshObservation = false;
  let activeCommand = null;
  let disposed = false;
  let terminal = false;
  let authority = input.authorization || {};
  let writeUnknown = Boolean(input.reconcileRequired);
  let lastReadCommand = null;
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
  const browser = runtime.browserAdapter || createFastBrowser({ page, context, signal, showCursor: cursorEnabled, onEvent: publish });
  const abort = () => { terminal = true; activeCommand?.controller.abort(signal?.reason || fastError('TASK_STOPPED', 'Stopped')); abortController.abort(); void browser.pauseCursor?.(true); };
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const check = () => {
    if (signal?.aborted || terminal || disposed) throw signal?.reason || fastError('TASK_STOPPED', 'Session stopped');
    if (activeCommand?.controller.signal.aborted) throw activeCommand.controller.signal.reason || fastError('TASK_STOPPED', 'Command stopped');
  };
  const conditions = async (values, expected) => {
    for (const condition of values) {
      check();
      if (await browser.condition(condition) !== expected) return false;
    }
    return true;
  };
  const assertPage = async (command, { version = false } = {}) => {
    check();
    const state = await browser.meta();
    if (command.pageId && command.pageId !== state.pageId) throw fastError('STALE_OBSERVATION', 'Selected page identity changed');
    if (version && command.pageVersion !== state.pageVersion) throw fastError('STALE_OBSERVATION', 'Observe the current page before acting');
    if (browser.unsafe) throw fastError(browser.unsafe, 'Unexpected page state; inspect and reconcile before continuing');
    return state;
  };
  const refreshAuthority = async (command, details = {}) => {
    check();
    const approval = await durable('authorize', { operationId, commandId: command.commandId, authorizationVersion: command.authorizationVersion, kind: command.kind === 'batch' ? 'observe' : command.kind, effect: false, ...details });
    authority = approval.authorization || approval;
    if (authority.revokedAt || !Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= Date.now()) throw fastError('AUTHORIZATION_EXPIRED', 'Authorization is revoked or expired');
    if (command.authorizationVersion !== authority.version) throw fastError('AUTHORIZATION_CHANGED', 'Authorization version changed');
    if (details.origin && !authority.origins?.includes(details.origin)) throw fastError('ORIGIN_OUT_OF_SCOPE', 'Page origin is outside authorization');
    check();
    return authority;
  };
  const protectedScope = async (command, { bootstrap = false, backgroundRead = false } = {}) => {
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
    const identity = await browser.identity(input.identity);
    if (!identity?.accountId || !identity.resourceId) throw fastError('IDENTITY_UNVERIFIED', 'Actual page account and resource evidence are both required');
    if (identity.accountId !== authority.accountId) throw fastError('ACCOUNT_CHANGED', 'Page account is outside authorization');
    if (!authority.resourceIds?.includes(identity.resourceId)) throw fastError('RESOURCE_OUT_OF_SCOPE', 'Page resource is outside authorization');
    if (command.payload?.resourceId && command.payload.resourceId !== identity.resourceId) throw fastError('RESOURCE_OUT_OF_SCOPE', 'Requested resource does not match actual page evidence');
    await refreshAuthority(command, { origin, ...identity, ...background });
    for (const [name, eventType, code] of [['loginExpired', 'login.expired', 'LOGIN_EXPIRED'], ['permissionChanged', 'permission.changed', 'PERMISSION_CHANGED']]) {
      if (input.safetyConditions?.[name] && await browser.condition(input.safetyConditions[name])) {
        await publish({ type: eventType, dedupeKey: `safety:${eventType}:${operationId}`, summary: 'Configured page safety condition requires main Agent review', priority: 'high' });
        throw fastError(code, 'Configured page safety condition prevents protected operations');
      }
    }
    return { state, identity, bootstrap: false };
  };
  const authorize = async (command, action, identity, url) => {
    check();
    const approval = await durable('authorize', {
      operationId, commandId: command.commandId, actionId: action.actionId,
      authorizationVersion: command.authorizationVersion,
      kind: action.kind || action.type, primitive: action.type, effect: action.effect !== false,
      accountId: identity?.accountId || authority.accountId,
      resourceId: identity?.resourceId || null,
      origin: new URL(action.type === 'navigate' ? action.value : url).origin,
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
    if (identity?.resourceId && !authority.resourceIds?.includes(identity.resourceId)) throw fastError('RESOURCE_OUT_OF_SCOPE', 'Page resource is outside authorization');
    const origin = new URL(action.type === 'navigate' ? action.value : url).origin;
    if (!authority.origins?.includes(origin)) throw fastError('ORIGIN_OUT_OF_SCOPE', 'Target origin is outside authorization');
    if (!authority.allowedActions?.includes(action.kind || action.type)) throw fastError('ACTION_NOT_ALLOWED', 'Action is outside authorization');
    check();
    return authority;
  };
  const waitFor = async (payload, commandSignal = activeCommand?.controller.signal || abortController.signal) => {
    const timeoutMs = boundedInteger(payload.timeoutMs, 5000, 60000, 'timeoutMs');
    const pollMs = boundedInteger(payload.pollMs, 200, 2000, 'pollMs', 25);
    const started = Date.now();
    if (payload.type === 'download') {
      const download = await browser.page.waitForEvent('download', { timeout: timeoutMs });
      check();
      const failure = await download.failure();
      if (failure) throw fastError('DOWNLOAD_FAILED', 'Download failed');
      return { matched: true, type: 'download', suggestedFilename: download.suggestedFilename(), elapsedMs: Date.now() - started };
    }
    do {
      check();
      if (activeCommand) await protectedScope(activeCommand.command);
      if (browser.unsafe) throw fastError(browser.unsafe, 'Unexpected page state during wait');
      if (await browser.condition(payload.condition || payload)) return { matched: true, elapsedMs: Date.now() - started };
      if (Date.now() - started >= timeoutMs) break;
      await delay(Math.min(pollMs, timeoutMs - (Date.now() - started)), commandSignal);
    } while (Date.now() - started <= timeoutMs);
    throw fastError('CONDITION_TIMEOUT', 'Local condition did not become true before its deadline');
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
          const matched = await browser.condition(payload.condition);
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
    if (action === 'stop') { terminal = true; activeCommand?.controller.abort(fastError('TASK_STOPPED', 'Session stopped')); abortController.abort(); void browser.pauseCursor?.(true); }
    if (action === 'takeover' || action === 'pause') {
      humanOwned = true; activeCommand?.controller.abort(fastError('MANUAL_TAKEOVER', 'Human took over or paused the page'));
      void browser.pauseCursor?.(true);
      for (const watcher of watches.values()) watcher.controller.abort();
    } else if (action === 'resume') { humanOwned = false; mode = nextMode || mode; if (!cursorExplicit) { cursorEnabled = mode === 'operations'; void browser.setCursorEnabled?.(cursorEnabled); } void browser.pauseCursor?.(false); }
    freshObservation = false;
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
    if (humanOwned) throw fastError('MANUAL_TAKEOVER', 'Human owns this page');
    if (writeUnknown) throw fastError('RECONCILE_REQUIRED', 'A previous write is unresolved; reconcile before any additional mutation');
    if (!freshObservation) throw fastError('OBSERVATION_REQUIRED', 'Read current page after startup or takeover before acting');
    await assertPage(command, { version: true });
    const initialScope = await protectedScope(command, { bootstrap: true });
    if (initialScope.bootstrap && (payload.actions.length !== 1 || payload.actions[0].type !== 'navigate')) throw fastError('BOOTSTRAP_NAVIGATION_REQUIRED', 'An empty initial page only permits one explicitly authorized navigation');
    const started = Date.now();
    const timeoutMs = boundedInteger(payload.timeoutMs, 20000, 60000, 'timeoutMs');
    const results = [];
    const pending = [];
    activeCommand.pending = pending;
    for (const action of payload.actions) {
      check();
      if (Date.now() - started >= timeoutMs) throw fastError('CONDITION_TIMEOUT', 'Action group exceeded its bounded duration');
      const state = await assertPage(command);
      const scope = await protectedScope(command, { bootstrap: initialScope.bootstrap && state.url === 'about:blank' });
      if (!await conditions(payload.preconditions, true)) throw fastError('PRECONDITION_FAILED', 'Batch precondition no longer holds');
      for (const condition of payload.stopConditions || []) if (await browser.condition(condition)) throw fastError('STOP_CONDITION', 'Configured stop condition matched');
      if (action.type === 'read' || action.type === 'locate') {
        results.push({ actionId: action.actionId, text: await browser.read(action.target) });
        continue;
      }
      if (action.type === 'wait') { results.push({ actionId: action.actionId, ...await waitFor(action.value) }); continue; }
      if (attempted.has(action.actionId)) throw fastError('ACTION_ALREADY_ATTEMPTED', 'Action identifier has already been initiated; reconcile rather than retry');
      await browser.validateAction?.(action);
      const identity = scope.identity;
      if (action.guard && !await browser.condition(action.guard)) throw fastError('RESOURCE_CHANGED', 'Current resource no longer matches the approved before-value');
      if (action.beforeTarget && String(await browser.read(action.beforeTarget)).trim() !== String(action.before)) throw fastError('RESOURCE_CHANGED', 'Before-value readback differs from the approved change');
      for (const [field, spec] of Object.entries(scope.bootstrap ? {} : input.businessContext || {})) {
        const actual = String(await browser.read({ selector: spec.selector })).trim();
        if (spec.expected !== undefined && actual !== String(spec.expected)) throw fastError('BUSINESS_CONTEXT_CHANGED', `Page ${field} changed`);
        if (action[field] !== undefined && actual !== String(action[field])) throw fastError('BUSINESS_CONTEXT_CHANGED', `Action ${field} differs from page evidence`);
      }
      if (action.interaction) {
        const interaction = action.interaction;
        if (interaction.replyToId === interaction.postId && interaction.postId === identity?.resourceId) action.observedReplyToId = identity.resourceId;
        else {
          const evidence = interaction.replyToEvidence;
          if (!evidence?.target || !evidence.expectedId || evidence.expectedId !== interaction.replyToId) throw fastError('INTERACTION_EVIDENCE_REQUIRED', 'A new reply target requires explicit observed identity evidence');
          action.observedReplyToId = await browser.readIdentifier(evidence.target, evidence.attribute);
          if (action.observedReplyToId !== interaction.replyToId) throw fastError('INTERACTION_TARGET_CHANGED', 'Observed reply target differs from the approved conversation object');
        }
      }
      const beforeAction = await browser.meta();
      if (beforeAction.pageVersion !== state.pageVersion) throw fastError('STALE_OBSERVATION', 'Page changed during safety checks; observe again');
      await authorize(command, action, identity, state.url);
      const record = {
        actionId: action.actionId, commandId: command.commandId, operationId,
        authorizationVersion: command.authorizationVersion, accountId: identity?.accountId || authority.accountId,
        resourceId: identity?.resourceId || null, businessKey: action.businessKey,
        expected: action.expected || null, expectedIdentity: identity, beforeTarget: action.beforeTarget || null, interaction: action.interaction ? { ...action.interaction, observedReplyToId: action.observedReplyToId } : null,
        kind: action.kind || action.type, before: action.before ?? null,
        proposed: action.proposed ?? (action.type === 'fill' ? '[input omitted]' : action.value) ?? null,
        reason: action.reason || '', effect: action.effect !== false, status: 'prepared', startedAt: new Date().toISOString()
      };
      await durable('action', record);
      check();
      // Authorization is re-read after the first ACK, immediately before the irreversible boundary.
      await authorize(command, action, identity, state.url);
      await durable('action', { ...record, status: 'initiated' });
      attempted.add(action.actionId);
      pending.push(record);
      try {
        check();
        await browser.act(action, Math.min(10000, Math.max(1, timeoutMs - (Date.now() - started))));
        check();
        if (browser.unsafe) throw fastError(browser.unsafe, 'Unexpected dialog interrupted the action group');
        const after = await browser.meta();
        const expectedUrl = action.expected?.url;
        if (after.url !== state.url && after.url !== expectedUrl) throw fastError('UNEXPECTED_NAVIGATION', 'Navigation was not declared by the main Agent');
        const afterScope = await protectedScope(command);
        if (scope.bootstrap) { record.accountId = afterScope.identity.accountId; record.resourceId = afterScope.identity.resourceId; record.expectedIdentity = afterScope.identity; }
        if (action.expected) await waitFor({ condition: action.expected, timeoutMs: Math.min(5000, Math.max(1, timeoutMs - (Date.now() - started))) });
        if (action.type !== 'navigate') {
          const afterIdentity = await browser.identity(input.identity);
          if (afterIdentity.accountId !== identity.accountId || afterIdentity.resourceId !== identity.resourceId) throw fastError('ACCOUNT_CHANGED', 'Page identity changed after an action');
        }
        results.push({ actionId: action.actionId, status: 'initiated' });
      } catch (error) {
        writeUnknown = true;
        throw fastError('WRITE_RESULT_UNKNOWN', 'Action may have taken effect; inspect and reconcile before retrying', { actionId: action.actionId, cause: error.code || 'ACTION_FAILED' });
      }
    }
    if (!await conditions(payload.verify, true)) {
      writeUnknown = pending.length > 0;
      throw fastError(pending.length ? 'WRITE_RESULT_UNKNOWN' : 'RESULT_UNVERIFIED', 'Final result was not positively verified');
    }
    for (const record of [...pending]) {
      try { await durable('action', { ...record, status: 'confirmed', confirmedAt: new Date().toISOString(), verification: { conditions: payload.verify, matched: true } }); }
      catch { writeUnknown = true; throw fastError('WRITE_RESULT_UNKNOWN', 'Completion acknowledgement was lost; reconcile persisted state'); }
      pending.splice(pending.indexOf(record), 1);
    }
    if (payload.businessRecord) await durable('business-record', { ...payload.businessRecord, operationId });
    pending.length = 0;
    return { actions: results.map((value) => value.status === 'initiated' ? { ...value, status: 'confirmed' } : value), verification: { matched: true }, elapsedMs: Date.now() - started };
  }

  async function execute(raw) {
    const command = validateFastCommand(raw);
    if (command.operationId !== operationId) throw fastError('OPERATION_MISMATCH', 'Command belongs to another operation');
    if (activeCommand) throw fastError('PAGE_BUSY', 'A command already owns this page');
    const leasePage = browser.page || page;
    const owner = leases.get(leasePage);
    if (owner && owner !== api) throw fastError('PAGE_BUSY', 'Another executor owns this page');
    leases.set(leasePage, api);
    activeCommand = { command, controller: new AbortController() };
    let reply;
    try {
      check();
      let result;
      const payload = command.payload || {};
      if (command.kind === 'observe') {
        const scope = await protectedScope(command, { bootstrap: true });
        if (scope.bootstrap) result = { ...scope.state, bootstrap: true, items: [], total: 0, omitted: { before: 0, after: 0, textCharacters: 0 } };
        else if (payload.scopes) {
          list(payload.scopes, 'scopes', 4);
          result = await Promise.all(payload.scopes.map((scope) => browser.observe({ ...payload, scopes: undefined, scope })));
        } else result = await browser.observe(payload);
        await protectedScope(command, { bootstrap: true });
        freshObservation = true;
        lastReadCommand = command;
        if (payload.requestDecision) await publish({ type: 'decision.required', dedupeKey: `review:${command.commandId}`, summary: String(payload.requestDecision.summary || 'Main Agent review required').slice(0, 500), priority: 'normal', payload: { commandId: command.commandId, businessKind: input.businessKind, context: payload.requestDecision.context || null } });
      } else if (command.kind === 'batch') result = await batch(command);
      else if (command.kind === 'wait') {
        await protectedScope(command);
        if (payload.cancelWatch) { const watcher = watches.get(payload.cancelWatch); watcher?.controller.abort(); await watcher?.done; watches.delete(payload.cancelWatch); result = { cancelled: Boolean(watcher) }; }
        else if (payload.health) result = { watches: [...watches].map(([watchId, { checks, healthy, lastCheckAt }]) => ({ watchId, checks, healthy, lastCheckAt })), browser: browser.metrics?.() || null };
        else if (payload.watch) result = await startWatch(payload);
        else result = await waitFor(payload);
      } else if (command.kind === 'tabs') {
        await protectedScope(command, { bootstrap: true });
        result = browser.tabs().map(({ pageId, selected }) => ({ pageId, selected, requiresIdentityCheck: !selected }));
      }
      else if (command.kind === 'select-tab') { await refreshAuthority(command); await browser.selectTab(payload.pageId); result = (await protectedScope(command, { bootstrap: true })).state; freshObservation = false; }
      else if (command.kind === 'control') {
        if (payload.action === 'acknowledge-dialog') {
          if (!command.pageId || !command.pageVersion || typeof payload.reason !== 'string' || !payload.reason.trim() || payload.reason.length > 2000) throw fastError('INVALID_DIALOG_ACKNOWLEDGEMENT', 'Fresh page identity/version and an explicit decision reason are required');
          const before = await browser.meta();
          if (before.pageId !== command.pageId || before.pageVersion !== command.pageVersion) throw fastError('STALE_OBSERVATION', 'Observe this interruption again before acknowledging it');
          if (browser.unsafe !== 'UNEXPECTED_DIALOG') throw fastError('DIALOG_ACKNOWLEDGEMENT_NOT_APPLICABLE', 'Only the current unexpected-dialog interruption can be acknowledged');
          const token = browser.unsafeToken;
          const scope = await protectedScope(command);
          const acknowledgement = await durable('dialog-acknowledgement', { operationId, commandId: command.commandId, pageId: before.pageId, pageVersion: before.pageVersion, reason: payload.reason.trim(), ...scope.identity, origin: new URL(scope.state.url).origin });
          if (acknowledgement?.acknowledged !== true) throw fastError('DIALOG_ACKNOWLEDGEMENT_UNCONFIRMED', 'Manager did not confirm this interruption acknowledgement');
          const after = await browser.meta();
          if (after.pageVersion !== before.pageVersion || browser.unsafeToken !== token) throw fastError('STALE_OBSERVATION', 'Page or interruption changed while acknowledgement was being persisted');
          if (browser.clearUnsafe(token) === false) throw fastError('DIALOG_ACKNOWLEDGEMENT_NOT_APPLICABLE', 'Interruption changed before acknowledgement');
          if (acknowledgement.localUncertaintyCleared === true) writeUnknown = false;
          else if (acknowledgement.remainingUnresolvedActionIds?.length) writeUnknown = true;
          freshObservation = false;
          result = { acknowledged: true, requiresObservation: true, automationPaused: humanOwned, pageId: before.pageId, pageVersion: after.pageVersion };
        } else result = await handleControl(payload);
      }
      else if (command.kind === 'screenshot') {
        await protectedScope(command);
        if (!payload.target && !payload.clip) throw fastError('SCREENSHOT_SCOPE_REQUIRED', 'Choose a region or unique target; full-page captures are not the default');
        const fileName = `observation-${randomUUID()}.png`;
        const masks = [];
        if (browser.page.locator) masks.push(browser.page.locator('input[type="password"],input[type="email"],input[autocomplete="one-time-code"],[data-private]'));
        const options = { fullPage: false, timeout: 5000, mask: masks };
        let bytes;
        const captureWithoutCursor = (capture) => browser.withoutCursor ? browser.withoutCursor(capture) : capture();
        if (payload.target) bytes = await captureWithoutCursor(async () => (await browser.locator(payload.target)).screenshot(options));
        else {
          const { x, y, width, height } = payload.clip || {};
          if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || width * height > 16000000) throw fastError('INVALID_COMMAND', 'Invalid screenshot region');
          bytes = await captureWithoutCursor(() => browser.page.screenshot({ ...options, clip: { x, y, width, height } }));
        }
        if (bytes.length > 5 * 1024 * 1024) throw fastError('EVIDENCE_TOO_LARGE', 'Screenshot exceeds 5 MiB');
        await writeFile(path.join(outputDir, fileName), bytes, { flag: 'wx', mode: 0o600 });
        result = { evidenceRef: fileName, privacy: 'Password/email/one-time-code and data-private regions masked; other visible data remains in the selected region' };
      } else if (command.kind === 'reconcile') {
        if (payload.refresh || payload.url) {
          const current = await browser.meta();
          const target = new URL(payload.url || current.url);
          if (!['http:', 'https:'].includes(target.protocol)) throw fastError('ORIGIN_OUT_OF_SCOPE', 'Reconciliation navigation requires an authorized HTTP(S) origin');
          await refreshAuthority(command, { origin: target.origin });
          await browser.refresh(target.href);
        }
        const scope = await protectedScope(command);
        if (!Array.isArray(payload.verify) || !payload.verify.length || !await conditions(payload.verify, true)) throw fastError('RECONCILE_UNRESOLVED', 'Current resource does not confirm the proposed result');
        const afterScope = await protectedScope(command);
        if (JSON.stringify(afterScope.identity) !== JSON.stringify(scope.identity)) throw fastError('ACCOUNT_CHANGED', 'Reconciliation identity changed during readback');
        result = { matched: true, verification: payload.verify, identity: afterScope.identity, url: afterScope.state.url, observation: await browser.observe({ scope: payload.scope }) };
        await durable('reconciliation', { operationId, commandId: command.commandId, actionIds: payload.actionIds || [], result });
        writeUnknown = false; freshObservation = true;
      }
      const meta = command.kind === 'control' ? {} : (await protectedScope(command, { bootstrap: true })).state;
      reply = { commandId: command.commandId, status: 'confirmed', ...meta, result, evidenceRef: result?.evidenceRef || null, needsDecision: false, reason: null };
    } catch (error) {
      if (activeCommand.pending?.length) {
        writeUnknown = true;
        for (const record of activeCommand.pending) await durable('action', { ...record, status: 'unknown', verification: { code: error.code || 'GROUP_INTERRUPTED' } }).catch(() => {});
        error = fastError('WRITE_RESULT_UNKNOWN', 'An initiated action group was interrupted; reconcile before repeating any effect', { cause: error.code || 'GROUP_INTERRUPTED' });
      }
      let meta = {}; try { const current = await browser.meta(); meta = { pageId: current.pageId, pageVersion: current.pageVersion }; } catch { /* do not expose URL/title from an unauthorized page */ }
      const unknown = error.code === 'WRITE_RESULT_UNKNOWN';
      reply = { commandId: command.commandId, status: unknown ? 'unknown' : 'stopped', ...meta, result: { code: error.code || 'EXECUTION_FAILED', message: error.message, ...(error.details ? { details: error.details } : {}) }, evidenceRef: null, needsDecision: true, reason: error.code || 'EXECUTION_FAILED' };
      freshObservation = false;
      await publish({ type: unknown ? 'action.unknown' : 'decision.required', dedupeKey: `decision:${command.commandId}`, summary: reply.reason, priority: 'high', payload: { commandId: command.commandId, reason: reply.reason } }).catch(() => {});
    } finally {
      activeCommand = null;
      if (leases.get(leasePage) === api) leases.delete(leasePage);
    }
    const safe = redactSensitiveValue(reply);
    await durable('command-result', safe);
    return safe;
  }
  const api = {
    execute, control: handleControl,
    get mode() { return mode; },
    get automationPaused() { return humanOwned; },
    get cursorEnabled() { return cursorEnabled; },
    get unresolved() { return writeUnknown; },
    async dispose() {
      disposed = true; activeCommand?.controller.abort(); abortController.abort();
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
        await runtime.durable('command-result', { commandId: command.commandId, status: 'stopped', needsDecision: true, reason: error.code || 'EXECUTION_FAILED', result: { code: error.code || 'EXECUTION_FAILED', message: error.message } });
      }
    }
  } finally { await session.dispose(); }
  return { status: 'stopped' };
}
