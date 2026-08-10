import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildOperatorPlayableReworkRequest,
  operatorPlayableReworkErrorMessage,
} from '../src/operator-playable-reworks.mjs';

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
const dictatedRequest = buildOperatorPlayableReworkRequest({
  mutationId: randomUUID(),
  occurrence,
  instruction: '  Увеличить точки\n\tв два раза.  ',
  screenshot,
});
assert.equal(dictatedRequest.instruction, 'Увеличить точки в два раза.');
assert.equal(
  operatorPlayableReworkErrorMessage({ code: 'playable_rework_stale' }),
  'Механика изменилась. Закройте форму и откройте её снова.',
);
assert.equal(
  operatorPlayableReworkErrorMessage({ code: 'playable_rework_invalid', message: 'invalid rework input' }),
  'Описание должно содержать от 1 до 2000 символов.',
);
assert.equal(
  operatorPlayableReworkErrorMessage({ status: 0, code: null }),
  'Нет связи с сервером. Задача не сохранена.',
);
assert.equal(
  operatorPlayableReworkErrorMessage({ code: 'request_timeout' }),
  'Сервер не ответил вовремя. Повторите отправку.',
);
assert.throws(() => buildOperatorPlayableReworkRequest({
  mutationId: randomUUID(), occurrence, instruction: 'Нельзя\u0000так', screenshot,
}), (error) => error?.code === 'playable_rework_invalid');
assert.throws(
  () => buildOperatorPlayableReworkRequest({
    mutationId: randomUUID(), occurrence: { ...occurrence, mappingId: 'caller-authored' },
    instruction: 'Поправить.', screenshot,
  }),
  (error) => error?.code === 'playable_rework_invalid',
);
console.log('operator playable rework contract: 10 assertions');
