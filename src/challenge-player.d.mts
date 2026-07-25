import type { CatalogFrameNavigation } from './catalog-player-v2.mjs';
import type { JsonValue } from './challenge-identity.mjs';

export declare const CHALLENGE_LEVEL_BUNDLE_SCHEMA: 'challenge.ticket-level-spec-bundle.v1';

export declare class ChallengePlayerContractError extends Error {
  readonly code: string;
}

export interface ChallengeBundleRuntimeV1 {
  playableId: string;
  releaseId: string;
  runtimeContractDigest: string;
  runtimeArtifactDigest: string;
  indexLocator: string;
  sidecarLocator: string;
  capabilities: Record<string, boolean>;
}

export interface ChallengeLevelSpecV1 {
  schema: string;
  specHash: string;
  runtimeContractDigest: string;
  seed: number;
  params: Record<string, JsonValue>;
}

export interface ChallengeLevelSpecBundleV1 {
  schema: 'challenge.ticket-level-spec-bundle.v1';
  ticketId: string;
  ticketState: string;
  challengeId: string | null;
  specDigest: string;
  expectedSpecHash: string;
  runtime: ChallengeBundleRuntimeV1;
  level: ChallengeLevelSpecV1;
}

export interface ChallengePlayerLevelBinding {
  frameEpoch: number;
  ticketId: string;
  challengeId: string | null;
  ticketState: string;
  playableId: string;
  releaseId: string;
  runtimeContractDigest: string;
  runtimeArtifactDigest: string;
  indexLocator: string;
  specHash: string;
  specDigest: string;
  spec: ChallengeLevelSpecV1;
  skinHash: null;
}

export declare function validateChallengeLevelBundle(input: unknown): ChallengeLevelSpecBundleV1;
export declare function buildChallengePlayerLevelBinding(bundleInput: unknown, frameEpoch: number): ChallengePlayerLevelBinding;
export declare function buildChallengeFrameNavigation(binding: ChallengePlayerLevelBinding, baseUrl: string): CatalogFrameNavigation;
export declare function verifyChallengeBundleIdentity(bundle: ChallengeLevelSpecBundleV1): Promise<boolean>;

export type ChallengeFailureReason = 'timeout' | 'digest' | 'origin' | 'runtime' | 'contract' | 'mount';
export type ChallengePlayerPhase = 'awaiting_ready' | 'awaiting_configured' | 'configured' | 'failed' | 'disposed';

export interface ChallengeConfigureLevelEffect {
  type: 'post_configure_level';
  frameEpoch: number;
  targetOrigin: string;
  message: { type: 'configure_level'; nonce: string; spec: ChallengeLevelSpecV1 };
}
export interface ChallengeRevealEffect {
  type: 'challenge_reveal_ready';
  frameEpoch: number;
  appliedSpecHash: string;
}
export interface ChallengeFailureEffect {
  type: 'challenge_configuration_failure';
  frameEpoch: number;
  payload: {
    ticket_id: string;
    challenge_id: string | null;
    expected_spec_hash: string;
    runtime_release_id: string;
    reason: ChallengeFailureReason;
  };
}
export type ChallengePlayerEffect =
  | ChallengeConfigureLevelEffect
  | ChallengeRevealEffect
  | ChallengeFailureEffect;

export interface ChallengePlayerTransition {
  status: 'accepted' | 'failed' | 'ignored';
  phase: ChallengePlayerPhase;
  reason: string | null;
  effects: ChallengePlayerEffect[];
}

export interface ChallengePlayerSessionOptions {
  bundle: unknown;
  baseUrl: string;
  frameEpoch: number;
  frameSource: object;
}

export declare class ChallengePlayerSession {
  constructor(options: ChallengePlayerSessionOptions);
  readonly binding: ChallengePlayerLevelBinding;
  readonly navigation: CatalogFrameNavigation;
  snapshot(): {
    frameEpoch: number;
    phase: ChallengePlayerPhase;
    visible: boolean;
    revealClaimed: boolean;
    failureReason: ChallengeFailureReason | null;
    expectedSpecHash: string;
  };
  handleMessage(event: { source?: unknown; origin?: string; data?: unknown }, frameEpoch: number): ChallengePlayerTransition;
  setVisible(visible: boolean, frameEpoch: number): ChallengePlayerTransition;
  fail(reason: ChallengeFailureReason, frameEpoch: number): ChallengePlayerTransition;
  dispose(frameEpoch: number): boolean;
}
