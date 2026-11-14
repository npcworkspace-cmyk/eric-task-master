import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonStore } from './json-store.mjs';
import { redactSensitiveValue } from './redaction.mjs';
import { opsError } from './operations-contracts.mjs';

export const operationId = (prefix = 'op') => `${prefix}_${randomUUID().replaceAll('-', '')}`;
// Domain authorization is a permission envelope, never an HTTP Authorization header.
export function safeOperationsValue(value) {
  const transform = (item, reverse = false) => {
    if (Array.isArray(item)) return item.map((child) => transform(child, reverse));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).filter(([key]) => !/^(?:otp|verificationCode|oneTimeCode|passcode|twoFactorCode)$/iu.test(key)).map(([key, child]) => [
      reverse && key === 'operationPermissionEnvelope' ? 'authorization' :
        !reverse && key === 'authorization' && child && typeof child === 'object' && !Array.isArray(child) &&
          typeof child.accountId === 'string' && Number.isSafeInteger(child.version) ? 'operationPermissionEnvelope' : key,
      transform(child, reverse)
    ]));
  };
  return transform(redactSensitiveValue(transform(value), { maxDepth: 30, maxItems: 10001 }), true);
}
export class OperationsStore {
  constructor({ stateDir, now = Date.now, maxBytes = 8 * 1024 * 1024, maxRecords = 10000, retentionMs = 30 * 86400000 }) {
    this.now = now; this.maxBytes = maxBytes; this.maxRecords = maxRecords; this.retentionMs = retentionMs;
    this.store = new JsonStore(path.join(stateDir, 'operations.json'), { version: 1, operations: [], actions: [], commands: [], events: [], records: [] });
  }
  async init() { await this.store.init(); return this; }
  async read() { return this.store.read(); }
  async update(change, { emergency = false } = {}) {
    let result;
    try { await this.store.update(async (data) => {
      result = await change(data);
      for (const collection of ['actions', 'commands', 'events', 'records']) {
        data[collection] = data[collection].filter((item) => {
          const terminal = collection === 'events' ? item.state === 'handled' : ['confirmed', 'failed', 'stopped'].includes(item.status);
          return !terminal || this.now() - Date.parse(item.updatedAt || item.createdAt) <= this.retentionMs;
        });
      }
      const safe = safeOperationsValue(data);
      if (JSON.stringify(safe).includes('[truncated]') || JSON.stringify(safe).includes('__taskMasterTruncated')) throw opsError('RECORD_TOO_DEEP', 'Record exceeds storage structural limits');
      const reserve = emergency ? 0 : Math.min(4096, Math.floor(this.maxBytes / 8));
      if (Object.values(data).some((value) => Array.isArray(value) && value.length > this.maxRecords) || Buffer.byteLength(JSON.stringify(safe)) > this.maxBytes - reserve) {
        throw opsError('OPERATIONS_STORAGE_LIMIT', 'Operations storage limit reached; archive confirmed records before continuing', 409);
      }
      Object.assign(data, safe);
    }); } catch (error) {
      if (error.code === 'OPERATIONS_STORAGE_LIMIT' && !emergency) {
        const paused = await this.pauseForCapacity();
        await this.onCapacity?.(paused);
      }
      throw error;
    }
    return safeOperationsValue(result);
  }
  async pauseForCapacity() {
    return this.update((data) => {
      data.storageFailure = { code: 'OPERATIONS_STORAGE_LIMIT', at: new Date(this.now()).toISOString(), message: 'Storage capacity reached; automation paused; retain safety evidence and archive confirmed records before resuming' };
      const paused = [];
      for (const operation of data.operations) if (!['stopped', 'revoked', 'failed'].includes(operation.status)) {
        operation.status = 'paused'; paused.push({ id: operation.id, taskId: operation.taskId });
      }
      return paused;
    }, { emergency: true });
  }
  async recover() {
    return this.update((data) => {
      for (const action of data.actions) if (action.status === 'initiated') action.status = 'unknown';
      for (const command of data.commands) if (command.status === 'pending') command.status = 'unknown';
      for (const operation of data.operations) if (!['stopped', 'revoked', 'failed'].includes(operation.status)) {
        if (operation.status !== 'paused') operation.status = 'reconcile-required';
        operation.pending = null;
      }
    });
  }
  assertUnchanged() { return this.store.assertUnchanged(); }
  fence() { this.store.fence(); }
}
