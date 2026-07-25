/**
 * Challenge sibling-player contract check: bundle validation, binding, reuse of
 * the identity-agnostic catalog frame navigation, on-client identity recompute,
 * and the configure_level/catalog_required handshake through to reveal — plus the
 * rejection paths (catalog-identity leaks, hash confusion, wrong runtime/origin).
 */
import assert from 'node:assert/strict';

import {
  ChallengePlayerContractError,
  ChallengePlayerSession,
  buildChallengeFrameNavigation,
  buildChallengePlayerLevelBinding,
  validateChallengeLevelBundle,
  verifyChallengeBundleIdentity,
} from '../src/challenge-player.mjs';
import { levelSpecHash } from '../src/challenge-identity.mjs';

let assertions = 0;
function equal(actual, expected, message) { assert.equal(actual, expected, message); assertions += 1; }
function ok(value, message) { assert.ok(value, message); assertions += 1; }
function throws(fn, message) { assert.throws(fn, ChallengePlayerContractError, message); assertions += 1; }

const ticketId = '00000000-0000-4000-8000-000000000001';
const challengeId = '00000000-0000-4000-8000-000000000002';
const releaseId = '00000000-0000-4000-8000-000000000003';
const contractDigest = 'c'.repeat(64);
const artifactHex = 'd'.repeat(64);
const artifactDigest = `sha256:${artifactHex}`;
const specDigest = 'a'.repeat(64);
const params = { board: { cells: 9, seed: 7 }, goal: 'clear' };
const baseUrl = 'https://feed.example.com/app/';

// The per-level content address is the REAL client recomputation, so the bundle
// is self-consistent and verifyChallengeBundleIdentity passes.
const level = {
  schema: 'sort.level-spec.v1',
  runtimeContractDigest: contractDigest,
  seed: 0,
  params,
};
const specHash = await levelSpecHash(level);
assert.notEqual(specHash, specDigest);

function makeBundle(overrides = {}) {
  return {
    schema: 'challenge.ticket-level-spec-bundle.v1',
    ticketId,
    ticketState: 'active',
    challengeId,
    specDigest,
    expectedSpecHash: specHash,
    runtime: {
      playableId: 'marble-sort-swipe',
      releaseId,
      runtimeContractDigest: contractDigest,
      runtimeArtifactDigest: artifactDigest,
      indexLocator: `runtime-releases/marble-sort-swipe/${artifactHex}/index.html`,
      sidecarLocator: `runtime-releases/marble-sort-swipe/${artifactHex}/sidecar.json`,
      capabilities: { levelSeries: false },
    },
    level: { ...level, specHash },
    ...overrides,
  };
}

// ── validation ─────────────────────────────────────────────────────────────
const bundle = validateChallengeLevelBundle(makeBundle());
equal(bundle.specDigest, specDigest, 'valid bundle passes');
ok(await verifyChallengeBundleIdentity(bundle), 'client recompute matches server per-level hash');
equal(await verifyChallengeBundleIdentity({ ...bundle, level: { ...bundle.level, params: { board: 1, goal: 'x' } } }), false,
  'tampered params fail the identity recompute');

throws(() => validateChallengeLevelBundle({ ...makeBundle(), decisionId: 'x' }), 'no catalog allocation identity allowed');
throws(() => validateChallengeLevelBundle(makeBundle({ expectedSpecHash: specDigest, level: { ...level, specHash: specDigest } })),
  'wrapper digest and per-level hash must differ');
throws(() => validateChallengeLevelBundle(makeBundle({ level: { ...level, specHash } , expectedSpecHash: 'b'.repeat(64) })),
  'expectedSpecHash must equal level.specHash');
throws(() => validateChallengeLevelBundle(makeBundle({ runtime: { ...makeBundle().runtime, runtimeContractDigest: 'e'.repeat(64) } })),
  'level/runtime contract digest must agree');
equal(validateChallengeLevelBundle(makeBundle({ challengeId: null })).challengeId, null, 'source bundle (challengeId null) is valid');

// ── binding + navigation (reuses the catalog frame builder unchanged) ────────
const binding = buildChallengePlayerLevelBinding(makeBundle(), 1);
equal(binding.specHash, specHash, 'binding.specHash is the per-level hash');
equal(binding.specDigest, specDigest, 'binding.specDigest is the wrapper digest');
equal(binding.spec.params.goal, 'clear', 'binding carries the exact level envelope');
throws(() => buildChallengePlayerLevelBinding(makeBundle(), 0), 'frameEpoch must be >= 1');

const nav = buildChallengeFrameNavigation(binding, baseUrl);
const url = new URL(nav.src);
equal(url.pathname, `/runtime-releases/marble-sort-swipe/${artifactHex}/index.html`, 'content-addressed runtime path');
equal(url.searchParams.get('level_config'), 'catalog_required', 'reuses the catalog_required handshake');
equal(url.searchParams.get('expected_spec_hash'), specHash, 'handshake checks against the per-level hash');
equal(nav.expectedOrigin, 'https://feed.example.com', 'expected origin resolved');

// ── handshake to reveal ──────────────────────────────────────────────────────
const frameSource = {};
const session = new ChallengePlayerSession({ bundle: makeBundle(), baseUrl, frameEpoch: 1, frameSource });
const ready = session.handleMessage({
  source: frameSource, origin: nav.expectedOrigin,
  data: { type: 'configure_ready', nonce: 'nonce-abc-0123456789', runtimeContractDigest: contractDigest, runtimeArtifactDigest: artifactDigest },
}, 1);
equal(ready.status, 'accepted', 'configure_ready accepted');
equal(ready.effects[0].type, 'post_configure_level', 'emits configure_level');
equal(ready.effects[0].message.spec.params.goal, 'clear', 'configure_level posts the exact level spec');
const nonce = ready.effects[0].message.nonce;
const configured = session.handleMessage({
  source: frameSource, origin: nav.expectedOrigin,
  data: { type: 'configured', appliedSpecHash: specHash, runtimeContractDigest: contractDigest, runtimeArtifactDigest: artifactDigest },
}, 1);
equal(configured.phase, 'configured', 'configured accepted (appliedSpecHash matches)');
void nonce;
const revealed = session.setVisible(true, 1);
equal(revealed.effects[0].type, 'challenge_reveal_ready', 'reveal fires once visible + configured');
equal(revealed.effects[0].appliedSpecHash, specHash, 'reveal carries the applied per-level hash');
equal(session.setVisible(true, 1).effects.length, 0, 'reveal is one-shot');

// ── handshake rejections ─────────────────────────────────────────────────────
const s2 = new ChallengePlayerSession({ bundle: makeBundle(), baseUrl, frameEpoch: 1, frameSource });
equal(s2.handleMessage({ source: frameSource, origin: 'https://evil.example.com', data: { type: 'configure_ready', nonce: 'nonce-abc-0123456789', runtimeContractDigest: contractDigest, runtimeArtifactDigest: artifactDigest } }, 1).status,
  'ignored', 'wrong origin is ignored');
s2.handleMessage({ source: frameSource, origin: nav.expectedOrigin, data: { type: 'configure_ready', nonce: 'nonce-abc-0123456789', runtimeContractDigest: contractDigest, runtimeArtifactDigest: artifactDigest } }, 1);
const digestFail = s2.handleMessage({ source: frameSource, origin: nav.expectedOrigin, data: { type: 'configured', appliedSpecHash: 'f'.repeat(64), runtimeContractDigest: contractDigest, runtimeArtifactDigest: artifactDigest } }, 1);
equal(digestFail.status, 'failed', 'wrong appliedSpecHash fails');
equal(digestFail.reason, 'digest', 'digest mismatch reason');

const s3 = new ChallengePlayerSession({ bundle: makeBundle(), baseUrl, frameEpoch: 1, frameSource });
const runtimeFail = s3.handleMessage({ source: frameSource, origin: nav.expectedOrigin, data: { type: 'configure_ready', nonce: 'nonce-abc-0123456789', runtimeContractDigest: contractDigest, runtimeArtifactDigest: `sha256:${'9'.repeat(64)}` } }, 1);
equal(runtimeFail.reason, 'runtime', 'wrong runtime artifact digest fails');

console.log(`check-challenge-player: ${assertions} assertions passed`);
