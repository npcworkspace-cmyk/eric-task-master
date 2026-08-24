import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'full-playwright-acceptance',
  version: '1.0.0',
  description: 'Built-in deterministic browser action acceptance task.',
  intents: ['accept-browser'],
  tags: ['acceptance', 'builtin'],
  outputs: ['json', 'png', 'download'],
  preferredBehavior: 'fast',
  risk: 'mixed',
  supportsResume: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url', 'uploadPath'],
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 4096 },
      uploadPath: { type: 'string', minLength: 1, maxLength: 4096 },
      expectedSession: { type: 'boolean' },
      expectCleanStart: { type: 'boolean' }
    }
  }
});

export async function run({ page, context, input, outputDir, action, progress, checkpoint }) {
  if (!input?.url || !input?.uploadPath) {
    throw new TypeError('acceptance task requires input.url and input.uploadPath');
  }
  await mkdir(outputDir, { recursive: true });
  const evidence = [];

  await action.goto(input.url, { waitUntil: 'domcontentloaded' });
  evidence.push({ kind: 'navigation', ok: page.url().startsWith(new URL(input.url).origin) });
  if (input.expectCleanStart) {
    const initialCookies = await context.cookies(input.url);
    const initialStorage = await page.evaluate(() => localStorage.getItem('taskmaster_fixture'));
    evidence.push({
      kind: 'ephemeral-clean-start',
      ok: !initialCookies.some((cookie) => cookie.name === 'taskmaster_fixture') && initialStorage === null
    });
  }
  if (input.expectedSession) {
    const importedCookies = await context.cookies(input.url);
    const importedStorage = await page.evaluate(() => localStorage.getItem('taskmaster_imported'));
    evidence.push({
      kind: 'session-import-cookie',
      ok: importedCookies.some((cookie) => cookie.name === 'taskmaster_imported' && cookie.value === 'accepted')
    });
    evidence.push({ kind: 'session-import-storage', ok: importedStorage === 'accepted' });
  }
  await progress({ current: 1, total: 9, message: 'Fixture loaded' });

  await action.fill('#name', 'Eric Task Master');
  evidence.push({ kind: 'input', ok: await page.locator('#name').inputValue() === 'Eric Task Master' });
  await progress({ current: 2, total: 9, message: 'Text input verified' });

  await action.hover('#submit');
  await action.scroll({ deltaY: 120, steps: 4 });
  const readingDelay = await action.read({ words: 20 });
  const behaviorTrace = await page.evaluate(() => window.__taskmasterTrace);
  const humanBehavior = action.effectiveMode === 'human';
  evidence.push({
    kind: 'behavior',
    ok: humanBehavior
      ? behaviorTrace.pointerMoves >= 4 && behaviorTrace.inputEvents >= 16 &&
        behaviorTrace.wheelEvents >= 2 && readingDelay > 0 && readingDelay <= 8_000
      : readingDelay === 0,
    mode: action.mode,
    effectiveMode: action.effectiveMode,
    pointerMoves: behaviorTrace.pointerMoves,
    inputEvents: behaviorTrace.inputEvents,
    wheelEvents: behaviorTrace.wheelEvents,
    readingDelay
  });

  await action.click('#agree');
  evidence.push({ kind: 'checkbox', ok: await page.locator('#agree').isChecked() });
  await action.run('select', () => page.locator('#choice').selectOption('beta'));
  evidence.push({ kind: 'select', ok: await page.locator('#choice').inputValue() === 'beta' });
  await progress({ current: 3, total: 9, message: 'Click and selection verified' });

  await action.run('upload', () => page.locator('#upload').setInputFiles(input.uploadPath));
  evidence.push({ kind: 'upload', ok: await page.locator('#upload').evaluate((node) => node.files?.length === 1) });
  await progress({ current: 4, total: 9, message: 'Upload verified' });

  await action.click('#submit');
  const resultText = await page.locator('#result').innerText();
  evidence.push({ kind: 'submit', ok: resultText.includes('Eric Task Master|true|beta|') });
  await progress({ current: 5, total: 9, message: 'Submit result verified' });

  const cookies = await context.cookies(input.url);
  evidence.push({ kind: 'cookie', ok: cookies.some((cookie) => cookie.name === 'taskmaster_fixture') });
  const stored = await page.evaluate(() => localStorage.getItem('taskmaster_fixture'));
  evidence.push({ kind: 'localStorage', ok: stored === 'accepted' });
  await progress({ current: 6, total: 9, message: 'Browser storage verified' });

  const downloadPromise = page.waitForEvent('download');
  await action.click('#download');
  const download = await downloadPromise;
  const downloadPath = path.join(outputDir, 'taskmaster-fixture.txt');
  await download.saveAs(downloadPath);
  evidence.push({ kind: 'download', ok: true, file: path.basename(downloadPath) });
  await progress({ current: 7, total: 9, message: 'Download verified' });

  const screenshotPath = path.join(outputDir, 'acceptance.png');
  await page.screenshot({ path: screenshotPath, fullPage: false });
  evidence.push({ kind: 'screenshot', ok: true, file: path.basename(screenshotPath) });
  await progress({ current: 8, total: 9, message: 'Screenshot captured' });

  const passed = evidence.every((item) => item.ok);
  const report = {
    passed,
    behavior: action.mode,
    checkedAt: new Date().toISOString(),
    evidence
  };
  const reportPath = path.join(outputDir, 'acceptance.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await checkpoint({ stage: 'acceptance-complete', passed, report: path.basename(reportPath) });
  await progress({ current: 9, total: 9, message: passed ? 'All checks passed' : 'Acceptance checks failed' });

  if (!passed) {
    const failedKinds = evidence.filter((item) => !item.ok).map((item) => item.kind).join(', ');
    const error = new Error(`One or more Playwright acceptance checks failed: ${failedKinds}`);
    error.code = 'ACCEPTANCE_FAILED';
    throw error;
  }
  return {
    summary: `Playwright acceptance passed (${evidence.length}/${evidence.length})`,
    evidence: [
      ...evidence,
      { kind: 'artifact', file: path.basename(reportPath), agentVisible: true },
      { kind: 'artifact', file: path.basename(screenshotPath), agentVisible: true },
      { kind: 'artifact', file: path.basename(downloadPath), agentVisible: true }
    ]
  };
}
