import { rm, writeFile } from 'node:fs/promises';
import { redactSensitiveText } from './redaction.mjs';

export async function shutdownManagerProcess({
  manager,
  pidFile,
  failureFile,
  pidRecord,
  trigger
}) {
  try {
    await manager.stop();
    await rm(pidFile, { force: true });
    await rm(failureFile, { force: true }).catch(() => {});
  } catch (error) {
    const evidence = {
      ...pidRecord,
      trigger,
      failedAt: new Date().toISOString(),
      error: {
        code: error?.code || 'MANAGER_STOP_FAILED',
        message: redactSensitiveText(error?.message || 'Manager shutdown failed').slice(0, 2_000)
      }
    };
    await writeFile(failureFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
    throw error;
  }
}
