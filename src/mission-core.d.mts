export declare const MISSION_CONTRIBUTION_RECEIPT_SCHEMA: 'mission.contribution-receipt.v1';
export declare const MISSION_CASE_VIEW_SCHEMA: 'mission.case-view.v1';
export declare const MISSION_CEREMONY_KINDS: readonly MissionCeremonyKind[];
export declare const MISSION_HISTORY_LIMIT: number;

export type MissionCeremonyKind = 'unlocked' | 'fulfilled';

export interface MissionBar {
  caseId: string;
  contractVersion: string;
  progress: number;
  tokenGoal: number;
}

export interface MissionUnlockedSnapshot {
  eventSeq: number;
  caseId: string;
  contractVersion: string;
  progress: number;
  tokenGoal: number;
  guaranteedCents: number;
  giftAdditionalCents: number;
  giftTotalCents: number;
  nextCaseId: string | null;
  nextContractVersion: string | null;
}

export interface MissionContributionAllocation {
  caseId: string;
  contractVersion: string;
  amount: number;
}

export interface MissionContributionReceipt {
  schema: 'mission.contribution-receipt.v1';
  seq: number;
  source: string;
  sourceRef: string;
  idempotencyKey: string;
  amount: number;
  allocations: MissionContributionAllocation[];
  unlocked: MissionUnlockedSnapshot | null;
  bar: MissionBar;
}

export interface MissionCaseEvent {
  eventSeq: number;
  caseId: string;
  contractVersion: string;
  occurredAt: string;
  receiptDigest: string;
  receipt: Record<string, unknown>;
  transferReceipt: Record<string, unknown> | null;
}

export interface MissionCaseMoney {
  currency: string;
  communityTokens: number;
  guaranteedCents: number;
  reservedCents: number;
  reservedAndOpenedCents: number;
  deliveredCents: number;
}

export interface MissionCaseContract {
  caseId: string;
  contractVersion: string;
  contractDigest: string;
  document: Record<string, unknown>;
  fundingPolicy: { version: string; digest: string; document: Record<string, unknown> };
}

export interface MissionActiveCase {
  caseId: string;
  contractVersion: string;
  bar: { progress: number; tokenGoal: number };
  money: MissionCaseMoney;
  contract: MissionCaseContract | null;
}

export interface MissionCaseView {
  schema: 'mission.case-view.v1';
  activeCase: MissionActiveCase | null;
  myContribution: { caseTokens: number; totalTokens: number };
  lastUnlocked: MissionCaseEvent | null;
  lastFulfilled: MissionCaseEvent | null;
}

export type MissionWatermark = Record<MissionCeremonyKind, number | null>;

export interface MissionPendingCeremony {
  kind: MissionCeremonyKind;
  event: MissionCaseEvent;
}

export interface MissionHistoryEntry {
  seq: number;
  source: string;
  amount: number;
  caseId: string;
  at: string;
}

export function parseMissionBar(value: unknown): MissionBar | null;
export function parseMissionUnlockedSnapshot(value: unknown): MissionUnlockedSnapshot | null;
export function parseMissionContributionReceipt(value: unknown): MissionContributionReceipt | null;
export function parseMissionCaseView(value: unknown): MissionCaseView | null;
export function normaliseMissionWatermark(value: unknown): MissionWatermark;
export function pendingMissionCeremonies(
  view: MissionCaseView | null | undefined,
  watermark: unknown,
): MissionPendingCeremony[];
export function advanceMissionWatermark(
  watermark: unknown,
  kind: string,
  eventSeq: unknown,
): MissionWatermark;
export function missionSurfaceEnabled(flagEnabled: unknown, capability: unknown): boolean;
export function missionBarPercent(progress: unknown, tokenGoal: unknown): number;
export function missionOpenedByPlayCents(money: unknown): number;
export function formatMissionMoney(cents: unknown, currency?: string): string;
export function missionCaseTitle(document: unknown): string;
export function missionCaseSubtitle(document: unknown): string;
export function missionSourceLabel(source: unknown): string;
export function appendMissionHistory(
  history: readonly MissionHistoryEntry[] | null | undefined,
  entry: Partial<MissionHistoryEntry> | null | undefined,
  limit?: number,
): MissionHistoryEntry[];
export function parseMissionHistory(value: unknown): MissionHistoryEntry[];
export function isContributionPresented(presented: readonly number[] | null | undefined, seq: unknown): boolean;
export function rememberPresentedContribution(
  presented: readonly number[] | null | undefined,
  seq: unknown,
  limit?: number,
): number[];
