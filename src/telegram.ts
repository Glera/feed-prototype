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

import { resolveTelegramStartParam } from './telegram-start-param.mjs';

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

/** Telegram launch start_param (deep-link payload), e.g. a challenge id.
 *
 * Main Mini App deep links carry the same value in `initDataUnsafe`, raw
 * `initData`, and the launch URL's `tgWebAppStartParam`.  Reading all three is
 * intentional: Telegram clients do not hydrate them at exactly the same time.
 * The backend still validates signed initData before any privileged action.
 */
export function getStartParam(): string | null {
  try {
    const tg = (window as any).Telegram?.WebApp;
    return resolveTelegramStartParam({
      search: location.search,
      hash: location.hash,
      webViewStartParam: (window as any).Telegram?.WebView?.initParams?.tgWebAppStartParam,
      unsafeStartParam: tg?.initDataUnsafe?.start_param,
      initData: tg?.initData,
    });
  } catch {
    return null;
  }
}

/** A challenge deep-link start_param is a plain uuid (with or without dashes). */
export function isChallengeParam(p: string | null): boolean {
  if (!p) return false;
  return /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(p);
}

/** Public island deep links use a compact `i_<telegram user id>` start param. */
export function islandOwnerFromParam(p: string | null): number | null {
  const match = p?.match(/^i_([1-9][0-9]{0,18})$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/** Open the Telegram share sheet for a deep link. Inside Telegram uses
 *  openTelegramLink (native chooser); falls back to a new tab elsewhere. */
export function shareTelegramLink(shareUrl: string, deepLink: string, text: string): void {
  const link = deepLink
    ? `https://t.me/share/url?url=${encodeURIComponent(deepLink)}&text=${encodeURIComponent(text)}`
    : shareUrl;
  if (!link) return;
  const tg: AnyTG | undefined = (window as any).Telegram?.WebApp;
  try {
    if (tg && typeof tg.openTelegramLink === 'function') { tg.openTelegramLink(link); return; }
  } catch { /* fall through */ }
  try { window.open(link, '_blank'); } catch { /* blocked */ }
}

export function shareChallenge(shareUrl: string, deepLink: string, text: string): void {
  shareTelegramLink(shareUrl, deepLink, text);
}

/** Native Telegram confirmation where available; browser fallback elsewhere. */
export function showConfirm(message: string): Promise<boolean> {
  const tg: AnyTG | undefined = (window as any).Telegram?.WebApp;
  if (tg && typeof tg.showConfirm === 'function') {
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(Boolean(value));
      };
      try { tg.showConfirm(message, done); } catch { done(window.confirm(message)); }
    });
  }
  return Promise.resolve(window.confirm(message));
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
