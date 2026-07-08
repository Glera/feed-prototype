/**
 * Real playables used as feed mechanics (phase 2).
 *
 * Each is a self-contained single-HTML build sitting on the same Render static
 * site as this prototype (the `playables-export` repo). We load them by
 * relative URL into an <iframe>, so on Render `./pins-v1.html` resolves to the
 * sibling file. Debug / -applovin duplicates are intentionally excluded — they
 * aren't distinct mechanics.
 *
 * Local dev: the sibling HTML files don't exist at localhost, so pass
 * `?base=https://<your-render-host>/` to point the iframes at the deployed
 * bundles while developing the feed shell locally.
 */
// Build stamp baked by vite (same value as the version badge). Used to
// cache-bust mechanic iframe URLs so a redeploy is picked up even by WebViews
// (Telegram) that cache same-origin siblings by URL and ignore Cache-Control.
declare const __PLATFORM_VERSION__: string;
const BUILD_TAG = (typeof __PLATFORM_VERSION__ === 'string' ? __PLATFORM_VERSION__ : 'dev').replace(/[^0-9]/g, '') || 'dev';

// Per-mechanic cache-bust version = the content hash of each mechanic's shipped
// bundle, published by export-swipe.sh into versions.json and loaded at boot
// (setMechanicVersions, fetched no-store). A mechanic's iframe URL changes ONLY
// when ITS bundle changes, so unchanged mechanics stay cached across deploys, and
// a changed one busts even inside a stale-cached feed (the manifest is always
// fetched fresh). Falls back to the feed build tag for anything not in the map.
let MECH_VERSIONS: Record<string, string> = {};
export function setMechanicVersions(m: Record<string, string> | null | undefined): void {
  if (m && typeof m === 'object') MECH_VERSIONS = m;
}
function mechanicVersion(id: string): string {
  return MECH_VERSIONS[id] || BUILD_TAG;
}

export interface Playable {
  id: string;
}

export const PLAYABLES: Playable[] = [
  { id: 'merge-locked-v1-swipe' },
  { id: 'pins-swipe' },
  { id: 'marble-sort-swipe' },
  { id: 'merge-timepress-v1-swipe' },
  { id: 'merge-timepress-v2-swipe' },
  { id: 'merge-timepress-no-orders-v1-swipe' },
  { id: 'merge-timepress-no-orders-v2-swipe' },
  { id: 'merge-second-board-v1-swipe' },
  { id: 'merge-second-board-v2-swipe' },
];

/** Resolve a playable's HTML URL. Relative by default (same Render site);
 *  override the host with `?base=…` for local development. */
export function playableUrl(id: string, options: { hostPaused?: boolean; auto?: boolean; series?: string; level?: number } = {}): string {
  let base = new URLSearchParams(location.search).get('base') || './';
  if (!base.endsWith('/')) base += '/';
  const url = `${base}${id}.html`;
  const params = new URLSearchParams();
  if (options.hostPaused) params.set('hostPaused', '1');
  if (options.auto !== undefined) params.set('auto', options.auto ? '1' : '0');
  // Series difficulty/economy overrides for this level (JSON, url-encoded). The
  // mechanic reads `?series=` at boot and applies them (shared/series.ts).
  if (options.series) params.set('series', options.series);
  // Which built-in LEVEL the mechanic should load (e.g. pins series: level 1, 2…).
  // The mechanic reads `?level=` at boot (main.ts currentLevelIdx).
  if (options.level != null) params.set('level', String(options.level));
  // Cache-bust: per-mechanic content hash (falls back to the feed build tag) so
  // the WebView refetches a mechanic's sibling HTML exactly when its bundle changed.
  params.set('v', mechanicVersion(id));
  const query = params.toString();
  return query ? `${url}?${query}` : url;
}
