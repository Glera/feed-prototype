import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildOperatorPlayableReworkRequest,
  groupOperatorPlayableReworkQueue,
  isOperatorPlayableReworkQueueItem,
  operatorPlayableReworkControlKey,
  operatorPlayableReworkQueuePresentation,
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
const queueItem = ({ disposition, active, queued, sourceAdapter = 'telegram', blocked = false }) => ({
  requestId: randomUUID(),
  requestHash: '1'.repeat(64),
  state: 'open',
  sourceAdapter,
  queueDisposition: disposition,
  batchPresent: disposition === 'active_batch',
  queueCounts: { active, queued },
  request,
  createdAt: request.context.capturedAt,
  ...(blocked ? {
    execution: {
      state: 'blocked', code: 'manual_authoring_required',
      summary: 'Обычная разработка поставлена в очередь.', updatedAt: request.context.capturedAt,
    },
  } : {}),
});
const active = queueItem({ disposition: 'active_batch', active: 1, queued: 0 });
assert.equal(isOperatorPlayableReworkQueueItem(active, occurrence.playableId), true);
assert.equal(isOperatorPlayableReworkQueueItem({ ...active, sourceAdapter: 'caller' }), false);
assert.deepEqual(operatorPlayableReworkQueuePresentation([active]), {
  state: 'active', label: 'В работе · добавить замечание',
  active: 1, queued: 0, duplicates: 0, unresolved: 1,
});
const activeWithQueued = queueItem({ disposition: 'active_batch', active: 1, queued: 1 });
const queued = queueItem({ disposition: 'queued', active: 1, queued: 1, sourceAdapter: 'codex' });
assert.deepEqual(operatorPlayableReworkQueuePresentation([activeWithQueued, queued]), {
  state: 'queued', label: 'В работе · ещё 1',
  active: 1, queued: 1, duplicates: 0, unresolved: 2,
});
const blocked = queueItem({ disposition: 'active_batch', active: 1, queued: 1, blocked: true });
assert.deepEqual(operatorPlayableReworkQueuePresentation([blocked, queued]), {
  state: 'needs_help', label: 'Нужна помощь · добавить замечание',
  active: 1, queued: 1, duplicates: 0, unresolved: 2,
});
const duplicate = queueItem({ disposition: 'duplicate_of', active: 0, queued: 0 });
assert.deepEqual(operatorPlayableReworkQueuePresentation([duplicate]), {
  state: 'idle', label: '✎ Доработать механику',
  active: 0, queued: 0, duplicates: 1, unresolved: 1,
});
const waiting = {
  ...queueItem({ disposition: 'queued', active: 0, queued: 1, sourceAdapter: 'codex' }),
  createdAt: '2026-08-14T12:05:00.000Z',
};
assert.deepEqual(operatorPlayableReworkQueuePresentation([waiting]), {
  state: 'idle', label: '✎ Доработать механику',
  active: 0, queued: 1, duplicates: 0, unresolved: 1,
});
const staleActiveCount = {
  ...waiting,
  queueCounts: { active: 1, queued: 1 },
};
assert.deepEqual(operatorPlayableReworkQueuePresentation([staleActiveCount]), {
  state: 'idle', label: '✎ Доработать механику',
  active: 0, queued: 1, duplicates: 0, unresolved: 1,
}, 'server count drift cannot invent an active batch without row-level evidence');
const delivered = {
  ...active,
  operatorPresentation: { kind: 'current', effectDelivered: true },
};
assert.deepEqual(operatorPlayableReworkPresentation(delivered), {
  state: 'ready_for_approval', icon: '!', label: 'Готово к проверке', blocker: null,
});
assert.deepEqual(operatorPlayableReworkPresentation({
  ...delivered,
  releaseExecution: {
    releaseId: randomUUID(), state: 'needs_help', code: 'stale_failure',
    summary: 'Устаревший failure.', updatedAt: '2026-08-10T12:30:00.000Z',
  },
}), {
  state: 'ready_for_approval', icon: '!', label: 'Готово к проверке', blocker: null,
}, 'a delivered effect outranks stale preparing/needs-help execution reporting');
assert.deepEqual(operatorPlayableReworkQueuePresentation([delivered]), {
  state: 'ready_for_approval', label: 'Готово к проверке',
  active: 0, queued: 0, duplicates: 0, unresolved: 0,
}, 'a delivered effect cannot remain presented as in progress');
assert.notEqual(
  operatorPlayableReworkControlKey(occurrence, [active]),
  operatorPlayableReworkControlKey(occurrence, [delivered]),
  'a repaired reporting projection must remount the visible control',
);
const superseded = {
  ...active,
  operatorPresentation: { kind: 'superseded', effectDelivered: false },
};
assert.deepEqual(operatorPlayableReworkPresentation(superseded), {
  state: 'superseded', icon: '↪', label: 'Заменена следующей правкой', blocker: null,
});
assert.deepEqual(operatorPlayableReworkQueuePresentation([superseded]), {
  state: 'history', label: 'История правок',
  active: 0, queued: 0, duplicates: 0, unresolved: 0,
});
const coveredGap = {
  ...active,
  operatorPresentation: { kind: 'capability_gap_root_covered', effectDelivered: false },
};
assert.deepEqual(operatorPlayableReworkPresentation(coveredGap), {
  state: 'capability_gap_root_covered', icon: '↪',
  label: 'Историческая заявка · выполнена successor', blocker: null,
});
const openGap = {
  ...active,
  operatorPresentation: { kind: 'capability_gap_root', effectDelivered: false },
};
assert.deepEqual(operatorPlayableReworkQueuePresentation([openGap]), {
  state: 'needs_help', label: 'Нужна помощь · добавить замечание',
  active: 1, queued: 0, duplicates: 0, unresolved: 1,
});
const multiline = {
  ...waiting,
  requestId: randomUUID(),
  createdAt: '2026-08-14T12:10:00.000Z',
  request: { ...request, instruction: 'Первая строка\nВторая строка.' },
};
const successor = {
  ...active,
  requestId: randomUUID(),
  request: { ...request, schema: 'feed.playable-rework.successor.v1' },
};
const malformed = { ...active, requestId: randomUUID(), sourceAdapter: 'caller' };
assert.equal(isOperatorPlayableReworkQueueItem({
  ...active, requestHash: 'short',
}, occurrence.playableId), false);
assert.equal(isOperatorPlayableReworkQueueItem({
  ...active, operatorPresentation: { kind: 'future_state', effectDelivered: false },
}, occurrence.playableId), false);
assert.equal(isOperatorPlayableReworkQueueItem({
  ...active,
  operatorPresentation: { kind: 'current', effectDelivered: false, callerAuthored: true },
}, occurrence.playableId), false);
const groups = groupOperatorPlayableReworkQueue([successor, malformed, waiting, multiline]);
assert.deepEqual([...groups.keys()], [occurrence.playableId]);
assert.deepEqual(
  groups.get(occurrence.playableId).map((item) => item.requestId),
  [multiline.requestId, waiting.requestId],
  'grouping keeps valid multiline feedback, rejects successors and sorts deterministically',
);
console.log('operator playable rework contract: capture + queue assertions passed');
