import assert from 'node:assert/strict';

import {
  OperatorLevelFlagContractError,
  buildOperatorLevelFlagRequest,
  operatorLevelFlagOccurrenceKey,
  operatorLevelFlagErrorMessage,
  operatorLevelFlaggingAvailable,
  validateOperatorLevelFlagResponse,
} from '../src/operator-level-flags.mjs';

const occurrence = {
  flagSurface: 'active_level',
  decisionId: '10000000-0000-4000-8000-000000000001',
  contentImpressionId: '10000000-0000-4000-8000-000000000002',
  catalogEntryId: '10000000-0000-4000-8000-000000000003',
  seriesId: '10000000-0000-4000-8000-000000000004',
  ordinal: 2,
  levelSpecHash: 'a'.repeat(64),
  skinHash: 'b'.repeat(64),
  levelEventId: '10000000-0000-4000-8000-000000000010',
  levelImpressionId: '10000000-0000-4000-8000-000000000005',
  runId: '10000000-0000-4000-8000-000000000006',
  attemptEventId: '10000000-0000-4000-8000-000000000011',
};
assert.equal(
  operatorLevelFlagOccurrenceKey(occurrence),
  operatorLevelFlagOccurrenceKey({
    runId: occurrence.runId,
    levelImpressionId: occurrence.levelImpressionId,
    skinHash: occurrence.skinHash,
    levelEventId: occurrence.levelEventId,
    levelSpecHash: occurrence.levelSpecHash,
    ordinal: occurrence.ordinal,
    seriesId: occurrence.seriesId,
    catalogEntryId: occurrence.catalogEntryId,
    contentImpressionId: occurrence.contentImpressionId,
    decisionId: occurrence.decisionId,
    flagSurface: occurrence.flagSurface,
    attemptEventId: occurrence.attemptEventId,
  }),
  'occurrence identity must not depend on caller object key order',
);
const request = buildOperatorLevelFlagRequest({
  mutationId: '10000000-0000-4000-8000-000000000007',
  intent: 'edit_candidate',
  comment: 'Слишком похож на предыдущий уровень',
  occurrence,
});
assert.equal(Object.isFrozen(request), true);
assert.deepEqual(request, {
  schema: 'catalog.operator-flag.request.v1',
  mutationId: '10000000-0000-4000-8000-000000000007',
  intent: 'edit_candidate',
  comment: 'Слишком похож на предыдущий уровень',
  flagSurface: 'active_level',
  subject: {
    catalogEntryId: occurrence.catalogEntryId,
    seriesId: occurrence.seriesId,
    ordinal: 2,
    levelSpecHash: occurrence.levelSpecHash,
    skinHash: occurrence.skinHash,
  },
  causal: {
    decisionId: occurrence.decisionId,
    contentImpressionId: occurrence.contentImpressionId,
    levelImpressionId: occurrence.levelImpressionId,
    runId: occurrence.runId,
  },
});
const previewOccurrence = {
  ...occurrence,
  flagSurface: 'preview',
  levelImpressionId: null,
  runId: null,
  attemptEventId: null,
};
const previewRequest = buildOperatorLevelFlagRequest({
  mutationId: '10000000-0000-4000-8000-000000000009',
  intent: 'delete_candidate',
  comment: 'Превью выглядит слишком знакомым',
  occurrence: previewOccurrence,
});
assert.equal(previewRequest.flagSurface, 'preview');
assert.equal(previewRequest.causal.levelImpressionId, null);
assert.equal(previewRequest.causal.runId, null);
for (const invalidOccurrence of [
  { ...previewOccurrence, levelImpressionId: occurrence.levelImpressionId },
  { ...previewOccurrence, runId: occurrence.runId },
  { ...occurrence, levelImpressionId: null },
]) {
  assert.throws(
    () => buildOperatorLevelFlagRequest({ ...request, occurrence: invalidOccurrence }),
    (error) => error instanceof OperatorLevelFlagContractError && error.code === 'invalid_surface',
  );
}
assert.throws(
  () => buildOperatorLevelFlagRequest({
    ...request,
    occurrence: { ...occurrence, attemptEventId: null },
  }),
  (error) => error instanceof OperatorLevelFlagContractError && error.code === 'invalid_occurrence',
);

for (const comment of ['', ' padded', 'padded ', 'a\nline', 'x'.repeat(2001)]) {
  assert.throws(
    () => buildOperatorLevelFlagRequest({ ...request, comment, occurrence }),
    (error) => error instanceof OperatorLevelFlagContractError && error.code === 'invalid_comment',
  );
}
const exactEmojiBoundary = '😀'.repeat(2_000);
assert.equal(new TextEncoder().encode(exactEmojiBoundary).length, 8_000);
assert.equal(buildOperatorLevelFlagRequest({
  ...request,
  comment: exactEmojiBoundary,
  occurrence,
}).comment, exactEmojiBoundary, '2000 Unicode code points at the 8000-byte boundary must be valid');
assert.throws(
  () => buildOperatorLevelFlagRequest({
    ...request,
    comment: `${exactEmojiBoundary}a`,
    occurrence,
  }),
  (error) => error instanceof OperatorLevelFlagContractError && error.code === 'invalid_comment',
  '2001 Unicode code points must be rejected even when UTF-16 length differs',
);
assert.equal(operatorLevelFlaggingAvailable(true), true);
for (const value of [false, 1, 'true', null, undefined, {}]) {
  assert.equal(operatorLevelFlaggingAvailable(value), false);
}

const response = {
  schema: 'catalog.operator-flag.v1',
  flagId: '10000000-0000-4000-8000-000000000008',
  mutationId: request.mutationId,
  requestHash: 'c'.repeat(64),
  actorUserId: 42,
  intent: request.intent,
  comment: request.comment,
  flagSurface: request.flagSurface,
  subject: request.subject,
  causal: request.causal,
  createdAt: '2026-07-16T12:00:00.000Z',
  replayed: false,
};
assert.equal(validateOperatorLevelFlagResponse(response, request).mutationId, request.mutationId);
assert.throws(
  () => validateOperatorLevelFlagResponse({ ...response, causal: { ...response.causal, runId: null } }, request),
  (error) => error instanceof OperatorLevelFlagContractError && error.code === 'invalid_response',
);
assert.equal(operatorLevelFlagErrorMessage({ status: 0 }), 'Нет соединения. Попробуйте ещё раз.');
assert.ok(operatorLevelFlagErrorMessage({ status: 500 }).length < 120);

console.log('operator level flags: preview/active occurrence, Unicode bounds and capability verified');
