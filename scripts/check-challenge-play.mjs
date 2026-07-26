/**
 * Challenge play-orchestration contract check: the exact recipient/source wire
 * sequence, and the non-negotiable invariant that verifyBundleIdentity is awaited
 * BEFORE mountLevel — a mismatch aborts with nothing mounted/played/reported.
 */
import assert from 'node:assert/strict';

import {
  ChallengePlayError,
  playRecipientChallenge,
  playSourceChallenge,
} from '../src/challenge-play.mjs';

let assertions = 0;
function equal(a, b, m) { assert.equal(a, b, m); assertions += 1; }
function deepEqual(a, b, m) { assert.deepEqual(a, b, m); assertions += 1; }

const specDigest = 'a'.repeat(64);
const bundle = { specDigest, expectedSpecHash: 'b'.repeat(64), level: { params: { goal: 'clear' } } };

function recorder() {
  const calls = [];
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret); };
  return { calls, rec };
}

// ── recipient happy path: order + applied_spec_digest wiring ─────────────────
{
  const { calls, rec } = recorder();
  let uuidN = 0;
  const deps = {
    getSpecBoundView: rec('getSpecBoundView', { spec_digest: specDigest, wire_version: 1 }),
    acceptChallenge: rec('acceptChallenge', {}),
    startRecipientRun: rec('startRecipientRun', { state: 'active' }),
    getLevelBundle: rec('getLevelBundle', bundle),
    verifyBundleIdentity: rec('verifyBundleIdentity', true),
    mountLevel: rec('mountLevel', { metricValue: 4200 }),
    postResult: rec('postResult', { is_best: true }),
    complete: rec('complete', { beat: true, stars_awarded: 3, balance: 10 }),
    newUuid: () => `id${++uuidN}`,
    tzOffsetMinutes: () => 0,
  };
  const out = await playRecipientChallenge(deps, { challengeId: 'C1', mechanicId: 'marble-sort-swipe', variantId: 'V1' });
  const order = calls.map((c) => c[0]);
  deepEqual(order, [
    'getSpecBoundView', 'acceptChallenge', 'startRecipientRun',
    'getLevelBundle', 'verifyBundleIdentity', 'mountLevel', 'postResult', 'complete',
  ], 'recipient wire order: identity verified before mount');
  const result = calls.find((c) => c[0] === 'postResult')[1];
  equal(result.applied_spec_digest, specDigest, 'result echoes the wrapper digest');
  const complete = calls.find((c) => c[0] === 'complete')[1];
  equal(complete.applied_spec_digest, specDigest, 'complete echoes the wrapper digest');
  equal(complete.source_run_id, result.run_id, 'complete uses the recipient run id');
  equal(out.result.beat, true, 'returns the complete result');
}

// ── identity mismatch aborts before mount ────────────────────────────────────
{
  const { calls, rec } = recorder();
  let uuidN = 0;
  const deps = {
    getSpecBoundView: rec('getSpecBoundView', { spec_digest: specDigest }),
    acceptChallenge: rec('acceptChallenge', {}),
    startRecipientRun: rec('startRecipientRun', {}),
    getLevelBundle: rec('getLevelBundle', bundle),
    verifyBundleIdentity: rec('verifyBundleIdentity', false),
    mountLevel: rec('mountLevel', { metricValue: 1 }),
    postResult: rec('postResult', {}),
    complete: rec('complete', {}),
    newUuid: () => `id${++uuidN}`,
  };
  await assert.rejects(
    playRecipientChallenge(deps, { challengeId: 'C1', mechanicId: 'm', variantId: 'v' }),
    (e) => e instanceof ChallengePlayError && e.code === 'challenge_identity_mismatch',
    'identity mismatch rejects',
  );
  assertions += 1;
  equal(calls.some((c) => c[0] === 'mountLevel'), false, 'nothing mounted on identity mismatch');
  equal(calls.some((c) => c[0] === 'postResult'), false, 'nothing reported on identity mismatch');
}

// ── legacy (non-spec-bound) challenge is refused from the v1 flow ────────────
{
  const { rec } = recorder();
  const deps = {
    getSpecBoundView: rec('getSpecBoundView', { spec_digest: null }),
    newUuid: () => 'x',
  };
  await assert.rejects(
    playRecipientChallenge(deps, { challengeId: 'C1', mechanicId: 'm', variantId: 'v' }),
    (e) => e instanceof ChallengePlayError && e.code === 'challenge_not_spec_bound',
    'legacy challenge refused',
  );
  assertions += 1;
}

// ── source happy path: offer → source run.start (4 fields) → create ──────────
{
  const { calls, rec } = recorder();
  let uuidN = 0;
  const offer = {
    request_id: 'REQ1', spec_digest: specDigest,
    challengeSpec: { playableId: 'marble-sort-swipe', adapterVersion: 1, schemaVersion: 1, params: { goal: 'clear' }, runtimeContractDigest: 'c'.repeat(64), runtimeArtifactDigest: `sha256:${'d'.repeat(64)}` },
  };
  const deps = {
    createSourceLevel: rec('createSourceLevel', offer),
    startSourceRun: rec('startSourceRun', { state: 'active' }),
    getLevelBundle: rec('getLevelBundle', bundle),
    verifyBundleIdentity: rec('verifyBundleIdentity', true),
    mountLevel: rec('mountLevel', { metricValue: 5000 }),
    postResult: rec('postResult', {}),
    createChallenge: rec('createChallenge', { challenge_id: 'C9', deep_link: 'tg://x', share_url: 'https://t.me/share' }),
    newUuid: () => `id${++uuidN}`,
  };
  const out = await playSourceChallenge(deps, { mechanicId: 'marble-sort-swipe', variantId: 'V1', requestId: 'REQ1' });
  const order = calls.map((c) => c[0]);
  deepEqual(order, ['createSourceLevel', 'startSourceRun', 'getLevelBundle', 'verifyBundleIdentity', 'mountLevel', 'postResult', 'createChallenge'],
    'source wire order');
  const sourceRun = calls.find((c) => c[0] === 'startSourceRun')[1];
  deepEqual(Object.keys(sourceRun.challengeSpec).sort(), ['adapterVersion', 'params', 'playableId', 'schemaVersion'],
    'source run.start challengeSpec carries ONLY the four authored fields (no runtime digests)');
  equal(sourceRun.schema, 'run.start.challenge.v1', 'source schema');
  equal(sourceRun.purpose, 'challenge_source', 'source purpose');
  const create = calls.find((c) => c[0] === 'createChallenge')[1];
  equal(create.request_id, 'REQ1', 'create reuses the persisted request_id');
  equal(create.source_run_id, sourceRun.run_id, 'create binds the source run');
  equal(out.created.challenge_id, 'C9', 'returns the created challenge');
}

console.log(`check-challenge-play: ${assertions} assertions passed`);
