/**
 * «Изменения dev-ленты» — the read-only inventory behind the dev-feed badge.
 *
 * The inventory remains a server-owned projection.  Its one mutation control
 * appears only after the backend has prepared an exact content-bound
 * `candidate -> published` closure; the backend revalidates the same closure
 * and confirmation code before applying it.
 *
 * Every status string here is reused verbatim from the surface that already
 * owns it, so the sheet and the per-mechanic button can never tell the
 * operator two different stories about the same task.
 */
import {
  groupOperatorPlayableReworkQueue,
} from './operator-playable-reworks.mjs';
import {
  operatorAudiencePresentation,
  resolveOperatorPresentationVocabulary,
} from './operator-presentation-vocabulary.mjs';

const EMPTY_STATUS = 'Dev-лента совпадает с релизной';
const CATALOG_STATUS = 'данных пока нет';
const CATALOG_DETAIL = 'Для sort/base пока нет dev или public записи каталога.';
const CATALOG_INVALID_STATUS = 'Проекция недоступна';
const CATALOG_INVALID_DETAIL = 'Server-owned состояние каталога не прошло проверку.';

const text = (value) => (typeof value === 'string' ? value.trim() : '');

const MECHANIC_NAMES = Object.freeze({
  'arrows-v1-swipe': 'Arrows',
  'marble-sort-swipe': 'Marble Sort',
  'merge-locked-v1-swipe': 'Merge',
  'merge-second-board-v1-swipe': 'Merge · второе поле',
  'merge-second-board-v2-swipe': 'Merge · второе поле',
  'merge-timepress-v1-swipe': 'Timepress',
  'merge-timepress-v2-swipe': 'Timepress',
  'merge-timepress-no-orders-v1-swipe': 'Timepress',
  'minesweeper-v1-swipe': 'Minesweeper',
  'pins-swipe': 'Pins',
  'pins-l3-swipe': 'Pins',
  'pins-l5-swipe': 'Pins',
  'pins-l7-swipe': 'Pins',
  'pins-l9-swipe': 'Pins',
  'short-drama-swipe': 'Short Drama',
  'solitaire-v1-swipe': 'Klondike',
});

const mechanicName = (playableId) => MECHANIC_NAMES[playableId]
  || playableId.replace(/-v\d+(?:-swipe)?$/, '').replace(/-swipe$/, '').replaceAll('-', ' ');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PLAYABLE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const exactObject = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const validDateTime = (value) => typeof value === 'string'
  && DATE_TIME.test(value) && Number.isFinite(Date.parse(value));

const validateCatalogRuntime = (value) => {
  if (!exactObject(value, [
    'releaseId', 'playableId', 'runtimeArtifactDigest', 'sourceCommit',
  ])) return null;
  if (!UUID.test(value.releaseId) || !PLAYABLE_ID.test(value.playableId)
    || !DIGEST.test(value.runtimeArtifactDigest) || !SHA.test(value.sourceCommit)) return null;
  return Object.freeze({ ...value });
};

const validateCatalogEntry = (value) => {
  if (!exactObject(value, [
    'entryId', 'kind', 'state', 'stateVersion', 'seriesId', 'levelSpecHash',
    'runtime', 'stateChangedAt',
  ])) return null;
  if (!UUID.test(value.entryId)
    || !['level', 'series', 'theme'].includes(value.kind)
    || !['candidate', 'canary', 'paused', 'published'].includes(value.state)
    || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 0
    || !validDateTime(value.stateChangedAt)) return null;
  const seriesId = value.seriesId === null ? null
    : typeof value.seriesId === 'string' && UUID.test(value.seriesId) ? value.seriesId : undefined;
  const levelSpecHash = value.levelSpecHash === null ? null
    : typeof value.levelSpecHash === 'string' && HASH.test(value.levelSpecHash)
      ? value.levelSpecHash : undefined;
  if (seriesId === undefined || levelSpecHash === undefined) return null;
  if ((value.kind === 'series' && (seriesId === null || levelSpecHash !== null))
    || (value.kind === 'level' && (levelSpecHash === null || seriesId !== null))
    || (value.kind === 'theme' && (seriesId !== null || levelSpecHash !== null))) return null;
  const runtime = value.runtime === null ? null : validateCatalogRuntime(value.runtime);
  if (value.runtime !== null && runtime === null) return null;
  return Object.freeze({ ...value, runtime });
};

/** Strict fail-closed validator for the optional server-owned `/session` projection. */
export function validateDeveloperFeedCatalogDiff(value) {
  if (!exactObject(value, [
    'schema', 'mechanic', 'variant', 'available', 'unavailableReason', 'dev', 'public',
  ])) return null;
  if (value.schema !== 'feed.developer-catalog-diff.v1'
    || value.mechanic !== 'sort' || value.variant !== 'base'
    || typeof value.available !== 'boolean'
    || ![null, 'catalog_entry_unavailable', 'catalog_projection_invalid']
      .includes(value.unavailableReason)) return null;
  const dev = value.dev === null ? null : validateCatalogEntry(value.dev);
  const publicEntry = value.public === null ? null : validateCatalogEntry(value.public);
  if ((value.dev !== null && dev === null) || (value.public !== null && publicEntry === null)) return null;
  const hasRow = dev !== null || publicEntry !== null;
  if (value.available !== hasRow
    || value.available !== (value.unavailableReason === null)
    || dev?.state === 'published'
    || (publicEntry !== null && publicEntry.state !== 'published')) return null;
  return Object.freeze({ ...value, dev, public: publicEntry });
}

/** Strict validator for the server-derived anti-misclick publication closure. */
export function validateCatalogDirectPromotionPrepared(value) {
  if (!exactObject(value, [
    'schema', 'operationId', 'action', 'entryId', 'expectedStateVersion',
    'fromState', 'toState', 'fromAudience', 'toAudience',
    'runtimeArtifactDigest', 'confirmationCode',
  ])) return null;
  if (value.schema !== 'catalog.direct-promotion.prepared.v1'
    || !UUID.test(value.operationId) || value.action !== 'publish'
    || !UUID.test(value.entryId)
    || !Number.isSafeInteger(value.expectedStateVersion)
    || value.expectedStateVersion < 0
    || value.fromState !== 'candidate' || value.toState !== 'published'
    || value.fromAudience !== 'exactUser' || value.toAudience !== 'public'
    || !DIGEST.test(value.runtimeArtifactDigest)
    || !/^[0-9A-F]{6}$/.test(value.confirmationCode)) return null;
  return Object.freeze({ ...value });
}

/** Strict validator for the mutation receipt before refreshing server state. */
export function validateCatalogDirectPromotionResult(value) {
  if (!exactObject(value, [
    'schema', 'operationId', 'entryId', 'fromState', 'toState',
    'stateVersion', 'replayed',
  ])) return null;
  if (value.schema !== 'catalog.direct-promotion.result.v1'
    || !UUID.test(value.operationId) || !UUID.test(value.entryId)
    || value.fromState !== 'candidate' || value.toState !== 'published'
    || !Number.isSafeInteger(value.stateVersion) || value.stateVersion < 1
    || typeof value.replayed !== 'boolean') return null;
  return Object.freeze({ ...value });
}

function mechanicRows(input) {
  const adoption = input.adoption;
  if (!adoption || typeof adoption.playableId !== 'string' || !adoption.playableId) return [];
  const audience = operatorAudiencePresentation(input.vocabulary, 'exactUser');
  const adoptedStatus = `Аудитория: ${audience.icon} ${audience.label}`;
  const instructions = [];
  const entries = input.reworks ? Array.from(input.reworks) : [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [playableId, rawQueue] = entry;
    if (playableId !== adoption.playableId) continue;
    const queue = groupOperatorPlayableReworkQueue(
      Array.isArray(rawQueue) ? rawQueue : [],
    ).get(playableId) || [];
    for (const item of queue) {
      if (text(item.request?.runtime?.artifactDigest) !== text(adoption.candidateArtifactDigest)) {
        continue;
      }
      const instruction = text(item.request?.instruction);
      if (instruction && !instructions.includes(instruction)) instructions.push(instruction);
    }
  }

  // A work request is not a feed difference. The one immutable candidate
  // currently adopted into this operator's feed is.
  return [Object.freeze({
    playableId: adoption.playableId,
    title: mechanicName(adoption.playableId),
    status: adoptedStatus,
    state: 'adopted',
    tone: 'ok',
    instructions: Object.freeze(instructions),
    adopted: true,
  })];
}

export function developerFeedDiffModel(input = {}) {
  const vocabulary = resolveOperatorPresentationVocabulary(input.vocabulary);
  const exactUserAudience = operatorAudiencePresentation(vocabulary, 'exactUser');
  const mechanics = mechanicRows({ ...input, vocabulary });
  const catalog = validateDeveloperFeedCatalogDiff(input.catalog);
  const preparedPromotion = validateCatalogDirectPromotionPrepared(
    input.catalogPromotion,
  );
  const catalogChanged = catalog?.dev ? 1 : 0;
  const changed = mechanics.length + catalogChanged;
  const catalogInvalid = input.catalog != null && catalog === null;
  const catalogUnavailable = catalog?.unavailableReason === 'catalog_projection_invalid';
  const catalogUnknown = input.catalog == null || catalogInvalid || catalogUnavailable;
  const promotion = catalog?.dev?.state === 'candidate'
    && catalog.dev.runtime !== null
    && preparedPromotion?.entryId === catalog.dev.entryId
    && preparedPromotion.expectedStateVersion === catalog.dev.stateVersion
    && preparedPromotion.runtimeArtifactDigest === catalog.dev.runtime.runtimeArtifactDigest
    ? preparedPromotion : null;
  return Object.freeze({
    visible: input.operatorSurfacesActive === true || Boolean(input.adoption),
    changed,
    empty: changed === 0 && !catalogUnknown,
    audience: exactUserAudience,
    mechanics: Object.freeze(mechanics),
    catalog: Object.freeze({
      changed: catalogChanged === 1,
      unknown: catalogUnknown,
      status: catalogUnknown
        ? CATALOG_INVALID_STATUS
        : catalog?.dev ? `Только мне · ${catalog.dev.state}`
          : catalog?.public ? 'Доступно всем' : CATALOG_STATUS,
      detail: catalogUnknown
        ? CATALOG_INVALID_DETAIL
        : catalog?.dev || catalog?.public ? '' : CATALOG_DETAIL,
      promotion,
      promotionPreparing: input.catalogPromotionPreparing === true,
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
  const onPromoteCatalog = typeof options.onPromoteCatalog === 'function'
    ? options.onPromoteCatalog
    : null;

  let destroyed = false;
  let open = false;
  let promotionPending = false;
  let promotionCommitted = false;
  let promotionConfirmOpen = false;
  let promotionCode = '';
  let promotionError = '';
  let catalogSelected = true;
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
    badgeLabel.replaceChildren(
      element('span', 'dev-diff__badge-label-line', 'Dev-лента'),
      element(
        'span',
        'dev-diff__badge-label-line',
        `${model.audience.icon} ${model.audience.label}`,
      ),
    );
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
    if (model.catalog.unknown) {
      const unknown = rowArticle('catalog-status', 'warn');
      unknown.dataset.testid = 'dev-diff-catalog-unknown';
      unknown.append(
        rowHead('Уровни', model.catalog.status),
        element('p', 'dev-diff__description', 'Не удалось проверить отличия. Обновите ленту.'),
      );
      body.append(unknown);
    }

    if (model.mechanics.length > 0) {
      const mechanics = groupSection('Механики');
      for (const row of model.mechanics) {
        const article = rowArticle('mechanic', row.tone);
        article.dataset.playableId = row.playableId;
        const selectableHead = element('div', 'dev-diff__selectable-head');
        const checkbox = element('input', 'dev-diff__checkbox');
        checkbox.type = 'checkbox';
        checkbox.checked = false;
        checkbox.disabled = true;
        checkbox.setAttribute('aria-label', `${row.title}: публикуется отдельно`);
        selectableHead.append(checkbox, rowHead(row.title, 'Только мне'));
        article.append(selectableHead);
        const instructions = row.instructions.length > 0
          ? row.instructions : ['Приватная версия механики отличается от релизной.'];
        for (const instruction of instructions) {
          article.append(element('p', 'dev-diff__description', instruction));
        }
        article.append(element('p', 'dev-diff__pending', 'Механика публикуется отдельно'));
        if (onShowMechanic) {
          const jump = element('button', 'dev-diff__action', 'Показать механику');
          jump.type = 'button';
          jump.dataset.action = 'show-mechanic';
          article.append(jump);
        }
        mechanics.append(article);
      }
      body.append(mechanics);
    }

    if (model.catalog.changed) {
      const catalog = groupSection('Уровни');
      const catalogRow = rowArticle('catalog', 'neutral');
      const selectableHead = element('div', 'dev-diff__selectable-head');
      const checkbox = element('input', 'dev-diff__checkbox');
      checkbox.type = 'checkbox';
      checkbox.checked = catalogSelected && Boolean(model.catalog.promotion);
      checkbox.disabled = !model.catalog.promotion || promotionPending || promotionCommitted;
      checkbox.dataset.action = 'select-catalog';
      checkbox.setAttribute('aria-label', 'Выбрать Marble Sort');
      checkbox.addEventListener('change', () => {
        catalogSelected = checkbox.checked;
        if (!catalogSelected) {
          promotionConfirmOpen = false;
          promotionCode = '';
          promotionError = '';
        }
        if (open) renderBody();
      });
      selectableHead.append(checkbox, rowHead('Marble Sort', 'Только мне'));
      catalogRow.append(selectableHead);
      catalogRow.append(element(
        'p',
        'dev-diff__description',
        'Новая версия уровней доступна только в вашей dev-ленте.',
      ));
      if (!model.catalog.promotion) {
        catalogRow.append(element(
          'p',
          'dev-diff__pending',
          model.catalog.promotionPreparing
            ? 'Проверяю возможность публикации…'
            : 'Пока нельзя выложить',
        ));
      }

      if (model.catalog.promotion && onPromoteCatalog) {
        const confirm = element('div', 'dev-diff__promotion-confirm');
        confirm.dataset.testid = 'catalog-promotion-confirm';
        confirm.hidden = !promotionConfirmOpen;
        confirm.append(
          element('p', 'dev-diff__detail', 'Только мне → Доступно всем'),
          element(
            'p',
            'dev-diff__promotion-code',
            `Код: ${model.catalog.promotion.confirmationCode}`,
          ),
        );
        const input = element('input', 'dev-diff__promotion-input');
        input.dataset.testid = 'catalog-promotion-code-input';
        input.inputMode = 'text';
        input.autocomplete = 'off';
        input.maxLength = 6;
        input.setAttribute('aria-label', 'Код подтверждения');
        input.value = promotionCode;
        input.disabled = promotionPending || promotionCommitted;
        input.addEventListener('input', () => { promotionCode = input.value; });
        const applyLabel = promotionCommitted ? 'Опубликовано'
          : promotionPending ? 'Проверяю…' : 'Подтвердить публикацию';
        const apply = element('button', 'dev-diff__action', applyLabel);
        apply.type = 'button';
        apply.dataset.action = 'confirm-catalog-publication';
        apply.disabled = !catalogSelected || promotionPending || promotionCommitted;
        confirm.append(input, apply);
        if (promotionError) {
          const error = element('p', 'dev-diff__blocker', promotionError);
          error.setAttribute('role', 'status');
          confirm.append(error);
        }
        catalogRow.append(confirm);
      }
      catalog.append(catalogRow);
      body.append(catalog);

      if (model.catalog.promotion && onPromoteCatalog) {
        const actions = element('div', 'dev-diff__publish-actions');
        const selected = element(
          'button',
          'dev-diff__action dev-diff__action--primary',
          'Выложить выбранное',
        );
        selected.type = 'button';
        selected.dataset.action = 'publish-catalog';
        selected.disabled = !catalogSelected || promotionPending || promotionCommitted;
        const all = element(
          'button',
          'dev-diff__action',
          model.mechanics.length > 0 ? 'Выложить уровни' : 'Выложить всё',
        );
        all.type = 'button';
        all.dataset.action = 'publish-all';
        all.disabled = promotionPending || promotionCommitted;
        actions.append(selected, all);
        body.append(actions);
      }
    }
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
    const publishAll = target.closest('[data-action="publish-all"]');
    const publish = target.closest('[data-action="publish-catalog"]');
    if (publishAll) catalogSelected = true;
    if (publish || publishAll) {
      if (!catalogSelected) return;
      promotionConfirmOpen = true;
      promotionError = '';
      renderBody();
      const input = body.querySelector('[data-testid="catalog-promotion-code-input"]');
      if (input instanceof HTMLInputElement) input.focus();
      return;
    }
    const apply = target.closest('[data-action="confirm-catalog-publication"]');
    if (apply && catalogSelected && model.catalog.promotion
      && onPromoteCatalog && !promotionPending) {
      const code = promotionCode.trim().toUpperCase();
      promotionPending = true;
      promotionError = '';
      renderBody();
      void Promise.resolve(onPromoteCatalog(model.catalog.promotion, code))
        .then((outcome) => {
          if (destroyed) return;
          promotionPending = false;
          if (outcome?.status === 'committed_refreshed') {
            promotionCommitted = true;
            promotionConfirmOpen = false;
            promotionCode = '';
            promotionError = '';
          } else if (outcome?.status === 'committed_refresh_pending') {
            promotionCommitted = true;
            promotionConfirmOpen = true;
            promotionError = 'Опубликовано. Не удалось обновить список — перезапустите ленту.';
          } else {
            promotionConfirmOpen = true;
            promotionError = 'Результат не подтверждён. Обновите ленту перед повтором.';
          }
          if (open) renderBody();
        })
        .catch(() => {
          if (destroyed) return;
          promotionPending = false;
          promotionConfirmOpen = true;
          promotionError = 'Код не подошёл или состояние изменилось. Публикация не подтверждена.';
          if (open) renderBody();
        });
      return;
    }
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
      const previousPromotionId = model.catalog.promotion?.operationId ?? null;
      model = developerFeedDiffModel(next || {});
      const nextPromotionId = model.catalog.promotion?.operationId ?? null;
      if (nextPromotionId === null || nextPromotionId !== previousPromotionId) {
        catalogSelected = true;
        promotionPending = false;
        promotionCommitted = false;
        promotionConfirmOpen = false;
        promotionCode = '';
        promotionError = '';
      }
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
