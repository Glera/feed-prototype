import assert from 'node:assert/strict';

import {
  bottomFeedTapAction,
  committedSwipeStep,
  navigationDirection,
  swipeIntentDirection,
  wrappedNavigationIndex,
} from '../src/feed-navigation.mjs';

assert.equal(
  bottomFeedTapAction({ nonFeedView: true, navigationBusy: false }),
  'return',
  'a feed tap from another view returns without advancing',
);
assert.equal(
  bottomFeedTapAction({ nonFeedView: true, navigationBusy: true }),
  'return',
  'returning to the feed takes priority over a stale transition',
);
assert.equal(
  bottomFeedTapAction({ nonFeedView: false, navigationBusy: false }),
  'advance',
  'a feed tap while the feed is active advances exactly once',
);
assert.equal(
  bottomFeedTapAction({ nonFeedView: false, navigationBusy: true }),
  'ignore',
  'a repeated tap cannot start a second transition',
);

assert.equal(wrappedNavigationIndex(-1, 5), 4, 'back from the first card wraps safely');
assert.equal(wrappedNavigationIndex(5, 5), 0, 'forward from the last card wraps safely');
assert.equal(wrappedNavigationIndex(-1, 1), 0, 'a single-card feed cannot leave its only card');
assert.equal(Number.isNaN(wrappedNavigationIndex(0, 0)), true, 'an empty ring has no valid-looking index');
assert.equal(navigationDirection(2, 3), 1);
assert.equal(navigationDirection(2, 1), -1);
assert.equal(navigationDirection(2, 2), 0);

const swipePolicy = {
  allowsBack: true,
  pageHeight: 760,
  minIntentPx: 8,
  velocitySnap: 0.24,
  distanceSnapFraction: 0.06,
  distanceSnapPixels: 14,
};
assert.equal(swipeIntentDirection({ dy: -8, allowsBack: true, minIntentPx: 8 }), 1);
assert.equal(swipeIntentDirection({ dy: 8, allowsBack: true, minIntentPx: 8 }), -1);
assert.equal(swipeIntentDirection({ dy: 8, allowsBack: false, minIntentPx: 8 }), 0);
assert.equal(committedSwipeStep({ ...swipePolicy, dy: -14, velocity: 0 }), 1);
assert.equal(committedSwipeStep({ ...swipePolicy, dy: 14, velocity: 0 }), -1);
assert.equal(
  committedSwipeStep({ ...swipePolicy, allowsBack: false, dy: 40, velocity: 1 }),
  0,
  'surfaces without backward navigation remain forward-only',
);
assert.equal(
  committedSwipeStep({ ...swipePolicy, dy: 7, velocity: 2 }),
  0,
  'velocity cannot promote sub-intent pointer noise',
);

console.log('feed navigation deterministic checks passed');
