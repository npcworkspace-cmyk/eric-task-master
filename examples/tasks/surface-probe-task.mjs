import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'surface-probe',
  version: '1.0.0',
  description: 'Inspect one bounded representative web surface before authoring an unknown large-scale workflow.',
  intents: ['inspect-surface', 'preflight-probe', 'plan-task-pack', 'probe', 'surface', 'preflight', 'scale'],
  tags: ['builtin', 'observation', 'preflight', 'probe', 'scale', 'surface'],
  outputs: ['json'],
  risk: 'read',
  readOnly: true,
  interactionContract: 'full-human-v1',
  supportsResume: false,
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 4096 },
      maxItems: { type: 'integer', minimum: 10, maximum: 120 },
      maxGestures: { type: 'integer', minimum: 1, maximum: 12 }
    }
  }
});

function httpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('surface-probe only accepts HTTP(S) URLs');
  }
  return url.href;
}

const BLOCKING_SIGNALS = new Set(['captcha', 'rate-limit', 'frame-unreadable']);

function detectChallengeSignals(value) {
  const source = String(value || '').slice(0, 50_000).toLowerCase();
  return [
    ['login', /\b(?:log in|sign in)\b|登录|登入/u],
    ['captcha', /captcha|verify you are human|robot or human|press and hold|activate and hold|人机验证|验证码|按住/u],
    ['rate-limit', /too many requests|rate limit|请求过于频繁|访问频繁/u],
    ['cookie-dialog', /cookie preferences|accept cookies|管理 cookie|接受.*cookie/u]
  ].filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

function finiteCount(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function summarizeFrameInspection(snapshot, fallbackChildFrames = 0) {
  const framesTotal = finiteCount(snapshot?.framesTotal, fallbackChildFrames + 1);
  const framesInspected = finiteCount(
    snapshot?.framesInspected,
    Math.max(0, framesTotal - finiteCount(snapshot?.frameErrors))
  );
  const truncatedFrames = finiteCount(snapshot?.truncatedFrames);
  const mainFrameTruncated = snapshot?.mainFrameTruncated === true ||
    (snapshot?.mainFrameTruncated === undefined && framesTotal <= 1 && snapshot?.truncated === true);
  const visibleChildFrameErrors = finiteCount(
    snapshot?.visibleChildFrameErrors,
    finiteCount(snapshot?.frameErrors)
  );
  const hiddenChildFrameErrors = finiteCount(snapshot?.hiddenChildFrameErrors);
  const visibleChildFramesTruncated = finiteCount(
    snapshot?.visibleChildFramesTruncated,
    Math.max(0, truncatedFrames - (mainFrameTruncated ? 1 : 0))
  );
  const hiddenChildFramesTruncated = finiteCount(snapshot?.hiddenChildFramesTruncated);
  const omitted = finiteCount(snapshot?.framesOmitted, Math.max(0, framesTotal - framesInspected));
  const visibleFramesOmitted = finiteCount(snapshot?.visibleFramesOmitted, omitted);
  const hiddenFramesOmitted = finiteCount(snapshot?.hiddenFramesOmitted);
  const unknownFramesOmitted = finiteCount(snapshot?.unknownFramesOmitted);
  const blocking = visibleChildFrameErrors > 0 || visibleFramesOmitted > 0 || unknownFramesOmitted > 0;
  const incomplete = blocking || mainFrameTruncated || visibleChildFramesTruncated > 0 ||
    hiddenChildFrameErrors > 0 || hiddenChildFramesTruncated > 0 || hiddenFramesOmitted > 0;
  const warnings = [];
  if (mainFrameTruncated) warnings.push('main-document-truncated');
  if (visibleChildFramesTruncated > 0) warnings.push('child-frame-truncated-bounded');
  if (hiddenChildFrameErrors > 0 || hiddenChildFramesTruncated > 0 || hiddenFramesOmitted > 0) {
    warnings.push('decorative-frame-incomplete');
  }
  return {
    total: framesTotal,
    inspected: framesInspected,
    errors: finiteCount(snapshot?.frameErrors),
    visibleChildFrameErrors,
    hiddenChildFrameErrors,
    truncatedFrames,
    mainFrameTruncated,
    visibleChildFramesTruncated,
    hiddenChildFramesTruncated,
    omitted,
    visibleFramesOmitted,
    hiddenFramesOmitted,
    unknownFramesOmitted,
    incomplete,
    blocking,
    warnings
  };
}

async function observe(page, semantic, limit) {
  const bounded = (value, length = 240) => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, length);
  const safeCount = async (selector) => page.locator(selector).count().catch(() => 0);
  const safeText = async (locator, length = 240) => {
    const inner = await locator.innerText({ timeout: 2_000 }).catch(() => null);
    if (inner !== null) return bounded(inner, length);
    return bounded(await locator.textContent({ timeout: 2_000 }).catch(() => ''), length);
  };
  const baseUrl = page.url();
  const linkLocator = page.locator('a[href]');
  const linkCount = await linkLocator.count().catch(() => 0);
  const links = [];
  for (let index = 0; index < Math.min(linkCount, limit); index += 1) {
    const locator = linkLocator.nth(index);
    const rawHref = await locator.getAttribute('href', { timeout: 2_000 }).catch(() => '');
    let href = bounded(rawHref, 2_048);
    try {
      href = bounded(new URL(rawHref, baseUrl).href, 2_048);
    } catch {}
    links.push({
      text: await safeText(locator),
      href,
      rel: bounded(await locator.getAttribute('rel', { timeout: 2_000 }).catch(() => ''), 80)
    });
  }
  const controlLocator = page.locator('button,input,textarea,select,[role="button"],[role="textbox"],[role="combobox"]');
  const controlCount = await controlLocator.count().catch(() => 0);
  const controls = [];
  for (let index = 0; index < Math.min(controlCount, limit); index += 1) {
    const locator = controlLocator.nth(index);
    const attributes = await Promise.all([
      locator.getAttribute('type', { timeout: 2_000 }).catch(() => ''),
      locator.getAttribute('role', { timeout: 2_000 }).catch(() => ''),
      locator.getAttribute('aria-label', { timeout: 2_000 }).catch(() => ''),
      locator.getAttribute('name', { timeout: 2_000 }).catch(() => ''),
      locator.getAttribute('placeholder', { timeout: 2_000 }).catch(() => '')
    ]);
    controls.push({
      tag: 'control',
      type: bounded(attributes[0], 40),
      role: bounded(attributes[1], 40),
      name: bounded(attributes[2] || attributes[3] || attributes[4] || await safeText(locator))
    });
  }
  const headingLocator = page.locator('h1,h2,h3,[role="heading"]');
  const headingCount = await headingLocator.count().catch(() => 0);
  const headings = [];
  for (let index = 0; index < Math.min(headingCount, limit); index += 1) {
    const value = await safeText(headingLocator.nth(index), 300);
    if (value) headings.push(value);
  }
  const nextCandidates = links.filter((link) => (
    /(?:^|\s)next(?:\s|$)/iu.test(link.rel) || /^(?:next|older|more|下一页|下页|查看更多)$/iu.test(link.text)
  ));
  const viewport = page.viewportSize() || { width: null, height: null };
  const bodyBox = await page.locator('body').boundingBox({ timeout: 2_000 }).catch(() => null);
  const counts = {
    links: linkCount,
    forms: await safeCount('form'),
    controls: controlCount,
    headings: headingCount,
    articles: await safeCount('article,[role="article"]'),
    frames: await safeCount('iframe')
  };
  const observation = {
    url: baseUrl,
    title: bounded(await page.title().catch(() => ''), 500),
    language: bounded(await page.locator('html').getAttribute('lang', { timeout: 2_000 }).catch(() => ''), 40),
    viewport: { width: viewport.width, height: viewport.height, scrollY: null },
    documentHeight: Math.max(Number(bodyBox?.height) || 0, Number(viewport.height) || 0),
    counts,
    headings,
    links,
    controls,
    nextCandidates,
    challengeText: bounded(await safeText(page.locator('body'), 50_000), 50_000),
    stableLocatorHints: {
      testIds: await safeCount('[data-testid],[data-test],[data-qa]'),
      labelledControls: await safeCount('[aria-label],[aria-labelledby],label[for]'),
      landmarkRoles: await safeCount('main,nav,article,[role="main"],[role="navigation"],[role="article"]')
    }
  };
  let semanticSnapshot = null;
  try {
    semanticSnapshot = await semantic.snapshot({
      scope: 'full_page',
      maxNodes: Math.min(120, limit * 2),
      maxTextChars: 30_000
    });
  } catch {
    semanticSnapshot = {
      content: '',
      frameErrors: observation.counts.frames > 0 ? 1 : 0,
      visibleChildFrameErrors: observation.counts.frames > 0 ? 1 : 0
    };
  }
  const challengeSignals = new Set([
    ...detectChallengeSignals(observation.challengeText),
    ...detectChallengeSignals(semanticSnapshot.content)
  ]);
  let frameInspection = summarizeFrameInspection(semanticSnapshot, observation.counts.frames);
  if (frameInspection.visibleChildFramesTruncated > 0) {
    try {
      const challengeScan = await semantic.snapshot({
        scope: 'viewport',
        maxNodes: 500,
        maxTextChars: 50_000
      });
      for (const signalName of detectChallengeSignals(challengeScan.content)) challengeSignals.add(signalName);
      const secondPass = summarizeFrameInspection(challengeScan, observation.counts.frames);
      frameInspection = {
        ...frameInspection,
        challengeScan: {
          attempted: true,
          blocking: secondPass.blocking,
          incomplete: secondPass.incomplete,
          warnings: secondPass.warnings
        },
        blocking: frameInspection.blocking || secondPass.blocking,
        incomplete: frameInspection.incomplete || secondPass.incomplete,
        warnings: [...new Set([...frameInspection.warnings, ...secondPass.warnings])]
      };
    } catch {
      frameInspection = {
        ...frameInspection,
        challengeScan: { attempted: true, blocking: true, incomplete: true, warnings: [] },
        blocking: true,
        incomplete: true
      };
    }
  }
  if (frameInspection.blocking) challengeSignals.add('frame-unreadable');
  const { challengeText: _challengeText, ...safeObservation } = observation;
  return {
    ...safeObservation,
    challengeSignals: [...challengeSignals],
    frameInspection
  };
}

function recommendRecipe(observation) {
  if (observation.counts.forms > 0 && observation.counts.controls > 1) return 'form-workflow';
  if (observation.nextCandidates.length > 0) return 'paginated-list';
  if (observation.counts.links >= 10 || observation.counts.articles >= 3) return 'list-detail';
  return 'single-page';
}

export async function run({ page, semantic, input, outputDir, journey, handoff, progress, checkpoint, signal }) {
  const url = httpUrl(input.url);
  const maxItems = input.maxItems ?? 60;
  const maxGestures = input.maxGestures ?? 6;
  await mkdir(outputDir, { recursive: true });

  await journey.open(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const initial = await observe(page, semantic, maxItems);
  await progress({ current: 1, total: 3, message: 'Representative surface loaded and bounded structure sampled' });
  if (signal?.aborted) throw signal.reason || new Error('Surface probe aborted');

  let verification = null;
  if (initial.challengeSignals.includes('captcha')) {
    const continuation = await handoff.request({
      kind: 'human_verification',
      reason: 'The representative surface requires human verification before read-only preflight can continue',
      instructions: 'Complete the visible verification in this task window, then continue the same task. Task Master will not solve or bypass the challenge.'
    });
    verification = {
      kind: 'human_verification',
      requestId: continuation.requestId,
      continuedAt: continuation.continuedAt
    };
  }

  const afterVerification = await observe(page, semantic, maxItems);
  const verificationStillRequired = afterVerification.challengeSignals.includes('captcha');
  const survey = verificationStillRequired
    ? { skipped: true, reason: 'human_verification_still_present' }
    : await journey.survey({ maxGestures });
  const after = await observe(page, semantic, maxItems);
  await progress({ current: 2, total: 3, message: 'Bounded full-page survey and backtrack completed' });

  const recommendedRecipe = recommendRecipe(after);
  const report = {
    schemaVersion: 1,
    probedAt: new Date().toISOString(),
    scope: {
      representativeUrls: 1,
      maxItems,
      maxGestures,
      exhaustive: false,
      note: 'This is a bounded preflight sample, not proof of full-site coverage.'
    },
    before: initial,
    after,
    survey,
    challengeBoundary: {
      detected: initial.challengeSignals,
      ...(verification ? { handoff: verification } : {}),
      unresolved: after.challengeSignals.filter((signalName) => BLOCKING_SIGNALS.has(signalName)),
      automation: 'none'
    },
    recommendation: {
      recipe: recommendedRecipe,
      scaleAllowed: after.challengeSignals.every((signalName) => !BLOCKING_SIGNALS.has(signalName)),
      blockers: after.challengeSignals.filter((signalName) => BLOCKING_SIGNALS.has(signalName)),
      nextAction: `Customize the ${recommendedRecipe} recipe with site-specific selectors, checkpoints, rate limits, outputs, and completion evidence; validate one bounded sample before scale.`
    }
  };
  const file = 'surface-probe.json';
  await writeFile(path.join(outputDir, file), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await checkpoint({ stage: 'surface-probed', url: after.url, artifact: file, recommendedRecipe });
  await progress({ current: 3, total: 3, message: 'Probe evidence persisted; scale decision is ready' });
  return {
    summary: `Surface probe recommends ${recommendedRecipe}; scaleAllowed=${report.recommendation.scaleAllowed}`,
    evidence: [
      { kind: 'url', value: after.url },
      { kind: 'note', value: `Recommended recipe: ${recommendedRecipe}` },
      { kind: 'artifact', file, agentVisible: true }
    ]
  };
}
