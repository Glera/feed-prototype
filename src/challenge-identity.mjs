/**
 * Share / Challenge v1 content-identity primitives (browser side).
 *
 * The backend closes level AND runtime identity with RFC 8785 JCS bytes + a
 * lowercase-hex SHA-256 (swipe-backend `app/content_identity.py`,
 * `app/challenge_core.py`). This module reproduces the SAME two hashes on the
 * client so a recipient can prove, byte-for-byte, that it played the exact level
 * the challenger authored. The Python↔browser agreement is pinned by
 * `test-fixtures/challenge-golden-vectors.v1.json` (D8 golden-vectors DoD),
 * checked by `scripts/check-challenge-identity.mjs`.
 *
 * Scope note: this is a MINIMAL JCS sufficient for the challenge domain — JSON
 * built from objects (string keys), arrays, strings, booleans, null and FINITE
 * numbers whose canonical form is an integer or a plain ECMAScript decimal.
 * Non-finite numbers and non-string object keys are rejected (fail-closed), the
 * same way the backend raises `CanonicalJsonError`. It is deliberately not a
 * general RFC 8785 implementation; sort-level params are integer/string shaped.
 */

export class ChallengeIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChallengeIdentityError';
  }
}

/** LevelSpec identity is exactly these four fields, in this contract order
 *  (mirrors backend `LEVEL_SPEC_IDENTITY_FIELDS`). */
export const LEVEL_SPEC_IDENTITY_FIELDS = Object.freeze([
  'schema',
  'runtimeContractDigest',
  'seed',
  'params',
]);

/** Challenge levels are fully explicit; the sort.level-spec.v1 procedural seed
 *  is fixed and deterministic (backend `CHALLENGE_LEVEL_SEED`). */
export const CHALLENGE_LEVEL_SEED = 0;

function canonicalNumber(value) {
  if (!Number.isFinite(value)) {
    throw new ChallengeIdentityError('non-finite numbers cannot be canonicalized');
  }
  // The challenge domain (schema/adapter versions, seed, sort params) is
  // integer-shaped. Integers serialize identically under ECMAScript
  // Number-to-String and RFC 8785. A non-integer finite number would need the
  // full RFC 8785 shortest-form algorithm we intentionally do not carry, so
  // reject it rather than risk a silent digest divergence from the backend.
  if (!Number.isInteger(value)) {
    throw new ChallengeIdentityError('non-integer numbers are outside the challenge JCS domain');
  }
  // -0 canonicalizes to "0".
  return String(value === 0 ? 0 : value);
}

function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') return canonicalNumber(value);
  if (t === 'string') {
    // JSON.stringify escapes control chars and " \\ per ECMAScript and emits raw
    // UTF-8 for all other code points — identical to RFC 8785 string output for
    // the (BMP, no lone-surrogate) challenge domain.
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (t === 'object') {
    const keys = Object.keys(value);
    for (const key of keys) {
      if (typeof key !== 'string') {
        throw new ChallengeIdentityError('object keys must be strings');
      }
    }
    // RFC 8785 sorts members by UTF-16 code units; the default string sort in
    // ECMAScript is exactly that ordering.
    keys.sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${members.join(',')}}`;
  }
  throw new ChallengeIdentityError(`unsupported JSON value of type ${t}`);
}

/** RFC 8785 canonical UTF-8 bytes of a JSON value (challenge domain). */
export function jcsBytes(value) {
  return new TextEncoder().encode(canonicalize(value));
}

async function sha256Hex(bytes, cryptoImpl) {
  const impl = cryptoImpl ?? (typeof globalThis !== 'undefined' ? globalThis.crypto : undefined);
  if (!impl?.subtle?.digest) {
    throw new ChallengeIdentityError('SHA-256 (crypto.subtle) is unavailable');
  }
  const digest = new Uint8Array(await impl.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256(JCS(value))` as lowercase hexadecimal (no `sha256:` prefix). */
export function jcsSha256(value, cryptoImpl) {
  return sha256Hex(jcsBytes(value), cryptoImpl);
}

/**
 * The challenge wrapper digest — closes level AND runtime
 * (backend `compute_spec_digest`). Field order is irrelevant (JCS sorts keys),
 * but we spell them out to mirror the contract exactly.
 */
export function computeSpecDigest(input, cryptoImpl) {
  const {
    schemaVersion, playableId, adapterVersion, params,
    runtimeContractDigest, runtimeArtifactDigest,
  } = input;
  return jcsSha256({
    schemaVersion,
    playableId,
    adapterVersion,
    params,
    runtimeContractDigest,
    runtimeArtifactDigest,
  }, cryptoImpl);
}

/**
 * The per-level `sort.level-spec.v1` specHash over the exact four identity
 * fields (backend `level_spec_hash`). Distinct address space from the wrapper
 * `spec_digest`.
 */
export function levelSpecHash(levelSpec, cryptoImpl) {
  const projected = {};
  for (const field of LEVEL_SPEC_IDENTITY_FIELDS) {
    if (!(field in levelSpec)) {
      throw new ChallengeIdentityError(`LevelSpec identity field missing: ${field}`);
    }
    projected[field] = levelSpec[field];
  }
  return jcsSha256(projected, cryptoImpl);
}
