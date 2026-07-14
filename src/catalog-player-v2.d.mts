export type CatalogFailureReason = 'timeout' | 'digest' | 'origin' | 'runtime' | 'contract' | 'mount';
export type CatalogPlayerPhase = 'awaiting_ready' | 'awaiting_configured' | 'configured' | 'failed' | 'disposed';

export interface SortLevelSpecV1 {
  schema: 'sort.level-spec.v1';
  specHash: string;
  runtimeContractDigest: string;
  seed: number;
  params: {
    gridCols: number;
    gridRows: number;
    colorsUsed: number;
    cellColorMap: number[];
    targetStacks: [number[], number[], number[], number[]];
    convSpeedMul: 0.8 | 1 | 1.25;
    modifiers: [];
  };
}

export interface CatalogRuntimeIdentityV1 {
  releaseId: string;
  playableId: string;
  legacyVariantId: string;
  runtimeContractDigest: string;
  runtimeArtifactDigest: string;
  indexLocator: string;
  sidecarLocator: string;
  capabilities: Record<string, boolean>;
}

export interface CatalogTicketLevelSpecBundleV1 {
  schema: 'catalog.ticket-level-spec-bundle.v1';
  ticketId: string;
  ticketState: 'active';
  decisionId: string;
  catalogEntryId: string;
  seriesId: string;
  manifestContentHash: string;
  runtime: CatalogRuntimeIdentityV1;
  levels: Array<{ ordinal: number; specHash: string; spec: SortLevelSpecV1 }>;
}

export interface CatalogPlayerLevelBinding {
  frameEpoch: number;
  decisionId: string;
  ticketId: string;
  catalogEntryId: string;
  seriesId: string;
  ordinal: number;
  runtimeReleaseId: string;
  playableId: string;
  legacyVariantId: string;
  runtimeContractDigest: string;
  runtimeArtifactDigest: string;
  indexLocator: string;
  specHash: string;
  spec: SortLevelSpecV1;
}

export interface CatalogFrameNavigation {
  src: string;
  expectedOrigin: string;
  referrerPolicy: 'origin';
  frameEpoch: number;
}

export interface CatalogConfigurationFailurePayload {
  decision_id: string;
  ticket_id: string;
  series_id: string;
  ordinal: number;
  expected_spec_hash: string;
  runtime_release_id: string;
  reason: CatalogFailureReason;
}

export interface CatalogLevelImpressionPayload {
  decision_id: string;
  impression_id: string;
  level_impression_id: string;
  ticket_id: string;
  catalog_entry_id: string;
  series_id: string;
  ordinal: number;
  level_spec_hash: string;
  applied_spec_hash: string;
  runtime_release_id: string;
  runtime_contract_digest: string;
  runtime_artifact_digest: string;
}

export interface CatalogMessageEvent {
  source: object | null;
  origin: string;
  data: unknown;
}

export type CatalogPlayerEffect =
  | { type: 'post_configure_level'; frameEpoch: number; targetOrigin: string; message: { type: 'configure_level'; nonce: string; spec: SortLevelSpecV1 } }
  | { type: 'catalog_reveal_ready'; frameEpoch: number; ordinal: number; appliedSpecHash: string }
  | { type: 'catalog_configuration_failure'; frameEpoch: number; payload: CatalogConfigurationFailurePayload };

export interface CatalogPlayerTransition {
  status: 'accepted' | 'ignored' | 'failed';
  phase: CatalogPlayerPhase;
  reason: string | null;
  effects: CatalogPlayerEffect[];
}

export interface CatalogPlayerSessionOptions {
  bundle: CatalogTicketLevelSpecBundleV1;
  ordinal: number;
  frameEpoch: number;
  frameSource: object;
  baseUrl: string;
}

export const CATALOG_FRAME_REFERRER_POLICY: 'origin';

export class CatalogPlayerV2ContractError extends Error {
  constructor(code: string, message: string);
  readonly code: string;
}

export function catalogPlayerV2Enabled(env: Record<string, unknown> | undefined, controlPlaneEnabled: boolean): boolean;
export function validateCatalogTicketLevelSpecBundle(value: unknown): CatalogTicketLevelSpecBundleV1;
export function buildCatalogPlayerLevelBinding(bundle: CatalogTicketLevelSpecBundleV1, ordinal: number, frameEpoch: number): CatalogPlayerLevelBinding;
export function buildCatalogFrameNavigation(binding: CatalogPlayerLevelBinding, baseUrl: string): CatalogFrameNavigation;
export function buildCatalogConfigurationFailure(binding: CatalogPlayerLevelBinding, reason: CatalogFailureReason): CatalogConfigurationFailurePayload;
export function buildCatalogLevelImpression(binding: CatalogPlayerLevelBinding, impressionId: string, levelImpressionId: string): CatalogLevelImpressionPayload;

export class CatalogPlayerV2Session {
  constructor(options: CatalogPlayerSessionOptions);
  readonly binding: CatalogPlayerLevelBinding;
  readonly navigation: CatalogFrameNavigation;
  snapshot(): {
    frameEpoch: number;
    phase: CatalogPlayerPhase;
    visible: boolean;
    revealClaimed: boolean;
    failureReason: CatalogFailureReason | null;
    ordinal: number;
    expectedSpecHash: string;
  };
  handleMessage(event: CatalogMessageEvent, frameEpoch: number): CatalogPlayerTransition;
  setVisible(visible: boolean, frameEpoch: number): CatalogPlayerTransition;
  fail(reason: CatalogFailureReason, frameEpoch: number): CatalogPlayerTransition;
  dispose(frameEpoch: number): boolean;
}
