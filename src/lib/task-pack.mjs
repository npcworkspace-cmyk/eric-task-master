import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PACK_NAME = /^[a-z][a-z0-9._-]{0,79}$/;
const TASK_NAME = /^[a-z][a-z0-9._-]{0,79}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_MANIFEST_BYTES = 256 * 1024;

export class TaskPackError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'TaskPackError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function exactKeys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new TaskPackError('INVALID_TASK_PACK', `${label} has unsupported fields: ${unknown.join(', ')}`);
  }
}

function boundedText(value, field, maximum, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new TaskPackError(
      'INVALID_TASK_PACK',
      `${field} must contain 1 to ${maximum} characters`
    );
  }
  return value.trim();
}

export async function readTaskPack(location) {
  if (typeof location !== 'string' || !location) {
    throw new TaskPackError('TASK_PACK_PATH_REQUIRED', 'Task Pack directory or taskpack.json path is required');
  }
  const requested = path.resolve(location);
  const stats = await lstat(requested).catch(() => null);
  if (!stats || stats.isSymbolicLink()) {
    throw new TaskPackError('TASK_PACK_NOT_FOUND', 'Task Pack path must be a regular directory or manifest');
  }
  const manifestPath = stats.isDirectory() ? path.join(requested, 'taskpack.json') : requested;
  if (path.basename(manifestPath).toLowerCase() !== 'taskpack.json') {
    throw new TaskPackError('INVALID_TASK_PACK', 'Task Pack manifest must be named taskpack.json');
  }
  const manifestStats = await lstat(manifestPath).catch(() => null);
  if (!manifestStats?.isFile() || manifestStats.isSymbolicLink() || manifestStats.size > MAX_MANIFEST_BYTES) {
    throw new TaskPackError('INVALID_TASK_PACK', 'taskpack.json must be a regular file of at most 256 KiB');
  }
  const canonicalManifest = await realpath(manifestPath);
  const root = await realpath(path.dirname(canonicalManifest));
  if (!inside(root, canonicalManifest)) {
    throw new TaskPackError('INVALID_TASK_PACK', 'Task Pack manifest resolves outside its directory');
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(canonicalManifest, 'utf8'));
  } catch {
    throw new TaskPackError('INVALID_TASK_PACK', 'taskpack.json must contain valid JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TaskPackError('INVALID_TASK_PACK', 'taskpack.json must contain one object');
  }
  exactKeys(manifest, new Set(['name', 'version', 'title', 'description', 'tasks']), 'taskpack.json');
  const name = boundedText(manifest.name, 'Task Pack name', 80, { required: true });
  const version = boundedText(manifest.version, 'Task Pack version', 64, { required: true });
  if (!PACK_NAME.test(name)) {
    throw new TaskPackError('INVALID_TASK_PACK', 'Task Pack name must be a lowercase identifier');
  }
  if (!VERSION.test(version)) {
    throw new TaskPackError('INVALID_TASK_PACK', 'Task Pack version must use semantic versioning');
  }
  const title = boundedText(manifest.title, 'Task Pack title', 120);
  const description = boundedText(manifest.description, 'Task Pack description', 2_000);
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length < 1 || manifest.tasks.length > 64) {
    throw new TaskPackError('INVALID_TASK_PACK', 'Task Pack must declare 1 to 64 task modules');
  }

  const names = new Set();
  const modules = [];
  for (const [index, task] of manifest.tasks.entries()) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new TaskPackError('INVALID_TASK_PACK', `tasks[${index}] must be an object`);
    }
    exactKeys(task, new Set(['name', 'module']), `tasks[${index}]`);
    const taskName = boundedText(task.name, `tasks[${index}].name`, 80, { required: true });
    const moduleName = boundedText(task.module, `tasks[${index}].module`, 240, { required: true });
    if (!TASK_NAME.test(taskName) || names.has(taskName)) {
      throw new TaskPackError('INVALID_TASK_PACK', 'Task Pack task names must be unique lowercase identifiers');
    }
    if (
      path.isAbsolute(moduleName) || path.extname(moduleName).toLowerCase() !== '.mjs' ||
      moduleName.split(/[\\/]/u).includes('..')
    ) {
      throw new TaskPackError('INVALID_TASK_PACK', `Task module ${moduleName} must be a relative .mjs path`);
    }
    const requestedModule = path.resolve(root, moduleName);
    const moduleStats = await lstat(requestedModule).catch(() => null);
    if (!moduleStats?.isFile() || moduleStats.isSymbolicLink()) {
      throw new TaskPackError('INVALID_TASK_PACK', `Task module ${moduleName} must be a regular file`);
    }
    const modulePath = await realpath(requestedModule);
    if (!inside(root, modulePath)) {
      throw new TaskPackError('INVALID_TASK_PACK', `Task module ${moduleName} resolves outside the Pack`);
    }
    names.add(taskName);
    modules.push({ name: taskName, modulePath, module: moduleName.replaceAll('\\', '/') });
  }

  return {
    manifestPath: canonicalManifest,
    root,
    pack: {
      name,
      version,
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      tasks: modules.map(({ name: taskName, module }) => ({ name: taskName, module }))
    },
    modules: modules.map(({ name: taskName, modulePath }) => ({ name: taskName, modulePath }))
  };
}

export async function scaffoldTaskPack(directory, { name } = {}) {
  const packName = boundedText(name, 'Task Pack name', 80, { required: true });
  if (!PACK_NAME.test(packName)) {
    throw new TaskPackError('INVALID_TASK_PACK', 'Task Pack name must be a lowercase identifier');
  }
  const root = path.resolve(directory);
  await mkdir(path.join(root, 'tasks'), { recursive: true, mode: 0o700 });
  const taskName = `${packName}.example`;
  const manifest = {
    name: packName,
    version: '1.0.0',
    title: packName,
    description: 'Reusable Task Master task pack.',
    tasks: [{ name: taskName, module: 'tasks/example.mjs' }]
  };
  const moduleSource = [
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    '',
    'export const meta = Object.freeze({',
    `  name: ${JSON.stringify(taskName)},`,
    "  version: '1.0.0',",
    "  description: 'Read one page into a bounded JSON artifact.',",
    "  intents: ['read-page'],",
    "  tags: ['example'],",
    "  outputs: ['json'],",
    "  preferredBehavior: 'fast',",
    "  risk: 'read',",
    '  readOnly: true,',
    '  supportsResume: false,',
    '  inputSchema: {',
    "    type: 'object', additionalProperties: false, required: ['url'],",
    "    properties: { url: { type: 'string', minLength: 8, maxLength: 4096 } }",
    '  }',
    '});',
    '',
    'export async function run({ page, input, outputDir, action, progress, checkpoint }) {',
    '  const target = new URL(input.url);',
    "  if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('url must use HTTP(S)');",
    '  await mkdir(outputDir, { recursive: true });',
    "  await action.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });",
    "  await progress({ current: 1, total: 2, message: 'Page loaded' });",
    "  const data = await page.locator('body').evaluate((body) => ({",
    '    title: document.title.slice(0, 500), url: location.href,',
    "    text: (body.innerText || body.textContent || '').slice(0, 20_000)",
    '  }));',
    "  const file = 'result.json';",
    "  await writeFile(path.join(outputDir, file), `${JSON.stringify(data, null, 2)}\\n`, { mode: 0o600 });",
    "  await checkpoint({ stage: 'complete', artifact: file, url: data.url });",
    "  await progress({ current: 2, total: 2, message: 'Artifact persisted' });",
    '  return { summary: `Captured ${data.text.length} characters`, evidence: [',
    "    { kind: 'url', value: data.url }, { kind: 'artifact', file, agentVisible: true }",
    '  ] };',
    '}',
    ''
  ].join('\n');
  await writeFile(path.join(root, 'taskpack.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(root, 'tasks', 'example.mjs'), moduleSource, { flag: 'wx', mode: 0o600 });
  return readTaskPack(root);
}
