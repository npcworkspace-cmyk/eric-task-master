export const TASK_RECIPES = Object.freeze([
  'single-page',
  'paginated-list',
  'list-detail',
  'resumable-batch',
  'form-workflow'
]);

function header(taskName, { description, intents, risk = 'read', readOnly = true, supportsResume = false, schema }) {
  return [
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    '',
    '// Runtime owns browser/extension coordination; visible mutations stay in journey; extension-dependent steps use extensionFlow.',
    '',
    'export const meta = Object.freeze({',
    `  name: ${JSON.stringify(taskName)},`,
    "  version: '1.0.0',",
    `  description: ${JSON.stringify(description)},`,
    `  intents: ${JSON.stringify(intents)},`,
    `  tags: ['recipe', ${JSON.stringify(intents[0])}],`,
    "  outputs: ['json'],",
    `  risk: ${JSON.stringify(risk)},`,
    `  readOnly: ${readOnly},`,
    "  interactionContract: 'full-human-v1',",
    `  supportsResume: ${supportsResume},`,
    `  inputSchema: ${JSON.stringify(schema, null, 2).replaceAll('\n', '\n  ')}`,
    '});',
    '',
    'async function persist(outputDir, file, value) {',
    '  await mkdir(path.dirname(path.join(outputDir, file)), { recursive: true });',
    "  await writeFile(path.join(outputDir, file), JSON.stringify(value, null, 2) + '\\n', { mode: 0o600 });",
    '}',
    '',
    'async function readPage(page) {',
    "  const body = page.locator('body');",
    "  const text = await body.innerText().catch(async () => await body.textContent() || '');",
    '  return { title: (await page.title()).slice(0, 500), url: page.url(), text: text.slice(0, 20_000) };',
    '}',
    '',
    'async function readRows(page, selector, limit = 500) {',
    '  const collection = page.locator(selector);',
    '  const count = Math.min(await collection.count(), limit);',
    '  const rows = [];',
    '  for (let index = 0; index < count; index += 1) {',
    '    const node = collection.nth(index);',
    "    const text = (await node.innerText().catch(async () => await node.textContent() || '')).trim().slice(0, 2_000);",
    "    let href = await node.getAttribute('href').catch(() => null);",
    "    if (!href) href = await node.locator('a[href]').first().getAttribute('href').catch(() => null);",
    '    rows.push({ text, href: href ? new URL(href, page.url()).href : null });',
    '  }',
    '  return rows;',
    '}',
    ''
  ];
}

const URL_SCHEMA = { type: 'string', minLength: 8, maxLength: 4096 };

function singlePage(taskName) {
  return [...header(taskName, {
    description: 'Read one page and persist a bounded structured artifact.',
    intents: ['single-page'],
    schema: {
      type: 'object', additionalProperties: false, required: ['url'],
      properties: { url: URL_SCHEMA }
    }
  }),
  'export async function run({ page, input, outputDir, journey, progress, checkpoint }) {',
  '  const target = new URL(input.url);',
  "  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('url must use HTTP(S)');",
  "  await journey.open(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  "  await progress({ current: 1, total: 2, message: 'Page loaded' });",
  '  const data = await readPage(page);',
  "  const file = 'result.json';",
  '  await persist(outputDir, file, data);',
  "  await checkpoint({ stage: 'complete', artifact: file, url: data.url });",
  "  await progress({ current: 2, total: 2, message: 'Artifact persisted' });",
  '  return { summary: `Captured ${data.text.length} characters`, evidence: [',
  "    { kind: 'url', value: data.url }, { kind: 'artifact', file, agentVisible: true }",
  '  ] };',
  '}', ''].join('\n');
}

function paginatedList(taskName) {
  return [...header(taskName, {
    description: 'Traverse a bounded next-page list with checkpoints and deterministic JSON output.',
    intents: ['paginated-list'],
    supportsResume: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['url', 'itemSelector', 'nextSelector'],
      properties: {
        url: URL_SCHEMA,
        itemSelector: { type: 'string', minLength: 1, maxLength: 500 },
        nextSelector: { type: 'string', minLength: 1, maxLength: 500 },
        maxPages: { type: 'integer', minimum: 1, maximum: 100, default: 10 }
      }
    }
  }),
  'export async function run({ page, input, outputDir, journey, progress, checkpoint }) {',
  '  const previous = await checkpoint.read();',
  '  const maxPages = input.maxPages ?? 10;',
  '  const rows = Array.isArray(previous?.rows) ? previous.rows : [];',
  '  let nextUrl = previous?.nextUrl || new URL(input.url).href;',
  '  let pageIndex = previous?.pageIndex ?? 0;',
  '  if (nextUrl && pageIndex < maxPages) {',
  "    await journey.open(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  '  }',
  '  while (nextUrl && pageIndex < maxPages) {',
  '    const items = await readRows(page, input.itemSelector, 500);',
  '    rows.push(...items);',
  '    const nextControl = page.locator(input.nextSelector).first();',
  "    nextUrl = await nextControl.getAttribute('href').catch(() => null);",
  '    if (nextUrl) nextUrl = new URL(nextUrl, page.url()).href;',
  '    pageIndex += 1;',
  '    await checkpoint({ pageIndex, nextUrl, rows });',
  "    await progress({ current: pageIndex, total: maxPages, message: 'List page persisted' });",
  '    if (nextUrl && pageIndex < maxPages) {',
  "      await journey.nextPage(nextControl, { timeoutMs: 30_000 });",
  '    }',
  '  }',
  "  const file = 'result.json';",
  '  await persist(outputDir, file, { pages: pageIndex, count: rows.length, rows });',
  '  return { summary: `Captured ${rows.length} list items across ${pageIndex} pages`, evidence: [',
  "    { kind: 'count', value: rows.length }, { kind: 'artifact', file, agentVisible: true }",
  '  ] };',
  '}', ''].join('\n');
}

function listDetail(taskName) {
  return [...header(taskName, {
    description: 'Collect bounded links from one list and visit each detail page with progress evidence.',
    intents: ['list-detail'],
    schema: {
      type: 'object', additionalProperties: false, required: ['url', 'itemSelector'],
      properties: {
        url: URL_SCHEMA,
        itemSelector: { type: 'string', minLength: 1, maxLength: 500 },
        maxItems: { type: 'integer', minimum: 1, maximum: 500, default: 50 }
      }
    }
  }),
  'export async function run({ page, input, outputDir, journey, progress, checkpoint }) {',
  '  const maxItems = input.maxItems ?? 50;',
  "  await journey.open(new URL(input.url).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  '  const urls = (await readRows(page, input.itemSelector, maxItems)).map((row) => row.href).filter(Boolean);',
  '  const details = [];',
  '  for (const [index, url] of urls.entries()) {',
  "    await journey.navigate(page.locator(input.itemSelector).nth(index), { timeoutMs: 30_000 });",
  '    details.push(await readPage(page));',
  '    await checkpoint({ nextIndex: index + 1, count: details.length });',
  "    await progress({ current: index + 1, total: urls.length, message: 'Detail persisted' });",
  '    if (index + 1 < urls.length) await journey.back({ timeoutMs: 30_000 });',
  '  }',
  "  const file = 'result.json';",
  '  await persist(outputDir, file, { count: details.length, details });',
  '  return { summary: `Captured ${details.length} detail pages`, evidence: [',
  "    { kind: 'count', value: details.length }, { kind: 'artifact', file, agentVisible: true }",
  '  ] };',
  '}', ''].join('\n');
}

function resumableBatch(taskName) {
  return [...header(taskName, {
    description: 'Process a bounded URL batch with resume-first checkpoint discipline and deterministic files.',
    intents: ['resumable-batch'],
    supportsResume: true,
    schema: {
      type: 'object', additionalProperties: false, required: ['urls'],
      properties: { urls: { type: 'array', minItems: 1, maxItems: 1000, items: URL_SCHEMA } }
    }
  }),
  'export async function run({ page, input, outputDir, journey, progress, checkpoint }) {',
  '  const previous = await checkpoint.read();',
  '  const start = previous?.nextIndex ?? 0;',
  '  const manifest = Array.isArray(previous?.manifest) ? previous.manifest : [];',
  '  for (let index = start; index < input.urls.length; index += 1) {',
  '    const url = new URL(input.urls[index]).href;',
  "    await journey.open(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  '    const item = await readPage(page);',
  "    const file = 'items/' + String(index).padStart(6, '0') + '.json';",
  '    await persist(outputDir, file, item);',
  '    manifest[index] = { index, file, url: item.url };',
  '    await checkpoint({ nextIndex: index + 1, manifest });',
  "    await progress({ current: index + 1, total: input.urls.length, message: 'Batch unit persisted' });",
  '  }',
  "  const file = 'manifest.json';",
  '  await persist(outputDir, file, { count: manifest.length, items: manifest });',
  '  return { summary: `Completed ${manifest.length} deterministic batch units`, evidence: [',
  "    { kind: 'count', value: manifest.length }, { kind: 'artifact', file, agentVisible: true }",
  '  ] };',
  '}', ''].join('\n');
}

function formWorkflow(taskName) {
  return [...header(taskName, {
    description: 'Fill and submit one explicit form with a required post-submit verification locator.',
    intents: ['form-workflow'],
    risk: 'write',
    readOnly: false,
    schema: {
      type: 'object', additionalProperties: false, required: ['url', 'fields', 'submitSelector', 'successSelector'],
      properties: {
        url: URL_SCHEMA,
        fields: {
          type: 'array', minItems: 1, maxItems: 50,
          items: {
            type: 'object', additionalProperties: false, required: ['selector', 'value'],
            properties: {
              selector: { type: 'string', minLength: 1, maxLength: 500 },
              value: { type: 'string', maxLength: 10000 }
            }
          }
        },
        submitSelector: { type: 'string', minLength: 1, maxLength: 500 },
        successSelector: { type: 'string', minLength: 1, maxLength: 500 }
      }
    }
  }),
  'export async function run({ page, input, outputDir, journey, progress, checkpoint }) {',
  "  await journey.open(new URL(input.url).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  '  for (const [index, field] of input.fields.entries()) {',
  '    await journey.fill(page.locator(field.selector).first(), field.value);',
  "    await progress({ current: index + 1, total: input.fields.length + 1, message: 'Form field completed' });",
  '  }',
  '  await journey.click(page.locator(input.submitSelector).first());',
  '  await page.locator(input.successSelector).first().waitFor({ state: \'visible\', timeout: 30_000 });',
  '  const result = { submitted: true, verifiedAt: new Date().toISOString(), url: page.url() };',
  "  const file = 'result.json';",
  '  await persist(outputDir, file, result);',
  "  await checkpoint({ stage: 'verified', artifact: file });",
  "  await progress({ current: input.fields.length + 1, total: input.fields.length + 1, message: 'Submission verified' });",
  '  return { summary: `Form submission verified at ${result.url}`, evidence: [',
  "    { kind: 'url', value: result.url }, { kind: 'artifact', file, agentVisible: true }",
  '  ] };',
  '}', ''].join('\n');
}

export function createTaskRecipeSource(taskName, recipe = 'single-page') {
  if (!TASK_RECIPES.includes(recipe)) {
    throw new TypeError(`recipe must be one of: ${TASK_RECIPES.join(', ')}`);
  }
  if (recipe === 'single-page') return singlePage(taskName);
  if (recipe === 'paginated-list') return paginatedList(taskName);
  if (recipe === 'list-detail') return listDetail(taskName);
  if (recipe === 'resumable-batch') return resumableBatch(taskName);
  return formWorkflow(taskName);
}
