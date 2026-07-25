import assert from 'node:assert/strict';

import {
  createModerationRequestGeneration,
  runExclusiveModerationAction,
  runKeyedModerationAction,
  runModerationPageAction,
} from '../src/island-moderation-pagination.mjs';

const button = { disabled: false };
let cursor = 'page-2';
const requested = [];
let calls = 0;

async function loadNextPage() {
  const requestedCursor = cursor;
  requested.push(requestedCursor);
  calls += 1;
  if (calls === 1) throw new Error('transient 503');
  // Mirrors the console: advance only after the request succeeds.
  cursor = 'page-3';
}

await assert.rejects(
  runModerationPageAction(button, loadNextPage),
  /transient 503/,
);
assert.equal(button.disabled, false, 'failed page request stranded the button disabled');
assert.equal(cursor, 'page-2', 'failed page request advanced the keyset cursor');

await runModerationPageAction(button, loadNextPage);
assert.equal(button.disabled, false, 'successful retry did not restore the button state');
assert.deepEqual(requested, ['page-2', 'page-2'], 'retry did not reuse the exact failed cursor');
assert.equal(cursor, 'page-3', 'successful retry did not advance the cursor');

const generation = createModerationRequestGeneration();
const staleReload = generation.begin();
const stalePage = generation.capture();
const currentReload = generation.begin();
assert.equal(generation.isCurrent(staleReload), false, 'older reload remained current');
assert.equal(generation.isCurrent(stalePage), false, 'older pagination response remained current');
assert.equal(generation.isCurrent(currentReload), true, 'latest reload was not current');

const buttons = [{ disabled: false }, { disabled: false }, { disabled: false }];
let releaseFirst;
const firstDone = new Promise((resolve) => { releaseFirst = resolve; });
let mutations = 0;
const first = runExclusiveModerationAction(buttons, async () => {
  mutations += 1;
  await firstDone;
});
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(buttons.map((item) => item.disabled), [true, true, true]);
const second = await runExclusiveModerationAction(buttons, async () => { mutations += 1; });
assert.equal(second, false, 'a concurrent report resolution was accepted');
assert.equal(mutations, 1);
releaseFirst();
assert.equal(await first, true);
assert.deepEqual(buttons.map((item) => item.disabled), [false, false, false]);

const mutationKeys = new Set();
const oldButtons = [{ disabled: false }];
let releaseKeyed;
const keyedDone = new Promise((resolve) => { releaseKeyed = resolve; });
const keyedFirst = runKeyedModerationAction(mutationKeys, 'report-1', oldButtons, async () => {
  await keyedDone;
});
await new Promise((resolve) => setImmediate(resolve));
const replacementButtons = [{ disabled: false }];
const keyedSecond = await runKeyedModerationAction(
  mutationKeys,
  'report-1',
  replacementButtons,
  async () => { throw new Error('replacement DOM bypassed the mutation fence'); },
);
assert.equal(keyedSecond, false, 'rerendered controls bypassed the report mutation fence');
releaseKeyed();
assert.equal(await keyedFirst, true);
assert.equal(mutationKeys.size, 0);

console.log('island moderation pagination: retry, freshness, and exclusive mutations verified');
