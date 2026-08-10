export function bottomFeedTapAction({ nonFeedView, navigationBusy }) {
  if (nonFeedView) return 'return';
  if (navigationBusy) return 'ignore';
  return 'advance';
}

export function wrappedNavigationIndex(position, count) {
  if (!Number.isInteger(count) || count <= 0) return Number.NaN;
  if (count === 1) return 0;
  const rounded = Math.round(position);
  return ((rounded % count) + count) % count;
}

export function navigationDirection(fromPosition, targetPosition) {
  if (targetPosition > fromPosition) return 1;
  if (targetPosition < fromPosition) return -1;
  return 0;
}

export function swipeIntentDirection({ dy, allowsBack, minIntentPx }) {
  if (dy <= -minIntentPx) return 1;
  if (allowsBack && dy >= minIntentPx) return -1;
  return 0;
}

export function committedSwipeStep({
  dy,
  velocity,
  allowsBack,
  pageHeight,
  minIntentPx,
  velocitySnap,
  distanceSnapFraction,
  distanceSnapPixels,
}) {
  const hasSwipeIntent = Math.abs(dy) >= minIntentPx;
  const fastUp = hasSwipeIntent && velocity <= -velocitySnap;
  const fastDown = hasSwipeIntent && allowsBack && velocity >= velocitySnap;
  const snapDistance = Math.min(pageHeight * distanceSnapFraction, distanceSnapPixels);
  const farUp = dy <= -snapDistance;
  const farDown = allowsBack && dy >= snapDistance;
  if (fastUp || farUp) return 1;
  if (fastDown || farDown) return -1;
  return 0;
}
