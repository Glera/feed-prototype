const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PLAYABLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CATALOG_MECHANIC_RE = /^[a-z0-9][a-z0-9._-]{0,30}\/[a-z0-9][a-z0-9._-]{0,30}$/;
const ISO_MILLIS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export class CatalogFeedAuthorityContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogFeedAuthorityContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CatalogFeedAuthorityContractError(code, message);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!plainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function canonicalUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    fail('invalid_uuid', `${label} must be a canonical UUID`);
  }
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) {
    fail('invalid_hash', `${label} must be a lowercase SHA-256 hash`);
  }
  return value;
}

function cloneAndFreeze(value) {
  const cloned = JSON.parse(JSON.stringify(value));
  const freeze = (item) => {
    if (item && typeof item === 'object' && !Object.isFrozen(item)) {
      Object.freeze(item);
      for (const child of Object.values(item)) freeze(child);
    }
    return item;
  };
  return freeze(cloned);
}

/**
 * One exact Telegram account owns the effectful dogfood surface. The raw
 * initData is still authenticated by the backend; this client check only keeps
 * every other account on the reviewed built-in path before any catalog request.
 */
export function catalogDogfoodAccountEligible(env, initData) {
  const configured = env?.VITE_CATALOG_DOGFOOD_USER_ID;
  if (typeof configured !== 'string' || !/^[1-9][0-9]{0,15}$/.test(configured)) return false;
  if (typeof initData !== 'string' || initData.length === 0) return false;
  try {
    const rawUser = new URLSearchParams(initData).get('user');
    if (!rawUser) return false;
    const user = JSON.parse(rawUser);
    return Boolean(user && typeof user === 'object' && !Array.isArray(user)
      && Number.isSafeInteger(user.id) && user.id > 0 && String(user.id) === configured);
  } catch {
    return false;
  }
}

/** Three independent build/runtime gates plus an exact account; no query escape. */
export function catalogFeedDogfoodEnabled(env, controlPlaneEnabled, accountEligible) {
  return controlPlaneEnabled === true
    && accountEligible === true
    && String(env?.VITE_CATALOG_PLAYER_V2_ENABLED ?? '').toLowerCase() === 'true'
    && String(env?.VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED ?? '').toLowerCase() === 'true';
}

export function catalogFeedSurface(phase) {
  if (phase == null || phase === 'builtin_fallback') return 'builtin';
  if (phase === 'catalog_ready' || phase === 'catalog_mounted') return 'catalog';
  if (['authority_pending', 'delivery_pending'].includes(phase)) return 'poster_only';
  return 'poster_only';
}

/** Pending/catalog slots never reuse the generic built-in impression wire. */
export function catalogFeedUsesBuiltinImpression(phase) {
  return phase == null || phase === 'builtin_fallback';
}

/** Poster-only authority/delivery owns the slot and evicts any warm iframe. */
export function catalogFeedMustEvictFrame(phase, hasFrame) {
  return hasFrame === true && catalogFeedSurface(phase) === 'poster_only';
}

/** A frame reload reuses the committed authority; only the first source ACK starts it. */
export function catalogAuthorityStartEligible(phase, authorityStarted, decisionEmitted) {
  return phase === 'authority_pending'
    && authorityStarted !== true
    && decisionEmitted === true;
}

export function buildCatalogFeedAuthorityRequest(requestId, sourceDecisionId) {
  return Object.freeze({
    schema: 'feed.catalog-authority-request.v1',
    requestId: canonicalUuid(requestId, 'requestId'),
    sourceDecisionId: canonicalUuid(sourceDecisionId, 'sourceDecisionId'),
  });
}

/** Validate the exact server-owned union and bind it back to the request. */
export function validateCatalogFeedAuthorityResult(value, request) {
  if (!exactKeys(value, [
    'schema', 'requestId', 'sourceDecisionId', 'planId', 'planDigest', 'outcome',
    'authorizationId', 'authorizationDigest', 'expiresAt', 'fallback',
  ])) fail('invalid_authority', 'catalog authority result has an unsupported shape');
  if (value.schema !== 'feed.catalog-authority-result.v1') {
    fail('invalid_authority', 'catalog authority result schema is unsupported');
  }
  canonicalUuid(value.requestId, 'result.requestId');
  canonicalUuid(value.sourceDecisionId, 'result.sourceDecisionId');
  canonicalUuid(value.planId, 'result.planId');
  hash(value.planDigest, 'result.planDigest');
  if (value.requestId !== request.requestId || value.sourceDecisionId !== request.sourceDecisionId) {
    fail('authority_mismatch', 'catalog authority result differs from the exact request');
  }

  if (value.outcome === 'catalog_authorized') {
    canonicalUuid(value.authorizationId, 'result.authorizationId');
    hash(value.authorizationDigest, 'result.authorizationDigest');
    if (typeof value.expiresAt !== 'string' || !ISO_MILLIS_RE.test(value.expiresAt)
      || !Number.isFinite(Date.parse(value.expiresAt))) {
      fail('invalid_authority', 'catalog authority expiry must use canonical millisecond UTC');
    }
    if (value.fallback !== null) {
      fail('invalid_authority', 'catalog_authorized cannot contain a fallback');
    }
  } else if (value.outcome === 'builtin_fallback') {
    if (value.authorizationId !== null || value.authorizationDigest !== null || value.expiresAt !== null) {
      fail('invalid_authority', 'builtin_fallback cannot contain catalog authority fields');
    }
    if (!exactKeys(value.fallback, ['mappingId', 'playableId', 'variantId', 'catalogMechanic'])) {
      fail('invalid_authority', 'builtin fallback has an unsupported shape');
    }
    canonicalUuid(value.fallback.mappingId, 'fallback.mappingId');
    canonicalUuid(value.fallback.variantId, 'fallback.variantId');
    if (typeof value.fallback.playableId !== 'string' || !PLAYABLE_RE.test(value.fallback.playableId)
      || typeof value.fallback.catalogMechanic !== 'string'
      || !CATALOG_MECHANIC_RE.test(value.fallback.catalogMechanic)) {
      fail('invalid_authority', 'builtin fallback identity is invalid');
    }
  } else {
    fail('invalid_authority', 'catalog authority outcome is unsupported');
  }
  return cloneAndFreeze(value);
}

/** The fallback must be the exact reviewed builtin that created the opportunity. */
export function catalogFallbackMatchesBinding(fallback, binding) {
  return Boolean(fallback && binding
    && fallback.mappingId === binding.mapping_id
    && fallback.playableId === binding.playable_id
    && fallback.variantId === binding.variant_id
    && fallback.catalogMechanic === binding.catalog_mechanic);
}

/** Pure terminal edge consumed by the feed before it paints catalog rewards. */
export function catalogRecallRecoveryEffect(code, ticketId, activeTicketId) {
  if (code !== 'catalog_ticket_revoked' || typeof ticketId !== 'string'
    || ticketId !== activeTicketId) return null;
  return Object.freeze({
    type: 'catalog_recall_recovery',
    closeControlPlane: true,
    claimReward: false,
    restore: 'builtin',
    message: 'Серия обновилась',
  });
}
