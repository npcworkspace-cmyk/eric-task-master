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

test('surface probe fails scale closed when any inspected frame or snapshot is truncated', async (t) => {
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
  assert.equal(report.recommendation.scaleAllowed, false);
  assert.deepEqual(report.recommendation.blockers, ['frame-unreadable']);
  assert.equal(report.after.frameInspection.truncatedFrames, 1);
  assert.equal(report.after.frameInspection.incomplete, true);
});
