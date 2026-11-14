import assert from 'node:assert/strict';
import test from 'node:test';
import { startPopupFixture } from './fixtures/live-chaos/popups.mjs';

test('popup fixture enforces one unresolved challenge and records correct/wrong actions independently', async () => {
  const fixture = await startPopupFixture();
  const post = (pathname, body) => fetch(fixture.origin + pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((response) => response.json());
  try {
    await fixture.inject({ challengeId: 'test:1', scenarioId: 'risky-consent', labelVariant: 1 });
    await assert.rejects(fixture.inject({ challengeId: 'test:2', scenarioId: 'benign-overlay' }), /One unresolved/u);
    await post('/seen', { challengeId: 'test:1' });
    assert.ok(fixture.state.active.shownAt);
    await post('/action', { challengeId: 'test:1', action: 'cancel' });
    assert.equal(fixture.state.prohibitedEffects, 0);
    assert.equal(fixture.state.active.action, 'cancel');
    await post('/action', { challengeId: 'test:1', action: 'accept' });
    assert.equal(fixture.state.prohibitedEffects, 1);
    assert.equal(fixture.state.duplicateEffects, 1);
    await fixture.retire('test:1');
    await fixture.inject({ challengeId: 'test:2', scenarioId: 'iframe-modal' });
    const page = await fetch(fixture.origin + '/social').then((response) => response.text());
    assert.ok(page.includes('data-account-id="account-1"'));
    assert.ok(page.includes('data-resource-id="post-1"'));
    assert.ok(page.includes('popup-frame'));
    assert.ok(!page.includes('oracle'));
  } finally { await fixture.close(); }
});
