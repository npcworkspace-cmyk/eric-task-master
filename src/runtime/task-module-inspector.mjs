import { pathToFileURL } from 'node:url';

const MAX_METADATA_BYTES = 96 * 1024;
const send = process.send?.bind(process);
const exit = process.exit.bind(process);
const schedule = setTimeout;

function reply(nonce, result) {
  if (!send) exit(2);
  const payload = { type: 'task-module-inspection', nonce, ...result };
  try {
    send(payload, () => exit(0));
    schedule(() => exit(0), 100).unref();
  } catch {
    exit(3);
  }
}

process.once('message', async (message) => {
  if (
    !message
    || message.type !== 'inspect-task-module'
    || typeof message.nonce !== 'string'
    || typeof message.snapshotPath !== 'string'
    || typeof message.sha256 !== 'string'
  ) {
    exit(2);
  }

  let loaded;
  try {
    loaded = await import(`${pathToFileURL(message.snapshotPath).href}?sha256=${message.sha256}`);
  } catch {
    reply(message.nonce, { ok: false, reason: 'load' });
    return;
  }
  if (typeof loaded.run !== 'function') {
    reply(message.nonce, { ok: false, reason: 'contract' });
    return;
  }

  let metadataJson;
  try {
    metadataJson = JSON.stringify(loaded.meta ?? {});
  } catch {
    reply(message.nonce, { ok: false, reason: 'metadata' });
    return;
  }
  if (typeof metadataJson !== 'string' || Buffer.byteLength(metadataJson) > MAX_METADATA_BYTES) {
    reply(message.nonce, { ok: false, reason: 'metadata-size' });
    return;
  }
  reply(message.nonce, { ok: true, metadataJson });
});
