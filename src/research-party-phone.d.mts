import type { ResearchResult } from './research-party.mjs';
export type ResearchIntakeCommand = ResearchResult['intake']['request'];
export interface ResearchPhoneCapability {
  schema: 'research.party-phone-capability.v1'; actorUserId: string;
  sourcePolicyVersion: 'research-source-policy.v1';
  capability: { schema: 'research.party-capability.v1'; enabled: boolean;
    registryVersion: 'research-tier-a.v1'; sourceIds: string[]; maxPartyCalls: 50;
    dailyCapIdentity: string; remainingCalls: number; routeOwner: 'mac-b';
    credentialTransit: false; executionAuthority: false };
}
export function validateResearchPhoneCapability(value: unknown): ResearchPhoneCapability;
export function validateResearchIntakeCommand(value: unknown, capability?: ResearchPhoneCapability | null): ResearchIntakeCommand;
export function researchCreatePendingKey(actorUserId: string): string;
export function researchCreateUrl(href: string): string;
