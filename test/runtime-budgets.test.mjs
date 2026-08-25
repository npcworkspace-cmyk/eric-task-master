import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
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
    async screenshot() { return Buffer.from([0xff, 0xd8, 0xff, 0xd9]); },
    async evaluate() { throw new Error('unexpected resize'); },
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
    attempt: 1,
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

test('output accounting binds the original directory identity at a stable path', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-output-root-identity-');
  const output = path.join(root, 'output');
  const displaced = path.join(root, 'displaced-output');
  await mkdir(output);
  const budget = await createOutputBudget({ root: output });
  await rename(output, displaced);
  await mkdir(output);
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

test('effect journal fails closed on malformed records and illegal state transitions', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-effect-invalid-');
  const cases = [
    '{"sequence":1,"operation":"click","state":"started"',
    '{"sequence":1,"operation":"click","state":"unknown","at":"2026-08-24T00:00:00.000Z"}\n',
    '{"sequence":1,"operation":"click","state":"succeeded","at":"2026-08-24T00:00:00.000Z"}\n',
    [
      '{"sequence":1,"operation":"click","state":"started","at":"2026-08-24T00:00:00.000Z"}',
      '{"sequence":2,"operation":"click","state":"started","at":"2026-08-24T00:00:01.000Z"}',
      ''
    ].join('\n')
  ];

  for (const [index, source] of cases.entries()) {
    const filePath = path.join(root, `invalid-${index}.jsonl`);
    await writeFile(filePath, source);
    await assert.rejects(createEffectJournal({ filePath }), {
      code: 'TASK_EFFECT_JOURNAL_INVALID'
    });
    await assert.rejects(inspectEffectJournal(filePath), {
      code: 'TASK_EFFECT_JOURNAL_INVALID'
    });
  }
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

test('an oversized checkpoint fails before replacing the last valid checkpoint', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-checkpoint-size-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ checkpoint }) {',
    "  await checkpoint({ cursor: 'last-valid' });",
    "  await checkpoint({ bulk: 'x'.repeat(8 * 1024 * 1024) });",
    "  return { summary: 'must not complete', evidence: [] };",
    '}',
    ''
  ].join('\n'));
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(workerConfig(root, modulePath), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });

  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_CHECKPOINT_TOO_LARGE');
  assert.equal(browser.wasClosed(), true);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'checkpoint.json'), 'utf8')).data, {
    cursor: 'last-valid'
  });
});

test('task modules cannot fall through or omit the explicit completion contract', async (t) => {
  const invalidReturns = [
    ['undefined', ''],
    ['empty-object', '  return {};'],
    ['blank-summary', "  return { summary: '   ', evidence: [] };"],
    ['missing-evidence', "  return { summary: 'looks complete' };"],
    ['non-array-evidence', "  return { summary: 'looks complete', evidence: {} };"]
  ];
  for (const [label, returnLine] of invalidReturns) {
    await t.test(label, async (t) => {
      const root = await temporaryRoot(t, `taskmaster-result-contract-${label}-`);
      const modulePath = path.join(root, 'task.mjs');
      await writeFile(modulePath, [
        'export async function run() {',
        '  await Promise.resolve();',
        returnLine,
        '}',
        ''
      ].join('\n'));
      const browser = fakeBrowser();
      const outcome = await runTaskWorker(workerConfig(root, modulePath), {
        loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
      });
      assert.equal(outcome.state, 'failed');
      assert.equal(outcome.error.code, 'TASK_RESULT_INVALID');
      assert.equal(browser.wasClosed(), true);
    });
  }
});

test('semantic diagnostic failure leaves an explicit safe fallback beside the screenshot', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-semantic-diagnostic-fallback-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  const browser = fakeBrowser();
  const config = workerConfig(root, modulePath);
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });

  assert.equal(outcome.state, 'failed');
  const manifest = JSON.parse(await readFile(path.join(root, 'diagnostics.json'), 'utf8'));
  assert.equal(typeof manifest.screenshot?.relativePath, 'string');
  assert.equal(typeof manifest.observation?.relativePath, 'string');
  const observation = JSON.parse(await readFile(
    path.join(config.outputDir, manifest.observation.relativePath),
    'utf8'
  ));
  assert.equal(observation.unavailable, true);
  assert.deepEqual(observation.error, { code: 'SEMANTIC_DIAGNOSTIC_UNAVAILABLE' });
  assert.deepEqual(observation.snapshot.refs, []);
  assert.equal(JSON.stringify(observation).includes('page.frames'), false);
  assert.equal(browser.wasClosed(), true);
});

test('a locked recovery manifest cannot suppress valid screenshot and observation files', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-diagnostic-manifest-locked-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() {}\n');
  await mkdir(path.join(root, 'diagnostics.json'));
  const browser = fakeBrowser();
  const config = workerConfig(root, modulePath);
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });

  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_RESULT_INVALID');
  await access(outcome.error.screenshot);
  assert.equal((await readdir(path.join(config.outputDir, 'observations'))).length, 1);
  assert.equal(browser.wasClosed(), true);
});

test('task progress cannot move backwards within one attempt', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-progress-backwards-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ progress }) {',
    "  await progress({ current: 2, total: 3, message: 'Advanced' });",
    "  await progress({ current: 1, total: 3, message: 'Moved backwards' });",
    "  return { summary: 'must not complete', evidence: [] };",
    '}',
    ''
  ].join('\n'));
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(workerConfig(root, modulePath), {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_PROGRESS_INVALID');
  assert.equal(browser.wasClosed(), true);
});

test('task progress cannot shrink or remove a declared total within one attempt', async (t) => {
  for (const [label, secondTotal] of [['shrink', '5'], ['remove', 'null']]) {
    await t.test(label, async (t) => {
      const root = await temporaryRoot(t, `taskmaster-progress-total-${label}-`);
      const modulePath = path.join(root, 'task.mjs');
      await writeFile(modulePath, [
        'export async function run({ progress }) {',
        "  await progress({ current: 5, total: 100, message: 'Started bounded work' });",
        `  await progress({ current: 5, total: ${secondTotal}, message: 'Invalid total rebase' });`,
        "  return { summary: 'must not complete', evidence: [{ kind: 'message', value: 'invalid' }] };",
        '}',
        ''
      ].join('\n'));
      const browser = fakeBrowser();
      const outcome = await runTaskWorker(workerConfig(root, modulePath), {
        loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
      });
      assert.equal(outcome.state, 'failed');
      assert.equal(outcome.error.code, 'TASK_PROGRESS_INVALID');
      assert.equal(browser.wasClosed(), true);
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
  assert.equal(outcome.state, 'completed', JSON.stringify(outcome));
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
  assert.equal(outcome.state, 'completed', JSON.stringify(outcome));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'checkpoint.json'), 'utf8')).data, {
    nextIndex: 2,
    stableKey: 'unit-2'
  });
});

test('a resumed worker reads only its frozen checkpoint even if the live checkpoint path changes', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-frozen-resume-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ checkpoint }) {',
    '  const restored = await checkpoint.read();',
    '  if (restored?.cursor !== "approved") throw new Error("unapproved resume data");',
    '  return { summary: "frozen resume passed", evidence: [] };',
    '}',
    ''
  ].join('\n'));
  const config = { ...workerConfig(root, modulePath), attempt: 2 };
  const savedAt = new Date().toISOString();
  const approved = Buffer.from(`${JSON.stringify({
    taskId: config.taskId,
    attempt: 1,
    savedAt,
    data: { cursor: 'approved' }
  })}\n`);
  const frozenPath = path.join(root, 'resume-input.json');
  await writeFile(frozenPath, approved);
  config.resumeCheckpoint = {
    path: frozenPath,
    sourceAttempt: 1,
    targetAttempt: 2,
    savedAt,
    sha256: createHash('sha256').update(approved).digest('hex'),
    sizeBytes: approved.byteLength
  };
  await writeFile(config.checkpointPath, `${JSON.stringify({
    taskId: config.taskId,
    attempt: 1,
    savedAt,
    data: { cursor: 'substituted' }
  })}\n`);
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'completed', JSON.stringify(outcome));
});

test('a resumed worker fails closed when its frozen checkpoint is replaced', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-frozen-resume-tamper-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ checkpoint }) {',
    '  await checkpoint.read();',
    '  return { summary: "must not complete", evidence: [] };',
    '}',
    ''
  ].join('\n'));
  const config = { ...workerConfig(root, modulePath), attempt: 2 };
  const savedAt = new Date().toISOString();
  const approved = Buffer.from(`${JSON.stringify({
    taskId: config.taskId,
    attempt: 1,
    savedAt,
    data: { cursor: 'approved' }
  })}\n`);
  const frozenPath = path.join(root, 'resume-input.json');
  await writeFile(frozenPath, approved);
  config.resumeCheckpoint = {
    path: frozenPath,
    sourceAttempt: 1,
    targetAttempt: 2,
    savedAt,
    sha256: createHash('sha256').update(approved).digest('hex'),
    sizeBytes: approved.byteLength
  };
  const replacement = Buffer.from(approved.toString('utf8').replace('approved', 'tampered'));
  assert.equal(replacement.byteLength, approved.byteLength);
  await writeFile(frozenPath, replacement);
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_CHECKPOINT_INVALID');
});

test('a resumed worker cannot complete without consuming its frozen checkpoint', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-frozen-resume-unread-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() { return { summary: "must not complete", evidence: [] }; }\n');
  const config = { ...workerConfig(root, modulePath), attempt: 2 };
  const savedAt = new Date().toISOString();
  const approved = Buffer.from(`${JSON.stringify({
    taskId: config.taskId,
    attempt: 1,
    savedAt,
    data: { cursor: 'approved' }
  })}\n`);
  const frozenPath = path.join(root, 'resume-input.json');
  await writeFile(frozenPath, approved);
  config.resumeCheckpoint = {
    path: frozenPath,
    sourceAttempt: 1,
    targetAttempt: 2,
    savedAt,
    sha256: createHash('sha256').update(approved).digest('hex'),
    sizeBytes: approved.byteLength
  };
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED');
});

test('a resumed worker cannot issue a browser action before reading its checkpoint', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-frozen-resume-action-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ action }) {',
    '  await action.goto("https://example.test/replayed");',
    '  return { summary: "must not complete", evidence: [] };',
    '}',
    ''
  ].join('\n'));
  const config = { ...workerConfig(root, modulePath), attempt: 2 };
  const savedAt = new Date().toISOString();
  const source = Buffer.from(`${JSON.stringify({
    taskId: config.taskId, attempt: 1, savedAt, data: { cursor: 1 }
  })}\n`);
  const frozenPath = path.join(root, 'resume-input.json');
  await writeFile(frozenPath, source);
  config.resumeCheckpoint = {
    path: frozenPath, sourceAttempt: 1, targetAttempt: 2, savedAt,
    sha256: createHash('sha256').update(source).digest('hex'), sizeBytes: source.byteLength
  };
  const browser = fakeBrowser();
  let browserActions = 0;
  browser.page.goto = async () => { browserActions += 1; return { status: () => 200 }; };
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED');
  assert.equal(browserActions, 0);
});

test('a resumed worker cannot overwrite its live checkpoint before reading the frozen input', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-frozen-resume-write-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ checkpoint }) {',
    '  await checkpoint({ cursor: 999 });',
    '  return { summary: "must not complete", evidence: [] };',
    '}',
    ''
  ].join('\n'));
  const config = { ...workerConfig(root, modulePath), attempt: 2 };
  const savedAt = new Date().toISOString();
  const source = Buffer.from(`${JSON.stringify({
    taskId: config.taskId, attempt: 1, savedAt, data: { cursor: 1 }
  })}\n`);
  const frozenPath = path.join(root, 'resume-input.json');
  await writeFile(frozenPath, source);
  await writeFile(config.checkpointPath, source);
  config.resumeCheckpoint = {
    path: frozenPath, sourceAttempt: 1, targetAttempt: 2, savedAt,
    sha256: createHash('sha256').update(source).digest('hex'), sizeBytes: source.byteLength
  };
  const browser = fakeBrowser();
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED');
  assert.deepEqual(await readFile(config.checkpointPath), source);
});

test('a resumed worker cannot resolve an unknown effect before reading its frozen checkpoint', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-frozen-resume-effect-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, [
    'export async function run({ effects }) {',
    '  const [pending] = effects.pending();',
    "  await effects.resolveUnknown(pending.sequence, 'observed_not_applied');",
    '  return { summary: "must not complete", evidence: [{ kind: "message", value: "unsafe" }] };',
    '}',
    ''
  ].join('\n'));
  const config = { ...workerConfig(root, modulePath), attempt: 2 };
  const savedAt = new Date().toISOString();
  const source = Buffer.from(`${JSON.stringify({
    taskId: config.taskId, attempt: 1, savedAt, data: { cursor: 1 }
  })}\n`);
  const frozenPath = path.join(root, 'resume-input.json');
  await writeFile(frozenPath, source);
  config.resumeCheckpoint = {
    path: frozenPath, sourceAttempt: 1, targetAttempt: 2, savedAt,
    sha256: createHash('sha256').update(source).digest('hex'), sizeBytes: source.byteLength
  };
  const journalPath = path.join(path.dirname(config.checkpointPath), 'effect-journal.jsonl');
  const journal = await createEffectJournal({ filePath: journalPath });
  await journal.record({ state: 'started', operation: 'click' });
  await journal.close();

  const browser = fakeBrowser();
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({ chromium: { launchPersistentContext: async () => browser.context } })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_RESUME_CHECKPOINT_NOT_CONSUMED');
  assert.deepEqual((await inspectEffectJournal(journalPath)).pending.map((item) => item.sequence), [1]);
});

test('task timeout covers a browser launch that never resolves', async (t) => {
  const root = await temporaryRoot(t, 'taskmaster-launch-timeout-');
  const modulePath = path.join(root, 'task.mjs');
  await writeFile(modulePath, 'export async function run() { return { summary: "unused", evidence: [] }; }\n');
  const config = { ...workerConfig(root, modulePath), timeoutMs: 50 };
  const startedAt = Date.now();
  const outcome = await runTaskWorker(config, {
    loadPlaywright: async () => ({
      chromium: { launchPersistentContext: async () => new Promise(() => {}) }
    })
  });
  assert.equal(outcome.state, 'failed');
  assert.equal(outcome.error.code, 'TASK_TIMEOUT');
  assert.equal(Date.now() - startedAt < 500, true);
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
