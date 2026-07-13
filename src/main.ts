import './styles.css';
import { createFeed } from './feed';
import { setMechanicVersions } from './playables';
import { initTelegram, getStartParam, islandOwnerFromParam, isChallengeParam } from './telegram';
import { initTelemetry } from './telemetry';
import { apiGetChallenge, apiPublicIsland, type ChallengeView, type PublicIslandView } from './api';

// Telegram Mini App (no-op outside Telegram): fullscreen under the notch,
// disable Telegram's own vertical swipe, mirror safe-area insets into --safe-*.
initTelegram();
// Telemetry (D3): flush the event queue on background/close. Events themselves
// are emitted from the feed; no-op network outside Telegram.
initTelemetry();

const viewport = document.getElementById('viewport')!;
const feedEl = document.getElementById('feed')!;

// If launched from a challenge deep-link (start_param = challenge id), fetch it
// first so the feed can open on the challenged mechanic. Normal launches skip
// the await entirely (getStartParam is sync) → no added boot latency.
async function boot(): Promise<void> {
  // Per-mechanic cache-bust manifest (content hashes, written by export-swipe.sh).
  // Fetched no-store + cb so even a stale-cached feed pulls the CURRENT versions →
  // a changed mechanic's iframe URL busts without needing a full app cache clear.
  try {
    const r = await fetch(`./versions.json?cb=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) setMechanicVersions(await r.json());
  } catch { /* missing/offline → fall back to the feed build tag */ }

  let challenge: ChallengeView | null = null;
  let publicIsland: PublicIslandView | null = null;
  // Telegram deep-link start_param OR ?c=<id> (set when tapping an inbox card, which
  // reloads — reusing the same landing path).
  const sp = getStartParam() || new URLSearchParams(location.search).get('c');
  if (isChallengeParam(sp)) {
    challenge = await apiGetChallenge(sp!);   // null if offline / not found → boots normally
  }
  const queryOwner = Number(new URLSearchParams(location.search).get('island'));
  const ownerId = islandOwnerFromParam(sp) || (Number.isSafeInteger(queryOwner) && queryOwner > 0 ? queryOwner : null);
  if (ownerId != null) {
    try { publicIsland = await apiPublicIsland(ownerId); } catch { /* unavailable/private → normal feed */ }
  }
  createFeed(viewport, feedEl, challenge, publicIsland);
}
const query = new URLSearchParams(location.search);
const startParam = getStartParam();
const labAuthLaunch = startParam === 'lab_auth'
  || (Boolean((import.meta as any).env?.DEV) && query.get('labAuth') === '1');

if (labAuthLaunch) {
  // Focused device approval flow: do not mount or warm the playable feed under
  // a security decision. The backend remains the authority for dev allowlisting
  // and feature availability.
  void import('./lab-auth').then((module) => module.mountCatalogLabAuth());
} else {
  void boot();
}

// On-device backend diagnostics: ?diag=1, or open in Telegram via
// t.me/<bot>?startapp=diag (start_param='diag') — shows initData + /session status
// right on screen (no desktop console in Telegram).
// Debug panel lives on the feed bar (right of the switcher icons). Also openable
// via ?diag=1 / startapp=diag.
if (!labAuthLaunch && (query.get('diag') === '1' || startParam === 'diag')) {
  import('./debug').then((m) => m.mountDebugPanel());
}
