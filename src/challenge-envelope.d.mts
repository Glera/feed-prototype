import type { ChallengePlayEnvelope, ChallengePlayEnvelopeData } from './challenge-play.mjs';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface DurableChallengeEnvelope extends ChallengePlayEnvelope {
  getData(): ChallengePlayEnvelopeData;
  clear(): void;
}

export declare const RECIPIENT_ENVELOPE_PREFIX: string;
export declare const SOURCE_ENVELOPE_KEY: string;

export declare function openEnvelope(
  storage: StorageLike,
  key: string,
  mint: () => string,
  runIdPrefix?: string,
): DurableChallengeEnvelope;

export declare function openRecipientEnvelope(
  storage: StorageLike,
  challengeId: string,
  mint: () => string,
): DurableChallengeEnvelope;

export declare function openSourceEnvelope(
  storage: StorageLike,
  mint: () => string,
): DurableChallengeEnvelope;
