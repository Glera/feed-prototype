/**
 * Telegram Mini App integration.
 *
 * No-ops entirely outside Telegram (normal browser, AppLovin webview, Render
 * preview) — there the CSS `env(safe-area-inset-*)` fallbacks apply as before.
 *
 * Inside Telegram it:
 *   - ready() + expand()                          — standard handshake.
 *   - requestFullscreen() (Bot API 8.0)           — edge-to-edge UNDER the notch.
 *   - disableVerticalSwipes() (Bot API 7.7+)      — CRITICAL: the feed pages
 *       vertically, and Telegram's own swipe-down-to-minimise would otherwise
 *       fight (and steal) every upward swipe.
 *   - mirrors Telegram's safe-area insets into the `--safe-*` CSS vars, because
 *       in fullscreen `env(safe-area-inset-*)` is NOT populated — Telegram
 *       exposes the device inset (`safeAreaInset`) AND its own header inset
 *       (`contentSafeAreaInset`); we sum them so feed chrome clears both.
 */

type AnyTG = any;

/** Raw Telegram initData for the `Authorization: tma <initData>` header. Null
 *  outside Telegram (normal browser / AppLovin) — callers then no-op the social
 *  features. `?initData=` query override is a DEV convenience for testing the
 *  backend from a plain browser. */
export function getInitData(): string | null {
  try {
    const d = (window as any).Telegram?.WebApp?.initData;
    if (typeof d === 'string' && d.length > 0) return d;
    const q = new URLSearchParams(location.search).get('initData');
    return q && q.length > 0 ? q : null;
  } catch {
    return null;
  }
}

/** Telegram launch start_param (deep-link payload), e.g. a challenge id. Null
 *  outside Telegram. Tags session entry source (direct|challenge|referral). */
export function getStartParam(): string | null {
  try {
    const p = (window as any).Telegram?.WebApp?.initDataUnsafe?.start_param;
    return typeof p === 'string' && p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

function setVars(top: number, bottom: number, left: number, right: number): void {
  const root = document.documentElement;
  const px = (n: number) => `${Math.max(0, Math.round(n || 0))}px`;
  root.style.setProperty('--safe-top', px(top));
  root.style.setProperty('--safe-bottom', px(bottom));
  root.style.setProperty('--safe-left', px(left));
  root.style.setProperty('--safe-right', px(right));
}

export function initTelegram(): void {
  const tg: AnyTG | undefined = (window as any).Telegram?.WebApp;
  if (!tg) return;

  const call = (fn: string, ...args: unknown[]) => {
    try { if (typeof tg[fn] === 'function') tg[fn](...args); } catch { /* old client */ }
  };

  call('ready');
  call('expand');
  call('disableVerticalSwipes');     // keep the vertical feed swipe for ourselves
  // Fullscreen ONLY on mobile Telegram (ios/android). On Telegram Web / Desktop
  // (tdesktop, macos, weba, webk) we keep the normal windowed Mini App — going
  // edge-to-edge there just makes a giant awkward window.
  const platform = String(tg.platform || '');
  const isMobile = platform === 'ios' || platform === 'android';
  if (isMobile) call('requestFullscreen'); // edge-to-edge under the notch (8.0+)
  // Match the feed bg EXACTLY (--platform-bg #07090f) so if Telegram's fullscreen
  // webview is even a hair shorter than the screen, the strip it leaves at the
  // bottom is the same colour as our bar and is invisible (was #0a0a0f — slightly
  // lighter — which read as a visible band under the bottom bar).
  call('setHeaderColor', '#07090f');
  call('setBackgroundColor', '#07090f');

  // Lock to portrait — the feed is a vertical pager, landscape makes no sense.
  // Telegram lockOrientation() (Bot API 8.0+) pins the Mini App to its current
  // (portrait) orientation. Best-effort screen.orientation.lock as a web fallback
  // (Android/Chrome in fullscreen; iOS Safari ignores it — harmless).
  call('lockOrientation');
  try { (screen.orientation as any)?.lock?.('portrait').catch(() => {}); } catch { /* unsupported */ }

  const applyInsets = () => {
    const sa = tg.safeAreaInset || {};         // device notch / home indicator
    const ca = tg.contentSafeAreaInset || {};  // Telegram's own header/controls
    setVars(
      (sa.top || 0) + (ca.top || 0),
      (sa.bottom || 0) + (ca.bottom || 0),
      (sa.left || 0) + (ca.left || 0),
      (sa.right || 0) + (ca.right || 0),
    );
  };
  applyInsets();

  // Re-apply whenever Telegram reports a change (entering fullscreen, rotation,
  // header show/hide). Older clients simply never fire these — harmless.
  for (const ev of ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged']) {
    try { tg.onEvent?.(ev, applyInsets); } catch { /* noop */ }
  }
}
