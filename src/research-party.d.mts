export interface ResearchArtifact {
  repository: 'Glera/p4g-workspace-meta'; path: string; commitSha: string; digest: string;
}
export interface ResearchCandidate {
  candidateId: string; primaryObservationId: string; observationIds: string[];
  title: string; summary: string;
  primaryObservation: {
    observationId: string; sourceId: string; sourceItemId: string; sourceUrl: string;
    observedAt: string; title: string; signal: string; region: string;
  };
}
export interface ResearchShortlist {
  schema: 'research.party-shortlist.v1'; requestId: string; requestHash: string;
  normalizedPack: ResearchArtifact; radar: ResearchArtifact;
  policyVersion: 'research-source-policy.v1'; candidates: ResearchCandidate[]; shortlistHash: string;
}
export interface ResearchChoiceCommand {
  schema: 'research.party-choice-command.v1'; requestId: string; requestHash: string;
  mutationId: string; shortlistHash: string; candidateId: string; action: 'select' | 'reject';
}
export interface ResearchChoiceReceipt {
  schema: 'research.party-choice-receipt.v1'; receiptId: string; actorUserId: string;
  command: ResearchChoiceCommand; commandHash: string; recordedAt: string;
}
export interface ResearchResult {
  schema: 'research.party-result.v1'; actorUserId: string;
  intake: {
    schema: 'research.party-intake.response.v1'; requestId: string; requestHash: string;
    mutationId: string; createdAt: string; credentialTransit: false; executionAuthority: false;
    replayed: boolean;
    request: { schema: 'research.party-intake.v1'; mutationId: string; lens: 'R' | 'D';
      sourceIds: string[]; callBudget: number; registryVersion: string; dailyCapIdentity: string };
    delivery: { deliveryId: string; status: string; issueUrl: string | null };
    terminal: { schema: 'research.party-terminal.v1'; mutationId: string; issueNumber: number;
      status: 'READY' | 'NEEDS_HELP'; normalizedPack: ResearchArtifact | null; radar: ResearchArtifact | null;
      blocker: { reasonCode: string; safeSummary: string } | null } | null;
    telegram: { status: string; providerRef: string | null } | null;
  };
  shortlist: ResearchShortlist | null; choices: ResearchChoiceReceipt[];
}
export function researchPartyRoute(options?: { search?: string; startParam?: string | null }): {
  requested: boolean; requestId: string | null;
};
export function researchCanonicalJson(value: unknown): string;
export function researchHash(value: unknown): Promise<string>;
export function researchSourceUrl(sourceId: string, value: unknown): string | null;
export function validateResearchShortlist(value: unknown): Promise<ResearchShortlist>;
export function validateResearchChoiceCommand(value: unknown, shortlist: ResearchShortlist): ResearchChoiceCommand;
export function validateResearchResult(value: unknown, requestId: string): Promise<ResearchResult>;
export function validateResearchIntakeResponse(value: unknown, command: ResearchResult['intake']['request']): Promise<ResearchResult['intake']>;
export function validateResearchChoiceResponse(value: unknown, result: ResearchResult, command: ResearchChoiceCommand): Promise<ResearchChoiceReceipt>;
export function researchPendingKey(actorUserId: string, requestId: string): string;
