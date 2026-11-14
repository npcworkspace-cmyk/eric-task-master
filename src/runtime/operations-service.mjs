import path from 'node:path';
import { OperationsStore, operationId, safeOperationsValue } from '../lib/operations-store.mjs';
import { assertAuthorized, fingerprint, opsError, selectMode, validateAuthorization } from '../lib/operations-contracts.mjs';
import { scheduleDue, validateSchedule } from '../lib/operations-scheduler.mjs';
import { dispatchHost } from '../lib/host-dispatch.mjs';

const READ_KINDS = new Set(['observe', 'wait', 'screenshot', 'tabs', 'select-tab', 'reconcile']);
const find = (data, id) => {
  const operation = data.operations.find((item) => item.id === id);
  if (!operation) throw opsError('OPERATION_NOT_FOUND', 'Operation was not found', 404);
  return operation;
};
const timestamp = (now) => new Date(now()).toISOString();
const socialKey = (accountId, resourceId, interaction, content) => fingerprint({ accountId, resourceId, replyToId: interaction.replyToId, content: content.trim() });
function validateBudgets(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((limit) => limit !== null && (!Number.isFinite(limit) || limit < 0))) throw opsError('INVALID_BUDGET', 'Budget limits must be nonnegative finite numbers or null');
  return structuredClone(value);
}
function documentEpoch(pageVersion) {
  const parts = typeof pageVersion === 'string' ? pageVersion.split(':') : [];
  return parts.length >= 3 ? parts.slice(1, -1).join(':') : null;
}

export async function createOperationsService({ stateDir, taskService, profileStore, now = Date.now, tickMs = 500, hostDispatch = dispatchHost, storeOptions = {} }) {
  const store = await new OperationsStore({ stateDir: path.join(stateDir, 'operations'), now, ...storeOptions }).init();
  await store.recover();
  let closed = false; let ticking = false; let tickFinished = Promise.resolve(); let finishTick = () => {};
  const dispatching = new Set(); const listeners = new Set();
  store.onCapacity = async (paused) => { for (const operation of paused) await taskService.operationControl?.(operation.taskId, { action: 'pause', reason: 'OPERATIONS_STORAGE_LIMIT' }); };
  const notify = () => { for (const listener of listeners) listener(); };
  function addEvent(data, operation, value) {
    const dedupeKey = String(value.dedupeKey || `${value.type}:${value.commandId || ''}`);
    const previous = data.events.find((event) => event.operationId === operation.id && event.dedupeKey === dedupeKey && event.state !== 'handled');
    if (previous) return previous;
    data.eventSequence = (data.eventSequence || 0) + 1;
    const event = { ...safeOperationsValue(value), id: operationId('event'), sequence: data.eventSequence, operationId: operation.id, dedupeKey,
      type: value.type || 'decision', priority: value.priority || 'normal', createdAt: timestamp(now),
      expiresAt: value.expiresAt || operation.authorization.expiresAt, state: 'pending', attempts: 0,
      summary: String(value.summary || value.type || 'Decision required').slice(0, 2000), nextAttemptAt: now() };
    data.events.push(event); notify(); return event;
  }
  function checkBudget(operation, { host = false, admission = false } = {}) {
    const limits = operation.budgets;
    const counters = operation.counters;
    const exceeded = (admission && limits.maxRuns != null && counters.runs >= limits.maxRuns) ||
      (limits.maxDurationMs != null && now() - Date.parse(operation.createdAt) >= limits.maxDurationMs) ||
      (host && limits.maxHostCalls != null && counters.hostCalls >= limits.maxHostCalls) ||
      ['inputTokens', 'outputTokens', 'cost'].some((name) => limits[name] != null && (counters[name] == null || counters[name] >= limits[name]));
    if (exceeded) throw opsError('OPERATION_BUDGET_EXCEEDED', 'Operation budget reached or requested usage is unobservable', 409);
  }
  function pausedRejection(operation, error) {
    operation.status = 'paused'; operation.pauseReason = { code: error.code, message: error.message, at: timestamp(now) };
    return { operationRejected: { code: error.code, message: error.message, statusCode: error.statusCode || 409 }, taskId: operation.taskId };
  }
  async function rejectAfterPersistence(result) {
    if (!result?.operationRejected) return result;
    await taskService.operationControl?.(result.taskId, { action: 'pause', reason: result.operationRejected.code });
    throw opsError(result.operationRejected.code, result.operationRejected.message, result.operationRejected.statusCode);
  }
  async function get(id, { commandId = null } = {}) {
    const data = await store.read();
    const operation = find(data, id);
    const task = operation.taskId ? await taskService.get(operation.taskId).catch(() => null) : null;
    if (commandId) {
      const command = data.commands.find((item) => item.operationId === id && item.commandId === commandId);
      if (!command) throw opsError('COMMAND_NOT_FOUND', 'Command was not found', 404);
      return { id, taskId: operation.taskId, goal: operation.goal, status: operation.status, mode: operation.mode, cursorEnabled: operation.cursorEnabled ?? operation.mode === 'operations',
        cursorApplyState: operation.cursorApplyState || 'initial', cursorRequested: operation.cursorRequested ?? operation.cursorEnabled ?? operation.mode === 'operations', manualLock: operation.manualLock,
        authorizationVersion: operation.authorization.version, accountId: operation.authorization.accountId, resourceIds: operation.authorization.resourceIds,
        pending: operation.pending, pauseReason: operation.pauseReason || null, storageFailure: data.storageFailure || null,
        task: task ? { id: task.id, state: task.state, waiting: task.waiting, error: task.error } : null,
        command: { commandId: command.commandId, status: command.status, reply: command.reply || null },
        unresolvedActions: data.actions.filter((item) => item.operationId === id && ['initiated', 'unknown'].includes(item.status)).map((item) => ({ actionId: item.actionId, commandId: item.commandId, kind: item.kind, accountId: item.accountId, resourceId: item.resourceId, status: item.status, expected: item.expected, evidenceRef: item.evidenceRef || null })),
        omitted: { completedActionCount: data.actions.filter((item) => item.operationId === id && !['initiated', 'unknown'].includes(item.status)).length,
          otherCommandCount: data.commands.filter((item) => item.operationId === id && item.commandId !== commandId).length,
          businessRecordCount: data.records.filter((item) => item.operationId === id).length, fullEvidence: `ops get ${id}` } };
    }
    return { ...operation, task, storageFailure: data.storageFailure || null, actions: data.actions.filter((item) => item.operationId === id),
      commands: data.commands.filter((item) => item.operationId === id), records: data.records.filter((item) => item.operationId === id),
      hostCapability: operation.hostAdapter ? 'configured-adapter-unverified-native-host' : 'active-wait-only; session-ended/app-closed adapter-required' };
  }
  async function start(body = {}) {
    if (closed) throw opsError('OPERATIONS_CLOSED', 'Operations service is closing', 503);
    const browserSelection = body.browserSelection || { kind: 'local-browser' };
    if (browserSelection.kind !== 'profile' || !browserSelection.profileId) {
      const error = opsError('BROWSER_ADAPTER_UNAVAILABLE', 'No supported local browser-use adapter is installed; no substitute browser was launched', 409);
      error.details = { choices: ['Connect the selected signed-in local browser through a supported browser-use host adapter', 'Explicitly choose a Task Master Profile for this task'] };
      throw error;
    }
    const profile = await profileStore.get(browserSelection.profileId);
    const authorization = validateAuthorization(body.authorization, now());
    authorization.id = operationId('auth'); authorization.version = 1; authorization.grantedAt = timestamp(now); authorization.revokedAt = null;
    const selected = selectMode({ modePolicy: profile.modePolicy || 'auto', mode: body.mode, skillMode: body.skillMode, intent: body.intent || 'waiting' });
    if (body.hostAdapter && (!path.isAbsolute(body.hostAdapter.executable || '') || !Array.isArray(body.hostAdapter.args))) throw opsError('INVALID_HOST_ADAPTER', 'Host adapter requires an explicit absolute executable and argument array');
    const budgets = validateBudgets(body.budgets);
    if (body.showCursor !== undefined && typeof body.showCursor !== 'boolean') throw opsError('INVALID_CURSOR_PREFERENCE', 'showCursor must be a boolean');
    const operation = { id: operationId(), taskId: null, goal: String(body.goal || '').slice(0, 2000), businessKind: body.businessKind || 'general',
      browserSelection: { kind: 'profile', profileId: profile.id }, authorization, ...selected, modePolicy: profile.modePolicy || 'auto', manualLock: false,
      currentStep: null, completedActionIds: [], pending: null, nextTrigger: null, decisionSummary: '', status: 'running',
      budgets, counters: { runs: 0, hostCalls: 0, inputTokens: null, outputTokens: null, cost: null, retries: 0 },
      cursorEnabled: body.showCursor ?? selected.mode === 'operations',
      identity: body.identity || null, runtimeOptions: { businessContext: body.businessContext, commandLimit: body.commandLimit, safetyConditions: body.safetyConditions, ...(body.showCursor === undefined ? {} : { showCursor: body.showCursor }) },
      schedule: validateSchedule(body.schedule), hostAdapter: body.hostAdapter || null, createdAt: timestamp(now), updatedAt: timestamp(now) };
    await store.update((data) => { data.operations.push(operation); });
    try {
      const task = await taskService.createOperation({ profileId: profile.id, label: body.label || body.goal || 'Operations session',
        input: { ...operation.runtimeOptions, showCursor: operation.cursorEnabled, operationId: operation.id, businessKind: operation.businessKind, authorization, identity: operation.identity, browserSelection: operation.browserSelection, mode: operation.mode, initialUrl: body.initialUrl },
        mode: operation.mode, modeReason: operation.reason, outputBudget: body.outputBudget || {}, timeoutMs: body.timeoutMs ?? null });
      await store.update((data) => { find(data, operation.id).taskId = task.id; });
      return get(operation.id);
    } catch (error) {
      await store.update((data) => { const item = find(data, operation.id); item.status = 'failed'; item.error = { code: error.code, message: error.message }; });
      throw error;
    }
  }
  async function command(id, body = {}) {
    if (closed) throw opsError('OPERATIONS_CLOSED', 'Operations service is closing', 503);
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(body.commandId || '')) throw opsError('INVALID_COMMAND_ID', 'A stable commandId is required');
    if (![...READ_KINDS, 'batch', 'control'].includes(body.kind) || Buffer.byteLength(JSON.stringify(body)) > 128 * 1024) throw opsError('INVALID_COMMAND', 'Unknown or oversized command');
    if (body.kind === 'batch' && (!Array.isArray(body.payload?.actions) || !body.payload.actions.length || body.payload.actions.length > 32)) throw opsError('INVALID_BATCH', 'Batch must contain 1-32 actions');
    const result = await store.update((data) => {
      const operation = find(data, id);
      const previous = data.commands.find((item) => item.operationId === id && item.commandId === body.commandId);
      const hash = fingerprint(body);
      if (previous) {
        if (previous.fingerprint !== hash) throw opsError('COMMAND_ID_CONFLICT', 'commandId is already reserved for a different payload', 409);
        return previous;
      }
      const dialogAcknowledgement = body.kind === 'control' && body.payload?.action === 'acknowledge-dialog';
      if (operation.status !== 'running' && !(['reconcile-required', 'paused'].includes(operation.status) && (READ_KINDS.has(body.kind) || dialogAcknowledgement))) throw opsError('OPERATION_NOT_RUNNING', `Operation is ${operation.status}`, 409);
      assertAuthorized(operation, { ...body, kind: body.kind === 'batch' ? undefined : body.kind }, now());
      if (operation.manualLock && !READ_KINDS.has(body.kind) && body.kind !== 'control') throw opsError('MANUAL_TAKEOVER', 'Human owns this page; explicitly resume before automation', 409);
      if (operation.pending) throw opsError('COMMAND_IN_PROGRESS', 'One command is already reserved; retrieve its result before issuing another', 409);
      if (body.kind === 'batch' && data.actions.some((item) => item.operationId === id && ['initiated', 'unknown'].includes(item.status))) throw opsError('RECONCILIATION_REQUIRED', 'Reconcile uncertain external effects before another mutation', 409);
      if (!READ_KINDS.has(body.kind) || operation.status === 'running') {
        try { checkBudget(operation, { admission: true }); }
        catch (error) { return pausedRejection(operation, error); }
      }
      const envelope = { schemaVersion: 1, ...safeOperationsValue(body), operationId: id, authorizationVersion: operation.authorization.version };
      const record = { operationId: id, commandId: body.commandId, fingerprint: hash, envelope, status: 'pending', delivered: false, createdAt: timestamp(now) };
      data.commands.push(record); operation.pending = body.commandId; operation.counters.runs += 1; operation.updatedAt = timestamp(now);
      return record;
    });
    await rejectAfterPersistence(result);
    const current = await store.read(); const operation = find(current, id);
    const oldTask = operation.taskId ? await taskService.get(operation.taskId).catch(() => null) : null;
    if (!oldTask || ['stopped', 'error', 'finished'].includes(oldTask.state)) {
      const task = await taskService.createOperation({ profileId: operation.browserSelection.profileId, label: operation.goal || 'Recovered operations',
        input: { ...operation.runtimeOptions, showCursor: operation.cursorEnabled ?? operation.mode === 'operations', operationId: id, businessKind: operation.businessKind, authorization: operation.authorization, identity: operation.identity, mode: operation.mode,
          reconcileRequired: current.actions.some((item) => item.operationId === id && ['initiated', 'unknown'].includes(item.status)),
          completedActionIds: operation.completedActionIds }, mode: operation.mode, modeReason: 'recovered-reconciliation' });
      await store.update((data) => { const operation = find(data, id); operation.taskId = task.id; operation.cursorApplyState = 'initial'; operation.cursorRequested = operation.cursorEnabled ?? operation.mode === 'operations'; operation.cursorApplyError = null; });
    }
    await deliver(id); return result;
  }
  async function deliver(id) {
    if (dispatching.has(id) || closed) return;
    dispatching.add(id);
    try {
      const data = await store.read(); const operation = find(data, id);
      const record = data.commands.find((item) => item.operationId === id && item.commandId === operation.pending && !item.delivered);
      if (!record || !['running', 'paused', 'reconcile-required'].includes(operation.status)) return;
      assertAuthorized(operation, { ...record.envelope, kind: record.envelope.kind === 'batch' ? undefined : record.envelope.kind }, now());
      const task = await taskService.get(operation.taskId);
      if (task.state !== 'waiting' || task.waiting?.reason !== 'operations-command') return;
      // Reservation is durable before IPC; failure is unknown, never automatically resent.
      await store.update((current) => { current.commands.find((item) => item.operationId === id && item.commandId === record.commandId).delivered = true; });
      try { await taskService.resume(task.id, record.envelope, { waitId: task.waiting.id }); }
      catch (error) {
        await store.update((current) => {
          const item = current.commands.find((entry) => entry.operationId === id && entry.commandId === record.commandId);
          item.status = 'unknown'; item.updatedAt = timestamp(now);
          const operation = find(current, id); operation.status = 'reconcile-required';
          if (operation.pending === record.commandId) operation.pending = null;
          addEvent(current, operation, { type: 'disconnection', priority: 'safety', summary: error.message, dedupeKey: `delivery:${record.commandId}` });
        });
        await taskService.operationControl?.(operation.taskId, { action: 'pause', reason: 'DELIVERY_UNCONFIRMED' });
      }
    } finally { dispatching.delete(id); }
  }
  async function durable(taskId, type, payload) {
    const apply = (data) => {
      const operation = data.operations.find((item) => item.taskId === taskId);
      if (!operation) throw opsError('OPERATION_NOT_FOUND', 'Worker is not bound to an operation', 404);
      const record = data.commands.find((item) => item.operationId === operation.id && item.commandId === payload?.commandId);
      if (type === 'authorize' || type === 'action' && payload.status === 'initiated') {
        try { checkBudget(operation); }
        catch (error) { return pausedRejection(operation, error); }
      }
      if (type === 'authorize') {
        const readOnlyControl = payload.kind === 'control' && payload.effect === false && !payload.actionId && record?.envelope.kind === 'control' && record.envelope.payload?.action === 'acknowledge-dialog';
        const background = payload.backgroundRead === true && payload.effect === false && READ_KINDS.has(payload.kind) && ['observe', 'wait'].includes(record?.envelope.kind) && record.status === 'confirmed' && !payload.actionId && payload.proposed === undefined && payload.primitive === undefined;
        if (!record || record.status !== 'pending' && !background) throw opsError('COMMAND_NOT_RESERVED', 'Command has no active durable reservation', 409);
        if (operation.status !== 'running' && (background || !(READ_KINDS.has(payload.kind) || readOnlyControl) || !['paused', 'reconcile-required'].includes(operation.status))) throw opsError('OPERATION_NOT_RUNNING', 'Operation is paused or requires reconciliation', 409);
        const authorization = assertAuthorized(operation, payload, now());
        if (operation.manualLock && !(READ_KINDS.has(payload.kind) || readOnlyControl)) throw opsError('MANUAL_TAKEOVER', 'Manual takeover prevents automated effects', 409);
        if (!(READ_KINDS.has(payload.kind) || readOnlyControl) && payload.primitive !== 'navigate' && (!payload.accountId || !payload.resourceId || !payload.origin)) throw opsError('IDENTITY_EVIDENCE_REQUIRED', 'Mutation needs observed account, resource and origin', 403);
        if (READ_KINDS.has(payload.kind) || readOnlyControl) return { authorization, mode: operation.mode, operationId: operation.id, takeover: operation.manualLock };
        if (payload.kind === 'social.reply') {
          const original = record.envelope.payload?.actions?.find((item) => item.actionId === payload.actionId);
          const interaction = original?.interaction;
          if (!interaction || !['platform', 'communityId', 'postId', 'conversationId', 'replyToId'].every((key) => typeof interaction[key] === 'string' && interaction[key])) throw opsError('SOCIAL_CONTEXT_REQUIRED', 'Reply requires a stable platform/community/post/conversation/inbound-object identity', 403);
          if (interaction.postId !== payload.resourceId || payload.observedReplyToId !== interaction.replyToId) throw opsError('SOCIAL_OBJECT_MISMATCH', 'Reply target requires current page evidence for the approved inbound object', 403);
          const text = original.expected?.text;
          if (typeof text !== 'string' || !text.trim()) throw opsError('SOCIAL_CONTENT_REQUIRED', 'Reply result must verify its approved exact content', 403);
          const key = socialKey(authorization.accountId, payload.resourceId, interaction, text);
          if (data.actions.some((item) => item.socialInteractionKey === key && ['initiated', 'unknown', 'confirmed'].includes(item.status))) throw opsError('SOCIAL_INTERACTION_DUPLICATE', 'This account already initiated or confirmed the same reply to this inbound object', 409);
        }
        const previous = data.actions.find((item) => item.operationId === operation.id && item.actionId === payload.actionId);
        if (previous && ['initiated', 'confirmed', 'unknown'].includes(previous.status)) throw opsError('ACTION_ALREADY_INITIATED', 'Read back and reconcile this action; do not replay', 409);
        const limits = authorization.limits || {};
        if (payload.kind === 'ads.adjust') {
          if (limits.fields && !limits.fields.includes(payload.field)) throw opsError('FIELD_NOT_AUTHORIZED', 'Field is outside authorized changes', 403);
          if (limits.currency && payload.currency !== limits.currency) throw opsError('CURRENCY_MISMATCH', 'Observed currency must match authorization', 403);
          if (limits.budgetType && payload.budgetType !== limits.budgetType) throw opsError('BUDGET_TYPE_MISMATCH', 'Observed budget basis must match authorization', 403);
          if (limits.min != null && Number(payload.proposed) < limits.min || limits.max != null && Number(payload.proposed) > limits.max) throw opsError('ADJUSTMENT_LIMIT', 'Proposed value is outside authorized bounds', 403);
          if (limits.maxChange != null && (!Number.isFinite(Number(payload.before)) || !Number.isFinite(Number(payload.proposed)) || Math.abs(Number(payload.proposed) - Number(payload.before)) > limits.maxChange)) throw opsError('ADJUSTMENT_LIMIT', 'Per-change adjustment limit exceeded', 403);
          if (limits.maxDataAgeMs != null && (!Number.isFinite(Date.parse(payload.dataAsOf)) || now() - Date.parse(payload.dataAsOf) > limits.maxDataAgeMs)) throw opsError('DATA_TOO_OLD', 'Current measurement period is missing or stale', 403);
        }
        if (['delete', 'ownership', 'dns', 'mail-routing'].includes(payload.kind) && limits.destructive !== true) throw opsError('DESTRUCTIVE_NOT_AUTHORIZED', 'This configuration requires explicit destructive permission', 403);
        const confirmed = data.actions.filter((item) => item.operationId === operation.id && item.effect !== false && ['initiated', 'confirmed', 'unknown'].includes(item.status));
        const recent = confirmed.filter((item) => now() - Date.parse(item.startedAt || item.createdAt) < 86400000);
        if (payload.kind === 'ads.adjust' && limits.maxCumulativeChange != null && confirmed.filter((item) => item.kind === 'ads.adjust').reduce((sum, item) => sum + Math.abs(Number(item.proposed) - Number(item.before)), 0) + Math.abs(Number(payload.proposed) - Number(payload.before)) > limits.maxCumulativeChange) throw opsError('CUMULATIVE_LIMIT', 'Cumulative adjustment limit exceeded', 403);
        if (payload.effect !== false) {
          if (limits.maxPerMinute != null && confirmed.filter((item) => now() - Date.parse(item.startedAt || item.createdAt) < 60000).length >= limits.maxPerMinute) throw opsError('FREQUENCY_LIMIT', 'Authorized action frequency exceeded', 403);
          if (limits.dailyMax != null && recent.length >= limits.dailyMax) throw opsError('DAILY_LIMIT', 'Daily action limit reached', 403);
          if (limits.cooldownMs && confirmed.some((item) => now() - Date.parse(item.startedAt || item.createdAt) < limits.cooldownMs)) throw opsError('ACTION_COOLDOWN', 'Authorized action cooldown has not elapsed', 403);
        }
        return { authorization, mode: operation.mode, operationId: operation.id, takeover: operation.manualLock };
      }
      if (type === 'action') {
        if (!record) throw opsError('COMMAND_NOT_RESERVED', 'Action command was not reserved', 409);
        if (!payload.actionId || !['prepared', 'initiated', 'confirmed', 'unknown', 'failed'].includes(payload.status)) throw opsError('INVALID_ACTION_RECORD', 'Action needs id and valid status');
        let action = data.actions.find((item) => item.operationId === operation.id && item.actionId === payload.actionId);
        if (!action) {
          if (payload.status !== 'prepared') throw opsError('INVALID_ACTION_TRANSITION', 'Action must be prepared before initiation', 409);
          const original = record.envelope.payload?.actions?.find((item) => item.actionId === payload.actionId);
          if (!original) throw opsError('ACTION_NOT_RESERVED', 'Action must belong to the original reserved group', 409);
          action = { ...safeOperationsValue(payload), expected: original.expected || null, effect: original.effect !== false, interaction: original.interaction || null,
            operationId: operation.id, authorizationVersion: operation.authorization.version, createdAt: timestamp(now) };
          if (action.kind === 'social.reply') action.socialInteractionKey = socialKey(action.accountId, action.resourceId, original.interaction, original.expected.text);
          data.actions.push(action);
        } else {
          const next = { prepared: ['initiated', 'failed'], initiated: ['confirmed', 'unknown', 'failed'], unknown: [], confirmed: [], failed: [] }[action.status];
          if (!next?.includes(payload.status)) throw opsError('INVALID_ACTION_TRANSITION', 'Action transition or replay rejected', 409);
          if (payload.status === 'initiated') {
            assertAuthorized(operation, payload, now());
            if (operation.status !== 'running' || operation.manualLock) throw opsError('MANUAL_TAKEOVER', 'Operation is not authorized for automated mutation', 409);
            if (action.socialInteractionKey && data.actions.some((item) => item !== action && item.socialInteractionKey === action.socialInteractionKey && ['initiated', 'confirmed', 'unknown'].includes(item.status))) throw opsError('SOCIAL_INTERACTION_DUPLICATE', 'The same reply target and content were already initiated', 409);
          }
          Object.assign(action, safeOperationsValue(payload), { operationId: operation.id, expected: action.expected, interaction: action.interaction, effect: action.effect, socialInteractionKey: action.socialInteractionKey,
            kind: action.kind, accountId: action.accountId, resourceId: action.resourceId, proposed: action.proposed, before: action.before, businessKey: action.businessKey });
        }
        action.updatedAt = timestamp(now);
        if (action.status === 'initiated') action.startedAt = timestamp(now);
        if (action.status === 'confirmed') { action.confirmedAt = timestamp(now); operation.completedActionIds.push(action.actionId); }
        if (action.status === 'unknown') addEvent(data, operation, { type: 'write-result-unknown', priority: 'safety', dedupeKey: `unknown:${action.actionId}`, summary: 'External effect needs readback reconciliation', actionId: action.actionId });
        return action;
      }
      if (type === 'event') return addEvent(data, operation, payload);
      if (type === 'dialog-acknowledgement') {
        if (!record || record.status !== 'pending' || record.envelope.kind !== 'control' || record.envelope.payload?.action !== 'acknowledge-dialog' ||
            typeof payload.reason !== 'string' || !payload.reason.trim() || record.envelope.payload.reason !== payload.reason ||
            record.envelope.pageId !== payload.pageId || record.envelope.pageVersion !== payload.pageVersion || !payload.pageId || !payload.pageVersion) throw opsError('INVALID_DIALOG_ACKNOWLEDGEMENT', 'Explicit acknowledgement needs the reserved fresh page identity/version and decision reason', 409);
        if (!payload.accountId || !payload.resourceId || !payload.origin) throw opsError('IDENTITY_EVIDENCE_REQUIRED', 'Dialog acknowledgement requires actual protected account/resource/origin evidence', 403);
        assertAuthorized(operation, { ...payload, kind: 'control', authorizationVersion: record.envelope.authorizationVersion }, now());
        const unsettled = data.actions.filter((action) => action.operationId === operation.id && ['prepared', 'initiated', 'unknown'].includes(action.status));
        if (unsettled.some((action) => action.effect !== false && action.status !== 'prepared')) throw opsError('RECONCILIATION_REQUIRED', 'A dialog acknowledgement cannot clear unresolved external effects', 409);
        const abandonedActionIds = [];
        for (const action of unsettled) {
          if (action.effect !== false) continue;
          const originalCommand = data.commands.find((command) => command.operationId === operation.id && command.commandId === action.commandId)?.envelope;
          if (originalCommand?.pageId !== payload.pageId || action.accountId !== payload.accountId || action.resourceId !== payload.resourceId ||
              !documentEpoch(originalCommand.pageVersion) || documentEpoch(originalCommand.pageVersion) !== documentEpoch(payload.pageVersion)) continue;
          action.status = 'failed'; action.updatedAt = timestamp(now); action.verification = { state: 'abandoned', reason: payload.reason, acknowledgementCommandId: record.commandId }; abandonedActionIds.push(action.actionId);
        }
        const remainingUnresolvedActionIds = data.actions.filter((action) => action.operationId === operation.id && ['initiated', 'unknown'].includes(action.status)).map((action) => action.actionId);
        const acknowledgement = { acknowledged: true, operationId: operation.id, commandId: record.commandId, pageId: payload.pageId, pageVersion: payload.pageVersion,
          accountId: payload.accountId, resourceId: payload.resourceId, origin: payload.origin, reason: payload.reason, abandonedActionIds, remainingUnresolvedActionIds,
          localUncertaintyCleared: remainingUnresolvedActionIds.length === 0, requiresReconciliation: remainingUnresolvedActionIds.length > 0, createdAt: timestamp(now) };
        record.dialogAcknowledgement = acknowledgement;
        data.records.push({ kind: 'dialog-acknowledgement', status: 'confirmed', ...acknowledgement });
        return acknowledgement;
      }
      if (type === 'reconciliation') {
        if (!record || record.envelope.kind !== 'reconcile' || payload.result?.matched !== true || !Array.isArray(payload.actionIds) || !payload.actionIds.length || !Array.isArray(payload.result.verification) || !payload.result.verification.length) throw opsError('RECONCILIATION_EVIDENCE_REQUIRED', 'Reconciliation requires a reserved browser readback command');
        const identity = payload.result.identity;
        let origin; try { origin = new URL(payload.result.url).origin; } catch { throw opsError('RECONCILIATION_SCOPE_REQUIRED', 'Readback requires current URL and observed account/resource identity', 403); }
        if (!identity?.accountId || !identity.resourceId) throw opsError('RECONCILIATION_SCOPE_REQUIRED', 'Readback requires observed account/resource identity', 403);
        assertAuthorized(operation, { ...identity, origin, authorizationVersion: record.envelope.authorizationVersion }, now());
        const reservedIds = record.envelope.payload?.actionIds || [];
        if (fingerprint([...new Set(payload.actionIds)].sort()) !== fingerprint([...new Set(reservedIds)].sort())) throw opsError('RECONCILIATION_ACTION_MISMATCH', 'Readback action IDs differ from the reserved command', 409);
        if (data.actions.some((item) => item.operationId === operation.id && item.effect !== false && ['initiated', 'unknown'].includes(item.status) && !payload.actionIds.includes(item.actionId))) throw opsError('RECONCILIATION_INCOMPLETE', 'Read back all pending external effects before clearing uncertainty', 409);
        for (const id of payload.actionIds) {
          const item = data.actions.find((entry) => entry.operationId === operation.id && entry.actionId === id);
          if (!item || !['initiated', 'unknown', 'confirmed'].includes(item.status)) throw opsError('ACTION_NOT_UNCERTAIN', 'Reconciliation must identify initiated actions', 409);
          if (item.accountId && item.accountId !== identity.accountId || item.resourceId && item.resourceId !== identity.resourceId) throw opsError('RECONCILIATION_RESOURCE_MISMATCH', 'Readback identifies a different account/resource than the original effect', 403);
          const original = data.commands.find((entry) => entry.operationId === operation.id && entry.commandId === item.commandId)?.envelope.payload?.actions?.find((entry) => entry.actionId === id);
          const expected = original?.expected || item.expected;
          if (item.effect !== false && (!expected || !payload.result.verification.some((condition) => fingerprint(condition) === fingerprint(expected)))) throw opsError('RECONCILIATION_EXPECTATION_MISMATCH', 'Readback must verify the original effect result, not an unrelated page condition', 409);
          item.status = 'confirmed'; item.verification = safeOperationsValue(payload.result); item.updatedAt = timestamp(now);
        }
        if (operation.status === 'reconcile-required' && !data.actions.some((item) => item.operationId === operation.id && ['initiated', 'unknown'].includes(item.status))) operation.status = 'running';
        return { reconciled: payload.actionIds };
      }
      if (type === 'command-result') {
        if (!record) throw opsError('COMMAND_NOT_RESERVED', 'Result has no reserved command', 409);
        record.status = ['confirmed', 'stopped', 'failed', 'unknown'].includes(payload.status) ? payload.status : 'unknown'; record.reply = safeOperationsValue(payload); record.updatedAt = timestamp(now);
        if (operation.pending === record.commandId) operation.pending = null;
        operation.currentStep = payload.commandId;
        if (payload.needsDecision) addEvent(data, operation, { type: payload.reason || 'decision', dedupeKey: `decision:${record.commandId}`, summary: payload.reason || 'Main Agent decision required', payload: payload.result });
        notify(); return record;
      }
      if (type === 'business-record') { const item = { ...safeOperationsValue(payload), operationId: operation.id, createdAt: timestamp(now) }; data.records.push(item); return item; }
      throw opsError('INVALID_DURABLE_TYPE', 'Unknown durable record type');
    };
    let result;
    if (type === 'authorize') {
      // Quiet watcher/guardian checks read the current revision without rewriting
      // the growing ledger. The initiated journal still revalidates before effects.
      result = apply(await store.read());
      if (result?.operationRejected) result = await store.update((data) => {
        const operation = data.operations.find((item) => item.taskId === taskId);
        if (!operation) throw opsError('OPERATION_NOT_FOUND', 'Worker is not bound to an operation', 404);
        try { checkBudget(operation); }
        catch (error) { return pausedRejection(operation, error); }
        return apply(data);
      });
      else result = safeOperationsValue(result);
    } else result = await store.update(apply);
    return rejectAfterPersistence(result);
  }
  async function events(id, { after = 0, waitMs = 0 } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw opsError('INVALID_EVENT_CURSOR', 'Event cursor/wait is invalid');
    const read = async () => { const data = await store.read(); if (id) find(data, id); const all = data.events.filter((item) => !id || item.operationId === id); const selected = all.filter((item) => item.sequence > after).slice(0, 200); return { events: selected, nextCursor: selected.at(-1)?.sequence || after, pending: all.filter((item) => item.state !== 'handled').length }; };
    let result = await read();
    if (!result.events.length && waitMs) {
      await new Promise((resolve) => { let timer; const done = () => { clearTimeout(timer); listeners.delete(done); resolve(); }; timer = setTimeout(done, waitMs); listeners.add(done); });
      result = await read();
    }
    return result;
  }
  async function action(id, body = {}) {
    if (body.action === 'ack') return store.update((data) => {
      const operation = find(data, id); assertAuthorized(operation, {}, now());
      const event = data.events.find((item) => item.operationId === id && item.id === body.eventId);
      if (!event || Date.parse(event.expiresAt) <= now()) throw opsError('EVENT_EXPIRED_OR_MISSING', 'Event cannot be acknowledged', 409);
      if (event.state === 'pending') { event.state = 'delivered'; event.deliveredAt = timestamp(now); }
      if (event.state !== 'handled') { event.state = 'received'; event.receivedAt = timestamp(now); }
      return event;
    });
    if (body.action === 'decide') {
      await store.update((data) => {
        const operation = find(data, id); assertAuthorized(operation, { authorizationVersion: body.authorizationVersion }, now());
        const event = data.events.find((item) => item.operationId === id && item.id === body.eventId);
        if (!event || event.state !== 'received' || Date.parse(event.expiresAt) <= now()) throw opsError('EVENT_NOT_RECEIVED', 'Decision needs a received, unexpired event', 409);
        if (typeof body.summary !== 'string' || !body.summary.trim()) throw opsError('DECISION_REQUIRED', 'Main Agent decision summary is required');
        event.state = 'handled'; event.handledAt = timestamp(now); operation.decisionSummary = body.summary.slice(0, 2000);
      });
      if (body.command) {
        try { return await command(id, body.command); }
        catch (error) {
          await store.update((data) => { const event = data.events.find((item) => item.operationId === id && item.id === body.eventId); if (event) { event.state = 'received'; delete event.handledAt; event.decisionError = { code: error.code, message: error.message }; } });
          throw error;
        }
      }
      if (body.stop) return action(id, { action: 'stop' });
      return get(id);
    }
    if (body.action === 'reconcile') return command(id, { ...body.command, commandId: body.commandId || body.command?.commandId, kind: 'reconcile', payload: body.payload || body.command?.payload });
    if (body.action === 'update') {
      if (body.showCursor !== undefined && typeof body.showCursor !== 'boolean') throw opsError('INVALID_CURSOR_PREFERENCE', 'showCursor must be a boolean');
      let cursorTaskId;
      await store.update((data) => { const operation = find(data, id); if (body.schedule !== undefined) operation.schedule = validateSchedule(body.schedule); if (body.budgets) operation.budgets = validateBudgets(body.budgets);
        if (body.showCursor !== undefined) {
          if (operation.cursorApplyState === 'pending') throw opsError('CURSOR_UPDATE_PENDING', 'A cursor preference update is awaiting Worker confirmation', 409);
          operation.cursorApplyState = 'pending'; operation.cursorRequested = body.showCursor; cursorTaskId = operation.taskId;
        }
      });
      if (body.showCursor !== undefined) {
        try {
          const result = await taskService.operationControl?.(cursorTaskId, { action: 'cursor', visible: body.showCursor });
          if (result?.applied !== true || result.cursorEnabled !== body.showCursor) throw opsError('CURSOR_APPLY_UNCONFIRMED', 'Worker did not confirm applying this display preference; no business action was retried', 409);
          await store.update((data) => { const operation = find(data, id); operation.runtimeOptions ||= {}; operation.runtimeOptions.showCursor = body.showCursor; operation.cursorEnabled = body.showCursor; operation.cursorApplyState = 'applied'; operation.cursorApplyError = null; });
        } catch (error) {
          await store.update((data) => { const operation = find(data, id); operation.cursorApplyState = 'unconfirmed'; operation.cursorApplyError = error.code || 'CURSOR_APPLY_UNCONFIRMED'; });
          throw error;
        }
      }
      return get(id);
    }
    if (!['pause', 'resume', 'takeover', 'revoke', 'stop'].includes(body.action)) throw opsError('INVALID_OPERATION_ACTION', 'Unknown operation action');
    let taskId; let resumedMode;
    if (body.action === 'resume') {
      const snapshot = await store.read(); const operation = find(snapshot, id);
      if (snapshot.actions.some((item) => item.operationId === id && ['initiated', 'unknown'].includes(item.status))) throw opsError('RECONCILIATION_REQUIRED', 'Resolve uncertain effects before resuming', 409);
      const task = operation.taskId ? await taskService.get(operation.taskId).catch(() => null) : null;
      if (task && !['waiting', 'stopped', 'finished', 'error'].includes(task.state)) throw opsError('COMMAND_IN_PROGRESS', 'Wait for the interrupted command to settle before explicit resume', 409);
    }
    await store.update((data) => {
      const operation = find(data, id); taskId = operation.taskId;
      if (body.action === 'resume') {
        assertAuthorized(operation, {}, now());
        if (data.actions.some((item) => item.operationId === id && ['initiated', 'unknown'].includes(item.status))) throw opsError('RECONCILIATION_REQUIRED', 'Resolve uncertain effects before resuming', 409);
        const selected = selectMode({ modePolicy: operation.modePolicy, mode: body.mode || operation.mode });
        resumedMode = selected.mode;
        operation.cursorEnabled = operation.runtimeOptions?.showCursor ?? selected.mode === 'operations';
        operation.mode = selected.mode; operation.reason = 'explicit-resume'; operation.manualLock = false; operation.status = 'running'; operation.pending = null;
      } else {
        operation.status = body.action === 'revoke' ? 'revoked' : body.action === 'stop' ? 'stopped' : 'paused';
        if (body.action === 'takeover') operation.manualLock = true;
        if (body.action === 'revoke') { operation.authorization.revokedAt = timestamp(now); operation.authorization.version += 1; }
        for (const record of data.commands.filter((item) => item.operationId === id && item.status === 'pending')) record.status = record.delivered ? 'unknown' : 'stopped';
        operation.pending = null;
      }
      operation.updatedAt = timestamp(now);
    });
    if (['stop', 'revoke'].includes(body.action)) { if (taskId) await taskService.stop(taskId); }
    else {
      await taskService.operationControl?.(taskId, { action: body.action, ...(body.action === 'resume' ? { mode: resumedMode } : {}) });
      if (body.action === 'resume') await command(id, { commandId: operationId('resume'), kind: 'control', payload: { action: 'resume', mode: resumedMode } });
      if (body.action === 'resume') {
        const operation = find(await store.read(), id);
        // A recreated Worker receives this preference in its startup config.
        // Do not send a duplicate cursor control before its handler is ready.
        if (operation.taskId === taskId) await taskService.operationControl?.(operation.taskId, { action: 'cursor', visible: operation.cursorEnabled });
      }
    }
    return get(id);
  }
  async function tick() {
    if (ticking || closed) return;
    ticking = true;
    tickFinished = new Promise((resolve) => { finishTick = resolve; });
    try {
      const before = await store.read();
      const pausedTasks = new Set();
      const requiresUpdate = before.operations.some((operation) => operation.status === 'running' && (
        operation.authorization.revokedAt || Date.parse(operation.authorization.expiresAt) <= now() ||
        (operation.schedule && Date.parse(operation.schedule.nextAt) <= now() && (!operation.schedule.expiresAt || Date.parse(operation.schedule.expiresAt) > now())) ||
        (operation.budgets.maxDurationMs != null && now() - Date.parse(operation.createdAt) >= operation.budgets.maxDurationMs) ||
        (!operation.pending && operation.budgets.maxRuns != null && operation.counters.runs >= operation.budgets.maxRuns) ||
        ['inputTokens', 'outputTokens', 'cost'].some((name) => operation.budgets[name] != null && (operation.counters[name] == null || operation.counters[name] >= operation.budgets[name]))));
      if (requiresUpdate) await store.update((data) => {
        for (const operation of data.operations) {
          if (operation.status !== 'running') continue;
          try { assertAuthorized(operation, {}, now()); checkBudget(operation, { admission: !operation.pending }); }
          catch (error) { pausedRejection(operation, error); pausedTasks.add(operation.taskId); addEvent(data, operation, { type: error.code, priority: 'safety', summary: error.message, dedupeKey: error.code }); continue; }
          const due = scheduleDue(operation.schedule, now());
          if (due) {
            operation.schedule = due.next; operation.schedulerDriftMs = due.driftMs;
            if (due.fire) {
              const event = addEvent(data, operation, { type: 'scheduled', dedupeKey: 'schedule:inspection', summary: 'Scheduled inspection requires main Agent decision' });
              event.coalescedTriggers = (event.coalescedTriggers || 0) + 1; event.lastTriggerAt = timestamp(now);
            }
          }
        }
      });
      for (const taskId of pausedTasks) await taskService.operationControl?.(taskId, { action: 'pause', reason: 'OPERATION_BUDGET_OR_AUTHORIZATION' });
      const snapshot = await store.read();
      for (const operation of snapshot.operations) {
        await deliver(operation.id);
        if (!operation.hostAdapter || operation.status !== 'running') continue;
        const event = snapshot.events.find((item) => item.operationId === operation.id && item.state === 'pending' && item.nextAttemptAt <= now() && item.attempts < 5 && Date.parse(item.expiresAt) > now());
        if (!event) continue;
        let permitted = true;
        await store.update((data) => { const live = find(data, operation.id); try { checkBudget(live, { host: true }); } catch (error) { pausedRejection(live, error); permitted = false; return; } live.counters.hostCalls += 1; const item = data.events.find((entry) => entry.id === event.id); item.attempts += 1; item.nextAttemptAt = now() + Math.min(60000, 1000 * 2 ** item.attempts); });
        if (!permitted) { await taskService.operationControl?.(operation.taskId, { action: 'pause', reason: 'OPERATION_BUDGET_EXCEEDED' }); continue; }
        try {
          const receipt = await hostDispatch(operation.hostAdapter, event);
          await store.update((data) => {
            const item = data.events.find((entry) => entry.id === event.id); if (item.state !== 'pending') return;
            item.state = 'delivered'; item.deliveryId = receipt.deliveryId; item.deliveredAt = timestamp(now);
            if (receipt.received === true) { item.state = 'received'; item.receivedAt = timestamp(now); }
            const live = find(data, operation.id);
            for (const name of ['inputTokens', 'outputTokens', 'cost']) if (Number.isFinite(receipt.usage?.[name]) && receipt.usage[name] >= 0) live.counters[name] = (live.counters[name] || 0) + receipt.usage[name];
          });
        } catch { /* durable pending event retains same ID for bounded retry */ }
      }
    } finally { ticking = false; finishTick(); }
  }
  const timer = setInterval(() => { void tick().catch(() => {}); }, tickMs); timer.unref?.();
  taskService.setOperationDurableHandler?.(durable);
  return { start, get, command, events, action, durable, tick, store,
    list: async () => (await store.read()).operations,
    stopAll: async () => { const operations = (await store.read()).operations.filter((item) => !['stopped', 'revoked', 'failed'].includes(item.status)); const results = await Promise.allSettled(operations.map((item) => action(item.id, { action: 'stop' }))); return { scope: 'operations-only', stopped: results.filter((item) => item.status === 'fulfilled').length, failed: results.filter((item) => item.status === 'rejected').length }; },
    close: async () => { closed = true; clearInterval(timer); notify(); await tickFinished; },
    assertUnchanged: () => store.assertUnchanged(), fence: () => { closed = true; clearInterval(timer); store.fence(); notify(); } };
}
