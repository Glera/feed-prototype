import assert from 'node:assert/strict';

if (!globalThis.btoa) globalThis.btoa = (value) => Buffer.from(value, 'binary').toString('base64');
if (!globalThis.atob) globalThis.atob = (value) => Buffer.from(value, 'base64').toString('binary');

const {
  CANDIDATE_FEED_START_PARAM_LENGTH,
  candidateFeedStartParamRequested,
  decodeCandidateFeedStartParam,
  encodeCandidateFeedStartParam,
} = await import('../src/candidate-feed-start-param.mjs');

const identity = {
  releaseId: '8b447be0-f961-582e-aa03-b419d5f1492d',
  reviewBindingDigest: 'c'.repeat(64),
};
const startParam = encodeCandidateFeedStartParam(identity);
assert.equal(startParam.length, CANDIDATE_FEED_START_PARAM_LENGTH);
assert.match(startParam, /^_[A-Za-z0-9_-]{63}$/);
assert.deepEqual(decodeCandidateFeedStartParam(startParam), identity);
assert.equal(candidateFeedStartParamRequested(startParam), true);
assert.equal(candidateFeedStartParamRequested('pr_fe7b8f9f-632d-5e88-b382-0405fb9156e9'), false);
assert.equal(candidateFeedStartParamRequested('diag'), false);
assert.equal(candidateFeedStartParamRequested('_tgr_campaign'), false);
assert.equal(decodeCandidateFeedStartParam('diag'), null);

for (const malformed of [
  startParam.slice(0, -1),
  `${startParam}A`,
  `${startParam.slice(0, 18)}!${startParam.slice(19)}`,
]) {
  assert.equal(candidateFeedStartParamRequested(malformed), true);
  assert.throws(() => decodeCandidateFeedStartParam(malformed), /candidate_feed_start_param_invalid/);
}

const tampered = `${startParam.slice(0, -1)}${startParam.endsWith('A') ? 'B' : 'A'}`;
assert.notDeepEqual(decodeCandidateFeedStartParam(tampered), identity);
assert.equal(candidateFeedStartParamRequested(`A${startParam.slice(1)}`), false);
assert.throws(() => encodeCandidateFeedStartParam({
  ...identity,
  releaseId: '8b447be0-f961-482e-aa03-b419d5f1492d',
}), /candidate_feed_start_identity_invalid/);

console.log(`candidate feed start-param contract: PASS (${startParam})`);
