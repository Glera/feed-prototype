const RELEASE_VALUE = 'release';
const PARAM = 'feedView';

export function operatorFeedView(search = location.search) {
  return new URLSearchParams(search).get(PARAM) === RELEASE_VALUE ? 'release' : 'dev';
}

export function operatorFeedViewUrl(view, href = location.href) {
  if (!['dev', 'release'].includes(view)) throw new Error('operator_feed_view_invalid');
  const url = new URL(href);
  if (view === 'release') url.searchParams.set(PARAM, RELEASE_VALUE);
  else url.searchParams.delete(PARAM);
  return url;
}

export function mountOperatorFeedViewToggle(host, { view, onChange } = {}) {
  if (!(host instanceof HTMLElement) || !['dev', 'release'].includes(view)
    || typeof onChange !== 'function') throw new Error('operator_feed_view_invalid');
  const root = document.createElement('div');
  root.className = 'operator-feed-view';
  root.dataset.view = view;
  root.dataset.testid = 'operator-feed-view-toggle';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Выбор ленты');
  for (const value of ['dev', 'release']) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.feedView = value;
    button.textContent = value === 'dev' ? 'Dev-лента' : 'Релизная лента';
    button.className = 'operator-feed-view__button';
    const active = value === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => { if (!active) onChange(value); });
    root.append(button);
  }
  host.append(root);
  return Object.freeze({ destroy() { root.remove(); } });
}
