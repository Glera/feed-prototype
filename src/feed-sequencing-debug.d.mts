export type SequencingDebugKind = 'profile' | 'why-now' | 'history';

export interface SequencingDebugSourceV1 {
  readonly kind: string | null;
  readonly id: string | null;
  readonly digest: string | null;
  readonly asOf: string | null;
}

export interface SequencingDebugEnvelopeV1 {
  readonly schema: string;
  readonly subjectUserId: string;
  readonly readOnly: true;
  readonly recomputed: false;
  readonly sources: ReadonlyArray<SequencingDebugSourceV1>;
}

export interface SequencingDebugProfileViewV1 {
  readonly kind: 'profile';
  readonly subjectUserId: string;
  readonly sources: ReadonlyArray<SequencingDebugSourceV1>;
  readonly snapshotAsOf: string | null;
  readonly snapshotAgeSeconds: number | null;
  readonly epoch: unknown;
  readonly configs: unknown;
  readonly profile: unknown;
  readonly profileSchema: string | null;
  readonly profileAsOf: string | null;
  readonly families: ReadonlyArray<unknown>;
  readonly favoriteSet: ReadonlyArray<unknown>;
  readonly present: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly raw: unknown;
}

export interface SequencingDebugSnapshotSectionV1 {
  readonly key: string;
  readonly value: unknown;
}

export interface SequencingDebugWhyNowViewV1 {
  readonly kind: 'why-now';
  readonly subjectUserId: string;
  readonly sources: ReadonlyArray<SequencingDebugSourceV1>;
  readonly planId: string | null;
  readonly chosenSlotType: string | null;
  readonly chosenFamilyId: string | null;
  readonly constraintConflict: boolean | null;
  readonly coldStartPhase: boolean | null;
  readonly snapshot: unknown;
  readonly snapshotDigest: string | null;
  readonly sections: ReadonlyArray<SequencingDebugSnapshotSectionV1>;
  readonly present: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly raw: unknown;
}

export interface SequencingDebugHistoryUnitV1 {
  readonly decisionId: string | null;
  readonly issuedAt: string | null;
  readonly slotType: string | null;
  readonly policyVersion: string | null;
  readonly arm: string | null;
  readonly mechanicId: string | null;
  readonly builtinMappingId: string | null;
  readonly rosterActivationId: string | null;
  readonly seen: boolean | null;
  readonly impressionId: string | null;
  readonly revealedAt: string | null;
}

export interface SequencingDebugResetReceiptV1 {
  readonly resetId: string | null;
  readonly scope: string | null;
  readonly effectiveAt: string | null;
  readonly newEpoch: number | null;
  readonly receiptDigest: string | null;
}

export interface SequencingDebugHistoryViewV1 {
  readonly kind: 'history';
  readonly subjectUserId: string;
  readonly sources: ReadonlyArray<SequencingDebugSourceV1>;
  readonly limit: number | null;
  readonly units: ReadonlyArray<SequencingDebugHistoryUnitV1>;
  readonly generatedOfferMisses: ReadonlyArray<unknown>;
  readonly favoriteDeliveryMisses: ReadonlyArray<unknown>;
  readonly resets: ReadonlyArray<SequencingDebugResetReceiptV1>;
  readonly present: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly raw: unknown;
}

export type SequencingDebugViewV1 =
  | SequencingDebugProfileViewV1
  | SequencingDebugWhyNowViewV1
  | SequencingDebugHistoryViewV1;

/** One transport outcome. `unavailable` is the server's single, non-leaking 404. */
export type SequencingDebugResult<T = unknown> =
  | { readonly status: 'ok'; readonly body: T }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error'; readonly message: string };

export interface SequencingDebugPanelStateV1 {
  readonly kind: SequencingDebugKind;
  readonly state: 'unavailable' | 'error' | 'empty' | 'data';
  readonly message: string | null;
  readonly retryable: boolean;
  readonly view: SequencingDebugViewV1 | null;
}

export type SequencingDebugSubject =
  | { readonly status: 'own' }
  | { readonly status: 'subject'; readonly userId: number }
  | { readonly status: 'invalid' };

export class FeedSequencingDebugContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string);
}

export const SEQUENCING_DEBUG_PROFILE_SCHEMA: 'feed.debug-profile.v1';
export const SEQUENCING_DEBUG_WHY_NOW_SCHEMA: 'feed.debug-why-now.v1';
export const SEQUENCING_DEBUG_HISTORY_SCHEMA: 'feed.debug-history.v1';
export const SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT: number;
export const SEQUENCING_DEBUG_HISTORY_LIMIT_MIN: number;
export const SEQUENCING_DEBUG_HISTORY_LIMIT_MAX: number;
export const SEQUENCING_DEBUG_PATHS: Readonly<Record<SequencingDebugKind, string>>;

export function parseSequencingDebugEnvelope(
  value: unknown,
  expectedSchema: string,
  warnings?: string[],
): Readonly<SequencingDebugEnvelopeV1>;
export function parseSequencingDebugProfileV1(value: unknown): SequencingDebugProfileViewV1;
export function parseSequencingDebugWhyNowV1(value: unknown): SequencingDebugWhyNowViewV1;
export function parseSequencingDebugHistoryV1(value: unknown): SequencingDebugHistoryViewV1;
export function parseSequencingDebugProjection(
  kind: SequencingDebugKind,
  value: unknown,
): SequencingDebugViewV1;
export function sequencingSnapshotSections(
  snapshot: unknown,
): ReadonlyArray<SequencingDebugSnapshotSectionV1>;
export function buildSequencingDebugView(
  kind: SequencingDebugKind,
  result: SequencingDebugResult,
): SequencingDebugPanelStateV1;
export function normalizeSequencingSubject(value: unknown): SequencingDebugSubject;
export function sequencingSubjectEchoWarning(
  requested: unknown,
  echoed: unknown,
): string | null;
export function normalizeSequencingHistoryLimit(value: unknown): number;
export function buildSequencingDebugPath(
  kind: SequencingDebugKind,
  options?: { readonly subject?: string | number | null; readonly limit?: string | number | null },
): string;
export function formatSequencingTimestamp(value: unknown): string;
export function formatSequencingSnapshotAge(seconds: unknown): string;
export function formatSequencingJson(value: unknown): string;
