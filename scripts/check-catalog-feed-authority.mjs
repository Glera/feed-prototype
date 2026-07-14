import assert from 'node:assert/strict';

import {
  CATALOG_AUTHORITY_BOOTSTRAP_TIMEOUT_MS,
  CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS,
  CatalogFeedAuthorityContractError,
  buildCatalogCanaryRunIdentity,
  buildCatalogFeedAuthorityRequest,
  catalogAuthorityFallbackTimerPlan,
  catalogAuthorityStartEligible,
  catalogCanaryAuthorityAllowsAllocation,
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
  validateCatalogCanaryAuthorityResult,
  validateCatalogFeedAuthorityResult,
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
equal(catalogFeedDogfoodEnabled({}, true, true), false, 'dogfood is off by default');
equal(catalogFeedDogfoodEnabled({
  VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
  VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
}, false, true), false, 'control-plane is an independent gate');
equal(catalogFeedDogfoodEnabled(dogfoodEnv, true, false), false, 'account scope is an independent gate');
equal(catalogFeedDogfoodEnabled(dogfoodEnv, true, true), true, 'all gates plus exact account enable the bridge');
equal(catalogCanaryDogfoodEnabled({}, true), false, 'canary invitation lookup is independently off by default');
equal(catalogCanaryDogfoodEnabled({ VITE_CATALOG_CANARY_DOGFOOD_ENABLED: 'true' }, false), false,
  'the canary flag cannot widen the existing effectful bridge');
equal(catalogCanaryDogfoodEnabled({ VITE_CATALOG_CANARY_DOGFOOD_ENABLED: 'TRUE' }, true), true,
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
  catalogAuthorityFallbackTimerPlan('authority_pending', false, true, null),
  'bootstrap',
  'an initial/navigation claim starts the bounded binding bootstrap',
);
equal(
  catalogAuthorityFallbackTimerPlan('authority_pending', true, true, 'bootstrap'),
  'delivery',
  'authority start replaces the bootstrap with a fresh delivery watchdog',
);
equal(
  catalogAuthorityFallbackTimerPlan('authority_pending', true, true, 'delivery'),
  null,
  'an already armed delivery watchdog is idempotent',
);
equal(
  catalogAuthorityFallbackTimerPlan('catalog_ready', true, true, 'delivery'),
  null,
  'a terminal delivery phase cannot arm another watchdog',
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
    : CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS;
  timerCallbacks.push({ stage, epoch, deadline: timerNow + delay, fire() {
    if (timerEpoch !== epoch || timerStage !== stage) return;
    timerPhase = 'builtin_fallback';
  } });
};
armTimer('bootstrap');
timerNow = 4000;
equal(timerPhase, 'authority_pending', 'a >3.5s delayed binding remains eligible under the 15s bootstrap');
equal(catalogAuthorityStartEligible(timerPhase, false, true), true, 'delayed binding can still start authority');
armTimer('delivery');
const staleBootstrap = timerCallbacks[0];
staleBootstrap.fire();
equal(timerPhase, 'authority_pending', 'a stale bootstrap callback is fenced by the replacement epoch');
equal(
  timerCallbacks[1].deadline,
  timerNow + CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS,
  'authority receives a full delivery budget independent of bootstrap age',
);
const deliveryCallback = timerCallbacks[1];
timerPhase = 'catalog_ready';
timerStage = null;
timerEpoch += 1;
deliveryCallback.fire();
equal(timerPhase, 'catalog_ready', 'catalog-ready cancellation fences a queued delivery callback');

timerPhase = 'authority_pending';
timerStage = null;
armTimer('delivery');
const unresolvedDelivery = timerCallbacks[2];
timerNow = unresolvedDelivery.deadline;
unresolvedDelivery.fire();
equal(catalogFeedSurface(timerPhase), 'builtin', 'an unresolved delivery still fails closed to builtin');

timerPhase = 'disposed';
timerStage = null;
timerEpoch += 1;
unresolvedDelivery.fire();
equal(timerPhase, 'disposed', 'dispose keeps stale watchdog callbacks fenced');
equal(Object.keys(request).join(','), 'schema,requestId,sourceDecisionId');
equal(Object.isFrozen(request), true);

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

console.log(`catalog feed authority: ${assertions} assertions passed`);
