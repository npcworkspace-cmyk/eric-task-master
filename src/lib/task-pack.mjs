import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateTaskModule } from './task-type-registry.mjs';
import { createTaskRecipeSource, TASK_RECIPES } from './task-recipes.mjs';

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

export async function preflightTaskPack(location) {
  const loaded = await readTaskPack(location);
  const results = await Promise.allSettled(loaded.modules.map((module) => validateTaskModule({
    name: module.name,
    modulePath: module.modulePath,
    allowedRoots: [loaded.root]
  })));
  const checks = results.map((result, index) => {
    const name = loaded.modules[index].name;
    if (result.status === 'fulfilled') {
      return { taskType: name, ok: true, metadata: result.value.taskType };
    }
    return {
      taskType: name,
      ok: false,
      code: typeof result.reason?.code === 'string' ? result.reason.code : 'TASK_MODULE_INVALID',
      message: typeof result.reason?.message === 'string' ? result.reason.message : 'Task module validation failed'
    };
  });
  const ok = checks.every((check) => check.ok);
  return {
    ok,
    taskPack: loaded.pack,
    checks,
    nextAction: ok
      ? 'Install this validated Pack, then run one bounded task with a disposable Profile and inspect its artifacts and completion evidence.'
      : 'Fix only the reported module contracts, run preflight again, and stop after two failed repair rounds instead of inventing another controller.'
  };
}

export async function scaffoldTaskPack(directory, { name, recipe = 'single-page' } = {}) {
  const packName = boundedText(name, 'Task Pack name', 80, { required: true });
  if (!PACK_NAME.test(packName)) {
    throw new TaskPackError('INVALID_TASK_PACK', 'Task Pack name must be a lowercase identifier');
  }
  if (!TASK_RECIPES.includes(recipe)) {
    throw new TaskPackError('INVALID_TASK_RECIPE', `Recipe must be one of: ${TASK_RECIPES.join(', ')}`);
  }
  const root = path.resolve(directory);
  await mkdir(path.join(root, 'tasks'), { recursive: true, mode: 0o700 });
  const taskName = `${packName}.${recipe}.v1`;
  const moduleName = `${recipe}-v1.mjs`;
  const manifest = {
    name: packName,
    version: '1.0.0',
    title: packName,
    description: 'Reusable Task Master task pack.',
    tasks: [{ name: taskName, module: `tasks/${moduleName}` }]
  };
  const moduleSource = createTaskRecipeSource(taskName, recipe);
  await writeFile(path.join(root, 'taskpack.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(root, 'tasks', moduleName), moduleSource, { flag: 'wx', mode: 0o600 });
  return readTaskPack(root);
}
