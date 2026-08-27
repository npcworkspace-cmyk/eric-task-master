import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const meta = Object.freeze({
  name: 'surface-probe',
  version: '1.0.0',
  description: 'Inspect one bounded representative web surface before authoring an unknown large-scale workflow.',
  intents: ['inspect-surface', 'preflight-probe', 'plan-task-pack'],
  tags: ['builtin', 'observation', 'probe'],
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

async function observe(page, limit) {
  return page.evaluate((maximum) => {
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
    const bodyText = text(document.body).slice(0, 12_000).toLowerCase();
    const challengeSignals = [
      ['login', /\b(?:log in|sign in)\b|登录|登入/u],
      ['captcha', /captcha|verify you are human|人机验证|验证码/u],
      ['rate-limit', /too many requests|rate limit|请求过于频繁|访问频繁/u],
      ['cookie-dialog', /cookie preferences|accept cookies|管理 cookie|接受.*cookie/u]
    ].filter(([, pattern]) => pattern.test(bodyText)).map(([name]) => name);
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
      challengeSignals,
      stableLocatorHints: {
        testIds: document.querySelectorAll('[data-testid],[data-test],[data-qa]').length,
        labelledControls: document.querySelectorAll('[aria-label],[aria-labelledby],label[for]').length,
        landmarkRoles: document.querySelectorAll('main,nav,article,[role="main"],[role="navigation"],[role="article"]').length
      }
    };
  }, limit);
}

function recommendRecipe(observation) {
  if (observation.counts.forms > 0 && observation.counts.controls > 1) return 'form-workflow';
  if (observation.nextCandidates.length > 0) return 'paginated-list';
  if (observation.counts.links >= 10 || observation.counts.articles >= 3) return 'list-detail';
  return 'single-page';
}

export async function run({ page, input, outputDir, journey, progress, checkpoint, signal }) {
  const url = httpUrl(input.url);
  const maxItems = input.maxItems ?? 60;
  const maxGestures = input.maxGestures ?? 6;
  await mkdir(outputDir, { recursive: true });

  await journey.open(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const before = await observe(page, maxItems);
  await progress({ current: 1, total: 3, message: 'Representative surface loaded and bounded structure sampled' });
  if (signal?.aborted) throw signal.reason || new Error('Surface probe aborted');

  const survey = await journey.survey({ maxGestures });
  const after = await observe(page, maxItems);
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
    before,
    after,
    survey,
    recommendation: {
      recipe: recommendedRecipe,
      scaleAllowed: after.challengeSignals.every((signalName) => !['captcha', 'rate-limit'].includes(signalName)),
      blockers: after.challengeSignals.filter((signalName) => ['captcha', 'rate-limit'].includes(signalName)),
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
