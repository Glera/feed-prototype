import './styles.css';
import { createFeed } from './feed';
import { initTelegram, getStartParam, isChallengeParam } from './telegram';
import { initTelemetry } from './telemetry';
import { apiGetChallenge, type ChallengeView } from './api';

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
  let challenge: ChallengeView | null = null;
  const sp = getStartParam();
  if (isChallengeParam(sp)) {
    challenge = await apiGetChallenge(sp!);   // null if offline / not found → boots normally
  }
  createFeed(viewport, feedEl, challenge);
}
void boot();

// On-device backend diagnostics: ?diag=1, or open in Telegram via
// t.me/<bot>?startapp=diag (start_param='diag') — shows initData + /session status
// right on screen (no desktop console in Telegram).
// Debug panel lives on the feed bar (right of the switcher icons). Also openable
// via ?diag=1 / startapp=diag.
const startParam = (window as any).Telegram?.WebApp?.initDataUnsafe?.start_param;
if (new URLSearchParams(location.search).get('diag') === '1' || startParam === 'diag') {
  import('./debug').then((m) => m.mountDebugPanel());
}
