import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'full-playwright-acceptance',
  version: '1.0.0',
  description: 'Built-in deterministic browser action acceptance task.',
  intents: ['accept-browser'],
  tags: ['acceptance', 'builtin'],
  outputs: ['json', 'png', 'download'],
  risk: 'mixed',
  interactionContract: 'full-human-v1',
  supportsResume: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url', 'uploadPath'],
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 4096 },
      uploadPath: { type: 'string', minLength: 1, maxLength: 4096 },
      expectCleanStart: { type: 'boolean' },
      expectExistingState: { type: 'boolean' }
    }
  }
});

async function storageValue(context, url, name) {
  const state = await context.storageState();
  const origin = new URL(url).origin;
  return state.origins?.find((item) => item.origin === origin)
    ?.localStorage?.find((item) => item.name === name)?.value ?? null;
}

export async function run({ page, context, input, outputDir, journey, capture, progress, checkpoint }) {
  if (!input?.url || !input?.uploadPath) {
    throw new TypeError('acceptance task requires input.url and input.uploadPath');
  }
  if (input.expectCleanStart && input.expectExistingState) {
    throw new TypeError('acceptance task state expectations are mutually exclusive');
  }
  await mkdir(outputDir, { recursive: true });
  const evidence = [];

  await journey.open(input.url, { waitUntil: 'domcontentloaded' });
  evidence.push({ kind: 'navigation', ok: page.url().startsWith(new URL(input.url).origin) });
  if (input.expectCleanStart || input.expectExistingState) {
    const initialCookies = await context.cookies(input.url);
    const initialStorage = await storageValue(context, input.url, 'taskmaster_fixture');
    if (input.expectCleanStart) {
      evidence.push({
        kind: 'ephemeral-clean-start',
        ok: !initialCookies.some((cookie) => cookie.name === 'taskmaster_fixture') && initialStorage === null
      });
    } else {
      evidence.push({
        kind: 'persistent-state-existing',
        ok: initialCookies.some((cookie) => (
          cookie.name === 'taskmaster_fixture' && cookie.value === 'accepted'
        )) && initialStorage === 'accepted'
      });
    }
  }
  await progress({ current: 1, total: 9, message: 'Fixture loaded' });

  await journey.fill('#name', 'Eric Task Master');
  evidence.push({ kind: 'input', ok: await page.locator('#name').inputValue() === 'Eric Task Master' });
  await progress({ current: 2, total: 9, message: 'Text input verified' });

  await journey.hover('#submit');
  await journey.scroll({ deltaY: 120, steps: 4 });
  const readingDelay = await journey.read({ words: 20 });
  const behaviorTrace = JSON.parse(
    await page.locator('html').getAttribute('data-taskmaster-trace') || '{}'
  );
  const inputGaps = behaviorTrace.inputTimeline.slice(1).map((at, index) => at - behaviorTrace.inputTimeline[index]);
  const humanBehavior = journey.contract === 'full-human-v1';
  evidence.push({
    kind: 'behavior',
    ok: humanBehavior
      ? behaviorTrace.pointerMoves >= 10 && behaviorTrace.inputEvents >= 16 &&
        behaviorTrace.keyEvents >= 16 && inputGaps.some((gap) => gap >= 8) &&
        behaviorTrace.wheelEvents >= 8 && readingDelay > 0 && readingDelay <= 8_000
      : readingDelay === 0,
    mode: 'profile-controlled',
    pointerMoves: behaviorTrace.pointerMoves,
    inputEvents: behaviorTrace.inputEvents,
    keyEvents: behaviorTrace.keyEvents,
    minimumObservedInputGap: inputGaps.length ? Math.min(...inputGaps) : 0,
    maximumObservedInputGap: inputGaps.length ? Math.max(...inputGaps) : 0,
    wheelEvents: behaviorTrace.wheelEvents,
    readingDelay
  });

  await journey.click('#agree');
  evidence.push({ kind: 'checkbox', ok: await page.locator('#agree').isChecked() });
  await journey.select('#choice', 'beta');
  evidence.push({ kind: 'select', ok: await page.locator('#choice').inputValue() === 'beta' });
  await progress({ current: 3, total: 9, message: 'Click and selection verified' });

  await journey.upload('#upload', input.uploadPath);
  evidence.push({
    kind: 'upload',
    ok: await page.locator('#upload').getAttribute('data-file-count') === '1'
  });
  await progress({ current: 4, total: 9, message: 'Upload verified' });

  await journey.click('#submit');
  const resultText = await page.locator('#result').innerText();
  evidence.push({ kind: 'submit', ok: resultText.includes('Eric Task Master|true|beta|') });
  await progress({ current: 5, total: 9, message: 'Submit result verified' });

  const cookies = await context.cookies(input.url);
  evidence.push({ kind: 'cookie', ok: cookies.some((cookie) => cookie.name === 'taskmaster_fixture') });
  const stored = await storageValue(context, input.url, 'taskmaster_fixture');
  evidence.push({ kind: 'localStorage', ok: stored === 'accepted' });
  await progress({ current: 6, total: 9, message: 'Browser storage verified' });

  const downloadPromise = page.waitForEvent('download');
  await journey.click('#download');
  const download = await downloadPromise;
  const downloadPath = path.join(outputDir, 'taskmaster-fixture.txt');
  await download.saveAs(downloadPath);
  evidence.push({ kind: 'download', ok: true, file: path.basename(downloadPath) });
  await progress({ current: 7, total: 9, message: 'Download verified' });

  const screenshotPath = path.join(outputDir, 'acceptance.png');
  await capture.viewport({ file: path.basename(screenshotPath) });
  evidence.push({ kind: 'screenshot', ok: true, file: path.basename(screenshotPath) });
  await progress({ current: 8, total: 9, message: 'Screenshot captured' });

  const passed = evidence.every((item) => item.ok);
  const report = {
    passed,
    interactionContract: journey.contract,
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
      { kind: 'count', label: 'acceptance checks passed', value: evidence.length },
      { kind: 'artifact', file: path.basename(reportPath), agentVisible: true },
      { kind: 'artifact', file: path.basename(screenshotPath), agentVisible: true },
      { kind: 'artifact', file: path.basename(downloadPath), agentVisible: true }
    ]
  };
}
