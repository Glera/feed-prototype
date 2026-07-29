import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seriesGameLevel, seriesLength } from '../src/series-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = resolve(root, 'test-fixtures/series-policy.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
for (const vector of fixture.vectors) {
  assert.equal(seriesLength(vector.mechanic_id), vector.levels, vector.mechanic_id);
}

const backendFixturePath = resolve(root, '../swipe-backend/tests/fixtures/series-policy.json');
if (existsSync(backendFixturePath)) {
  assert.deepEqual(JSON.parse(readFileSync(backendFixturePath, 'utf8')), fixture, 'backend series policy drifted');
}

for (const [mechanicId, expected] of [
  ['pins-swipe', [1, 2]],
  ['pins-l3-swipe', [3, 4]],
  ['pins-l5-swipe', [5, 6]],
  ['pins-l7-swipe', [7, 8]],
  ['pins-l9-swipe', [9, 10]],
]) {
  assert.deepEqual(
    [seriesGameLevel(mechanicId, 1), seriesGameLevel(mechanicId, 2)],
    expected,
    `${mechanicId} level routing`,
  );
}
assert.equal(seriesGameLevel('merge-locked-v1-swipe', 1), null);
assert.deepEqual(
  Array.from(
    { length: seriesLength('arrows-v1-swipe') },
    (_, index) => seriesGameLevel('arrows-v1-swipe', index + 1),
  ),
  [11, 12, 13, 10, 14],
  'arrows-v1-swipe level routing',
);

console.log(`series policy: ${fixture.vectors.length} lengths + 5 pins routes + arrows route passed`);
