import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';

import {
  CatalogGeneratedPreviewError,
  loadCatalogGeneratedPreview,
  loadCatalogGeneratedPreviewOptional,
} from '../src/catalog-generated-preview.mjs';

const contentHash = 'a'.repeat(64);
const runtimeArtifactDigest = `sha256:${'b'.repeat(64)}`;
const mobile = Buffer.from('mobile-jpeg');
const compact = Buffer.from('compact-jpeg');
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const manifest = {
  schema: 'catalog.generated-preview.v1',
  captureContract: 'sort.generated-preview.v1',
  contentHash,
  runtimeArtifactDigest,
  covers: {
    mobile: { file: `${contentHash}.cover.jpg`, sha256: digest(mobile), width: 390, height: 600 },
    compact: { file: `${contentHash}.cover.c.jpg`, sha256: digest(compact), width: 390, height: 488 },
  },
};
const response = (body, type) => ({
  ok: true,
  redirected: false,
  headers: { get: (name) => name === 'content-type' ? type : name === 'content-length' ? String(body.length) : null },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
});
const fetchImpl = async (url) => {
  if (url.endsWith('.preview.json')) return response(Buffer.from(JSON.stringify(manifest)), 'application/json');
  if (url.includes('.cover.c.jpg')) return response(compact, 'image/jpeg');
  return response(mobile, 'image/jpeg');
};
const loaded = await loadCatalogGeneratedPreview({
  baseUrl: 'https://platform.example/', contentHash, runtimeArtifactDigest, fetchImpl, cryptoImpl: webcrypto,
});
assert.deepEqual(Buffer.from(loaded.mobile.bytes), mobile);
assert.deepEqual(Buffer.from(loaded.compact.bytes), compact);

const genericLoaded = await loadCatalogGeneratedPreview({
  baseUrl: 'https://platform.example/', contentHash, runtimeArtifactDigest,
  fetchImpl: async (url) => url.endsWith('.preview.json')
    ? response(Buffer.from(JSON.stringify({
      ...manifest,
      captureContract: 'catalog.runtime-cover.v1',
    })), 'application/json')
    : fetchImpl(url),
  cryptoImpl: webcrypto,
});
assert.deepEqual(Buffer.from(genericLoaded.mobile.bytes), mobile);
assert.deepEqual(Buffer.from(genericLoaded.compact.bytes), compact);

await assert.rejects(
  loadCatalogGeneratedPreview({
    baseUrl: 'https://platform.example/', contentHash, runtimeArtifactDigest,
    fetchImpl: async (url) => url.endsWith('.preview.json')
      ? response(Buffer.from(JSON.stringify({ ...manifest, contentHash: 'c'.repeat(64) })), 'application/json')
      : fetchImpl(url),
    cryptoImpl: webcrypto,
  }),
  (error) => error instanceof CatalogGeneratedPreviewError && error.code === 'invalid_preview_manifest',
);
await assert.rejects(
  loadCatalogGeneratedPreview({
    baseUrl: 'https://platform.example/', contentHash, runtimeArtifactDigest,
    fetchImpl: async (url) => url.endsWith('.preview.json')
      ? response(Buffer.from(JSON.stringify({ ...manifest, captureContract: 'caller-authored' })), 'application/json')
      : fetchImpl(url),
    cryptoImpl: webcrypto,
  }),
  (error) => error instanceof CatalogGeneratedPreviewError && error.code === 'invalid_preview_manifest',
);
const optionalMissing = await loadCatalogGeneratedPreviewOptional({
  baseUrl: 'https://platform.example/', contentHash, runtimeArtifactDigest,
  fetchImpl: async () => ({
    ok: false,
    redirected: false,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
  }),
  cryptoImpl: webcrypto,
});
assert.deepEqual(optionalMissing, {
  outcome: 'unavailable',
  preview: null,
  reason: 'preview_manifest_unavailable',
});
const optionalTransport = await loadCatalogGeneratedPreviewOptional({
  baseUrl: 'https://platform.example/', contentHash, runtimeArtifactDigest,
  fetchImpl: async () => { throw new Error('network down'); },
  cryptoImpl: webcrypto,
});
assert.equal(optionalTransport.outcome, 'unavailable');
assert.equal(optionalTransport.reason, 'preview_transport_failure');
console.log('catalog generated preview: exact manifest and both image digests verified');
