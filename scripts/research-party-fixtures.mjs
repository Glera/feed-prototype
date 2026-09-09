/** Required Backend golden snapshots. Missing fixtures fail; there is no CI skip. */
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/research-party/research-party-${name}.json`, import.meta.url), 'utf8'));
export const clone = (value) => structuredClone(value);
// Independent test-side canonicalization, never the production validator/hash.
const ordered = (value) => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
export const shortlistGolden = fixture('shortlist-v1.golden');
export const commandGolden = fixture('choice-command-v1.golden');
export const resultGolden = fixture('result-v1.golden');
export const receiptGolden = fixture('choice-receipt-v1.golden');
export const responseGolden = fixture('choice-response-v1.golden');
export const requestId = shortlistGolden.requestId;
export const actor = resultGolden.actorUserId;
export function rehashShortlist(shortlist) {
  const { shortlistHash: ignored, ...payload } = shortlist;
  shortlist.shortlistHash = hash(payload);
  return shortlist;
}
export function readyResult({ count = 5, literal = false } = {}) {
  const result = clone(resultGolden);
  result.choices = [];
  const observations = fixture('normalized-pack-v1.golden').observations;
  while (result.shortlist.candidates.length < count) {
    const used = new Set(result.shortlist.candidates.map((card) => card.primaryObservationId));
    const observation = observations.find((item) => !used.has(item.observationId));
    result.shortlist.candidates.push({
      candidateId: hash({ schema: 'research.candidate-identity.v1', sourceId: observation.sourceId, sourceItemId: observation.sourceItemId }),
      primaryObservationId: observation.observationId, observationIds: [observation.observationId],
      title: `SYNTHETIC extra candidate ${result.shortlist.candidates.length + 1}`,
      summary: 'Synthetic browser coverage, not a live Research observation.', primaryObservation: clone(observation),
    });
  }
  if (literal) {
    result.shortlist.candidates[0].title = '<img src=x onerror=alert(1)> & идея';
    result.shortlist.candidates[0].summary = '<script>alert(2)</script> — обычный текст';
  }
  rehashShortlist(result.shortlist);
  return result;
}
export function choiceCommand(result, index = 0, action = 'select') {
  return { ...clone(commandGolden), mutationId: randomUUID(), requestHash: result.intake.requestHash,
    shortlistHash: result.shortlist.shortlistHash, candidateId: result.shortlist.candidates[index].candidateId, action };
}
export function choiceReceipt(result, command) {
  return { ...clone(receiptGolden), receiptId: randomUUID(), actorUserId: result.actorUserId,
    command: clone(command), commandHash: hash(command) };
}
export function pendingRecord(result, command) {
  return { schema: 'research.party-choice-pending.v1', actorUserId: result.actorUserId, command };
}
