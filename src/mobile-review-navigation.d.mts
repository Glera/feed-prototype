export interface MobileReviewNavigation {
  requested: boolean;
  bundleId: string | null;
}

export function mobileReviewNavigation(options?: {
  search?: string;
  startParam?: string | null;
}): MobileReviewNavigation;
