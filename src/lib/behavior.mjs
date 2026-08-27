import { isBehaviorMode } from '../contracts.mjs';

const DEFAULT_HUMAN_TIMING = Object.freeze({
  cautiousBeforeAction: [15, 45],
  cautiousAfterAction: [25, 75],
  beforeAction: [30, 105],
  afterAction: [35, 130],
  hoverPause: [55, 155],
  clickDelay: [38, 105],
  mouseSteps: [16, 32],
  mouseStepPause: [2, 6],
  mouseCorrectionSteps: [4, 8],
  keyDelay: [30, 92],
  typingBurstPause: [18, 58],
  selectionKeyPause: [35, 95],
  wordPause: [24, 72],
  punctuationPause: [90, 220],
  // Segment waits are frame-like. Deliberate pauses belong between gestures,
  // never between large, visibly separated wheel chunks.
  scrollPause: [2, 7],
  scrollGesturePause: [35, 95],
  readingBase: [320, 650],
  readingPerWord: [28, 65],
  readingMaximum: 7_500
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
const PACING_SCALE = Object.freeze({ fast: 0.22, cautious: 0.55, human: 1 });

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

function minimumJerk(progress) {
  const value = Math.max(0, Math.min(1, progress));
  return 10 * value ** 3 - 15 * value ** 4 + 6 * value ** 5;
}

function motionSegments(total, steps, random) {
  let priorSample = 0;
  let priorProgress = 0;
  let sent = 0;
  return Array.from({ length: steps }, (_, index) => {
    if (index === steps - 1) return total - sent;
    const linear = (index + 1) / steps;
    const boundedJitter = (random() - 0.5) * 0.12 / steps;
    const sample = Math.max(priorSample + 0.0001, Math.min(0.9999, linear + boundedJitter));
    const progress = minimumJerk(sample);
    const value = Math.round(total * (progress - priorProgress));
    priorSample = sample;
    priorProgress = progress;
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
 * Creates the task-scoped action facade used by task modules. Every mode uses
 * the same visible action mechanics; modes change only the central pacing and
 * guard depth. Auto adds short settling pauses for ordinary dynamic-page
 * signals and full human pacing after stronger ambiguity or rate-limit signals.
 * It never retries an unknown action outcome automatically.
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
    pointerDistancePx: 0,
    pointerPeakStepPx: 0,
    visibleTargetAcquisitions: 0,
    typedCharacters: 0,
    keyboardEvents: 0,
    typingCadencePauses: 0,
    typingBursts: 0,
    selectionKeyEvents: 0,
    selectionFallbacks: 0,
    scrollGestures: 0,
    wheelEvents: 0,
    scrollDistancePx: 0,
    scrollDirectionChanges: 0,
    targetTraversals: 0,
    pageSurveys: 0,
    surveysNeedingScroll: 0,
    surveyBacktracks: 0,
    surveyReachedBottom: 0,
    readingDwells: 0,
    readingDurationMs: 0
  };
  let lastScrollDirection = 0;

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
    await pacingSleep(pacingNumber(range));
  }

  function viewportSize() {
    const configured = page.viewportSize?.();
    if (configured?.width > 0 && configured?.height > 0) return configured;
    return { width: 1280, height: 720 };
  }

  async function humanWheel(deltaX, deltaY, requestedSteps) {
    const distance = Math.hypot(deltaX, deltaY);
    const defaultSteps = Math.round(10 + Math.min(18, Math.sqrt(distance) * 0.45));
    const steps = Math.max(
      8,
      Math.min(32, strictVisibleTraversal ? defaultSteps : Number(requestedSteps) || defaultSteps)
    );
    const xSegments = motionSegments(deltaX, steps, random);
    const ySegments = motionSegments(deltaY, steps, random);
    const direction = Math.sign(deltaY || deltaX);
    if (lastScrollDirection && direction && direction !== lastScrollDirection) metrics.scrollDirectionChanges += 1;
    if (direction) lastScrollDirection = direction;
    metrics.scrollGestures += 1;
    for (let index = 0; index < steps; index += 1) {
      throwIfAborted();
      await page.mouse.wheel(xSegments[index], ySegments[index]);
      metrics.wheelEvents += 1;
      metrics.scrollDistancePx += Math.hypot(xSegments[index], ySegments[index]);
      if (index !== steps - 1) {
        await pacingSleep(pacingNumber(timing.scrollPause, { minimum: effectiveMode() === 'human' ? 4 : 2 }));
      }
    }
  }

  async function traverseToLocator(locator, measurementOptions = {}) {
    const viewport = viewportSize();
    let box = await locator.boundingBox?.(measurementOptions);
    if (!box) {
      if (strictVisibleTraversal) {
        const error = new Error('Target has no measurable box for visible traversal');
        error.code = 'JOURNEY_TARGET_NOT_MEASURABLE';
        throw error;
      }
      return null;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      throwIfAborted();
      const centerY = box.y + box.height / 2;
      const acquisitionTop = strictVisibleTraversal ? viewport.height * 0.16 : 0;
      const acquisitionBottom = strictVisibleTraversal ? viewport.height * 0.84 : viewport.height;
      if (centerY >= acquisitionTop && centerY <= acquisitionBottom) {
        metrics.visibleTargetAcquisitions += 1;
        return box;
      }
      const below = centerY > acquisitionBottom;
      const desiredY = viewport.height * (below
        ? 0.62 + random() * 0.08
        : 0.30 + random() * 0.08);
      const rawDelta = centerY - desiredY;
      const far = Math.abs(rawDelta) > viewport.height * 1.75;
      // A far rendered target is one continuous approach, not a staircase of
      // viewport-sized gestures. Fine wheel events still supply the natural
      // acceleration/deceleration inside that single gesture.
      const maximumGesture = far
        ? Math.abs(rawDelta)
        : viewport.height * (0.70 + random() * 0.45);
      const deltaY = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), maximumGesture);
      if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 8) break;
      await humanWheel(0, deltaY);
      metrics.targetTraversals += 1;
      await pacingSleep(pacingNumber(timing.scrollGesturePause, { minimum: 8 }));
      const next = await locator.boundingBox?.(measurementOptions);
      if (!next) break;
      const nextCenterY = next.y + next.height / 2;
      if (
        nextCenterY >= 0 && nextCenterY <= viewport.height &&
        Math.abs(nextCenterY - centerY) < 2
      ) {
        // A document boundary can prevent a visible footer target from being
        // centered any further. Clicking the already visible control is safer
        // than issuing twenty ineffective wheel gestures.
        metrics.visibleTargetAcquisitions += 1;
        return next;
      }
      box = next;
    }
    const centerY = box.y + box.height / 2;
    if (centerY >= viewport.height * 0.12 && centerY <= viewport.height * 0.88) {
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
    let priorPoint = start;
    for (let index = 1; index <= steps; index += 1) {
      throwIfAborted();
      const linear = index / steps;
      const progress = minimumJerk(linear);
      const inverse = 1 - progress;
      const x = inverse ** 3 * start.x + 3 * inverse ** 2 * progress * control1.x +
        3 * inverse * progress ** 2 * control2.x + progress ** 3 * target.x;
      const y = inverse ** 3 * start.y + 3 * inverse ** 2 * progress * control1.y +
        3 * inverse * progress ** 2 * control2.y + progress ** 3 * target.y;
      const point = {
        x: Math.max(0, Math.min(viewport.width - 1, x)),
        y: Math.max(0, Math.min(viewport.height - 1, y))
      };
      await page.mouse.move(point.x, point.y);
      const stepDistance = Math.hypot(point.x - priorPoint.x, point.y - priorPoint.y);
      metrics.pointerDistancePx += stepDistance;
      metrics.pointerPeakStepPx = Math.max(metrics.pointerPeakStepPx, stepDistance);
      priorPoint = point;
      metrics.pointerMoves += 1;
      if (correction) metrics.pointerCorrections += 1;
      if (index !== steps) {
        await pacingSleep(pacingNumber(timing.mouseStepPause, { minimum: effectiveMode() === 'human' ? 3 : 2 }));
      }
    }
  }

  async function moveToLocator(locator, requestedPosition, actionOptions = {}) {
    const measurementOptions = Number.isFinite(actionOptions?.timeout) && actionOptions.timeout >= 0
      ? { timeout: actionOptions.timeout }
      : {};
    const traversedBox = await traverseToLocator(locator, measurementOptions);
    const box = await locator.boundingBox?.(measurementOptions);
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
      await locator.hover({ ...measurementOptions, ...(requestedPosition ? { position: requestedPosition } : {}) });
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
    const targetWidth = Math.max(8, Math.min(box.width, box.height));
    const difficulty = Math.log2(distance / targetWidth + 1);
    const adaptiveSteps = Math.round(9 + difficulty * 4.5 + Math.min(7, distance / 160));
    const steps = Math.max(numberBetween(timing.mouseSteps, random), Math.min(48, adaptiveSteps));
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
        numberBetween(timing.mouseCorrectionSteps, random),
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
    const position = await moveToLocator(locator, options.position, options);
    // The Profile mode is authoritative over physical pacing. A task may still
    // provide Playwright click semantics, but cannot bypass central timing.
    const { delay: _requestedDelay, ...clickOptions } = options;
    const result = await locator.click({
      ...clickOptions,
      ...(position && options.position === undefined ? { position } : {}),
      delay: pacingNumber(timing.clickDelay)
    });
    metrics.clicks += 1;
    return result;
  }

  async function enterText(locator, value, options) {
    await humanClick(locator, Number.isFinite(options?.timeout) ? { timeout: options.timeout } : {});
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    let result;
    const characters = Array.from(String(value));
    let burstRemaining = numberBetween([3, 7], random);
    metrics.typingBursts += characters.length > 0 ? 1 : 0;
    for (const [index, character] of characters.entries()) {
      throwIfAborted();
      const delay = pacingNumber(timing.keyDelay, { minimum: 12 });
      if (typeof locator.pressSequentially === 'function') {
        result = await locator.pressSequentially(character, { delay: 0 });
      } else {
        result = await locator.type(character, { delay: 0 });
      }
      metrics.typedCharacters += 1;
      metrics.keyboardEvents += 1;
      const isLast = index === characters.length - 1;
      if (!isLast) {
        await pacingSleep(delay);
        metrics.typingCadencePauses += 1;
      }
      if (/[,.;:!?，。！？；：、]/u.test(character)) {
        await pacingSleep(pacingNumber(timing.punctuationPause));
      } else if (/\s/u.test(character)) {
        await pacingSleep(pacingNumber(timing.wordPause));
      } else if (!isLast && --burstRemaining === 0) {
        await pacingSleep(pacingNumber(timing.typingBurstPause ?? DEFAULT_HUMAN_TIMING.typingBurstPause));
        metrics.typingCadencePauses += 1;
        metrics.typingBursts += 1;
        burstRemaining = numberBetween([3, 7], random);
      }
    }
    return result;
  }

  async function readScrollState() {
    return page.evaluate(() => {
      const root = document.scrollingElement || document.documentElement;
      const height = Math.max(
        root?.scrollHeight || 0,
        document.body?.scrollHeight || 0,
        document.documentElement?.scrollHeight || 0
      );
      return {
        scrollY: Math.max(0, window.scrollY || root?.scrollTop || 0),
        maxScroll: Math.max(0, height - window.innerHeight),
        viewportHeight: Math.max(1, window.innerHeight)
      };
    });
  }

  async function surveyPage(options = {}) {
    const maxGestures = Number(options.maxGestures ?? 8);
    if (!Number.isSafeInteger(maxGestures) || maxGestures < 1 || maxGestures > 24) {
      throw new TypeError('survey maxGestures must be an integer from 1 to 24');
    }
    const start = await readScrollState();
    metrics.pageSurveys += 1;
    const needsScroll = start.maxScroll - start.scrollY > start.viewportHeight * 0.35;
    if (needsScroll) metrics.surveysNeedingScroll += 1;
    let state = start;
    let gestures = 0;
    // A normal static document uses one continuous downward wheel stream. One
    // immediate continuation is retained only for a page that grows or does
    // not consume the full first gesture; this avoids visible stop-start loops.
    const maximumPasses = Math.min(maxGestures, 2);
    while (gestures < maximumPasses && state.scrollY < state.maxScroll - Math.max(8, state.viewportHeight * 0.04)) {
      const remaining = state.maxScroll - state.scrollY;
      const before = state;
      await humanWheel(0, remaining);
      gestures += 1;
      const next = await readScrollState();
      state = next;
      if (next.scrollY <= before.scrollY + 1) break;
    }
    const reachedBottom = state.scrollY >= state.maxScroll - Math.max(8, state.viewportHeight * 0.06);
    if (reachedBottom) metrics.surveyReachedBottom += 1;
    let backtracked = false;
    if (needsScroll && state.scrollY - start.scrollY > state.viewportHeight * 0.4) {
      const beforeBacktrackY = state.scrollY;
      const backtrackDistance = Math.min(
        state.scrollY - start.scrollY,
        state.viewportHeight * (0.72 + random() * 0.46)
      );
      await pacingSleep(pacingNumber(timing.scrollGesturePause, { minimum: 8 }));
      await humanWheel(0, -backtrackDistance);
      state = await readScrollState();
      backtracked = state.scrollY < beforeBacktrackY - 1;
      if (backtracked) metrics.surveyBacktracks += 1;
    }
    return Object.freeze({
      startY: start.scrollY,
      endY: state.scrollY,
      maxScroll: state.maxScroll,
      gestures,
      reachedBottom,
      backtracked
    });
  }

  async function chooseSelectOption(locator, value, options) {
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
    await humanClick(locator, Number.isFinite(options?.timeout) ? { timeout: options.timeout } : {});
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
        return humanClick(locator, options);
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
        return moveToLocator(locator, options.position, options);
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
        await humanWheel(deltaX, deltaY, normalized.steps);
      });
    },

    async survey(options = {}) {
      return execute('survey', () => surveyPage(options));
    },

    async read(input = {}) {
      const words = Number(typeof input === 'number' ? input : input.words ?? 0);
      if (!Number.isFinite(words) || words < 0) throw new TypeError('read words must be non-negative');
      throwIfAborted();
      let duration;
      let interrupted;
      do {
        duration = Math.min(
          Math.max(1, Math.round(timing.readingMaximum * PACING_SCALE[effectiveMode()])),
          pacingNumber(timing.readingBase) + Math.round(words * pacingNumber(timing.readingPerWord))
        );
        interrupted = await pacingSleep(duration);
        throwIfAborted();
      } while (interrupted);
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
