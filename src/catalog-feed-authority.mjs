const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PLAYABLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CATALOG_MECHANIC_RE = /^[a-z0-9][a-z0-9._-]{0,30}\/[a-z0-9][a-z0-9._-]{0,30}$/;
const ISO_MILLIS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export const CATALOG_AUTHORITY_BOOTSTRAP_TIMEOUT_MS = 65000;
export const CATALOG_AUTHORITY_PROJECTION_TIMEOUT_MS = 65000;
export const CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS = 15000;

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

/** Additive invitation probe; it can never widen the existing effectful surface. */
export function catalogCanaryDogfoodEnabled(env, feedDogfoodEnabled) {
  return feedDogfoodEnabled === true
    && String(env?.VITE_CATALOG_CANARY_DOGFOOD_ENABLED ?? '').toLowerCase() === 'true';
}

/** The only 404 which means "continue through the ordinary effectful policy". */
export function catalogCanaryInvitationMissing(status, code) {
  return status === 404 && code === 'catalog_canary_invitation_not_found';
}

/** Validate the opaque invitation without accepting any content identity. */
export function validateCatalogCanaryAuthorityResult(value) {
  if (!exactKeys(value, [
    'schema', 'authorizationId', 'authorizationDigest', 'expiresAt', 'replayed',
  ])) fail('invalid_canary_authority', 'catalog canary authority has an unsupported shape');
  if (value.schema !== 'catalog.canary-authority-result.v1') {
    fail('invalid_canary_authority', 'catalog canary authority schema is unsupported');
  }
  canonicalUuid(value.authorizationId, 'canary.authorizationId');
  hash(value.authorizationDigest, 'canary.authorizationDigest');
  if (typeof value.expiresAt !== 'string'
    || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|\+00:00)$/.test(value.expiresAt)
    || !Number.isFinite(Date.parse(value.expiresAt))) {
    fail('invalid_canary_authority', 'catalog canary authority expiry must be a timezone-aware UTC instant');
  }
  if (typeof value.replayed !== 'boolean') {
    fail('invalid_canary_authority', 'catalog canary authority replayed must be boolean');
  }
  return cloneAndFreeze(value);
}

/** Fresh invitations expire normally; committed allocations remain exact-replayable. */
export function catalogCanaryAuthorityAllowsAllocation(authority, nowMs = Date.now()) {
  if (!authority || !Number.isFinite(nowMs)) return false;
  const expiresAt = Date.parse(authority.expiresAt);
  return authority.replayed === true || (Number.isFinite(expiresAt) && expiresAt > nowMs);
}

/**
 * A delivered canary invitation is also the bounded reload-recovery identity.
 * Repeating the same exact start request after a lost response replays the
 * manifest-bound ticket instead of colliding on decision uniqueness. This is
 * not mid-series resume: callers may mount only a zero-progress active ticket.
 */
export function buildCatalogCanaryRunIdentity(authorizationId) {
  const exact = canonicalUuid(authorizationId, 'canary.authorizationId');
  return Object.freeze({
    ticketId: exact,
    runId: `catalog-canary:${exact}`,
  });
}

export function catalogCanaryTicketStartIsSafe(ticket) {
  return Boolean(ticket
    && ticket.state === 'active'
    && ticket.completed_levels === 0);
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

/**
 * The claim is created only for the initial slot or a committed navigation,
 * never for ordinary iframe prefetch. It owns a bounded bootstrap wait. Once
 * authority starts, projection gets a cold-backend budget. Only the durable
 * source ACK replaces that with the shorter catalog-delivery watchdog.
 */
export function catalogAuthorityFallbackTimerPlan(
  phase,
  authorityStarted,
  sourceDecisionAcknowledged,
  claimCommitted,
  currentStage,
) {
  if (phase !== 'authority_pending') return null;
  if (sourceDecisionAcknowledged === true) {
    return currentStage === 'delivery' ? null : 'delivery';
  }
  if (authorityStarted === true) {
    return currentStage === 'projection' ? null : 'projection';
  }
  if (claimCommitted === true && currentStage == null) return 'bootstrap';
  return null;
}

/** Durable receipt alone is insufficient: authority requires the normalized projection. */
export function catalogSourceDecisionProjectionReady(flushed, eventState, receiptStatus) {
  return flushed === true
    && eventState === 'acknowledged'
    && receiptStatus === 'projected';
}

/** Resolved session bindings can fail only still-pending catalog claims immediately. */
export function catalogPendingSlotShouldFallbackForBinding(
  phase,
  bindingsResolved,
  hasBinding,
) {
  return phase === 'authority_pending'
    && bindingsResolved === true
    && hasBinding !== true;
}

/** Future unbound opportunities stay builtin once session bindings are authoritative. */
export function catalogFeedShouldClaimSlot(dogfoodEnabled, bindingsResolved, hasBinding) {
  return dogfoodEnabled === true
    && (bindingsResolved !== true || hasBinding === true);
}

/** Reserve only a future ring page; current navigation never waits for discovery. */
export function generatedInsertionTarget(currentIndex, pageCount, blocked = [], minimumDistance = 2) {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(pageCount) || pageCount < 3
    || currentIndex < 0 || currentIndex >= pageCount
    || !Number.isInteger(minimumDistance) || minimumDistance < 2 || minimumDistance >= pageCount
    || !Array.isArray(blocked) || blocked.some((value) => !Number.isInteger(value))) return null;
  const unavailable = new Set(blocked);
  for (let distance = minimumDistance; distance < pageCount; distance += 1) {
    const candidate = (currentIndex + distance) % pageCount;
    if (!unavailable.has(candidate)) return candidate;
  }
  return null;
}

/** Immutable, content-addressed host cover. No player device captures frames. */
export function catalogGeneratedPreviewUrl({
  baseUrl,
  contentHash,
  runtimeArtifactDigest,
  compact = false,
}) {
  hash(contentHash, 'preview.contentHash');
  if (typeof runtimeArtifactDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(runtimeArtifactDigest)) {
    fail('invalid_preview', 'preview runtimeArtifactDigest must be a sha256: digest');
  }
  if (typeof baseUrl !== 'string' || !baseUrl || typeof compact !== 'boolean') {
    fail('invalid_preview', 'preview baseUrl and aspect bucket are required');
  }
  let base;
  try { base = new URL(baseUrl, globalThis.location?.href ?? 'https://invalid.local/'); }
  catch { fail('invalid_preview', 'preview baseUrl is invalid'); }
  if (!['http:', 'https:'].includes(base.protocol)) fail('invalid_preview', 'preview baseUrl must be HTTP(S)');
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const artifact = runtimeArtifactDigest.slice('sha256:'.length);
  return new URL(
    `catalog-previews/${contentHash}.cover${compact ? '.c' : ''}.jpg?v=${artifact}`,
    base,
  ).toString();
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
  if (!['catalog_ticket_revoked', 'catalog_ticket_superseded'].includes(code)
    || typeof ticketId !== 'string'
    || ticketId !== activeTicketId) return null;
  return Object.freeze({
    type: 'catalog_recall_recovery',
    closeControlPlane: true,
    claimReward: false,
    restore: 'builtin',
    message: 'Серия обновилась',
  });
}
