import assert from 'node:assert/strict';
import test from 'node:test';
import { socialReplyBatch, advertisingBatch, websiteBatch, SIMULATED_SELECTORS } from '../src/runtime/operations-workflows.mjs';

test('social mechanics require an actual Agent decision, rules and conversation identity', () => {
  assert.throws(() => socialReplyBatch({ decision: {}, selectors: {}, record: {}, replyText: 'hi' }), { code: 'DECISION_REQUIRED' });
  const value = socialReplyBatch({ decision: { approved: true, id: 'd1', ruleEvidence: 'No spam' }, selectors: SIMULATED_SELECTORS.social, record: { platform: 'local', communityId: 'c', postId: 'p', conversationId: 't' }, replyText: 'Approved reply' });
  assert.equal(value.actions.length, 2);
  assert.equal(value.actions[1].kind, 'social.reply');
  assert.equal(value.businessRecord.followUp.state, 'waiting');
  assert.equal(value.actions[1].interaction.replyToId, 'p');
  const laterDecision = socialReplyBatch({ decision: { approved: true, id: 'd2', ruleEvidence: 'No spam' }, selectors: SIMULATED_SELECTORS.social, record: { platform: 'local', communityId: 'c', postId: 'p', conversationId: 't' }, replyText: 'Approved reply' });
  assert.equal(laterDecision.actions[1].businessKey, value.actions[1].businessKey, 'new command/action ids cannot change the stable interaction identity');
  assert.throws(() => socialReplyBatch({ decision: { approved: true, id: 'd3', ruleEvidence: 'No spam', replyToId: 'new-comment' }, selectors: SIMULATED_SELECTORS.social, record: { platform: 'local', communityId: 'c', postId: 'p', conversationId: 't' }, replyText: 'follow-up' }), { code: 'INTERACTION_EVIDENCE_REQUIRED' });
});

test('advertising mechanics stop on insufficient data and retain budget units/observation window', () => {
  const record = { platform: 'Google', accountId: 'a', campaignId: 'c', currency: 'USD', budgetType: 'daily', before: 100, dataRange: 'last 7 days', dataAsOf: '2026-11-14T00:00:00Z', attribution: '7-day click', sufficient: false, observationUntil: '2026-11-15T00:00:00Z' };
  const input = { decision: { approved: true, id: 'd2' }, selectors: SIMULATED_SELECTORS.ads, record, nextBudget: 110 };
  assert.throws(() => advertisingBatch(input), { code: 'INSUFFICIENT_AD_DATA' });
  record.sufficient = true;
  const value = advertisingBatch(input);
  assert.equal(value.actions[1].currency, 'USD');
  assert.equal(value.actions[1].beforeTarget.selector, '#current-budget');
  assert.equal(value.businessRecord.observationUntil, record.observationUntil);
});

test('website mechanics preserve original/rollback and do not equate saving with propagation', () => {
  const input = { decision: { approved: true, id: 'd3' }, selectors: SIMULATED_SELECTORS.site, record: { domain: 'example.test', accountId: 'a', resourceId: 'r', before: 'old', rollback: 'Restore old', destructive: true }, nextValue: 'new' };
  assert.throws(() => websiteBatch(input), { code: 'DESTRUCTIVE_PERMISSION_REQUIRED' });
  input.decision.destructivePermission = true;
  const value = websiteBatch(input);
  assert.equal(value.businessRecord.effective, false);
  assert.equal(value.businessRecord.propagation, 'pending');
  assert.equal(value.actions[1].kind, 'site.destructive');
});
