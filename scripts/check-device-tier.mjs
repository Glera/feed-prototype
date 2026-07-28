import assert from 'node:assert/strict';

import {
  DEVICE_TIER_CACHE_KEY,
  DEVICE_TIER_CACHE_TTL_MS,
  classifyPlatformDeviceTier,
  createPlatformDeviceTierResolver,
} from '../src/device-tier.mjs';
import { buildPlayableNavigationUrl } from '../src/playable-navigation.mjs';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

const premiumAndroid = {
  userAgent: 'Mozilla/5.0 (Linux; Android 15)',
  vendor: 'Google Inc.',
  maxTouchPoints: 5,
  hardwareConcurrency: 8,
  deviceMemory: 8,
};
assert.equal(classifyPlatformDeviceTier(3000, premiumAndroid), 'premium');
assert.equal(classifyPlatformDeviceTier(2999, premiumAndroid), 'standard');
assert.equal(classifyPlatformDeviceTier(1199, premiumAndroid), 'low');
assert.equal(
  classifyPlatformDeviceTier(5000, { ...premiumAndroid, deviceMemory: 2 }),
  'standard',
  'explicitly weak memory may only downgrade',
);
assert.equal(
  classifyPlatformDeviceTier(1800, { ...premiumAndroid, hardwareConcurrency: 2 }),
  'low',
  'non-Apple two-core devices with a weak benchmark are low',
);
assert.equal(
  classifyPlatformDeviceTier(5000, {
    userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148',
    vendor: 'Apple Computer, Inc.',
    maxTouchPoints: 5,
    hardwareConcurrency: 2,
  }),
  'premium',
  'Telegram WKWebView is judged by its parent benchmark, not the AppLovin UA cap',
);
assert.equal(classifyPlatformDeviceTier(0, premiumAndroid), 'standard');

const storage = new MemoryStorage();
let benchmarkCalls = 0;
const first = createPlatformDeviceTierResolver({
  storage,
  navigatorLike: premiumAndroid,
  locationLike: { search: '' },
  now: () => 1_000,
  benchmark: () => {
    benchmarkCalls += 1;
    return 4200;
  },
});
const firstResolution = first();
assert.equal(firstResolution.tier, 'premium');
assert.equal(firstResolution.source, 'benchmark');
assert.equal(first(), firstResolution, 'one page reuses the exact immutable resolution object');
assert.equal(benchmarkCalls, 1, 'the parent benchmark executes once per platform page');

let nextPageBenchmarkCalls = 0;
const nextPage = createPlatformDeviceTierResolver({
  storage,
  navigatorLike: premiumAndroid,
  locationLike: { search: '' },
  now: () => 2_000,
  benchmark: () => {
    nextPageBenchmarkCalls += 1;
    return 1;
  },
});
assert.equal(nextPage().tier, 'premium');
assert.equal(nextPage().source, 'cache');
assert.equal(nextPageBenchmarkCalls, 0, 'a fresh platform page reuses a valid device cache');

const cached = JSON.parse(storage.getItem(DEVICE_TIER_CACHE_KEY));
cached.resolvedAt = 2_000 - DEVICE_TIER_CACHE_TTL_MS;
storage.setItem(DEVICE_TIER_CACHE_KEY, JSON.stringify(cached));
const afterTtl = createPlatformDeviceTierResolver({
  storage,
  navigatorLike: premiumAndroid,
  locationLike: { search: '' },
  now: () => 2_000,
  benchmark: () => 1500,
});
assert.equal(afterTtl().tier, 'standard');
assert.equal(afterTtl().source, 'benchmark');

const override = createPlatformDeviceTierResolver({
  storage: null,
  navigatorLike: premiumAndroid,
  locationLike: { search: '?deviceTier=low' },
  now: () => 3_000,
  benchmark: () => {
    throw new Error('override must skip the benchmark');
  },
});
assert.equal(override().tier, 'low');
assert.equal(override().source, 'override');

assert.equal(
  buildPlayableNavigationUrl({
    base: './',
    htmlFile: 'pins-swipe',
    version: 'abc123',
    deviceTier: 'premium',
    hostPaused: true,
    auto: true,
    level: 5,
  }),
  './pins-swipe.html?hostPaused=1&auto=1&level=5&quality=premium&tier=premium&v=abc123',
  'live mount and prefetch share an exact URL with the parent-owned tier',
);
assert.throws(
  () => buildPlayableNavigationUrl({
    base: './',
    htmlFile: 'pins-swipe',
    version: 'abc123',
    deviceTier: 'unsupported',
  }),
  /device tier/,
);

console.log('device tier: parent-owned one-shot classification, cache and override OK');
