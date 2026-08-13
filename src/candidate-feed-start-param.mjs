const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TOKEN_LENGTH = 64;
const TOKEN_MARKER = 63; // '_' in the RFC 4648 URL-safe alphabet.

function hexBytes(value) {
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - value.length % 4) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function uuidFromBytes(bytes) {
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A v1 source-preview token is exactly Telegram's documented 64-character
 * start-parameter ceiling. It carries a v5 release UUID plus the full review
 * binding SHA-256. The binding digest commits the playable id, artifact digest
 * and same-origin candidate path, so those fields are never caller-authored a
 * second time.
 *
 * Six fixed UUID bits (version=5 and RFC variant=10) temporarily carry the
 * original first base64 sextet, freeing that first sextet for the '_' framing
 * marker without truncating either identity.
 */
export function encodeCandidateFeedStartParam({ releaseId, reviewBindingDigest }) {
  const normalizedRelease = String(releaseId ?? '').toLowerCase();
  const normalizedDigest = String(reviewBindingDigest ?? '').toLowerCase();
  if (!UUID_V5.test(normalizedRelease) || !DIGEST.test(normalizedDigest)) {
    throw new Error('candidate_feed_start_identity_invalid');
  }
  const bytes = new Uint8Array(48);
  bytes.set(hexBytes(normalizedRelease.replace(/-/g, '')), 0);
  bytes.set(hexBytes(normalizedDigest), 16);
  const originalFirstSextet = bytes[0] >>> 2;
  bytes[0] = (TOKEN_MARKER << 2) | (bytes[0] & 0x03);
  bytes[6] = ((originalFirstSextet >>> 2) << 4) | (bytes[6] & 0x0f);
  bytes[8] = ((originalFirstSextet & 0x03) << 6) | (bytes[8] & 0x3f);
  const token = base64UrlEncode(bytes);
  if (token.length !== TOKEN_LENGTH || !token.startsWith('_')) {
    throw new Error('candidate_feed_start_encoding_invalid');
  }
  return token;
}

/**
 * The single '_' marker is the full lossless framing budget: the payload uses
 * all other bits to retain a v5 UUID plus an untruncated SHA-256. Telegram's
 * reserved `_tgr_` campaign namespace is explicitly not ours.
 */
export function candidateFeedStartParamRequested(value) {
  return typeof value === 'string'
    && value.startsWith('_')
    && !value.startsWith('_tgr_');
}

export function decodeCandidateFeedStartParam(value) {
  if (!candidateFeedStartParamRequested(value)) return null;
  if (value.length !== TOKEN_LENGTH || !BASE64URL.test(value) || !value.startsWith('_')) {
    throw new Error('candidate_feed_start_param_invalid');
  }
  let bytes;
  try { bytes = base64UrlDecode(value); } catch {
    throw new Error('candidate_feed_start_param_invalid');
  }
  if (bytes.length !== 48 || bytes[0] >>> 2 !== TOKEN_MARKER) {
    throw new Error('candidate_feed_start_param_invalid');
  }
  const originalFirstSextet = ((bytes[6] >>> 4) << 2) | (bytes[8] >>> 6);
  bytes[0] = (originalFirstSextet << 2) | (bytes[0] & 0x03);
  bytes[6] = 0x50 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const releaseId = uuidFromBytes(bytes.slice(0, 16));
  const reviewBindingDigest = [...bytes.slice(16)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (!UUID_V5.test(releaseId) || !DIGEST.test(reviewBindingDigest)) {
    throw new Error('candidate_feed_start_param_invalid');
  }
  return Object.freeze({ releaseId, reviewBindingDigest });
}

export const CANDIDATE_FEED_START_PARAM_LENGTH = TOKEN_LENGTH;
