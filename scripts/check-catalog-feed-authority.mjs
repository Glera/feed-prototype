import assert from 'node:assert/strict';

import {
  CatalogFeedAuthorityContractError,
  buildCatalogFeedAuthorityRequest,
  catalogAuthorityStartEligible,
  catalogFallbackMatchesBinding,
  catalogFeedDogfoodEnabled,
  catalogFeedMustEvictFrame,
  catalogFeedSurface,
  catalogFeedUsesBuiltinImpression,
  catalogRecallRecoveryEffect,
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

equal(catalogFeedDogfoodEnabled({}, true), false, 'dogfood is off by default');
equal(catalogFeedDogfoodEnabled({
  VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
  VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
}, false), false, 'control-plane is an independent gate');
equal(catalogFeedDogfoodEnabled({
  VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
  VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
}, true), true, 'all three gates enable the bridge');
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
equal(Object.keys(request).join(','), 'schema,requestId,sourceDecisionId');
equal(Object.isFrozen(request), true);

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

console.log(`catalog feed authority: ${assertions} assertions passed`);
