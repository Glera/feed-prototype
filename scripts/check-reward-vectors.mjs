import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { levelStarReward, seriesRewards, stableRewardHash } from '../src/rewards.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = resolve(root, 'test-fixtures/reward-vectors.json');
const fixtureText = readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(fixtureText);

assert.equal(fixture.algorithm, 'fnv1a-32-utf8');
for (const vector of fixture.vectors) {
  assert.equal(stableRewardHash(vector.run_id), vector.hash, `${vector.run_id}: hash`);
  assert.equal(levelStarReward(vector.run_id), vector.level_stars, `${vector.run_id}: level stars`);
  assert.deepEqual(
    seriesRewards(vector.run_id),
    { stars: vector.series_stars, puzzles: vector.series_puzzles },
    `${vector.run_id}: series rewards`,
  );
}

// Both repos remain independently testable. In the normal workspace, also
// prevent either golden fixture from drifting away from its counterpart.
const backendFixturePath = resolve(root, '../swipe-backend/tests/fixtures/reward-vectors.json');
if (existsSync(backendFixturePath)) {
  assert.deepEqual(JSON.parse(readFileSync(backendFixturePath, 'utf8')), fixture, 'backend reward vectors drifted');
}

console.log(`reward vectors: ${fixture.vectors.length} passed`);
