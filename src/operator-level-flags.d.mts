export type OperatorLevelFlagIntent = 'delete_candidate' | 'edit_candidate';
export type OperatorLevelFlagSurface = 'preview' | 'active_level';
export interface OperatorLevelFlagOccurrence {
  flagSurface: OperatorLevelFlagSurface;
  decisionId: string;
  contentImpressionId: string;
  catalogEntryId: string;
  seriesId: string;
  ordinal: number;
  levelSpecHash: string;
  skinHash: string | null;
  levelEventId: string;
  levelImpressionId: string | null;
  runId: string | null;
  attemptEventId: string | null;
}
export interface OperatorLevelFlagRequestV1 {
  schema: 'catalog.operator-flag.request.v1';
  mutationId: string;
  intent: OperatorLevelFlagIntent;
  comment: string;
  flagSurface: OperatorLevelFlagSurface;
  subject: {
    catalogEntryId: string;
    seriesId: string;
    ordinal: number;
    levelSpecHash: string;
    skinHash: string | null;
  };
  causal: {
    decisionId: string;
    contentImpressionId: string;
    levelImpressionId: string | null;
    runId: string | null;
  };
}
export interface OperatorLevelFlagResponseV1 extends Omit<OperatorLevelFlagRequestV1, 'schema' | 'flagSurface'> {
  schema: 'catalog.operator-flag.v1';
  flagId: string;
  requestHash: string;
  actorUserId: number;
  flagSurface: OperatorLevelFlagSurface;
  createdAt: string;
  replayed: boolean;
}
export class OperatorLevelFlagContractError extends Error { readonly code: string; }
export function operatorLevelFlaggingAvailable(value: unknown): boolean;
export function validateOperatorLevelFlagOccurrence(value: unknown): Readonly<OperatorLevelFlagOccurrence>;
export function operatorLevelFlagOccurrenceKey(value: unknown): string;
export function buildOperatorLevelFlagRequest(input: {
  mutationId: string;
  intent: OperatorLevelFlagIntent;
  comment: string;
  occurrence: OperatorLevelFlagOccurrence;
}): Readonly<OperatorLevelFlagRequestV1>;
export function validateOperatorLevelFlagResponse(
  value: unknown,
  request: OperatorLevelFlagRequestV1,
): Readonly<OperatorLevelFlagResponseV1>;
export function operatorLevelFlagErrorMessage(error: unknown): string;
export interface OperatorLevelFlagControl { readonly occurrenceKey: string; destroy(): void; }
export function mountOperatorLevelFlagControl(host: HTMLElement, options: {
  occurrence: OperatorLevelFlagOccurrence;
  createMutationId(): string;
  submit(request: OperatorLevelFlagRequestV1): Promise<unknown>;
}): OperatorLevelFlagControl;
