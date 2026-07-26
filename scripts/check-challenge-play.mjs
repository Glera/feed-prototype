/**
 * Challenge play-orchestration contract check:
 *  - the exact recipient/source wire sequence,
 *  - the P1-4 invariant that verifyBundleIdentity is awaited BEFORE mountLevel
 *    (a mismatch aborts with nothing mounted/played/reported),
 *  - the P1-3 durable phase envelope: a lost response / reload RESUMES with the
 *    SAME ids and frozen payload, creating no second offer/run/challenge and never
 *    re-playing the level.
 */
import assert from 'node:assert/strict';

import {
  ChallengePlayError,
  playRecipientChallenge,
  playSourceChallenge,
} from '../src/challenge-play.mjs';
import { openRecipientEnvelope, openSourceEnvelope } from '../src/challenge-envelope.mjs';

let assertions = 0;
function equal(a, b, m) { assert.equal(a, b, m); assertions += 1; }
function deepEqual(a, b, m) { assert.deepEqual(a, b, m); assertions += 1; }

const specDigest = 'a'.repeat(64);
const bundle = { specDigest, expectedSpecHash: 'b'.repeat(64), level: { params: { goal: 'clear' } } };

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}
let uuidN = 0;
const mint = () => `id${++uuidN}`;

function recorder() {
  const calls = [];
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return Promise.resolve(typeof ret === 'function' ? ret(...args) : ret); };
  return { calls, rec };
}

// ── recipient happy path: order + identity-before-mount + applied_spec_digest ─
{
  uuidN = 0;
  const { calls, rec } = recorder();
  const deps = {
    getSpecBoundView: rec('getSpecBoundView', { spec_digest: specDigest, wire_version: 1 }),
    acceptChallenge: rec('acceptChallenge', {}),
    startRecipientRun: rec('startRecipientRun', { state: 'active' }),
    getLevelBundle: rec('getLevelBundle', bundle),
    verifyBundleIdentity: rec('verifyBundleIdentity', true),
    mountLevel: rec('mountLevel', { metricValue: 4200 }),
    postResult: rec('postResult', { is_best: true }),
    complete: rec('complete', { beat: true, stars_awarded: 3, balance: 10 }),
    tzOffsetMinutes: () => 0,
  };
  const env = openRecipientEnvelope(memStorage(), 'C1', mint);
  const out = await playRecipientChallenge(deps, { challengeId: 'C1', mechanicId: 'marble-sort-swipe', variantId: 'V1' }, env);
  deepEqual(calls.map((c) => c[0]), [
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
  uuidN = 0;
  const { calls, rec } = recorder();
  const deps = {
    getSpecBoundView: rec('getSpecBoundView', { spec_digest: specDigest }),
    acceptChallenge: rec('acceptChallenge', {}),
    startRecipientRun: rec('startRecipientRun', {}),
    getLevelBundle: rec('getLevelBundle', bundle),
    verifyBundleIdentity: rec('verifyBundleIdentity', false),
    mountLevel: rec('mountLevel', { metricValue: 1 }),
    postResult: rec('postResult', {}),
    complete: rec('complete', {}),
  };
  const env = openRecipientEnvelope(memStorage(), 'C1', mint);
  await assert.rejects(
    playRecipientChallenge(deps, { challengeId: 'C1', mechanicId: 'm', variantId: 'v' }, env),
    (e) => e instanceof ChallengePlayError && e.code === 'challenge_identity_mismatch',
    'identity mismatch rejects',
  );
  assertions += 1;
  equal(calls.some((c) => c[0] === 'mountLevel'), false, 'nothing mounted on identity mismatch');
  equal(calls.some((c) => c[0] === 'postResult'), false, 'nothing reported on identity mismatch');
}

// ── legacy (non-spec-bound) challenge is refused from the v1 flow ────────────
{
  uuidN = 0;
  const { rec } = recorder();
  const deps = { getSpecBoundView: rec('getSpecBoundView', { spec_digest: null }) };
  const env = openRecipientEnvelope(memStorage(), 'C1', mint);
  await assert.rejects(
    playRecipientChallenge(deps, { challengeId: 'C1', mechanicId: 'm', variantId: 'v' }, env),
    (e) => e instanceof ChallengePlayError && e.code === 'challenge_not_spec_bound',
    'legacy challenge refused',
  );
  assertions += 1;
}

// ── source happy path: offer → source run.start (4 fields) → create ──────────
{
  uuidN = 0;
  const { calls, rec } = recorder();
  const offer = {
    request_id: 'REQ', spec_digest: specDigest,
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
  };
  const env = openSourceEnvelope(memStorage(), mint);
  const out = await playSourceChallenge(deps, { mechanicId: 'marble-sort-swipe', variantId: 'V1' }, env);
  deepEqual(calls.map((c) => c[0]), ['createSourceLevel', 'startSourceRun', 'getLevelBundle', 'verifyBundleIdentity', 'mountLevel', 'postResult', 'createChallenge'],
    'source wire order');
  const sourceRun = calls.find((c) => c[0] === 'startSourceRun')[1];
  deepEqual(Object.keys(sourceRun.challengeSpec).sort(), ['adapterVersion', 'params', 'playableId', 'schemaVersion'],
    'source run.start challengeSpec carries ONLY the four authored fields (no runtime digests)');
  equal(sourceRun.schema, 'run.start.challenge.v1', 'source schema');
  equal(sourceRun.sourceOfferRequestId, env.ids.requestId, 'source run.start carries the durable offer request_id (v1.4.2 R2 P1-1)');
  const create = calls.find((c) => c[0] === 'createChallenge')[1];
  equal(create.request_id, env.ids.requestId, 'create reuses the durable request_id');
  equal(create.source_run_id, sourceRun.run_id, 'create binds the source run');
  equal(out.created.challenge_id, 'C9', 'returns the created challenge');
}

// ── P1-3: lost-response / reload resumes with SAME ids, no duplicates ─────────
{
  uuidN = 0;
  const offersByReq = new Map();
  const runsByTicket = new Set();
  const resultsByRun = new Set();
  const challengesByReq = new Map();
  let mountCalls = 0;
  let failCreateOnce = true;
  const frozenMetric = 5000;

  const deps = {
    createSourceLevel: (reqId) => {
      if (!offersByReq.has(reqId)) {
        offersByReq.set(reqId, { request_id: reqId, spec_digest: specDigest, challengeSpec: { playableId: 'marble-sort-swipe', adapterVersion: 1, schemaVersion: 1, params: { goal: 'clear' } } });
      }
      return Promise.resolve(offersByReq.get(reqId));
    },
    startSourceRun: (req) => { runsByTicket.add(req.ticket_id); return Promise.resolve({}); },
    getLevelBundle: () => Promise.resolve(bundle),
    verifyBundleIdentity: () => Promise.resolve(true),
    mountLevel: () => { mountCalls += 1; return Promise.resolve({ metricValue: frozenMetric }); },
    postResult: (p) => {
      resultsByRun.add(p.run_id);
      assert.equal(p.metric_value, frozenMetric, 'frozen metric payload never changes across retries');
      return Promise.resolve({});
    },
    createChallenge: (p) => {
      // COMMIT server-side, then (once) lose the response so the client retries.
      if (!challengesByReq.has(p.request_id)) challengesByReq.set(p.request_id, { challenge_id: 'C-1', deep_link: 'd', share_url: 's' });
      if (failCreateOnce) { failCreateOnce = false; return Promise.reject(new Error('network lost after commit')); }
      return Promise.resolve(challengesByReq.get(p.request_id));
    },
  };

  const storage = memStorage();
  const env1 = openSourceEnvelope(storage, mint);
  const idsSnapshot = { ...env1.ids };
  await assert.rejects(
    playSourceChallenge(deps, { mechanicId: 'marble-sort-swipe', variantId: 'V1' }, env1),
    (e) => e instanceof Error, 'attempt 1 fails at create (lost response after commit)',
  );
  assertions += 1;
  // "повторить" / reload: re-open the SAME persisted slot.
  const env2 = openSourceEnvelope(storage, mint);
  deepEqual(env2.ids, idsSnapshot, 'reload reuses the durable ids (no re-mint)');
  const out2 = await playSourceChallenge(deps, { mechanicId: 'marble-sort-swipe', variantId: 'V1' }, env2);

  equal(offersByReq.size, 1, 'exactly one offer across the retry');
  equal(runsByTicket.size, 1, 'exactly one source run across the retry');
  equal(resultsByRun.size, 1, 'exactly one /results run across the retry');
  equal(challengesByReq.size, 1, 'exactly one challenge across the retry');
  equal(mountCalls, 1, 'the level is played EXACTLY once (frozen metric reused on resume)');
  equal(out2.created.challenge_id, 'C-1', 'resume returns the committed challenge');

  env2.clear();
  const env3 = openSourceEnvelope(storage, mint);
  assert.notEqual(env3.ids.requestId, idsSnapshot.requestId, 'after clear, a new op mints fresh ids');
  assertions += 1;
}

console.log(`check-challenge-play: ${assertions} assertions passed`);
