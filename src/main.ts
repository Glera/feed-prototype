import './styles.css';
import { createFeed } from './feed';
import { setMechanicVersions } from './playables';
import { initTelegram, getInitData, getStartParam, islandOwnerFromParam, islandFriendCodeFromParam, isChallengeParam } from './telegram';
import { initTelemetry } from './telemetry';
import { apiGetChallenge, apiPublicIsland, type ChallengeView, type PublicIslandView } from './api';
import { catalogLabAuthRequested } from './catalog-lab-navigation.mjs';
import { mobileReviewNavigation } from './mobile-review-navigation.mjs';
import { loadVerifiedFeedRosterSessionSnapshot } from './feed-roster.mjs';
import { userScopedStorage } from './user-scope';

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
  // Operator decision (F005): VITE_ISLAND_ENABLED gates the ENTIRE social surface,
  // direct-entry deep links included. With the flag OFF, `i_<owner>`/`?island=`
  // does not resolve a public island (island world never mounts) and `f_<code>`
  // is not accepted — the deep link is silently ignored.
  const islandEnabled = (() => {
    const raw = String((import.meta as any).env?.VITE_ISLAND_ENABLED ?? '').toLowerCase();
    return raw === 'true' || raw === '1';
  })();
  const queryOwner = Number(new URLSearchParams(location.search).get('island'));
  const ownerId = islandEnabled
    ? (islandOwnerFromParam(sp) || (Number.isSafeInteger(queryOwner) && queryOwner > 0 ? queryOwner : null))
    : null;
  if (ownerId != null) {
    try { publicIsland = await apiPublicIsland(ownerId); } catch { /* unavailable/private → normal feed */ }
  }
  // Friend-invite deep link (startapp=f_<code>): the feed accepts it after the
  // first /session (it owns the toast + the friend HUD), mirroring i_<owner>.
  const friendAcceptCode = islandEnabled ? islandFriendCodeFromParam(sp) : null;
  // Read exactly once. /session may stage a newer activation later, but a live
  // ring is immutable under the user's finger; that activation starts on the
  // next page/session load.
  // Per-user storage view: a roster activation is issued to ONE player by
  // /session, and its mapping ids end up on that player's feed decisions.
  const rosterSnapshot = getInitData()
    ? await loadVerifiedFeedRosterSessionSnapshot(userScopedStorage(localStorage))
    : null;
  createFeed(viewport, feedEl, challenge, publicIsland, rosterSnapshot, friendAcceptCode);
}
const query = new URLSearchParams(location.search);
const startParam = getStartParam();
const labAuthLaunch = catalogLabAuthRequested({ search: location.search, startParam });
const mobileReviewLaunch = mobileReviewNavigation({
  search: location.search,
  startParam,
});

if (mobileReviewLaunch.requested) {
  // A focused phone review must not boot the feed underneath the exact
  // authority surface. Telegram initData still gates every backend read/write.
  void import('./mobile-review').then((module) => (
    module.mountMobileReview(mobileReviewLaunch.bundleId)
  ));
} else if (labAuthLaunch) {
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
if (!mobileReviewLaunch.requested && !labAuthLaunch
  && (query.get('diag') === '1' || startParam === 'diag')) {
  import('./debug').then((m) => m.mountDebugPanel());
}
