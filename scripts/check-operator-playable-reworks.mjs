import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildOperatorPlayableReworkRequest,
  operatorPlayableReworkPresentation,
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
assert.equal(
  operatorPlayableReworkErrorMessage({ code: 'playable_rework_screenshot_invalid' }),
  'Не удалось обработать скриншот. Выберите другое изображение.',
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
const projected = (state) => ({
  releaseExecution: {
    releaseId: randomUUID(),
    state,
    code: state === 'needs_help' ? 'candidate_failed' : null,
    summary: state === 'needs_help' ? 'Проверка candidate остановилась.' : null,
    updatedAt: '2026-08-10T12:30:00.000Z',
  },
  state: 'open',
  execution: { state: 'accepted', code: null, summary: null, updatedAt: null },
});
assert.deepEqual(operatorPlayableReworkPresentation(projected('preparing')), {
  state: 'preparing', icon: '…', label: 'Готовится', blocker: null,
});
assert.deepEqual(operatorPlayableReworkPresentation(projected('ready_for_approval')), {
  state: 'ready_for_approval', icon: '!', label: 'Готово к проверке', blocker: null,
});
assert.deepEqual(operatorPlayableReworkPresentation(projected('needs_help')), {
  state: 'needs_help', icon: '!', label: 'Нужна помощь', blocker: 'Проверка candidate остановилась.',
});
assert.deepEqual(operatorPlayableReworkPresentation({
  state: 'claimed',
  execution: { state: 'accepted', code: null, summary: null, updatedAt: null },
}), { state: 'claimed', icon: '✓', label: 'Задача принята', blocker: null });
console.log('operator playable rework contract: 15 assertions');
