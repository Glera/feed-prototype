import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seriesLength } from '../src/series-policy.mjs';

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

console.log(`series policy: ${fixture.vectors.length} passed`);
