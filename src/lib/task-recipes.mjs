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
    'export const meta = Object.freeze({',
    `  name: ${JSON.stringify(taskName)},`,
    "  version: '1.0.0',",
    `  description: ${JSON.stringify(description)},`,
    `  intents: ${JSON.stringify(intents)},`,
    `  tags: ['recipe', ${JSON.stringify(intents[0])}],`,
    "  outputs: ['json'],",
    `  risk: ${JSON.stringify(risk)},`,
    `  readOnly: ${readOnly},`,
    `  supportsResume: ${supportsResume},`,
    `  inputSchema: ${JSON.stringify(schema, null, 2).replaceAll('\n', '\n  ')}`,
    '});',
    '',
    'async function persist(outputDir, file, value) {',
    '  await mkdir(path.dirname(path.join(outputDir, file)), { recursive: true });',
    "  await writeFile(path.join(outputDir, file), JSON.stringify(value, null, 2) + '\\n', { mode: 0o600 });",
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
  'export async function run({ page, input, outputDir, action, progress, checkpoint }) {',
  '  const target = new URL(input.url);',
  "  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('url must use HTTP(S)');",
  "  await action.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  "  await progress({ current: 1, total: 2, message: 'Page loaded' });",
  "  const data = await page.locator('body').evaluate((body) => ({",
  '    title: document.title.slice(0, 500), url: location.href,',
  "    text: (body.innerText || body.textContent || '').slice(0, 20_000)",
  '  }));',
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
  'export async function run({ page, input, outputDir, action, progress, checkpoint }) {',
  '  const previous = await checkpoint.read();',
  '  const maxPages = input.maxPages ?? 10;',
  '  const rows = Array.isArray(previous?.rows) ? previous.rows : [];',
  '  let nextUrl = previous?.nextUrl || new URL(input.url).href;',
  '  let pageIndex = previous?.pageIndex ?? 0;',
  '  while (nextUrl && pageIndex < maxPages) {',
  "    await action.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  '    const items = await page.locator(input.itemSelector).evaluateAll((nodes) => nodes.slice(0, 500).map((node) => ({',
  "      text: (node.innerText || node.textContent || '').trim().slice(0, 2_000),",
  "      href: node.href || node.querySelector?.('a[href]')?.href || null",
  '    })));',
  '    rows.push(...items);',
  "    nextUrl = await page.locator(input.nextSelector).first().getAttribute('href').catch(() => null);",
  '    if (nextUrl) nextUrl = new URL(nextUrl, page.url()).href;',
  '    pageIndex += 1;',
  '    await checkpoint({ pageIndex, nextUrl, rows });',
  "    await progress({ current: pageIndex, total: maxPages, message: 'List page persisted' });",
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
  'export async function run({ page, input, outputDir, action, progress, checkpoint }) {',
  '  const maxItems = input.maxItems ?? 50;',
  "  await action.goto(new URL(input.url).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  '  const urls = await page.locator(input.itemSelector).evaluateAll((nodes, limit) => nodes.slice(0, limit).map((node) =>',
  "    node.href || node.querySelector?.('a[href]')?.href || null).filter(Boolean), maxItems);",
  '  const details = [];',
  '  for (const [index, url] of urls.entries()) {',
  "    await action.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  "    details.push(await page.locator('body').evaluate((body) => ({",
  "      url: location.href, title: document.title.slice(0, 500), text: (body.innerText || '').slice(0, 20_000)",
  '    })));',
  '    await checkpoint({ nextIndex: index + 1, count: details.length });',
  "    await progress({ current: index + 1, total: urls.length, message: 'Detail persisted' });",
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
  'export async function run({ page, input, outputDir, action, progress, checkpoint }) {',
  '  const previous = await checkpoint.read();',
  '  const start = previous?.nextIndex ?? 0;',
  '  const manifest = Array.isArray(previous?.manifest) ? previous.manifest : [];',
  '  for (let index = start; index < input.urls.length; index += 1) {',
  '    const url = new URL(input.urls[index]).href;',
  "    await action.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  "    const item = await page.locator('body').evaluate((body) => ({",
  "      url: location.href, title: document.title.slice(0, 500), text: (body.innerText || '').slice(0, 20_000)",
  '    }));',
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
  'export async function run({ page, input, outputDir, action, progress, checkpoint }) {',
  "  await action.goto(new URL(input.url).href, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
  '  for (const [index, field] of input.fields.entries()) {',
  '    await action.fill(page.locator(field.selector).first(), field.value);',
  "    await progress({ current: index + 1, total: input.fields.length + 1, message: 'Form field completed' });",
  '  }',
  '  await action.click(page.locator(input.submitSelector).first());',
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
