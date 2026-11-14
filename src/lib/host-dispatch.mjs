import { spawn } from 'node:child_process';
import { opsError } from './operations-contracts.mjs';

export function dispatchHost(adapter, event, { timeoutMs = 10000, maxBytes = 65536 } = {}) {
  if (!adapter?.executable || !Array.isArray(adapter.args) || adapter.args.some((arg) => typeof arg !== 'string')) throw opsError('HOST_ADAPTER_REQUIRED', 'An explicitly configured executable/argument-array host adapter is required', 409);
  return new Promise((resolve, reject) => {
    const child = spawn(adapter.executable, adapter.args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = ''; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(opsError('HOST_DISPATCH_TIMEOUT', 'Host receipt timed out')), Math.min(30000, timeoutMs));
    child.on('error', (error) => finish(error));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => { output += chunk; if (Buffer.byteLength(output) > maxBytes) finish(opsError('HOST_RECEIPT_TOO_LARGE', 'Host receipt exceeded size limit')); });
    child.on('close', (code) => {
      if (code !== 0) return finish(opsError('HOST_DISPATCH_FAILED', 'Host adapter exited without a successful receipt'));
      let receipt; try { receipt = JSON.parse(output); } catch { return finish(opsError('HOST_RECEIPT_INVALID', 'Host receipt must be JSON')); }
      if (receipt.accepted !== true || receipt.eventId !== event.id || typeof receipt.deliveryId !== 'string' || !receipt.deliveryId) return finish(opsError('HOST_RECEIPT_INVALID', 'Host must identify accepted event and delivery'));
      finish(null, receipt);
    });
    child.stdin.end(JSON.stringify({ schemaVersion: 1, event }));
  });
}
