import assert from 'node:assert/strict';

import {
  ResultReceiptWaiters,
  catalogResultAllowsProgress,
} from '../src/result-receipts.mjs';

const waiters = new ResultReceiptWaiters();
const first = waiters.wait('run-a');
const second = waiters.wait('run-b');
let firstSettled = false;
void first.then(() => { firstSettled = true; });

assert.equal(waiters.pendingRuns(), 2);
assert.equal(waiters.settle({ runId: 'run-b', status: 'confirmed' }), 1);
assert.deepEqual(await second, { runId: 'run-b', status: 'confirmed' });
await Promise.resolve();
assert.equal(firstSettled, false, 'another run receipt cannot unlock this run');
assert.equal(waiters.settle({ runId: 'run-a', status: 'rejected' }), 1);
assert.deepEqual(await first, { runId: 'run-a', status: 'rejected' });

const duplicateA = waiters.wait('run-c');
const duplicateB = waiters.wait('run-c');
assert.equal(waiters.settle({ runId: 'run-c', status: 'confirmed' }), 2);
assert.deepEqual(await Promise.all([duplicateA, duplicateB]), [
  { runId: 'run-c', status: 'confirmed' },
  { runId: 'run-c', status: 'confirmed' },
]);
assert.equal(waiters.settle({ runId: 'unknown', status: 'confirmed' }), 0);
assert.throws(() => waiters.wait(''), /runId is required/);
assert.equal(catalogResultAllowsProgress({ runId: 'run-a', status: 'confirmed' }, 'run-a'), true);
assert.equal(catalogResultAllowsProgress({ runId: 'run-a', status: 'rejected' }, 'run-a'), false);
assert.equal(catalogResultAllowsProgress({ runId: 'other-run', status: 'confirmed' }, 'run-a'), false);

console.log('result receipt isolation: 13 assertions passed');
