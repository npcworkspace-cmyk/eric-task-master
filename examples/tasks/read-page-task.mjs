import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'read-page',
  version: '1.0.0',
  description: 'Open one HTTP(S) page and persist a bounded text-and-link snapshot.',
  intents: ['extract-text', 'read-page'],
  tags: ['builtin', 'observation'],
  outputs: ['json', 'screenshot'],
  preferredBehavior: 'fast',
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

export async function run({ page, input, outputDir, action, progress, checkpoint }) {
  const target = httpUrl(input?.url);
  const maxChars = Number.isSafeInteger(input?.maxChars) ? input.maxChars : 20_000;
  if (maxChars < 100 || maxChars > 50_000) throw new TypeError('maxChars is outside its bounded range');
  await mkdir(outputDir, { recursive: true });

  const response = await action.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await progress({ current: 1, total: 3, message: 'Page loaded' });
  const snapshot = await page.locator('body').evaluate((body, limit) => {
    const links = [...body.querySelectorAll('a[href]')].slice(0, 100).map((anchor) => ({
      text: (anchor.innerText || anchor.textContent || '').trim().slice(0, 300),
      href: anchor.href
    }));
    return {
      title: document.title.slice(0, 500),
      url: location.href,
      text: (body.innerText || body.textContent || '').slice(0, limit),
      links
    };
  }, maxChars);
  await progress({ current: 2, total: 3, message: 'Bounded page snapshot captured' });

  const artifactName = 'page-snapshot.json';
  await writeFile(path.join(outputDir, artifactName), `${JSON.stringify({
    ...snapshot,
    status: response?.status() ?? null,
    capturedAt: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
  if (input?.screenshot === true) {
    await page.screenshot({ path: path.join(outputDir, 'page.png'), fullPage: false });
  }
  await checkpoint({ stage: 'page-read', url: snapshot.url, artifact: artifactName });
  await progress({ current: 3, total: 3, message: 'Artifact persisted' });
  return {
    summary: `Read ${snapshot.text.length} characters from ${snapshot.title || snapshot.url}`,
    evidence: [
      { kind: 'url', value: snapshot.url },
      { kind: 'count', label: 'HTTP status', value: response?.status() ?? 0 },
      { kind: 'artifact', file: artifactName }
    ]
  };
}
