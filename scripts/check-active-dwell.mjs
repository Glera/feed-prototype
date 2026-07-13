import assert from 'node:assert/strict';

import { ActiveDwellAccumulator } from '../src/active-dwell.mjs';

const dwell = new ActiveDwellAccumulator(0);
dwell.update({ visible: true }, 10);
dwell.update({ foreground: true }, 20);
dwell.update({ interactiveReady: true }, 30);
assert.deepEqual(dwell.snapshot(80, true), { dwellActiveMs: 50, dwellCensored: true });

// Background time is excluded, then the same impression continues on resume.
dwell.update({ foreground: false }, 100);
assert.equal(dwell.snapshot(1100).dwellActiveMs, 70);
dwell.update({ foreground: true }, 1200);
dwell.update({ visible: false }, 1240);
assert.deepEqual(dwell.snapshot(2000, false), { dwellActiveMs: 110, dwellCensored: false });

// A remount can revoke interactive readiness without losing already accrued time.
dwell.update({ visible: true, interactiveReady: false }, 2100);
dwell.update({ interactiveReady: true }, 2200);
assert.deepEqual(dwell.finish(2233.4, false), { dwellActiveMs: 143, dwellCensored: false });

// A regressing/non-finite clock never subtracts dwell.
assert.equal(dwell.snapshot(100).dwellActiveMs, 143);
assert.equal(dwell.snapshot(Number.NaN).dwellActiveMs, 143);

dwell.reset(500, { visible: true, foreground: true, interactiveReady: true });
assert.deepEqual(dwell.finish(517.6, true), { dwellActiveMs: 18, dwellCensored: true });

console.log('active dwell: 12 assertions passed');
