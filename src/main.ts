import './styles.css';
import { createFeed } from './feed';
import { initTelegram } from './telegram';
import { initTelemetry } from './telemetry';

// Telegram Mini App (no-op outside Telegram): fullscreen under the notch,
// disable Telegram's own vertical swipe, mirror safe-area insets into --safe-*.
initTelegram();
// Telemetry (D3): flush the event queue on background/close. Events themselves
// are emitted from the feed; no-op network outside Telegram.
initTelemetry();

const viewport = document.getElementById('viewport')!;
const feedEl = document.getElementById('feed')!;

createFeed(viewport, feedEl);

// On-device backend diagnostics: ?diag=1, or open in Telegram via
// t.me/<bot>?startapp=diag (start_param='diag') — shows initData + /session status
// right on screen (no desktop console in Telegram).
// Small always-available debug button (bottom-right, above the bar) — opens the
// diag panel (initData/session, event log, pending stars, flush, reset). TEST
// phase; gate/remove before public. Also openable via ?diag=1 / startapp=diag.
{
  const dbg = document.createElement('button');
  dbg.textContent = '🐞';
  dbg.setAttribute('aria-label', 'Debug');
  dbg.style.cssText =
    'position:fixed;right:8px;bottom:calc(env(safe-area-inset-bottom,0px) + 66px);z-index:2147483000;' +
    'width:34px;height:34px;border-radius:50%;border:0;background:rgba(0,0,0,0.45);color:#fff;' +
    'font-size:16px;line-height:34px;padding:0;opacity:0.5;';
  dbg.addEventListener('click', () => import('./debug').then((m) => m.mountDebugPanel()));
  document.body.appendChild(dbg);
}
const startParam = (window as any).Telegram?.WebApp?.initDataUnsafe?.start_param;
if (new URLSearchParams(location.search).get('diag') === '1' || startParam === 'diag') {
  import('./debug').then((m) => m.mountDebugPanel());
}
