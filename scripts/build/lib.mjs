import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) throw new Error(`Unexpected argument: ${entry}`);
    const key = entry.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

export async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureEmpty(path) {
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

export async function run(command, args, options = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.stdio || 'inherit',
      windowsHide: true,
      shell: options.shell === true
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveRun();
      rejectRun(new Error(`${command} exited with ${signal || code}`));
    });
  });
}

export async function download(url, output) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  await mkdir(dirname(output), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(output, { flags: 'wx' }));
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const file = await import('node:fs').then(({ createReadStream }) => createReadStream(path));
  for await (const chunk of file) hash.update(chunk);
  return hash.digest('hex');
}

export async function copyApplication(sourceRoot, destination) {
  const directories = ['src', 'dashboard'];
  const files = ['package.json', 'package-lock.json', 'LICENSE'];
  await mkdir(destination, { recursive: true });
  for (const entry of directories) {
    const source = join(sourceRoot, entry);
    if (await exists(source)) await cp(source, join(destination, entry), { recursive: true });
  }
  for (const entry of files) {
    const source = join(sourceRoot, entry);
    if (!(await exists(source))) throw new Error(`Runtime source is missing ${entry}`);
    await copyFile(source, join(destination, entry));
  }
}

export async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
  }
  return files;
}

export async function hashTree(root, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const files = (await listFiles(root)).filter((entry) => !excluded.has(entry));
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(root, ...file.split('/'))));
    hash.update('\0');
  }
  return { files: files.length, sha256: hash.digest('hex') };
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function directorySize(root) {
  let total = 0;
  for (const file of await listFiles(root)) total += (await stat(join(root, ...file.split('/')))).size;
  return total;
}
