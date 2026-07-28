const DEVICE_TIER_SCHEMA = 'swipe.platform-device-tier.v1';
export const DEVICE_TIER_CACHE_KEY = 'swipe_platform_device_tier_v1';
export const DEVICE_TIER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const DEVICE_TIERS = new Set(['premium', 'standard', 'low']);

function frozen(value) {
  return Object.freeze(value);
}

function safeGlobal(name) {
  try { return globalThis[name] ?? null; } catch { return null; }
}

function normalizedSignals(navigatorLike = {}) {
  return frozen({
    userAgent: typeof navigatorLike.userAgent === 'string' ? navigatorLike.userAgent : '',
    vendor: typeof navigatorLike.vendor === 'string' ? navigatorLike.vendor : '',
    maxTouchPoints: Number.isFinite(navigatorLike.maxTouchPoints)
      ? Number(navigatorLike.maxTouchPoints)
      : 0,
    hardwareConcurrency: Number.isFinite(navigatorLike.hardwareConcurrency)
      ? Number(navigatorLike.hardwareConcurrency)
      : null,
    deviceMemory: Number.isFinite(navigatorLike.deviceMemory)
      ? Number(navigatorLike.deviceMemory)
      : null,
  });
}

/**
 * Platform-owned classification. The Canvas2D benchmark is measured in the
 * visible parent document, never in a hidden/host-paused mechanic iframe.
 *
 * Unlike the ad-playable detector, this does not downgrade every in-app
 * WKWebView by UA shape: Telegram is itself an in-app WebView, and the parent
 * benchmark already measures that actual execution environment.
 */
export function classifyPlatformDeviceTier(benchmarkOpsPerSec, navigatorLike = {}) {
  if (!Number.isFinite(benchmarkOpsPerSec) || benchmarkOpsPerSec <= 0) return 'standard';

  let tier = benchmarkOpsPerSec >= 3000
    ? 'premium'
    : benchmarkOpsPerSec >= 1200
      ? 'standard'
      : 'low';
  const signals = normalizedSignals(navigatorLike);

  if (signals.deviceMemory !== null) {
    if (signals.deviceMemory <= 1) tier = 'low';
    else if (signals.deviceMemory <= 2 && tier === 'premium') tier = 'standard';
  }

  const appleMobile = /iPad|iPhone|iPod/.test(signals.userAgent)
    || (/Macintosh/.test(signals.userAgent) && signals.maxTouchPoints > 1)
    || (/Apple/.test(signals.vendor) && signals.maxTouchPoints > 1);
  if (!appleMobile
    && signals.hardwareConcurrency !== null
    && signals.hardwareConcurrency <= 2
    && benchmarkOpsPerSec < 2000) {
    tier = 'low';
  }
  return tier;
}

/** Measure the same Canvas2D workload the playable quality profiles use. */
export function measurePlatformCanvas2dOps(
  budgetMs = 300,
  documentLike = safeGlobal('document'),
  performanceLike = safeGlobal('performance'),
) {
  if (!documentLike?.createElement || !performanceLike?.now || budgetMs <= 0) return 0;
  const canvas = documentLike.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext?.('2d');
  if (!context) return 0;

  const startedAt = performanceLike.now();
  let operations = 0;
  while (performanceLike.now() - startedAt < budgetMs) {
    context.clearRect(0, 0, 256, 256);
    for (let index = 0; index < 50; index += 1) {
      context.fillStyle = `hsl(${index * 7},70%,50%)`;
      context.shadowColor = '#000';
      context.shadowBlur = 4;
      context.beginPath();
      context.arc((index * 13) % 256, (index * 17) % 256, 10, 0, Math.PI * 2);
      context.fill();
    }
    operations += 1;
  }
  return Math.round((operations / budgetMs) * 1000);
}

function readCachedResolution(storage, now, signals) {
  if (!storage?.getItem) return null;
  try {
    const parsed = JSON.parse(storage.getItem(DEVICE_TIER_CACHE_KEY) || 'null');
    if (!parsed
      || parsed.schema !== DEVICE_TIER_SCHEMA
      || !DEVICE_TIERS.has(parsed.tier)
      || !Number.isFinite(parsed.benchmarkOpsPerSec)
      || !Number.isFinite(parsed.resolvedAt)
      || parsed.userAgent !== signals.userAgent
      || now - parsed.resolvedAt < 0
      || now - parsed.resolvedAt >= DEVICE_TIER_CACHE_TTL_MS) return null;
    return frozen({
      schema: DEVICE_TIER_SCHEMA,
      tier: parsed.tier,
      benchmarkOpsPerSec: Number(parsed.benchmarkOpsPerSec),
      source: 'cache',
      resolvedAt: Number(parsed.resolvedAt),
      signals,
    });
  } catch {
    return null;
  }
}

function writeCachedResolution(storage, resolution) {
  if (!storage?.setItem) return;
  try {
    storage.setItem(DEVICE_TIER_CACHE_KEY, JSON.stringify({
      schema: DEVICE_TIER_SCHEMA,
      tier: resolution.tier,
      benchmarkOpsPerSec: resolution.benchmarkOpsPerSec,
      resolvedAt: resolution.resolvedAt,
      userAgent: resolution.signals.userAgent,
    }));
  } catch {
    // Telegram privacy mode can deny storage; the page-scoped one-shot still holds.
  }
}

/**
 * Build a page-scoped resolver. The returned function is idempotent: benchmark
 * and classification execute at most once for the whole platform page.
 */
export function createPlatformDeviceTierResolver(dependencies = {}) {
  let pageResolution = null;

  return function resolvePlatformDeviceTier() {
    if (pageResolution) return pageResolution;

    const navigatorLike = dependencies.navigatorLike ?? safeGlobal('navigator') ?? {};
    const locationLike = dependencies.locationLike ?? safeGlobal('location');
    const storage = Object.prototype.hasOwnProperty.call(dependencies, 'storage')
      ? dependencies.storage
      : safeGlobal('localStorage');
    const now = typeof dependencies.now === 'function' ? dependencies.now() : Date.now();
    const signals = normalizedSignals(navigatorLike);

    try {
      const override = new URLSearchParams(locationLike?.search || '').get('deviceTier');
      if (DEVICE_TIERS.has(override)) {
        pageResolution = frozen({
          schema: DEVICE_TIER_SCHEMA,
          tier: override,
          benchmarkOpsPerSec: null,
          source: 'override',
          resolvedAt: now,
          signals,
        });
        return pageResolution;
      }

      const cached = readCachedResolution(storage, now, signals);
      if (cached) {
        pageResolution = cached;
        return pageResolution;
      }

      const benchmark = dependencies.benchmark ?? measurePlatformCanvas2dOps;
      const benchmarkOpsPerSec = Number(benchmark(300));
      const tier = classifyPlatformDeviceTier(benchmarkOpsPerSec, signals);
      pageResolution = frozen({
        schema: DEVICE_TIER_SCHEMA,
        tier,
        benchmarkOpsPerSec: Number.isFinite(benchmarkOpsPerSec) && benchmarkOpsPerSec > 0
          ? benchmarkOpsPerSec
          : null,
        source: benchmarkOpsPerSec > 0 ? 'benchmark' : 'fallback',
        resolvedAt: now,
        signals,
      });
      if (pageResolution.source === 'benchmark') writeCachedResolution(storage, pageResolution);
      return pageResolution;
    } catch {
      pageResolution = frozen({
        schema: DEVICE_TIER_SCHEMA,
        tier: 'standard',
        benchmarkOpsPerSec: null,
        source: 'fallback',
        resolvedAt: now,
        signals,
      });
      return pageResolution;
    }
  };
}

export const resolvePlatformDeviceTier = createPlatformDeviceTierResolver();
