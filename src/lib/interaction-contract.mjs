export const FULL_HUMAN_INTERACTION_CONTRACT = 'full-human-v1';

export const INTERACTION_CONTRACTS = Object.freeze([
  FULL_HUMAN_INTERACTION_CONTRACT
]);

export function isInteractionContract(value) {
  return INTERACTION_CONTRACTS.includes(value);
}

export class InteractionContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InteractionContractError';
    this.code = code;
  }
}

const FORBIDDEN_PACK_PATTERNS = Object.freeze([
  {
    pattern: /\baction\s*(?:\.|\[)\s*['"]?(?:goto|click|fill|type|hover|select|scroll|read|run|wait|signal)['"]?\s*\]?\s*\(/u,
    operation: 'legacy action facade'
  },
  {
    pattern: /\bpage\s*(?:\.|\[)\s*['"]?(?:goto|reload|goBack|goForward|setContent|close|bringToFront|click|dblclick|fill|type|press|hover|focus|check|uncheck|selectOption|setInputFiles|tap|dispatchEvent|dragAndDrop)['"]?\s*\]?\s*\(/u,
    operation: 'direct Page navigation or mutation'
  },
  {
    pattern: /\bcontext\s*(?:\.|\[)\s*['"]?(?:newPage|newCDPSession|addCookies|clearCookies|close|grantPermissions|setGeolocation|setExtraHTTPHeaders|addInitScript)['"]?\s*\]?\s*\(/u,
    operation: 'direct BrowserContext mutation'
  },
  {
    pattern: /\bpage\s*(?:\.|\[)\s*['"]?(?:mouse|keyboard|touchscreen)['"]?\b/u,
    operation: 'raw input device access'
  },
  {
    pattern: /\.scrollIntoViewIfNeeded\s*\(/u,
    operation: 'instant target positioning'
  },
  {
    pattern: /\b(?:page|frame)\s*\.\s*(?:\$\$?|evaluateHandle|waitForSelector)\s*\(/u,
    operation: 'raw ElementHandle or JSHandle escape'
  },
  {
    pattern: /\.locator\s*\([^)]*\)\s*\.\s*(?:click|dblclick|fill|clear|type|press|pressSequentially|check|uncheck|setChecked|selectOption|setInputFiles|hover|focus|blur|dragTo|dispatchEvent)\s*\(/u,
    operation: 'direct Locator mutation'
  }
]);

/**
 * Task Packs are trusted code, not a hostile-code sandbox. This preflight is
 * deliberately a clear accidental-bypass gate; the runtime read-only facade
 * remains the authoritative enforcement boundary.
 */
export function validateFullHumanPackSource(source) {
  const text = Buffer.isBuffer(source) ? source.toString('utf8') : String(source || '');
  if (!/\bjourney\s*(?:\.|\[)/u.test(text)) {
    throw new InteractionContractError(
      'TASK_PACK_JOURNEY_REQUIRED',
      'full-human-v1 Task Pack modules must use the journey facade'
    );
  }
  for (const rule of FORBIDDEN_PACK_PATTERNS) {
    if (!rule.pattern.test(text)) continue;
    throw new InteractionContractError(
      'TASK_PACK_JOURNEY_BYPASS',
      `full-human-v1 Task Pack modules cannot use ${rule.operation}`
    );
  }
  return true;
}
