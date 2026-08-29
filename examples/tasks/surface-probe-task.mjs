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
  const observation = await page.evaluate((maximum) => {
    const text = (node) => (node?.innerText || node?.textContent || '').replace(/\s+/gu, ' ').trim();
    const bounded = (value, length = 240) => String(value || '').slice(0, length);
    const root = document.scrollingElement || document.documentElement;
    const documentHeight = Math.max(
      root?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    );
    const links = [...document.querySelectorAll('a[href]')].slice(0, maximum).map((anchor) => ({
      text: bounded(text(anchor)),
      href: bounded(anchor.href, 2_048),
      rel: bounded(anchor.getAttribute('rel'), 80)
    }));
    const controls = [...document.querySelectorAll('button,input,textarea,select,[role="button"],[role="textbox"],[role="combobox"]')]
      .slice(0, maximum)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        type: bounded(node.getAttribute('type'), 40),
        role: bounded(node.getAttribute('role'), 40),
        name: bounded(node.getAttribute('aria-label') || node.getAttribute('name') || node.getAttribute('placeholder') || text(node))
      }));
    const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')]
      .slice(0, maximum)
      .map((node) => bounded(text(node), 300))
      .filter(Boolean);
    const nextCandidates = links.filter((link) => (
      /(?:^|\s)next(?:\s|$)/iu.test(link.rel) || /^(?:next|older|more|下一页|下页|查看更多)$/iu.test(link.text)
    ));
    const shadowText = [];
    const candidates = [...document.querySelectorAll('*')].slice(0, 5_000);
    for (const node of candidates) {
      if (node.shadowRoot) shadowText.push(text(node.shadowRoot).slice(0, 2_000));
      if (shadowText.length >= 32) break;
    }
    return {
      url: location.href,
      title: bounded(document.title, 500),
      language: bounded(document.documentElement.lang, 40),
      viewport: { width: innerWidth, height: innerHeight, scrollY },
      documentHeight,
      counts: {
        links: document.links.length,
        forms: document.forms.length,
        controls: document.querySelectorAll('button,input,textarea,select,[role="button"],[role="textbox"],[role="combobox"]').length,
        headings: document.querySelectorAll('h1,h2,h3,[role="heading"]').length,
        articles: document.querySelectorAll('article,[role="article"]').length,
        frames: document.querySelectorAll('iframe').length
      },
      headings,
      links,
      controls,
      nextCandidates,
      challengeText: `${text(document.body).slice(0, 12_000)}\n${shadowText.join('\n')}`.slice(0, 50_000),
      stableLocatorHints: {
        testIds: document.querySelectorAll('[data-testid],[data-test],[data-qa]').length,
        labelledControls: document.querySelectorAll('[aria-label],[aria-labelledby],label[for]').length,
        landmarkRoles: document.querySelectorAll('main,nav,article,[role="main"],[role="navigation"],[role="article"]').length
      }
    };
  }, limit);
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
