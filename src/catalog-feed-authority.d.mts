export interface CatalogFeedAuthorityRequestV1 {
  schema: 'feed.catalog-authority-request.v1';
  requestId: string;
  sourceDecisionId: string;
}

export interface CatalogBuiltinFallbackV1 {
  mappingId: string;
  playableId: string;
  variantId: string;
  catalogMechanic: string;
}

export type CatalogFeedAuthorityResultV1 = {
  schema: 'feed.catalog-authority-result.v1';
  requestId: string;
  sourceDecisionId: string;
  planId: string;
  planDigest: string;
} & (
  | {
    outcome: 'catalog_authorized';
    authorizationId: string;
    authorizationDigest: string;
    expiresAt: string;
    fallback: null;
  }
  | {
    outcome: 'builtin_fallback';
    authorizationId: null;
    authorizationDigest: null;
    expiresAt: null;
    fallback: CatalogBuiltinFallbackV1;
  }
);

export interface CatalogCanaryAuthorityResultV1 {
  schema: 'catalog.canary-authority-result.v1';
  authorizationId: string;
  authorizationDigest: string;
  expiresAt: string;
  replayed: boolean;
}

export interface CatalogGeneratedOfferRequestV1 {
  schema: 'feed.generated-offer-request.v1';
  requestId: string;
}

export type CatalogGeneratedOfferResultV1 = {
  schema: 'feed.generated-offer-result.v1';
  requestId: string;
} & (
  | {
    outcome: 'no_offer';
    selectionMode: null;
    selectionReason: null;
    allocation: null;
  }
  | {
    outcome: 'allocated';
    selectionMode: 'affinity' | 'fallback_any';
    selectionReason: 'favorite_eligible' | 'insufficient_affinity' | 'affinity_stale'
      | 'preferred_runway_empty';
    allocation: import('./api').CatalogAllocationDecisionResultV3;
  }
);

export interface BuiltinBindingLike {
  mapping_id: string;
  playable_id: string;
  variant_id: string;
  catalog_mechanic: string;
}

export class CatalogFeedAuthorityContractError extends Error {
  readonly code: string;
}

export function catalogDogfoodAccountEligible(
  env: Record<string, unknown> | undefined,
  initData: string | null,
): boolean;

export function catalogFeedDogfoodEnabled(
  env: Record<string, unknown> | undefined,
  controlPlaneEnabled: boolean,
): boolean;
export function catalogCanaryDogfoodEnabled(
  env: Record<string, unknown> | undefined,
  feedDogfoodEnabled: boolean,
  accountEligible: boolean,
): boolean;
export function catalogCanaryInvitationMissing(status: number, code: string | null): boolean;
export function catalogCanaryAllocationFailureFallsThrough(status: number): boolean;
export function generatedProvenanceLabel(levelCount: number): string;
export function validateCatalogCanaryAuthorityResult(
  value: unknown,
): Readonly<CatalogCanaryAuthorityResultV1>;
export function catalogCanaryAuthorityAllowsAllocation(
  authority: CatalogCanaryAuthorityResultV1,
  nowMs?: number,
): boolean;
export function catalogCanaryAuthorityAllowsBackgroundAllocation(
  authority: CatalogCanaryAuthorityResultV1,
  nowMs?: number,
): boolean;
export function buildCatalogCanaryRunIdentity(authorizationId: string): Readonly<{
  ticketId: string;
  runId: string;
}>;
export function catalogCanaryTicketStartIsSafe(ticket: {
  state: string;
  completed_levels: number;
} | null | undefined): boolean;
export function catalogFeedSurface(
  phase: 'authority_pending' | 'delivery_pending' | 'catalog_ready' | 'catalog_mounted'
    | 'builtin_fallback' | 'disposed' | null,
): 'poster_only' | 'catalog' | 'builtin';
export function catalogFeedUsesBuiltinImpression(
  phase: 'authority_pending' | 'delivery_pending' | 'catalog_ready' | 'catalog_mounted'
    | 'builtin_fallback' | 'disposed' | null,
): boolean;
export function catalogFeedMustEvictFrame(
  phase: 'authority_pending' | 'delivery_pending' | 'catalog_ready' | 'catalog_mounted'
    | 'builtin_fallback' | 'disposed' | null,
  hasFrame: boolean,
): boolean;
export function catalogAuthorityStartEligible(
  phase: 'authority_pending' | 'delivery_pending' | 'catalog_ready' | 'catalog_mounted'
    | 'builtin_fallback' | 'disposed',
  authorityStarted: boolean,
  decisionEmitted: boolean,
): boolean;
export const CATALOG_AUTHORITY_BOOTSTRAP_TIMEOUT_MS: 65000;
export const CATALOG_AUTHORITY_PROJECTION_TIMEOUT_MS: 65000;
export const CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS: 15000;
export function catalogAuthorityFallbackTimerPlan(
  phase: 'authority_pending' | 'delivery_pending' | 'catalog_ready' | 'catalog_mounted'
    | 'builtin_fallback' | 'disposed',
  authorityStarted: boolean,
  sourceDecisionAcknowledged: boolean,
  claimCommitted: boolean,
  currentStage: 'bootstrap' | 'projection' | 'delivery' | null,
): 'bootstrap' | 'projection' | 'delivery' | null;
export function catalogSourceDecisionProjectionReady(
  flushed: boolean,
  eventState: 'pending' | 'rejected' | 'acknowledged' | 'unavailable',
  receiptStatus: 'pending' | 'stored' | 'projected' | 'pending_dependency' | 'rejected' | 'unavailable',
): boolean;
export function catalogPendingSlotShouldFallbackForBinding(
  phase: 'authority_pending' | 'delivery_pending' | 'catalog_ready' | 'catalog_mounted'
    | 'builtin_fallback' | 'disposed',
  bindingsResolved: boolean,
  hasBinding: boolean,
): boolean;
export function catalogFeedShouldClaimSlot(
  dogfoodEnabled: boolean,
  bindingsResolved: boolean,
  hasBinding: boolean,
): boolean;
export function generatedInsertionTarget(
  currentIndex: number,
  pageCount: number,
  blocked?: number[],
  minimumDistance?: number,
): number | null;
export function catalogGeneratedPreviewUrl(options: {
  baseUrl: string;
  contentHash: string;
  runtimeArtifactDigest: string;
  compact?: boolean;
}): string;
export function buildCatalogFeedAuthorityRequest(
  requestId: string,
  sourceDecisionId: string,
): CatalogFeedAuthorityRequestV1;
export function buildCatalogGeneratedOfferRequest(
  requestId: string,
): CatalogGeneratedOfferRequestV1;
export function validateCatalogGeneratedOfferResult(
  value: unknown,
  request: CatalogGeneratedOfferRequestV1,
): Readonly<CatalogGeneratedOfferResultV1>;
export function validateCatalogFeedAuthorityResult(
  value: unknown,
  request: CatalogFeedAuthorityRequestV1,
): CatalogFeedAuthorityResultV1;
export function catalogFallbackMatchesBinding(
  fallback: CatalogBuiltinFallbackV1 | null,
  binding: BuiltinBindingLike | null,
): boolean;
export function catalogRecallRecoveryEffect(
  code: string | null,
  ticketId: string | null,
  activeTicketId: string,
): Readonly<{
  type: 'catalog_recall_recovery';
  closeControlPlane: true;
  claimReward: false;
  restore: 'builtin';
  message: 'Серия обновилась';
}> | null;
