import { rm } from 'node:fs/promises';

const CLEANUP_OPTIONS = Object.freeze({
  recursive: true,
  force: true,
  // Node retries only its documented transient recursive-rm failures and
  // still rejects after this bounded window, so real cleanup defects surface.
  maxRetries: 10,
  retryDelay: 100
});

export function removeTestTree(target, { remove = rm } = {}) {
  return remove(target, CLEANUP_OPTIONS);
}
