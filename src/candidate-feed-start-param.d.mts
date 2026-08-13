export interface CandidateFeedStartIdentity {
  releaseId: string;
  reviewBindingDigest: string;
}

export function encodeCandidateFeedStartParam(identity: CandidateFeedStartIdentity): string;
export function candidateFeedStartParamRequested(value: unknown): boolean;
export function decodeCandidateFeedStartParam(value: unknown): Readonly<CandidateFeedStartIdentity> | null;
export const CANDIDATE_FEED_START_PARAM_LENGTH: 64;
