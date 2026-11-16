import path from 'node:path';
import { OperationsStore, operationId, safeOperationsValue } from '../lib/operations-store.mjs';
import { assertAuthorized, fingerprint, opsError, selectMode, validateAuthorization, operationAuthorization } from '../lib/operations-contracts.mjs';
import { actionHasEffect, MAX_BATCH_ACTIONS, normalizeOperationsCommand } from '../lib/operations-actions.mjs';
import { scheduleDue, validateSchedule } from '../lib/operations-scheduler.mjs';
import { dispatchHost } from '../lib/host-dispatch.mjs';
import { validateTransport } from './single-send-transport.mjs';
import { compactOperationsReply } from '../lib/operations-reply.mjs';

const READ_KINDS = new Set(['observe', 'wait', 'screenshot', 'tabs', 'select-tab', 'reconcile']);
const LOCAL_RECEIPT_ACTIONS = new Set(['click', 'hover', 'fill', 'type', 'key', 'select', 'scroll', 'drag', 'navigate', 'back', 'forward', 'reload', 'new-tab', 'close-tab']);
function localReceiptAction(record, actionId, kind) {
  const original = record?.envelope.kind === 'batch' && record.envelope.payload?.actions?.find((item) => item.actionId === actionId);
  if (!record?.delivered || !original || original.effect !== false || !LOCAL_RECEIPT_ACTIONS.has(original.type) || original.transport || original.interaction || kind !== (original.kind || original.type)) throw opsError('INVALID_LOCAL_RECEIPT', 'Local receipts require an originally reserved non-effect primitive', 409);
  return original;
}
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

export function operationsReplyDetail(value = 'compact', command) {
  const detail = command?.payload?.detail ?? command?.payload?.observation?.detail ?? value ?? 'compact';
  if (!['compact', 'full'].includes(detail)) throw opsError('INVALID_REPLY_DETAIL', 'Reply detail must be compact or full');
  return detail;
}
const unresolved = (item) => item.effect !== false && ['initiated', 'unknown'].includes(item.status);
const unresolvedInfo = (item) => ({ actionId: item.actionId, commandId: item.commandId, kind: item.kind,
  accountId: item.accountId, resourceId: item.resourceId, status: item.status, authorizationVersion: item.authorizationVersion,
  pageId: item.pageId, pageVersion: item.pageVersion, expected: item.expected, evidenceRef: item.evidenceRef || null });
const commandReceiptInfo = (item) => ({ commandId: item.commandId, status: item.status,
  ...(Object.hasOwn(item, 'reply') ? { reply: item.reply } : {}), ...(Object.hasOwn(item, 'replyRef') ? { replyRef: item.replyRef } : {}) });
function operationInfo(operation) {
  return { id: operation.id, taskId: operation.taskId, status: operation.status, mode: operation.mode,
    browserSelection: operation.browserSelection ? { kind: operation.browserSelection.kind, profileId: operation.browserSelection.profileId } : undefined,
    ...(operation.profileName ? { profileName: operation.profileName } : {}),
    cursorEnabled: operation.cursorEnabled ?? operation.mode === 'operations', cursorApplyState: operation.cursorApplyState || 'initial',
    cursorRequested: operation.cursorRequested ?? operation.cursorEnabled ?? operation.mode === 'operations',
    ...(operation.cursorApplyError ? { cursorApplyError: operation.cursorApplyError } : {}), manualLock: operation.manualLock,
    currentStep: operation.currentStep, pending: operation.pending, nextTrigger: operation.nextTrigger,
    authorizationVersion: operation.authorization.version, authorizationScope: operation.authorization.scope, authorizationLimits: operation.authorization.limits,
    accountId: operation.authorization.accountId,
    authorizationExpiresAt: operation.authorization.expiresAt, authorizationRevokedAt: operation.authorization.revokedAt,
    pauseReason: operation.pauseReason || null, ...(operation.error ? { error: operation.error } : {}),
    budgets: operation.budgets, counters: operation.counters };
}
const taskInfo = (task) => task ? { id: task.id, state: task.state, waiting: task.waiting, error: task.error,
  ...(task.profileId ? { profileId: task.profileId } : {}), ...(task.profileName ? { profileName: task.profileName } : {}) } : null;
function compactWire(value, { id = value.operationId || value.id, commandId = value.commandId || value.command?.commandId, event = false, maxChars } = {}) {
  try { return compactOperationsReply(value, maxChars ? { maxChars } : undefined); }
  catch (error) {
    // Formatting is after execution/commit. Never turn a real receipt into an
    // ordinary rejected request that could encourage replay under a fresh ID.
    const command = value.command || value;
    const after = event ? Math.max(0, Number(value.sequence) - 1) : null;
    const pointer = event ? `/v1/operations/${encodeURIComponent(id)}/events?after=${after}&detail=full` :
      `/v1/operations/${encodeURIComponent(id)}?${commandId ? `commandId=${encodeURIComponent(commandId)}&` : ''}detail=full`;
    const identity = {}, missing = [];
    const small = (source, target, key, field = key) => {
      if (!Object.hasOwn(source, key)) return;
      const current = source[key];
      if (current === null || typeof current === 'boolean' || typeof current === 'number' && Number.isFinite(current) || typeof current === 'string' && current.length <= 256) target[key] = current;
      else if (current !== undefined) missing.push(field);
    };
    for (const key of ['profileName', 'authorizationVersion', 'authorizationScope', 'accountId', 'authorizationExpiresAt', 'authorizationRevokedAt']) small(value, identity, key);
    if (value.browserSelection) {
      const selected = {}; small(value.browserSelection, selected, 'kind', 'browserSelection.kind'); small(value.browserSelection, selected, 'profileId', 'browserSelection.profileId');
      if (Object.keys(selected).length) identity.browserSelection = selected;
    }
    if (value.task) {
      const selected = {}; small(value.task, selected, 'profileId', 'task.profileId'); small(value.task, selected, 'profileName', 'task.profileName');
      if (Object.keys(selected).length) identity.task = selected;
    }
    if (value.authorizationLimits !== undefined) {
      if (JSON.stringify(value.authorizationLimits).length <= 512) identity.authorizationLimits = value.authorizationLimits;
      else missing.push('authorizationLimits');
    }
    return { ...(error.compactReceipt || {}), ...(event ? { id: value.id, sequence: value.sequence, type: value.type, priority: value.priority, state: value.state, summary: value.summary } : {}),
      ...identity, ...(missing.length ? { missingContext: { fields: missing, fullReadRequired: true } } : {}),
      operationId: id, ...(commandId ? { commandId } : {}), status: command.reply?.status || command.status || value.status,
      ...(value.operationStatus || value.command ? { operationStatus: value.operationStatus || value.status } : {}),
      ...(value.pending !== undefined ? { pending: value.pending } : {}), ...(value.manualLock !== undefined ? { manualLock: value.manualLock } : {}),
      ...(value.pauseReason ? { pauseReason: value.pauseReason } : {}), ...(value.storageFailure ? { storageFailure: value.storageFailure } : {}),
      ...(value.reason ? { outcomeReason: value.reason } : {}),
      ...(value.unresolvedActions ? { unresolvedActions: value.unresolvedActions.map((item) => ({ actionId: item.actionId, commandId: item.commandId, status: item.status,
        authorizationVersion: item.authorizationVersion, pageId: item.pageId, pageVersion: item.pageVersion })) } : {}),
      needsDecision: true, reason: error.code === 'CONTEXT_INSUFFICIENT' ? 'OUTPUT_CONTEXT_INSUFFICIENT' : 'OUTPUT_FORMAT_FAILED', fullReceiptRequired: true,
      fullReceipt: { method: 'GET', path: pointer, command: event ? `ops events ${id} --after ${after} --detail full` : `ops get ${id}${commandId ? ` --command ${commandId}` : ''} --detail full` } };
  }
}
function receiptReadError(error, id, record, context = {}) {
  const code = typeof error.code === 'string' ? error.code : 'COMMAND_RECEIPT_READ_FAILED';
  const receipt = safeOperationsValue({ operationId: id, commandId: record.commandId, status: record.status,
    statusSource: context.statusSource || 'committed-command-metadata',
    ...(context.taskId ? { taskId: context.taskId } : {}), ...(context.status ? { operationStatus: context.status } : {}),
    ...(context.pending !== undefined ? { pending: context.pending } : {}), ...(context.manualLock !== undefined ? { manualLock: context.manualLock } : {}),
    ...(context.pauseReason ? { pauseReason: context.pauseReason } : {}),
    ...(context.unresolvedActions ? { unresolvedActions: context.unresolvedActions.map((item) => ({ actionId: item.actionId, commandId: item.commandId,
      status: item.status, authorizationVersion: item.authorizationVersion, pageId: item.pageId, pageVersion: item.pageVersion })), unresolvedActionCount: context.unresolvedActions.length } : {}),
    needsDecision: true, reason: 'COMMAND_RECEIPT_UNAVAILABLE', receiptUnavailable: true, evidenceAvailable: false,
    storageFailure: { code, message: 'Stored command evidence cannot currently be read; its absence is not proof that the command was not executed' },
    storageRecovery: { required: true, requiresOwnerRecovery: true, automationMayProceed: false, retryCommand: false,
      operationId: id, commandId: record.commandId, code, instruction: 'Retain the current state and recover its original evidence before further automation; do not submit the command again' } });
  // Preserve the original storage error code for read-only/full APIs. POST
  // presentation uses this bounded receipt without changing persisted truth.
  error.operationReceipt = receipt;
  error.details = { ...(error.details && typeof error.details === 'object' ? error.details : {}), operationReceipt: receipt };
  return error;
}

export async function createOperationsService({ stateDir, taskService, profileStore, now = Date.now, tickMs = 500, hostDispatch = dispatchHost, storeOptions = {} }) {
  const store = await new OperationsStore({ stateDir: path.join(stateDir, 'operations'), now, ...storeOptions }).init();
  await store.recover();
  let closed = false; let ticking = false; let tickFinished = Promise.resolve(); let finishTick = () => {};
  const dispatching = new Set(); const redispatch = new Set(); const listeners = new Set();
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
  async function get(id, { commandId = null, detail = 'full' } = {}) {
    operationsReplyDetail(detail);
    const compact = detail === 'compact';
    const data = await store.project((data) => {
      const operation = find(data, id), commands = data.commands.filter((item) => item.operationId === id);
      const actions = data.actions.filter((item) => item.operationId === id);
      const selected = commandId ? commands.filter((item) => item.commandId === commandId) : compact ? commands.filter((item) => item.commandId === operation.pending || item === commands.at(-1)) : commands;
      return { operation: compact ? operationInfo(operation) : operation, commands: compact && !commandId ? selected.map((item) => ({
        commandId: item.commandId, status: item.status, delivered: item.delivered, replyAvailable: Boolean(item.reply || item.replyRef),
        fullEvidence: `ops get ${id} --command ${item.commandId} --detail full`
      })) : commandId ? selected.map(commandReceiptInfo) : selected,
        actions: commandId || compact ? actions.filter(unresolved).map(unresolvedInfo) : actions,
        records: commandId || compact ? [] : data.records.filter((item) => item.operationId === id), storageFailure: data.storageFailure,
        completedActionCount: actions.filter((item) => !['initiated', 'unknown'].includes(item.status)).length,
        otherCommandCount: commands.length - selected.length,
        businessRecordCount: data.records.filter((item) => item.operationId === id).length };
    });
    const operation = data.operation;
    if (!compact || commandId) {
      try { data.commands = await store.hydrateCommands(data.commands); }
      catch (error) {
        if (commandId && data.commands[0]) throw receiptReadError(error, id, data.commands[0], { ...operation, unresolvedActions: data.actions });
        throw error;
      }
    }
    const task = operation.taskId ? await taskService.get(operation.taskId).catch(() => null) : null;
    if (commandId) {
      const command = data.commands[0];
      if (!command) throw opsError('COMMAND_NOT_FOUND', 'Command was not found', 404);
      const result = { id, taskId: operation.taskId, ...(!compact ? { goal: operation.goal } : {}), status: operation.status, mode: operation.mode, cursorEnabled: operation.cursorEnabled ?? operation.mode === 'operations',
        ...(compact ? { browserSelection: operation.browserSelection, authorizationScope: operation.authorizationScope, authorizationLimits: operation.authorizationLimits,
          ...(operation.profileName ? { profileName: operation.profileName } : {}) } : {}),
        cursorApplyState: operation.cursorApplyState || 'initial', cursorRequested: operation.cursorRequested ?? operation.cursorEnabled ?? operation.mode === 'operations', manualLock: operation.manualLock,
        authorizationVersion: compact ? operation.authorizationVersion : operation.authorization.version, accountId: compact ? operation.accountId : operation.authorization.accountId,
        ...(!compact ? { resourceIds: operation.authorization.resourceIds } : {}),
        pending: operation.pending, pauseReason: operation.pauseReason || null, storageFailure: data.storageFailure || null,
        task: taskInfo(task),
        command: { commandId: command.commandId, status: command.status, reply: command.reply || null },
        unresolvedActions: data.actions, ...(compact ? { unresolvedActionCount: data.actions.length } : {}),
        omitted: { completedActionCount: data.completedActionCount,
          otherCommandCount: data.otherCommandCount,
          businessRecordCount: data.businessRecordCount, fullEvidence: `ops get ${id} --detail full` } };
      return compact ? compactWire(result, { id, commandId }) : result;
    }
    if (compact) return compactWire({ ...operation, task: taskInfo(task),
      storageFailure: data.storageFailure || null, unresolvedActions: data.actions, unresolvedActionCount: data.actions.length,
      commands: data.commands,
      omitted: { completedActionCount: data.completedActionCount, otherCommandCount: data.otherCommandCount, businessRecordCount: data.businessRecordCount, fullEvidence: `ops get ${id} --detail full` } }, { id });
    return { ...operation, task, storageFailure: data.storageFailure || null, actions: data.actions,
      commands: data.commands, records: data.records,
      hostCapability: operation.hostAdapter ? 'configured-adapter-unverified-native-host' : 'active-wait-only; session-ended/app-closed adapter-required' };
  }
  async function start(body = {}, { detail = 'full' } = {}) {
    operationsReplyDetail(detail);
    if (closed) throw opsError('OPERATIONS_CLOSED', 'Operations service is closing', 503);
    const browserSelection = body.browserSelection;
    if (browserSelection && browserSelection.kind !== 'profile') throw opsError('INVALID_BROWSER_SELECTION', 'Task Master uses its own Profiles; select profileId or use the saved default');
    const profileIdentifier = body.profileId || body.profile || browserSelection?.profileId;
    const profile = profileIdentifier ? await profileStore.get(profileIdentifier) : await profileStore.getDefault?.();
    if (!profile) throw opsError('DEFAULT_PROFILE_REQUIRED', 'Choose an existing Task Master Profile or set its default in the Dashboard', 409);
    const authorization = operationAuthorization(body.authorization, profile.id, now());
    authorization.id = operationId('auth'); authorization.version = 1; authorization.grantedAt = timestamp(now); authorization.revokedAt = null;
    const selected = selectMode({ modePolicy: profile.modePolicy || 'auto', mode: body.mode, skillMode: body.skillMode, intent: body.intent || 'waiting' });
    if (body.hostAdapter && (!path.isAbsolute(body.hostAdapter.executable || '') || !Array.isArray(body.hostAdapter.args))) throw opsError('INVALID_HOST_ADAPTER', 'Host adapter requires an explicit absolute executable and argument array');
    const budgets = validateBudgets(body.budgets);
    if (body.showCursor !== undefined && typeof body.showCursor !== 'boolean') throw opsError('INVALID_CURSOR_PREFERENCE', 'showCursor must be a boolean');
    if (body.singleSendTransport !== undefined && typeof body.singleSendTransport !== 'boolean') throw opsError('INVALID_TRANSPORT_POLICY', 'singleSendTransport must be an explicit boolean');
    const operation = { id: operationId(), taskId: null, goal: String(body.goal || '').slice(0, 2000), businessKind: body.businessKind || 'general',
      browserSelection: { kind: 'profile', profileId: profile.id }, ...(profile.name ? { profileName: profile.name } : {}), authorization, ...selected, modePolicy: profile.modePolicy || 'auto', manualLock: false,
      currentStep: null, completedActionIds: [], pending: null, nextTrigger: null, decisionSummary: '', status: 'running',
      budgets, counters: { runs: 0, hostCalls: 0, inputTokens: null, outputTokens: null, cost: null, retries: 0 },
      cursorEnabled: body.showCursor ?? selected.mode === 'operations', singleSendTransport: body.singleSendTransport === true,
      identity: body.identity || null, runtimeOptions: { singleSendTransport: body.singleSendTransport === true, businessContext: body.businessContext, commandLimit: body.commandLimit, safetyConditions: body.safetyConditions, ...(body.showCursor === undefined ? {} : { showCursor: body.showCursor }) },
      schedule: validateSchedule(body.schedule), hostAdapter: body.hostAdapter || null, createdAt: timestamp(now), updatedAt: timestamp(now) };
    await store.update((data) => { data.operations.push(operation); });
    try {
      const task = await taskService.createOperation({ profileId: profile.id, label: body.label || body.goal || 'Operations session',
        input: { ...operation.runtimeOptions, showCursor: operation.cursorEnabled, operationId: operation.id, businessKind: operation.businessKind, authorization, identity: operation.identity, browserSelection: operation.browserSelection, mode: operation.mode, initialUrl: body.initialUrl },
        mode: operation.mode, modeReason: operation.reason, outputBudget: body.outputBudget || {}, timeoutMs: body.timeoutMs ?? null });
      await store.update((data) => { find(data, operation.id).taskId = task.id; });
      return get(operation.id, { detail });
    } catch (error) {
      await store.update((data) => { const item = find(data, operation.id); item.status = 'failed'; item.error = { code: error.code, message: error.message }; });
      throw error;
    }
  }
  async function waitCommand(id, commandId, waitMs = 30000, { detail = 'full' } = {}) {
    operationsReplyDetail(detail);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw opsError('INVALID_COMMAND_WAIT', 'Command wait must be 0-30000 milliseconds');
    const deadline = Date.now() + waitMs;
    const read = () => store.project((data) => {
      const operation = find(data, id), command = data.commands.find((item) => item.operationId === id && item.commandId === commandId);
      if (!command) throw opsError('COMMAND_NOT_FOUND', 'Command was not found', 404);
      return { taskId: operation.taskId, status: operation.status, pending: operation.pending, pauseReason: operation.pauseReason || null,
        storageFailure: data.storageFailure || null, manualLock: operation.manualLock,
        command: commandReceiptInfo(command),
        unresolvedActions: data.actions.filter((item) => item.operationId === id && unresolved(item)).map(unresolvedInfo) };
    });
    let snapshot = await read();
    while (!snapshot.command.reply && !snapshot.command.replyRef && !closed && Date.now() < deadline) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); listeners.delete(done); resolve(); };
        const timer = setTimeout(done, Math.max(1, deadline - Date.now()));
        listeners.add(done);
        // A result can commit between the read above and listener registration.
        void store.project((data) => data.commands.some((item) => item.operationId === id && item.commandId === commandId && (item.reply || item.replyRef))).then((replied) => { if (replied) done(); }, done);
      });
      snapshot = await read();
    }
    try { snapshot.command = await store.hydrateCommand(snapshot.command); }
    catch (error) { throw receiptReadError(error, id, snapshot.command, snapshot); }
    const result = { ...snapshot.command.reply, commandId, operationId: id, taskId: snapshot.taskId,
      status: snapshot.command.reply?.status || snapshot.command.status, operationStatus: snapshot.status,
      pending: snapshot.pending, unresolvedActions: snapshot.unresolvedActions, unresolvedActionCount: snapshot.unresolvedActions.length, pauseReason: snapshot.pauseReason,
      ...(snapshot.manualLock ? { manualLock: true } : {}), ...(snapshot.storageFailure ? { storageFailure: snapshot.storageFailure } : {}) };
    return detail === 'compact' ? compactWire(result, { id, commandId }) : result;
  }
  async function commandReply(id, record, { waitMs = 0, detail = 'full' } = {}) {
    operationsReplyDetail(detail);
    try {
      if (detail === 'full' && !waitMs) return await store.hydrateCommand(record);
      const result = await waitCommand(id, record.commandId, waitMs, { detail });
      return record.status === 'pending' && !waitMs ? { ...result, delivered: record.delivered } : result;
    } catch (error) {
      return error.operationReceipt || receiptReadError(error, id, record, { statusSource: record.status === 'pending' ? 'last-known-reservation' : 'committed-command-metadata' }).operationReceipt;
    }
  }
  async function command(id, body = {}) {
    if (closed) throw opsError('OPERATIONS_CLOSED', 'Operations service is closing', 503);
    body = normalizeOperationsCommand(body);
    if (!body || typeof body !== 'object') throw opsError('INVALID_COMMAND', 'Command must be a JSON object');
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(body.commandId || '')) throw opsError('INVALID_COMMAND_ID', 'A stable commandId is required');
    if (![...READ_KINDS, 'batch', 'control'].includes(body.kind) || Buffer.byteLength(JSON.stringify(body)) > 128 * 1024) throw opsError('INVALID_COMMAND', 'Unknown or oversized command');
    if (body.kind === 'batch' && (!Array.isArray(body.payload?.actions) || !body.payload.actions.length || body.payload.actions.length > MAX_BATCH_ACTIONS)) throw opsError('INVALID_BATCH', `Batch must contain 1-${MAX_BATCH_ACTIONS} actions`);
    const candidateTaskId = await store.project((data) => find(data, id).taskId);
    const candidateTask = candidateTaskId && typeof taskService.get === 'function' ? await taskService.get(candidateTaskId).catch(() => null) : null;
    const candidateWaiting = candidateTask?.state === 'waiting' && candidateTask.waiting?.reason === 'operations-command' && typeof candidateTask.waiting.id === 'string';
    let immediateDelivery, previousReceiptContext, createdReservation = false, ownsDispatch = candidateWaiting && !dispatching.has(id);
    if (ownsDispatch) dispatching.add(id);
    try {
    const result = await store.update((data) => {
      const operation = find(data, id);
      if (body.kind === 'batch') for (const action of body.payload.actions) {
        const writes = !['read', 'locate', 'wait'].includes(action.type) && action.effect !== false;
        if (action.transport && !operation.singleSendTransport) throw opsError('TRANSPORT_NOT_ENABLED', 'Explicit singleSendTransport is required for transport guards');
        if (operation.singleSendTransport && writes) {
          if (!['click', 'fill', 'select', 'key'].includes(action.type)) throw opsError('TRANSPORT_ACTION_UNSUPPORTED', 'Explicitly mark non-effect navigation/scroll; only known JSON UI submissions can be guarded');
          validateTransport(action.transport, { origins: operation.authorization.origins });
        } else if (action.transport) throw opsError('INVALID_TRANSPORT_GUARD', 'Transport guards belong only to external-effect actions');
      }
      const previous = data.commands.find((item) => item.operationId === id && item.commandId === body.commandId);
      const hash = fingerprint(body);
      if (previous) {
        if (previous.fingerprint !== hash) throw opsError('COMMAND_ID_CONFLICT', 'commandId is already reserved for a different payload', 409);
        previousReceiptContext = { taskId: operation.taskId, status: operation.status, pending: operation.pending, manualLock: operation.manualLock, pauseReason: operation.pauseReason,
          unresolvedActions: data.actions.filter((item) => item.operationId === id && unresolved(item)).map(unresolvedInfo) };
        return previous;
      }
      const dialogAcknowledgement = body.kind === 'control' && body.payload?.action === 'acknowledge-dialog';
      const inspectionBatch = operation.status === 'reconcile-required' && body.kind === 'batch' && !body.payload.actions.some(actionHasEffect);
      if (operation.status !== 'running' && !inspectionBatch && !(['reconcile-required', 'paused'].includes(operation.status) && (READ_KINDS.has(body.kind) || dialogAcknowledgement))) throw opsError('OPERATION_NOT_RUNNING', `Operation is ${operation.status}`, 409);
      assertAuthorized(operation, { ...body, kind: body.kind === 'batch' ? undefined : body.kind }, now());
      if (operation.manualLock && !READ_KINDS.has(body.kind) && body.kind !== 'control') throw opsError('MANUAL_TAKEOVER', 'Human owns this page; explicitly resume before automation', 409);
      if (operation.pending) throw opsError('COMMAND_IN_PROGRESS', 'One command is already reserved; retrieve its result before issuing another', 409);
      if (body.kind === 'batch' && body.payload.actions.some(actionHasEffect) && data.actions.some((item) => item.operationId === id && item.effect !== false && ['initiated', 'unknown'].includes(item.status))) throw opsError('RECONCILIATION_REQUIRED', 'Read back uncertain external effects before another effect; observation and non-effect actions remain available', 409);
      if (!READ_KINDS.has(body.kind) || operation.status === 'running') {
        try { checkBudget(operation, { admission: true }); }
        catch (error) { return pausedRejection(operation, error); }
      }
      const envelope = { schemaVersion: 1, ...safeOperationsValue(body), operationId: id, authorizationVersion: operation.authorization.version };
      const delivered = ownsDispatch && operation.taskId === candidateTaskId;
      const record = { operationId: id, commandId: body.commandId, fingerprint: hash, envelope, status: 'pending', delivered, createdAt: timestamp(now) };
      createdReservation = true;
      data.commands.push(record); operation.pending = body.commandId; operation.counters.runs += 1; operation.updatedAt = timestamp(now);
      if (delivered) immediateDelivery = { commandId: body.commandId, taskId: candidateTaskId, waitId: candidateTask.waiting.id };
      return record;
    });
    await rejectAfterPersistence(result);
    if (!createdReservation) {
      // A stable ID is a receipt lookup, never permission to restart a stopped
      // Profile. Only its existing, undelivered reservation may be handed off.
      if (ownsDispatch) { ownsDispatch = false; releaseDispatch(id); }
      if (result.status === 'pending' && result.delivered !== true) await deliver(id);
      try { return await store.hydrateCommand(result); }
      catch (error) { throw receiptReadError(error, id, result, previousReceiptContext); }
    }
    if (immediateDelivery) { await deliverReserved(id, immediateDelivery); return result; }
    const current = await store.project((data) => ({ operations: data.operations.filter((item) => item.id === id),
      actions: data.actions.filter((item) => item.operationId === id && item.effect !== false && ['initiated', 'unknown'].includes(item.status)) })); const operation = find(current, id);
    const oldTask = operation.taskId ? await taskService.get(operation.taskId).catch(() => null) : null;
    if (!oldTask || ['stopped', 'error', 'finished'].includes(oldTask.state)) {
      const task = await taskService.createOperation({ profileId: operation.browserSelection.profileId, label: operation.goal || 'Recovered operations',
        input: { ...operation.runtimeOptions, browserSelection: operation.browserSelection, showCursor: operation.cursorEnabled ?? operation.mode === 'operations', operationId: id, businessKind: operation.businessKind, authorization: operation.authorization, identity: operation.identity, mode: operation.mode,
          reconcileRequired: current.actions.some((item) => item.operationId === id && item.effect !== false && ['initiated', 'unknown'].includes(item.status)),
          completedActionIds: operation.completedActionIds }, mode: operation.mode, modeReason: 'recovered-reconciliation' });
      await store.update((data) => { const operation = find(data, id); operation.taskId = task.id; operation.cursorApplyState = 'initial'; operation.cursorRequested = operation.cursorEnabled ?? operation.mode === 'operations'; operation.cursorApplyError = null; });
    }
    if (ownsDispatch) { ownsDispatch = false; releaseDispatch(id); }
    await deliver(id); return result;
    } finally { if (ownsDispatch) releaseDispatch(id); }
  }
  function releaseDispatch(id) {
    dispatching.delete(id);
    if (redispatch.delete(id) && !closed) void deliver(id).catch(() => {});
  }
  async function deliveryFailed(id, commandId, error) {
    const pauseTask = await store.update((data) => {
      const operation = find(data, id), record = data.commands.find((item) => item.operationId === id && item.commandId === commandId);
      // A result can win an uncertain IPC acknowledgement race. Its committed
      // terminal truth must not be replaced with an artificial unknown.
      if (!record || record.status !== 'pending') return null;
      record.status = 'unknown'; record.updatedAt = timestamp(now);
      if (operation.pending === commandId) operation.pending = null;
      const terminal = ['stopped', 'revoked', 'failed'].includes(operation.status);
      if (!terminal) operation.status = 'reconcile-required';
      addEvent(data, operation, { type: 'disconnection', priority: 'safety', summary: error.message, dedupeKey: `delivery:${commandId}` });
      return terminal ? null : operation.taskId;
    });
    if (pauseTask) await taskService.operationControl?.(pauseTask, { action: 'pause', reason: 'DELIVERY_UNCONFIRMED' });
  }
  async function deliverReserved(id, reservation) {
    try {
      // A single durable transaction reserved both the command and its one IPC
      // attempt. Re-read authority after commit; never treat this as a grant.
      const data = await store.project((data) => ({ operations: data.operations.filter((item) => item.id === id),
        commands: data.commands.filter((item) => item.operationId === id && item.commandId === reservation.commandId) }));
      const operation = find(data, id), record = data.commands[0], envelope = record?.envelope;
      const dialogAcknowledgement = envelope?.kind === 'control' && envelope.payload?.action === 'acknowledge-dialog';
      const inspectionBatch = operation.status === 'reconcile-required' && envelope?.kind === 'batch' && !envelope.payload.actions.some(actionHasEffect);
      if (!record || record.status !== 'pending' || record.delivered !== true || operation.pending !== reservation.commandId || operation.taskId !== reservation.taskId) throw opsError('COMMAND_NOT_RESERVED', 'The reserved handoff is no longer current', 409);
      if (operation.status !== 'running' && !inspectionBatch && !(['reconcile-required', 'paused'].includes(operation.status) && (READ_KINDS.has(envelope.kind) || dialogAcknowledgement))) throw opsError('OPERATION_NOT_RUNNING', `Operation is ${operation.status}`, 409);
      assertAuthorized(operation, { ...envelope, kind: envelope.kind === 'batch' ? undefined : envelope.kind }, now());
      if (operation.manualLock && !READ_KINDS.has(envelope.kind) && envelope.kind !== 'control') throw opsError('MANUAL_TAKEOVER', 'Human owns this page; explicitly resume before automation', 409);
      await taskService.resume(reservation.taskId, envelope, { waitId: reservation.waitId });
    } catch (error) {
      await deliveryFailed(id, reservation.commandId, error);
    }
  }
  async function deliver(id) {
    if (closed) return;
    if (dispatching.has(id)) { redispatch.add(id); return; }
    dispatching.add(id);
    try {
      const data = await store.project((data) => {
        const operation = data.operations.find((item) => item.id === id);
        return { operations: operation ? [operation] : [],
          commands: operation ? data.commands.filter((item) => item.operationId === id && item.commandId === operation.pending && !item.delivered) : [] };
      }); const operation = find(data, id);
      const record = data.commands.find((item) => item.operationId === id && item.commandId === operation.pending && !item.delivered);
      if (!record || !['running', 'paused', 'reconcile-required'].includes(operation.status)) return;
      assertAuthorized(operation, { ...record.envelope, kind: record.envelope.kind === 'batch' ? undefined : record.envelope.kind }, now());
      const task = await taskService.get(operation.taskId);
      if (task.state !== 'waiting' || task.waiting?.reason !== 'operations-command') return;
      // Reservation is durable before IPC; failure is unknown, never automatically resent.
      await store.update((current) => { current.commands.find((item) => item.operationId === id && item.commandId === record.commandId).delivered = true; });
      try { await taskService.resume(task.id, record.envelope, { waitId: task.waiting.id }); }
      catch (error) {
        await deliveryFailed(id, record.commandId, error);
      }
    } finally {
      releaseDispatch(id);
    }
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
        if (payload.localReceipt === true) localReceiptAction(record, payload.actionId, payload.kind);
        const readOnlyControl = payload.kind === 'control' && payload.effect === false && !payload.actionId && record?.envelope.kind === 'control' && record.envelope.payload?.action === 'acknowledge-dialog';
        const background = payload.backgroundRead === true && payload.effect === false && READ_KINDS.has(payload.kind) && ['observe', 'wait'].includes(record?.envelope.kind) && record.status === 'confirmed' && !payload.actionId && payload.proposed === undefined && payload.primitive === undefined;
        const preparation = payload.effect === false && record?.envelope.kind === 'batch' && record.envelope.payload.actions.some((item) => item.actionId === payload.actionId && !actionHasEffect(item));
        if (!record || record.status !== 'pending' && !background) throw opsError('COMMAND_NOT_RESERVED', 'Command has no active durable reservation', 409);
        if (operation.status !== 'running' && (background || !(READ_KINDS.has(payload.kind) || readOnlyControl || preparation && operation.status === 'reconcile-required') || !['paused', 'reconcile-required'].includes(operation.status))) throw opsError('OPERATION_NOT_RUNNING', 'Operation is paused or requires reconciliation', 409);
        const authorization = assertAuthorized(operation, payload, now());
        if (operation.manualLock && !(READ_KINDS.has(payload.kind) || readOnlyControl)) throw opsError('MANUAL_TAKEOVER', 'Manual takeover prevents automated effects', 409);
        if (!(READ_KINDS.has(payload.kind) || readOnlyControl || preparation) && payload.primitive !== 'navigate' && (!payload.accountId || !payload.resourceId || !payload.origin)) throw opsError('IDENTITY_EVIDENCE_REQUIRED', 'An effect needs account/resource/origin context', 403);
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
        if (previous && (previous.localReceipt || payload.localReceipt === true || ['initiated', 'confirmed', 'unknown'].includes(previous.status)) || payload.localReceipt === true && operation.completedActionIds.includes(payload.actionId)) throw opsError('ACTION_ALREADY_INITIATED', 'Read back and reconcile this action; do not replay', 409);
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
          action = { ...safeOperationsValue(payload), expected: original.expected || null, effect: original.effect !== false, interaction: original.interaction || null, transport: original.transport || null,
            operationId: operation.id, authorizationVersion: operation.authorization.version, createdAt: timestamp(now) };
          if (action.kind === 'social.reply') action.socialInteractionKey = socialKey(action.accountId, action.resourceId, original.interaction, original.expected.text);
          data.actions.push(action);
        } else {
          const next = { prepared: ['initiated', 'failed'], initiated: ['confirmed', 'unknown', 'failed'], unknown: [], confirmed: [], failed: [] }[action.status];
          if (!next?.includes(payload.status)) throw opsError('INVALID_ACTION_TRANSITION', 'Action transition or replay rejected', 409);
          if (payload.status === 'initiated') {
            assertAuthorized(operation, payload, now());
            if (operation.status !== 'running' && !(operation.status === 'reconcile-required' && action.effect === false) || operation.manualLock) throw opsError('MANUAL_TAKEOVER', 'Operation is not authorized for automated effects', 409);
            if (action.socialInteractionKey && data.actions.some((item) => item !== action && item.socialInteractionKey === action.socialInteractionKey && ['initiated', 'confirmed', 'unknown'].includes(item.status))) throw opsError('SOCIAL_INTERACTION_DUPLICATE', 'The same reply target and content were already initiated', 409);
          }
          Object.assign(action, safeOperationsValue(payload), { operationId: operation.id, expected: action.expected, interaction: action.interaction, effect: action.effect, socialInteractionKey: action.socialInteractionKey,
            kind: action.kind, accountId: action.accountId, resourceId: action.resourceId, proposed: action.proposed, before: action.before, businessKey: action.businessKey, transport: action.transport, transportForward: action.transportForward,
            ...(action.transport ? { pageId: action.pageId, pageVersion: action.pageVersion } : {}) });
        }
        action.updatedAt = timestamp(now);
        if (action.status === 'initiated') action.startedAt = timestamp(now);
        if (action.status === 'confirmed') { action.confirmedAt = timestamp(now); operation.completedActionIds.push(action.actionId); }
        if (action.status === 'unknown') addEvent(data, operation, { type: 'write-result-unknown', priority: 'safety', dedupeKey: `unknown:${action.actionId}`, summary: 'External effect needs readback reconciliation', actionId: action.actionId });
        return action;
      }
      if (type === 'event') return addEvent(data, operation, payload);
      if (type === 'transport-forward') {
        if (!operation.singleSendTransport || operation.browserSelection?.kind !== 'profile' || operation.status !== 'running' || operation.manualLock || !record || record.status !== 'pending') throw opsError('TRANSPORT_NOT_AUTHORIZED', 'Single-send forwarding requires the live explicitly opted-in owned operation', 409);
        checkBudget(operation);
        const original = record.envelope.payload?.actions?.find((item) => item.actionId === payload.actionId);
        const action = data.actions.find((item) => item.operationId === operation.id && item.actionId === payload.actionId && item.commandId === payload.commandId);
        if (!original || original.effect === false || !action || action.status !== 'initiated' || action.transportForward) throw opsError('TRANSPORT_FORWARD_ALREADY_CONSUMED', 'Forwarding requires the original durably initiated action and an unused budget', 409);
        const guard = validateTransport(original.transport, { origins: operation.authorization.origins });
        assertAuthorized(operation, { ...payload, kind: action.kind }, now());
        if (payload.accountId !== action.accountId || payload.resourceId !== action.resourceId || payload.pageId !== action.pageId || payload.pageId !== record.envelope.pageId || action.kind !== (original.kind || original.type) ||
            !documentEpoch(action.pageVersion) || documentEpoch(action.pageVersion) !== documentEpoch(record.envelope.pageVersion) || documentEpoch(action.pageVersion) !== documentEpoch(payload.pageVersion) ||
            payload.url !== guard.url || payload.origin !== new URL(guard.url).origin || payload.method !== 'POST' || payload.bodySha256 !== guard.bodySha256 || !Number.isSafeInteger(payload.bodyBytes) || payload.bodyBytes < 2 || payload.bodyBytes > guard.maxBodyBytes || action.authorizationVersion !== operation.authorization.version) throw opsError('TRANSPORT_BINDING_MISMATCH', 'Forward metadata does not match original page/account/resource/body authorization', 403);
        action.transportForward = { at: timestamp(now), url: guard.url, method: 'POST', bodySha256: payload.bodySha256, bodyBytes: payload.bodyBytes, pageId: payload.pageId, pageVersion: payload.pageVersion, authorizationVersion: operation.authorization.version };
        return { acknowledged: true, authorization: operation.authorization, transportForward: action.transportForward };
      }
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
        const outcome = payload.result.outcome || 'applied';
        if (!['applied', 'not-applied'].includes(outcome)) throw opsError('INVALID_RECONCILIATION_OUTCOME', 'Readback outcome must be applied or not-applied');
        const declared = record.envelope.payload;
        if (outcome !== (declared.outcome || 'applied') || (payload.result.reason || '') !== (typeof declared.reason === 'string' ? declared.reason.trim() : '')) throw opsError('RECONCILIATION_DECISION_MISMATCH', 'Readback outcome/reason must match the Agent reserved reconciliation decision');
        if (!Array.isArray(declared.verify) || fingerprint(payload.result.verification) !== fingerprint(declared.verify)) throw opsError('RECONCILIATION_EXPECTATION_MISMATCH', 'Readback checks differ from the Agent reserved conditions');
        const explained = typeof payload.result.reason === 'string' && payload.result.reason.trim().length > 0 && payload.result.reason.length <= 2000;
        if (outcome === 'not-applied' && !explained) throw opsError('RECONCILIATION_REASON_REQUIRED', 'A confirmed not-applied result requires the Agent reason and actual task-specific readback');
        let origin; try { origin = new URL(payload.result.url).origin; } catch { throw opsError('RECONCILIATION_SCOPE_REQUIRED', 'Readback requires current URL and observed account/resource identity', 403); }
        if (!identity?.accountId || !identity.resourceId) throw opsError('RECONCILIATION_SCOPE_REQUIRED', 'Readback requires observed account/resource identity', 403);
        assertAuthorized(operation, { ...identity, origin, authorizationVersion: record.envelope.authorizationVersion }, now());
        const reservedIds = record.envelope.payload?.actionIds || [];
        if (fingerprint([...new Set(payload.actionIds)].sort()) !== fingerprint([...new Set(reservedIds)].sort())) throw opsError('RECONCILIATION_ACTION_MISMATCH', 'Readback action IDs differ from the reserved command', 409);
        if (data.actions.some((item) => item.operationId === operation.id && item.effect !== false && ['initiated', 'unknown'].includes(item.status) && !payload.actionIds.includes(item.actionId))) throw opsError('RECONCILIATION_INCOMPLETE', 'Read back all pending external effects before clearing uncertainty', 409);
        for (const id of payload.actionIds) {
          const item = data.actions.find((entry) => entry.operationId === operation.id && entry.actionId === id);
          if (!item || !['initiated', 'unknown', 'confirmed'].includes(item.status)) throw opsError('ACTION_NOT_UNCERTAIN', 'Reconciliation must identify initiated actions', 409);
          const original = data.commands.find((entry) => entry.operationId === operation.id && entry.commandId === item.commandId)?.envelope.payload?.actions?.find((entry) => entry.actionId === id);
          const expected = original?.expected || item.expected;
          let declaredReadOnlyNavigation = false;
          if (original?.type === 'navigate' && (original.kind === undefined || original.kind === 'navigate') && item.kind === 'navigate' && original.effect === false && item.effect === false &&
              typeof original.value === 'string' && original.value === original.expected?.url) {
            try { declaredReadOnlyNavigation = ['http:', 'https:'].includes(new URL(original.value).protocol); } catch { /* malformed declarations receive no navigation exception */ }
          }
          const profileReadback = operation.authorization.scope === 'profile';
          if (item.accountId && item.accountId !== identity.accountId || !declaredReadOnlyNavigation && item.resourceId && item.resourceId !== identity.resourceId && (!profileReadback || !explained)) throw opsError('RECONCILIATION_RESOURCE_MISMATCH', 'Readback identifies a different account/resource; a Profile-scoped alternate result page requires the Agent explanation', 403);
          if (declaredReadOnlyNavigation && (item.accountId !== identity.accountId || payload.result.url !== original.expected.url)) throw opsError('RECONCILIATION_DESTINATION_MISMATCH', 'Read-only navigation must read back the same account at its exact originally declared destination URL', 409);
          if (outcome === 'not-applied') {
            if (!['initiated', 'unknown'].includes(item.status)) throw opsError('ACTION_NOT_UNCERTAIN', 'A confirmed action cannot be downgraded to not-applied', 409);
            if (operation.authorization.scope !== 'profile') {
              const before = item.beforeTarget && item.before !== null ? { target: item.beforeTarget, text: String(item.before) } : null;
              if (!before || !payload.result.verification.some((condition) => fingerprint(condition) === fingerprint(before))) throw opsError('RECONCILIATION_EXPECTATION_MISMATCH', 'Strict not-applied readback must verify the original recorded before-value', 409);
            }
          } else if ((item.effect !== false || declaredReadOnlyNavigation) && (!expected || !payload.result.verification.some((condition) => fingerprint(condition) === fingerprint(expected)))) {
            if (!profileReadback || !explained) throw opsError('RECONCILIATION_EXPECTATION_MISMATCH', 'Read back the original result; alternative evidence for a general browser action requires the Agent explanation', 409);
          }
          if (declaredReadOnlyNavigation) item.destinationReadback = { accountId: identity.accountId, resourceId: identity.resourceId, url: payload.result.url, verifiedAt: timestamp(now) };
          item.status = outcome === 'not-applied' ? 'failed' : 'confirmed'; item.verification = safeOperationsValue(payload.result); item.updatedAt = timestamp(now);
        }
        if (operation.status === 'reconcile-required' && !data.actions.some((item) => item.operationId === operation.id && item.effect !== false && ['initiated', 'unknown'].includes(item.status))) operation.status = 'running';
        return { reconciled: payload.actionIds };
      }
      if (type === 'command-result') {
        if (!record) throw opsError('COMMAND_NOT_RESERVED', 'Result has no reserved command', 409);
        if (payload.localActions !== undefined) {
          if (!Array.isArray(payload.localActions) || payload.localActions.length > MAX_BATCH_ACTIONS) throw opsError('INVALID_LOCAL_RECEIPT', 'Local receipt batch exceeds its bound', 409);
          const seen = new Set();
          const receipts = payload.localActions.map((receipt) => {
            const original = localReceiptAction(record, receipt?.actionId, receipt?.kind);
            if (seen.has(receipt.actionId) || receipt.commandId !== record.commandId || receipt.operationId !== operation.id || receipt.effect !== false || !['confirmed', 'failed'].includes(receipt.status) ||
                receipt.authorizationVersion !== record.envelope.authorizationVersion || receipt.accountId !== operation.authorization.accountId ||
                typeof receipt.pageId !== 'string' || !receipt.pageId || typeof receipt.pageVersion !== 'string' || !receipt.pageVersion ||
                typeof receipt.origin !== 'string' || !receipt.origin || receipt.transport || receipt.interaction ||
                data.actions.some((item) => item.operationId === operation.id && item.actionId === receipt.actionId) || operation.completedActionIds.includes(receipt.actionId)) throw opsError('INVALID_LOCAL_RECEIPT', 'Local receipt does not match its reserved command and action context', 409);
            seen.add(receipt.actionId);
            return { ...safeOperationsValue(receipt), operationId: operation.id, commandId: record.commandId, authorizationVersion: record.envelope.authorizationVersion,
              kind: original.kind || original.type, effect: false, localReceipt: true, expected: original.expected || null, beforeTarget: original.beforeTarget || null,
              before: original.before ?? null, interaction: null, transport: null, createdAt: timestamp(now), updatedAt: timestamp(now),
              ...(receipt.status === 'confirmed' ? { confirmedAt: timestamp(now) } : {}) };
          });
          data.actions.push(...receipts);
          operation.completedActionIds.push(...receipts.filter((receipt) => receipt.status === 'confirmed').map((receipt) => receipt.actionId));
        }
        const { localActions: _localActions, ...publicPayload } = payload;
        record.status = ['confirmed', 'stopped', 'failed', 'unknown'].includes(payload.status) ? payload.status : 'unknown'; record.reply = safeOperationsValue(publicPayload); record.updatedAt = timestamp(now);
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
      result = apply(await store.readAuthorizationContext(taskId, payload?.commandId, payload));
      if (result?.operationRejected) result = await store.update((data) => {
        const operation = data.operations.find((item) => item.taskId === taskId);
        if (!operation) throw opsError('OPERATION_NOT_FOUND', 'Worker is not bound to an operation', 404);
        try { checkBudget(operation); }
        catch (error) { return pausedRejection(operation, error); }
        return apply(data);
      });
      else result = safeOperationsValue(result);
    } else result = await store.update(apply);
    if (type === 'command-result' || type === 'event') notify();
    return rejectAfterPersistence(result);
  }
  async function events(id, { after = 0, waitMs = 0, detail = 'full' } = {}) {
    operationsReplyDetail(detail);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw opsError('INVALID_EVENT_CURSOR', 'Event cursor/wait is invalid');
    const read = () => store.project((data) => {
      const operation = id ? find(data, id) : null, all = data.events.filter((item) => !id || item.operationId === id);
      const selected = all.filter((item) => item.sequence > after).slice(0, 200);
      return { events: selected, nextCursor: selected.at(-1)?.sequence || after, pending: all.filter((item) => item.state !== 'handled').length,
        ...(operation ? { operationStatus: operation.status } : {}) };
    });
    let result = await read();
    if (!result.events.length && waitMs) {
      await new Promise((resolve) => { let timer; const done = () => { clearTimeout(timer); listeners.delete(done); resolve(); }; timer = setTimeout(done, waitMs); listeners.add(done); });
      result = await read();
    }
    if (detail !== 'compact') return result;
    const selected = []; let size = 0;
    for (const event of result.events) {
      const value = compactWire(event, { id, event: true, maxChars: 64000 });
      const length = JSON.stringify(value).length;
      // Never cut a safety payload. A large first event remains whole; later
      // events stay behind the returned cursor and can be read on the next page.
      if (selected.length && size + length > 10000) break;
      selected.push(value); size += length;
    }
    return { ...result, events: selected, nextCursor: selected.at(-1)?.sequence || after,
      ...(selected.length < result.events.length ? { omitted: { eventsAfterPage: result.events.length - selected.length, fullEvidence: `ops events ${id} --after ${selected.at(-1)?.sequence || after} --detail full` } } : {}) };
  }
  async function action(id, body = {}, { detail = 'full' } = {}) {
    operationsReplyDetail(detail);
    if (body.action === 'ack') {
      const event = await store.update((data) => {
      const operation = find(data, id); assertAuthorized(operation, {}, now());
      const event = data.events.find((item) => item.operationId === id && item.id === body.eventId);
      if (!event || Date.parse(event.expiresAt) <= now()) throw opsError('EVENT_EXPIRED_OR_MISSING', 'Event cannot be acknowledged', 409);
      if (event.state === 'pending') { event.state = 'delivered'; event.deliveredAt = timestamp(now); }
      if (event.state !== 'handled') { event.state = 'received'; event.receivedAt = timestamp(now); }
      return event;
      });
      return detail === 'compact' ? compactWire(event, { id, event: true, maxChars: 64000 }) : event;
    }
    if (body.action === 'decide') {
      await store.update((data) => {
        const operation = find(data, id); assertAuthorized(operation, { authorizationVersion: body.authorizationVersion }, now());
        const event = data.events.find((item) => item.operationId === id && item.id === body.eventId);
        if (!event || event.state !== 'received' || Date.parse(event.expiresAt) <= now()) throw opsError('EVENT_NOT_RECEIVED', 'Decision needs a received, unexpired event', 409);
        if (typeof body.summary !== 'string' || !body.summary.trim()) throw opsError('DECISION_REQUIRED', 'Main Agent decision summary is required');
        event.state = 'handled'; event.handledAt = timestamp(now); operation.decisionSummary = body.summary.slice(0, 2000);
      });
      if (body.command) {
        try { const record = await command(id, body.command); return detail === 'compact' ? commandReply(id, record, { detail }) : record; }
        catch (error) {
          await store.update((data) => { const event = data.events.find((item) => item.operationId === id && item.id === body.eventId); if (event) { event.state = 'received'; delete event.handledAt; event.decisionError = { code: error.code, message: error.message }; } });
          throw error;
        }
      }
      if (body.stop) return action(id, { action: 'stop' }, { detail });
      return get(id, { detail });
    }
    if (body.action === 'reconcile') {
      const record = await command(id, { ...body.command, commandId: body.commandId || body.command?.commandId, kind: 'reconcile', payload: body.payload || body.command?.payload });
      return detail === 'compact' ? commandReply(id, record, { detail }) : record;
    }
    if (body.action === 'update') {
      if (body.singleSendTransport !== undefined) throw opsError('TRANSPORT_POLICY_IMMUTABLE', 'Transport context policy is selected at operation start, not changed on a running browser');
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
      return get(id, { detail });
    }
    if (!['pause', 'resume', 'takeover', 'revoke', 'stop'].includes(body.action)) throw opsError('INVALID_OPERATION_ACTION', 'Unknown operation action');
    let taskId; let resumedMode;
    if (body.action === 'resume') {
      const snapshot = await store.project((data) => ({ taskId: find(data, id).taskId, unresolved: data.actions.some((item) => item.operationId === id && unresolved(item)) }));
      if (snapshot.unresolved) throw opsError('RECONCILIATION_REQUIRED', 'Resolve uncertain effects before resuming', 409);
      const task = snapshot.taskId ? await taskService.get(snapshot.taskId).catch(() => null) : null;
      if (task && !['waiting', 'stopped', 'finished', 'error'].includes(task.state)) throw opsError('COMMAND_IN_PROGRESS', 'Wait for the interrupted command to settle before explicit resume', 409);
    }
    await store.update((data) => {
      const operation = find(data, id); taskId = operation.taskId;
      if (body.action === 'resume') {
        assertAuthorized(operation, {}, now());
        if (data.actions.some((item) => item.operationId === id && item.effect !== false && ['initiated', 'unknown'].includes(item.status))) throw opsError('RECONCILIATION_REQUIRED', 'Resolve uncertain effects before resuming', 409);
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
    notify();
    if (['stop', 'revoke'].includes(body.action)) { if (taskId) await taskService.stop(taskId); }
    else {
      await taskService.operationControl?.(taskId, { action: body.action, ...(body.action === 'resume' ? { mode: resumedMode } : {}) });
      if (body.action === 'resume') await command(id, { commandId: operationId('resume'), kind: 'control', payload: { action: 'resume', mode: resumedMode } });
      if (body.action === 'resume') {
        const operation = await store.project((data) => { const operation = find(data, id); return { taskId: operation.taskId, cursorEnabled: operation.cursorEnabled }; });
        // A recreated Worker receives this preference in its startup config.
        // Do not send a duplicate cursor control before its handler is ready.
        if (operation.taskId === taskId) await taskService.operationControl?.(operation.taskId, { action: 'cursor', visible: operation.cursorEnabled });
      }
    }
    return get(id, { detail });
  }
  async function tick() {
    if (ticking || closed) return;
    ticking = true;
    tickFinished = new Promise((resolve) => { finishTick = resolve; });
    try {
      const pausedTasks = new Set();
      const requiresUpdate = await store.project((data) => data.operations.some((operation) => operation.status === 'running' && (
        operation.authorization.revokedAt || Date.parse(operation.authorization.expiresAt) <= now() ||
        (operation.schedule && Date.parse(operation.schedule.nextAt) <= now() && (!operation.schedule.expiresAt || Date.parse(operation.schedule.expiresAt) > now())) ||
        (operation.budgets.maxDurationMs != null && now() - Date.parse(operation.createdAt) >= operation.budgets.maxDurationMs) ||
        (!operation.pending && operation.budgets.maxRuns != null && operation.counters.runs >= operation.budgets.maxRuns) ||
        ['inputTokens', 'outputTokens', 'cost'].some((name) => operation.budgets[name] != null && (operation.counters[name] == null || operation.counters[name] >= operation.budgets[name])))));
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
      const snapshot = await store.project((data) => data.operations.filter((operation) => operation.pending || operation.hostAdapter && operation.status === 'running').map((operation) => ({
        id: operation.id, taskId: operation.taskId, status: operation.status, pending: operation.pending, hostAdapter: operation.hostAdapter,
        event: operation.hostAdapter && operation.status === 'running' ? data.events.find((item) => item.operationId === operation.id && item.state === 'pending' && item.nextAttemptAt <= now() && item.attempts < 5 && Date.parse(item.expiresAt) > now()) : null
      })));
      for (const operation of snapshot) {
        if (operation.pending) await deliver(operation.id);
        if (!operation.hostAdapter || operation.status !== 'running') continue;
        const event = operation.event;
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
  taskService.setOperationReadyHandler?.(async (taskId) => {
    if (closed) return;
    const id = await store.project((data) => data.operations.find((item) => item.taskId === taskId && item.pending)?.id || null);
    if (id) await deliver(id);
  });
  return { start, get, command, waitCommand, commandReply, replyDetail: operationsReplyDetail, events, action, durable, tick, store,
    list: async ({ detail = 'full' } = {}) => { operationsReplyDetail(detail); return store.project((data) => data.operations.map((operation) => detail === 'compact' ? {
      ...operationInfo(operation), unresolvedActionCount: data.actions.filter((item) => item.operationId === operation.id && unresolved(item)).length,
      fullEvidence: `ops get ${operation.id} --detail full`
    } : operation)); },
    stopAll: async () => { const ids = await store.project((data) => data.operations.filter((item) => !['stopped', 'revoked', 'failed'].includes(item.status)).map((item) => item.id)); const results = await Promise.allSettled(ids.map((id) => action(id, { action: 'stop' }, { detail: 'compact' }))); return { scope: 'operations-only', stopped: results.filter((item) => item.status === 'fulfilled').length, failed: results.filter((item) => item.status === 'rejected').length }; },
    close: async () => { closed = true; taskService.setOperationReadyHandler?.(null); clearInterval(timer); notify(); await tickFinished; },
    assertUnchanged: () => store.assertUnchanged(), fence: () => { closed = true; taskService.setOperationReadyHandler?.(null); clearInterval(timer); store.fence(); notify(); } };
}
