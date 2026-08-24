import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_RECEIPT_BYTES = 4 * 1024;
const RECEIPT_VERSION = 1;
const INTERNAL_ID = /^[a-zA-Z0-9._:-]{1,128}$/u;

function validTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function sameFile(left, right) {
  return typeof left?.dev === 'bigint' && typeof left?.ino === 'bigint' &&
    typeof right?.dev === 'bigint' && typeof right?.ino === 'bigint' &&
    left.ino > 0n && right.ino > 0n && left.dev === right.dev && left.ino === right.ino;
}

function validReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return false;
  if (receipt.version !== RECEIPT_VERSION || !['task', 'profile', 'session'].includes(receipt.kind)) return false;
  if (!Number.isSafeInteger(receipt.workerPid) || receipt.workerPid <= 0) return false;
  if (!validTimestamp(receipt.closedAt)) return false;
  if (receipt.kind === 'task') {
    return INTERNAL_ID.test(receipt.taskId) &&
      Number.isSafeInteger(receipt.attempt) && receipt.attempt >= 1;
  }
  if (receipt.kind === 'session') {
    return INTERNAL_ID.test(receipt.profileId) &&
      typeof receipt.ownerId === 'string' && /^session-import:/u.test(receipt.ownerId) &&
      ['committed', 'rolled_back'].includes(receipt.outcome);
  }
  return INTERNAL_ID.test(receipt.profileId) &&
    typeof receipt.ownerId === 'string' && /^profile-open:/u.test(receipt.ownerId);
}

export async function writeCleanupReceipt(filePath, receipt) {
  const value = {
    version: RECEIPT_VERSION,
    ...receipt,
    workerPid: process.pid,
    closedAt: new Date().toISOString()
  };
  if (!validReceipt(value)) throw new TypeError('Cleanup receipt is invalid');
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return value;
}

export async function verifyCleanupReceipt(filePath, expected) {
  let handle;
  try {
    const before = await lstat(filePath, { bigint: true });
    if (
      !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.ino <= 0n ||
      before.size < 2n || before.size > BigInt(MAX_RECEIPT_BYTES)
    ) {
      return false;
    }
    handle = await open(filePath, 'r');
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) return false;
    const source = await handle.readFile('utf8');
    const afterRead = await handle.stat({ bigint: true });
    const currentPath = await lstat(filePath, { bigint: true });
    if (
      !sameFile(opened, afterRead) || !sameFile(opened, currentPath) ||
      opened.size !== afterRead.size || opened.mtimeNs !== afterRead.mtimeNs
    ) {
      return false;
    }
    const receipt = JSON.parse(source);
    if (!validReceipt(receipt)) return false;
    for (const [key, value] of Object.entries(expected || {})) {
      if (receipt[key] !== value) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function removeCleanupReceipt(filePath) {
  await rm(filePath, { force: true });
}
