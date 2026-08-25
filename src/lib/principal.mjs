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
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return RESERVED_AGENT_CLIENT_IDS.has(normalized) ||
    RESERVED_AGENT_CLIENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
