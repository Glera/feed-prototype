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
export interface Playable {
  id: string;
}

export const PLAYABLES: Playable[] = [
  { id: 'pins-v1' },
  { id: 'marble-sort' },
  { id: 'merge-timepress-v1' },
  { id: 'merge-timepress-v2' },
  { id: 'merge-timepress-no-orders-v1' },
  { id: 'merge-timepress-no-orders-v2' },
  { id: 'merge-second-board-v1' },
  { id: 'merge-second-board-v2' },
  { id: 'merge-locked-v1' },
];

/** Resolve a playable's HTML URL. Relative by default (same Render site);
 *  override the host with `?base=…` for local development. */
export function playableUrl(id: string): string {
  let base = new URLSearchParams(location.search).get('base') || './';
  if (!base.endsWith('/')) base += '/';
  return `${base}${id}.html`;
}
