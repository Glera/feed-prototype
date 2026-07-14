const LAB_AUTH_QUERY_KEY = 'labAuth';

/** Fail closed: only the exact server capability enables the feed entry. */
export function catalogLabAuthorizationAvailable(value) {
  return value === true;
}

/** Resolve the focused authorization route from Telegram or feed navigation. */
export function catalogLabAuthRequested({ search = '', startParam = null } = {}) {
  if (startParam === 'lab_auth') return true;
  return new URLSearchParams(String(search || '')).get(LAB_AUTH_QUERY_KEY) === '1';
}

/** Whether Close should return to the feed instead of closing the Mini App. */
export function catalogLabOpenedFromFeed(search = '') {
  return new URLSearchParams(String(search || '')).get(LAB_AUTH_QUERY_KEY) === '1';
}

/** Add the focused LAB route without dropping Telegram's launch fragment. */
export function catalogLabAuthUrl(href) {
  const url = new URL(String(href));
  url.searchParams.set(LAB_AUTH_QUERY_KEY, '1');
  return url.href;
}

/** Remove only the focused LAB route and preserve the rest of the feed URL. */
export function catalogFeedUrl(href) {
  const url = new URL(String(href));
  url.searchParams.delete(LAB_AUTH_QUERY_KEY);
  return url.href;
}
