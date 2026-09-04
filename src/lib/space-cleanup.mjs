import { lstat, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_CLEANUP_PATH' });
}

function sameEntry(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory();
}

// The caller supplies an owned, narrow root, checks its managed parent (e.g.
// profiles/tasks) is not a link, and excludes concurrent writers. Parent paths
// above that boundary may use system aliases such as macOS /var -> /private/var.
// Rechecks avoid stale-path mistakes; this is not a sandbox against an attacker
// concurrently replacing filesystem entries (Node has no portable unlinkat API).
export async function cleanManagedPath({ root, relativePath, preview = true, linkOnly = false } = {}) {
  if (typeof root !== 'string' || root.includes('\0') || !path.isAbsolute(root)) {
    throw invalid('root must be an absolute owned directory');
  }
  root = path.resolve(root);
  if (root === path.parse(root).root) throw invalid('root must not be a filesystem root');
  if (typeof relativePath !== 'string' || !relativePath.trim()
    || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
    || relativePath.includes(':') || relativePath.includes('\0')) {
    throw invalid('relativePath must name a nested target');
  }
  const parts = relativePath.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..'
    || (process.platform === 'win32' && /[. ]$/.test(part)))) {
    throw invalid('relativePath cannot contain traversal or ambiguous segments');
  }
  if (typeof preview !== 'boolean' || typeof linkOnly !== 'boolean') {
    throw invalid('preview and linkOnly must be booleans');
  }
  if (linkOnly && (parts.length !== 1 || parts[0] !== 'node_modules')) {
    throw invalid('linkOnly is restricted to the task root node_modules link');
  }
  const result = { bytes: 0, files: 0, skipped: [], failed: [] };
  let rootEntry;
  try {
    rootEntry = await lstat(root);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw invalid('root must be a real directory');
    root = path.join(await realpath(path.dirname(root)), path.basename(root));
  } catch (error) {
    if (error.code === 'INVALID_CLEANUP_PATH') throw error;
    if (error.code !== 'ENOENT') result.failed.push({ path: parts.join('/'), reason: error.code || 'IO_ERROR' });
    return result;
  }
  const target = path.join(root, ...parts);
  const parents = new Map([[root, rootEntry]]);
  const display = (file) => path.relative(root, file).split(path.sep).join('/');
  const failure = (file, error) => result.failed.push({ path: display(file), reason: error?.code || 'IO_ERROR' });
  const skip = (file, reason) => result.skipped.push({ path: display(file), reason });

  async function stat(file) {
    try { return await lstat(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function checkedStat(file) {
    const chain = [];
    for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
      chain.push(parent);
      if (parent === root) break;
    }
    for (const parent of chain.reverse()) {
      const entry = await stat(parent);
      if (!entry) return null;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw invalid('Cleanup root and ancestors must be real directories');
      }
      if (parents.has(parent) && !sameEntry(parents.get(parent), entry)) {
        throw Object.assign(new Error('Directory changed during cleanup'), { code: 'PATH_CHANGED' });
      }
      parents.set(parent, entry);
    }
    return stat(file);
  }

  // Unsafe caller-selected roots/ancestors are invalid requests, not partial
  // cleanup. Permission or filesystem errors remain visible in the report.
  let initial;
  try { initial = await checkedStat(target); }
  catch (error) {
    if (error.code === 'INVALID_CLEANUP_PATH') throw error;
    failure(target, error);
    return result;
  }
  if (!initial) return result;
  if (linkOnly && !initial.isSymbolicLink()) throw invalid('node_modules must be a link for linkOnly cleanup');

  async function recheck(file, expected) {
    const actual = await checkedStat(file);
    if (!actual) return null;
    if (!sameEntry(actual, expected) || actual.isSymbolicLink() !== expected.isSymbolicLink()) {
      throw Object.assign(new Error('Entry changed during cleanup'), { code: 'PATH_CHANGED' });
    }
    return actual;
  }

  async function visit(file) {
    try {
      const entry = file === target ? await recheck(file, initial) : await checkedStat(file);
      if (!entry) return true;
      if (entry.isSymbolicLink()) {
        if (!linkOnly || file !== target) { skip(file, 'SYMLINK_OR_JUNCTION'); return false; }
        if (!preview) {
          if (!await recheck(file, entry)) return true;
          await unlink(file); // Remove the link itself, never its shared target.
        }
        result.files += 1;
        return true;
      }
      if (entry.isFile()) {
        const current = await recheck(file, entry);
        if (!current) return true;
        if (!preview) await unlink(file);
        result.files += 1;
        result.bytes += current.size;
        return true;
      }
      if (!entry.isDirectory()) { skip(file, 'UNSUPPORTED_FILE_TYPE'); return false; }
      if (!await recheck(file, entry)) return true;
      parents.set(file, entry);
      const children = await readdir(file);
      if (!await recheck(file, entry)) return true;
      let empty = true;
      for (const child of children) if (!await visit(path.join(file, child))) empty = false;
      if (empty && !preview && await recheck(file, entry)) await rmdir(file);
      return empty;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      failure(file, error);
      return false;
    }
  }
  await visit(target);
  return result;
}
