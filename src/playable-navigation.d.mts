import type { PlatformDeviceTier } from './device-tier.mjs';

export interface PlayableNavigationOptions {
  base: string;
  htmlFile: string;
  version: string;
  deviceTier: PlatformDeviceTier;
  hostPaused?: boolean;
  auto?: boolean;
  series?: string;
  level?: number;
}

export function buildPlayableNavigationUrl(options: PlayableNavigationOptions): string;
