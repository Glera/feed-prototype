/**
 * Golden-vector check (D8): the browser challenge-identity JCS/SHA-256 must
 * reproduce, byte-for-byte, the digests the swipe-backend produced with RFC 8785
 * + SHA-256. Fails loudly on any divergence so a client/backend JCS drift can
 * never ship silently.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  ChallengeIdentityError,
  CHALLENGE_LEVEL_SEED,
  computeSpecDigest,
  jcsSha256,
  levelSpecHash,
} from '../src/challenge-identity.mjs';

const fixturePath = fileURLToPath(
  new URL('../test-fixtures/challenge-golden-vectors.v1.json', import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
assert.equal(fixture.schema, 'challenge.golden-vectors.v1');

let assertions = 0;
async function expectDigest(actual, expected, label) {
  assert.equal(await actual, expected, label);
  assertions += 1;
}

for (const vector of fixture.vectors) {
  const { kind, input, digest } = vector;
  if (kind === 'spec_digest') {
    await expectDigest(computeSpecDigest(input), digest, `spec_digest ${digest.slice(0, 8)}`);
  } else if (kind === 'level_spec_hash') {
    await expectDigest(levelSpecHash(input), digest, `level_spec_hash ${digest.slice(0, 8)}`);
    // The challenge level seed is a fixed contract constant.
    assert.equal(input.seed, CHALLENGE_LEVEL_SEED, 'challenge level vector must use the fixed seed');
    assertions += 1;
  } else if (kind === 'jcs_sha256') {
    await expectDigest(jcsSha256(input), digest, `jcs_sha256 ${digest.slice(0, 8)}`);
  } else {
    throw new Error(`unknown golden-vector kind: ${kind}`);
  }
}

// Fail-closed behaviours mirror the backend CanonicalJsonError boundary.
assert.throws(() => computeSpecDigest({
  schemaVersion: 1, playableId: 'x', adapterVersion: 1,
  params: { n: Number.NaN }, runtimeContractDigest: 'd', runtimeArtifactDigest: 's',
}), ChallengeIdentityError, 'NaN must be rejected');
assertions += 1;
assert.throws(() => jcsSha256({ n: 1.5 }), ChallengeIdentityError, 'non-integer must be rejected');
assertions += 1;

console.log(`check-challenge-identity: ${assertions} assertions passed (${fixture.vectors.length} golden vectors)`);
