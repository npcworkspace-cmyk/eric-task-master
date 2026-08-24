import { isBehaviorMode } from '../contracts.mjs';

const DEFAULT_HUMAN_TIMING = Object.freeze({
  beforeAction: [45, 140],
  afterAction: [55, 180],
  hoverPause: [70, 180],
  clickDelay: [35, 95],
  mouseSteps: [8, 16],
  keyDelay: [25, 85],
  wordPause: [30, 90],
  punctuationPause: [120, 320],
  scrollPause: [70, 180],
  readingBase: [350, 700],
  readingPerWord: [90, 160],
  readingMaximum: 8_000
});

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

/**
 * Creates the task-scoped action facade used by task modules. Adaptive mode is
 * fast until the caller reports a dynamic-page or rate-limit signal, or an
 * action fails. It never retries an unknown action outcome automatically.
 */
export function createActionHelper({
  page,
  mode = 'fast',
  random = Math.random,
  sleep = defaultSleep,
  abortSignal,
  onFailure = async () => {},
  onEffect = async () => undefined,
  timing = DEFAULT_HUMAN_TIMING
} = {}) {
  if (!page) throw new TypeError('page is required');
  if (!isBehaviorMode(mode)) throw new TypeError(`Unsupported behavior mode: ${mode}`);

  let adaptiveSlowdown = 0;
  let cursor = { x: 0, y: 0 };

  const throwIfAborted = () => {
    if (!abortSignal?.aborted) return;
    throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Task execution was aborted');
  };

  const usesHumanTiming = () => mode === 'human' || (mode === 'adaptive' && adaptiveSlowdown > 0);

  async function pause(range) {
    if (usesHumanTiming()) await sleep(numberBetween(range, random));
  }

  async function moveToLocator(locator, requestedPosition) {
    await locator.scrollIntoViewIfNeeded?.();
    const box = await locator.boundingBox?.();
    if (
      !box ||
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0 ||
      typeof page.mouse?.move !== 'function'
    ) {
      await locator.hover({ ...(requestedPosition ? { position: requestedPosition } : {}) });
      await sleep(numberBetween(timing.hoverPause, random));
      return requestedPosition || null;
    }

    const position = requestedPosition || {
      x: box.width * (0.3 + random() * 0.4),
      y: box.height * (0.3 + random() * 0.4)
    };
    const target = { x: box.x + position.x, y: box.y + position.y };
    const dx = target.x - cursor.x;
    const dy = target.y - cursor.y;
    const distance = Math.hypot(dx, dy);
    const curve = Math.min(80, Math.max(6, distance * 0.12)) * (random() * 2 - 1);
    const control = distance > 0 ? {
      x: cursor.x + dx / 2 - dy / distance * curve,
      y: cursor.y + dy / 2 + dx / distance * curve
    } : cursor;
    const steps = numberBetween(timing.mouseSteps, random);
    const start = cursor;
    const viewport = page.viewportSize?.();
    const maximumX = viewport?.width ? viewport.width - 1 : Number.POSITIVE_INFINITY;
    const maximumY = viewport?.height ? viewport.height - 1 : Number.POSITIVE_INFINITY;
    for (let index = 1; index <= steps; index += 1) {
      throwIfAborted();
      const progress = index / steps;
      const inverse = 1 - progress;
      await page.mouse.move(
        Math.max(0, Math.min(maximumX,
          inverse * inverse * start.x + 2 * inverse * progress * control.x + progress * progress * target.x)),
        Math.max(0, Math.min(maximumY,
          inverse * inverse * start.y + 2 * inverse * progress * control.y + progress * progress * target.y))
      );
    }
    cursor = target;
    await sleep(numberBetween(timing.hoverPause, random));
    return position;
  }

  async function humanClick(locator, options = {}) {
    const position = await moveToLocator(locator, options.position);
    return locator.click({
      ...options,
      ...(position && options.position === undefined ? { position } : {}),
      ...(options.delay === undefined ? { delay: numberBetween(timing.clickDelay, random) } : {})
    });
  }

  async function enterText(locator, value, options) {
    const { delay: requestedDelay, ...fillOptions } = options;
    if (!usesHumanTiming()) return locator.fill(String(value), fillOptions);
    await humanClick(locator);
    await locator.fill('');
    let result;
    for (const character of Array.from(String(value))) {
      throwIfAborted();
      const delay = requestedDelay ?? numberBetween(timing.keyDelay, random);
      if (typeof locator.pressSequentially === 'function') {
        result = await locator.pressSequentially(character, { delay });
      } else {
        result = await locator.type(character, { delay });
      }
      if (/[,.;:!?，。！？；：、]/u.test(character)) await sleep(numberBetween(timing.punctuationPause, random));
      else if (/\s/u.test(character)) await sleep(numberBetween(timing.wordPause, random));
    }
    return result;
  }

  function signal(kind) {
    if (mode !== 'adaptive') return;
    if (['dynamic', 'rate_limit', 'timeout', 'occluded', 'navigation_unknown'].includes(kind)) {
      adaptiveSlowdown = Math.max(adaptiveSlowdown, kind === 'rate_limit' ? 8 : 3);
    }
  }

  async function execute(operation, callback, effectOperation = operation) {
    throwIfAborted();
    const sequence = await onEffect({ state: 'started', operation: effectOperation });
    let result;
    try {
      await pause(timing.beforeAction);
      throwIfAborted();
      result = await callback();
      throwIfAborted();
      await pause(timing.afterAction);
      throwIfAborted();
      if (mode === 'adaptive' && adaptiveSlowdown > 0) adaptiveSlowdown -= 1;
    } catch (cause) {
      // Playwright cannot prove that a failed click/navigation did not reach the
      // website. Keep the started record pending; a later attempt must inspect
      // real state and resolve the unknown outcome explicitly.
      if (mode === 'adaptive') adaptiveSlowdown = Math.max(adaptiveSlowdown, 3);
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
      return usesHumanTiming() ? 'human' : 'fast';
    },

    signal,

    async run(name, callback) {
      if (typeof callback !== 'function') throw new TypeError('action.run callback is required');
      return execute(name || 'custom', callback, 'custom');
    },

    async goto(url, options = {}) {
      return execute('goto', async () => {
        const response = await page.goto(url, options);
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

    async scroll(input = {}) {
      const normalized = typeof input === 'number' ? { deltaY: input } : input;
      const deltaX = Number(normalized.deltaX ?? 0);
      const deltaY = Number(normalized.deltaY ?? 600);
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        throw new TypeError('scroll deltas must be finite numbers');
      }

      return execute('scroll', async () => {
        if (!usesHumanTiming()) return page.mouse.wheel(deltaX, deltaY);
        const steps = Math.max(2, Math.min(8, Number(normalized.steps) || numberBetween([3, 6], random)));
        const xSegments = easedSegments(deltaX, steps, random);
        const ySegments = easedSegments(deltaY, steps, random);
        for (let index = 0; index < steps; index += 1) {
          throwIfAborted();
          await page.mouse.wheel(xSegments[index], ySegments[index]);
          if (index !== steps - 1) await sleep(numberBetween(timing.scrollPause, random));
        }
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
      return duration;
    },

    async wait(milliseconds) {
      const duration = Number(milliseconds);
      if (!Number.isFinite(duration) || duration < 0) throw new TypeError('wait duration must be non-negative');
      await sleep(duration);
    }
  });
}
