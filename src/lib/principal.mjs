const RESERVED_AGENT_CLIENT_IDS = new Set([
  'manager-admin',
  'dashboard',
  'extension'
]);

const RESERVED_AGENT_CLIENT_PREFIXES = [
  'manager:',
  'manager-',
  'dashboard:',
  'extension:',
  'internal:',
  'profile-open:',
  'session-import:',
  'task:',
  'taskmaster:'
];

export function isReservedAgentClientId(value) {
  return typeof value === 'string' && (
    RESERVED_AGENT_CLIENT_IDS.has(value) ||
    RESERVED_AGENT_CLIENT_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}
