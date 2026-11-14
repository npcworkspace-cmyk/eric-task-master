import { fastError } from './fast-browser.mjs';

// These helpers encode mechanical steps only. Text, strategy and permission are
// supplied by the main Agent after reviewing the observed page and its rules.
export function workflowEnvelope({ operationId, authorizationVersion, observation, commandId, kind, payload }) {
  return { schemaVersion: 1, operationId, authorizationVersion, commandId, kind, pageId: observation?.pageId, pageVersion: observation?.pageVersion, payload };
}

export function socialReplyBatch({ decision, selectors, record, replyText }) {
  if (!decision?.approved || typeof replyText !== 'string' || !replyText.trim() || !decision.ruleEvidence) throw fastError('DECISION_REQUIRED', 'An explicit main-Agent reply decision and observed rule evidence are required');
  if (!record?.postId || !record.communityId || !record.conversationId) throw fastError('CONTEXT_INSUFFICIENT', 'Social record needs post, community and conversation identifiers');
  if (!record.platform) throw fastError('CONTEXT_INSUFFICIENT', 'Social record needs a platform identity');
  const replyToId = decision.replyToId || record.postId;
  const interaction = { platform: record.platform, communityId: record.communityId, postId: record.postId, conversationId: record.conversationId, replyToId, ...(decision.replyToEvidence ? { replyToEvidence: decision.replyToEvidence } : {}) };
  if (replyToId !== record.postId && (!interaction.replyToEvidence?.target || interaction.replyToEvidence.expectedId !== replyToId)) throw fastError('INTERACTION_EVIDENCE_REQUIRED', 'Follow-up replies need observed identity evidence for the new reply target');
  const businessKey = [record.platform, record.communityId, record.postId, record.conversationId, replyToId].map(encodeURIComponent).join(':');
  return {
    preconditions: [{ target: { selector: selectors.rules }, includes: decision.ruleEvidence }],
    stopConditions: [{ target: { selector: selectors.permissionError }, state: 'visible' }],
    actions: [
      { actionId: `${decision.id}:fill`, type: 'fill', kind: 'social.prepare', effect: false, target: { selector: selectors.replyInput }, value: replyText, expected: { target: { selector: selectors.replyInput }, value: replyText }, businessKey },
      { actionId: `${decision.id}:publish`, type: 'click', kind: 'social.reply', target: { selector: selectors.publish }, proposed: replyText, interaction, expected: { target: { selector: selectors.replyResult }, text: replyText }, businessKey, reason: decision.reason }
    ],
    verify: [{ target: { selector: selectors.replyResult }, text: replyText }],
    businessRecord: { kind: 'social', ...record, replyResult: 'confirmed', replyText, followUp: { state: 'waiting', target: selectors.followUp } }
  };
}

export function advertisingBatch({ decision, selectors, record, nextBudget }) {
  if (!decision?.approved) throw fastError('DECISION_REQUIRED', 'An explicit main-Agent advertising decision is required');
  if (!['Google', 'Meta'].includes(record?.platform) || !record.accountId || !record.campaignId || !record.currency || !['daily', 'lifetime'].includes(record.budgetType) || !record.dataRange || !record.dataAsOf || !record.attribution || record.sufficient !== true) throw fastError('INSUFFICIENT_AD_DATA', 'Fresh, sufficiently attributed account/budget context is required');
  if (![Number(record.before), nextBudget].every(Number.isFinite) || nextBudget < 0) throw fastError('INVALID_BUDGET', 'Budget must be a finite non-negative value');
  const guard = { target: { selector: selectors.currentBudget }, text: String(record.before) };
  const context = { currency: record.currency, budgetType: record.budgetType, field: 'budget', before: Number(record.before), proposed: nextBudget, dataRange: record.dataRange, dataAsOf: record.dataAsOf, attribution: record.attribution };
  return {
    resourceId: record.campaignId,
    preconditions: [{ target: { selector: selectors.currency }, text: record.currency }, { target: { selector: selectors.budgetType }, text: record.budgetType }, { target: { selector: selectors.sufficient }, text: 'sufficient' }],
    stopConditions: [{ target: { selector: selectors.permissionError }, state: 'visible' }],
    actions: [
      { actionId: `${decision.id}:fill`, type: 'fill', kind: 'ads.prepare', effect: false, target: { selector: selectors.budgetInput }, value: String(nextBudget), guard, expected: { target: { selector: selectors.budgetInput }, value: String(nextBudget) }, ...context },
      { actionId: `${decision.id}:save`, type: 'click', kind: 'ads.adjust', target: { selector: selectors.save }, guard, beforeTarget: { selector: selectors.currentBudget }, expected: { target: { selector: selectors.currentBudget }, text: String(nextBudget) }, businessKey: `${record.platform}:${record.campaignId}:budget`, reason: decision.reason, ...context }
    ],
    verify: [{ target: { selector: selectors.currentBudget }, text: String(nextBudget) }],
    businessRecord: { kind: 'ads', ...record, after: nextBudget, reason: decision.reason, observationUntil: record.observationUntil || null }
  };
}

export function websiteBatch({ decision, selectors, record, nextValue }) {
  if (!decision?.approved) throw fastError('DECISION_REQUIRED', 'An explicit main-Agent configuration decision is required');
  if (!record?.domain || !record.accountId || !record.resourceId || record.before === undefined || !record.rollback) throw fastError('CONTEXT_INSUFFICIENT', 'Domain, resource, original value and rollback evidence are required');
  if (record.destructive && decision.destructivePermission !== true) throw fastError('DESTRUCTIVE_PERMISSION_REQUIRED', 'Destructive configuration requires explicit permission');
  return {
    resourceId: record.resourceId,
    preconditions: [{ target: { selector: selectors.domain }, text: record.domain }],
    stopConditions: [{ target: { selector: selectors.permissionError }, state: 'visible' }],
    actions: [
      { actionId: `${decision.id}:fill`, type: 'fill', kind: 'site.prepare', effect: false, target: { selector: selectors.valueInput }, value: nextValue, expected: { target: { selector: selectors.valueInput }, value: nextValue } },
      { actionId: `${decision.id}:save`, type: 'click', kind: record.destructive ? 'site.destructive' : 'site.configure', target: { selector: selectors.save }, before: record.before, proposed: nextValue, beforeTarget: { selector: selectors.currentValue }, expected: { target: { selector: selectors.currentValue }, text: nextValue }, businessKey: `${record.domain}:${record.resourceId}`, reason: decision.reason }
    ],
    verify: [{ target: { selector: selectors.currentValue }, text: nextValue }, { target: { selector: selectors.saved }, text: 'saved' }],
    businessRecord: { kind: 'site', ...record, after: nextValue, submissionStatus: 'saved', readback: nextValue, propagation: 'pending', effective: false }
  };
}

export const SIMULATED_SELECTORS = Object.freeze({
  account: '[data-account-id]', resource: '[data-resource-id]', permissionError: '#permission-error',
  social: { rules: '#rules', permissionError: '#permission-error', replyInput: '#reply', publish: '#publish', replyResult: '#reply-result', followUp: '#follow-up' },
  ads: { currentBudget: '#current-budget', budgetInput: '#budget', save: '#save-budget', currency: '#currency', budgetType: '#budget-type', sufficient: '#data-sufficiency', permissionError: '#permission-error' },
  site: { domain: '#domain', currentValue: '#current-value', valueInput: '#config-value', save: '#save-config', saved: '#saved', permissionError: '#permission-error' }
});
