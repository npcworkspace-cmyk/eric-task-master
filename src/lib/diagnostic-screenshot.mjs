export const MAX_AGENT_IMAGE_BYTES = 48 * 1024;

const JPEG_QUALITIES = Object.freeze([55, 35, 20, 12, 7, 3, 1, 0]);

function diagnosticImageError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'DIAGNOSTIC_IMAGE_UNAVAILABLE'
  });
}

/**
 * Capture one complete image that fits in the MCP artifact read ceiling.
 *
 * Capture quality is reduced without evaluating JavaScript in the inspected
 * page. Animations and caret state remain untouched, so diagnostics do not
 * fast-forward CSS animations, dispatch animation events, or mutate the DOM.
 */
export async function captureBoundedDiagnosticImage(page, {
  maxBytes = MAX_AGENT_IMAGE_BYTES
} = {}) {
  if (!page || typeof page.screenshot !== 'function') {
    throw new TypeError('A Playwright page with screenshot support is required');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_AGENT_IMAGE_BYTES) {
    throw new TypeError(`maxBytes must be an integer between 1 and ${MAX_AGENT_IMAGE_BYTES}`);
  }

  for (const quality of JPEG_QUALITIES) {
    let candidate;
    try {
      candidate = Buffer.from(await page.screenshot({
        type: 'jpeg',
        quality,
        fullPage: false,
        animations: 'allow',
        caret: 'initial'
      }));
    } catch (cause) {
      throw diagnosticImageError('The visible page could not be captured', cause);
    }
    if (
      candidate.length >= 4 && candidate.length <= maxBytes &&
      candidate[0] === 0xff && candidate[1] === 0xd8
    ) return candidate;
  }
  throw diagnosticImageError(`The diagnostic image could not fit within ${maxBytes} bytes`);
}
