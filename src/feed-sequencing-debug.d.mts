export type SequencingDebugKind = 'profile' | 'why-now' | 'history' | 'shadow-vs-actual';

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

export interface SequencingDebugShadowColdStartV1 {
  readonly active: boolean | null;
  readonly probesSeen: number | null;
  readonly exitReason: string | null;
}

export interface SequencingDebugShadowPlanV1 {
  readonly planId: string | null;
  readonly planDigest: string | null;
  readonly asOf: string | null;
  readonly chosenSlotType: string | null;
  readonly chosenFamilyId: string | null;
  readonly reason: string | null;
  readonly matchesActual: boolean | null;
  readonly constraintConflicts: ReadonlyArray<string | null>;
  readonly coldStart: SequencingDebugShadowColdStartV1;
}

export interface SequencingDebugShadowAbsenceV1 {
  readonly reason: string | null;
  readonly detail: string | null;
}

export interface SequencingDebugShadowActualV1 {
  readonly catalogMechanic: string | null;
  readonly familyId: string | null;
}

/** Folded from stored bytes only: `absent` when no plan, otherwise the
 *  server's own `matchesActual` (`unknown` when that boolean drifted). */
export type SequencingDebugShadowVerdict = 'match' | 'mismatch' | 'absent' | 'unknown';

export interface SequencingDebugShadowVsActualUnitV1 {
  readonly decisionId: string | null;
  readonly issuedAt: string | null;
  readonly slotType: string | null;
  readonly mechanicId: string | null;
  readonly builtinMappingId: string | null;
  readonly feedPosition: number | null;
  readonly seen: boolean | null;
  readonly impressionId: string | null;
  readonly revealedAt: string | null;
  readonly actual: SequencingDebugShadowActualV1;
  readonly armId: string | null;
  readonly shadowPlan: SequencingDebugShadowPlanV1 | null;
  readonly absence: SequencingDebugShadowAbsenceV1 | null;
  readonly verdict: SequencingDebugShadowVerdict;
}

export interface SequencingDebugShadowVsActualViewV1 {
  readonly kind: 'shadow-vs-actual';
  readonly subjectUserId: string;
  readonly sources: ReadonlyArray<SequencingDebugSourceV1>;
  readonly limit: number | null;
  readonly units: ReadonlyArray<SequencingDebugShadowVsActualUnitV1>;
  readonly present: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly raw: unknown;
}

export type SequencingDebugViewV1 =
  | SequencingDebugProfileViewV1
  | SequencingDebugWhyNowViewV1
  | SequencingDebugHistoryViewV1
  | SequencingDebugShadowVsActualViewV1;

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
export const SEQUENCING_DEBUG_SHADOW_VS_ACTUAL_SCHEMA: 'feed.debug-shadow-vs-actual.v1';
export const SEQUENCING_DEBUG_ABSENCE_REASONS: ReadonlyArray<string>;
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
export function parseSequencingDebugShadowVsActualV1(
  value: unknown,
): SequencingDebugShadowVsActualViewV1;
export function formatSequencingShadowAbsence(absence: unknown): string;
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
