/**
 * Shared capture-first screenshot preparation for the operator forms (mechanic
 * rework and platform development intake).
 *
 * An operator attaches whatever the phone gallery hands over — an unedited
 * full-resolution screenshot, HEIC/WebP included. The file never leaves the
 * device as a file: it is decoded locally, downscaled to SCREENSHOT_MAX_EDGE
 * and re-encoded as JPEG until the resulting data URL fits the request wire
 * budget, so the durable request stays one bounded inline value with no upload
 * endpoint behind it.
 *
 * The caller owns its own error code so each form keeps its exact typed
 * failure vocabulary; everything else here is identical by construction.
 */
export const SCREENSHOT_DATA_URL_LIMIT = 500_000;
export const SCREENSHOT_PASSTHROUGH_BYTES = 370_000;
export const SCREENSHOT_MAX_EDGE = 1_600;
const SCREENSHOT_INPUT_BYTES_LIMIT = 30_000_000;
const SCREENSHOT_INPUT_PIXELS_LIMIT = 16_000_000;
const SCREENSHOT_MIN_EDGE = 320;
const SCREENSHOT_JPEG_QUALITIES = [0.86, 0.76, 0.66, 0.56, 0.46];
const SCREENSHOT_DECODE_TIMEOUT_MS = 15_000;

const screenshotFailure = (message, code) => Object.assign(new Error(message), { code });

function readFileAsDataUrl(file, code) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(screenshotFailure('screenshot could not be read', code));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

async function encodedImageDimensions(file) {
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 262_144)).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes.slice(0, 8).every((value, index) => (
    value === [137, 80, 78, 71, 13, 10, 26, 10][index]
  ))) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X') {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    }
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 <= bytes.length) {
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
  }
  return null;
}

function decodeScreenshot(file, dimensions, code) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanup = () => {};
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const failDecode = () => finish(() => {
      cleanup();
      reject(screenshotFailure('screenshot could not be decoded', code));
    });
    const timeout = setTimeout(failDecode, SCREENSHOT_DECODE_TIMEOUT_MS);
    if (typeof createImageBitmap === 'function') {
      const resize = Math.max(dimensions.width, dimensions.height) <= SCREENSHOT_MAX_EDGE
        ? {}
        : dimensions.width >= dimensions.height
          ? { resizeWidth: SCREENSHOT_MAX_EDGE, resizeQuality: 'high' }
          : { resizeHeight: SCREENSHOT_MAX_EDGE, resizeQuality: 'high' };
      createImageBitmap(file, resize)
        .then((image) => {
          if (settled) {
            image.close();
            return;
          }
          finish(() => resolve({
            image,
            release: () => image.close(),
            width: image.width,
            height: image.height,
          }));
        }, failDecode);
      return;
    }
    const url = URL.createObjectURL(file);
    cleanup = () => URL.revokeObjectURL(url);
    const image = new Image();
    image.onload = () => finish(() => resolve({
      image,
      release: cleanup,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    image.onerror = failDecode;
    image.src = url;
  });
}

function canvasJpeg(canvas, quality, code) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob || blob.type !== 'image/jpeg') {
      reject(screenshotFailure('screenshot could not be encoded', code));
      return;
    }
    resolve(blob);
  }, 'image/jpeg', quality));
}

async function normalizedScreenshotDataUrl(image, sourceWidth, sourceHeight, code) {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)
    || sourceWidth < 1 || sourceHeight < 1) {
    throw screenshotFailure('screenshot dimensions are invalid', code);
  }
  const canvas = document.createElement('canvas');
  let scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  while (true) {
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) break;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of SCREENSHOT_JPEG_QUALITIES) {
      const blob = await canvasJpeg(canvas, quality, code);
      if (blob.size <= SCREENSHOT_PASSTHROUGH_BYTES) {
        const dataUrl = await readFileAsDataUrl(blob, code);
        if (dataUrl.length <= SCREENSHOT_DATA_URL_LIMIT) return dataUrl;
      }
    }
    if (Math.min(canvas.width, canvas.height) <= SCREENSHOT_MIN_EDGE) break;
    scale *= 0.78;
  }
  throw screenshotFailure('screenshot could not be normalized', code);
}

/**
 * Resolve one attached file into the frozen ScreenshotV1 wire value shared by
 * both operator request schemas. `code` is the caller's typed failure code.
 */
export async function prepareScreenshotFromFile(file, code) {
  if (!file) return Object.freeze({
    kind: 'unavailable', reason: 'not_attached', mimeType: null, dataUrl: null,
  });
  const mimeType = String(file.type || '');
  if (file.size > SCREENSHOT_INPUT_BYTES_LIMIT
    || (mimeType && mimeType !== 'application/octet-stream' && !mimeType.startsWith('image/'))) {
    throw screenshotFailure('screenshot must be an image', code);
  }
  if (['image/jpeg', 'image/png'].includes(mimeType) && file.size <= SCREENSHOT_PASSTHROUGH_BYTES) {
    const dataUrl = await readFileAsDataUrl(file, code);
    if (dataUrl.length <= SCREENSHOT_DATA_URL_LIMIT) {
      return Object.freeze({ kind: 'data_url', reason: null, mimeType, dataUrl });
    }
  }
  try {
    const dimensions = await encodedImageDimensions(file);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1
      || dimensions.width * dimensions.height > SCREENSHOT_INPUT_PIXELS_LIMIT) {
      throw screenshotFailure('screenshot dimensions are unsupported', code);
    }
    const decoded = await decodeScreenshot(file, dimensions, code);
    try {
      const dataUrl = await normalizedScreenshotDataUrl(
        decoded.image,
        decoded.width,
        decoded.height,
        code,
      );
      return Object.freeze({ kind: 'data_url', reason: null, mimeType: 'image/jpeg', dataUrl });
    } finally {
      decoded.release();
    }
  } catch (error) {
    if (error?.code === code) throw error;
    throw screenshotFailure('screenshot could not be processed', code);
  }
}

export const formatScreenshotBytes = (value) => (value < 1_000_000
  ? `${Math.max(1, Math.round(value / 1_000))} КБ`
  : `${(value / 1_000_000).toFixed(1)} МБ`);

/** Preview caption for the attached file; nothing is sent until submit. */
export function screenshotSelectionLabel(file) {
  if (!file) return '';
  const prepared = file.size > SCREENSHOT_PASSTHROUGH_BYTES ? ' · подготовим автоматически' : '';
  return `${file.name || 'Скриншот'} · ${formatScreenshotBytes(file.size)}${prepared}`;
}

/**
 * Markup for the shared preview + remove-before-submit row. `hook` names the
 * form's data attributes so each control keeps its own stable DOM contract.
 */
export function screenshotSelectionMarkup(hook) {
  return `<div class="game__operator-playable-rework-screenshot" data-${hook}-screenshot hidden>
        <span data-${hook}-screenshot-name></span>
        <button type="button" data-action="remove-screenshot">Удалить</button>
      </div>`;
}
