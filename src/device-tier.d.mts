export type PlatformDeviceTier = 'premium' | 'standard' | 'low';
export type PlatformDeviceTierSource = 'benchmark' | 'cache' | 'override' | 'fallback';

export interface PlatformDeviceSignals {
  userAgent: string;
  vendor: string;
  maxTouchPoints: number;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
}

export interface PlatformDeviceTierResolution {
  schema: 'swipe.platform-device-tier.v1';
  tier: PlatformDeviceTier;
  benchmarkOpsPerSec: number | null;
  source: PlatformDeviceTierSource;
  resolvedAt: number;
  signals: PlatformDeviceSignals;
}

export interface PlatformDeviceTierResolverDependencies {
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  navigatorLike?: Partial<Navigator> & { deviceMemory?: number };
  locationLike?: Pick<Location, 'search'>;
  now?: () => number;
  benchmark?: (budgetMs: number) => number;
}

export const DEVICE_TIER_CACHE_KEY: string;
export const DEVICE_TIER_CACHE_TTL_MS: number;

export function classifyPlatformDeviceTier(
  benchmarkOpsPerSec: number,
  navigatorLike?: PlatformDeviceTierResolverDependencies['navigatorLike'],
): PlatformDeviceTier;

export function measurePlatformCanvas2dOps(
  budgetMs?: number,
  documentLike?: Document | null,
  performanceLike?: Performance | null,
): number;

export function createPlatformDeviceTierResolver(
  dependencies?: PlatformDeviceTierResolverDependencies,
): () => PlatformDeviceTierResolution;

export const resolvePlatformDeviceTier: () => PlatformDeviceTierResolution;
