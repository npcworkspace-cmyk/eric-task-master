export const MAX_AGENT_IMAGE_BYTES = 48 * 1024;

const JPEG_QUALITY = 55;
const DOWNSCALE_ATTEMPTS = Object.freeze([
  { maxWidth: 800, maxHeight: 600, quality: 0.5 },
  { maxWidth: 640, maxHeight: 480, quality: 0.4 },
  { maxWidth: 480, maxHeight: 360, quality: 0.3 },
  { maxWidth: 360, maxHeight: 270, quality: 0.22 },
  { maxWidth: 256, maxHeight: 192, quality: 0.15 },
  { maxWidth: 160, maxHeight: 120, quality: 0.1 }
]);

function diagnosticImageError(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code: 'DIAGNOSTIC_IMAGE_UNAVAILABLE'
  });
}

/**
 * Capture one complete image that fits in the MCP artifact read ceiling.
 *
 * Playwright has no native resize option for screenshots. When a JPEG still
 * exceeds the ceiling, Chromium decodes and downsizes that already-captured
 * JPEG in a detached canvas. This preserves the complete visible viewport,
 * avoids native image dependencies, and never changes the live page DOM or
 * viewport.
 */
export async function captureBoundedDiagnosticImage(page, {
  maxBytes = MAX_AGENT_IMAGE_BYTES
} = {}) {
  if (!page || typeof page.screenshot !== 'function' || typeof page.evaluate !== 'function') {
    throw new TypeError('A Playwright page with screenshot and evaluate support is required');
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_AGENT_IMAGE_BYTES) {
    throw new TypeError(`maxBytes must be an integer between 1 and ${MAX_AGENT_IMAGE_BYTES}`);
  }

  let original;
  try {
    original = Buffer.from(await page.screenshot({
      type: 'jpeg',
      quality: JPEG_QUALITY,
      fullPage: false,
      animations: 'disabled',
      caret: 'hide'
    }));
  } catch (cause) {
    throw diagnosticImageError('The visible page could not be captured', cause);
  }
  if (original.length > 0 && original.length <= maxBytes) return original;

  let encoded;
  try {
    encoded = await page.evaluate(async ({ sourceBase64, attempts, byteLimit }) => {
      const binary = atob(sourceBase64);
      const sourceBytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        sourceBytes[index] = binary.charCodeAt(index);
      }
      const bitmap = await createImageBitmap(new Blob([sourceBytes], { type: 'image/jpeg' }));
      try {
        for (const attempt of attempts) {
          const scale = Math.min(
            1,
            attempt.maxWidth / bitmap.width,
            attempt.maxHeight / bitmap.height
          );
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(bitmap.width * scale));
          canvas.height = Math.max(1, Math.round(bitmap.height * scale));
          const context = canvas.getContext('2d', { alpha: false });
          if (!context) continue;
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', attempt.quality);
          const candidate = dataUrl.slice(dataUrl.indexOf(',') + 1);
          const padding = candidate.endsWith('==') ? 2 : candidate.endsWith('=') ? 1 : 0;
          const sizeBytes = Math.floor((candidate.length * 3) / 4) - padding;
          if (sizeBytes > 0 && sizeBytes <= byteLimit) return candidate;
        }
        return null;
      } finally {
        bitmap.close();
      }
    }, {
      sourceBase64: original.toString('base64'),
      attempts: DOWNSCALE_ATTEMPTS,
      byteLimit: maxBytes
    });
  } catch (cause) {
    throw diagnosticImageError('The diagnostic image could not be resized', cause);
  }

  if (typeof encoded !== 'string' || !encoded) {
    throw diagnosticImageError(`The diagnostic image could not fit within ${maxBytes} bytes`);
  }
  const bounded = Buffer.from(encoded, 'base64');
  if (bounded.length < 4 || bounded.length > maxBytes || bounded[0] !== 0xff || bounded[1] !== 0xd8) {
    throw diagnosticImageError('The resized diagnostic image was invalid');
  }
  return bounded;
}
