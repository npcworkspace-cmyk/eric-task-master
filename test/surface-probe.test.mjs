import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { run } from '../examples/tasks/surface-probe-task.mjs';

function baseObservation(challengeText = '') {
  return {
    url: 'https://example.test/',
    title: 'Fixture',
    language: 'en',
    viewport: { width: 1280, height: 720, scrollY: 0 },
    documentHeight: 2400,
    counts: { links: 20, forms: 0, controls: 2, headings: 3, articles: 4, frames: 1 },
    headings: ['Fixture'],
    links: [],
    controls: [],
    nextCandidates: [],
    challengeText,
    stableLocatorHints: { testIds: 1, labelledControls: 2, landmarkRoles: 2 }
  };
}

async function fixture(t, { observations, semantics }) {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'taskmaster-surface-probe-'));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const handoffs = [];
  let observationIndex = 0;
  let semanticIndex = 0;
  const result = await run({
    page: {
      async evaluate() {
        return structuredClone(observations[Math.min(observationIndex++, observations.length - 1)]);
      }
    },
    semantic: {
      async snapshot() {
        return structuredClone(semantics[Math.min(semanticIndex++, semantics.length - 1)]);
      }
    },
    input: { url: 'https://example.test/' },
    outputDir,
    journey: {
      async open() {},
      async survey() { return { gestures: 2 }; }
    },
    handoff: {
      async request(input) {
        handoffs.push(input);
        return {
          requestId: 'handoff_0123456789abcdef0123456789abcdef',
          continuedAt: '2026-08-29T00:00:01.000Z'
        };
      }
    },
    async progress() {},
    async checkpoint() {},
    signal: new AbortController().signal
  });
  const report = JSON.parse(await readFile(path.join(outputDir, 'surface-probe.json'), 'utf8'));
  return { result, report, handoffs };
}

test('surface probe detects a verification signal exposed only through a cross-frame semantic snapshot', async (t) => {
  const challenge = { content: 'frame 1: https://challenge.test/\nbutton "Press and hold to verify you are human"', frameErrors: 0 };
  const clear = { content: 'frame 1: https://challenge.test/\nVerification complete', frameErrors: 0 };
  const { report, handoffs } = await fixture(t, {
    observations: [baseObservation(), baseObservation(), baseObservation()],
    semantics: [challenge, clear, clear]
  });

  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].kind, 'human_verification');
  assert.deepEqual(report.challengeBoundary.detected, ['captcha']);
  assert.equal(report.challengeBoundary.automation, 'none');
  assert.equal(report.recommendation.scaleAllowed, true);
});

test('surface probe fails scale closed when a frame cannot be inspected', async (t) => {
  const unreadable = { content: '', frameErrors: 1 };
  const { report, handoffs } = await fixture(t, {
    observations: [baseObservation(), baseObservation(), baseObservation()],
    semantics: [unreadable, unreadable, unreadable]
  });

  assert.equal(handoffs.length, 0);
  assert.equal(report.recommendation.scaleAllowed, false);
  assert.deepEqual(report.recommendation.blockers, ['frame-unreadable']);
  assert.equal(report.after.frameInspection.incomplete, true);
});

test('surface probe treats bounded child-frame truncation as a warning after a clean challenge scan', async (t) => {
  const truncated = {
    content: 'bounded semantic prefix without the challenge tail',
    frameErrors: 0,
    framesTotal: 2,
    framesInspected: 2,
    truncatedFrames: 1,
    framesOmitted: 0,
    truncated: true
  };
  const { report, handoffs } = await fixture(t, {
    observations: [baseObservation(), baseObservation(), baseObservation()],
    semantics: [truncated, truncated, truncated]
  });

  assert.equal(handoffs.length, 0);
  assert.equal(report.recommendation.scaleAllowed, true);
  assert.deepEqual(report.recommendation.blockers, []);
  assert.equal(report.after.frameInspection.truncatedFrames, 1);
  assert.equal(report.after.frameInspection.incomplete, true);
  assert.equal(report.after.frameInspection.blocking, false);
  assert.deepEqual(report.after.frameInspection.warnings, ['child-frame-truncated-bounded']);
});

test('surface probe allows a dense main document whose bounded semantic prefix is truncated', async (t) => {
  const observation = { ...baseObservation(), counts: { ...baseObservation().counts, frames: 0 } };
  const denseMain = {
    content: 'bounded main-document prefix',
    frameErrors: 0,
    framesTotal: 1,
    framesInspected: 1,
    truncatedFrames: 1,
    mainFrameTruncated: true,
    framesOmitted: 0,
    truncated: true
  };
  const { report } = await fixture(t, {
    observations: [observation, observation, observation],
    semantics: [denseMain, denseMain, denseMain]
  });

  assert.equal(report.recommendation.scaleAllowed, true);
  assert.equal(report.after.frameInspection.blocking, false);
  assert.deepEqual(report.after.frameInspection.warnings, ['main-document-truncated']);
});

test('surface probe ignores an incomplete hidden or decorative child frame', async (t) => {
  const decorative = {
    content: 'main document observed',
    frameErrors: 1,
    framesTotal: 2,
    framesInspected: 1,
    visibleChildFrameErrors: 0,
    hiddenChildFrameErrors: 1,
    truncatedFrames: 0,
    framesOmitted: 0
  };
  const { report } = await fixture(t, {
    observations: [baseObservation(), baseObservation(), baseObservation()],
    semantics: [decorative, decorative, decorative]
  });

  assert.equal(report.recommendation.scaleAllowed, true);
  assert.equal(report.after.frameInspection.blocking, false);
  assert.deepEqual(report.after.frameInspection.warnings, ['decorative-frame-incomplete']);
});

test('surface probe keeps a visible omitted child frame fail-closed', async (t) => {
  const omitted = {
    content: 'main document observed',
    frameErrors: 0,
    framesTotal: 2,
    framesInspected: 1,
    framesOmitted: 1,
    visibleFramesOmitted: 1
  };
  const { report } = await fixture(t, {
    observations: [baseObservation(), baseObservation(), baseObservation()],
    semantics: [omitted, omitted, omitted]
  });

  assert.equal(report.recommendation.scaleAllowed, false);
  assert.deepEqual(report.recommendation.blockers, ['frame-unreadable']);
  assert.equal(report.after.frameInspection.blocking, true);
});

test('surface probe detects a challenge exposed by the bounded secondary child-frame scan', async (t) => {
  const truncated = {
    content: 'bounded child prefix',
    frameErrors: 0,
    framesTotal: 2,
    framesInspected: 2,
    truncatedFrames: 1,
    visibleChildFramesTruncated: 1,
    framesOmitted: 0,
    truncated: true
  };
  const challenge = {
    content: 'Press and hold to verify you are human',
    frameErrors: 0,
    framesTotal: 2,
    framesInspected: 2,
    truncatedFrames: 0,
    framesOmitted: 0
  };
  const clear = { ...challenge, content: 'Verification complete' };
  const { report, handoffs } = await fixture(t, {
    observations: [baseObservation(), baseObservation(), baseObservation()],
    semantics: [truncated, challenge, clear, clear]
  });

  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].kind, 'human_verification');
  assert.equal(report.challengeBoundary.automation, 'none');
  assert.equal(report.recommendation.scaleAllowed, true);
});
