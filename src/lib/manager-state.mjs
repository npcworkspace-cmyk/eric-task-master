import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

export async function readManagerConfig(filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const config = JSON.parse(await readFile(filePath, 'utf8'));
      if (!config || typeof config.managerToken !== 'string' || config.managerToken.length < 32) {
        throw new Error('Local Manager configuration is incomplete');
      }
      return config;
    } catch (error) {
      if (attempt === 3) throw error;
      // External tools sometimes rewrite the small config in place. Tolerate
      // the short truncate/write interval without treating it as lost identity.
      await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
    }
  }
}

export function managerStateId(stateInstanceId, stateDir) {
  if (typeof stateInstanceId !== 'string' || stateInstanceId.length < 16 || !stateDir) return null;
  const resolved = path.resolve(stateDir);
  const canonical = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return `state_${createHash('sha256').update(`${stateInstanceId}\0${canonical}`).digest('base64url').slice(0, 24)}`;
}

export function managerRecoveryProof(managerToken, stateId, nonce, { force = false } = {}) {
  if (typeof managerToken !== 'string' || managerToken.length < 32 ||
      typeof stateId !== 'string' || !stateId || typeof nonce !== 'string' || nonce.length < 16) return null;
  return createHmac('sha256', managerToken)
    .update(`eric-task-master:state-recovery:v1\n${stateId}\n${nonce}\n${force ? 'contain' : 'idle'}`)
    .digest('base64url');
}
