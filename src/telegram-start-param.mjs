/**
 * Resolve Telegram's Mini App launch payload across client generations.
 *
 * Telegram documents the same value in two places for a Main Mini App deep
 * link: `Telegram.WebApp.initDataUnsafe.start_param` and the launch URL's
 * `tgWebAppStartParam` query parameter.  Some clients make the URL parameter
 * available before (or instead of) hydrating `initDataUnsafe`, so routing must
 * not depend on only one representation.
 */
export function resolveTelegramStartParam({
  search = '',
  hash = '',
  webViewStartParam = null,
  unsafeStartParam = null,
  initData = '',
} = {}) {
  const fromQuery = new URLSearchParams(String(search || '')).get('tgWebAppStartParam');
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  const fragment = String(hash || '').replace(/^#/, '');
  const fragmentQueryAt = fragment.indexOf('?');
  const fragmentParams = fragmentQueryAt >= 0
    ? fragment.slice(fragmentQueryAt + 1)
    : fragment;
  const fromHash = new URLSearchParams(fragmentParams).get('tgWebAppStartParam');
  if (typeof fromHash === 'string' && fromHash.length > 0) return fromHash;

  if (typeof unsafeStartParam === 'string' && unsafeStartParam.length > 0) {
    return unsafeStartParam;
  }

  const fromInitData = new URLSearchParams(String(initData || '')).get('start_param');
  if (typeof fromInitData === 'string' && fromInitData.length > 0) return fromInitData;

  // telegram-web-app.js may restore WebView.initParams from sessionStorage, so
  // this is deliberately the last fallback after all current-launch sources.
  return typeof webViewStartParam === 'string' && webViewStartParam.length > 0
    ? webViewStartParam
    : null;
}
