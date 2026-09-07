/** Research result/choice wire only. Auth, provenance and choices belong to Backend. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ACTOR = /^[1-9][0-9]*$/;
const SOURCES = {
  'poki-charts': ['poki.com'],
  'crazygames-charts': ['crazygames.com', 'www.crazygames.com'],
  'meta-ad-library': ['facebook.com', 'www.facebook.com'],
  'tiktok-creative-center': ['ads.tiktok.com'],
};
const STATES = ['queued', 'send_started', 'outcome_unknown', 'retry_wait', 'confirmed', 'failed_terminal'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const text = (value, max) => typeof value === 'string' && value === value.trim()
  && [...value].length >= 1 && [...value].length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const instant = (value) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const check = (condition) => { if (!condition) throw new Error('research_party_wire_invalid'); };
const unique = (values) => new Set(values).size === values.length;

export function researchPartyRoute({ search = '', startParam = null } = {}) {
  const params = new URLSearchParams(search);
  const fromStart = typeof startParam === 'string' && startParam.startsWith('rp_');
  const fromQuery = params.has('researchParty');
  if (!fromStart && !fromQuery) return { requested: false, requestId: null };
  const queryIds = params.getAll('researchParty');
  const id = fromStart ? startParam.slice(3) : queryIds[0];
  const competing = ['candidateReview', 'missionDemo', 'labAuth', 'candidateFeed',
    'candidateFeedRelease', 'candidateFeedPlayable', 'candidateFeedArtifact', 'candidateFeedBinding']
    .some((key) => params.has(key));
  if (!UUID.test(id || '') || queryIds.length > 1 || competing
    || (fromQuery && queryIds[0] !== id)
    || (!fromStart && startParam != null && startParam !== '')) {
    return { requested: true, requestId: null };
  }
  return { requested: true, requestId: id };
}

export function researchCanonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(researchCanonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${researchCanonicalJson(value[key])}`).join(',')}}`;
  throw new Error('research_party_wire_invalid');
}

export async function researchHash(value) {
  const bytes = new TextEncoder().encode(researchCanonicalJson(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((item) => item.toString(16).padStart(2, '0')).join('');
}

export function researchSourceUrl(sourceId, value) {
  if (typeof value !== 'string' || value.length > 512 || /[^\x21-\x7e]|[\\?#]/.test(value)) return null;
  const match = /^https:\/\/([^/]+)(?:\/.*)?$/.exec(value);
  return match && SOURCES[sourceId]?.includes(match[1]) ? value : null;
}

function artifact(value) {
  check(exact(value, ['repository', 'path', 'commitSha', 'digest'])
    && value.repository === 'Glera/p4g-workspace-meta'
    && typeof value.path === 'string' && value.path.length <= 512
    && /^docs\/research\/\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]{0,63}\/[^\s]+$/.test(value.path)
    && /^[ -~]+$/.test(value.path) && !value.path.includes('//')
    && !/\/(?:\.|\.\.)\//.test(`/${value.path}/`)
    && /^[0-9a-f]{40}$/.test(value.commitSha) && DIGEST.test(value.digest));
}

async function intake(value, requestId) {
  check(exact(value, ['schema', 'requestId', 'mutationId', 'requestHash', 'request', 'delivery',
    'terminal', 'telegram', 'replayed', 'createdAt', 'credentialTransit', 'executionAuthority'])
    && value.schema === 'research.party-intake.response.v1' && value.requestId === requestId
    && UUID.test(value.mutationId) && HASH.test(value.requestHash)
    && typeof value.replayed === 'boolean' && instant(value.createdAt)
    && value.credentialTransit === false && value.executionAuthority === false);
  const request = value.request;
  check(exact(request, ['schema', 'mutationId', 'lens', 'sourceIds', 'callBudget', 'registryVersion', 'dailyCapIdentity'])
    && request.schema === 'research.party-intake.v1' && request.mutationId === value.mutationId
    && ['R', 'D'].includes(request.lens) && Array.isArray(request.sourceIds)
    && request.sourceIds.length >= 1 && request.sourceIds.length <= 4
    && request.sourceIds.every((source) => Object.hasOwn(SOURCES, source)) && unique(request.sourceIds)
    && JSON.stringify(request.sourceIds) === JSON.stringify([...request.sourceIds].sort())
    && Number.isInteger(request.callBudget) && request.callBudget >= 0 && request.callBudget <= 50
    && request.registryVersion === 'research-tier-a.v1'
    && /^research-tier-a:\d{4}-\d{2}-\d{2}:calls-50:v1$/.test(request.dailyCapIdentity)
    && await researchHash(request) === value.requestHash);
  const delivery = value.delivery;
  check(exact(delivery, ['deliveryId', 'status', 'issueUrl']) && UUID.test(delivery.deliveryId)
    && STATES.includes(delivery.status));
  const issue = typeof delivery.issueUrl === 'string'
    ? /^https:\/\/github\.com\/Glera\/p4g-workspace-meta\/issues\/([1-9]\d*)$/.exec(delivery.issueUrl) : null;
  check(delivery.status === 'confirmed' ? Boolean(issue) : delivery.issueUrl === null);
  if (value.terminal === null) { check(value.telegram === null); return; }
  const terminal = value.terminal;
  check(delivery.status === 'confirmed'
    && exact(terminal, ['schema', 'mutationId', 'issueNumber', 'status', 'normalizedPack', 'radar', 'blocker'])
    && terminal.schema === 'research.party-terminal.v1' && UUID.test(terminal.mutationId)
    && Number.isSafeInteger(terminal.issueNumber) && String(terminal.issueNumber) === issue[1]);
  if (terminal.status === 'READY') {
    artifact(terminal.normalizedPack); artifact(terminal.radar);
    check(terminal.blocker === null && terminal.normalizedPack.commitSha === terminal.radar.commitSha
      && terminal.normalizedPack.path !== terminal.radar.path);
  } else {
    check(terminal.status === 'NEEDS_HELP' && terminal.normalizedPack === null && terminal.radar === null
      && exact(terminal.blocker, ['reasonCode', 'safeSummary'])
      && /^[a-z0-9_]{3,64}$/.test(terminal.blocker.reasonCode) && text(terminal.blocker.safeSummary, 240));
  }
  check(exact(value.telegram, ['status', 'providerRef']) && STATES.includes(value.telegram.status)
    && (value.telegram.status === 'confirmed'
      ? typeof value.telegram.providerRef === 'string' && /^[1-9]\d*$/.test(value.telegram.providerRef)
      : value.telegram.providerRef === null));
}

export async function validateResearchShortlist(value) {
  check(exact(value, ['schema', 'requestId', 'requestHash', 'normalizedPack', 'radar', 'policyVersion', 'candidates', 'shortlistHash'])
    && value.schema === 'research.party-shortlist.v1' && UUID.test(value.requestId)
    && HASH.test(value.requestHash) && value.policyVersion === 'research-source-policy.v1'
    && Array.isArray(value.candidates) && value.candidates.length >= 5 && value.candidates.length <= 7
    && HASH.test(value.shortlistHash));
  artifact(value.normalizedPack); artifact(value.radar);
  check(value.normalizedPack.commitSha === value.radar.commitSha && value.normalizedPack.path !== value.radar.path);
  for (const card of value.candidates) {
    check(exact(card, ['candidateId', 'primaryObservationId', 'observationIds', 'title', 'summary', 'primaryObservation'])
      && HASH.test(card.candidateId) && HASH.test(card.primaryObservationId)
      && Array.isArray(card.observationIds) && card.observationIds.length >= 1 && card.observationIds.length <= 30
      && card.observationIds.every((id) => HASH.test(id)) && unique(card.observationIds)
      && card.observationIds.includes(card.primaryObservationId) && text(card.title, 120) && text(card.summary, 480));
    const observation = card.primaryObservation;
    check(exact(observation, ['observationId', 'sourceId', 'sourceItemId', 'sourceUrl', 'observedAt', 'title', 'signal', 'region'])
      && observation.observationId === card.primaryObservationId
      && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(observation.sourceItemId)
      && researchSourceUrl(observation.sourceId, observation.sourceUrl) !== null
      && instant(observation.observedAt) && text(observation.title, 120)
      && text(observation.signal, 480) && text(observation.region, 32));
    check(observation.observationId === await researchHash({ schema: 'research.observation-identity.v1',
      sourceId: observation.sourceId, sourceItemId: observation.sourceItemId, observedAt: observation.observedAt }));
    check(card.candidateId === await researchHash({ schema: 'research.candidate-identity.v1',
      sourceId: observation.sourceId, sourceItemId: observation.sourceItemId }));
  }
  check(unique(value.candidates.map((card) => card.candidateId)));
  const { shortlistHash, ...payload } = value;
  check(await researchHash(payload) === shortlistHash);
  return value;
}

export function validateResearchChoiceCommand(value, shortlist) {
  check(exact(value, ['schema', 'requestId', 'requestHash', 'mutationId', 'shortlistHash', 'candidateId', 'action'])
    && value.schema === 'research.party-choice-command.v1' && UUID.test(value.mutationId)
    && value.requestId === shortlist.requestId && value.requestHash === shortlist.requestHash
    && value.shortlistHash === shortlist.shortlistHash && ['select', 'reject'].includes(value.action)
    && shortlist.candidates.some((card) => card.candidateId === value.candidateId));
  return value;
}

async function receipt(value, result) {
  check(exact(value, ['schema', 'receiptId', 'actorUserId', 'command', 'commandHash', 'recordedAt'])
    && value.schema === 'research.party-choice-receipt.v1' && UUID.test(value.receiptId)
    && value.actorUserId === result.actorUserId && instant(value.recordedAt) && HASH.test(value.commandHash)
    && result.shortlist !== null);
  validateResearchChoiceCommand(value.command, result.shortlist);
  check(await researchHash(value.command) === value.commandHash);
  return value;
}

export async function validateResearchResult(value, requestId) {
  check(UUID.test(requestId) && exact(value, ['schema', 'actorUserId', 'intake', 'shortlist', 'choices'])
    && value.schema === 'research.party-result.v1' && typeof value.actorUserId === 'string'
    && value.actorUserId.length <= 32 && ACTOR.test(value.actorUserId)
    && Array.isArray(value.choices) && value.choices.length <= 7);
  await intake(value.intake, requestId);
  if (value.shortlist === null) check(value.choices.length === 0);
  else {
    await validateResearchShortlist(value.shortlist);
    const terminal = value.intake.terminal;
    check(terminal?.status === 'READY' && terminal.mutationId === value.intake.mutationId
      && value.shortlist.requestId === requestId && value.shortlist.requestHash === value.intake.requestHash
      && researchCanonicalJson(value.shortlist.normalizedPack) === researchCanonicalJson(terminal.normalizedPack)
      && researchCanonicalJson(value.shortlist.radar) === researchCanonicalJson(terminal.radar)
      && value.shortlist.candidates.every((card) => value.intake.request.sourceIds.includes(card.primaryObservation.sourceId)));
  }
  for (const choice of value.choices) await receipt(choice, value);
  check(unique(value.choices.map((choice) => choice.receiptId))
    && unique(value.choices.map((choice) => choice.command.mutationId))
    && unique(value.choices.map((choice) => choice.command.candidateId)));
  return value;
}

export async function validateResearchChoiceResponse(value, result, command) {
  check(exact(value, ['schema', 'choice', 'replayed'])
    && value.schema === 'research.party-choice-response.v1' && typeof value.replayed === 'boolean');
  const verified = await receipt(value.choice, result);
  check(researchCanonicalJson(verified.command) === researchCanonicalJson(command));
  return verified;
}

export function researchPendingKey(actorUserId, requestId) {
  check(typeof actorUserId === 'string' && ACTOR.test(actorUserId) && UUID.test(requestId));
  return `research-party-choice:v1:${actorUserId}:${requestId}`;
}
