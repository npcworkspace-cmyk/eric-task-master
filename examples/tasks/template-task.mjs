import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'task-template',
  version: '1.0.0',
  description: 'Copyable single-file Task Master module with durable output and compact evidence.',
  intents: ['read-page'],
  tags: ['template'],
  outputs: ['json'],
  risk: 'read',
  readOnly: true,
  supportsResume: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: { url: { type: 'string', minLength: 8, maxLength: 4096 } }
  }
});

export async function run({ page, input, outputDir, action, progress, checkpoint }) {
  const target = new URL(input.url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('url must use HTTP(S)');
  await mkdir(outputDir, { recursive: true });

  await action.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await progress({ current: 1, total: 2, message: 'Target loaded' });

  const body = page.locator('body');
  const result = {
    title: (await page.title().catch(() => '')).slice(0, 500),
    url: page.url(),
    text: String(
      await body.innerText({ timeout: 5_000 }).catch(async () => (
        await body.textContent({ timeout: 5_000 }).catch(() => '')
      ))
    ).slice(0, 20_000)
  };
  const artifactName = 'result.json';
  await writeFile(path.join(outputDir, artifactName), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await checkpoint({ stage: 'persisted', url: result.url, artifact: artifactName });
  await progress({ current: 2, total: 2, message: 'Result persisted' });

  return {
    summary: `Captured ${result.text.length} characters from ${result.title || result.url}`,
    evidence: [
      { kind: 'url', value: result.url },
      { kind: 'artifact', file: artifactName, agentVisible: true },
      { kind: 'message', label: 'behavior mode', value: action.mode }
    ]
  };
}
