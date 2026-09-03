import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_OUTPUT_BUDGET = Object.freeze({
  maxBytes: 512 * 1024 * 1024,
  maxFiles: 10_000,
  maxEntries: 20_000,
  maxDepth: 128,
  diagnosticReserveBytes: 16 * 1024 * 1024,
  diagnosticReserveFiles: 8,
  checkIntervalMs: 5_000
});

export class OutputBudgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OutputBudgetError';
    this.code = code;
  }
}

function boundedInteger(value, fallback, { name, minimum, maximum }) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}

export function normalizeOutputBudgetLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('outputBudget must be an object');
  }
  const allowed = new Set(Object.keys(DEFAULT_OUTPUT_BUDGET));
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new TypeError(`Unsupported outputBudget fields: ${unknown.join(', ')}`);
  const maxFiles = boundedInteger(input.maxFiles, DEFAULT_OUTPUT_BUDGET.maxFiles, {
    name: 'outputBudget.maxFiles', minimum: 1, maximum: 1_000_000
  });
  const derivedMaxEntries = input.maxFiles === undefined
    ? DEFAULT_OUTPUT_BUDGET.maxEntries
    : Math.min(2_000_000, Math.max(DEFAULT_OUTPUT_BUDGET.maxEntries, maxFiles * 2));
  const maxEntries = boundedInteger(input.maxEntries, derivedMaxEntries, {
    name: 'outputBudget.maxEntries', minimum: 1, maximum: 2_000_000
  });
  if (maxEntries < maxFiles) {
    throw new TypeError('outputBudget.maxEntries must be greater than or equal to outputBudget.maxFiles');
  }
  return Object.freeze({
    maxBytes: boundedInteger(input.maxBytes, DEFAULT_OUTPUT_BUDGET.maxBytes, {
      name: 'outputBudget.maxBytes', minimum: 1, maximum: 64 * 1024 * 1024 * 1024
    }),
    maxFiles,
    maxEntries,
    maxDepth: boundedInteger(input.maxDepth, DEFAULT_OUTPUT_BUDGET.maxDepth, {
      name: 'outputBudget.maxDepth', minimum: 1, maximum: 1_024
    }),
    diagnosticReserveBytes: boundedInteger(
      input.diagnosticReserveBytes,
      DEFAULT_OUTPUT_BUDGET.diagnosticReserveBytes,
      { name: 'outputBudget.diagnosticReserveBytes', minimum: 1, maximum: 256 * 1024 * 1024 }
    ),
    diagnosticReserveFiles: boundedInteger(
      input.diagnosticReserveFiles,
      DEFAULT_OUTPUT_BUDGET.diagnosticReserveFiles,
      { name: 'outputBudget.diagnosticReserveFiles', minimum: 1, maximum: 64 }
    ),
    checkIntervalMs: boundedInteger(input.checkIntervalMs, DEFAULT_OUTPUT_BUDGET.checkIntervalMs, {
      name: 'outputBudget.checkIntervalMs', minimum: 10, maximum: 60_000
    })
  });
}

function outsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function sameFile(left, right) {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino);
}

function isDiagnosticFile(root, candidate) {
  const parts = path.relative(root, candidate).split(path.sep);
  return parts.length === 2 && parts[0] === 'screenshots' &&
    /^\d{13,16}-[a-z0-9_-]{1,48}\.(?:png|jpe?g)$/iu.test(parts[1]);
}

function budgetExceeded(snapshot, limits) {
  if (snapshot.bytes > limits.maxBytes) {
    return new OutputBudgetError(
      'TASK_OUTPUT_BUDGET_EXCEEDED',
      `Task output exceeded the ${limits.maxBytes}-byte resource budget; existing output was preserved`
    );
  }
  if (snapshot.files > limits.maxFiles) {
    return new OutputBudgetError(
      'TASK_OUTPUT_BUDGET_EXCEEDED',
      `Task output exceeded the ${limits.maxFiles}-file resource budget; existing output was preserved`
    );
  }
  if (snapshot.diagnosticBytes > limits.diagnosticReserveBytes ||
      snapshot.diagnosticFiles > limits.diagnosticReserveFiles) {
    return new OutputBudgetError(
      'TASK_DIAGNOSTIC_BUDGET_EXCEEDED',
      'Task diagnostic output exceeded its reserved resource budget; existing output was preserved'
    );
  }
  return null;
}

export async function createOutputBudget({ root, limits: suppliedLimits } = {}) {
  if (typeof root !== 'string' || !root) throw new TypeError('output budget root is required');
  const limits = normalizeOutputBudgetLimits(suppliedLimits);
  const resolvedRoot = path.resolve(root);
  const rootStats = await lstat(resolvedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new OutputBudgetError('TASK_OUTPUT_ROOT_UNSAFE', 'Task output root must be a real directory');
  }
  const canonicalRoot = await realpath(resolvedRoot);
  const diagnosticPaths = new Set();
  let scanTail = Promise.resolve();
  let terminalError = null;

  async function verifyRoot() {
    const currentStats = await lstat(resolvedRoot);
    const currentCanonical = await realpath(resolvedRoot);
    if (!currentStats.isDirectory() || currentStats.isSymbolicLink() ||
        currentCanonical !== canonicalRoot || !sameFile(rootStats, currentStats)) {
      throw new OutputBudgetError('TASK_OUTPUT_ROOT_CHANGED', 'Task output root changed during execution');
    }
  }

  async function scan() {
    await verifyRoot();
    const snapshot = {
      bytes: 0,
      files: 0,
      diagnosticBytes: 0,
      diagnosticFiles: 0,
      entries: 0
    };
    const pending = [{ directory: resolvedRoot, depth: 0 }];

    while (pending.length) {
      const { directory, depth } = pending.pop();
      if (depth > limits.maxDepth) {
        throw new OutputBudgetError(
          'TASK_OUTPUT_SCAN_LIMIT_EXCEEDED',
          'Task output directory depth exceeded the bounded scanner limit'
        );
      }
      let directoryStats;
      try {
        directoryStats = await lstat(directory);
      } catch (error) {
        if (directory !== resolvedRoot && ['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
        throw error;
      }
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) continue;
      let canonicalDirectory;
      try {
        canonicalDirectory = await realpath(directory);
      } catch (error) {
        if (directory !== resolvedRoot && ['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
        throw error;
      }
      if (outsideRoot(canonicalRoot, canonicalDirectory)) {
        throw new OutputBudgetError('TASK_OUTPUT_PATH_ESCAPE', 'Task output attempted to escape its output root');
      }

      let handle;
      try {
        const current = await lstat(directory);
        if (!current.isDirectory() || current.isSymbolicLink() ||
            String(current.dev) !== String(directoryStats.dev) || String(current.ino) !== String(directoryStats.ino)) {
          if (directory === resolvedRoot) {
            throw new OutputBudgetError('TASK_OUTPUT_ROOT_CHANGED', 'Task output root changed during execution');
          }
          continue;
        }
        handle = await opendir(directory);
      } catch (error) {
        if (directory !== resolvedRoot && ['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
        throw error;
      }
      try {
        for await (const entry of handle) {
          snapshot.entries += 1;
          if (snapshot.entries > limits.maxEntries) {
            throw new OutputBudgetError(
              'TASK_OUTPUT_SCAN_LIMIT_EXCEEDED',
              'Task output contained too many entries for bounded resource accounting'
            );
          }
          const candidate = path.resolve(directory, entry.name);
          if (outsideRoot(resolvedRoot, candidate)) {
            throw new OutputBudgetError('TASK_OUTPUT_PATH_ESCAPE', 'Task output attempted to escape its output root');
          }
          let stats;
          try {
            stats = await lstat(candidate);
          } catch (error) {
            if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
            throw error;
          }
          if (stats.isDirectory() && !stats.isSymbolicLink()) {
            pending.push({ directory: candidate, depth: depth + 1 });
            continue;
          }

          // The bounded filename convention lets a later resume recognize
          // screenshots from a prior attempt. Even if trusted task code adopts
          // the convention, the exemption remains capped by the small reserve.
          const isDiagnostic = stats.isFile() && stats.nlink === 1 &&
            (diagnosticPaths.has(candidate) || isDiagnosticFile(resolvedRoot, candidate));
          if (isDiagnostic) {
            snapshot.diagnosticFiles += 1;
            snapshot.diagnosticBytes += stats.size;
          } else {
            snapshot.files += 1;
            snapshot.bytes += stats.size;
          }
          const exceeded = budgetExceeded(snapshot, limits);
          if (exceeded) throw exceeded;
        }
      } finally {
        await handle.close().catch(() => {});
      }
    }
    await verifyRoot();
    return Object.freeze(snapshot);
  }

  async function assertWithinBudget() {
    if (terminalError) throw terminalError;
    const operation = scanTail.then(scan, scan);
    scanTail = operation.catch(() => {});
    try {
      return await operation;
    } catch (error) {
      terminalError = error instanceof OutputBudgetError
        ? error
        : new OutputBudgetError('TASK_OUTPUT_SCAN_FAILED', 'Task output resource accounting failed safely');
      throw terminalError;
    }
  }

  async function reserveDiagnostic(filePath) {
    const candidate = path.resolve(filePath);
    if (outsideRoot(resolvedRoot, candidate) || candidate === resolvedRoot) {
      throw new OutputBudgetError('TASK_OUTPUT_PATH_ESCAPE', 'Diagnostic output must stay inside the task output root');
    }
    await verifyRoot();
    const parent = path.dirname(candidate);
    const parentStats = await lstat(parent);
    const canonicalParent = await realpath(parent);
    if (!parentStats.isDirectory() || parentStats.isSymbolicLink() || outsideRoot(canonicalRoot, canonicalParent)) {
      throw new OutputBudgetError('TASK_OUTPUT_PATH_ESCAPE', 'Diagnostic output must stay inside the task output root');
    }
    if (!diagnosticPaths.has(candidate) && diagnosticPaths.size >= limits.diagnosticReserveFiles) {
      throw new OutputBudgetError(
        'TASK_DIAGNOSTIC_BUDGET_EXCEEDED',
        'Task diagnostic output exhausted its reserved file capacity; existing output was preserved'
      );
    }
    diagnosticPaths.add(candidate);
    return () => diagnosticPaths.delete(candidate);
  }

  function startPeriodic(onExceeded) {
    if (typeof onExceeded !== 'function') throw new TypeError('onExceeded callback is required');
    let stopped = false;
    let reporting = false;
    const timer = setInterval(() => {
      if (stopped || reporting) return;
      reporting = true;
      void assertWithinBudget().catch((error) => {
        if (!stopped) {
          try {
            onExceeded(error);
          } catch {
            // Accounting remains failed even if a consumer cannot report it.
          }
        }
      }).finally(() => {
        reporting = false;
      });
    }, limits.checkIntervalMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return Object.freeze({
    limits,
    assertSafeRoot: verifyRoot,
    assertWithinBudget,
    reserveDiagnostic,
    startPeriodic
  });
}
