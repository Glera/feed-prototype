import assert from 'node:assert/strict';

import {
  CATALOG_AUTHORITY_BOOTSTRAP_TIMEOUT_MS,
  CATALOG_AUTHORITY_PROJECTION_TIMEOUT_MS,
  CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS,
  CatalogFeedAuthorityContractError,
  buildCatalogCanaryRunIdentity,
  buildCatalogFeedAuthorityRequest,
  buildCatalogGeneratedOfferRequest,
  catalogAuthorityFallbackTimerPlan,
  catalogAuthorityStartEligible,
  catalogGeneratedPreviewUrl,
  catalogFeedShouldClaimSlot,
  catalogPendingSlotShouldFallbackForBinding,
  catalogSourceDecisionProjectionReady,
  catalogCanaryAuthorityAllowsAllocation,
  catalogCanaryAuthorityAllowsBackgroundAllocation,
  catalogCanaryAllocationFailureFallsThrough,
  catalogCanaryDogfoodEnabled,
  catalogCanaryInvitationMissing,
  catalogCanaryTicketStartIsSafe,
  catalogFallbackMatchesBinding,
  catalogDogfoodAccountEligible,
  catalogFeedDogfoodEnabled,
  catalogFeedMustEvictFrame,
  catalogFeedSurface,
  catalogFeedUsesBuiltinImpression,
  catalogRecallRecoveryEffect,
  generatedInsertionTarget,
  generatedProvenanceLabel,
  validateCatalogCanaryAuthorityResult,
  validateCatalogFeedAuthorityResult,
  validateCatalogGeneratedOfferResult,
} from '../src/catalog-feed-authority.mjs';

let assertions = 0;
const equal = (actual, expected, message) => {
  assert.equal(actual, expected, message);
  assertions += 1;
};
const throws = (fn, matcher, message) => {
  assert.throws(fn, matcher, message);
  assertions += 1;
};

const ids = {
  request: '10000000-0000-4000-8000-000000000001',
  source: '10000000-0000-4000-8000-000000000002',
  plan: '10000000-0000-4000-8000-000000000003',
  auth: '10000000-0000-4000-8000-000000000004',
  mapping: '10000000-0000-4000-8000-000000000005',
  variant: '10000000-0000-4000-8000-000000000006',
};
const request = buildCatalogFeedAuthorityRequest(ids.request, ids.source);
const offerRequest = buildCatalogGeneratedOfferRequest(ids.request);
const dogfoodEnv = {
  VITE_CATALOG_DOGFOOD_USER_ID: '424242',
  VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
  VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
};
const dogfoodInitData = new URLSearchParams({ user: JSON.stringify({ id: 424242 }) }).toString();

equal(catalogDogfoodAccountEligible({}, dogfoodInitData), false, 'missing account config fails closed');
equal(catalogDogfoodAccountEligible({ VITE_CATALOG_DOGFOOD_USER_ID: '424242,7' }, dogfoodInitData), false,
  'an allowlist cannot replace the one-account gate');
equal(catalogDogfoodAccountEligible({ VITE_CATALOG_DOGFOOD_USER_ID: '0424242' }, dogfoodInitData), false,
  'configured user id must be canonical');
equal(catalogDogfoodAccountEligible({ VITE_CATALOG_DOGFOOD_USER_ID: '424242' }, null), false,
  'missing Telegram identity fails closed');
equal(catalogDogfoodAccountEligible({ VITE_CATALOG_DOGFOOD_USER_ID: '424242' },
  new URLSearchParams({ user: JSON.stringify({ id: 7 }) }).toString()), false,
  'a different authenticated account is excluded');
equal(catalogDogfoodAccountEligible({ VITE_CATALOG_DOGFOOD_USER_ID: '424242' }, dogfoodInitData), true,
  'the one exact configured Telegram account is eligible');
equal(catalogFeedDogfoodEnabled({}, true), false, 'published catalog delivery is off by default');
equal(catalogFeedDogfoodEnabled({
  VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
  VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
}, false), false, 'control-plane is an independent gate');
equal(catalogFeedDogfoodEnabled(dogfoodEnv, true), true,
  'published catalog delivery does not depend on the canary account');
equal(catalogCanaryDogfoodEnabled({}, true, true), false, 'canary invitation lookup is independently off by default');
equal(catalogCanaryDogfoodEnabled({ VITE_CATALOG_CANARY_DOGFOOD_ENABLED: 'true' }, false, true), false,
  'the canary flag cannot widen the existing effectful bridge');
equal(catalogCanaryDogfoodEnabled({ VITE_CATALOG_CANARY_DOGFOOD_ENABLED: 'TRUE' }, true, false), false,
  'the canary flag cannot widen beyond the exact configured account');
equal(catalogCanaryDogfoodEnabled({ VITE_CATALOG_CANARY_DOGFOOD_ENABLED: 'TRUE' }, true, true), true,
  'the explicit canary flag adds invitation precedence to an eligible bridge');
equal(catalogCanaryInvitationMissing(404, 'catalog_canary_invitation_not_found'), true,
  'only the exact no-invitation code falls through to normal effectful policy');
equal(catalogCanaryInvitationMissing(404, 'catalog_canary_not_available'), false,
  'wrong-account backend evidence is terminal, not a policy fallthrough');
equal(catalogCanaryInvitationMissing(409, 'catalog_canary_invitation_not_found'), false,
  'the no-invitation code cannot bypass its exact HTTP status');
equal(catalogFeedSurface('authority_pending'), 'poster_only', 'authority cannot reveal the warm builtin');
equal(catalogFeedSurface('delivery_pending'), 'poster_only', 'delivery cannot reveal the warm builtin');
equal(catalogFeedSurface('catalog_ready'), 'catalog', 'only exact catalog delivery mounts catalog');
equal(catalogFeedSurface('builtin_fallback'), 'builtin', 'fallback mounts the reviewed builtin');
equal(catalogFeedUsesBuiltinImpression('authority_pending'), false, 'pending poster is not an impression');
equal(catalogFeedUsesBuiltinImpression('catalog_mounted'), false, 'catalog uses its specialized impression');
equal(catalogFeedUsesBuiltinImpression('builtin_fallback'), true, 'only fallback reuses the builtin wire');
equal(catalogFeedMustEvictFrame('authority_pending', true), true, 'pending authority evicts a warm builtin');
equal(catalogFeedMustEvictFrame('delivery_pending', true), true, 'pending delivery keeps poster-only ownership');
equal(catalogFeedMustEvictFrame('catalog_ready', true), false, 'delivered catalog owns its catalog frame');
equal(catalogFeedMustEvictFrame('builtin_fallback', true), false, 'fallback may keep its reviewed builtin');
equal(catalogAuthorityStartEligible('authority_pending', false, true), true, 'the first source ACK starts authority');
equal(catalogAuthorityStartEligible('authority_pending', true, true), false, 'retry/reload cannot start authority twice');
equal(catalogAuthorityStartEligible('catalog_ready', true, true), false, 'frame reload reuses delivered authority');

equal(
  catalogAuthorityFallbackTimerPlan('authority_pending', false, false, true, null),
  'bootstrap',
  'an initial/navigation claim starts the bounded binding bootstrap',
);
equal(
  catalogAuthorityFallbackTimerPlan('authority_pending', true, false, true, 'bootstrap'),
  'projection',
  'authority start replaces bootstrap with the cold CP projection watchdog',
);
equal(
  catalogAuthorityFallbackTimerPlan('authority_pending', true, true, true, 'projection'),
  'delivery',
  'durable source ACK starts a fresh catalog delivery watchdog',
);
equal(
  catalogAuthorityFallbackTimerPlan('authority_pending', true, true, true, 'delivery'),
  null,
  'an already armed delivery watchdog is idempotent',
);
equal(
  catalogAuthorityFallbackTimerPlan('catalog_ready', true, true, true, 'delivery'),
  null,
  'a terminal delivery phase cannot arm another watchdog',
);
equal(
  catalogSourceDecisionProjectionReady(true, 'acknowledged', 'projected'),
  true,
  'only a durable normalized source projection may enter catalog delivery',
);
equal(
  catalogSourceDecisionProjectionReady(true, 'acknowledged', 'stored'),
  false,
  'a stored durable receipt is not yet a source projection',
);
equal(
  catalogSourceDecisionProjectionReady(true, 'acknowledged', 'pending_dependency'),
  false,
  'pending dependency cannot authorize catalog selection',
);
equal(
  catalogSourceDecisionProjectionReady(false, 'acknowledged', 'projected'),
  false,
  'a failed flush cannot be hidden by stale page-local receipt state',
);
equal(
  catalogPendingSlotShouldFallbackForBinding('authority_pending', true, false),
  true,
  'an authoritative document immediately releases an unmapped pending claim',
);
equal(
  catalogPendingSlotShouldFallbackForBinding('authority_pending', true, true),
  false,
  'a mapped pending claim remains eligible for catalog authority',
);
equal(
  catalogPendingSlotShouldFallbackForBinding('authority_pending', false, false),
  false,
  'an unresolved session retains the cold-start bootstrap window',
);
equal(
  catalogPendingSlotShouldFallbackForBinding('delivery_pending', true, false),
  false,
  'binding refresh cannot retrofit an in-flight delivery or shown surface',
);
equal(
  catalogFeedShouldClaimSlot(true, false, false),
  true,
  'a pre-session opportunity retains a cold-start catalog claim',
);
equal(
  catalogFeedShouldClaimSlot(true, true, false),
  false,
  'a future authoritatively unbound opportunity stays plain builtin',
);
equal(
  catalogFeedShouldClaimSlot(true, true, true),
  true,
  'a future mapped opportunity still receives a catalog claim',
);
equal(
  catalogFeedShouldClaimSlot(false, false, true),
  false,
  'resolved state cannot bypass the dogfood gate',
);
equal(generatedInsertionTarget(0, 10), 2,
  'the first generated reservation stays two pages ahead');
equal(generatedInsertionTarget(9, 10), 1,
  'generated reservations wrap around the ring');
equal(generatedInsertionTarget(0, 4, [2]), 3,
  'a blocked future page is skipped without touching the next page');
equal(generatedInsertionTarget(0, 3, [2]), null,
  'no safe future page leaves the built-in loop unchanged');
equal(generatedInsertionTarget(0, 2), null,
  'a two-page ring cannot host a non-blocking insertion');
equal(
  catalogGeneratedPreviewUrl({
    baseUrl: 'https://swipe-platform.example/app/',
    contentHash: 'a'.repeat(64),
    runtimeArtifactDigest: `sha256:${'b'.repeat(64)}`,
  }),
  `https://swipe-platform.example/app/catalog-previews/${'a'.repeat(64)}.cover.jpg?v=${'b'.repeat(64)}`,
  'generated previews are content-addressed by the exact catalog/runtime closure',
);
equal(
  catalogGeneratedPreviewUrl({
    baseUrl: 'https://swipe-platform.example/',
    contentHash: 'c'.repeat(64),
    runtimeArtifactDigest: `sha256:${'d'.repeat(64)}`,
    compact: true,
  }),
  `https://swipe-platform.example/catalog-previews/${'c'.repeat(64)}.cover.c.jpg?v=${'d'.repeat(64)}`,
  'compact feed previews use their own immutable aspect bucket',
);

// Deterministic clock/epoch regression for the production race. Binding may
// arrive after the former 3.5s deadline, and authority then owns a full fresh
// delivery budget. Deliberately execute the stale bootstrap callback as if a
// browser queued it before clearTimeout; its epoch must fence it out.
let timerNow = 0;
let timerEpoch = 0;
let timerStage = null;
let timerPhase = 'authority_pending';
const timerCallbacks = [];
const armTimer = (stage) => {
  timerStage = stage;
  const epoch = ++timerEpoch;
  const delay = stage === 'bootstrap'
    ? CATALOG_AUTHORITY_BOOTSTRAP_TIMEOUT_MS
    : stage === 'projection'
      ? CATALOG_AUTHORITY_PROJECTION_TIMEOUT_MS
      : CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS;
  timerCallbacks.push({ stage, epoch, deadline: timerNow + delay, fire() {
    if (timerEpoch !== epoch || timerStage !== stage) return;
    timerPhase = 'builtin_fallback';
  } });
};
const advanceTimer = (nextNow) => {
  timerNow = nextNow;
  for (const callback of timerCallbacks) {
    if (callback.deadline <= timerNow) callback.fire();
  }
};
armTimer('bootstrap');
advanceTimer(20_000);
equal(timerPhase, 'authority_pending', 'binding delayed beyond 15s remains eligible under the cold-start bootstrap');
equal(catalogAuthorityStartEligible(timerPhase, false, true), true, 'delayed binding can still start authority');
armTimer('projection');
const staleBootstrap = timerCallbacks[0];
staleBootstrap.fire();
equal(timerPhase, 'authority_pending', 'a stale bootstrap callback is fenced by the replacement epoch');
equal(
  timerCallbacks[1].deadline,
  timerNow + CATALOG_AUTHORITY_PROJECTION_TIMEOUT_MS,
  'authority receives a cold-backend projection budget independent of bootstrap age',
);

advanceTimer(timerNow + 20_000);
equal(timerPhase, 'authority_pending', 'source ACK delayed beyond 15s cannot trigger catalog fallback');
armTimer('delivery');
const staleProjection = timerCallbacks[1];
staleProjection.fire();
equal(timerPhase, 'authority_pending', 'a stale projection callback is fenced after durable source ACK');
equal(
  timerCallbacks[2].deadline,
  timerNow + CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS,
  'durable source ACK receives a fresh full catalog-delivery window',
);
const deliveryCallback = timerCallbacks[2];
timerPhase = 'catalog_ready';
timerStage = null;
timerEpoch += 1;
deliveryCallback.fire();
equal(timerPhase, 'catalog_ready', 'catalog-ready cancellation fences a queued delivery callback');

timerPhase = 'authority_pending';
timerStage = null;
armTimer('delivery');
const unresolvedDelivery = timerCallbacks[3];
advanceTimer(unresolvedDelivery.deadline);
equal(catalogFeedSurface(timerPhase), 'builtin', 'an unresolved delivery still fails closed to builtin');

timerPhase = 'disposed';
timerStage = null;
timerEpoch += 1;
unresolvedDelivery.fire();
equal(timerPhase, 'disposed', 'dispose keeps stale watchdog callbacks fenced');
equal(Object.keys(request).join(','), 'schema,requestId,sourceDecisionId');
equal(Object.isFrozen(request), true);
equal(Object.keys(offerRequest).join(','), 'schema,requestId',
  'background selection accepts only a caller-generated replay identity');
equal(Object.isFrozen(offerRequest), true);

const generatedSelection = {
  schema: 'feed.generated-offer-selection.v1',
  mode: 'fallback_any',
  reason: 'insufficient_affinity',
  asOf: '2026-07-19T12:00:00.000Z',
  affinityConfig: { kind: 'affinity', version: 'affinity.pilot.v1', digest: '1'.repeat(64) },
  slotConfig: { kind: 'slot', version: 'slot.pilot.v2', digest: '2'.repeat(64) },
  runwayConfig: { kind: 'runway', version: 'runway.pilot.v1', digest: '3'.repeat(64) },
  affinitySnapshotId: null,
  preferredMechanic: null,
  poolKind: 'unseen',
  poolDigest: '4'.repeat(64),
  tieDigest: '5'.repeat(64),
};
const generatedAllocation = {
  schema: 'catalog.allocate-decision-result.v3',
  outcome: 'allocated',
  decisionId: ids.plan,
  allocationId: ids.request,
  requestHash: '6'.repeat(64),
  requestedCatalogMechanic: 'sort/base',
  slotType: 'generated-offer',
  policyVersion: 'feed.generated-offer.v1',
  holdExpiresAt: '2026-07-19T12:10:00.000Z',
  catalog: {
    entryId: ids.auth,
    entryState: 'published',
    entryStateVersion: 3,
    mechanic: 'sort',
    variant: 'base',
    seriesId: ids.mapping,
  },
  runtime: {
    releaseId: ids.variant,
    playableId: 'marble-sort-swipe',
    legacyVariantId: '20000000-0000-4000-8000-000000000001',
    runtimeContractDigest: '7'.repeat(64),
    runtimeArtifactDigest: `sha256:${'8'.repeat(64)}`,
    indexLocator: 'runtime-releases/marble-sort-swipe/index.html',
    sidecarLocator: 'runtime-releases/marble-sort-swipe/runtime.json',
    capabilities: { catalogRequiredHandshake: true },
  },
  manifest: {
    schema: 'series.manifest.v1',
    contentHash: '9'.repeat(64),
    seriesFingerprint: 'a'.repeat(64),
    fingerprintVersion: 'series-fingerprint.v1',
    levels: [{ ordinal: 1, specHash: 'b'.repeat(64) }],
  },
  offerSelection: generatedSelection,
};
const generatedOffer = validateCatalogGeneratedOfferResult({
  schema: 'feed.generated-offer-result.v1',
  requestId: ids.request,
  outcome: 'allocated',
  selectionMode: 'fallback_any',
  selectionReason: 'insufficient_affinity',
  allocation: generatedAllocation,
}, offerRequest);
equal(generatedOffer.allocation.allocationId, ids.request,
  'the selector allocation is bound directly to the request replay identity');
equal(Object.isFrozen(generatedOffer.allocation.offerSelection), true,
  'nested server-owned selection evidence is immutable after validation');
const rasterOffer = validateCatalogGeneratedOfferResult({
  schema: 'feed.generated-offer-result.v1',
  requestId: ids.request,
  outcome: 'allocated',
  selectionMode: 'fallback_any',
  selectionReason: 'insufficient_affinity',
  allocation: {
    ...generatedAllocation,
    requestedCatalogMechanic: 'merge/raster-art-feae1e153540',
    catalog: {
      ...generatedAllocation.catalog,
      mechanic: 'merge',
      variant: 'raster-art-feae1e153540',
    },
    runtime: {
      ...generatedAllocation.runtime,
      playableId: 'merge-locked-v1-swipe',
    },
    manifest: {
      ...generatedAllocation.manifest,
      schema: 'series.manifest.v3',
      gameplayFingerprint: 'c'.repeat(64),
      presentationFingerprint: 'd'.repeat(64),
    },
  },
}, offerRequest);
equal(rasterOffer.allocation.manifest.schema, 'series.manifest.v3',
  'the public selector accepts an exact generic raster-art manifest');
const noOffer = validateCatalogGeneratedOfferResult({
  schema: 'feed.generated-offer-result.v1',
  requestId: ids.request,
  outcome: 'no_offer',
  selectionMode: null,
  selectionReason: null,
  allocation: null,
}, offerRequest);
equal(noOffer.allocation, null, 'no_offer is a strict side-effect-free union arm');
throws(
  () => buildCatalogGeneratedOfferRequest('not-a-uuid'),
  /canonical UUID/,
  'generated discovery cannot invent a noncanonical replay identity',
);
throws(
  () => validateCatalogGeneratedOfferResult({ ...generatedOffer, requestId: ids.source }, offerRequest),
  /differs from its request/,
  'a selector response cannot cross-bind to another request',
);
throws(
  () => validateCatalogGeneratedOfferResult({
    ...generatedOffer,
    allocation: { ...generatedAllocation, slotType: 'anchor' },
  }, offerRequest),
  /unsupported shape/,
  'a generic allocation cannot masquerade as a generated insertion',
);
throws(
  () => validateCatalogGeneratedOfferResult({
    ...generatedOffer,
    selectionMode: 'affinity',
  }, offerRequest),
  /differs from allocation snapshot/,
  'outer selection labels must replay the durable allocation snapshot',
);
throws(
  () => validateCatalogGeneratedOfferResult({
    ...generatedOffer,
    allocation: {
      ...generatedAllocation,
      offerSelection: { ...generatedSelection, poolKind: 'invented' },
    },
  }, offerRequest),
  /selection is invalid/,
  'the client rejects an unknown selector pool instead of guessing',
);

const canary = validateCatalogCanaryAuthorityResult({
  schema: 'catalog.canary-authority-result.v1',
  authorizationId: ids.auth,
  authorizationDigest: 'd'.repeat(64),
  expiresAt: '2026-07-14T12:00:00.123456+00:00',
  replayed: false,
});
equal(canary.authorizationId, ids.auth);
equal(Object.keys(canary).join(','), 'schema,authorizationId,authorizationDigest,expiresAt,replayed');
equal(Object.isFrozen(canary), true);
equal(catalogCanaryAuthorityAllowsAllocation(canary, Date.parse('2026-07-14T11:59:59Z')), true,
  'a fresh invitation may allocate before expiry');
equal(catalogCanaryAuthorityAllowsAllocation(canary, Date.parse('2026-07-14T12:00:01Z')), false,
  'an uncommitted invitation cannot allocate after expiry');
equal(catalogCanaryAuthorityAllowsAllocation({ ...canary, replayed: true }, Date.parse('2030-01-01T00:00:00Z')), true,
  'a committed invitation remains usable only through exact allocation replay');
equal(catalogCanaryAuthorityAllowsBackgroundAllocation(canary, Date.parse('2026-07-14T11:59:59Z')), true,
  'detached discovery may consume a fresh canary invitation');
equal(catalogCanaryAuthorityAllowsBackgroundAllocation({ ...canary, replayed: true }, Date.parse('2026-07-14T11:59:59Z')), true,
  'detached discovery may recover an allocation-to-ticket transport gap');
equal(catalogCanaryAuthorityAllowsBackgroundAllocation(canary, Date.parse('2026-07-14T12:00:01Z')), false,
  'detached discovery rejects an expired fresh invitation');
const canaryRun = buildCatalogCanaryRunIdentity(ids.auth);
equal(canaryRun.ticketId, ids.auth, 'canary reload repeats the opaque authorization as ticket identity');
equal(canaryRun.runId, `catalog-canary:${ids.auth}`, 'canary reload repeats one bounded run identity');
equal(Object.isFrozen(canaryRun), true);
equal(catalogCanaryTicketStartIsSafe({ state: 'active', completed_levels: 0 }), true,
  'only an active zero-progress canary ticket is safe to recover');
equal(catalogCanaryTicketStartIsSafe({ state: 'active', completed_levels: 1 }), false,
  'configured or played canary tickets do not mid-series resume');
equal(catalogCanaryTicketStartIsSafe({ state: 'consumed', completed_levels: 2 }), false,
  'terminal canary tickets cannot duplicate a chest or reward');

const catalog = validateCatalogFeedAuthorityResult({
  schema: 'feed.catalog-authority-result.v1',
  requestId: ids.request,
  sourceDecisionId: ids.source,
  planId: ids.plan,
  planDigest: 'a'.repeat(64),
  outcome: 'catalog_authorized',
  authorizationId: ids.auth,
  authorizationDigest: 'b'.repeat(64),
  expiresAt: '2026-07-14T12:00:00.000Z',
  fallback: null,
}, request);
equal(catalog.authorizationId, ids.auth);
equal(Object.isFrozen(catalog), true);

const fallback = validateCatalogFeedAuthorityResult({
  schema: 'feed.catalog-authority-result.v1',
  requestId: ids.request,
  sourceDecisionId: ids.source,
  planId: ids.plan,
  planDigest: 'c'.repeat(64),
  outcome: 'builtin_fallback',
  authorizationId: null,
  authorizationDigest: null,
  expiresAt: null,
  fallback: {
    mappingId: ids.mapping,
    playableId: 'marble-sort-swipe',
    variantId: ids.variant,
    catalogMechanic: 'sort/marble',
  },
}, request);
equal(catalogFallbackMatchesBinding(fallback.fallback, {
  mapping_id: ids.mapping,
  playable_id: 'marble-sort-swipe',
  variant_id: ids.variant,
  catalog_mechanic: 'sort/marble',
}), true);
equal(catalogFallbackMatchesBinding(fallback.fallback, {
  mapping_id: ids.mapping,
  playable_id: 'merge-locked-v1-swipe',
  variant_id: ids.variant,
  catalog_mechanic: 'sort/marble',
}), false, 'server fallback cannot silently replace the source opportunity');
const recovery = catalogRecallRecoveryEffect('catalog_ticket_revoked', ids.auth, ids.auth);
equal(recovery?.claimReward, false, 'hard recall cannot claim a catalog reward');
equal(recovery?.restore, 'builtin', 'hard recall restores the reviewed builtin');
const superseded = catalogRecallRecoveryEffect(
  'catalog_ticket_superseded', ids.auth, ids.auth,
);
equal(superseded?.claimReward, false, 'replacement cannot claim a catalog reward');
equal(superseded?.restore, 'builtin', 'replacement restores the reviewed builtin');
equal(catalogRecallRecoveryEffect('catalog_ticket_expired', ids.auth, ids.auth), null);
equal(catalogRecallRecoveryEffect('catalog_ticket_revoked', ids.auth, ids.request), null);

throws(
  () => validateCatalogFeedAuthorityResult({ ...catalog, requestId: ids.source }, request),
  (error) => error instanceof CatalogFeedAuthorityContractError && error.code === 'authority_mismatch',
);
throws(
  () => validateCatalogFeedAuthorityResult({ ...catalog, extra: true }, request),
  /unsupported shape/,
);
throws(
  () => validateCatalogFeedAuthorityResult({ ...catalog, fallback: fallback.fallback }, request),
  /cannot contain a fallback/,
);
throws(
  () => validateCatalogFeedAuthorityResult({ ...fallback, authorizationId: ids.auth }, request),
  /cannot contain catalog authority fields/,
);
throws(
  () => buildCatalogFeedAuthorityRequest('not-a-uuid', ids.source),
  /canonical UUID/,
);
throws(
  () => validateCatalogCanaryAuthorityResult({ ...canary, entryId: ids.plan }),
  /unsupported shape/,
  'the invitation can never leak or accept a catalog content identity',
);
throws(
  () => validateCatalogCanaryAuthorityResult({ ...canary, expiresAt: '2026-07-14T12:00:00+03:00' }),
  /timezone-aware UTC/,
  'a non-UTC expiry fails closed',
);
throws(
  () => validateCatalogCanaryAuthorityResult({ ...canary, replayed: 1 }),
  /must be boolean/,
  'replay evidence cannot be truthy coercion',
);
throws(
  () => buildCatalogCanaryRunIdentity('not-a-uuid'),
  /canonical UUID/,
  'a malformed invitation cannot create a persisted recovery identity',
);
equal(catalogCanaryAllocationFailureFallsThrough(409), true,
  'a rejected exact canary immediately releases the public generated lane');
equal(catalogCanaryAllocationFailureFallsThrough(410), true,
  'an expired exact canary immediately releases the public generated lane');
equal(catalogCanaryAllocationFailureFallsThrough(503), false,
  'transient backend failure keeps the exact canary retryable');
equal(generatedProvenanceLabel(1), 'GENERATED LEVEL',
  'single generated content is labelled as one level');
equal(generatedProvenanceLabel(3), 'GENERATED SERIES · 3 LEVELS',
  'multi-level generated content exposes its series size');
throws(() => generatedProvenanceLabel(0), /level count is invalid/,
  'empty generated content cannot render misleading provenance');

console.log(`catalog feed authority: ${assertions} assertions passed`);
