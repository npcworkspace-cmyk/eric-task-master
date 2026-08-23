import assert from 'node:assert/strict';
import { access, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createActionHelper } from '../src/lib/behavior.mjs';
import { createEffectJournal, inspectEffectJournal } from '../src/lib/effect-journal.mjs';
import { createOutputBudget } from '../src/lib/output-budget.mjs';
import { runTaskWorker } from '../src/runtime/task-worker.mjs';

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function fakeBrowser() {
  let closed = false;
  const page = {
    isClosed: () => closed,
    async goto() { return { status: () => 200 }; },
    async screenshot({ path: screenshotPath }) {
      await writeFile(screenshotPath, Buffer.from('diagnostic'));
    },
    locator() {
      return {
        async click() {}, async fill() {}, async hover() {}, async pressSequentially() {}
      };
    },
    mouse: { async wheel() {} }
  };
  const context = {
    pages: () => [page],
    async close() { closed = true; }
  };
  return { page, context, wasClosed: () => closed };
}

function workerConfig(root, modulePath, outputBudget) {
  return {
    taskId: `task_${path.basename(root)}`,
    modulePath,
    outputDir: path.join(root, 'output'),
    checkpointPath: path.join(root, 'checkpoint.json'),
    input: {},
    behavior: 'fast',
    profile: { userDataDir: path.join(root, 'profile') },
    heartbeatMs: 1_000,
    timeoutMs: 5_000,
    outputBudget
  };
}

test('output budget preserves user files and reserves bounded diagnostic capacity', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-output-budget-');
  const output = path.join(root, 'output');
  const screenshots = path.join(output, 'screenshots');
  await mkdir(screenshots, { recursive: true });
  await writeFile(path.join(output, 'business.bin'), Buffer.alloc(10));
  const budget = await createOutputBudget({
    root: output,
    limits: {
      maxBytes: 10,
      maxFiles: 1,
      maxEntries: 10,
      maxDepth: 8,
      diagnosticReserveBytes: 64,
      diagnosticReserveFiles: 1,
      checkIntervalMs: 10
    }
  });
  const diagnostic = path.join(screenshots, '1724457600000-failure.png');
  await budget.reserveDiagnostic(diagnostic);
  await assert.rejects(
    budget.reserveDiagnostic(path.join(screenshots, 'second.png')),
    { code: 'TASK_DIAGNOSTIC_BUDGET_EXCEEDED' }
  );
  await writeFile(diagnostic, Buffer.alloc(32));
  const snapshot = await budget.assertWithinBudget();
  assert.deepEqual(snapshot, {
    bytes: 10,
    files: 1,
    diagnosticBytes: 32,
    diagnosticFiles: 1,
    entries: 3
  });
  const resumedBudget = await createOutputBudget({
    root: output,
    limits: budget.limits
  });
  assert.equal((await resumedBudget.assertWithinBudget()).diagnosticBytes, 32);

  await writeFile(path.join(output, 'extra.bin'), Buffer.from('x'));
  await assert.rejects(budget.assertWithinBudget(), { code: 'TASK_OUTPUT_BUDGET_EXCEEDED' });
  assert.equal((await readFile(path.join(output, 'business.bin'))).length, 10);
  assert.equal((await readFile(diagnostic)).length, 32);
});

test('bounded scanner does not follow directory links and fails closed on entry floods', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-output-link-');
  const output = path.join(root, 'output');
  const outside = path.join(root, 'outside');
  await mkdir(output);
  await mkdir(outside);
  await writeFile(path.join(outside, 'large.bin'), Buffer.alloc(1024 * 1024));
  try {
    await symlink(outside, path.join(output, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const linkBudget = await createOutputBudget({
    root: output,
    limits: {
      maxBytes: 1_000,
      maxFiles: 2,
      maxEntries: 4,
      maxDepth: 8,
      diagnosticReserveBytes: 64,
      diagnosticReserveFiles: 1,
      checkIntervalMs: 10
    }
  });
  const snapshot = await linkBudget.assertWithinBudget();
  assert.equal(snapshot.files, 1);
  assert.ok(snapshot.bytes < 1_000);

  for (const name of ['a', 'b', 'c', 'd']) await mkdir(path.join(output, name));
  const bounded = await createOutputBudget({
    root: output,
    limits: {
      maxBytes: 10_000,
      maxFiles: 100,
      maxEntries: 3,
      maxDepth: 8,
      diagnosticReserveBytes: 64,
      diagnosticReserveFiles: 1,
      checkIntervalMs: 10
    }
  });
  await assert.rejects(bounded.assertWithinBudget(), { code: 'TASK_OUTPUT_SCAN_LIMIT_EXCEEDED' });
});

test('output accounting detects replacement of its root instead of following it', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-output-root-swap-');
  const output = path.join(root, 'output');
  const displaced = path.join(root, 'displaced-output');
  await mkdir(output);
  const budget = await createOutputBudget({ root: output });
  await rename(output, displaced);
  try {
    await symlink(displaced, output, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(budget.assertWithinBudget(), { code: 'TASK_OUTPUT_ROOT_CHANGED' });
});

test('effect journal records only safe operation metadata and exposes pending effects', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-effect-journal-');
  const filePath = path.join(root, 'internal', 'effects.jsonl');
  const marker = 'credential-marker-should-not-appear';
  const journal = await createEffectJournal({ filePath, now: () => '2026-08-24T00:00:00.000Z' });
  const pendingSequence = await journal.record({
    state: 'started',
    operation: `https://example.test/?token=${marker}`
  });
  const firstInspection = await inspectEffectJournal(filePath);
  assert.equal(pendingSequence, 1);
  assert.deepEqual(firstInspection.pending, [{
    sequence: 1,
    operation: 'custom',
    state: 'started',
    at: '2026-08-24T00:00:00.000Z'
  }]);
  await journal.close();

  const resumedJournal = await createEffectJournal({ filePath, now: () => '2026-08-24T00:00:01.000Z' });
  assert.deepEqual(resumedJournal.pending(), [{
    sequence: 1,
    operation: 'custom',
    state: 'started'
  }]);
  await assert.rejects(
    resumedJournal.record({ state: 'started', operation: 'click' }),
    { code: 'TASK_EFFECT_OUTCOME_UNKNOWN' }
  );
  await assert.rejects(
    resumedJournal.resolveUnknown(1, 'guessed'),
    { name: 'TypeError' }
  );
  await resumedJournal.resolveUnknown(1, 'observed_not_applied');
  const nextSequence = await resumedJournal.record({ state: 'started', operation: 'click' });
  await resumedJournal.record({ state: 'succeeded', operation: 'click', sequence: nextSequence });
  const serialized = await readFile(filePath, 'utf8');
  assert.equal(nextSequence, 2);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes('https://'), false);
  assert.deepEqual((await inspectEffectJournal(filePath)).pending, []);
  await resumedJournal.close();
});

test('worker blocks carried unknown effects until task logic verifies and resolves them', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-worker-carried-effect-');
  const modulePath = path.join(root, 'task.mjs');
  const journalPath = path.join(root, 'effect-journal.jsonl');
  const prior = await createEffectJournal({ filePath: journalPath });
  await prior.record({ state: 'started', operation: 'click' });
  await prior.close();

  await writeFile(modulePath, [
    'export async function run({ action }) {',
    "  await action.goto('https://example.test/');",
    "  return { summary: 'must not complete', evidence: [] };",
    '}',
    ''
  ].join('\n'));
  const blockedBrowser = fakeBrowser();
  const blocked = await runTaskWorker(workerConfig(root, modulePath), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => blockedBrowser.context } })
  });
  assert.equal(blocked.state, 'failed');
  assert.equal(blocked.error.code, 'TASK_EFFECT_OUTCOME_UNKNOWN');
  assert.equal(blockedBrowser.wasClosed(), true);
  assert.deepEqual((await inspectEffectJournal(journalPath)).pending.map((item) => item.sequence), [1]);

  const recoveryModulePath = path.join(root, 'recovery-task.mjs');
  await writeFile(recoveryModulePath, [
    'export async function run({ action, effects }) {',
    '  const [unknown] = effects.pending();',
    "  await effects.resolveUnknown(unknown.sequence, 'observed_not_applied');",
    "  await action.goto('https://example.test/');",
    "  return { summary: 'verified and completed', evidence: [] };",
    '}',
    ''
  ].join('\n'));
  const recoveredBrowser = fakeBrowser();
  const recovered = await runTaskWorker(workerConfig(root, recoveryModulePath), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => recoveredBrowser.context } })
  });
  assert.equal(recovered.state, 'completed');
  assert.equal(recoveredBrowser.wasClosed(), true);
  assert.deepEqual((await inspectEffectJournal(journalPath)).pending, []);
});

test('effect journal refuses linked files that could redirect internal records', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-effect-link-');
  const outside = path.join(root, 'outside.jsonl');
  const journalPath = path.join(root, 'internal', 'effects.jsonl');
  await mkdir(path.dirname(journalPath));
  await writeFile(outside, 'outside must stay unchanged\n');
  await link(outside, journalPath);
  await assert.rejects(createEffectJournal({ filePath: journalPath }), {
    code: 'TASK_EFFECT_JOURNAL_UNSAFE'
  });
  assert.equal(await readFile(outside, 'utf8'), 'outside must stay unchanged\n');
});

test('action facade never records selectors, values, URLs, or a false terminal state', async () => {
  const events = [];
  const marker = 'private-action-value';
  const page = {
    async goto() {},
    locator() {
      return { async click() {}, async fill() {}, async hover() {} };
    },
    mouse: { async wheel() {} }
  };
  const action = createActionHelper({
    page,
    onEffect: async (event) => {
      events.push(event);
      if (event.state === 'started') return 7;
      if (event.state === 'succeeded') throw Object.assign(new Error('journal unavailable'), {
        code: 'TASK_EFFECT_JOURNAL_FAILED'
      });
      return 7;
    }
  });
  await assert.rejects(
    action.run(`https://example.test/?token=${marker}`, async () => marker),
    { code: 'TASK_EFFECT_JOURNAL_FAILED' }
  );
  assert.deepEqual(events.map(({ state, operation, sequence }) => ({ state, operation, sequence })), [
    { state: 'started', operation: 'custom', sequence: undefined },
    { state: 'succeeded', operation: 'custom', sequence: 7 }
  ]);
  assert.equal(JSON.stringify(events).includes(marker), false);
});

test('worker aborts and closes its browser when progress detects output over budget', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-worker-budget-progress-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    "import { writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    'export async function run({ outputDir, progress }) {',
    "  await writeFile(path.join(outputDir, 'too-large.bin'), Buffer.alloc(64));",
    "  await progress({ current: 1, total: 1, message: 'written' });",
    "  return { summary: 'must not complete', evidence: [] };",
    '}',
    ''
  ].join('\n'));
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(workerConfig(root, modulePath, {
    maxBytes: 32,
    maxFiles: 10,
    maxEntries: 20,
    maxDepth: 8,
    diagnosticReserveBytes: 1_024,
    diagnosticReserveFiles: 2,
    checkIntervalMs: 10
  }), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_OUTPUT_BUDGET_EXCEEDED');
  assert.equal(browser.wasClosed(), true);
  assert.ok(outcome.error.screenshot);
  await access(outcome.error.screenshot);
  assert.equal((await readFile(path.join(root, 'output', 'too-large.bin'))).length, 64);
});

test('periodic output accounting stops a task that never reports progress', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-worker-budget-periodic-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    "import { writeFile } from 'node:fs/promises';",
    "import path from 'node:path';",
    'export async function run({ outputDir, signal }) {',
    "  await writeFile(path.join(outputDir, 'too-large.bin'), Buffer.alloc(64));",
    '  await new Promise((resolve) => {',
    '    const timer = setTimeout(resolve, 2_000);',
    "    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });",
    '  });',
    "  return { summary: 'must not complete', evidence: [] };",
    '}',
    ''
  ].join('\n'));
  const browser = fakeBrowser();
  const startedAt = Date.now();
  const outcome = await runTaskWorker(workerConfig(root, modulePath, {
    maxBytes: 32,
    maxFiles: 10,
    maxEntries: 20,
    maxDepth: 8,
    diagnosticReserveBytes: 1_024,
    diagnosticReserveFiles: 2,
    checkIntervalMs: 10
  }), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_OUTPUT_BUDGET_EXCEEDED');
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(browser.wasClosed(), true);
});

test('checkpoint and result boundaries cannot publish output beyond the budget', async (t) => {
  for (const boundary of ['checkpoint', 'result']) {
    await t.test(boundary, async (t) => {
      const root = await temporaryRoot(t, `taskmaster-worker-budget-${boundary}-`);
      const modulePath = path.join(root, 'task.mjs');
      await writeFile(modulePath, [
        "import { writeFile } from 'node:fs/promises';",
        "import path from 'node:path';",
        'export async function run({ outputDir, checkpoint }) {',
        "  await writeFile(path.join(outputDir, 'too-large.bin'), Buffer.alloc(64));",
        ...(boundary === 'checkpoint' ? ["  await checkpoint({ cursor: 'must-not-persist' });"] : []),
        "  return { summary: 'must not complete', evidence: [] };",
        '}',
        ''
      ].join('\n'));
      const browser = fakeBrowser();
      const outcome = await runTaskWorker(workerConfig(root, modulePath, {
        maxBytes: 32,
        maxFiles: 10,
        maxEntries: 20,
        maxDepth: 8,
        diagnosticReserveBytes: 1_024,
        diagnosticReserveFiles: 2,
        checkIntervalMs: 60_000
      }), {
        loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
      });
      assert.equal(outcome.state, 'failed');
      assert.equal(outcome.error.code, 'TASK_OUTPUT_BUDGET_EXCEEDED');
      assert.equal(browser.wasClosed(), true);
      if (boundary === 'checkpoint') {
        await assert.rejects(access(path.join(root, 'checkpoint.json')), { code: 'ENOENT' });
      }
    });
  }
});

test('worker persists a metadata-only effect journal outside user output', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-worker-effects-');
  const modulePath = path.join(root, 'task.mjs');
  const marker = 'worker-url-secret';
  await writeFile(modulePath, [
    'export async function run({ action }) {',
    `  await action.goto('https://example.test/?token=${marker}');`,
    "  await action.fill('#password', 'do-not-log-this');",
    "  return { summary: 'done', evidence: [] };",
    '}',
    ''
  ].join('\n'));
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(workerConfig(root, modulePath), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'completed');
  const journalPath = path.join(root, 'effect-journal.jsonl');
  const journal = await readFile(journalPath, 'utf8');
  assert.equal(journal.includes(marker), false);
  assert.equal(journal.includes('#password'), false);
  assert.equal(journal.includes('do-not-log-this'), false);
  assert.deepEqual(
    journal.trim().split(/\r?\n/u).map((line) => {
      const entry = JSON.parse(line);
      return [entry.sequence, entry.operation, entry.state];
    }),
    [
      [1, 'goto', 'started'],
      [1, 'goto', 'succeeded'],
      [2, 'fill', 'started'],
      [2, 'fill', 'succeeded']
    ]
  );
  assert.deepEqual((await inspectEffectJournal(journalPath)).pending, []);
});

test('checkpoint read returns the exact task data instead of its internal envelope', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-checkpoint-contract-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ checkpoint }) {',
    '  if (await checkpoint.read() !== null) throw new Error("unexpected existing checkpoint");',
    '  await checkpoint({ nextIndex: 2, stableKey: "unit-2" });',
    '  const restored = await checkpoint.read();',
    '  if (restored?.nextIndex !== 2 || restored?.stableKey !== "unit-2") {',
    '    throw new Error("checkpoint data shape drifted");',
    '  }',
    '  return { summary: "checkpoint contract passed", evidence: [] };',
    '}',
    ''
  ].join('\n'));
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(workerConfig(root, modulePath), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'completed');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'checkpoint.json'), 'utf8')).data, {
    nextIndex: 2,
    stableKey: 'unit-2'
  });
});

test('worker refuses completion while a current-attempt action outcome is pending', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-worker-pending-effect-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ action, signal }) {',
    "  void action.run('unawaited-action', () => new Promise((resolve) => {",
    "    signal.addEventListener('abort', resolve, { once: true });",
    '  })).catch(() => {});',
    "  await new Promise((resolve) => setTimeout(resolve, 20));",
    "  return { summary: 'must not complete', evidence: [] };",
    '}',
    ''
  ].join('\n'));
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(workerConfig(root, modulePath), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_EFFECT_OUTCOME_UNKNOWN');
  assert.equal(browser.wasClosed(), true);
  const inspected = await inspectEffectJournal(path.join(root, 'effect-journal.jsonl'));
  assert.deepEqual(inspected.pending.map((item) => item.operation), ['custom']);
});

test('task timeout aborts new actions before bounded screenshot diagnostics', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-timeout-abort-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    "import { writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    'export async function run({ action, signal, outputDir }) {',
    "  signal.addEventListener('abort', () => {",
    "    writeFileSync(path.join(outputDir, 'aborted.txt'), 'yes');",
    "    void action.run('late-action', async () => {",
    "      writeFileSync(path.join(outputDir, 'late-action.txt'), 'applied');",
    "    }).catch(() => writeFileSync(path.join(outputDir, 'blocked.txt'), 'yes'));",
    '  }, { once: true });',
    '  await new Promise(() => {});',
    '}',
    ''
  ].join('\n'));
  const browser = fakeBrowser();
  const outcome = await runTaskWorker({
    ...workerConfig(root, modulePath),
    timeoutMs: 50
  }, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_TIMEOUT');
  assert.equal(await readFile(path.join(root, 'output', 'aborted.txt'), 'utf8'), 'yes');
  assert.equal(await readFile(path.join(root, 'output', 'blocked.txt'), 'utf8'), 'yes');
  await assert.rejects(access(path.join(root, 'output', 'late-action.txt')), { code: 'ENOENT' });
  assert.equal(browser.wasClosed(), true);
});
