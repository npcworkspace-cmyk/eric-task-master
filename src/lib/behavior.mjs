import { isBehaviorMode } from '../contracts.mjs';

const DEFAULT_HUMAN_TIMING = Object.freeze({
  beforeAction: [45, 140],
  afterAction: [55, 180],
  keyDelay: [25, 85],
  scrollPause: [70, 180]
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

  const throwIfAborted = () => {
    if (!abortSignal?.aborted) return;
    throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Task execution was aborted');
  };

  const usesHumanTiming = () => mode === 'human' || (mode === 'adaptive' && adaptiveSlowdown > 0);

  async function pause(range) {
    if (usesHumanTiming()) await sleep(numberBetween(range, random));
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
        if (usesHumanTiming()) {
          await locator.hover();
          await sleep(numberBetween(timing.beforeAction, random));
        }
        return locator.click(options);
      });
    },

    async fill(target, value, options = {}) {
      return execute('fill', async () => {
        const locator = asLocator(page, target);
        const { delay: _delay, ...fillOptions } = options;
        if (!usesHumanTiming()) return locator.fill(String(value), fillOptions);
        await locator.click();
        await locator.fill('');
        const keyDelay = options.delay ?? numberBetween(timing.keyDelay, random);
        if (typeof locator.pressSequentially === 'function') {
          return locator.pressSequentially(String(value), { delay: keyDelay });
        }
        return locator.type(String(value), { delay: keyDelay });
      });
    },

    async type(target, value, options = {}) {
      return execute('type', async () => {
        const locator = asLocator(page, target);
        const { delay: _delay, ...fillOptions } = options;
        if (!usesHumanTiming()) return locator.fill(String(value), fillOptions);
        await locator.click();
        await locator.fill('');
        const keyDelay = options.delay ?? numberBetween(timing.keyDelay, random);
        if (typeof locator.pressSequentially === 'function') {
          return locator.pressSequentially(String(value), { delay: keyDelay });
        }
        return locator.type(String(value), { delay: keyDelay });
      });
    },

    async hover(target, options = {}) {
      return execute('hover', () => asLocator(page, target).hover(options));
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
        let sentX = 0;
        let sentY = 0;
        for (let index = 0; index < steps; index += 1) {
          const stepX = index === steps - 1 ? deltaX - sentX : Math.round(deltaX / steps);
          const stepY = index === steps - 1 ? deltaY - sentY : Math.round(deltaY / steps);
          sentX += stepX;
          sentY += stepY;
          await page.mouse.wheel(stepX, stepY);
          if (index !== steps - 1) await sleep(numberBetween(timing.scrollPause, random));
        }
      });
    },

    async wait(milliseconds) {
      const duration = Number(milliseconds);
      if (!Number.isFinite(duration) || duration < 0) throw new TypeError('wait duration must be non-negative');
      await sleep(duration);
    }
  });
}
