import './styles.css';
import { createFeed } from './feed';
import { setMechanicVersions } from './playables';
import { initTelegram, getInitData, getStartParam, islandOwnerFromParam, islandFriendCodeFromParam, isChallengeParam } from './telegram';
import { initTelemetry } from './telemetry';
import {
  apiGetChallenge, apiGetChallengeRawRequired, apiGetChallengeSpecBoundRequired,
  ApiRequestError, type ChallengeView, type PublicIslandView,
} from './api';
import { apiPublicIsland } from './api';
import { challengeV1Enabled } from './challenge-config';
import { catalogLabAuthRequested } from './catalog-lab-navigation.mjs';
import { loadVerifiedFeedRosterSessionSnapshot } from './feed-roster.mjs';

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
    challenge = await resolveDeepLinkChallenge(sp!);
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
  const rosterSnapshot = getInitData()
    ? await loadVerifiedFeedRosterSessionSnapshot(localStorage)
    : null;
  createFeed(viewport, feedEl, challenge, publicIsland, rosterSnapshot, friendAcceptCode);
}

/**
 * Classify a challenge deep-link. A legacy (non-spec-bound) challenge boots
 * exactly as before. A spec-bound v1 challenge carries content-addressed level
 * identity that this build's exact-level play surface does not yet mount — so we
 * NEVER hand it to the legacy path (which would silently play the wrong built-in
 * level): instead we show an honest "please update" toast and boot the normal
 * feed. This holds in BOTH flag states (flag OFF has no wire header at all; flag
 * ON detects spec_digest). Missing/offline still degrades silently as before.
 */
async function resolveDeepLinkChallenge(id: string): Promise<ChallengeView | null> {
  if (challengeV1Enabled()) {
    try {
      // Fetch WITH the wire header. A spec-bound view (spec_digest present) is a v1
      // challenge — the feed plays its EXACT content-addressed level in the overlay
      // (Feed.maybeShowChallengeIntro → runV1RecipientPlay). A legacy challenge
      // (spec_digest null) flows through the legacy path unchanged.
      return await apiGetChallengeSpecBoundRequired(id);
    } catch (e) {
      if (isUpgradeRequired(e)) { showUpgradeRequiredToast(); return null; }
      return apiGetChallenge(id); // 404/offline → silent legacy fallback (unchanged).
    }
  }
  // Flag OFF: probe WITHOUT the wire header so a v1 challenge answers 426 and we
  // can honestly say "update", rather than the legacy getter's silent null.
  try {
    return await apiGetChallengeRawRequired(id);
  } catch (e) {
    if (isUpgradeRequired(e)) { showUpgradeRequiredToast(); return null; }
    return null; // not found / offline → boot normally (byte-identical to before).
  }
}

function isUpgradeRequired(e: unknown): boolean {
  return e instanceof ApiRequestError
    && (e.status === 426 || e.code === 'challenge_client_upgrade_required');
}

let upgradeToastShown = false;
function showUpgradeRequiredToast(): void {
  if (upgradeToastShown) return;
  upgradeToastShown = true;
  const tg = (window as unknown as { Telegram?: { WebApp?: { showAlert?: (m: string) => void } } }).Telegram?.WebApp;
  const message = 'Обнови приложение, чтобы сыграть этот вызов ⚡';
  if (tg && typeof tg.showAlert === 'function') { try { tg.showAlert(message); return; } catch { /* fall through */ } }
  const toast = document.createElement('div');
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'position:fixed', 'left:50%', 'top:calc(env(safe-area-inset-top,0px) + 16px)',
    'transform:translateX(-50%)', 'z-index:2147483647', 'max-width:82%',
    'padding:10px 14px', 'border-radius:12px', 'background:rgba(20,22,28,0.94)',
    'color:#fff', 'font:600 13px/1.3 system-ui,sans-serif', 'text-align:center',
    'box-shadow:0 6px 24px rgba(0,0,0,0.4)', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(toast);
  window.setTimeout(() => toast.remove(), 5000);
}
const query = new URLSearchParams(location.search);
const startParam = getStartParam();
const labAuthLaunch = catalogLabAuthRequested({ search: location.search, startParam });

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
