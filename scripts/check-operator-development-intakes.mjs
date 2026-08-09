import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import {
  buildPlatformDevelopmentIntakeRequest,
  persistPlatformDevelopmentIntakePendingRequest,
  platformDevelopmentIntakeAvailable,
  platformDevelopmentIntakeFailureDisposition,
  platformDevelopmentIntakePendingStorageKey,
  platformDevelopmentIntakeSessionGrant,
  restorePlatformDevelopmentIntakePendingRequest,
  validatePlatformDevelopmentIntakeList,
  validatePlatformDevelopmentIntakeReceipt,
} from '../src/operator-development-intakes.mjs';

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
assert.equal(platformDevelopmentIntakeSessionGrant(true, { buildSha: input.buildSha }, input.buildSha), true);
assert.equal(platformDevelopmentIntakeSessionGrant(
  true, { buildSha: input.buildSha, extra: true }, input.buildSha,
), false);
assert.equal(platformDevelopmentIntakeSessionGrant(true, { buildSha: 'b'.repeat(40) }, input.buildSha), false);
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
values.set(pendingKey, JSON.stringify({ ...persisted, actorUserId: 43 }));
assert.equal(restorePlatformDevelopmentIntakePendingRequest(storage, pendingOptions), null);
assert.equal(values.has(pendingKey), false);
assert.notEqual(
  platformDevelopmentIntakePendingStorageKey({ ...pendingOptions, actorUserId: 43 }),
  pendingKey,
);
values.set(pendingKey, JSON.stringify({ ...persisted, unexpected: true }));
assert.equal(restorePlatformDevelopmentIntakePendingRequest(storage, pendingOptions), null);
assert.equal(values.has(pendingKey), false);
values.set(pendingKey, 'x'.repeat(600_001));
assert.equal(restorePlatformDevelopmentIntakePendingRequest(storage, pendingOptions), null);
assert.equal(values.has(pendingKey), false);

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
