const DEVICE_TIERS = new Set(['premium', 'standard', 'low']);

/**
 * Pure navigation builder shared by live iframe mounts and byte-prefetch.
 * Keeping the host tier here makes it impossible for those URLs to drift.
 */
export function buildPlayableNavigationUrl({
  base,
  htmlFile,
  version,
  deviceTier,
  hostPaused = false,
  auto,
  series,
  level,
}) {
  if (!DEVICE_TIERS.has(deviceTier)) throw new Error('invalid platform device tier');
  const normalizedBase = String(base || './').endsWith('/') ? String(base || './') : `${base}/`;
  const params = new URLSearchParams();
  if (hostPaused) params.set('hostPaused', '1');
  if (auto !== undefined) params.set('auto', auto ? '1' : '0');
  if (series) params.set('series', series);
  if (level != null) params.set('level', String(level));
  params.set('quality', deviceTier);
  params.set('tier', deviceTier);
  params.set('v', version);
  return `${normalizedBase}${htmlFile}.html?${params.toString()}`;
}
