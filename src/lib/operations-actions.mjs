import { createHash, randomUUID } from 'node:crypto';

// Shared by the Manager, worker and offline schema. Host/model integrations do
// not get a different action vocabulary or a different permission default.
export const MAX_BATCH_ACTIONS = 16;
export const ACTION_TYPES = Object.freeze(['navigate', 'back', 'forward', 'reload', 'new-tab', 'close-tab', 'click', 'hover', 'fill', 'type', 'key', 'select', 'scroll', 'drag', 'upload', 'download', 'read', 'locate', 'wait']);
const LOCAL_ACTIONS = new Set(['navigate', 'back', 'forward', 'reload', 'new-tab', 'close-tab', 'hover', 'scroll', 'download', 'read', 'locate', 'wait']);

export function actionHasEffect(action) {
  return typeof action.effect === 'boolean' ? action.effect : !LOCAL_ACTIONS.has(action.type);
}

export function sameDocument(first, second) {
  if (first === second) return true;
  const documentPart = (version) => typeof version === 'string' && version.split(':').length >= 3 ? version.split(':').slice(1, -1).join(':') : null;
  const a = documentPart(first), b = documentPart(second);
  return Boolean(a && b && a === b);
}

export function normalizeOperationsCommand(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const commandId = value.commandId || `cmd_${randomUUID().replaceAll('-', '')}`;
  const command = { ...value, schemaVersion: value.schemaVersion ?? 1, commandId, payload: { ...value.payload } };
  if (command.kind === 'batch') {
    const prefix = createHash('sha256').update(commandId).digest('hex').slice(0, 24);
    command.payload.preconditions ??= [];
    command.payload.stopConditions ??= [];
    command.payload.verify ??= [];
    if (Array.isArray(command.payload.actions)) command.payload.actions = command.payload.actions.map((action, index) => ({ ...action, actionId: action.actionId || `action_${prefix}_${index + 1}`, effect: actionHasEffect(action) }));
  }
  return command;
}
