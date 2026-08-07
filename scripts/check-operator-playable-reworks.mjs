import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildOperatorPlayableReworkRequest } from '../src/operator-playable-reworks.mjs';

const occurrence = {
  playableId: 'solitaire-v1-swipe',
  mappingId: randomUUID(),
  rosterActivationId: randomUUID(),
  runtime: {
    version: 'dee840674f',
    artifactDigest: `sha256:${'1'.repeat(64)}`,
    sourceCommit: '2'.repeat(40),
  },
  feedPosition: 4,
  level: null,
  runId: null,
};
const screenshot = { kind: 'unavailable', reason: 'not_attached', mimeType: null, dataUrl: null };
const request = buildOperatorPlayableReworkRequest({
  mutationId: randomUUID(),
  occurrence,
  instruction: 'Увеличить номиналы карт.',
  screenshot,
});
assert.equal(request.schema, 'feed.playable-rework.request.v1');
assert.equal(request.playableId, occurrence.playableId);
assert.equal(request.context.screenshot.reason, 'not_attached');
assert.throws(
  () => buildOperatorPlayableReworkRequest({
    mutationId: randomUUID(), occurrence, instruction: ' padded ', screenshot,
  }),
  (error) => error?.code === 'playable_rework_invalid',
);
assert.throws(
  () => buildOperatorPlayableReworkRequest({
    mutationId: randomUUID(), occurrence: { ...occurrence, mappingId: 'caller-authored' },
    instruction: 'Поправить.', screenshot,
  }),
  (error) => error?.code === 'playable_rework_invalid',
);
console.log('operator playable rework contract: 5 assertions');
