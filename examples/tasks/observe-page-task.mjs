import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'observe-page',
  version: '1.0.0',
  description: 'Capture a compact semantic page snapshot with short refs and stable locator hints.',
  intents: ['inspect-page', 'observe-page'],
  tags: ['builtin', 'observation', 'semantic'],
  outputs: ['json', 'screenshot'],
  risk: 'read',
  readOnly: true,
  supportsResume: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 4096 },
      scope: { type: 'string', enum: ['viewport', 'full_page'] },
      maxNodes: { type: 'integer', minimum: 1, maximum: 500 },
      maxTextChars: { type: 'integer', minimum: 0, maximum: 50_000 },
      screenshot: { type: 'boolean' }
    }
  }
});

export async function run({ page, input, outputDir, action, semantic, progress, checkpoint }) {
  const target = new URL(input.url);
  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('url must use HTTP(S)');
  await mkdir(outputDir, { recursive: true });
  await action.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await progress({ current: 1, total: 3, message: 'Page loaded' });

  const snapshot = await semantic.snapshot({
    scope: input.scope || 'viewport',
    maxNodes: input.maxNodes ?? 180,
    maxTextChars: input.maxTextChars ?? 12_000
  });
  const artifactName = 'semantic-snapshot.json';
  await writeFile(path.join(outputDir, artifactName), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await progress({ current: 2, total: 3, message: 'Semantic snapshot captured' });

  const evidence = [
    { kind: 'url', value: snapshot.url },
    { kind: 'count', label: 'semantic refs', value: snapshot.refs.length },
    { kind: 'artifact', file: artifactName, agentVisible: true }
  ];
  if (input.screenshot === true) {
    const screenshotName = 'page.png';
    await page.screenshot({ path: path.join(outputDir, screenshotName), fullPage: false });
    evidence.push({ kind: 'artifact', file: screenshotName, agentVisible: true });
  }
  await checkpoint({ stage: 'observed', url: snapshot.url, artifact: artifactName });
  await progress({ current: 3, total: 3, message: 'Observation persisted' });
  return {
    summary: `Observed ${snapshot.refs.length} interactive elements on ${snapshot.title || snapshot.url}`,
    evidence
  };
}
