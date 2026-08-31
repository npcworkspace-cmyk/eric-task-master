import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'read-page',
  version: '1.0.0',
  description: 'Open one HTTP(S) page and persist a bounded text-and-link snapshot.',
  intents: ['extract-text', 'read-page'],
  tags: ['builtin', 'observation'],
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
      maxChars: { type: 'integer', minimum: 100, maximum: 50_000 },
      screenshot: { type: 'boolean' }
    }
  }
});

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('read-page only accepts HTTP(S) URLs');
  }
  return url.href;
}

export async function run({ page, input, outputDir, action, capture, progress, checkpoint }) {
  const target = httpUrl(input?.url);
  const maxChars = Number.isSafeInteger(input?.maxChars) ? input.maxChars : 20_000;
  if (maxChars < 100 || maxChars > 50_000) throw new TypeError('maxChars is outside its bounded range');
  await mkdir(outputDir, { recursive: true });

  const response = await action.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await progress({ current: 1, total: 3, message: 'Page loaded' });
  const body = page.locator('body');
  const linkLocator = body.locator('a[href]');
  const linkCount = await linkLocator.count().catch(() => 0);
  const links = [];
  for (let index = 0; index < Math.min(linkCount, 100); index += 1) {
    const link = linkLocator.nth(index);
    const rawHref = await link.getAttribute('href', { timeout: 2_000 }).catch(() => '');
    let href = String(rawHref || '').slice(0, 4_096);
    try {
      href = new URL(rawHref, page.url()).href.slice(0, 4_096);
    } catch {}
    const linkText = await link.innerText({ timeout: 2_000 }).catch(async () => (
      await link.textContent({ timeout: 2_000 }).catch(() => '')
    ));
    links.push({ text: String(linkText || '').trim().slice(0, 300), href });
  }
  const bodyText = await body.innerText({ timeout: 5_000 }).catch(async () => (
    await body.textContent({ timeout: 5_000 }).catch(() => '')
  ));
  const snapshot = {
    title: (await page.title().catch(() => '')).slice(0, 500),
    url: page.url(),
    text: String(bodyText || '').slice(0, maxChars),
    links
  };
  await progress({ current: 2, total: 3, message: 'Bounded page snapshot captured' });

  const artifactName = 'page-snapshot.json';
  await writeFile(path.join(outputDir, artifactName), `${JSON.stringify({
    ...snapshot,
    status: response?.status() ?? null,
    capturedAt: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
  if (input?.screenshot === true) {
    await capture.viewport({ file: 'page.png' });
  }
  await checkpoint({ stage: 'page-read', url: snapshot.url, artifact: artifactName });
  await progress({ current: 3, total: 3, message: 'Artifact persisted' });
  return {
    summary: `Read ${snapshot.text.length} characters from ${snapshot.title || snapshot.url}`,
    evidence: [
      { kind: 'url', value: snapshot.url },
      { kind: 'count', label: 'HTTP status', value: response?.status() ?? 0 },
      { kind: 'artifact', file: artifactName, agentVisible: true }
    ]
  };
}
