import assert from 'node:assert/strict';
import {
  researchPartyRoute, researchSourceUrl, researchHash, researchPendingKey,
  validateResearchShortlist, validateResearchResult, validateResearchChoiceCommand, validateResearchChoiceResponse,
} from '../src/research-party.mjs';
import { actor, requestId, clone, hash, readyResult, rehashShortlist, shortlistGolden,
  commandGolden, resultGolden, receiptGolden, responseGolden, choiceCommand, choiceReceipt } from './research-party-fixtures.mjs';

assert.deepEqual(researchPartyRoute(), { requested: false, requestId: null });
for (const input of [{ startParam: `rp_${requestId}` }, { search: `?researchParty=${requestId}` },
  { startParam: `rp_${requestId}`, search: `?researchParty=${requestId}` }]) {
  assert.deepEqual(researchPartyRoute(input), { requested: true, requestId });
}
for (const input of [{ startParam: 'rp_' }, { startParam: 'rp_1880000A-0000-4000-8000-000000000930' },
  { search: '?researchParty=' }, { search: `?researchParty=${requestId}&researchParty=${requestId}` },
  { startParam: 'mission_demo', search: `?researchParty=${requestId}` },
  { startParam: `rp_${requestId}`, search: '?researchParty=18800000-0000-4000-8000-000000000999' },
  ...['candidateReview', 'labAuth', 'missionDemo', 'candidateFeedRelease', 'candidateFeedBinding'].map((key) =>
    ({ search: `?researchParty=${requestId}&${key}=anything` }))]) {
  assert.deepEqual(researchPartyRoute(input), { requested: true, requestId: null }, JSON.stringify(input));
}
assert.deepEqual(await validateResearchShortlist(shortlistGolden), shortlistGolden);
assert.deepEqual(validateResearchChoiceCommand(commandGolden, shortlistGolden), commandGolden);
assert.deepEqual(await validateResearchResult(resultGolden, requestId), resultGolden);
assert.deepEqual(await validateResearchChoiceResponse(responseGolden, resultGolden, commandGolden), receiptGolden);
assert.equal(await researchHash(commandGolden), hash(commandGolden));
assert.equal(researchPendingKey(actor, requestId), `research-party-choice:v1:${actor}:${requestId}`);
assert.throws(() => researchPendingKey('0', requestId));
const rejectResult = async (mutate) => {
  const result = readyResult(); mutate(result);
  await assert.rejects(validateResearchResult(result, requestId), /wire_invalid/);
};
const rejectShortlist = async (mutate) => {
  const value = clone(shortlistGolden); mutate(value); rehashShortlist(value);
  await assert.rejects(validateResearchShortlist(value), /wire_invalid/);
};
await validateResearchResult(readyResult({ count: 7, literal: true }), requestId);
await rejectShortlist((value) => value.candidates.pop());
await rejectShortlist((value) => value.candidates.push(...value.candidates.slice(0, 3)));
await rejectShortlist((value) => { value.candidates[1] = clone(value.candidates[0]); });
await rejectShortlist((value) => { value.candidates[0].candidateId = '0'.repeat(64); });
await rejectShortlist((value) => { value.candidates[0].primaryObservation.observedAt = '2026-02-31T00:00:00.000Z'; });
await rejectShortlist((value) => { value.candidates[0].title = 'x'.repeat(121); });
await rejectShortlist((value) => { value.candidates[0].summary = 'hidden\ncontrol'; });
await rejectShortlist((value) => { value.candidates[0].primaryObservationId = '0'.repeat(64); });
await rejectShortlist((value) => { value.normalizedPack.path = 'docs/research/2026-09-08-fixture/../pack.json'; });
await rejectShortlist((value) => { value.radar.commitSha = 'b'.repeat(40); });
for (const sourceUrl of ['javascript:alert(1)', 'http://poki.com/x', 'https://evil.test/x',
  'https://poki.com.evil.test/x', 'https://u@poki.com/x', 'https://poki.com:443/x',
  'https://poki.com/x?', 'https://poki.com/x#', 'https://poki.com\\evil', 'https://poki.com/x y']) {
  assert.equal(researchSourceUrl('poki-charts', sourceUrl), null);
  await rejectShortlist((value) => { value.candidates[0].primaryObservation.sourceUrl = sourceUrl; });
}
await rejectResult((result) => { result.actorUserId = 42; });
await rejectResult((result) => { result.intake.requestHash = '0'.repeat(64); });
await rejectResult((result) => { result.shortlist.shortlistHash = '0'.repeat(64); });
await rejectResult((result) => { result.intake.terminal.normalizedPack.digest = `sha256:${'0'.repeat(64)}`; });
await rejectResult((result) => { result.intake.extra = true; });
await rejectResult((result) => { result.intake.terminal.mutationId = '18800000-0000-4000-8000-000000000998'; });
const legacy = readyResult(); legacy.shortlist = null;
legacy.intake.terminal.mutationId = '18800000-0000-4000-8000-000000000998';
await validateResearchResult(legacy, requestId);
const pending = readyResult(); pending.shortlist = null; pending.intake.terminal = null; pending.intake.telegram = null;
await validateResearchResult(pending, requestId);
const help = clone(pending); help.intake.terminal = { schema: 'research.party-terminal.v1', mutationId: help.intake.mutationId,
  issueNumber: Number(help.intake.delivery.issueUrl.split('/').pop()), status: 'NEEDS_HELP', normalizedPack: null,
  radar: null, blocker: { reasonCode: 'synthetic_blocker', safeSummary: '<b>Not HTML</b>' } };
help.intake.telegram = { status: 'queued', providerRef: null };
await validateResearchResult(help, requestId);
for (const field of ['requestHash', 'shortlistHash', 'candidateId']) {
  assert.throws(() => validateResearchChoiceCommand({ ...commandGolden, [field]: '0'.repeat(64) }, shortlistGolden));
}
assert.throws(() => validateResearchChoiceCommand({ ...commandGolden, action: 'copy' }, shortlistGolden));
const chosen = readyResult();
chosen.choices = [choiceReceipt(chosen, choiceCommand(chosen, 0)), choiceReceipt(chosen, choiceCommand(chosen, 1, 'reject'))];
await validateResearchResult(chosen, requestId);
const duplicates = clone(chosen); duplicates.choices.push(clone(duplicates.choices[0]));
await assert.rejects(validateResearchResult(duplicates, requestId));
const corruptReceipt = clone(responseGolden); corruptReceipt.choice.commandHash = '0'.repeat(64);
await assert.rejects(validateResearchChoiceResponse(corruptReceipt, resultGolden, commandGolden));
const foreignReceipt = clone(responseGolden); foreignReceipt.choice.actorUserId = '999999';
await assert.rejects(validateResearchChoiceResponse(foreignReceipt, resultGolden, commandGolden));
console.log('research-party: PASS (Backend exact goldens; closed shapes, identities, URLs, legacy results and immutable choices)');
