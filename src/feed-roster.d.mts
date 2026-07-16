export interface FeedRosterSessionEntryV1 {
  builtinMappingId: string;
  playableId: string;
  variantId: string;
  catalogMechanic: string;
  mappingDigest: string;
  mappingState: 'active' | 'retired';
}

export interface FeedRosterSessionV1 {
  schema: 'feed.roster-config.v1';
  activationId: string;
  rosterHash: string;
  entries: ReadonlyArray<FeedRosterSessionEntryV1>;
}

export interface FeedRosterResolutionV1 {
  source: 'baked' | 'fallback' | 'roster';
  playables: ReadonlyArray<{ readonly id: string }>;
  entries: ReadonlyArray<FeedRosterSessionEntryV1 | null>;
  unavailable: ReadonlyArray<{
    readonly builtinMappingId: string;
    readonly playableId: string;
    readonly reason: 'retired' | 'not_deployed';
  }>;
  availableCount: number;
  activationId: string | null;
  rosterHash: string | null;
}

export class FeedRosterContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export function parseFeedRosterSessionV1(value: unknown): Readonly<FeedRosterSessionV1>;
export function feedRosterIdentityJcs(projection: unknown): string;
export function verifyFeedRosterSessionV1(
  value: unknown,
  cryptoImpl?: Crypto,
): Promise<Readonly<FeedRosterSessionV1>>;
export function loadFeedRosterSessionSnapshot(storage: Storage): Readonly<FeedRosterSessionV1> | null;
export function loadVerifiedFeedRosterSessionSnapshot(
  storage: Storage,
  cryptoImpl?: Crypto,
): Promise<Readonly<FeedRosterSessionV1> | null>;
export function stageFeedRosterForNextSession(
  storage: Storage,
  value: unknown,
  cryptoImpl?: Crypto,
): Promise<Readonly<
  | { status: 'baked'; reason: 'absent' }
  | { status: 'staged'; activationId: string; rosterHash: string }
  | { status: 'rejected'; reason: string }
>>;
export function resolveFeedRosterSession(
  snapshot: unknown,
  bakedPlayables: ReadonlyArray<{ readonly id: string }>,
  isAvailable: (playableId: string) => boolean,
): Readonly<FeedRosterResolutionV1>;
export function buildBuiltinFeedDecisionV2(
  decisionId: string,
  entry: FeedRosterSessionEntryV1,
  rosterActivationId: string,
  feedPosition: number,
): Readonly<{
  decision_id: string;
  mapping_id: string;
  roster_activation_id: string;
  feed_position: number;
}>;
export const FEED_ROSTER_SNAPSHOT_KEY: string;
