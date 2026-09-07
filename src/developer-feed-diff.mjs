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
  operatorPlayableReworkPresentation,
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

function copyablePublicationCode(code) {
  const group = element('div', 'dev-diff__code-copy');
  const button = element('button', 'dev-diff__promotion-code', 'Код: ');
  const bareCode = element('code', null, code);
  bareCode.dataset.testid = 'publication-copy-value';
  button.append(bareCode);
  button.type = 'button';
  button.dataset.action = 'copy-publication-code';
  button.setAttribute('aria-label', `Скопировать код публикации ${code}`);
  const feedback = element('span', 'dev-diff__copy-feedback', 'Нажмите, чтобы скопировать');
  feedback.setAttribute('role', 'status');
  feedback.setAttribute('aria-live', 'polite');
  let pending = false;
  button.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    button.setAttribute('aria-busy', 'true');
    try {
      await navigator.clipboard.writeText(code);
      if (group.isConnected) feedback.textContent = 'Код скопирован';
    } catch {
      if (group.isConnected) {
        const range = document.createRange();
        range.selectNodeContents(bareCode);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        feedback.textContent = 'Не удалось скопировать. Код выделен — скопируйте его вручную или введите.';
      }
    } finally {
      pending = false;
      button.setAttribute('aria-busy', 'false');
    }
  });
  group.append(button, feedback);
  return group;
}

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

const validatePlayablePublicationItem = (value) => {
  if (!exactObject(value, [
    'releaseId', 'playableId', 'bindingDigest', 'candidateArtifactDigest',
    'runtimeArtifactDigest', 'changes',
  ]) || !UUID.test(value.releaseId) || !PLAYABLE_ID.test(value.playableId)
    || !HASH.test(value.bindingDigest) || !HASH.test(value.candidateArtifactDigest)
    || !DIGEST.test(value.runtimeArtifactDigest)
    || !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > 20
    || value.changes.some((change) => !text(change) || change !== text(change))) return null;
  return Object.freeze({ ...value, changes: Object.freeze([...value.changes]) });
};

const visiblePendingRequest = (item) => {
  const presentation = operatorPlayableReworkPresentation(item);
  if (['superseded', 'capability_gap_root_covered', 'obsolete']
    .includes(presentation.state)) return null;
  const instruction = text(item.request?.instruction);
  if (!instruction) return null;
  return Object.freeze({
    instruction,
    status: presentation.label,
    detail: presentation.blocker || 'Эта правка ещё не вошла в готовую версию.',
  });
};

const isAdoptedPublicationRequest = (item, adoption, preparedItem) => {
  if (!preparedItem || item?.queueDisposition !== 'active_batch'
    || item?.execution !== undefined) return false;
  const releaseExecution = item.releaseExecution;
  const instruction = text(item.request?.instruction);
  return Boolean(instruction)
    && releaseExecution?.state === 'ready_for_approval'
    && releaseExecution.releaseId === adoption.releaseId
    && releaseExecution.bindingDigest === adoption.bindingDigest
    && preparedItem.changes.includes(instruction);
};

export function validatePlayablePublicationPrepared(value) {
  if (!exactObject(value, [
    'schema', 'operationId', 'action', 'clientInstanceId', 'items', 'confirmationCode',
  ]) || value.schema !== 'feed.playable-publication.prepared.v1'
    || !UUID.test(value.operationId) || value.action !== 'publish'
    || !UUID.test(value.clientInstanceId) || !/^[0-9A-F]{6}$/.test(value.confirmationCode)
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 20) return null;
  const items = value.items.map(validatePlayablePublicationItem);
  if (items.some((item) => item === null)) return null;
  return Object.freeze({ ...value, items: Object.freeze(items) });
}

export function validatePlayablePublicationRequested(value) {
  if (!exactObject(value, [
    'schema', 'operationId', 'action', 'items', 'status', 'replayed',
  ]) || value.schema !== 'feed.playable-publication.requested.v1'
    || !UUID.test(value.operationId) || value.action !== 'publish'
    || !['queued', 'published'].includes(value.status) || typeof value.replayed !== 'boolean'
    || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 20) return null;
  const items = value.items.map(validatePlayablePublicationItem);
  if (items.some((item) => item === null)) return null;
  return Object.freeze({ ...value, items: Object.freeze(items) });
}

/** Apply once; track ambiguity only when the transport proves a dispatch. */
export async function applyPlayablePublicationClient(prepared, selection, confirmationCode, transport) {
  if (!selection || selection.length !== prepared.items.length
    || !prepared.items.every((item, index) => (
      item.releaseId === selection[index].releaseId
      && item.bindingDigest === selection[index].bindingDigest
      && item.candidateArtifactDigest === selection[index].candidateArtifactDigest
    ))) return { status: 'rejected', reason: 'candidate_changed' };
  let raw;
  try {
    raw = await transport.apply({
      schema: 'feed.playable-publication.apply.v1',
      operationId: prepared.operationId, action: 'publish', items: selection, confirmationCode,
    });
  } catch (error) {
    if (error?.acceptance === 'unknown') return { status: 'acceptance_unknown' };
    return {
      status: 'rejected',
      reason: error?.acceptance === 'rejected' ? 'request_rejected' : 'not_sent',
    };
  }
  const result = validatePlayablePublicationRequested(raw);
  if (!result || result.operationId !== prepared.operationId
    || result.items.length !== prepared.items.length
    || !result.items.every((item, index) => (
      item.releaseId === prepared.items[index].releaseId
      && item.bindingDigest === prepared.items[index].bindingDigest
      && item.candidateArtifactDigest === prepared.items[index].candidateArtifactDigest
    ))) return { status: 'acceptance_unknown' };
  let refreshed = false;
  try { refreshed = await transport.refresh(); } catch { /* acceptance is already proven */ }
  return {
    status: result.status === 'published'
      ? refreshed ? 'published_refreshed' : 'published_refresh_pending'
      : refreshed ? 'queued_refreshed' : 'queued_refresh_pending',
  };
}

export function validatePlayablePublicationStatus(value, prepared) {
  if (!exactObject(value, ['schema', 'operationId', 'items'])
    || value.schema !== 'feed.playable-publication.status.v1'
    || value.operationId !== prepared.operationId
    || !Array.isArray(value.items) || value.items.length !== prepared.items.length) return null;
  const items = value.items.map((item, index) => {
    const expected = prepared.items[index];
    if (!exactObject(item, [
      'releaseId', 'bindingDigest', 'candidateArtifactDigest', 'status', 'reason',
    ]) || item.releaseId !== expected.releaseId
      || item.bindingDigest !== expected.bindingDigest
      || item.candidateArtifactDigest !== expected.candidateArtifactDigest
      || !['queued', 'running', 'published', 'not_completed', 'unknown'].includes(item.status)
      || ![null, 'expired_before_start', 'outcome_unconfirmed', 'not_found', 'unavailable']
        .includes(item.reason)) return null;
    return Object.freeze({ ...item });
  });
  return items.some((item) => item === null) ? null
    : Object.freeze({ ...value, items: Object.freeze(items) });
}

const PUBLICATION_LABELS = Object.freeze({
  queued: 'Ожидает публикации',
  running: 'Публикуется',
  published: 'Опубликовано',
  not_completed: 'Не выполнено',
  unknown: 'Статус не подтверждён',
});
const PUBLICATION_POLL_MS = 5_000;
const PUBLICATION_POLL_LIMIT = 24;

function mechanicRows(input) {
  const adoptions = Array.isArray(input.adoptions)
    ? input.adoptions : input.adoption ? [input.adoption] : [];
  if (adoptions.length > 20) return [];
  const audience = operatorAudiencePresentation(input.vocabulary, 'exactUser');
  const adoptedStatus = `Аудитория: ${audience.icon} ${audience.label}`;
  const prepared = validatePlayablePublicationPrepared(input.mechanicPublication);
  const pendingByPlayable = new Map();
  for (const entry of input.reworks ? Array.from(input.reworks) : []) {
    if (!Array.isArray(entry) || entry.length < 2 || typeof entry[0] !== 'string') continue;
    const queue = groupOperatorPlayableReworkQueue(
      Array.isArray(entry[1]) ? entry[1] : [],
    ).get(entry[0]) || [];
    if (queue.length > 0) pendingByPlayable.set(entry[0], queue);
  }
  const rows = adoptions.flatMap((adoption) => {
    if (!adoption || typeof adoption.playableId !== 'string' || !adoption.playableId) return [];
    const preparedItem = prepared?.items.find((item) => (
      item.releaseId === adoption.releaseId
      && item.playableId === adoption.playableId
      && item.bindingDigest === adoption.bindingDigest
      && item.candidateArtifactDigest === adoption.candidateArtifactDigest
    ));
    const instructions = preparedItem ? [...new Set(preparedItem.changes)] : [];
    const pendingRequests = (pendingByPlayable.get(adoption.playableId) || [])
      .filter((item) => !isAdoptedPublicationRequest(item, adoption, preparedItem))
      .map(visiblePendingRequest).filter(Boolean);
    pendingByPlayable.delete(adoption.playableId);
    return [Object.freeze({
      playableId: adoption.playableId,
      releaseId: adoption.releaseId,
      title: mechanicName(adoption.playableId),
      status: adoptedStatus,
      state: 'adopted',
      tone: 'ok',
      instructions: Object.freeze(instructions),
      pendingRequests: Object.freeze(pendingRequests),
      adopted: true,
      publication: preparedItem ? prepared : null,
    })];
  });
  for (const [playableId, queue] of pendingByPlayable) {
    const pendingRequests = queue.map(visiblePendingRequest).filter(Boolean);
    if (pendingRequests.length === 0) continue;
    rows.push(Object.freeze({
      playableId,
      releaseId: null,
      title: mechanicName(playableId),
      status: pendingRequests[0].status,
      state: 'pending',
      tone: 'warn',
      instructions: Object.freeze([]),
      pendingRequests: Object.freeze(pendingRequests),
      adopted: false,
      publication: null,
    }));
  }
  return rows;
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
    visible: input.operatorSurfacesActive === true || mechanics.length > 0,
    changed,
    empty: changed === 0 && !catalogUnknown,
    audience: exactUserAudience,
    mechanics: Object.freeze(mechanics),
    mechanicPublicationPreparing: input.mechanicPublicationPreparing === true,
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
  const onPublishMechanic = typeof options.onPublishMechanic === 'function'
    ? options.onPublishMechanic
    : null;
  const onPrepareMechanics = typeof options.onPrepareMechanics === 'function'
    ? options.onPrepareMechanics
    : null;
  const onReadPublicationStatus = typeof options.onReadPublicationStatus === 'function'
    ? options.onReadPublicationStatus : null;

  let destroyed = false;
  let open = false;
  let promotionPending = false;
  let promotionCommitted = false;
  let promotionConfirmOpen = false;
  let promotionCode = '';
  let promotionError = '';
  let catalogSelected = true;
  let model = developerFeedDiffModel(options.input || {});
  // Publication is a deliberate operator act.  Opening the inventory must
  // never silently preselect every private mechanic: the operator either
  // chooses individual rows or uses the explicit select-all control below.
  let mechanicSelected = new Set();
  let mechanicQueued = new Set();
  let mechanicPublication = model.mechanics.find((row) => row.adopted)?.publication ?? null;
  let mechanicPublicationPending = false;
  let mechanicPublicationCommitted = false;
  let mechanicPublicationConfirmOpen = false;
  let mechanicPublicationCode = '';
  let mechanicPublicationError = '';
  // Retain exact submitted identities through projection refreshes. Removing a
  // candidate from the dev inventory is not evidence of public deployment.
  const publications = new Map();
  let publicationTimer = null;
  let publicationCheckPending = false;
  let publicationChecksLeft = PUBLICATION_POLL_LIMIT;
  const codeCopies = new Map();
  const renderCopyCode = (scope, code) => {
    const current = codeCopies.get(scope);
    if (current?.code === code) return current.node;
    const node = copyablePublicationCode(code);
    codeCopies.set(scope, { code, node });
    return node;
  };

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
  // Keep this node mounted: changing an aria-live container itself is not a
  // reliable announcement, and polling must not repeatedly announce the list.
  const announcement = element('p', 'dev-diff__announcement');
  announcement.dataset.testid = 'publication-announcement';
  announcement.setAttribute('role', 'status');
  announcement.setAttribute('aria-live', 'polite');
  announcement.setAttribute('aria-atomic', 'true');
  const close = element('button', 'dev-diff__close', 'Закрыть');
  close.type = 'button';
  close.dataset.close = '';
  card.append(heading, body, announcement, close);
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
      const publishableRows = model.mechanics.filter((row) => row.adopted);
      for (const row of model.mechanics) {
        const article = rowArticle('mechanic', row.tone);
        article.dataset.playableId = row.playableId;
        const selectableHead = element('div', 'dev-diff__selectable-head');
        const checkbox = element('input', 'dev-diff__checkbox');
        checkbox.type = 'checkbox';
        checkbox.checked = row.adopted && mechanicSelected.has(row.playableId);
        checkbox.disabled = !row.adopted || mechanicQueued.has(row.playableId)
          || !onPrepareMechanics || !onPublishMechanic || mechanicPublicationPending;
        checkbox.dataset.action = 'select-mechanic';
        checkbox.setAttribute('aria-label', `Выбрать ${row.title}`);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) mechanicSelected.add(row.playableId);
          else mechanicSelected.delete(row.playableId);
          mechanicPublication = null;
          mechanicPublicationConfirmOpen = false;
          mechanicPublicationCode = '';
          mechanicPublicationError = '';
          if (open) renderBody();
        });
        selectableHead.append(checkbox, rowHead(
          row.title,
          publicationStateForRow(row) ?? row.status,
        ));
        article.append(selectableHead);
        const instructions = row.instructions.length > 0
          ? row.instructions : row.adopted
            ? ['Приватная версия механики отличается от релизной.'] : [];
        for (const instruction of instructions) {
          article.append(element('p', 'dev-diff__description', instruction));
        }
        for (const pending of row.pendingRequests) {
          article.append(element(
            'p',
            'dev-diff__pending',
            `${pending.instruction} — ${pending.status}. ${pending.detail}`,
          ));
        }
        if (model.mechanicPublicationPreparing) article.append(element(
          'p',
          'dev-diff__pending',
          'Проверяю возможность публикации…',
        ));
        if (onShowMechanic) {
          const jump = element('button', 'dev-diff__action', 'Показать механику');
          jump.type = 'button';
          jump.dataset.action = 'show-mechanic';
          article.append(jump);
        }
        mechanics.append(article);
      }
      body.append(mechanics);

      if (publishableRows.length > 0 && onPrepareMechanics && onPublishMechanic) {
        const actions = element('div', 'dev-diff__publish-actions');
        const selectableIds = publishableRows
          .filter((row) => !mechanicQueued.has(row.playableId))
          .map((row) => row.playableId);
        const selectedCount = selectableIds
          .filter((playableId) => mechanicSelected.has(playableId)).length;
        const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;
        const selectAll = element('label', 'dev-diff__select-all');
        const selectAllCheckbox = element('input', 'dev-diff__checkbox');
        selectAllCheckbox.type = 'checkbox';
        selectAllCheckbox.checked = allSelected;
        selectAllCheckbox.indeterminate = selectedCount > 0 && !allSelected;
        selectAllCheckbox.disabled = selectableIds.length === 0 || mechanicPublicationPending;
        selectAll.dataset.disabled = selectAllCheckbox.disabled ? 'true' : 'false';
        selectAllCheckbox.dataset.action = 'select-all-mechanics';
        selectAllCheckbox.setAttribute(
          'aria-label',
          allSelected ? 'Убрать все механики' : 'Выбрать все механики',
        );
        selectAllCheckbox.addEventListener('change', () => {
          for (const playableId of selectableIds) {
            if (selectAllCheckbox.checked) mechanicSelected.add(playableId);
            else mechanicSelected.delete(playableId);
          }
          mechanicPublication = null;
          mechanicPublicationConfirmOpen = false;
          mechanicPublicationCode = '';
          mechanicPublicationError = '';
          if (open) renderBody();
        });
        selectAll.append(
          selectAllCheckbox,
          element('span', null, allSelected ? 'Убрать все' : 'Выбрать все'),
        );
        const selected = element(
          'button',
          'dev-diff__action dev-diff__action--primary',
          'Выложить выбранное',
        );
        selected.type = 'button';
        selected.dataset.action = 'publish-mechanic';
        selected.disabled = selectedCount === 0 || mechanicPublicationPending;
        actions.append(selectAll, selected);
        body.append(actions);

        const confirm = element('div', 'dev-diff__promotion-confirm');
        confirm.dataset.testid = 'mechanic-publication-confirm';
        confirm.hidden = !mechanicPublicationConfirmOpen;
        confirm.append(element('p', 'dev-diff__detail', 'Только мне → Доступно всем'));
        if (mechanicPublication) {
          confirm.append(renderCopyCode('mechanic', mechanicPublication.confirmationCode));
        }
        const input = element('input', 'dev-diff__promotion-input');
        input.dataset.testid = 'mechanic-publication-code-input';
        input.inputMode = 'text';
        input.autocomplete = 'off';
        input.maxLength = 6;
        input.setAttribute('aria-label', 'Код подтверждения');
        input.value = mechanicPublicationCode;
        input.disabled = mechanicPublicationPending || mechanicPublicationCommitted;
        input.addEventListener('input', () => { mechanicPublicationCode = input.value; });
        const applyLabel = mechanicPublicationCommitted ? 'Заявка принята'
          : mechanicPublicationPending ? 'Проверяю…' : 'Подтвердить публикацию';
        const apply = element('button', 'dev-diff__action', applyLabel);
        apply.type = 'button';
        apply.dataset.action = 'confirm-mechanic-publication';
        apply.disabled = selectedCount === 0 || !mechanicPublication
          || mechanicPublicationPending
          || mechanicPublicationCommitted;
        confirm.append(input, apply);
        if (mechanicPublicationError) {
          const error = element('p', 'dev-diff__blocker', mechanicPublicationError);
          error.setAttribute('role', 'status');
          confirm.append(error);
        }
        body.append(confirm);
      }
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
          renderCopyCode('catalog', model.catalog.promotion.confirmationCode),
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

    if (publications.size > 0) {
      const statuses = groupSection('Публикация');
      statuses.dataset.testid = 'mechanic-publication-statuses';
      for (const publication of publications.values()) {
        const published = publication.items.filter((item) => item.status === 'published').length;
        if (publication.items.length > 1) {
          statuses.append(element('p', 'dev-diff__detail',
            `Опубликовано ${published} из ${publication.items.length}`));
        }
        for (const [index, item] of publication.items.entries()) {
          const preparedItem = publication.prepared.items[index];
          const article = rowArticle('publication-status', item.status === 'published' ? 'ok' : 'neutral');
          article.dataset.releaseId = item.releaseId;
          article.dataset.publicationStatus = item.status;
          article.append(rowHead(mechanicName(preparedItem.playableId), PUBLICATION_LABELS[item.status]));
          for (const change of preparedItem.changes) {
            article.append(element('p', 'dev-diff__description', change));
          }
          if (item.reason === 'expired_before_start') article.append(element('p', 'dev-diff__detail',
            'Заявка истекла до начала работы. Для новой публикации запросите новый код.'));
          if (item.reason === 'outcome_unconfirmed') article.append(element('p', 'dev-diff__detail',
            'Работа начиналась, но результат не подтверждён. Проверьте релизную ленту перед новой публикацией.'));
          if (item.reason === 'not_found') article.append(element('p', 'dev-diff__detail',
            'Сервер не нашёл принятую заявку. Публикация не подтверждена.'));
          if (item.reason === 'unavailable') article.append(element('p', 'dev-diff__detail',
            'Не удалось определить результат публикации.'));
          if (publication.error) article.append(element('p', 'dev-diff__blocker',
            'Не удалось проверить статус. Показано последнее подтверждённое состояние.'));
          statuses.append(article);
        }
      }
      if (onReadPublicationStatus) {
        const refresh = element('button', 'dev-diff__action',
          publicationCheckPending ? 'Проверяю статус…' : 'Проверить статус');
        refresh.type = 'button';
        refresh.dataset.action = 'refresh-publication-status';
        refresh.setAttribute('aria-busy', String(publicationCheckPending));
        refresh.setAttribute('aria-disabled', String(publicationCheckPending));
        statuses.append(refresh);
        if (publicationChecksLeft === 0) statuses.append(element('p', 'dev-diff__detail',
          'Автопроверка остановлена. Статус можно проверить кнопкой выше.'));
      }
      body.append(statuses);
    }
  };

  const publicationStateForRow = (row) => {
    for (const publication of [...publications.values()].reverse()) {
      const index = publication.prepared.items.findIndex((item) => (
        item.playableId === row.playableId && item.releaseId === row.releaseId
      ));
      if (index >= 0) return PUBLICATION_LABELS[publication.items[index].status];
    }
    return null;
  };

  const rerender = () => {
    if (!open || destroyed) return;
    const scrollTop = card.scrollTop;
    const focused = body.contains(document.activeElement) ? document.activeElement : null;
    const identity = focusIdentity(focused);
    const selection = focused instanceof HTMLInputElement
      ? [focused.selectionStart, focused.selectionEnd] : null;
    renderBody();
    card.scrollTop = scrollTop;
    if (focused) {
      const replacement = [...body.querySelectorAll('button, input')]
        .find((node) => identity !== null && focusIdentity(node) === identity && !node.disabled);
      (replacement ?? card).focus({ preventScroll: true });
      if (replacement instanceof HTMLInputElement && selection?.[0] != null) {
        replacement.setSelectionRange(...selection);
      }
    }
  };

  const focusIdentity = (node) => {
    if (!(node instanceof HTMLElement)) return null;
    if (node.dataset.testid) return `test:${node.dataset.testid}`;
    if (!node.dataset.action) return null;
    return JSON.stringify([
      node.dataset.action,
      node.closest('[data-playable-id]')?.dataset.playableId ?? null,
      node.closest('.dev-diff__promotion-confirm')?.dataset.testid ?? null,
    ]);
  };

  const publicationSignature = () => JSON.stringify([
    [...publications.values()].map(({ items, error }) => [items, error]),
    publicationChecksLeft === 0,
  ]);
  const announcePublications = () => {
    const summary = [...publications.values()].flatMap((publication) => (
      publication.items.map((item, index) => (
        `${mechanicName(publication.prepared.items[index].playableId)}: ${PUBLICATION_LABELS[item.status]}`
        + (publication.error ? ' — не удалось обновить статус' : '')
      ))
    )).join('. ');
    if (announcement.textContent !== summary) announcement.textContent = summary;
  };
  const refreshPendingControl = () => {
    const button = body.querySelector('[data-action="refresh-publication-status"]');
    if (!button) return;
    const label = publicationCheckPending ? 'Проверяю статус…' : 'Проверить статус';
    if (button.textContent !== label) button.textContent = label;
    button.setAttribute('aria-busy', String(publicationCheckPending));
    button.setAttribute('aria-disabled', String(publicationCheckPending));
  };

  const updateQueuedMechanics = () => {
    mechanicQueued = new Set();
    for (const publication of publications.values()) {
      publication.items.forEach((item, index) => {
        if (item.status === 'not_completed' || item.reason === 'not_found') return;
        const preparedItem = publication.prepared.items[index];
        const current = model.mechanics.find((row) => row.playableId === preparedItem.playableId);
        if (current?.releaseId === preparedItem.releaseId) {
          mechanicQueued.add(preparedItem.playableId);
        }
      });
    }
  };

  const stopPublicationTimer = () => {
    if (publicationTimer !== null) clearTimeout(publicationTimer);
    publicationTimer = null;
  };
  const schedulePublicationCheck = () => {
    stopPublicationTimer();
    if (destroyed || !open || document.visibilityState === 'hidden'
      || !onReadPublicationStatus || publicationChecksLeft === 0) return;
    if (![...publications.values()].some((publication) => publication.error
      || publication.items.some((item) => ['queued', 'running'].includes(item.status)))) return;
    publicationTimer = setTimeout(() => { void checkPublications(); }, PUBLICATION_POLL_MS);
  };
  const checkPublications = async () => {
    stopPublicationTimer();
    if (destroyed || !open || document.visibilityState === 'hidden'
      || !onReadPublicationStatus || publicationCheckPending) return;
    const previous = publicationSignature();
    publicationCheckPending = true;
    refreshPendingControl();
    publicationChecksLeft = Math.max(0, publicationChecksLeft - 1);
    const pending = [...publications.values()]
      .filter((publication) => !publication.items.every((item) => item.status === 'published'));
    await Promise.all(pending.map(async (publication) => {
      try {
        const raw = await onReadPublicationStatus(publication.prepared);
        const status = validatePlayablePublicationStatus(raw, publication.prepared);
        if (!status) throw new Error('invalid_publication_status');
        if (destroyed) return;
        publication.items = status.items;
        publication.error = false;
      } catch {
        if (!destroyed) publication.error = true;
      }
    }));
    publicationCheckPending = false;
    if (destroyed) return;
    updateQueuedMechanics();
    if (previous !== publicationSignature()) rerender();
    refreshPendingControl();
    announcePublications();
    schedulePublicationCheck();
  };
  const trackPublication = (prepared, status) => {
    publications.set(prepared.operationId, {
      prepared,
      items: prepared.items.map(({ releaseId, bindingDigest, candidateArtifactDigest }) => ({
        releaseId, bindingDigest, candidateArtifactDigest, status, reason: null,
      })),
      error: false,
    });
    publicationChecksLeft = PUBLICATION_POLL_LIMIT;
    for (const item of prepared.items) mechanicSelected.delete(item.playableId);
    updateQueuedMechanics();
    announcePublications();
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
    if (publications.size > 0) void checkPublications();
  };

  const closeSheet = (restoreFocus = true) => {
    if (!open) return;
    open = false;
    stopPublicationTimer();
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
    if (target.closest('[data-action="refresh-publication-status"]')) {
      if (publicationCheckPending) return;
      publicationChecksLeft = PUBLICATION_POLL_LIMIT;
      void checkPublications();
      return;
    }
    const jump = target.closest('[data-action="show-mechanic"]');
    const publishMechanic = target.closest('[data-action="publish-mechanic"]');
    if (publishMechanic) {
      if (mechanicSelected.size === 0 || !onPrepareMechanics) return;
      const selectedIds = model.mechanics
        .filter((row) => row.adopted && !mechanicQueued.has(row.playableId)
          && mechanicSelected.has(row.playableId))
        .map((row) => row.playableId);
      if (selectedIds.length === 0) return;
      mechanicPublicationPending = true;
      mechanicPublicationConfirmOpen = false;
      mechanicPublicationError = '';
      renderBody();
      void Promise.resolve(onPrepareMechanics(selectedIds))
        .then((next) => {
          if (destroyed) return;
          mechanicPublicationPending = false;
          mechanicPublication = next;
          mechanicPublicationConfirmOpen = true;
          renderBody();
          const input = body.querySelector('[data-testid="mechanic-publication-code-input"]');
          if (input instanceof HTMLInputElement) input.focus();
        })
        .catch(() => {
          if (destroyed) return;
          mechanicPublicationPending = false;
          mechanicPublication = null;
          mechanicPublicationConfirmOpen = true;
          mechanicPublicationError = 'Не удалось подготовить точный набор. Обновите ленту.';
          renderBody();
        });
      return;
    }
    const applyMechanic = target.closest('[data-action="confirm-mechanic-publication"]');
    if (applyMechanic && mechanicSelected.size > 0 && mechanicPublication
      && onPublishMechanic && !mechanicPublicationPending) {
      if (mechanicPublication.items.some((item) => mechanicQueued.has(item.playableId))) return;
      const code = mechanicPublicationCode.trim().toUpperCase();
      const submittedPublication = mechanicPublication;
      mechanicPublicationPending = true;
      mechanicPublicationError = '';
      renderBody();
      void Promise.resolve().then(() => onPublishMechanic(submittedPublication, code))
        .then((outcome) => {
          if (destroyed) return;
          mechanicPublicationPending = false;
          if (['queued_refreshed', 'queued_refresh_pending', 'published_refreshed', 'published_refresh_pending']
            .includes(outcome?.status)) {
            trackPublication(submittedPublication,
              outcome.status.startsWith('published_') ? 'published' : 'queued');
            for (const item of submittedPublication.items) {
              mechanicSelected.delete(item.playableId);
            }
            mechanicPublicationCommitted = false;
            mechanicPublication = null;
            mechanicPublicationConfirmOpen = false;
            mechanicPublicationCode = '';
            mechanicPublicationError = '';
            if (outcome.status.startsWith('queued_')) void checkPublications();
          } else if (outcome?.status === 'acceptance_unknown') {
            trackPublication(submittedPublication, 'unknown');
            mechanicPublication = null;
            mechanicPublicationCode = '';
            mechanicPublicationConfirmOpen = true;
            mechanicPublicationError = 'Приём заявки не подтверждён. Проверяем статус.';
            void checkPublications();
          } else {
            mechanicPublicationConfirmOpen = true;
            mechanicPublicationError = outcome?.reason === 'candidate_changed'
              ? 'Кандидат изменился. Обновите ленту и выберите механику заново.'
              : outcome?.reason === 'request_rejected'
                ? 'Заявка отклонена. Проверьте код и актуальность выбранной версии.'
                : 'Не удалось отправить заявку. Публикация не началась.';
            if (outcome?.reason === 'candidate_changed') {
              mechanicPublication = null;
              mechanicPublicationCode = '';
            }
          }
          if (open) renderBody();
        })
        .catch(() => {
          if (destroyed) return;
          mechanicPublicationPending = false;
          mechanicPublication = null;
          mechanicPublicationCode = '';
          mechanicPublicationConfirmOpen = true;
          // Unknown callback errors provide no evidence that apply was sent.
          // The production adapter returns acceptance_unknown for sent errors.
          mechanicPublicationError = 'Не удалось обработать заявку. Обновите ленту.';
          if (open) renderBody();
        });
      return;
    }
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
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') stopPublicationTimer();
    else if (open && publications.size > 0 && publicationChecksLeft > 0) void checkPublications();
  };

  badge.addEventListener('click', onBadgeClick);
  sheet.addEventListener('click', onSheetClick);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('visibilitychange', onVisibilityChange);

  renderBadge();

  return Object.freeze({
    get open() { return open; },
    update(next) {
      if (destroyed) return;
      const previousModel = JSON.stringify(model);
      const previousPromotionId = model.catalog.promotion?.operationId ?? null;
      const previousMechanics = model.mechanics.map((row) => (
        `${row.playableId}:${row.publication?.items.find((item) => item.playableId === row.playableId)?.releaseId ?? ''}`
      )).join('|');
      model = developerFeedDiffModel(next || {});
      // A returned adoption may be the exact release already queued. Rebuild
      // the fence from the new projection BEFORE retaining any selection.
      updateQueuedMechanics();
      const selectableIds = new Set(model.mechanics
        .filter((row) => row.adopted && !mechanicQueued.has(row.playableId))
        .map((row) => row.playableId));
      mechanicSelected = new Set([...mechanicSelected].filter((id) => selectableIds.has(id)));
      const nextPromotionId = model.catalog.promotion?.operationId ?? null;
      if (nextPromotionId === null || nextPromotionId !== previousPromotionId) {
        catalogSelected = true;
        promotionPending = false;
        promotionCommitted = false;
        promotionConfirmOpen = false;
        promotionCode = '';
        promotionError = '';
      }
      const nextMechanics = model.mechanics.map((row) => (
        `${row.playableId}:${row.publication?.items.find((item) => item.playableId === row.playableId)?.releaseId ?? ''}`
      )).join('|');
      if (nextMechanics !== previousMechanics) {
        mechanicPublication = model.mechanics.find((row) => row.adopted)?.publication ?? null;
        mechanicPublicationPending = false;
        mechanicPublicationCommitted = false;
        mechanicPublicationConfirmOpen = false;
        mechanicPublicationCode = '';
        mechanicPublicationError = '';
      }
      if (open && !model.visible) closeSheet(false);
      renderBadge();
      if (!open) return;
      // A background projection refresh must not throw the operator back to the
      // top of a list they are reading.
      if (previousModel !== JSON.stringify(model)) rerender();
    },
    close() { closeSheet(false); },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      open = false;
      stopPublicationTimer();
      badge.removeEventListener('click', onBadgeClick);
      sheet.removeEventListener('click', onSheetClick);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      root.remove();
    },
  });
}
