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
  if (typeof webViewStartParam === 'string' && webViewStartParam.length > 0) {
    return webViewStartParam;
  }

  const fromQuery = new URLSearchParams(String(search || '')).get('tgWebAppStartParam');
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;

  const fragment = String(hash || '').replace(/^#/, '');
  const fromHash = new URLSearchParams(fragment).get('tgWebAppStartParam');
  if (typeof fromHash === 'string' && fromHash.length > 0) return fromHash;

  if (typeof unsafeStartParam === 'string' && unsafeStartParam.length > 0) {
    return unsafeStartParam;
  }

  const fromInitData = new URLSearchParams(String(initData || '')).get('start_param');
  return typeof fromInitData === 'string' && fromInitData.length > 0
    ? fromInitData
    : null;
}
