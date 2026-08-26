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

const AUTO_SIGNALS = Object.freeze({
  dynamic: Object.freeze({ level: 1, actions: 2 }),
  action_failure: Object.freeze({ level: 2, actions: 4 }),
  occluded: Object.freeze({ level: 2, actions: 4 }),
  timeout: Object.freeze({ level: 2, actions: 4 }),
  navigation_unknown: Object.freeze({ level: 3, actions: 6 }),
  rate_limit: Object.freeze({ level: 3, actions: 6 })
});

const AUTO_LABELS = Object.freeze(['fast', 'cautious', 'guarded', 'cooldown']);
const PACING_SCALE = Object.freeze({ fast: 0.18, cautious: 0.52, human: 1 });

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

function autoFailureSignal(error) {
  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  if (text.includes('occlud') || text.includes('intercept')) return 'occluded';
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('navigation') || text.includes('target closed') || text.includes('context destroyed')) {
    return 'navigation_unknown';
  }
  return 'action_failure';
}

/**
 * Creates the task-scoped action facade used by task modules. Auto mode
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
  onAutoState = null,
  onAdaptiveState = () => {},
  onBehaviorState = () => {},
  timing = DEFAULT_HUMAN_TIMING,
  strictVisibleTraversal = false
} = {}) {
  if (!page) throw new TypeError('page is required');
  if (!isBehaviorMode(mode)) throw new TypeError(`Unsupported behavior mode: ${mode}`);

  let currentMode = mode;
  let autoLevel = 0;
  let autoActionsRemaining = 0;
  let autoSignal = null;
  let autoGeneration = 0;
  let cursor = null;
  const pacingWaiters = new Set();
  const autoStateListener = typeof onAutoState === 'function' ? onAutoState : onAdaptiveState;
  const metrics = {
    navigations: 0,
    clicks: 0,
    pointerMoves: 0,
    pointerCorrections: 0,
    visibleTargetAcquisitions: 0,
    typedCharacters: 0,
    selectionKeyEvents: 0,
    selectionFallbacks: 0,
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

  const effectiveMode = () => {
    if (currentMode === 'human') return 'human';
    if (currentMode === 'auto' && autoLevel >= 2) return 'human';
    if (currentMode === 'auto' && autoLevel === 1) return 'cautious';
    return 'fast';
  };
  const usesHumanMechanics = () => strictVisibleTraversal || effectiveMode() === 'human';

  function scaledRange(range, { minimum = 0 } = {}) {
    const scale = PACING_SCALE[effectiveMode()];
    return [
      Math.max(minimum, Math.round(range[0] * scale)),
      Math.max(minimum, Math.round(range[1] * scale))
    ];
  }

  function pacingNumber(range, options) {
    return numberBetween(scaledRange(range, options), random);
  }

  async function pacingSleep(milliseconds) {
    if (milliseconds <= 0) return false;
    let wake;
    const modeChanged = new Promise((resolve) => {
      wake = () => resolve(true);
      pacingWaiters.add(wake);
    });
    try {
      return await Promise.race([
        Promise.resolve(sleep(milliseconds)).then(() => false),
        modeChanged
      ]);
    } finally {
      pacingWaiters.delete(wake);
    }
  }

  function wakePacingWaiters() {
    for (const wake of pacingWaiters) wake();
    pacingWaiters.clear();
  }

  async function pause(range) {
    if (!usesHumanMechanics() && effectiveMode() === 'fast') return;
    await pacingSleep(pacingNumber(range));
  }

  function viewportSize() {
    const configured = page.viewportSize?.();
    if (configured?.width > 0 && configured?.height > 0) return configured;
    return { width: 1280, height: 720 };
  }

  async function humanWheel(deltaX, deltaY, requestedSteps) {
    const defaultSteps = pacingNumber([5, 9], { minimum: 3 });
    const steps = Math.max(
      3,
      Math.min(12, strictVisibleTraversal ? defaultSteps : Number(requestedSteps) || defaultSteps)
    );
    const xSegments = easedSegments(deltaX, steps, random);
    const ySegments = easedSegments(deltaY, steps, random);
    metrics.scrollGestures += 1;
    for (let index = 0; index < steps; index += 1) {
      throwIfAborted();
      await page.mouse.wheel(xSegments[index], ySegments[index]);
      metrics.wheelEvents += 1;
      if (index !== steps - 1) await pacingSleep(pacingNumber(timing.scrollPause));
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
      await pacingSleep(pacingNumber(timing.scrollGesturePause));
      if (Math.abs(deltaY) > viewport.height * 0.35 && random() < 0.22) {
        const correction = -Math.sign(deltaY) * numberBetween([18, 54], random);
        await humanWheel(0, correction, pacingNumber([3, 5], { minimum: 3 }));
        metrics.pointerCorrections += 1;
        await pacingSleep(pacingNumber(timing.scrollPause));
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
      if (index !== steps) await pacingSleep(pacingNumber(timing.mouseStepPause));
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
      await pacingSleep(pacingNumber(timing.hoverPause));
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
    const steps = Math.max(
      pacingNumber(timing.mouseSteps, { minimum: 6 }),
      Math.min(36, Math.round(distance / 28))
    );
    const start = cursor;
    if (distance > 140 && random() < 0.52) {
      const overshootDistance = Math.min(14, Math.max(4, distance * 0.025));
      const overshoot = {
        x: target.x + dx / distance * overshootDistance,
        y: target.y + dy / distance * overshootDistance
      };
      await pointerPath(start, overshoot, steps);
      await pointerPath(
        overshoot,
        target,
        pacingNumber(timing.mouseCorrectionSteps, { minimum: 2 }),
        { correction: true }
      );
    } else {
      await pointerPath(start, target, steps);
    }
    cursor = target;
    await pacingSleep(pacingNumber(timing.hoverPause));
    if (traversedBox && (Math.abs(traversedBox.x - box.x) > 2 || Math.abs(traversedBox.y - box.y) > 2)) {
      await pacingSleep(pacingNumber(timing.hoverPause));
    }
    return position;
  }

  async function humanClick(locator, options = {}) {
    const position = await moveToLocator(locator, options.position);
    const { delay: requestedDelay, ...clickOptions } = options;
    const result = await locator.click({
      ...clickOptions,
      ...(position && options.position === undefined ? { position } : {}),
      delay: strictVisibleTraversal || requestedDelay === undefined
        ? pacingNumber(timing.clickDelay)
        : requestedDelay
    });
    metrics.clicks += 1;
    return result;
  }

  async function enterText(locator, value, options) {
    const { delay: requestedDelay, ...fillOptions } = options;
    if (!usesHumanMechanics()) return locator.fill(String(value), fillOptions);
    await humanClick(locator);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    let result;
    for (const character of Array.from(String(value))) {
      throwIfAborted();
      const delay = strictVisibleTraversal || requestedDelay === undefined
        ? pacingNumber(timing.keyDelay)
        : requestedDelay;
      if (typeof locator.pressSequentially === 'function') {
        result = await locator.pressSequentially(character, { delay });
      } else {
        result = await locator.type(character, { delay });
      }
      metrics.typedCharacters += 1;
      if (/[,.;:!?，。！？；：、]/u.test(character)) await pacingSleep(pacingNumber(timing.punctuationPause));
      else if (/\s/u.test(character)) await pacingSleep(pacingNumber(timing.wordPause));
    }
    return result;
  }

  async function chooseSelectOption(locator, value, options) {
    if (!usesHumanMechanics()) return locator.selectOption(value, options);
    const selection = await locator.evaluate((select, requested) => {
      const first = Array.isArray(requested) ? requested[0] : requested;
      const requestedIndex = typeof first === 'object' && first !== null ? first.index : undefined;
      const requestedValue = typeof first === 'object' && first !== null ? first.value ?? first.label : first;
      const targetIndex = Number.isSafeInteger(requestedIndex)
        ? requestedIndex
        : [...select.options].findIndex((option) => (
          option.value === String(requestedValue) || option.label === String(requestedValue)
        ));
      return {
        currentIndex: select.selectedIndex,
        targetIndex,
        targetValue: targetIndex >= 0 && targetIndex < select.options.length
          ? select.options[targetIndex].value
          : null
      };
    }, value);
    if (!Number.isSafeInteger(selection?.targetIndex) || selection.targetIndex < 0 || selection.targetValue === null) {
      const error = new Error('Requested select option is unavailable');
      error.code = 'JOURNEY_SELECT_OPTION_NOT_FOUND';
      throw error;
    }
    await humanClick(locator);
    // Keep the popup opened by the real click. On macOS, the first arrow key on
    // a closed select only opens the popup and does not advance the highlight;
    // moving while it is already open keeps the relative index consistent.
    const direction = selection.targetIndex >= selection.currentIndex ? 'ArrowDown' : 'ArrowUp';
    const distance = Math.abs(selection.targetIndex - selection.currentIndex);
    for (let index = 0; index < distance; index += 1) {
      await pacingSleep(pacingNumber(timing.selectionKeyPause));
      // Do not refocus the locator here: on macOS the native picker owns the
      // active keyboard surface, and refocusing the DOM element closes it.
      await page.keyboard.press(direction);
      metrics.selectionKeyEvents += 1;
    }
    await pacingSleep(pacingNumber(timing.selectionKeyPause));
    await page.keyboard.press('Enter');
    metrics.selectionKeyEvents += 1;
    await pacingSleep(pacingNumber(timing.selectionKeyPause));
    await page.keyboard.press('Tab');
    metrics.selectionKeyEvents += 1;
    let actual = await locator.inputValue?.();
    if (actual !== selection.targetValue) {
      // Native select popups are owned by the host OS. Some headless macOS
      // Chromium builds accept the keyboard events without committing the DOM
      // value, so fall back once to Playwright's stable select primitive after
      // preserving the visible human journey above. Keep this observable.
      await locator.selectOption(value, options);
      metrics.selectionFallbacks += 1;
      actual = await locator.inputValue?.();
    }
    if (actual !== selection.targetValue) {
      const error = new Error('Requested select option was not applied by keyboard interaction or stable fallback');
      error.code = 'JOURNEY_SELECT_OPTION_UNCHANGED';
      throw error;
    }
    return actual;
  }

  function signal(kind) {
    if (currentMode !== 'auto') return null;
    const policy = AUTO_SIGNALS[kind];
    if (!policy) return autoState();
    if (policy.level >= autoLevel) autoSignal = kind;
    autoLevel = Math.max(autoLevel, policy.level);
    autoActionsRemaining = Math.max(autoActionsRemaining, policy.actions);
    autoGeneration += 1;
    const state = autoState();
    emitAutoState(state);
    return state;
  }

  function autoState() {
    return Object.freeze({
      level: autoLevel,
      label: AUTO_LABELS[autoLevel],
      actionsRemaining: autoActionsRemaining,
      signal: autoSignal
    });
  }

  function behaviorState() {
    return Object.freeze({
      configured: currentMode,
      effective: effectiveMode(),
      ...(currentMode === 'auto' ? { auto: autoState() } : {})
    });
  }

  function emitBehaviorState() {
    Promise.resolve().then(() => onBehaviorState(behaviorState())).catch(() => {});
  }

  function emitAutoState(state) {
    Promise.resolve().then(() => autoStateListener(state)).catch(() => {});
    emitBehaviorState();
  }

  function setMode(nextMode) {
    if (!isBehaviorMode(nextMode)) throw new TypeError(`Unsupported behavior mode: ${nextMode}`);
    if (nextMode !== currentMode) {
      currentMode = nextMode;
      autoLevel = 0;
      autoActionsRemaining = 0;
      autoSignal = null;
      autoGeneration += 1;
      wakePacingWaiters();
    }
    const state = behaviorState();
    Promise.resolve().then(() => onBehaviorState(state)).catch(() => {});
    return state;
  }

  function decayAutoState(generationAtStart) {
    if (currentMode !== 'auto' || generationAtStart !== autoGeneration || autoActionsRemaining <= 0) return;
    autoActionsRemaining -= 1;
    if (autoActionsRemaining === 0) {
      autoLevel = 0;
      autoSignal = null;
    }
    emitAutoState(autoState());
  }

  async function execute(operation, callback, effectOperation = operation) {
    throwIfAborted();
    const generationAtStart = autoGeneration;
    const sequence = await onEffect({ state: 'started', operation: effectOperation });
    let result;
    try {
      await pause(timing.beforeAction);
      throwIfAborted();
      result = await callback();
      throwIfAborted();
      await pause(timing.afterAction);
      throwIfAborted();
      decayAutoState(generationAtStart);
    } catch (cause) {
      // Playwright cannot prove that a failed click/navigation did not reach the
      // website. Keep the started record pending; a later attempt must inspect
      // real state and resolve the unknown outcome explicitly.
      if (currentMode === 'auto') {
        signal(autoFailureSignal(cause));
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
      return currentMode;
    },

    get effectiveMode() {
      return effectiveMode();
    },

    get autoState() {
      return autoState();
    },

    get adaptiveState() {
      return autoState();
    },

    get audit() {
      return Object.freeze({ ...metrics });
    },

    signal,
    setMode,

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
        if (usesHumanMechanics()) return humanClick(locator, options);
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
        if (usesHumanMechanics()) return moveToLocator(locator, options.position);
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
        if (!usesHumanMechanics()) return page.mouse.wheel(deltaX, deltaY);
        await humanWheel(deltaX, deltaY, normalized.steps);
      });
    },

    async read(input = {}) {
      const words = Number(typeof input === 'number' ? input : input.words ?? 0);
      if (!Number.isFinite(words) || words < 0) throw new TypeError('read words must be non-negative');
      if (!usesHumanMechanics()) return 0;
      throwIfAborted();
      const duration = Math.min(
        Math.max(1, Math.round(timing.readingMaximum * PACING_SCALE[effectiveMode()])),
        pacingNumber(timing.readingBase) + Math.round(words * pacingNumber(timing.readingPerWord))
      );
      const interrupted = await pacingSleep(duration);
      throwIfAborted();
      const appliedDuration = interrupted ? 0 : duration;
      if (appliedDuration > 0) metrics.readingDwells += 1;
      metrics.readingDurationMs += appliedDuration;
      return appliedDuration;
    },

    async wait(milliseconds) {
      const duration = Number(milliseconds);
      if (!Number.isFinite(duration) || duration < 0) throw new TypeError('wait duration must be non-negative');
      await sleep(duration);
    }
  });
}
