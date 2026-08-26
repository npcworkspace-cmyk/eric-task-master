import { isBehaviorMode } from '../contracts.mjs';

const DEFAULT_HUMAN_TIMING = Object.freeze({
  cautiousBeforeAction: [15, 45],
  cautiousAfterAction: [25, 75],
  beforeAction: [45, 140],
  afterAction: [55, 180],
  hoverPause: [90, 260],
  clickDelay: [45, 120],
  mouseSteps: [14, 30],
  mouseStepPause: [3, 11],
  mouseCorrectionSteps: [4, 8],
  keyDelay: [25, 85],
  selectionKeyPause: [35, 95],
  wordPause: [30, 90],
  punctuationPause: [120, 320],
  scrollPause: [45, 135],
  scrollGesturePause: [180, 620],
  readingBase: [450, 900],
  readingPerWord: [85, 145],
  readingMaximum: 12_000
});

const ADAPTIVE_SIGNALS = Object.freeze({
  dynamic: Object.freeze({ level: 1, actions: 2 }),
  action_failure: Object.freeze({ level: 2, actions: 4 }),
  occluded: Object.freeze({ level: 2, actions: 4 }),
  timeout: Object.freeze({ level: 2, actions: 4 }),
  navigation_unknown: Object.freeze({ level: 3, actions: 6 }),
  rate_limit: Object.freeze({ level: 3, actions: 6 })
});

const ADAPTIVE_LABELS = Object.freeze(['fast', 'cautious', 'guarded', 'cooldown']);

export class BehaviorActionError extends Error {
  constructor(operation, cause) {
    super(`${operation} failed: ${cause?.message || 'unknown error'}`, { cause });
    this.name = 'BehaviorActionError';
    this.code = 'ACTION_FAILED';
    this.operation = operation;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberBetween(range, random) {
  const [minimum, maximum] = range;
  return Math.round(minimum + (maximum - minimum) * random());
}

function asLocator(page, target) {
  if (typeof target === 'string') return page.locator(target);
  if (target && typeof target === 'object') return target;
  throw new TypeError('Action target must be a selector string or Playwright Locator');
}

function easedSegments(total, steps, random) {
  const weights = Array.from({ length: steps }, (_, index) => {
    const easing = Math.sin(Math.PI * (index + 1) / (steps + 1));
    return easing * (0.9 + random() * 0.2);
  });
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  let sent = 0;
  return weights.map((weight, index) => {
    const value = index === steps - 1 ? total - sent : Math.round(total * weight / weightTotal);
    sent += value;
    return value;
  });
}

function adaptiveFailureSignal(error) {
  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  if (text.includes('occlud') || text.includes('intercept')) return 'occluded';
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('navigation') || text.includes('target closed') || text.includes('context destroyed')) {
    return 'navigation_unknown';
  }
  return 'action_failure';
}

/**
 * Creates the task-scoped action facade used by task modules. Adaptive mode
 * keeps deterministic work fast, adds only short settling pauses for ordinary
 * dynamic-page signals, and uses full human pacing after stronger ambiguity or
 * rate-limit signals. It never retries an unknown action outcome automatically.
 */
export function createActionHelper({
  page,
  mode = 'fast',
  random = Math.random,
  sleep = defaultSleep,
  abortSignal,
  onFailure = async () => {},
  onEffect = async () => undefined,
  onAdaptiveState = () => {},
  timing = DEFAULT_HUMAN_TIMING,
  strictVisibleTraversal = false
} = {}) {
  if (!page) throw new TypeError('page is required');
  if (!isBehaviorMode(mode)) throw new TypeError(`Unsupported behavior mode: ${mode}`);

  let adaptiveLevel = 0;
  let adaptiveActionsRemaining = 0;
  let adaptiveSignal = null;
  let adaptiveGeneration = 0;
  let cursor = null;
  const metrics = {
    navigations: 0,
    clicks: 0,
    pointerMoves: 0,
    pointerCorrections: 0,
    visibleTargetAcquisitions: 0,
    typedCharacters: 0,
    selectionKeyEvents: 0,
    scrollGestures: 0,
    wheelEvents: 0,
    targetTraversals: 0,
    readingDwells: 0,
    readingDurationMs: 0
  };

  const throwIfAborted = () => {
    if (!abortSignal?.aborted) return;
    throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Task execution was aborted');
  };

  const usesHumanTiming = () => mode === 'human' || (mode === 'adaptive' && adaptiveLevel >= 2);
  const usesCautiousTiming = () => mode === 'adaptive' && adaptiveLevel === 1;

  async function pause(range) {
    if (usesHumanTiming()) {
      await sleep(numberBetween(range, random));
    } else if (usesCautiousTiming()) {
      const cautiousRange = range === timing.beforeAction
        ? timing.cautiousBeforeAction
        : timing.cautiousAfterAction;
      await sleep(numberBetween(cautiousRange, random));
    }
  }

  function viewportSize() {
    const configured = page.viewportSize?.();
    if (configured?.width > 0 && configured?.height > 0) return configured;
    return { width: 1280, height: 720 };
  }

  async function humanWheel(deltaX, deltaY, requestedSteps) {
    const steps = Math.max(3, Math.min(12, Number(requestedSteps) || numberBetween([5, 9], random)));
    const xSegments = easedSegments(deltaX, steps, random);
    const ySegments = easedSegments(deltaY, steps, random);
    metrics.scrollGestures += 1;
    for (let index = 0; index < steps; index += 1) {
      throwIfAborted();
      await page.mouse.wheel(xSegments[index], ySegments[index]);
      metrics.wheelEvents += 1;
      if (index !== steps - 1) await sleep(numberBetween(timing.scrollPause, random));
    }
  }

  async function traverseToLocator(locator) {
    const viewport = viewportSize();
    let box = await locator.boundingBox?.();
    if (!box) {
      if (strictVisibleTraversal) {
        const error = new Error('Target has no measurable box for visible traversal');
        error.code = 'JOURNEY_TARGET_NOT_MEASURABLE';
        throw error;
      }
      return null;
    }
    for (let attempt = 0; attempt < 24; attempt += 1) {
      throwIfAborted();
      const centerY = box.y + box.height / 2;
      if (centerY >= 0 && centerY <= viewport.height) {
        metrics.visibleTargetAcquisitions += 1;
        return box;
      }
      const desiredY = viewport.height * (0.48 + (random() - 0.5) * 0.12);
      const rawDelta = centerY - desiredY;
      const maximumGesture = viewport.height * (0.56 + random() * 0.18);
      const deltaY = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), maximumGesture);
      if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 8) break;
      await humanWheel(0, deltaY);
      metrics.targetTraversals += 1;
      await sleep(numberBetween(timing.scrollGesturePause, random));
      if (Math.abs(deltaY) > viewport.height * 0.35 && random() < 0.22) {
        const correction = -Math.sign(deltaY) * numberBetween([18, 54], random);
        await humanWheel(0, correction, numberBetween([3, 5], random));
        metrics.pointerCorrections += 1;
        await sleep(numberBetween(timing.scrollPause, random));
      }
      const next = await locator.boundingBox?.();
      if (!next) break;
      box = next;
    }
    const centerY = box.y + box.height / 2;
    if (centerY >= 0 && centerY <= viewport.height) {
      metrics.visibleTargetAcquisitions += 1;
      return box;
    }
    const error = new Error('Target could not be reached through bounded visible scrolling');
    error.code = 'JOURNEY_TARGET_NOT_VISIBLE';
    throw error;
  }

  async function pointerPath(start, target, steps, { correction = false } = {}) {
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const distance = Math.hypot(dx, dy);
    const normal = distance > 0 ? { x: -dy / distance, y: dx / distance } : { x: 0, y: 0 };
    const curve = Math.min(100, Math.max(8, distance * 0.15)) * (random() * 2 - 1);
    const control1 = {
      x: start.x + dx * (0.28 + random() * 0.12) + normal.x * curve,
      y: start.y + dy * (0.28 + random() * 0.12) + normal.y * curve
    };
    const control2 = {
      x: start.x + dx * (0.68 + random() * 0.12) - normal.x * curve * 0.45,
      y: start.y + dy * (0.68 + random() * 0.12) - normal.y * curve * 0.45
    };
    const viewport = viewportSize();
    for (let index = 1; index <= steps; index += 1) {
      throwIfAborted();
      const linear = index / steps;
      const progress = linear * linear * (3 - 2 * linear);
      const inverse = 1 - progress;
      const x = inverse ** 3 * start.x + 3 * inverse ** 2 * progress * control1.x +
        3 * inverse * progress ** 2 * control2.x + progress ** 3 * target.x;
      const y = inverse ** 3 * start.y + 3 * inverse ** 2 * progress * control1.y +
        3 * inverse * progress ** 2 * control2.y + progress ** 3 * target.y;
      await page.mouse.move(
        Math.max(0, Math.min(viewport.width - 1, x)),
        Math.max(0, Math.min(viewport.height - 1, y))
      );
      metrics.pointerMoves += 1;
      if (correction) metrics.pointerCorrections += 1;
      if (index !== steps) await sleep(numberBetween(timing.mouseStepPause, random));
    }
  }

  async function moveToLocator(locator, requestedPosition) {
    const traversedBox = await traverseToLocator(locator);
    const box = await locator.boundingBox?.();
    if (
      !box ||
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0 ||
      typeof page.mouse?.move !== 'function'
    ) {
      if (strictVisibleTraversal) {
        const error = new Error('Target became unavailable after visible traversal');
        error.code = 'JOURNEY_TARGET_NOT_VISIBLE';
        throw error;
      }
      await locator.hover({ ...(requestedPosition ? { position: requestedPosition } : {}) });
      await sleep(numberBetween(timing.hoverPause, random));
      return requestedPosition || null;
    }

    const position = requestedPosition || {
      x: box.width * (0.3 + random() * 0.4),
      y: box.height * (0.3 + random() * 0.4)
    };
    const target = { x: box.x + position.x, y: box.y + position.y };
    if (!cursor) {
      const viewport = viewportSize();
      cursor = {
        x: viewport.width * (0.42 + random() * 0.16),
        y: viewport.height * (0.36 + random() * 0.18)
      };
    }
    const dx = target.x - cursor.x;
    const dy = target.y - cursor.y;
    const distance = Math.hypot(dx, dy);
    const steps = Math.max(numberBetween(timing.mouseSteps, random), Math.min(36, Math.round(distance / 28)));
    const start = cursor;
    if (distance > 140 && random() < 0.52) {
      const overshootDistance = Math.min(14, Math.max(4, distance * 0.025));
      const overshoot = {
        x: target.x + dx / distance * overshootDistance,
        y: target.y + dy / distance * overshootDistance
      };
      await pointerPath(start, overshoot, steps);
      await pointerPath(overshoot, target, numberBetween(timing.mouseCorrectionSteps, random), { correction: true });
    } else {
      await pointerPath(start, target, steps);
    }
    cursor = target;
    await sleep(numberBetween(timing.hoverPause, random));
    if (traversedBox && (Math.abs(traversedBox.x - box.x) > 2 || Math.abs(traversedBox.y - box.y) > 2)) {
      await sleep(numberBetween(timing.hoverPause, random));
    }
    return position;
  }

  async function humanClick(locator, options = {}) {
    const position = await moveToLocator(locator, options.position);
    const result = await locator.click({
      ...options,
      ...(position && options.position === undefined ? { position } : {}),
      ...(options.delay === undefined ? { delay: numberBetween(timing.clickDelay, random) } : {})
    });
    metrics.clicks += 1;
    return result;
  }

  async function enterText(locator, value, options) {
    const { delay: requestedDelay, ...fillOptions } = options;
    if (!usesHumanTiming()) return locator.fill(String(value), fillOptions);
    await humanClick(locator);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    let result;
    for (const character of Array.from(String(value))) {
      throwIfAborted();
      const delay = requestedDelay ?? numberBetween(timing.keyDelay, random);
      if (typeof locator.pressSequentially === 'function') {
        result = await locator.pressSequentially(character, { delay });
      } else {
        result = await locator.type(character, { delay });
      }
      metrics.typedCharacters += 1;
      if (/[,.;:!?，。！？；：、]/u.test(character)) await sleep(numberBetween(timing.punctuationPause, random));
      else if (/\s/u.test(character)) await sleep(numberBetween(timing.wordPause, random));
    }
    return result;
  }

  async function chooseSelectOption(locator, value, options) {
    if (!usesHumanTiming()) return locator.selectOption(value, options);
    const targetIndex = await locator.evaluate((select, requested) => {
      const first = Array.isArray(requested) ? requested[0] : requested;
      const requestedValue = typeof first === 'object' && first !== null
        ? first.value ?? first.label
        : first;
      return [...select.options].findIndex((option) => (
        option.value === String(requestedValue) || option.label === String(requestedValue)
      ));
    }, value);
    if (!Number.isSafeInteger(targetIndex) || targetIndex < 0) {
      const error = new Error('Requested select option is unavailable');
      error.code = 'JOURNEY_SELECT_OPTION_NOT_FOUND';
      throw error;
    }
    await humanClick(locator);
    await page.keyboard.press('Home');
    metrics.selectionKeyEvents += 1;
    for (let index = 0; index < targetIndex; index += 1) {
      await sleep(numberBetween(timing.selectionKeyPause, random));
      await page.keyboard.press('ArrowDown');
      metrics.selectionKeyEvents += 1;
    }
    await sleep(numberBetween(timing.selectionKeyPause, random));
    await page.keyboard.press('Enter');
    metrics.selectionKeyEvents += 1;
    return locator.inputValue?.();
  }

  function signal(kind) {
    if (mode !== 'adaptive') return null;
    const policy = ADAPTIVE_SIGNALS[kind];
    if (!policy) return adaptiveState();
    if (policy.level >= adaptiveLevel) adaptiveSignal = kind;
    adaptiveLevel = Math.max(adaptiveLevel, policy.level);
    adaptiveActionsRemaining = Math.max(adaptiveActionsRemaining, policy.actions);
    adaptiveGeneration += 1;
    const state = adaptiveState();
    Promise.resolve(onAdaptiveState(state)).catch(() => {});
    return state;
  }

  function adaptiveState() {
    return Object.freeze({
      level: adaptiveLevel,
      label: ADAPTIVE_LABELS[adaptiveLevel],
      actionsRemaining: adaptiveActionsRemaining,
      signal: adaptiveSignal
    });
  }

  function decayAdaptiveState(generationAtStart) {
    if (mode !== 'adaptive' || generationAtStart !== adaptiveGeneration || adaptiveActionsRemaining <= 0) return;
    adaptiveActionsRemaining -= 1;
    if (adaptiveActionsRemaining === 0) {
      adaptiveLevel = 0;
      adaptiveSignal = null;
    }
    Promise.resolve(onAdaptiveState(adaptiveState())).catch(() => {});
  }

  async function execute(operation, callback, effectOperation = operation) {
    throwIfAborted();
    const generationAtStart = adaptiveGeneration;
    const sequence = await onEffect({ state: 'started', operation: effectOperation });
    let result;
    try {
      await pause(timing.beforeAction);
      throwIfAborted();
      result = await callback();
      throwIfAborted();
      await pause(timing.afterAction);
      throwIfAborted();
      decayAdaptiveState(generationAtStart);
    } catch (cause) {
      // Playwright cannot prove that a failed click/navigation did not reach the
      // website. Keep the started record pending; a later attempt must inspect
      // real state and resolve the unknown outcome explicitly.
      if (mode === 'adaptive') {
        signal(adaptiveFailureSignal(cause));
      }
      if (!abortSignal?.aborted) {
        try {
          await onFailure({ operation, error: cause });
        } catch {
          // Diagnostic failure must not replace the original browser error.
        }
      }
      throw new BehaviorActionError(operation, cause);
    }
    // If this durable terminal write fails, the preceding `started` record stays
    // pending. That is deliberately safer than falsely recording a failed action
    // after its external effect may already have succeeded.
    await onEffect({ state: 'succeeded', operation: effectOperation, sequence });
    return result;
  }

  return Object.freeze({
    get mode() {
      return mode;
    },

    get effectiveMode() {
      if (usesHumanTiming()) return 'human';
      if (usesCautiousTiming()) return 'cautious';
      return 'fast';
    },

    get adaptiveState() {
      return adaptiveState();
    },

    get audit() {
      return Object.freeze({ ...metrics });
    },

    signal,

    async run(name, callback) {
      if (typeof callback !== 'function') throw new TypeError('action.run callback is required');
      return execute(name || 'custom', callback, 'custom');
    },

    async goto(url, options = {}) {
      return execute('goto', async () => {
        const response = await page.goto(url, options);
        metrics.navigations += 1;
        const status = response?.status?.();
        if (status === 429 || (status === 503 && response?.headers?.()['retry-after'])) signal('rate_limit');
        return response;
      });
    },

    async click(target, options = {}) {
      return execute('click', async () => {
        const locator = asLocator(page, target);
        if (usesHumanTiming()) return humanClick(locator, options);
        return locator.click(options);
      });
    },

    async fill(target, value, options = {}) {
      return execute('fill', () => enterText(asLocator(page, target), value, options));
    },

    async type(target, value, options = {}) {
      return execute('type', () => enterText(asLocator(page, target), value, options));
    },

    async hover(target, options = {}) {
      return execute('hover', async () => {
        const locator = asLocator(page, target);
        if (usesHumanTiming()) return moveToLocator(locator, options.position);
        return locator.hover(options);
      });
    },

    async select(target, value, options = {}) {
      return execute('select', () => chooseSelectOption(asLocator(page, target), value, options));
    },

    async scroll(input = {}) {
      const normalized = typeof input === 'number' ? { deltaY: input } : input;
      const deltaX = Number(normalized.deltaX ?? 0);
      const deltaY = Number(normalized.deltaY ?? 600);
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        throw new TypeError('scroll deltas must be finite numbers');
      }

      return execute('scroll', async () => {
        if (!usesHumanTiming()) return page.mouse.wheel(deltaX, deltaY);
        await humanWheel(deltaX, deltaY, normalized.steps);
      });
    },

    async read(input = {}) {
      const words = Number(typeof input === 'number' ? input : input.words ?? 0);
      if (!Number.isFinite(words) || words < 0) throw new TypeError('read words must be non-negative');
      if (!usesHumanTiming()) return 0;
      throwIfAborted();
      const duration = Math.min(
        timing.readingMaximum,
        numberBetween(timing.readingBase, random) + Math.round(words * numberBetween(timing.readingPerWord, random))
      );
      await sleep(duration);
      throwIfAborted();
      metrics.readingDwells += 1;
      metrics.readingDurationMs += duration;
      return duration;
    },

    async wait(milliseconds) {
      const duration = Number(milliseconds);
      if (!Number.isFinite(duration) || duration < 0) throw new TypeError('wait duration must be non-negative');
      await sleep(duration);
    }
  });
}
