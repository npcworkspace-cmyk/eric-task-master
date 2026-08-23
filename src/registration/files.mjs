import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readOptionalFile(filePath) {
  let before;
  try {
    before = await lstat(filePath);
    if (before.isSymbolicLink()) {
      throw Object.assign(new Error(`Refusing to modify symbolic-link configuration: ${filePath}`), {
        code: 'CONFIG_SYMLINK_UNSUPPORTED'
      });
    }
    if (!before.isFile()) {
      throw Object.assign(new Error(`Host configuration is not a regular file: ${filePath}`), {
        code: 'INVALID_HOST_CONFIG_FILE'
      });
    }
    const bytes = await readFile(filePath);
    const after = await lstat(filePath);
    const beforeIdentity = fileIdentity(before);
    const afterIdentity = fileIdentity(after);
    if (!after.isFile() || beforeIdentity !== afterIdentity) {
      throw Object.assign(new Error(`Host configuration changed while it was being read: ${filePath}`), {
        code: 'CONFIG_CHANGED_DURING_READ'
      });
    }
    return {
      exists: true,
      bytes,
      text: bytes.toString('utf8'),
      hash: sha256(bytes),
      mode: after.mode & 0o777,
      identity: afterIdentity
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const bytes = Buffer.alloc(0);
    return { exists: false, bytes, text: '', hash: sha256(bytes), mode: 0o600, identity: null };
  }
}

function fileIdentity(metadata) {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs].join(':');
}

export function sameFileSnapshot(current, expected) {
  if (!expected || current.exists !== expected.exists || current.hash !== expected.hash) return false;
  return !expected.identity || current.identity === expected.identity;
}

export async function assertFileSnapshot(filePath, expected) {
  const current = await readOptionalFile(filePath);
  if (!sameFileSnapshot(current, expected)) {
    throw Object.assign(new Error(`Host configuration changed during the registration transaction: ${filePath}`), {
      code: 'CONFIG_CAS_MISMATCH',
      expected: { exists: expected?.exists, hash: expected?.hash },
      actual: { exists: current.exists, hash: current.hash }
    });
  }
  return current;
}

function casDirectoryPath(filePath) {
  return join(dirname(filePath), `.${basename(filePath)}.eric-task-master-cas`);
}

async function readCasOriginal(transactionDir) {
  const directory = await lstat(transactionDir).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!directory) return null;
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw Object.assign(new Error(`Reserved registration CAS path is not a directory: ${transactionDir}`), {
      code: 'INVALID_REGISTRATION_CAS_PATH'
    });
  }
  const originalPath = join(transactionDir, 'original');
  const original = await readOptionalFile(originalPath);
  return { originalPath, original };
}

async function cleanupCasDirectory(transactionDir) {
  await rm(transactionDir, { recursive: true, force: true });
}

async function publishNoReplace(sourcePath, destinationPath) {
  try {
    await link(sourcePath, destinationPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw Object.assign(new Error(`Host configuration changed during atomic publication: ${destinationPath}`), {
        code: 'CONFIG_CAS_MISMATCH'
      });
    }
    throw error;
  }
}

async function restoreDisplacedOriginal(filePath, transactionDir, originalPath) {
  try {
    await publishNoReplace(originalPath, filePath);
    await cleanupCasDirectory(transactionDir);
  } catch (error) {
    throw Object.assign(new Error(
      `A concurrent host edit was preserved at ${filePath}; the displaced bytes remain protected at ${originalPath}`
    ), {
      code: 'CONFIG_CAS_RECOVERY_REQUIRED',
      preservedPath: originalPath,
      cause: error
    });
  }
}

async function recoverCasDirectory(filePath, expected) {
  const transactionDir = casDirectoryPath(filePath);
  const pending = await readCasOriginal(transactionDir);
  if (!pending) return transactionDir;
  const current = await readOptionalFile(filePath);
  if (!pending.original.exists) {
    if (!current.exists || sameFileSnapshot(current, expected)) {
      await cleanupCasDirectory(transactionDir);
      return transactionDir;
    }
    throw Object.assign(new Error(`Incomplete registration CAS directory requires review: ${transactionDir}`), {
      code: 'CONFIG_CAS_RECOVERY_REQUIRED',
      preservedPath: transactionDir
    });
  }
  if (!current.exists) {
    await restoreDisplacedOriginal(filePath, transactionDir, pending.originalPath);
    return transactionDir;
  }
  if (sameFileSnapshot(current, expected)) {
    await cleanupCasDirectory(transactionDir);
    return transactionDir;
  }
  throw Object.assign(new Error(
    `Both the host configuration and an incomplete displaced copy exist; review ${transactionDir}`
  ), {
    code: 'CONFIG_CAS_RECOVERY_REQUIRED',
    preservedPath: transactionDir
  });
}

export async function atomicWrite(filePath, value, { mode = 0o600 } = {}) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await chmod(filePath, mode).catch((error) => {
      if (process.platform !== 'win32') throw error;
    });
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function atomicWriteCas(filePath, value, {
  mode = 0o600,
  expected,
  beforeCommit
} = {}) {
  if (!expected) throw new TypeError('atomicWriteCas requires an expected file snapshot');
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const transactionDir = await recoverCasDirectory(filePath, expected);
  const temporaryPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertFileSnapshot(filePath, expected);
    await beforeCommit?.();
    if (!expected.exists) {
      await publishNoReplace(temporaryPath, filePath);
    } else {
      await mkdir(transactionDir, { mode: 0o700 });
      const originalPath = join(transactionDir, 'original');
      try {
        await rename(filePath, originalPath);
      } catch (error) {
        await cleanupCasDirectory(transactionDir).catch(() => {});
        if (error?.code === 'ENOENT') {
          throw Object.assign(new Error(`Host configuration changed during atomic displacement: ${filePath}`), {
            code: 'CONFIG_CAS_MISMATCH'
          });
        }
        throw error;
      }
      const displaced = await readOptionalFile(originalPath);
      if (!sameFileSnapshot(displaced, expected)) {
        await restoreDisplacedOriginal(filePath, transactionDir, originalPath);
        throw Object.assign(new Error(`Host configuration changed before atomic displacement: ${filePath}`), {
          code: 'CONFIG_CAS_MISMATCH'
        });
      }
      try {
        await publishNoReplace(temporaryPath, filePath);
      } catch (error) {
        if (!(await pathExists(filePath))) {
          await restoreDisplacedOriginal(filePath, transactionDir, originalPath);
        }
        throw error;
      }
      await cleanupCasDirectory(transactionDir).catch(() => {});
    }
    // `publishNoReplace` uses a hard link so publication cannot overwrite a
    // concurrent host edit. Once the destination exists, remove the private
    // staging name; otherwise the host directory would retain a hidden second
    // link containing the complete configuration bytes.
    await rm(temporaryPath, { force: true });
    await chmod(filePath, mode).catch((error) => {
      if (process.platform !== 'win32') throw error;
    });
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function removeFile(filePath) {
  await rm(filePath, { force: true });
}

export async function removeFileCas(filePath, expected, { beforeCommit } = {}) {
  const transactionDir = await recoverCasDirectory(filePath, expected);
  await assertFileSnapshot(filePath, expected);
  await beforeCommit?.();
  if (!expected.exists) {
    await assertFileSnapshot(filePath, expected);
    return;
  }
  await mkdir(transactionDir, { mode: 0o700 });
  const originalPath = join(transactionDir, 'original');
  try {
    await rename(filePath, originalPath);
  } catch (error) {
    await cleanupCasDirectory(transactionDir).catch(() => {});
    if (error?.code === 'ENOENT') {
      throw Object.assign(new Error(`Host configuration changed during atomic removal: ${filePath}`), {
        code: 'CONFIG_CAS_MISMATCH'
      });
    }
    throw error;
  }
  const displaced = await readOptionalFile(originalPath);
  if (!sameFileSnapshot(displaced, expected)) {
    await restoreDisplacedOriginal(filePath, transactionDir, originalPath);
    throw Object.assign(new Error(`Host configuration changed before atomic removal: ${filePath}`), {
      code: 'CONFIG_CAS_MISMATCH'
    });
  }
  await cleanupCasDirectory(transactionDir);
}

export async function writeJsonAtomic(filePath, value) {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function readJsonOptional(filePath) {
  const file = await readOptionalFile(filePath);
  if (!file.exists) return null;
  try {
    return JSON.parse(file.text);
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON state file ${filePath}: ${error.message}`), {
      code: 'INVALID_REGISTRATION_STATE'
    });
  }
}
