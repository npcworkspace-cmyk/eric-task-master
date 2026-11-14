export const POPUP_FAMILIES = Object.freeze(['benign-overlay', 'risky-consent', 'destructive-confirmation', 'login-security', 'new-tab', 'iframe-modal', 'native-alert', 'native-choice']);

export function seededRandom(seed) {
  let value = 2166136261;
  for (const character of String(seed)) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return () => { value ^= value << 13; value ^= value >>> 17; value ^= value << 5; return (value >>> 0) / 4294967296; };
}

export function popupPlan({ seed, durationMs = 8 * 3600000 } = {}) {
  if (!Number.isSafeInteger(durationMs) || durationMs < 24000) throw new Error('Popup experiment duration must be at least 24000ms');
  const random = seededRandom(seed);
  const slotMs = durationMs / 24;
  const plan = [];
  const seen = new Map();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    const order = [...POPUP_FAMILIES];
    for (let index = order.length - 1; index > 0; index -= 1) { const swap = Math.floor(random() * (index + 1)); [order[index], order[swap]] = [order[swap], order[index]]; }
    for (const scenarioId of order) {
      const sequence = plan.length + 1;
      const occurrence = (seen.get(scenarioId) || 0) + 1; seen.set(scenarioId, occurrence);
      plan.push({ sequence, scenarioId, occurrence, atMs: Math.round((sequence - 1) * slotMs + slotMs * (0.1 + random() * 0.5)), variant: scenarioId === 'native-choice' ? occurrence === 2 ? 'prompt' : 'confirm' : null, placement: ['before-action', 'during-wait', 'after-observation'][Math.floor(random() * 3)], labelVariant: Math.floor(random() * 3) });
    }
  }
  return plan;
}
