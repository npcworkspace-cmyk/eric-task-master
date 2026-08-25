import { readFile } from 'node:fs/promises';

const TRANSIENT_READ_ERRORS = new Set(['EACCES', 'EBUSY', 'EPERM']);

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForManagerShutdownProof(pidFile, expected, {
  timeoutMs = 5_000,
  pollMs = 100
} = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const current = JSON.parse(await readFile(pidFile, 'utf8'));
      if (
        current?.pid !== expected?.pid ||
        current?.version !== expected?.version ||
        current?.baseUrl !== expected?.baseUrl
      ) return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      if (TRANSIENT_READ_ERRORS.has(error?.code) && Date.now() < deadline) {
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
        continue;
      }
      return false;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}
