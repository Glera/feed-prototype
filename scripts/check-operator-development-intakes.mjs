import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildPlatformDevelopmentIntakeRequest,
  buildPlatformDevelopmentIntakeCancelRequest,
  persistPlatformDevelopmentIntakePendingRequest,
  persistPlatformDevelopmentIntakePendingRequestWithFallback,
  platformDevelopmentIntakeAvailable,
  platformDevelopmentIntakeErrorMessage,
  platformDevelopmentIntakeFailureDisposition,
  platformDevelopmentIntakePendingStorageKey,
  platformDevelopmentIntakeQueuePresentation,
  platformDevelopmentIntakeSessionGrant,
  restorePlatformDevelopmentIntakePendingRequest,
  validatePlatformDevelopmentIntakeList,
  validatePlatformDevelopmentIntakeReceipt,
} from '../src/operator-development-intakes.mjs';
import { platformDevelopmentIntakePresentation } from '../src/operator-presentation-vocabulary.mjs';

const screenshot = { kind: 'unavailable', reason: 'not_attached', mimeType: null, dataUrl: null };
const input = {
  mutationId: randomUUID(),
  instruction: 'Сделать подпись версии заметнее.',
  surface: 'feed',
  route: '/?platform-intake-test=1',
  buildSha: 'a'.repeat(40),
  capturedAt: '2026-08-09T12:34:56.789Z',
  screenshot,
};
const request = buildPlatformDevelopmentIntakeRequest(input);
assert.deepEqual(request, {
  schema: 'platform.development-intake.request.v1',
  ...input,
  screenshot,
});
assert.equal(platformDevelopmentIntakeAvailable(true), true);
assert.equal(platformDevelopmentIntakeAvailable(1), false);
assert.equal(platformDevelopmentIntakeSessionGrant(
  true, { contract: 'platform.development-intake.request.v1' }, input.buildSha,
), true);
assert.equal(platformDevelopmentIntakeSessionGrant(
  true, { buildSha: input.buildSha }, input.buildSha,
), true, 'the transitional client must accept the exact legacy build pin');
assert.equal(platformDevelopmentIntakeSessionGrant(
  true, { buildSha: 'b'.repeat(40) }, input.buildSha,
), false);
assert.equal(platformDevelopmentIntakeSessionGrant(
  true, { contract: 'platform.development-intake.request.v1', extra: true }, input.buildSha,
), false);
assert.equal(platformDevelopmentIntakeSessionGrant(
  true, { contract: 'platform.development-intake.request.v2' }, input.buildSha,
), false);
assert.throws(
  () => buildPlatformDevelopmentIntakeRequest({ ...input, buildSha: 'short' }),
  (error) => error?.code === 'development_intake_invalid',
);
assert.throws(
  () => buildPlatformDevelopmentIntakeRequest({ ...input, instruction: ' padded ' }),
  (error) => error?.code === 'development_intake_invalid',
);
assert.throws(
  () => buildPlatformDevelopmentIntakeRequest({ ...input, route: 'https://outside.example/' }),
  (error) => error?.code === 'development_intake_invalid',
);
assert.equal(
  platformDevelopmentIntakeErrorMessage({ code: 'development_intake_invalid' }),
  'Описание должно содержать от 1 до 2000 символов.',
);
assert.equal(
  platformDevelopmentIntakeErrorMessage({ code: 'development_intake_pending_not_persisted' }),
  'Память Mini App недоступна. Скопируйте текст и перезапустите Mini App.',
);

const pendingOptions = {
  actorUserId: 42,
  buildSha: input.buildSha,
  route: input.route,
  surface: input.surface,
};
const values = new Map();
const storage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
  removeItem: (key) => values.delete(key),
};
assert.equal(persistPlatformDevelopmentIntakePendingRequest(storage, pendingOptions, request), true);
assert.deepEqual(restorePlatformDevelopmentIntakePendingRequest(storage, pendingOptions), request);
const pendingKey = platformDevelopmentIntakePendingStorageKey(pendingOptions);
const persisted = JSON.parse(values.get(pendingKey));
assert.deepEqual(persisted, {
  schema: 'platform.development-intake.pending.v1',
  actorUserId: 42,
  request,
});
const changedRouteOptions = { ...pendingOptions, route: '/?different-entry=1' };
assert.equal(platformDevelopmentIntakePendingStorageKey(changedRouteOptions), pendingKey);
assert.deepEqual(
  restorePlatformDevelopmentIntakePendingRequest(storage, changedRouteOptions),
  request,
  'a Telegram relaunch route must not orphan the immutable pending request',
);
values.set(pendingKey, JSON.stringify({ ...persisted, actorUserId: 43 }));
assert.equal(restorePlatformDevelopmentIntakePendingRequest(storage, pendingOptions), null);
assert.equal(values.has(pendingKey), false);
assert.notEqual(
  platformDevelopmentIntakePendingStorageKey({ ...pendingOptions, actorUserId: 43 }),
  pendingKey,
);
const unavailableStorage = {
  getItem: () => null,
  setItem: () => { throw new Error('quota exceeded'); },
};
const fallbackValues = new Map();
const fallbackStorage = {
  getItem: (key) => fallbackValues.get(key) ?? null,
  setItem: (key, value) => fallbackValues.set(key, value),
};
assert.equal(
  persistPlatformDevelopmentIntakePendingRequestWithFallback(
    unavailableStorage, fallbackStorage, pendingOptions, request,
  ),
  'fallback',
  'a full/unavailable durable store must fall back to the WebView session store',
);
assert.equal(
  persistPlatformDevelopmentIntakePendingRequestWithFallback(
    unavailableStorage, unavailableStorage, pendingOptions, request,
  ),
  null,
  'submission must remain fail-closed when neither pending store is writable',
);
values.set(pendingKey, JSON.stringify({ ...persisted, unexpected: true }));
assert.equal(restorePlatformDevelopmentIntakePendingRequest(storage, pendingOptions), null);
assert.equal(values.has(pendingKey), false);
values.set(pendingKey, 'x'.repeat(600_001));
assert.equal(restorePlatformDevelopmentIntakePendingRequest(storage, pendingOptions), null);
assert.equal(values.has(pendingKey), false);

// A locally prepared screenshot is the whole transport: there is no upload, so
// the inline data URL must stay inside the exact request wire budget and still
// fit the immutable pending record that survives a lost response.
const DATA_URL_PREFIX = 'data:image/jpeg;base64,';
const jpegDataUrl = (chars) => `${DATA_URL_PREFIX}${'A'.repeat(chars - DATA_URL_PREFIX.length)}`;
const preparedScreenshot = {
  kind: 'data_url', reason: null, mimeType: 'image/jpeg', dataUrl: jpegDataUrl(500_000),
};
const preparedRequest = buildPlatformDevelopmentIntakeRequest({
  ...input, mutationId: randomUUID(), screenshot: preparedScreenshot,
});
assert.deepEqual(preparedRequest.screenshot, preparedScreenshot);
assert.doesNotThrow(() => buildPlatformDevelopmentIntakeRequest({
  ...input,
  mutationId: randomUUID(),
  screenshot: { ...preparedScreenshot, dataUrl: jpegDataUrl(524_288) },
}));
assert.throws(
  () => buildPlatformDevelopmentIntakeRequest({
    ...input,
    mutationId: randomUUID(),
    screenshot: { ...preparedScreenshot, dataUrl: jpegDataUrl(524_289) },
  }),
  (error) => error?.code === 'development_intake_invalid',
  'the request wire budget for one inline screenshot must stay exact',
);
assert.throws(
  () => buildPlatformDevelopmentIntakeRequest({
    ...input, mutationId: randomUUID(), screenshot: { ...preparedScreenshot, mimeType: 'image/webp' },
  }),
  (error) => error?.code === 'development_intake_invalid',
);
assert.throws(
  () => buildPlatformDevelopmentIntakeRequest({
    ...input, mutationId: randomUUID(), screenshot: { ...preparedScreenshot, mimeType: 'image/png' },
  }),
  (error) => error?.code === 'development_intake_invalid',
  'the declared mime type must bind the exact data URL prefix',
);
assert.equal(
  persistPlatformDevelopmentIntakePendingRequest(storage, pendingOptions, preparedRequest),
  true,
  'a prepared screenshot must fit the durable pending record',
);
assert.deepEqual(
  restorePlatformDevelopmentIntakePendingRequest(storage, pendingOptions),
  preparedRequest,
);
values.delete(pendingKey);

const receipt = {
  schema: 'platform.development-intake.response.v1',
  requestId: '11111111-1111-5111-8111-111111111111',
  mutationId: request.mutationId,
  requestHash: 'c'.repeat(64),
  delivery: {
    deliveryId: '22222222-2222-5222-8222-222222222222',
    status: 'queued',
    issueUrl: null,
    nothingPublished: true,
  },
  terminal: null,
  request,
  replayed: false,
  createdAt: '2026-08-09T12:34:57.000Z',
};
assert.deepEqual(validatePlatformDevelopmentIntakeReceipt(receipt, request), receipt);
assert.deepEqual(validatePlatformDevelopmentIntakeList({
  schema: 'platform.development-intake.list.v1', items: [receipt],
}).items, [receipt]);
const cancellation = buildPlatformDevelopmentIntakeCancelRequest({
  mutationId: randomUUID(), requestHash: receipt.requestHash,
});
assert.deepEqual(cancellation, {
  schema: 'platform.development-intake.cancel.v1',
  mutationId: cancellation.mutationId,
  requestHash: receipt.requestHash,
  reason: 'obsolete',
});
const cancelledReceipt = {
  ...receipt,
  cancellation: {
    mutationId: cancellation.mutationId,
    status: 'confirmed',
    reason: 'obsolete',
    requestedAt: '2026-08-09T12:35:00.000Z',
    cancelledAt: '2026-08-09T12:35:00.000Z',
    issueClosed: false,
    lastErrorCode: null,
  },
};
assert.equal(
  validatePlatformDevelopmentIntakeReceipt(cancelledReceipt).cancellation.status,
  'confirmed',
);
assert.throws(
  () => validatePlatformDevelopmentIntakeReceipt({
    ...cancelledReceipt,
    cancellation: { ...cancelledReceipt.cancellation, cancelledAt: null },
  }),
  (error) => error?.code === 'development_intake_receipt_invalid',
);
assert.throws(
  () => validatePlatformDevelopmentIntakeReceipt({
    ...cancelledReceipt,
    cancellation: { ...cancelledReceipt.cancellation, issueClosed: true },
  }),
  (error) => error?.code === 'development_intake_receipt_invalid',
  'a closed Issue requires an exact confirmed delivery URL',
);
assert.throws(
  () => validatePlatformDevelopmentIntakeReceipt({
    ...cancelledReceipt,
    cancellation: {
      ...cancelledReceipt.cancellation, status: 'queued', cancelledAt: '2026-08-09T12:35:00.000Z',
    },
  }),
  (error) => error?.code === 'development_intake_receipt_invalid',
  'a non-confirmed cancellation cannot carry a terminal timestamp',
);
const readyReceipt = {
  ...receipt,
  delivery: {
    ...receipt.delivery,
    status: 'confirmed',
    issueUrl: 'https://github.com/Glera/p4g-workspace-meta/issues/17',
  },
  terminal: {
    status: 'READY_TO_PLAY',
    summary: 'Bounded candidate is ready for operator testing.',
    candidate: {
      repository: 'Glera/feed-prototype',
      commitSha: 'd'.repeat(40),
      artifactDigest: `sha256:${'e'.repeat(64)}`,
      url: 'https://example.test/candidate/17',
    },
    blocker: null,
    review: {
      provider: 'claude',
      verdict: 'APPROVE',
      patchDigest: `sha256:${'f'.repeat(64)}`,
      reviewedAt: '2026-08-09T12:35:00.000Z',
    },
    recordedAt: '2026-08-09T12:35:01.000Z',
    nothingPublished: true,
  },
};
assert.equal(
  validatePlatformDevelopmentIntakeReceipt(readyReceipt).terminal.status,
  'READY_TO_PLAY',
);
const liveReceipt = {
  ...readyReceipt,
  delivery: { ...readyReceipt.delivery, nothingPublished: false },
  terminal: {
    ...readyReceipt.terminal,
    review: {
      provider: 'platform-delivery',
      verdict: 'LIVE',
      platformCommitSha: 'a'.repeat(40),
      deployedAt: '2026-08-09T12:35:01.000Z',
      stageTimings: {
        queueSeconds: 5,
        authoringSeconds: 20,
        ciMergeSeconds: 15,
        rolloutSeconds: 20,
        totalSeconds: 60,
      },
    },
    nothingPublished: false,
  },
};
assert.equal(
  validatePlatformDevelopmentIntakeReceipt(liveReceipt).terminal.review.verdict,
  'LIVE',
  'a proven live rollout must be distinct from the pre-publication terminal',
);

const queueReceipt = ({
  requestId, issueNumber = null, createdAt, terminal = null,
  deliveryStatus = issueNumber === null ? 'queued' : 'confirmed',
  cancellation: itemCancellation = null,
}) => ({
  ...receipt,
  requestId,
  createdAt,
  delivery: {
    ...receipt.delivery,
    status: deliveryStatus,
    issueUrl: issueNumber === null
      ? null : `https://github.com/Glera/p4g-workspace-meta/issues/${issueNumber}`,
  },
  terminal,
  ...(itemCancellation === null ? {} : { cancellation: itemCancellation }),
});
const successfulQueueReceipt = queueReceipt({
  requestId: '17171717-1717-5171-8171-171717171717',
  issueNumber: 17,
  createdAt: '2026-08-09T12:35:00.000Z',
  terminal: readyReceipt.terminal,
});
const legacyTerminalGap = queueReceipt({
  requestId: '16161616-1616-5161-8161-161616161616',
  issueNumber: 16,
  createdAt: '2026-08-09T12:34:00.000Z',
});
const newerConfirmedWork = queueReceipt({
  requestId: '18181818-1818-5181-8181-181818181818',
  issueNumber: 18,
  createdAt: '2026-08-09T12:36:00.000Z',
});
const retryingDelivery = queueReceipt({
  requestId: '15151515-1515-5151-8151-151515151515',
  createdAt: '2026-08-09T12:33:00.000Z',
  deliveryStatus: 'retry_wait',
});
const olderNeedsHelp = queueReceipt({
  requestId: '14141414-1414-5141-8141-141414141414',
  issueNumber: 14,
  createdAt: '2026-08-09T12:32:00.000Z',
  terminal: {
    ...readyReceipt.terminal,
    status: 'NEEDS_HELP',
    candidate: null,
    blocker: { reasonCode: 'operator_action_required', operatorAction: 'Проверьте задачу.' },
    review: null,
  },
});
const queueRows = platformDevelopmentIntakeQueuePresentation([
  legacyTerminalGap,
  successfulQueueReceipt,
  newerConfirmedWork,
  retryingDelivery,
  olderNeedsHelp,
  cancelledReceipt,
]);
assert.deepEqual(queueRows.map(({ receipt: item }) => item.requestId), [
  olderNeedsHelp.requestId,
  retryingDelivery.requestId,
  newerConfirmedWork.requestId,
], 'the Issue FIFO watermark must hide only confirmed legacy gaps');
assert.deepEqual(queueRows.map(({ label }) => label), [
  'Нужна помощь', 'В работе', 'В очереди · №1',
]);
assert.deepEqual(
  platformDevelopmentIntakeQueuePresentation([legacyTerminalGap, successfulQueueReceipt]),
  [],
  'a successful terminal plus older legacy gaps must render an empty active queue',
);
assert.throws(
  () => validatePlatformDevelopmentIntakeReceipt({
    ...liveReceipt,
    delivery: { ...liveReceipt.delivery, nothingPublished: true },
  }),
  (error) => error?.code === 'development_intake_receipt_invalid',
  'the delivery and terminal publication states must be byte-consistent',
);

const pendingCancellation = {
  mutationId: cancellation.mutationId,
  status: 'queued',
  reason: 'obsolete',
  requestedAt: '2026-08-09T12:35:00.000Z',
  cancelledAt: null,
  issueClosed: false,
  lastErrorCode: null,
};
const needsHelpDuringCancellation = platformDevelopmentIntakePresentation({
  ...readyReceipt,
  terminal: {
    status: 'NEEDS_HELP',
    summary: 'Нужна ручная проверка конфигурации.',
    candidate: null,
    blocker: {
      code: 'operator_action_required',
      operatorAction: 'Проверьте конфигурацию доступа.',
    },
    review: null,
    recordedAt: '2026-08-09T12:35:01.000Z',
    nothingPublished: true,
  },
  cancellation: pendingCancellation,
});
assert.equal(needsHelpDuringCancellation.state, 'needsHelp');
assert.equal(needsHelpDuringCancellation.blocker, 'Проверьте конфигурацию доступа.');
assert.match(needsHelpDuringCancellation.detail, /Нужна ручная проверка конфигурации/);

const deliveryFailureDuringCancellation = platformDevelopmentIntakePresentation({
  ...readyReceipt,
  delivery: { ...readyReceipt.delivery, status: 'failed_terminal', issueUrl: null },
  cancellation: pendingCancellation,
});
assert.equal(deliveryFailureDuringCancellation.state, 'needsHelp');
assert.match(deliveryFailureDuringCancellation.detail, /изменения не опубликованы/);
assert.match(deliveryFailureDuringCancellation.blocker, /Нужна помощь/);
assert.throws(
  () => validatePlatformDevelopmentIntakeReceipt({
    ...readyReceipt,
    terminal: {
      ...readyReceipt.terminal,
      candidate: { ...readyReceipt.terminal.candidate, commitSha: 'short' },
    },
  }),
  (error) => error?.code === 'development_intake_receipt_invalid',
);
assert.throws(
  () => validatePlatformDevelopmentIntakeReceipt({ ...receipt, unexpected: true }),
  (error) => error?.code === 'development_intake_receipt_invalid',
);
assert.throws(
  () => validatePlatformDevelopmentIntakeReceipt({
    ...receipt,
    delivery: { ...receipt.delivery, status: 'confirmed', issueUrl: null },
  }),
  (error) => error?.code === 'development_intake_receipt_invalid',
);
assert.doesNotThrow(() => validatePlatformDevelopmentIntakeReceipt({
  ...receipt,
  delivery: {
    ...receipt.delivery,
    status: 'confirmed',
    issueUrl: 'https://github.com/Glera/p4g-workspace-meta/issues/17',
  },
}));
const futureClockRequest = buildPlatformDevelopmentIntakeRequest({
  ...input,
  mutationId: randomUUID(),
  capturedAt: '2099-08-09T12:34:56.789Z',
});
assert.doesNotThrow(() => validatePlatformDevelopmentIntakeReceipt({
  ...receipt,
  mutationId: futureClockRequest.mutationId,
  request: futureClockRequest,
  createdAt: '2026-08-09T12:34:57.000Z',
}, futureClockRequest));
assert.equal(platformDevelopmentIntakeFailureDisposition({ status: 422 }), 'rejected');
assert.equal(platformDevelopmentIntakeFailureDisposition({ status: 409 }), 'rejected');
assert.equal(platformDevelopmentIntakeFailureDisposition({ status: 408 }), 'retry');
assert.equal(platformDevelopmentIntakeFailureDisposition({ status: 425 }), 'retry');
assert.equal(platformDevelopmentIntakeFailureDisposition({ status: 429 }), 'retry');
assert.equal(platformDevelopmentIntakeFailureDisposition({ status: 503 }), 'retry');
assert.equal(platformDevelopmentIntakeFailureDisposition({ status: 0 }), 'retry');

console.log('operator development intake contract: actor-scoped pending, strict receipts, and failure disposition verified');
