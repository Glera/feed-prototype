export declare class ChallengeIdentityError extends Error {}

export declare const LEVEL_SPEC_IDENTITY_FIELDS: readonly [
  'schema',
  'runtimeContractDigest',
  'seed',
  'params',
];

export declare const CHALLENGE_LEVEL_SEED: 0;

export type JsonScalar = null | boolean | number | string;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

export declare function jcsBytes(value: JsonValue): Uint8Array;

export declare function jcsSha256(value: JsonValue, cryptoImpl?: Crypto): Promise<string>;

export interface ChallengeSpecDigestInput {
  schemaVersion: number;
  playableId: string;
  adapterVersion: number;
  params: { [key: string]: JsonValue };
  runtimeContractDigest: string;
  runtimeArtifactDigest: string;
}

export declare function computeSpecDigest(
  input: ChallengeSpecDigestInput,
  cryptoImpl?: Crypto,
): Promise<string>;

export interface ChallengeLevelSpecIdentity {
  schema: string;
  runtimeContractDigest: string;
  seed: number;
  params: { [key: string]: JsonValue };
}

export declare function levelSpecHash(
  levelSpec: ChallengeLevelSpecIdentity,
  cryptoImpl?: Crypto,
): Promise<string>;
