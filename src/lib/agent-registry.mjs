import { normalizeAgentName, validateAgentClientId } from './agent-token.mjs';
import { JsonStore } from './json-store.mjs';

const DEFAULT_ONLINE_TTL_MS = 45_000;
const MAX_CONNECTIONS_PER_AGENT = 64;
const CONNECTION_ID = /^[a-zA-Z0-9._:-]{1,128}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

export class AgentRegistryError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'AgentRegistryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function agentNotFound(clientId) {
  return new AgentRegistryError(
    'AGENT_NOT_FOUND',
    `Agent ${clientId} was not found`,
    404
  );
}

function normalizeConnectionId(value) {
  const connectionId = value ?? 'default';
  if (typeof connectionId !== 'string' || !CONNECTION_ID.test(connectionId)) {
    throw new AgentRegistryError(
      'INVALID_AGENT_CONNECTION_ID',
      'connectionId must contain 1-128 letters, numbers, dots, underscores, colons, or hyphens'
    );
  }
  return connectionId;
}

function normalizeReason(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || CONTROL_CHARACTER.test(value)) {
    throw new AgentRegistryError('INVALID_AGENT_REVOKE_REASON', 'reason must be plain text');
  }
  const reason = value.normalize('NFC').trim();
  if (!reason || [...reason].length > 160 || Buffer.byteLength(reason, 'utf8') > 320) {
    throw new AgentRegistryError(
      'INVALID_AGENT_REVOKE_REASON',
      'reason must contain 1-160 characters'
    );
  }
  return reason;
}

function normalizeIdentity({ clientId, agentId, name, displayName } = {}) {
  const normalizedClientId = validateAgentClientId(clientId ?? agentId);
  const normalizedName = normalizeAgentName(displayName ?? name ?? normalizedClientId);
  return { clientId: normalizedClientId, displayName: normalizedName };
}

function findAgent(data, clientId) {
  const agent = data.agents.find((item) => item.clientId === clientId);
  if (!agent) throw agentNotFound(clientId);
  return agent;
}

function activityFor(options, clientId) {
  const source = options?.activityByClientId;
  if (source instanceof Map) return source.get(clientId);
  if (source && typeof source === 'object' && !Array.isArray(source)) return source[clientId];
  return undefined;
}

function boundedIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item).slice(0, 100))];
}

function normalizeActivity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { working: false, currentTaskIds: [], currentProfileIds: [], queueDepth: 0 };
  }
  const currentTaskIds = boundedIds(value.currentTaskIds ?? value.taskIds);
  const currentProfileIds = boundedIds(value.currentProfileIds ?? value.profileIds);
  const queueDepth = Number.isSafeInteger(value.queueDepth) && value.queueDepth >= 0
    ? Math.min(value.queueDepth, 10_000)
    : 0;
  return {
    working: value.working === true || currentTaskIds.length > 0,
    currentTaskIds,
    currentProfileIds,
    queueDepth
  };
}

function activeConnections(agent, nowMs, onlineTtlMs) {
  return agent.connections.filter((connection) => (
    connection.disconnectedAt === null &&
    Number.isFinite(Date.parse(connection.lastSeenAt)) &&
    Date.parse(connection.lastSeenAt) + onlineTtlMs > nowMs
  ));
}

function publicAgent(agent, { nowMs, onlineTtlMs, activity } = {}) {
  const normalizedActivity = normalizeActivity(activity);
  const connectionCount = activeConnections(agent, nowMs, onlineTtlMs).length;
  let status = agent.lastSeenAt ? 'offline' : 'registered';
  if (connectionCount > 0) status = 'online';
  if (normalizedActivity.working) status = 'working';
  if (agent.revokedAt) status = 'revoked';
  return {
    agentId: agent.clientId,
    clientId: agent.clientId,
    displayName: agent.displayName,
    name: agent.displayName,
    status,
    registeredAt: agent.registeredAt,
    updatedAt: agent.updatedAt,
    lastSeenAt: agent.lastSeenAt,
    connectionCount: agent.revokedAt ? 0 : connectionCount,
    currentTaskIds: normalizedActivity.currentTaskIds,
    currentProfileIds: normalizedActivity.currentProfileIds,
    queueDepth: normalizedActivity.queueDepth,
    revokedAt: agent.revokedAt,
    revokedReason: agent.revokedReason
  };
}

function pruneConnections(connections) {
  if (connections.length <= MAX_CONNECTIONS_PER_AGENT) return;
  connections.sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
  connections.length = MAX_CONNECTIONS_PER_AGENT;
}

export class AgentRegistry {
  #store;
  #now;
  #onlineTtlMs;

  constructor({ filePath, now = () => Date.now(), onlineTtlMs = DEFAULT_ONLINE_TTL_MS } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    if (!Number.isSafeInteger(onlineTtlMs) || onlineTtlMs < 1_000) {
      throw new TypeError('onlineTtlMs must be an integer of at least 1000');
    }
    this.#store = new JsonStore(filePath, { version: 1, agents: [] });
    this.#now = now;
    this.#onlineTtlMs = onlineTtlMs;
  }

  async init() {
    await this.#store.init();
    await this.#store.update((data) => {
      if (data?.version !== 1 || !Array.isArray(data.agents)) {
        throw new AgentRegistryError(
          'AGENT_REGISTRY_VERSION_UNSUPPORTED',
          `Agent registry version ${String(data?.version)} is unsupported`,
          409
        );
      }
      const initializedAt = new Date(this.#now()).toISOString();
      const seen = new Set();
      for (const agent of data.agents) {
        const identity = normalizeIdentity(agent);
        if (seen.has(identity.clientId)) {
          throw new AgentRegistryError(
            'AGENT_REGISTRY_CORRUPT',
            `Agent registry contains duplicate id ${identity.clientId}`,
            409
          );
        }
        seen.add(identity.clientId);
        agent.clientId = identity.clientId;
        agent.displayName = identity.displayName;
        delete agent.agentId;
        delete agent.name;
        // Credentials are intentionally stateless and must never survive here,
        // including when a pre-release registry file is migrated.
        delete agent.token;
        delete agent.agentToken;
        delete agent.tokenHash;
        agent.registeredAt = typeof agent.registeredAt === 'string'
          ? agent.registeredAt
          : initializedAt;
        agent.updatedAt = typeof agent.updatedAt === 'string' ? agent.updatedAt : agent.registeredAt;
        agent.lastSeenAt = typeof agent.lastSeenAt === 'string' ? agent.lastSeenAt : null;
        agent.revokedAt = typeof agent.revokedAt === 'string' ? agent.revokedAt : null;
        agent.revokedReason = typeof agent.revokedReason === 'string' ? agent.revokedReason : null;
        agent.connections = Array.isArray(agent.connections) ? agent.connections.filter((connection) => (
          connection && typeof connection === 'object' &&
          typeof connection.id === 'string' && CONNECTION_ID.test(connection.id) &&
          typeof connection.connectedAt === 'string' &&
          typeof connection.lastSeenAt === 'string'
        )).map((connection) => ({
          id: connection.id,
          connectedAt: connection.connectedAt,
          lastSeenAt: connection.lastSeenAt,
          disconnectedAt: typeof connection.disconnectedAt === 'string'
            ? connection.disconnectedAt
            : null
        })) : [];
        pruneConnections(agent.connections);
      }
    });
  }

  async register(identity = {}) {
    const normalized = normalizeIdentity(identity);
    const connectionId = identity.connectionId === undefined
      ? null
      : normalizeConnectionId(identity.connectionId);
    const now = new Date(this.#now()).toISOString();
    let result;
    await this.#store.update((data) => {
      let agent = data.agents.find((item) => item.clientId === normalized.clientId);
      if (!agent) {
        agent = {
          clientId: normalized.clientId,
          displayName: normalized.displayName,
          registeredAt: now,
          updatedAt: now,
          lastSeenAt: null,
          revokedAt: null,
          revokedReason: null,
          connections: []
        };
        data.agents.push(agent);
      } else {
        if (agent.revokedAt) {
          throw new AgentRegistryError(
            'AGENT_REVOKED',
            `Agent ${normalized.clientId} is revoked`,
            403
          );
        }
        agent.displayName = normalized.displayName;
        agent.updatedAt = now;
      }
      if (connectionId !== null) this.#touchRecord(agent, connectionId, now);
      result = structuredClone(agent);
    });
    return this.#public(result);
  }

  async touch(clientId, { name, displayName, connectionId } = {}) {
    const normalizedClientId = validateAgentClientId(clientId);
    const normalizedName = name === undefined && displayName === undefined
      ? null
      : normalizeAgentName(displayName ?? name);
    const normalizedConnectionId = normalizeConnectionId(connectionId);
    const now = new Date(this.#now()).toISOString();
    let result;
    await this.#store.update((data) => {
      let agent = data.agents.find((item) => item.clientId === normalizedClientId);
      if (!agent) {
        agent = {
          clientId: normalizedClientId,
          displayName: normalizedName ?? normalizedClientId,
          registeredAt: now,
          updatedAt: now,
          lastSeenAt: null,
          revokedAt: null,
          revokedReason: null,
          connections: []
        };
        data.agents.push(agent);
      }
      if (agent.revokedAt) {
        throw new AgentRegistryError(
          'AGENT_REVOKED',
          `Agent ${normalizedClientId} is revoked`,
          403
        );
      }
      if (normalizedName !== null) agent.displayName = normalizedName;
      this.#touchRecord(agent, normalizedConnectionId, now);
      result = structuredClone(agent);
    });
    return this.#public(result);
  }

  async disconnect(clientId, { connectionId } = {}) {
    const normalizedClientId = validateAgentClientId(clientId);
    const normalizedConnectionId = normalizeConnectionId(connectionId);
    const now = new Date(this.#now()).toISOString();
    let changed = false;
    await this.#store.update((data) => {
      const agent = findAgent(data, normalizedClientId);
      const connection = agent.connections.find((item) => item.id === normalizedConnectionId);
      if (!connection || connection.disconnectedAt !== null) return;
      connection.disconnectedAt = now;
      agent.updatedAt = now;
      changed = true;
    });
    return changed;
  }

  async revoke(clientId, { reason } = {}) {
    const normalizedClientId = validateAgentClientId(clientId);
    const hasReason = reason !== undefined;
    const normalizedReason = normalizeReason(reason);
    const now = new Date(this.#now()).toISOString();
    let result;
    await this.#store.update((data) => {
      const agent = findAgent(data, normalizedClientId);
      if (!agent.revokedAt) agent.revokedAt = now;
      if (hasReason) agent.revokedReason = normalizedReason;
      agent.updatedAt = now;
      for (const connection of agent.connections) {
        connection.disconnectedAt ??= now;
      }
      result = structuredClone(agent);
    });
    return this.#public(result);
  }

  async restore(clientId) {
    const normalizedClientId = validateAgentClientId(clientId);
    const now = new Date(this.#now()).toISOString();
    let result;
    await this.#store.update((data) => {
      const agent = findAgent(data, normalizedClientId);
      agent.revokedAt = null;
      agent.revokedReason = null;
      agent.updatedAt = now;
      // Restore permission only. A real subsequent request establishes
      // presence; old connections must not become online again.
      for (const connection of agent.connections) {
        connection.disconnectedAt ??= now;
      }
      result = structuredClone(agent);
    });
    return this.#public(result);
  }

  async isRevoked(clientId) {
    const normalizedClientId = validateAgentClientId(clientId);
    const data = await this.#store.read();
    const agent = data.agents.find((item) => item.clientId === normalizedClientId);
    return Boolean(agent?.revokedAt);
  }

  async requireActive(clientId) {
    const normalizedClientId = validateAgentClientId(clientId);
    const data = await this.#store.read();
    const agent = data.agents.find((item) => item.clientId === normalizedClientId);
    if (!agent) throw agentNotFound(normalizedClientId);
    if (agent.revokedAt) {
      throw new AgentRegistryError('AGENT_REVOKED', `Agent ${normalizedClientId} is revoked`, 403);
    }
    return this.#public(agent);
  }

  async get(clientId, options = {}) {
    const normalizedClientId = validateAgentClientId(clientId);
    const data = await this.#store.read();
    return this.#public(findAgent(data, normalizedClientId), activityFor(options, normalizedClientId));
  }

  async list(options = {}) {
    const data = await this.#store.read();
    return data.agents
      .map((agent) => this.#public(agent, activityFor(options, agent.clientId)))
      .sort((left, right) => left.registeredAt.localeCompare(right.registeredAt) ||
        left.agentId.localeCompare(right.agentId));
  }

  #touchRecord(agent, connectionId, now) {
    let connection = agent.connections.find((item) => item.id === connectionId);
    if (!connection) {
      connection = { id: connectionId, connectedAt: now, lastSeenAt: now, disconnectedAt: null };
      agent.connections.push(connection);
    } else {
      if (connection.disconnectedAt !== null) connection.connectedAt = now;
      connection.lastSeenAt = now;
      connection.disconnectedAt = null;
    }
    pruneConnections(agent.connections);
    agent.lastSeenAt = now;
    agent.updatedAt = now;
  }

  #public(agent, activity) {
    return publicAgent(agent, {
      nowMs: this.#now(),
      onlineTtlMs: this.#onlineTtlMs,
      activity
    });
  }
}
