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
// Some feed entries REUSE another mechanic's shipped HTML (e.g. a different level of
// the same build). id → html basename. Falls back to the id itself.
const HTML_ALIAS: Record<string, string> = {
  'pins-l3-swipe': 'pins-swipe',   // level-3 pins series rides the same pins-swipe build (?level=3)
};
function htmlFileFor(id: string): string { return HTML_ALIAS[id] ?? id; }
function mechanicVersion(id: string): string {
  return MECH_VERSIONS[htmlFileFor(id)] || BUILD_TAG;   // shared HTML → shared cache-bust hash
}

/** Cover image URL for a feed entry — keyed by the ENTRY id (NOT the aliased
 *  html), so an entry that reuses another mechanic's build (e.g. pins-l3-swipe →
 *  pins-swipe.html at ?level=3) ships its OWN cover baked at its level. Missing
 *  covers fall back to the standard card via the <img> onerror handler. */
// Cover aspect bucket for THIS device, set once at boot from the measured slot
// aspect (see Feed.pickCoverBucket). '' = tall (~0.55, modern phones), '.c' =
// compact (~0.72, iPhone SE / small Android). Covers are baked in both aspects so
// the object-fit:fill'd poster registers with the live canvas on either cluster.
let coverBucket = '';
export function setCoverBucket(suffix: string): void {
  coverBucket = suffix === '.c' ? '.c' : '';
}
// Cover-generation epoch — bump when covers are re-baked WITHOUT a payload change
// (the `?v=` below is the payload hash, so it wouldn't bust the WebView cover cache
// on its own). cv=2: two-aspect buckets (0.55/0.72). cv=3: re-baked at REAL Telegram
// aspects (mobile 0.65 / desktop 0.80) + object-fit:cover.
const COVER_EPOCH = 3;
export function coverUrl(id: string): string {
  let base = new URLSearchParams(location.search).get('base') || './';
  if (!base.endsWith('/')) base += '/';
  return `${base}${id}.cover${coverBucket}.jpg?v=${mechanicVersion(id)}&cv=${COVER_EPOCH}`;
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
  { id: 'pins-l3-swipe' },                    // level-3 pins as its own 1-level series (spaced away from pins-swipe)
  { id: 'short-drama-swipe' },
  { id: 'merge-second-board-v1-swipe' },
  { id: 'merge-second-board-v2-swipe' },
];

/** Resolve a playable's HTML URL. Relative by default (same Render site);
 *  override the host with `?base=…` for local development. */
export function playableUrl(id: string, options: { hostPaused?: boolean; auto?: boolean; series?: string; level?: number } = {}): string {
  let base = new URLSearchParams(location.search).get('base') || './';
  if (!base.endsWith('/')) base += '/';
  const url = `${base}${htmlFileFor(id)}.html`;   // may alias to another mechanic's build
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
