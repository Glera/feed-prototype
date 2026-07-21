const HASH = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const CAPTURE_CONTRACTS = new Set([
  'sort.generated-preview.v1',
  'catalog.runtime-cover.v1',
]);

export class CatalogGeneratedPreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogGeneratedPreviewError';
    this.code = code;
  }
}

function fail(code, message) { throw new CatalogGeneratedPreviewError(code, message); }
function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exact(value, keys) {
  return plain(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
function baseUrl(value) {
  let parsed;
  try { parsed = new URL(value, globalThis.location?.href ?? 'https://invalid.local/'); }
  catch { fail('invalid_preview', 'generated preview base URL is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    fail('invalid_preview', 'generated preview base URL must be credential-free HTTP(S)');
  }
  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/';
  return parsed;
}
function manifestUrl(base, contentHash) {
  return new URL(`catalog-previews/${contentHash}.preview.json`, base).toString();
}
function imageUrl(base, file, artifactDigest) {
  return new URL(`catalog-previews/${file}?v=${artifactDigest.slice('sha256:'.length)}`, base).toString();
}
async function bytes(response, maximum, code) {
  if (!response || response.ok !== true || response.redirected === true) fail(code, 'generated preview response is unavailable');
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maximum) fail(code, 'generated preview response is too large');
  const value = new Uint8Array(await response.arrayBuffer());
  if (value.byteLength < 1 || value.byteLength > maximum) fail(code, 'generated preview response has an invalid size');
  return value;
}
function cover(value, contentHash, bucket) {
  const suffix = bucket === 'mobile' ? '' : '.c';
  const expectedFile = `${contentHash}.cover${suffix}.jpg`;
  if (!exact(value, ['file', 'sha256', 'width', 'height'])
    || value.file !== expectedFile || !DIGEST.test(String(value.sha256 || ''))
    || !Number.isInteger(value.width) || !Number.isInteger(value.height)
    || value.width < 240 || value.width > 1440 || value.height < 320 || value.height > 1920) {
    fail('invalid_preview_manifest', `generated ${bucket} preview descriptor is invalid`);
  }
  return value;
}
async function sha256(value, cryptoImpl) {
  if (!cryptoImpl?.subtle?.digest) fail('preview_crypto_unavailable', 'SHA-256 is unavailable');
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', value));
  return `sha256:${[...digest].map((item) => item.toString(16).padStart(2, '0')).join('')}`;
}

/** Fetch and verify both aspect buckets before the offer can reserve a page. */
export async function loadCatalogGeneratedPreview({
  baseUrl: rawBase,
  contentHash,
  runtimeArtifactDigest,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (!HASH.test(String(contentHash || '')) || !DIGEST.test(String(runtimeArtifactDigest || ''))
    || typeof fetchImpl !== 'function') fail('invalid_preview', 'generated preview identity is invalid');
  const base = baseUrl(rawBase);
  const manifestResponse = await fetchImpl(manifestUrl(base, contentHash), {
    cache: 'force-cache', credentials: 'omit', redirect: 'error',
  });
  const manifestBytes = await bytes(manifestResponse, MAX_MANIFEST_BYTES, 'preview_manifest_unavailable');
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); }
  catch { fail('invalid_preview_manifest', 'generated preview manifest is not valid UTF-8 JSON'); }
  if (!exact(manifest, [
    'schema', 'captureContract', 'contentHash', 'runtimeArtifactDigest', 'covers',
  ]) || manifest.schema !== 'catalog.generated-preview.v1'
    || !CAPTURE_CONTRACTS.has(manifest.captureContract)
    || manifest.contentHash !== contentHash
    || manifest.runtimeArtifactDigest !== runtimeArtifactDigest
    || !exact(manifest.covers, ['mobile', 'compact'])) {
    fail('invalid_preview_manifest', 'generated preview manifest differs from the catalog closure');
  }
  const descriptors = {
    mobile: cover(manifest.covers.mobile, contentHash, 'mobile'),
    compact: cover(manifest.covers.compact, contentHash, 'compact'),
  };
  const result = {};
  for (const bucket of ['mobile', 'compact']) {
    const descriptor = descriptors[bucket];
    const response = await fetchImpl(imageUrl(base, descriptor.file, runtimeArtifactDigest), {
      cache: 'force-cache', credentials: 'omit', redirect: 'error',
    });
    if (!/^image\/jpeg(?:\s*;|$)/i.test(response.headers?.get?.('content-type') || '')) {
      fail('invalid_preview_image', `generated ${bucket} preview is not JPEG`);
    }
    const imageBytes = await bytes(response, MAX_IMAGE_BYTES, 'preview_image_unavailable');
    if (await sha256(imageBytes, cryptoImpl) !== descriptor.sha256) {
      fail('preview_digest_mismatch', `generated ${bucket} preview digest mismatch`);
    }
    result[bucket] = Object.freeze({ descriptor: Object.freeze({ ...descriptor }), bytes: imageBytes });
  }
  return Object.freeze(result);
}
