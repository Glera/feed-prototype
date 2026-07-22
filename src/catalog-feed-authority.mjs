const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const PLAYABLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CATALOG_MECHANIC_RE = /^[a-z0-9][a-z0-9._-]{0,30}\/[a-z0-9][a-z0-9._-]{0,30}$/;
const ISO_MILLIS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const PLAYED_CANARY_STORAGE_KEY = 'swipe.catalog.played-canary-authorities.v1';
const PLAYED_CANARY_LIMIT = 32;

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

/** Published catalog delivery is available to every authenticated CP player. */
export function catalogFeedDogfoodEnabled(env, controlPlaneEnabled) {
  return controlPlaneEnabled === true
    && String(env?.VITE_CATALOG_PLAYER_V2_ENABLED ?? '').toLowerCase() === 'true'
    && String(env?.VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED ?? '').toLowerCase() === 'true';
}

/** Canary invitations remain pinned to the one explicitly configured account. */
export function catalogCanaryDogfoodEnabled(env, feedDogfoodEnabled, accountEligible) {
  return feedDogfoodEnabled === true
    && accountEligible === true
    && String(env?.VITE_CATALOG_CANARY_DOGFOOD_ENABLED ?? '').toLowerCase() === 'true';
}

/** The only 404 which means "continue through the ordinary effectful policy". */
export function catalogCanaryInvitationMissing(status, code) {
  return status === 404 && code === 'catalog_canary_invitation_not_found';
}

/** A consumed/stale/rejected exact canary must not suppress the public lane. */
export function catalogCanaryAllocationFailureFallsThrough(status) {
  return status === 404 || status === 409 || status === 410;
}

export function generatedProvenanceLabel(levelCount) {
  if (!Number.isInteger(levelCount) || levelCount < 1 || levelCount > 6) {
    fail('invalid_generated_offer', 'generated provenance level count is invalid');
  }
  return levelCount === 1
    ? 'GENERATED LEVEL'
    : `GENERATED SERIES · ${levelCount} LEVELS`;
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
 * Detached discovery may consume a fresh invitation or recover its exact
 * committed allocation after navigation won the allocation race but vanished
 * before creating the deterministic ticket. The caller must retire a failed
 * replay for the rest of the page so a played/terminal canary cannot starve the
 * ordinary published-feed fallback.
 */
export function catalogCanaryAuthorityAllowsBackgroundAllocation(
  authority,
  nowMs = Date.now(),
) {
  return catalogCanaryAuthorityAllowsAllocation(authority, nowMs);
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

function playedCanaryAuthorities(storage) {
  try {
    const value = JSON.parse(storage?.getItem?.(PLAYED_CANARY_STORAGE_KEY) || '[]');
    if (!Array.isArray(value) || value.length > PLAYED_CANARY_LIMIT
      || value.some((item) => typeof item !== 'string' || !UUID_RE.test(item))
      || new Set(value).size !== value.length) return [];
    return value;
  } catch {
    return [];
  }
}

/** A canary entered manually is no longer a lost-response recovery candidate. */
export function catalogCanaryWasPlayed(storage, authorizationId) {
  const exact = canonicalUuid(authorizationId, 'canary.authorizationId');
  return playedCanaryAuthorities(storage).includes(exact);
}

/**
 * Store only the opaque invitation id. A deliberate replacement gets a new id,
 * while a played/superseded ticket cannot resurface after a Telegram remount.
 */
export function rememberPlayedCatalogCanary(storage, authorizationId) {
  const exact = canonicalUuid(authorizationId, 'canary.authorizationId');
  const next = playedCanaryAuthorities(storage).filter((item) => item !== exact);
  next.push(exact);
  const bounded = next.slice(-PLAYED_CANARY_LIMIT);
  try {
    storage?.setItem?.(PLAYED_CANARY_STORAGE_KEY, JSON.stringify(bounded));
  } catch {
    // This is recovery/UI state, never catalog authority.
  }
  return Object.freeze([...bounded]);
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

export function buildCatalogGeneratedOfferRequest(requestId) {
  return Object.freeze({
    schema: 'feed.generated-offer-request.v1',
    requestId: canonicalUuid(requestId, 'requestId'),
  });
}

function generatedConfigRef(value, kind, label) {
  if (!exactKeys(value, ['kind', 'version', 'digest']) || value.kind !== kind
    || typeof value.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/.test(value.version)) {
    fail('invalid_generated_offer', `${label} is invalid`);
  }
  hash(value.digest, `${label}.digest`);
}

function validateGeneratedSelection(value) {
  if (!exactKeys(value, [
    'schema', 'mode', 'reason', 'asOf', 'affinityConfig', 'slotConfig', 'runwayConfig',
    'affinitySnapshotId', 'preferredMechanic', 'poolKind', 'poolDigest', 'tieDigest',
  ]) || value.schema !== 'feed.generated-offer-selection.v1'
    || !['affinity', 'fallback_any'].includes(value.mode)
    || !['favorite_eligible', 'insufficient_affinity', 'affinity_stale', 'preferred_runway_empty']
      .includes(value.reason)
    || typeof value.asOf !== 'string' || !ISO_MILLIS_RE.test(value.asOf)
    || !['unseen', 'released_repeat'].includes(value.poolKind)) {
    fail('invalid_generated_offer', 'generated offer selection is invalid');
  }
  generatedConfigRef(value.affinityConfig, 'affinity', 'selection.affinityConfig');
  generatedConfigRef(value.slotConfig, 'slot', 'selection.slotConfig');
  generatedConfigRef(value.runwayConfig, 'runway', 'selection.runwayConfig');
  hash(value.poolDigest, 'selection.poolDigest');
  hash(value.tieDigest, 'selection.tieDigest');
  const hasAffinity = value.affinitySnapshotId !== null || value.preferredMechanic !== null;
  if ((value.affinitySnapshotId === null) !== (value.preferredMechanic === null)) {
    fail('invalid_generated_offer', 'preferred affinity identity is all-or-none');
  }
  if (hasAffinity) {
    canonicalUuid(value.affinitySnapshotId, 'selection.affinitySnapshotId');
    if (typeof value.preferredMechanic !== 'string'
      || !CATALOG_MECHANIC_RE.test(value.preferredMechanic)) {
      fail('invalid_generated_offer', 'selection preferred mechanic is invalid');
    }
  }
  if (value.mode === 'affinity' && (value.reason !== 'favorite_eligible' || !hasAffinity)) {
    fail('invalid_generated_offer', 'affinity selection requires exact favorite evidence');
  }
  if (value.mode === 'fallback_any' && value.reason === 'favorite_eligible') {
    fail('invalid_generated_offer', 'fallback_any cannot claim favorite selection');
  }
}

function validateGeneratedAllocation(value, request) {
  if (!exactKeys(value, [
    'schema', 'outcome', 'decisionId', 'allocationId', 'requestHash',
    'requestedCatalogMechanic', 'slotType', 'policyVersion', 'holdExpiresAt',
    'catalog', 'runtime', 'manifest', 'offerSelection',
  ]) || value.schema !== 'catalog.allocate-decision-result.v3'
    || value.outcome !== 'allocated' || value.allocationId !== request.requestId
    || value.slotType !== 'generated-offer' || value.policyVersion !== 'feed.generated-offer.v1'
    || typeof value.holdExpiresAt !== 'string' || !ISO_MILLIS_RE.test(value.holdExpiresAt)) {
    fail('invalid_generated_offer', 'generated allocation has an unsupported shape');
  }
  canonicalUuid(value.decisionId, 'allocation.decisionId');
  canonicalUuid(value.allocationId, 'allocation.allocationId');
  hash(value.requestHash, 'allocation.requestHash');
  if (typeof value.requestedCatalogMechanic !== 'string'
    || !CATALOG_MECHANIC_RE.test(value.requestedCatalogMechanic)) {
    fail('invalid_generated_offer', 'generated allocation mechanic is invalid');
  }
  if (!exactKeys(value.catalog, [
    'entryId', 'entryState', 'entryStateVersion', 'mechanic', 'variant', 'seriesId',
  ]) || value.catalog.entryState !== 'published'
    || !Number.isInteger(value.catalog.entryStateVersion) || value.catalog.entryStateVersion < 0
    || typeof value.catalog.mechanic !== 'string' || typeof value.catalog.variant !== 'string'
    || `${value.catalog.mechanic}/${value.catalog.variant}` !== value.requestedCatalogMechanic) {
    fail('invalid_generated_offer', 'generated catalog identity is invalid');
  }
  canonicalUuid(value.catalog.entryId, 'allocation.catalog.entryId');
  canonicalUuid(value.catalog.seriesId, 'allocation.catalog.seriesId');
  if (!exactKeys(value.runtime, [
    'releaseId', 'playableId', 'legacyVariantId', 'runtimeContractDigest',
    'runtimeArtifactDigest', 'indexLocator', 'sidecarLocator', 'capabilities',
  ]) || typeof value.runtime.playableId !== 'string' || !PLAYABLE_RE.test(value.runtime.playableId)
    || typeof value.runtime.runtimeArtifactDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(value.runtime.runtimeArtifactDigest)
    || !plainObject(value.runtime.capabilities)
    || value.runtime.capabilities.catalogRequiredHandshake !== true) {
    fail('invalid_generated_offer', 'generated runtime identity is invalid');
  }
  canonicalUuid(value.runtime.releaseId, 'allocation.runtime.releaseId');
  canonicalUuid(value.runtime.legacyVariantId, 'allocation.runtime.legacyVariantId');
  hash(value.runtime.runtimeContractDigest, 'allocation.runtime.runtimeContractDigest');
  if (!plainObject(value.manifest)
    || !['series.manifest.v1', 'series.manifest.v2', 'series.manifest.v3']
      .includes(value.manifest.schema)) {
    fail('invalid_generated_offer', 'generated manifest identity is invalid');
  }
  const manifestKeys = value.manifest.schema === 'series.manifest.v2'
    ? ['schema', 'contentHash', 'seriesFingerprint', 'fingerprintVersion', 'levels',
      'skinHash', 'skinContractDigest', 'gameplayFingerprint', 'presentationFingerprint']
    : value.manifest.schema === 'series.manifest.v3'
      ? ['schema', 'contentHash', 'seriesFingerprint', 'fingerprintVersion', 'levels',
        'gameplayFingerprint', 'presentationFingerprint']
      : ['schema', 'contentHash', 'seriesFingerprint', 'fingerprintVersion', 'levels'];
  if (!exactKeys(value.manifest, manifestKeys) || !Array.isArray(value.manifest.levels)
    || value.manifest.levels.length < 1 || value.manifest.levels.length > 6
    || value.manifest.levels.some((item, index) => !exactKeys(item, ['ordinal', 'specHash'])
      || item.ordinal !== index + 1 || typeof item.specHash !== 'string' || !HASH_RE.test(item.specHash))) {
    fail('invalid_generated_offer', 'generated manifest levels are invalid');
  }
  hash(value.manifest.contentHash, 'allocation.manifest.contentHash');
  hash(value.manifest.seriesFingerprint, 'allocation.manifest.seriesFingerprint');
  if (value.manifest.schema === 'series.manifest.v2') {
    for (const key of ['skinHash', 'skinContractDigest']) {
      hash(value.manifest[key], `allocation.manifest.${key}`);
    }
  }
  if (['series.manifest.v2', 'series.manifest.v3'].includes(value.manifest.schema)) {
    for (const key of ['gameplayFingerprint', 'presentationFingerprint']) {
      hash(value.manifest[key], `allocation.manifest.${key}`);
    }
  }
  validateGeneratedSelection(value.offerSelection);
}

/** Validate the direct selector union and bind allocated bytes to requestId. */
export function validateCatalogGeneratedOfferResult(value, request) {
  if (!exactKeys(value, [
    'schema', 'requestId', 'outcome', 'selectionMode', 'selectionReason', 'allocation',
  ]) || value.schema !== 'feed.generated-offer-result.v1'
    || value.requestId !== request.requestId) {
    fail('invalid_generated_offer', 'generated offer result differs from its request');
  }
  canonicalUuid(value.requestId, 'result.requestId');
  if (value.outcome === 'no_offer') {
    if (value.selectionMode !== null || value.selectionReason !== null || value.allocation !== null) {
      fail('invalid_generated_offer', 'no_offer cannot expose selection or allocation');
    }
  } else if (value.outcome === 'allocated') {
    if (!['affinity', 'fallback_any'].includes(value.selectionMode)
      || typeof value.selectionReason !== 'string' || !plainObject(value.allocation)) {
      fail('invalid_generated_offer', 'allocated offer is missing selection evidence');
    }
    validateGeneratedAllocation(value.allocation, request);
    if (value.selectionMode !== value.allocation.offerSelection.mode
      || value.selectionReason !== value.allocation.offerSelection.reason) {
      fail('invalid_generated_offer', 'offer selection differs from allocation snapshot');
    }
  } else {
    fail('invalid_generated_offer', 'generated offer outcome is unsupported');
  }
  return cloneAndFreeze(value);
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
