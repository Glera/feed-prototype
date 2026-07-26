import type { ChallengeLevelSpecBundleV1 } from './challenge-player.mjs';

export declare class ChallengePlayError extends Error {
  readonly code: string;
}

export interface ChallengePlayMountContext {
  bundle: ChallengeLevelSpecBundleV1;
  kind: 'recipient' | 'source';
}

export interface ChallengePlayDeps {
  getSpecBoundView(id: string): Promise<{ spec_digest?: string | null }>;
  acceptChallenge(id: string): Promise<unknown>;
  startRecipientRun(req: {
    ticket_id: string; run_id: string; mechanic_id: string; variant_id: string;
    kind: 'single'; challenge_id: string;
  }): Promise<unknown>;
  startSourceRun(req: {
    schema: 'run.start.challenge.v1'; purpose: 'challenge_source';
    ticket_id: string; run_id: string; mechanic_id: string; variant_id: string;
    kind: 'single'; challengeSpec: { playableId: string; adapterVersion: number; schemaVersion: number; params: Record<string, unknown> };
  }): Promise<unknown>;
  getLevelBundle(ticketId: string): Promise<ChallengeLevelSpecBundleV1>;
  createSourceLevel(requestId: string): Promise<{
    request_id: string; spec_digest: string;
    challengeSpec: { playableId: string; adapterVersion: number; schemaVersion: number; params: Record<string, unknown>; runtimeContractDigest: string; runtimeArtifactDigest: string };
  }>;
  postResult(payload: {
    mechanic_id: string; variant_id: string; run_id: string; ticket_id: string;
    metric_value: number; applied_spec_digest: string; tz_offset_minutes?: number;
  }): Promise<unknown>;
  complete(payload: { id: string; source_run_id: string; applied_spec_digest: string }): Promise<{ beat: boolean; stars_awarded: number; balance: number }>;
  createChallenge(payload: { mechanic_id: string; variant_id: string; source_run_id: string; request_id: string }): Promise<{ challenge_id: string; deep_link: string; share_url: string }>;
  verifyBundleIdentity(bundle: ChallengeLevelSpecBundleV1): Promise<boolean>;
  mountLevel(ctx: ChallengePlayMountContext): Promise<{ metricValue: number }>;
  newUuid(): string;
  tzOffsetMinutes?(): number;
}

export declare function playRecipientChallenge(
  deps: ChallengePlayDeps,
  input: { challengeId: string; mechanicId: string; variantId: string },
): Promise<{
  view: Record<string, unknown>;
  bundle: ChallengeLevelSpecBundleV1;
  runId: string;
  ticketId: string;
  metricValue: number;
  result: { beat: boolean; stars_awarded: number; balance: number };
}>;

export declare function playSourceChallenge(
  deps: ChallengePlayDeps,
  input: { mechanicId: string; variantId: string; requestId: string },
): Promise<{
  offer: { request_id: string; spec_digest: string };
  bundle: ChallengeLevelSpecBundleV1;
  runId: string;
  ticketId: string;
  metricValue: number;
  created: { challenge_id: string; deep_link: string; share_url: string };
}>;
