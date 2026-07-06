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
const startParam = (window as any).Telegram?.WebApp?.initDataUnsafe?.start_param;
if (new URLSearchParams(location.search).get('diag') === '1' || startParam === 'diag') {
  import('./api').then(({ apiDiagnose }) => apiDiagnose()).then((d) => {
    const pre = document.createElement('pre');
    pre.style.cssText =
      'position:fixed;inset:0 0 auto 0;z-index:99999;margin:0;background:#000;color:#3f6;' +
      'font:12px/1.5 ui-monospace,monospace;padding:14px;white-space:pre-wrap;word-break:break-all;';
    pre.textContent = 'SWIPE DIAG\n' + JSON.stringify(d, null, 2) + '\n\n(tap to dismiss)';
    pre.addEventListener('click', () => pre.remove());
    document.body.appendChild(pre);
  });
}
