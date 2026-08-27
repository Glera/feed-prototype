import './styles.css';
import { createFeed } from './feed';
import {
  candidateMatchesPublicManifest,
  setCandidatePlayableOverlay,
  setMechanicVersions,
} from './playables';
import { initTelegram, getInitData, getStartParam, hasTelegramHostContext, hasTelegramLaunchUserIdentity, islandOwnerFromParam, islandFriendCodeFromParam, isChallengeParam, setTelegramReadOnlyPreviewMode } from './telegram';
import { initTelemetry, setTelemetryReadOnlyPreviewMode } from './telemetry';
import { apiGetChallenge, apiPublicIsland, apiSessionRequired, apiSourcePreviewSessionRequired, type ChallengeView, type PublicIslandView, type SessionResp } from './api';
import { catalogLabAuthRequested } from './catalog-lab-navigation.mjs';
import { feedRosterSnapshotForBoot, loadVerifiedFeedRosterSessionSnapshot } from './feed-roster.mjs';
import { userScopedStorage } from './user-scope';
import { candidateReviewReleaseIdFromParam } from './candidate-review';
import { candidateFeedPreviewRequested, resolveCandidateFeedPreview, resolveDeveloperFeedAdoption, type CandidateFeedPreviewIdentity } from './candidate-feed-preview';
import { candidateFeedStartParamRequested } from './candidate-feed-start-param.mjs';
import { consumeDeveloperFeedHandoff, mountCandidateFeedAdoption } from './candidate-feed-adoption';

const query = new URLSearchParams(location.search);
const restoredStartParam = getStartParam();
const developerFeedHandoff = consumeDeveloperFeedHandoff(restoredStartParam);
const startParam = developerFeedHandoff ? null : restoredStartParam;
const candidateFeedStartRequested = candidateFeedStartParamRequested(startParam);
const candidateFeedRequested = candidateFeedPreviewRequested(location.search, startParam);
setTelegramReadOnlyPreviewMode(candidateFeedRequested);
setTelemetryReadOnlyPreviewMode(candidateFeedRequested);

// Telegram Mini App (no-op outside Telegram): fullscreen under the notch,
// disable Telegram's own vertical swipe, mirror safe-area insets into --safe-*.
initTelegram();
// Telemetry (D3): flush the event queue on background/close. Events themselves
// are emitted from the feed; no-op network outside Telegram.
if (!candidateFeedRequested) initTelemetry();

const viewport = document.getElementById('viewport')!;
const feedEl = document.getElementById('feed')!;

function failCandidateFeedPreview(): void {
  document.body.classList.add('candidate-feed-preview-open');
  viewport.replaceChildren();
  feedEl.replaceChildren();
  const error = document.createElement('section');
  error.className = 'candidate-feed-preview__error';
  error.dataset.testid = 'candidate-feed-preview-error';
  const title = document.createElement('strong');
  title.textContent = 'Candidate недоступен';
  const detail = document.createElement('span');
  detail.textContent = 'Immutable binding не подтверждён. Обычная лента не открыта.';
  error.append(title, detail);
  document.body.appendChild(error);
}

function mountCandidateFeedBadge(): void {
  const badge = document.createElement('div');
  badge.className = 'candidate-feed-preview__badge';
  badge.dataset.testid = 'candidate-feed-preview-badge';
  badge.textContent = 'Кандидат — не опубликовано';
  document.body.appendChild(badge);
}

// If launched from a challenge deep-link (start_param = challenge id), fetch it
// first so the feed can open on the challenged mechanic. Normal launches skip
// the await entirely (getStartParam is sync) → no added boot latency.
async function boot(): Promise<void> {
  let candidate: CandidateFeedPreviewIdentity | null = null;
  let candidateSession: SessionResp | null = null;
  try {
    if (candidateFeedStartRequested
      && (!hasTelegramHostContext() || !hasTelegramLaunchUserIdentity())) {
      throw new Error('candidate_feed_start_operator_identity_required');
    }
    candidate = await resolveCandidateFeedPreview(
      location.search,
      location.origin,
      fetch,
      startParam,
    );
    setCandidatePlayableOverlay(candidate);
    if (candidateFeedStartRequested) {
      candidateSession = await apiSourcePreviewSessionRequired();
    }
  } catch {
    failCandidateFeedPreview();
    return;
  }
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
  const sp = candidateFeedRequested
    ? null
    : getStartParam() || new URLSearchParams(location.search).get('c');
  if (!candidateFeedRequested && isChallengeParam(sp)) {
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
  if (!candidateFeedRequested && ownerId != null) {
    try { publicIsland = await apiPublicIsland(ownerId); } catch { /* unavailable/private → normal feed */ }
  }
  // Friend-invite deep link (startapp=f_<code>): the feed accepts it after the
  // first /session (it owns the toast + the friend HUD), mirroring i_<owner>.
  const friendAcceptCode = islandEnabled ? islandFriendCodeFromParam(sp) : null;
  // Start /session before constructing the ring. A warm backend normally gives
  // us the newly activated roster on this first open; after 1s we preserve
  // the fast/offline boot and the same in-flight request stages it for later.
  // The ring is still immutable once createFeed receives this snapshot.
  // Per-user storage view: a roster activation is issued to ONE player by
  // /session, and its mapping ids end up on that player's feed decisions.
  let initialSessionPromise: Promise<SessionResp> | null = null;
  let rosterSnapshot = null;
  if (candidateFeedRequested) {
    const storage = userScopedStorage(localStorage);
    rosterSnapshot = await loadVerifiedFeedRosterSessionSnapshot(storage);
  } else if (getInitData()) {
    const storage = userScopedStorage(localStorage);
    const persisted = await loadVerifiedFeedRosterSessionSnapshot(storage);
    initialSessionPromise = apiSessionRequired();
    const timeout = Symbol('session-timeout');
    const initial = await Promise.race([
      initialSessionPromise.catch(() => null),
      new Promise<typeof timeout>((resolve) => window.setTimeout(() => resolve(timeout), 1000)),
    ]);
    rosterSnapshot = initial === timeout
      ? persisted
      : await feedRosterSnapshotForBoot(persisted, initial?.feedRoster);
    if (initial !== timeout && initial?.developerFeedAdoption) {
      try {
        const adopted = await resolveDeveloperFeedAdoption(initial.developerFeedAdoption);
        if (candidateMatchesPublicManifest(adopted)) {
          // The exact adopted bytes are public now.  Keeping the operator
          // overlay would falsely present a dev-only audience and suppress
          // ordinary telemetry after publication.
          setCandidatePlayableOverlay(null);
        } else {
          setCandidatePlayableOverlay(adopted);
          setTelemetryReadOnlyPreviewMode(true);
        }
      } catch { /* invalid/tampered dev adoption fails closed to the public manifest */ }
    }
  }
  const mountFeed = (): void => {
    createFeed(
      viewport,
      feedEl,
      challenge,
      publicIsland,
      rosterSnapshot,
      friendAcceptCode,
      initialSessionPromise,
      { readOnlyPreview: candidateFeedRequested },
    );
  };
  if (candidateFeedRequested) try {
    mountFeed();
    mountCandidateFeedBadge();
    if (candidate) {
      const adoption = mountCandidateFeedAdoption(candidate, candidateSession, startParam);
      if (adoption) document.body.appendChild(adoption);
    }
  } catch {
    failCandidateFeedPreview();
    return;
  } else {
    // The two-line `Dev-лента` / `Только мне` badge is owned by the feed itself: it is the
    // entry point of the read-only «Изменения dev-ленты» inventory, which needs
    // the operator capabilities and rework queue the feed already holds.
    mountFeed();
  }
}
const routedStartParam = startParam;
const labAuthLaunch = catalogLabAuthRequested({ search: location.search, startParam: routedStartParam });
const candidateReviewQuery = query.get('candidateReview');
const candidateReviewReleaseId = candidateReviewReleaseIdFromParam(routedStartParam)
  || candidateReviewReleaseIdFromParam(candidateReviewQuery ? `pr_${candidateReviewQuery}` : null);

if (candidateFeedRequested) {
  void boot();
} else if (candidateReviewReleaseId) {
  // READY deep-link: resolve only this server-owned immutable release. This
  // focused path never boots the feed or reads its mutable roster/manifest.
  void import('./candidate-review').then((module) =>
    module.mountPlayableCandidateReviewSurface(candidateReviewReleaseId));
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
// Debug panel lives on the feed bar (left of the switcher icons). Also openable
// via ?diag=1 / startapp=diag.
if (!candidateFeedRequested && !candidateReviewReleaseId && !labAuthLaunch
  && (query.get('diag') === '1' || routedStartParam === 'diag')) {
  import('./debug').then((m) => m.mountDebugPanel());
}
