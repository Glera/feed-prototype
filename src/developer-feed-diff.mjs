/**
 * «Изменения dev-ленты» — the read-only inventory behind the dev-feed badge.
 *
 * Slice 1 of the frozen selective-promotion v1 contract (reconciliation
 * 18.08.2026 §C.2a). It is a PROJECTION of state the feed client already
 * holds: the baked platform identity, the operator rework queue the feed
 * already fetched for its per-mechanic button, the latest platform intake
 * receipt, and the exact candidate this operator adopted. It issues no request
 * of its own, owns no mutation authority, and carries no `Продвинуть…` control
 * — promotion is a separate slice over the existing content-bound approval.
 *
 * Every status string here is reused verbatim from the surface that already
 * owns it, so the sheet and the per-mechanic button can never tell the
 * operator two different stories about the same task.
 */
import {
  groupOperatorPlayableReworkQueue,
  operatorPlayableReworkPresentation,
  operatorPlayableReworkQueuePresentation,
} from './operator-playable-reworks.mjs';

/** The audience vocabulary the adoption card already shows (candidate-feed-adoption). */
const ADOPTED_STATUS = 'Аудитория: Только мне';
const PLATFORM_STATUS = 'что живёт сейчас';
const EMPTY_STATUS = 'Dev не отличается от публичного';
const CATALOG_STATUS = 'данных пока нет';
const CATALOG_DETAIL = 'Клиенту не отдаётся активный release/candidate каталога — '
  + 'показывать нечего, пока это не станет server-owned проекцией.';

const TONE_ORDER = { error: 0, ok: 1, warn: 2, neutral: 3 };

const toneForReworkState = (state) => {
  if (state === 'needs_help' || state === 'blocked' || state === 'capability_gap_root') return 'error';
  if (state === 'ready_for_approval') return 'ok';
  if (state === 'preparing' || state === 'escalated_to_mac_b') return 'warn';
  return 'neutral';
};

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** `abcdef…` → `abcdef012345`; `sha256:abc…` keeps its algorithm prefix. */
const shortDigest = (value) => {
  const raw = text(value);
  if (!raw) return '';
  const separator = raw.indexOf(':');
  if (separator > 0) {
    const prefix = raw.slice(0, separator + 1);
    const body = raw.slice(separator + 1);
    return body.length > 12 ? `${prefix}${body.slice(0, 12)}…` : raw;
  }
  return raw.length > 12 ? `${raw.slice(0, 12)}…` : raw;
};

const identityLine = (label, value, mono = false) => {
  const resolved = text(value);
  return resolved ? { label, value: resolved, mono } : null;
};

/** The counts strip, worded exactly as the rework details panel words it. */
const reworkCounts = (presentation) => [
  presentation.active ? `активно ${presentation.active}` : '',
  presentation.queued ? `в очереди ${presentation.queued}` : '',
  presentation.duplicates ? `возможных дублей ${presentation.duplicates}` : '',
].filter(Boolean).join(' · ') || 'Новых замечаний пока нет';

/**
 * The platform intake status, worded exactly as the ⚙ intake details word it.
 * `null` when no platform rework is in flight.
 */
function platformIntakeRow(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (receipt.cancellation?.status === 'confirmed') return null;
  const deliveryStatus = receipt.delivery?.status;
  const terminalReady = receipt.terminal?.status === 'READY_TO_PLAY';
  const terminalNeedsHelp = receipt.terminal?.status === 'NEEDS_HELP';
  const failed = deliveryStatus === 'failed_terminal' || terminalNeedsHelp;
  const confirmed = deliveryStatus === 'confirmed';
  const cancelling = Boolean(receipt.cancellation);
  const status = receipt.cancellation?.status === 'failed_terminal'
    ? 'Не удалось завершить отмену; нужна помощь.'
    : cancelling
      ? 'Отмена сохранена и синхронизируется.'
      : terminalNeedsHelp
    ? `NEEDS_HELP: ${text(receipt.terminal?.summary)}`
    : terminalReady
      ? `READY_TO_PLAY: ${text(receipt.terminal?.summary)}`
      : failed
        ? 'Синхронизация остановлена; изменения не опубликованы.'
        : confirmed
          ? 'Инженерный тикет создан; изменения ещё не опубликованы.'
          : 'Задача сохранена и ждёт синхронизации; изменения не опубликованы.';
  const blocker = terminalNeedsHelp
    ? text(receipt.terminal?.blocker?.operatorAction)
    : failed ? 'Нужна помощь с конфигурацией инженерного контура.' : '';
  return Object.freeze({
    status,
    tone: failed || receipt.cancellation?.status === 'failed_terminal'
      ? 'error' : terminalReady ? 'ok' : confirmed ? 'neutral' : 'warn',
    blocker: blocker || null,
  });
}

function mechanicRows(input) {
  const rows = new Map();
  const entries = input.reworks ? Array.from(input.reworks) : [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [playableId, rawQueue] = entry;
    if (typeof playableId !== 'string' || !playableId) continue;
    // Re-filter through the shared grouper: the presentation helpers read raw
    // fields and must never be handed an unvalidated projection item.
    const queue = groupOperatorPlayableReworkQueue(
      Array.isArray(rawQueue) ? rawQueue : [],
    ).get(playableId) || [];
    if (queue.length === 0) continue;
    const newest = queue[0];
    const task = operatorPlayableReworkPresentation(newest);
    const aggregate = operatorPlayableReworkQueuePresentation(queue);
    rows.set(playableId, {
      playableId,
      status: task.label,
      state: task.state,
      tone: toneForReworkState(task.state),
      counts: reworkCounts(aggregate),
      blocker: task.blocker,
      identity: [
        identityLine('runtime', shortDigest(newest.request?.runtime?.artifactDigest), true),
        identityLine('source', shortDigest(newest.request?.runtime?.sourceCommit), true),
      ].filter(Boolean),
      adopted: false,
    });
  }

  const adoption = input.adoption;
  if (adoption && typeof adoption.playableId === 'string' && adoption.playableId) {
    const existing = rows.get(adoption.playableId);
    const identity = [
      identityLine('release', adoption.releaseId, true),
      identityLine('artifact', shortDigest(adoption.candidateArtifactDigest), true),
      identityLine('source', shortDigest(adoption.sourceCommit), true),
    ].filter(Boolean);
    if (existing) {
      existing.adopted = true;
      existing.identity = identity;
    } else {
      rows.set(adoption.playableId, {
        playableId: adoption.playableId,
        status: ADOPTED_STATUS,
        state: 'adopted',
        tone: 'ok',
        counts: 'Новых замечаний пока нет',
        blocker: null,
        identity,
        adopted: true,
      });
    }
  }

  return Array.from(rows.values()).sort((left, right) => {
    const byTone = TONE_ORDER[left.tone] - TONE_ORDER[right.tone];
    return byTone !== 0 ? byTone : left.playableId.localeCompare(right.playableId);
  }).map((row) => Object.freeze({ ...row, identity: Object.freeze(row.identity) }));
}

export function developerFeedDiffModel(input = {}) {
  const platformInput = input.platform || {};
  const intake = platformIntakeRow(input.platformIntake);
  const mechanics = mechanicRows(input);
  const catalogIdentity = Array.isArray(input.catalog?.activeRelease)
    ? input.catalog.activeRelease.filter(Boolean)
    : [];
  const changed = mechanics.filter((row) => ![
    'superseded', 'capability_gap_root_covered', 'obsolete',
  ].includes(row.state)).length + (intake ? 1 : 0);
  return Object.freeze({
    visible: input.operatorSurfacesActive === true || Boolean(input.adoption),
    changed,
    empty: changed === 0,
    platform: Object.freeze({
      status: PLATFORM_STATUS,
      identity: Object.freeze([
        identityLine('source', shortDigest(platformInput.sourceSha), true),
        identityLine('сборка', platformInput.stamp),
      ].filter(Boolean)),
      intake,
    }),
    mechanics: Object.freeze(mechanics),
    catalog: Object.freeze({
      status: catalogIdentity.length ? '' : CATALOG_STATUS,
      detail: catalogIdentity.length ? '' : CATALOG_DETAIL,
      identity: Object.freeze(catalogIdentity),
    }),
  });
}

// ── DOM ─────────────────────────────────────────────────────────────────────

const element = (tag, className, textContent) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined) node.textContent = textContent;
  return node;
};

function identityList(lines) {
  const list = element('dl', 'dev-diff__identity');
  for (const line of lines) {
    const row = element('div');
    row.append(element('dt', null, line.label));
    const value = element('dd', line.mono ? 'dev-diff__mono' : null, line.value);
    row.append(value);
    list.append(row);
  }
  list.hidden = lines.length === 0;
  return list;
}

function groupSection(title) {
  const group = element('section', 'dev-diff__group');
  group.append(element('h3', 'dev-diff__group-title', title));
  return group;
}

function rowArticle(kind, tone) {
  const row = element('article', 'dev-diff__row');
  row.dataset.row = kind;
  row.dataset.testid = 'dev-diff-row';
  if (tone) row.dataset.tone = tone;
  return row;
}

function rowHead(title, status) {
  const head = element('div', 'dev-diff__row-head');
  head.append(element('b', null, title));
  head.append(element('small', 'dev-diff__status', status));
  return head;
}

export function mountDeveloperFeedDiffSurface(host, options) {
  if (!(host instanceof HTMLElement) || !options || typeof options !== 'object') {
    throw new Error('developer_feed_diff_invalid');
  }
  const onShowMechanic = typeof options.onShowMechanic === 'function'
    ? options.onShowMechanic
    : null;

  let destroyed = false;
  let open = false;
  let model = developerFeedDiffModel(options.input || {});

  const root = element('div', 'dev-diff-surface');
  root.dataset.testid = 'dev-diff-surface';

  const badge = element('button', 'candidate-feed-preview__badge '
    + 'candidate-feed-preview__badge--developer dev-diff__badge');
  badge.type = 'button';
  badge.dataset.testid = 'developer-feed-badge';
  badge.setAttribute('aria-haspopup', 'dialog');
  const badgeLabel = element('span', 'dev-diff__badge-label');
  badgeLabel.append(
    element('span', 'dev-diff__badge-label-line', 'Dev-лента'),
    element('span', 'dev-diff__badge-label-line', 'Только мне'),
  );
  badge.append(badgeLabel);
  const badgeCount = element('span', 'dev-diff__badge-count');
  badgeCount.dataset.testid = 'dev-diff-badge-count';
  badge.append(badgeCount);

  const sheet = element('div', 'dev-diff');
  sheet.dataset.testid = 'dev-diff-sheet';
  sheet.hidden = true;
  const scrim = element('div', 'dev-diff__scrim');
  scrim.dataset.close = '';
  const card = element('section', 'dev-diff__card');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', 'Изменения dev-ленты');
  card.tabIndex = -1;
  const heading = element('h2', 'dev-diff__h', 'Изменения dev-ленты');
  const body = element('div', 'dev-diff__body');
  const close = element('button', 'dev-diff__close', 'Закрыть');
  close.type = 'button';
  close.dataset.close = '';
  card.append(heading, body, close);
  sheet.append(scrim, card);
  root.append(badge, sheet);
  host.append(root);

  const renderBadge = () => {
    root.hidden = !model.visible;
    badgeCount.textContent = String(model.changed);
    badgeCount.hidden = model.changed === 0;
    badge.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  const renderBody = () => {
    body.replaceChildren();
    if (model.empty) {
      const empty = element('p', 'dev-diff__empty', EMPTY_STATUS);
      empty.dataset.testid = 'dev-diff-empty';
      body.append(empty);
    }

    const platform = groupSection('Платформа');
    const platformRow = rowArticle('platform', model.platform.intake?.tone || 'neutral');
    platformRow.append(rowHead('Feed shell', model.platform.status));
    platformRow.append(identityList(model.platform.identity));
    if (model.platform.intake) {
      platformRow.append(element('p', 'dev-diff__detail', model.platform.intake.status));
      if (model.platform.intake.blocker) {
        platformRow.append(element('p', 'dev-diff__blocker', model.platform.intake.blocker));
      }
    }
    platform.append(platformRow);
    body.append(platform);

    const mechanics = groupSection('Механики и очередь правок');
    if (model.mechanics.length === 0) {
      // Scoped wording: the sheet-wide `Dev не отличается от публичного` is
      // already above, and repeating it per group reads as two verdicts.
      mechanics.append(element('p', 'dev-diff__none', 'Новых замечаний пока нет'));
    }
    for (const row of model.mechanics) {
      const article = rowArticle('mechanic', row.tone);
      article.dataset.playableId = row.playableId;
      article.append(rowHead(row.playableId, row.status));
      if (row.adopted) {
        article.append(element('small', 'dev-diff__adopted', ADOPTED_STATUS));
      }
      article.append(element('small', 'dev-diff__counts', row.counts));
      if (row.blocker) article.append(element('p', 'dev-diff__blocker', row.blocker));
      article.append(identityList(row.identity));
      if (onShowMechanic) {
        const jump = element('button', 'dev-diff__action', 'Показать механику');
        jump.type = 'button';
        jump.dataset.action = 'show-mechanic';
        article.append(jump);
      }
      mechanics.append(article);
    }
    body.append(mechanics);

    const catalog = groupSection('Catalog (marble-sort)');
    const catalogRow = rowArticle('catalog', 'neutral');
    catalogRow.append(rowHead('sort/base', model.catalog.status));
    if (model.catalog.detail) {
      catalogRow.append(element('p', 'dev-diff__detail', model.catalog.detail));
    }
    catalogRow.append(identityList(model.catalog.identity));
    catalog.append(catalogRow);
    body.append(catalog);
  };

  const openSheet = () => {
    if (destroyed || open || !model.visible) return;
    open = true;
    renderBody();
    sheet.hidden = false;
    renderBadge();
    // Focus the dialog itself, never a control inside it: focusing the trailing
    // Закрыть button scrolls this scrollable card to its own bottom, so the
    // operator would open the inventory already past the platform row.
    card.scrollTop = 0;
    card.focus({ preventScroll: true });
  };

  const closeSheet = (restoreFocus = true) => {
    if (!open) return;
    open = false;
    sheet.hidden = true;
    body.replaceChildren();
    renderBadge();
    if (restoreFocus && !destroyed) badge.focus();
  };

  const onBadgeClick = () => { if (open) closeSheet(); else openSheet(); };
  const onSheetClick = (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (!target) return;
    if (target.closest('[data-close]')) {
      closeSheet();
      return;
    }
    const jump = target.closest('[data-action="show-mechanic"]');
    if (!jump) return;
    const article = jump.closest('[data-playable-id]');
    const playableId = article instanceof HTMLElement ? article.dataset.playableId : '';
    // Close first: the jump animates the feed, and a sheet left open over it
    // would hide the very card the operator asked to see.
    closeSheet(false);
    if (playableId && onShowMechanic) onShowMechanic(playableId);
  };
  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    closeSheet();
  };

  badge.addEventListener('click', onBadgeClick);
  sheet.addEventListener('click', onSheetClick);
  document.addEventListener('keydown', onKeyDown);

  renderBadge();

  return Object.freeze({
    get open() { return open; },
    update(next) {
      if (destroyed) return;
      model = developerFeedDiffModel(next || {});
      if (open && !model.visible) closeSheet(false);
      renderBadge();
      if (!open) return;
      // A background projection refresh must not throw the operator back to the
      // top of a list they are reading.
      const scrollTop = card.scrollTop;
      renderBody();
      card.scrollTop = scrollTop;
    },
    close() { closeSheet(false); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      open = false;
      badge.removeEventListener('click', onBadgeClick);
      sheet.removeEventListener('click', onSheetClick);
      document.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  });
}
