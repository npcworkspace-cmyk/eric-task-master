import { createHash, createHmac } from 'node:crypto';
import { JsonStore } from './json-store.mjs';
import { redactPublicText } from './redaction.mjs';
import { createSystemNotifier } from './system-notifier.mjs';

const STORE_VERSION = 1;
const DEFAULT_REMINDER_MS = 30_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RECORDS = 500;
const CHANNELS = Object.freeze(['system', 'telegram', 'feishu']);
const ACTIVE_STATE = 'active';
const DEFAULT_DASHBOARD_URL = 'http://127.0.0.1:19946/dashboard';
const CHANNEL_STATUSES = new Set(['ready', 'needs_setup', 'permission_blocked', 'unavailable', 'test_failed']);

function clone(value) {
  return structuredClone(value);
}

function nowIso(now) {
  return new Date(now()).toISOString();
}

function boundedPublicText(value, maximum, fallback = '') {
  const text = redactPublicText(String(value ?? '')).replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
  return (text || fallback).slice(0, maximum);
}

function stableAlertId(taskId, requestId) {
  return `notice_${createHash('sha256').update(`${taskId}\0${requestId}`).digest('hex').slice(0, 32)}`;
}

function isActiveVerification(task) {
  return Boolean(
    task &&
    typeof task.id === 'string' && task.id &&
    task.state === 'waiting_user' &&
    task.userRequest?.kind === 'human_verification' &&
    task.userRequest?.status === 'pending' &&
    typeof task.userRequest.id === 'string' && task.userRequest.id
  );
}

function defaultStore() {
  return {
    version: STORE_VERSION,
    settings: {
      channels: {
        system: { enabled: true },
        telegram: { enabled: false, botToken: null, chatId: null },
        feishu: { enabled: false, webhookUrl: null, signingSecret: null }
      }
    },
    records: []
  };
}

function validateStore(value) {
  if (!value || value.version !== STORE_VERSION || !Array.isArray(value.records)) {
    const error = new Error('Notification store version is unsupported or corrupt');
    error.code = 'NOTIFICATION_STORE_INVALID';
    throw error;
  }
  value.settings ||= defaultStore().settings;
  value.settings.channels ||= defaultStore().settings.channels;
  for (const channel of CHANNELS) {
    value.settings.channels[channel] ||= defaultStore().settings.channels[channel];
  }
  return value;
}

function maskTail(value) {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  return `••••${text.slice(-4)}`;
}

function maskedWebhook(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}/••••`;
  } catch {
    return undefined;
  }
}

function publicLastTest(value) {
  if (!value || typeof value !== 'object' || typeof value.testedAt !== 'string') return null;
  return {
    ok: value.ok === true,
    testedAt: boundedPublicText(value.testedAt, 64),
    attempts: Number(value.attempts) || 0,
    ...(value.code ? { code: boundedPublicText(value.code, 64, 'NOTIFICATION_TEST_FAILED') } : {}),
    ...(Number.isInteger(value.statusCode) ? { statusCode: value.statusCode } : {})
  };
}

function channelStatus(configured, lastTest) {
  if (!configured || !lastTest) return 'needs_setup';
  return lastTest?.ok === false ? 'test_failed' : 'ready';
}

function normalizeSystemStatus(value) {
  const status = value && typeof value === 'object' ? value : {};
  const state = CHANNEL_STATUSES.has(status.state) ? status.state : status.configured === false ? 'unavailable' : 'ready';
  return {
    state,
    configured: status.configured === true || ['ready', 'permission_blocked', 'test_failed'].includes(state),
    canOpenSettings: status.canOpenSettings === true,
    ...(status.code ? { code: boundedPublicText(status.code, 64, 'SYSTEM_NOTIFICATION_FAILED') } : {})
  };
}

function publicSettings(settings, systemCapability) {
  const channels = settings.channels;
  const telegramConfigured = Boolean(channels.telegram.botToken && channels.telegram.chatId);
  const feishuConfigured = Boolean(channels.feishu.webhookUrl);
  const system = normalizeSystemStatus(systemCapability);
  const systemLastTest = publicLastTest(channels.system.lastTest);
  const telegramLastTest = publicLastTest(channels.telegram.lastTest);
  const feishuLastTest = publicLastTest(channels.feishu.lastTest);
  const systemStatus = ['unavailable', 'needs_setup', 'permission_blocked'].includes(system.state)
    ? system.state
    : systemLastTest?.ok === false ? 'test_failed' : system.state;
  return {
    channels: {
      system: {
        enabled: channels.system.enabled === true,
        configured: system.configured,
        status: systemStatus,
        canOpenSettings: system.canOpenSettings,
        lastTest: systemLastTest,
        ...(system.code ? { code: system.code } : {})
      },
      telegram: {
        enabled: channels.telegram.enabled === true,
        configured: telegramConfigured,
        status: channelStatus(telegramConfigured, telegramLastTest),
        lastTest: telegramLastTest,
        ...(telegramConfigured ? { maskedTarget: maskTail(channels.telegram.chatId) } : {})
      },
      feishu: {
        enabled: channels.feishu.enabled === true,
        configured: feishuConfigured,
        status: channelStatus(feishuConfigured, feishuLastTest),
        signingConfigured: Boolean(channels.feishu.signingSecret),
        lastTest: feishuLastTest,
        ...(feishuConfigured ? { maskedTarget: maskedWebhook(channels.feishu.webhookUrl) } : {})
      }
    }
  };
}

function publicRecord(record) {
  const lastDelivery = record.lastDelivery && typeof record.lastDelivery === 'object'
    ? Object.fromEntries(CHANNELS
      .filter((channel) => record.lastDelivery[channel])
      .map((channel) => [channel, safeChannelResult(channel, record.lastDelivery[channel])]))
    : null;
  return clone({
    id: boundedPublicText(record.id, 128),
    taskId: boundedPublicText(record.taskId, 128),
    requestId: boundedPublicText(record.requestId, 128),
    kind: 'human_verification',
    state: ['active', 'claimed', 'resolved'].includes(record.state) ? record.state : 'resolved',
    title: boundedPublicText(record.title, 120, 'Eric Task Master 需要人工验证'),
    message: boundedPublicText(record.message, 300, '浏览器任务正在等待人工验证。'),
    createdAt: boundedPublicText(record.createdAt, 64),
    updatedAt: boundedPublicText(record.updatedAt, 64),
    nextDueAt: record.nextDueAt ? boundedPublicText(record.nextDueAt, 64) : null,
    deliveryCount: Number(record.deliveryCount) || 0,
    ...(record.lastDeliveredAt ? { lastDeliveredAt: boundedPublicText(record.lastDeliveredAt, 64) } : {}),
    ...(record.readAt ? { readAt: boundedPublicText(record.readAt, 64) } : {}),
    ...(record.claimedAt ? { claimedAt: boundedPublicText(record.claimedAt, 64) } : {}),
    ...(record.resolvedAt ? { resolvedAt: boundedPublicText(record.resolvedAt, 64) } : {}),
    ...(lastDelivery && Object.keys(lastDelivery).length ? { lastDelivery } : {})
  });
}

function validateBoolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be a boolean`);
  return value;
}

function validateSecret(value, field, maximum) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw new TypeError(`${field} must be a bounded non-empty string or null`);
  }
  return value.trim();
}

function validateFeishuWebhook(value) {
  const source = validateSecret(value, 'channels.feishu.webhookUrl', 2_048);
  if (source === null) return null;
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new TypeError('channels.feishu.webhookUrl must be a valid HTTPS URL');
  }
  if (
    url.protocol !== 'https:' ||
    !['open.feishu.cn', 'open.larksuite.com'].includes(url.hostname.toLowerCase()) ||
    url.username || url.password || url.hash
  ) {
    throw new TypeError('channels.feishu.webhookUrl must use an official Feishu or Lark HTTPS webhook host');
  }
  return url.href;
}

function applySettingsPatch(settings, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('Notification settings must be an object');
  }
  const unknownRoot = Object.keys(patch).filter((key) => key !== 'channels');
  if (unknownRoot.length || !patch.channels || typeof patch.channels !== 'object' || Array.isArray(patch.channels)) {
    throw new TypeError('Notification settings accept only a channels object');
  }
  const unknownChannels = Object.keys(patch.channels).filter((key) => !CHANNELS.includes(key));
  if (unknownChannels.length) throw new TypeError(`Unsupported notification channels: ${unknownChannels.join(', ')}`);
  const next = clone(settings);
  for (const channel of Object.keys(patch.channels)) {
    const value = patch.channels[channel];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`channels.${channel} must be an object`);
    }
    const allowed = channel === 'system'
      ? ['enabled']
      : channel === 'telegram'
        ? ['enabled', 'botToken', 'chatId']
        : ['enabled', 'webhookUrl', 'signingSecret'];
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length) throw new TypeError(`Unsupported channels.${channel} fields: ${unknown.join(', ')}`);
    if (Object.hasOwn(value, 'enabled')) next.channels[channel].enabled = validateBoolean(value.enabled, `channels.${channel}.enabled`);
    if (channel === 'telegram') {
      if (Object.hasOwn(value, 'botToken')) {
        next.channels.telegram.botToken = validateSecret(value.botToken, 'channels.telegram.botToken', 512);
        delete next.channels.telegram.lastTest;
      }
      if (Object.hasOwn(value, 'chatId')) {
        next.channels.telegram.chatId = validateSecret(value.chatId, 'channels.telegram.chatId', 256);
        delete next.channels.telegram.lastTest;
      }
    }
    if (channel === 'feishu' && Object.hasOwn(value, 'webhookUrl')) {
      next.channels.feishu.webhookUrl = validateFeishuWebhook(value.webhookUrl);
      delete next.channels.feishu.lastTest;
    }
    if (channel === 'feishu' && Object.hasOwn(value, 'signingSecret')) {
      next.channels.feishu.signingSecret = validateSecret(value.signingSecret, 'channels.feishu.signingSecret', 512);
      delete next.channels.feishu.lastTest;
    }
  }
  return next;
}

function safeChannelResult(channel, result) {
  return {
    channel,
    ok: result.ok === true,
    attempts: Number(result.attempts) || 0,
    ...(result.code ? { code: boundedPublicText(result.code, 64, 'DELIVERY_FAILED') } : {}),
    ...(Number.isInteger(result.statusCode) ? { statusCode: result.statusCode } : {})
  };
}

function retryable(error) {
  if (error?.retryable === false) return false;
  const statusCode = Number(error?.statusCode);
  return !Number.isInteger(statusCode) || [408, 425, 429].includes(statusCode) || statusCode >= 500;
}

function providerErrorCode(channel, statusCode) {
  if ([401, 403].includes(statusCode)) return `${channel.toUpperCase()}_AUTH_REJECTED`;
  if (statusCode === 429) return 'NOTIFICATION_RATE_LIMITED';
  if (statusCode >= 500) return 'NOTIFICATION_PROVIDER_UNAVAILABLE';
  return `${channel.toUpperCase()}_PROVIDER_REJECTED`;
}

function fetchError(response, channel) {
  const error = new Error('Notification endpoint rejected the request');
  error.code = providerErrorCode(channel, Number(response.status));
  error.statusCode = response.status;
  return error;
}

async function assertEndpointAccepted(response, channel) {
  if (!response?.ok) throw fetchError(response || { status: 503 }, channel);
  // Native Response objects always expose json(). Test doubles may omit it.
  if (typeof response.json !== 'function') return;
  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error('Notification endpoint returned an invalid response');
    error.code = `${channel.toUpperCase()}_RESPONSE_INVALID`;
    error.statusCode = response.status;
    throw error;
  }
  if (channel === 'telegram' && payload?.ok !== true) {
    const error = fetchError({ status: Number(payload?.error_code) || response.status }, channel);
    error.retryable = [408, 425, 429].includes(error.statusCode) || error.statusCode >= 500;
    throw error;
  }
  if (channel === 'feishu') {
    const code = payload?.code ?? payload?.StatusCode;
    if (Number(code) !== 0) {
      const error = fetchError({ status: response.status }, channel);
      error.retryable = false;
      throw error;
    }
  }
}

function sleepDefault(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class NotificationCenter {
  #store;
  #fetch;
  #systemNotifier;
  #eligibilityCheck;
  #now;
  #setTimer;
  #clearTimer;
  #sleep;
  #reminderMs;
  #deliveryTimeoutMs;
  #retryDelayMs;
  #maxAttempts;
  #dashboardUrl;
  #timer = null;
  #scheduleGeneration = 0;
  #tail = Promise.resolve();
  #deliveries = new Set();
  #deliveryByRecord = new Map();
  #inFlight = new Set();
  #initialized = false;
  #closed = false;

  constructor({
    filePath,
    fetchImpl = globalThis.fetch,
    systemNotifier,
    eligibilityCheck = async () => 'pending',
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    sleep = sleepDefault,
    reminderMs = DEFAULT_REMINDER_MS,
    deliveryTimeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    dashboardUrl = DEFAULT_DASHBOARD_URL
  } = {}) {
    if (!filePath) throw new TypeError('filePath is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    if (typeof eligibilityCheck !== 'function') throw new TypeError('eligibilityCheck must be a function');
    if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function' || typeof sleep !== 'function') {
      throw new TypeError('clock and timer dependencies must be functions');
    }
    if (!Number.isFinite(reminderMs) || reminderMs < 1_000) throw new TypeError('reminderMs must be at least 1000');
    if (!Number.isFinite(deliveryTimeoutMs) || deliveryTimeoutMs < 100 || deliveryTimeoutMs > 30_000) {
      throw new TypeError('deliveryTimeoutMs must be between 100 and 30000');
    }
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 30_000) {
      throw new TypeError('retryDelayMs must be between 0 and 30000');
    }
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
      throw new TypeError('maxAttempts must be an integer from 1 to 5');
    }
    const normalizeDashboardUrl = (value) => {
      try {
        const parsed = new URL(value);
        if (
          !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
        ) throw new TypeError();
        return parsed.href;
      } catch {
        throw new TypeError('dashboardUrl must resolve to a loopback HTTP(S) URL');
      }
    };
    if (typeof dashboardUrl !== 'string' && typeof dashboardUrl !== 'function') {
      throw new TypeError('dashboardUrl must be a string or function');
    }
    if (typeof dashboardUrl === 'string') {
      const normalizedDashboardUrl = normalizeDashboardUrl(dashboardUrl);
      this.#dashboardUrl = () => normalizedDashboardUrl;
    } else {
      this.#dashboardUrl = () => normalizeDashboardUrl(dashboardUrl());
    }
    const resolvedSystemNotifier = systemNotifier ?? createSystemNotifier({ dashboardUrl: this.#dashboardUrl });
    if (typeof resolvedSystemNotifier !== 'function') throw new TypeError('systemNotifier must be a function');
    this.#store = new JsonStore(filePath, defaultStore);
    this.#fetch = fetchImpl;
    this.#systemNotifier = resolvedSystemNotifier;
    this.#eligibilityCheck = eligibilityCheck;
    this.#now = now;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
    this.#sleep = sleep;
    this.#reminderMs = reminderMs;
    this.#deliveryTimeoutMs = deliveryTimeoutMs;
    this.#retryDelayMs = retryDelayMs;
    this.#maxAttempts = maxAttempts;
  }

  async init() {
    if (this.#initialized) return;
    await this.#store.init();
    const data = validateStore(await this.#store.read());
    await this.#store.replace(data);
    if (typeof this.#systemNotifier.initialize === 'function') {
      await this.#systemNotifier.initialize().catch(() => {});
    }
    this.#initialized = true;
  }

  async observeTask(task) {
    await this.init();
    if (!task || typeof task.id !== 'string' || !task.id) throw new TypeError('task.id is required');
    return this.#enqueue(async () => {
      const timestamp = nowIso(this.#now);
      const active = isActiveVerification(task);
      let selected = null;
      await this.#store.update((data) => {
        validateStore(data);
        for (const record of data.records) {
          if (
            record.taskId === task.id && record.state === ACTIVE_STATE &&
            (!active || record.requestId !== task.userRequest.id)
          ) {
            record.state = 'resolved';
            record.resolvedAt = timestamp;
            record.updatedAt = timestamp;
            record.nextDueAt = null;
          }
        }
        if (!active) return;
        const id = stableAlertId(task.id, task.userRequest.id);
        selected = data.records.find((record) => record.id === id) || null;
        if (!selected) {
          const safeTaskName = boundedPublicText(task.displayName || task.id, 120, '浏览器任务');
          selected = {
            id,
            taskId: task.id,
            requestId: task.userRequest.id,
            kind: 'human_verification',
            state: ACTIVE_STATE,
            title: 'Eric Task Master 需要人工验证',
            message: `任务 ${safeTaskName} 正在等待人工验证，请打开本机控制面板处理。`,
            createdAt: timestamp,
            updatedAt: timestamp,
            nextDueAt: timestamp,
            deliveryCount: 0
          };
          data.records.push(selected);
          const activeRecords = data.records.filter((record) => record.state === ACTIVE_STATE);
          const inactive = data.records.filter((record) => record.state !== ACTIVE_STATE)
            .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
            .slice(0, Math.max(0, MAX_RECORDS - activeRecords.length));
          data.records = [...activeRecords, ...inactive];
        }
      });
      this.#schedule();
      return selected ? publicRecord(selected) : null;
    });
  }

  async resolveTask(taskId, { requestId } = {}) {
    await this.init();
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required');
    return this.#enqueue(async () => {
      const timestamp = nowIso(this.#now);
      let count = 0;
      await this.#store.update((data) => {
        validateStore(data);
        for (const record of data.records) {
          if (
            record.taskId === taskId &&
            (record.state === ACTIVE_STATE || record.state === 'claimed') &&
            (requestId === undefined || record.requestId === requestId)
          ) {
            record.state = 'resolved';
            record.resolvedAt = timestamp;
            record.updatedAt = timestamp;
            record.nextDueAt = null;
            count += 1;
          }
        }
      });
      this.#schedule();
      return { resolved: count };
    });
  }

  async claim(id) {
    await this.init();
    if (typeof id !== 'string' || !id) throw new TypeError('notification id is required');
    const claimed = await this.#markClaimed(id);
    if (claimed) await this.#waitForDeliverySettle(id);
    return claimed;
  }

  async #markClaimed(id) {
    return this.#enqueue(async () => {
      const timestamp = nowIso(this.#now);
      let claimed = null;
      await this.#store.update((data) => {
        validateStore(data);
        const record = data.records.find((entry) => entry.id === id);
        if (!record) return;
        if (record.state === ACTIVE_STATE) {
          record.state = 'claimed';
          record.claimedAt = timestamp;
          record.updatedAt = timestamp;
          record.nextDueAt = null;
        }
        claimed = record;
      });
      this.#schedule();
      return claimed ? publicRecord(claimed) : null;
    });
  }

  async claimTask(taskId, { requestId } = {}) {
    await this.init();
    if (typeof taskId !== 'string' || !taskId) throw new TypeError('taskId is required');
    if (typeof requestId !== 'string' || !requestId) throw new TypeError('requestId is required');
    const data = validateStore(await this.#store.read());
    const record = data.records.find((entry) => (
      entry.taskId === taskId && entry.requestId === requestId &&
      (entry.state === ACTIVE_STATE || entry.state === 'claimed')
    ));
    return record ? this.claim(record.id) : null;
  }

  async get(id) {
    await this.init();
    if (typeof id !== 'string' || !id) throw new TypeError('notification id is required');
    const data = validateStore(await this.#store.read());
    const record = data.records.find((entry) => entry.id === id);
    return record ? publicRecord(record) : null;
  }

  async markRead(id) {
    await this.init();
    if (typeof id !== 'string' || !id) throw new TypeError('notification id is required');
    return this.#enqueue(async () => {
      const timestamp = nowIso(this.#now);
      let selected = null;
      await this.#store.update((data) => {
        validateStore(data);
        const record = data.records.find((entry) => entry.id === id);
        if (!record) return;
        if (!record.readAt) record.readAt = timestamp;
        record.updatedAt = timestamp;
        selected = record;
      });
      return selected ? publicRecord(selected) : null;
    });
  }

  async markAllRead() {
    await this.init();
    return this.#enqueue(async () => {
      const timestamp = nowIso(this.#now);
      let updated = 0;
      await this.#store.update((data) => {
        validateStore(data);
        for (const record of data.records) {
          if (record.readAt) continue;
          record.readAt = timestamp;
          record.updatedAt = timestamp;
          updated += 1;
        }
      });
      return { updated, readAt: timestamp };
    });
  }

  async list({ state, limit = 100 } = {}) {
    await this.init();
    if (state !== undefined && !['active', 'claimed', 'resolved'].includes(state)) throw new TypeError('Unsupported notification state');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORDS) throw new TypeError(`limit must be from 1 to ${MAX_RECORDS}`);
    const data = validateStore(await this.#store.read());
    return data.records
      .filter((record) => state === undefined || record.state === state)
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, limit)
      .map(publicRecord);
  }

  async getSettings() {
    await this.init();
    const data = validateStore(await this.#store.read());
    return publicSettings(data.settings, this.#systemCapability());
  }

  async updateSettings(patch) {
    await this.init();
    const data = await this.#store.update((draft) => {
      validateStore(draft);
      draft.settings = applySettingsPatch(draft.settings, patch);
    });
    return publicSettings(data.settings, this.#systemCapability());
  }

  async testChannel(channel) {
    await this.init();
    if (!CHANNELS.includes(channel)) throw new TypeError('Unsupported notification channel');
    const result = await this.#deliverChannel(channel, {
      title: 'Eric Task Master 通知测试',
      message: '测试消息已送达。任务通知通道可以正常使用。',
      taskId: 'notification-test'
    }, { requireEnabled: false });
    const testedAt = nowIso(this.#now);
    const publicResult = { ...safeChannelResult(channel, result), testedAt };
    await this.#store.update((data) => {
      validateStore(data);
      data.settings.channels[channel].lastTest = clone(publicResult);
    });
    return publicResult;
  }

  async openSystemSettings() {
    await this.init();
    if (typeof this.#systemNotifier.openSettings !== 'function') {
      const error = new Error('System notification settings are unavailable');
      error.code = 'SYSTEM_NOTIFICATION_SETTINGS_UNAVAILABLE';
      throw error;
    }
    await this.#systemNotifier.openSettings();
    return this.getSettings();
  }

  #systemCapability() {
    if (typeof this.#systemNotifier.status === 'function') return this.#systemNotifier.status();
    return {
      state: this.#systemNotifier.configured === false ? 'unavailable' : 'ready',
      supported: this.#systemNotifier.supported !== false,
      configured: this.#systemNotifier.configured !== false,
      canOpenSettings: typeof this.#systemNotifier.openSettings === 'function'
    };
  }

  #taskTargetUrl(taskId) {
    const target = new URL(this.#dashboardUrl());
    if (taskId && taskId !== 'notification-test') target.searchParams.set('task', boundedPublicText(taskId, 128));
    return target.href;
  }

  async flush() {
    while (this.#deliveries.size) await Promise.allSettled([...this.#deliveries]);
    await this.#tail;
  }

  async close() {
    this.#closed = true;
    this.#scheduleGeneration += 1;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    await this.flush();
  }

  #enqueue(operation) {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.catch(() => {});
    return result;
  }

  #schedule() {
    if (!this.#initialized || this.#closed) return;
    const generation = ++this.#scheduleGeneration;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    void this.#store.read().then((data) => {
      if (this.#closed || generation !== this.#scheduleGeneration) return;
      const dueTimes = validateStore(data).records
        .filter((record) => (
          record.state === ACTIVE_STATE && record.nextDueAt && !this.#inFlight.has(record.id)
        ))
        .map((record) => Date.parse(record.nextDueAt))
        .filter(Number.isFinite);
      if (!dueTimes.length) return;
      const delay = Math.max(0, Math.min(...dueTimes) - this.#now());
      this.#timer = this.#setTimer(() => {
        this.#timer = null;
        void this.#pump();
      }, delay);
      this.#timer?.unref?.();
    }).catch(() => {});
  }

  async #pump() {
    if (this.#closed) return;
    const due = await this.#enqueue(async () => {
      const now = this.#now();
      const timestamp = nowIso(() => now);
      const selected = [];
      await this.#store.update((data) => {
        validateStore(data);
        for (const record of data.records) {
          if (
            record.state !== ACTIVE_STATE || !record.nextDueAt ||
            Date.parse(record.nextDueAt) > now || this.#inFlight.has(record.id)
          ) continue;
          record.attemptCount = (Number(record.attemptCount) || 0) + 1;
          record.lastAttemptAt = timestamp;
          record.updatedAt = timestamp;
          record.nextDueAt = new Date(now + this.#reminderMs).toISOString();
          selected.push(clone(record));
          this.#inFlight.add(record.id);
        }
      });
      this.#schedule();
      return selected;
    });
    for (const record of due) {
      const delivery = this.#deliverRecord(record).finally(() => {
        this.#inFlight.delete(record.id);
        this.#deliveries.delete(delivery);
        if (this.#deliveryByRecord.get(record.id) === delivery) this.#deliveryByRecord.delete(record.id);
        this.#schedule();
      });
      this.#deliveries.add(delivery);
      this.#deliveryByRecord.set(record.id, delivery);
    }
  }

  async #deliverRecord(record) {
    const data = validateStore(await this.#store.read());
    const current = data.records.find((entry) => entry.id === record.id);
    if (!current || current.state !== ACTIVE_STATE || current.requestId !== record.requestId) return;
    let eligibility = 'absent';
    try {
      const checked = await this.#eligibilityCheck({ taskId: record.taskId, requestId: record.requestId });
      eligibility = checked === true || checked === 'pending'
        ? 'pending'
        : checked === 'claimed'
          ? 'claimed'
          : 'absent';
    } catch {
      // A temporary TaskService/store failure is not evidence that the human
      // request disappeared. Keep the record active so the already-scheduled
      // 30-second cycle can retry instead of permanently swallowing the alert.
      return;
    }
    if (eligibility === 'claimed') {
      await this.#markClaimed(record.id);
      return;
    }
    if (eligibility !== 'pending') {
      await this.resolveTask(record.taskId, { requestId: record.requestId });
      return;
    }
    const safeRecord = publicRecord(record);
    const deliveryData = validateStore(await this.#store.read());
    const latest = deliveryData.records.find((entry) => entry.id === record.id);
    if (!latest || latest.state !== ACTIVE_STATE || latest.requestId !== record.requestId) return;
    const enabled = CHANNELS.filter((channel) => deliveryData.settings.channels[channel].enabled === true);
    const settled = await Promise.allSettled(enabled.map(async (channel) => safeChannelResult(
      channel,
      await this.#deliverChannel(channel, safeRecord)
    )));
    const results = settled.map((item, index) => item.status === 'fulfilled'
      ? item.value
      : safeChannelResult(enabled[index], { ok: false, attempts: 0, code: 'NOTIFICATION_DELIVERY_FAILED' }));
    const deliveredAt = nowIso(this.#now);
    const delivered = results.some((result) => result.ok === true);
    await this.#store.update((draft) => {
      validateStore(draft);
      const current = draft.records.find((entry) => entry.id === record.id);
      if (!current) return;
      if (delivered) {
        current.deliveryCount = (Number(current.deliveryCount) || 0) + 1;
        current.lastDeliveredAt = deliveredAt;
      }
      current.lastDelivery = Object.fromEntries(results.map((result) => [result.channel, result]));
      current.updatedAt = deliveredAt;
    });
  }

  async #deliverChannel(channel, record, { requireEnabled = true } = {}) {
    let lastError;
    let attempts = 0;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (!(await this.#recordIsActive(record))) {
        return { ok: false, attempts, code: 'NOTIFICATION_NO_LONGER_ACTIVE' };
      }
      const liveData = validateStore(await this.#store.read());
      const settings = liveData.settings.channels[channel];
      if (requireEnabled && settings?.enabled !== true) {
        return { ok: false, attempts, code: 'CHANNEL_DISABLED' };
      }
      let botToken;
      let chatId;
      let webhookUrl;
      let signingSecret;
      try {
        if (channel === 'telegram') {
          botToken = validateSecret(settings.botToken, 'channels.telegram.botToken', 512);
          chatId = validateSecret(settings.chatId, 'channels.telegram.chatId', 256);
        } else if (channel === 'feishu') {
          webhookUrl = validateFeishuWebhook(settings.webhookUrl);
          signingSecret = settings.signingSecret === null || settings.signingSecret === undefined
            ? null
            : validateSecret(settings.signingSecret, 'channels.feishu.signingSecret', 512);
        }
      } catch {
        return { ok: false, attempts, code: 'CHANNEL_CONFIG_INVALID' };
      }
      const configured = channel === 'system'
        ? this.#systemCapability().configured
        : channel === 'telegram'
          ? Boolean(botToken && chatId)
          : Boolean(webhookUrl);
      if (!configured) return { ok: false, attempts, code: 'CHANNEL_NOT_CONFIGURED' };
      attempts = attempt;
      try {
        await this.#withDeadline(async (signal) => {
          if (channel === 'system') {
            await this.#systemNotifier({
              title: record.title,
              message: record.message,
              targetUrl: this.#taskTargetUrl(record.taskId),
              signal
            });
            return;
          }
          if (channel === 'telegram') {
            const response = await this.#fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text: `${record.title}\n${record.message}` }),
              signal
            });
            await assertEndpointAccepted(response, 'telegram');
            return;
          }
          const feishuBody = { msg_type: 'text', content: { text: `${record.title}\n${record.message}` } };
          if (signingSecret) {
            const timestamp = String(Math.floor(this.#now() / 1_000));
            feishuBody.timestamp = timestamp;
            feishuBody.sign = createHmac('sha256', `${timestamp}\n${signingSecret}`).digest('base64');
          }
          const response = await this.#fetch(webhookUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(feishuBody),
            signal
          });
          await assertEndpointAccepted(response, 'feishu');
        });
        return { ok: true, attempts: attempt };
      } catch (error) {
        lastError = error;
        if (attempt >= this.#maxAttempts || !retryable(error)) break;
        if (this.#retryDelayMs > 0) await this.#sleep(this.#retryDelayMs * attempt);
      }
    }
    return {
      ok: false,
      attempts,
      code: boundedPublicText(
        lastError?.code || (lastError instanceof TypeError ? 'NOTIFICATION_NETWORK_ERROR' : ''),
        64,
        'NOTIFICATION_DELIVERY_FAILED'
      ),
      ...(Number.isInteger(lastError?.statusCode) ? { statusCode: lastError.statusCode } : {})
    };
  }

  async #recordIsActive(record) {
    if (!record?.id || !record?.requestId) return true;
    const data = validateStore(await this.#store.read());
    const current = data.records.find((entry) => entry.id === record.id);
    return Boolean(
      current && current.state === ACTIVE_STATE && current.requestId === record.requestId
    );
  }

  async #withDeadline(operation) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = this.#setTimer(() => {
        controller.abort();
        const error = new Error('Notification delivery timed out');
        error.code = 'NOTIFICATION_DELIVERY_TIMEOUT';
        reject(error);
      }, this.#deliveryTimeoutMs);
      timer?.unref?.();
    });
    try {
      let operationResult;
      try {
        operationResult = operation(controller.signal);
      } catch (error) {
        operationResult = Promise.reject(error);
      }
      await Promise.race([Promise.resolve(operationResult), timeout]);
    } finally {
      if (timer !== undefined) this.#clearTimer(timer);
    }
  }

  async #waitForDeliverySettle(id) {
    while (this.#inFlight.has(id)) {
      const delivery = this.#deliveryByRecord.get(id);
      if (delivery) {
        await delivery.catch(() => {});
        continue;
      }
      // A due record is reserved inside the serialized scheduler before its
      // delivery promise is installed. Yield once so claim cannot outrun that
      // narrow handoff and return while an old send is still starting.
      await Promise.resolve();
    }
  }
}

export const NOTIFICATION_DEFAULTS = Object.freeze({
  reminderMs: DEFAULT_REMINDER_MS,
  deliveryTimeoutMs: DEFAULT_DELIVERY_TIMEOUT_MS,
  retryDelayMs: DEFAULT_RETRY_DELAY_MS,
  maxAttempts: DEFAULT_MAX_ATTEMPTS
});
