export type BottomFeedTapAction = 'return' | 'advance' | 'ignore';
export type NavigationDirection = -1 | 0 | 1;

export function bottomFeedTapAction(input: {
  nonFeedView: boolean;
  navigationBusy: boolean;
}): BottomFeedTapAction;

export function wrappedNavigationIndex(position: number, count: number): number;
export function navigationDirection(fromPosition: number, targetPosition: number): NavigationDirection;

export function swipeIntentDirection(input: {
  dy: number;
  allowsBack: boolean;
  minIntentPx: number;
}): NavigationDirection;

export function committedSwipeStep(input: {
  dy: number;
  velocity: number;
  allowsBack: boolean;
  pageHeight: number;
  minIntentPx: number;
  velocitySnap: number;
  distanceSnapFraction: number;
  distanceSnapPixels: number;
}): NavigationDirection;
