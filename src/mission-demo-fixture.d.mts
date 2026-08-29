import type {
  MissionCaseView,
  MissionContributionReceipt,
  MissionHistoryEntry,
} from './mission-core.mjs';

export interface MissionDemoCaseOptions {
  progress?: number;
  caseTokens?: number;
  unlockedSeq?: number | null;
  fulfilledSeq?: number | null;
}

export declare const MISSION_DEMO_CONTRIBUTION: MissionContributionReceipt;
export declare const MISSION_DEMO_HISTORY: readonly MissionHistoryEntry[];
export declare function missionDemoCaseWire(options?: MissionDemoCaseOptions): MissionCaseView;
