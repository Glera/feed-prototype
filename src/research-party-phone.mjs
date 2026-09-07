/** Immutable registry v1 -> source-policy v1 admission for phone creation only. */
import { researchCanonicalJson } from './research-party.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCES = ['crazygames-charts', 'poki-charts'];
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const actor = (value) => typeof value === 'string' && /^[1-9][0-9]{0,31}$/.test(value);
const capId = (value) => typeof value === 'string' && /^research-tier-a:\d{4}-\d{2}-\d{2}:calls-50:v1$/.test(value);
const check = (condition) => { if (!condition) throw new Error('research_phone_wire_invalid'); };
export function validateResearchPhoneCapability(value) {
  check(exact(value, ['schema', 'actorUserId', 'sourcePolicyVersion', 'capability'])
    && value.schema === 'research.party-phone-capability.v1' && actor(value.actorUserId)
    && value.sourcePolicyVersion === 'research-source-policy.v1');
  const cap = value.capability;
  check(exact(cap, ['schema', 'enabled', 'registryVersion', 'sourceIds', 'maxPartyCalls', 'dailyCapIdentity',
    'remainingCalls', 'routeOwner', 'credentialTransit', 'executionAuthority'])
    && cap.schema === 'research.party-capability.v1' && typeof cap.enabled === 'boolean'
    && cap.registryVersion === 'research-tier-a.v1' && cap.routeOwner === 'mac-b'
    && cap.credentialTransit === false && cap.executionAuthority === false
    && researchCanonicalJson(cap.sourceIds) === researchCanonicalJson(SOURCES)
    && cap.maxPartyCalls === 50 && Number.isInteger(cap.remainingCalls)
    && cap.remainingCalls >= 0 && cap.remainingCalls <= 50 && capId(cap.dailyCapIdentity));
  return value;
}
export function validateResearchIntakeCommand(value, phoneCapability = null) {
  check(exact(value, ['schema', 'mutationId', 'lens', 'sourceIds', 'callBudget', 'registryVersion', 'dailyCapIdentity'])
    && value.schema === 'research.party-intake.v1' && UUID.test(value.mutationId)
    && ['R', 'D'].includes(value.lens) && Array.isArray(value.sourceIds) && value.sourceIds.length >= 1
    && value.sourceIds.length <= 2 && value.sourceIds.every((id) => SOURCES.includes(id))
    && new Set(value.sourceIds).size === value.sourceIds.length
    && researchCanonicalJson(value.sourceIds) === researchCanonicalJson([...value.sourceIds].sort())
    && Number.isInteger(value.callBudget) && value.callBudget >= 0 && value.callBudget <= 50
    && value.registryVersion === 'research-tier-a.v1' && capId(value.dailyCapIdentity));
  // Current remaining/day constrain new admission, never hide a historical
  // command that might already have been accepted and only needs GET recovery.
  if (phoneCapability) {
    const cap = validateResearchPhoneCapability(phoneCapability).capability;
    check(cap.enabled && value.dailyCapIdentity === cap.dailyCapIdentity
      && value.callBudget <= cap.remainingCalls);
  }
  return value;
}
export function researchCreatePendingKey(actorUserId) {
  check(actor(actorUserId));
  return `research-party-create:v1:${actorUserId}`;
}
export function researchCreateUrl(href) {
  const url = new URL(href);
  url.searchParams.delete('labAuth');
  url.searchParams.set('researchParty', 'new');
  return url.href;
}
