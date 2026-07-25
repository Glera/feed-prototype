/**
 * Share / Challenge v1 top-of-feed rail (migrated out of feed.ts).
 *
 * The rail is the unified top row: [You] [friends…] [challenges…]. The challenge
 * INBOX cards (friends' challenges I haven't beaten) render here, after the
 * island friends cluster, preserving the exact DOM/classes the feed used before
 * so the OFF path stays byte-identical.
 *
 * A friend who has thrown me an active challenge is shown as their island
 * friends-HUD avatar decorated with a ⚡ badge (display-only). The two data
 * sources are kept SEPARATE by construction: `friendsWithActiveChallenge` reads
 * ONLY the challenge inbox; the friend cluster is authored by the island code.
 * We never merge the friendship graph and the challenge graph in data — only in
 * pixels (spec D11 HUD note).
 */
import type { ChallengeInboxItem } from './api';

export interface ChallengeRailRenderOptions {
  inbox: ChallengeInboxItem[];
  /** HTML-escape helper (shared with the feed so escaping is identical). */
  esc: (s: string) => string;
  /** Insert challenge cards after this element (the friends cluster, else You). */
  anchor: Element | null;
}

/**
 * Render the challenge inbox cards into the stories rail. Idempotent: it removes
 * any prior `.story[data-challenge]` cards first, then re-inserts from `inbox`.
 * DOM is byte-identical to the pre-migration feed renderer — taps are handled by
 * the feed's existing `.story[data-challenge]` event delegation, so no per-card
 * listener is attached here.
 */
export function renderChallengeInboxRail(rail: HTMLElement, options: ChallengeRailRenderOptions): void {
  const { inbox, esc, anchor } = options;
  rail.querySelectorAll('.story[data-challenge]').forEach((el) => el.remove());
  const frag = document.createDocumentFragment();
  for (const ch of inbox) {
    const name = ch.challenger.first_name || ch.challenger.username || 'Друг';
    const initial = (name.trim()[0] || '?').toUpperCase();
    const el = document.createElement('div');
    el.className = 'story';
    el.dataset.challenge = ch.id;
    el.innerHTML =
      `<div class="story__avatar story__avatar--challenge${ch.played ? ' story__avatar--viewed' : ''}">` +
        `<span>${esc(initial)}</span><i class="story__bolt" aria-hidden="true">⚡</i></div>` +
      `<div class="story__name">${esc(name)}</div>`;
    frag.appendChild(el);
  }
  if (anchor && anchor.nextSibling) rail.insertBefore(frag, anchor.nextSibling);
  else rail.appendChild(frag);
}

/**
 * PURE: the set of friend user-ids who have thrown the caller an active
 * (unbeaten) incoming challenge, derived ONLY from the challenge inbox. The
 * island friendship graph is intentionally NOT consulted here.
 */
export function friendsWithActiveChallenge(inbox: ChallengeInboxItem[]): Set<number> {
  const ids = new Set<number>();
  for (const ch of inbox) {
    const id = ch.challenger?.id;
    if (typeof id === 'number' && Number.isFinite(id)) ids.add(id);
  }
  return ids;
}

const CHALLENGE_BADGE_CLASS = 'isln-friend__challenge-badge';

/**
 * Display-only: decorate the already-rendered island friend cluster avatars
 * whose owner has an active incoming challenge with a ⚡ badge. Additive and
 * fully reversible — it never rewrites the island-authored cluster, only adds
 * (or removes) a single badge child per matching avatar. Safe to call repeatedly.
 */
export function applyChallengeBadges(cluster: HTMLElement | null, challengerIds: Set<number>): void {
  if (!cluster) return;
  cluster.querySelectorAll<HTMLElement>('[data-friend-visit]').forEach((button) => {
    const id = Number(button.dataset.friendVisit);
    const wanted = Number.isFinite(id) && challengerIds.has(id);
    const existing = button.querySelector(`.${CHALLENGE_BADGE_CLASS}`);
    if (wanted && !existing) {
      const badge = document.createElement('i');
      badge.className = CHALLENGE_BADGE_CLASS;
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = '⚡';
      button.appendChild(badge);
    } else if (!wanted && existing) {
      existing.remove();
    }
  });
}
