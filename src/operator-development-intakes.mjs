import { observeOperatorFormViewport } from './operator-form-viewport.mjs';
import {
  prepareScreenshotFromFile,
  screenshotSelectionLabel,
  screenshotSelectionMarkup,
} from './operator-screenshot.mjs';
import {
  platformDevelopmentIntakePresentation,
  resolveOperatorPresentationVocabulary,
} from './operator-presentation-vocabulary.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISSUE_URL = /^https:\/\/github\.com\/Glera\/p4g-workspace-meta\/issues\/[1-9][0-9]*$/;
const PENDING_SCHEMA = 'platform.development-intake.pending.v1';
const PENDING_STORAGE_MAX_CHARS = 600_000;
const DELIVERY_STATUSES = new Set([
  'queued', 'send_started', 'outcome_unknown', 'retry_wait', 'confirmed', 'failed_terminal',
]);
const CANCELLATION_STATUSES = new Set([
  'requested', 'started', 'outcome_unknown', 'confirmed', 'failed_terminal',
]);
const TERMINAL_STATUSES = new Set(['READY_TO_PLAY', 'NEEDS_HELP']);
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429]);
const SCREENSHOT_INVALID = 'development_intake_screenshot_invalid';
export const PLATFORM_DEVELOPMENT_INTAKE_CONTRACT = 'platform.development-intake.request.v1';
let controlSequence = 0;

const fail = (code, message) => {
  const error = new Error(message);
  error.code = code;
  throw error;
};
const exactKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const printable = (value, max = 2_000) => typeof value === 'string' && value === value.trim()
  && value.length >= 1 && value.length <= max && new TextEncoder().encode(value).length <= max * 4
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const normalizeInstruction = (value) => typeof value === 'string'
  ? value.replace(/\s+/gu, ' ').trim()
  : value;
const exactTimestamp = (value) => typeof value === 'string' && TIMESTAMP.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const exactActorUserId = (value) => Number.isSafeInteger(value) && value > 0;

function exactScreenshot(screenshot) {
  if (!exactKeys(screenshot, ['kind', 'reason', 'mimeType', 'dataUrl'])
    || !['unavailable', 'data_url'].includes(screenshot.kind)) {
    fail('development_intake_invalid', 'screenshot is invalid');
  }
  if (screenshot.kind === 'unavailable') {
    if (!printable(screenshot.reason, 96) || screenshot.mimeType !== null || screenshot.dataUrl !== null) {
      fail('development_intake_invalid', 'screenshot is invalid');
    }
  } else {
    const prefix = `data:${screenshot.mimeType};base64,`;
    if (!['image/jpeg', 'image/png'].includes(screenshot.mimeType) || screenshot.reason !== null
      || typeof screenshot.dataUrl !== 'string' || screenshot.dataUrl.length > 524_288
      || !screenshot.dataUrl.startsWith(prefix)) {
      fail('development_intake_invalid', 'screenshot is invalid');
    }
  }
  return Object.freeze({ ...screenshot });
}

export function platformDevelopmentIntakeAvailable(value) {
  return value === true;
}

export function platformDevelopmentIntakeSessionGrant(value, context, buildSha) {
  return platformDevelopmentIntakeAvailable(value)
    && SHA.test(String(buildSha))
    && ((exactKeys(context, ['contract'])
      && context.contract === PLATFORM_DEVELOPMENT_INTAKE_CONTRACT)
      || (exactKeys(context, ['buildSha']) && context.buildSha === buildSha));
}

export function buildPlatformDevelopmentIntakeRequest({
  mutationId,
  instruction,
  surface,
  route,
  buildSha,
  screenshot,
  capturedAt = new Date().toISOString(),
}) {
  if (!UUID.test(String(mutationId)) || !printable(instruction)
    || !printable(surface, 128) || !printable(route, 512)
    || !route.startsWith('/') || route.startsWith('//') || !SHA.test(String(buildSha))
    || !exactTimestamp(capturedAt)) {
    fail('development_intake_invalid', 'platform intake identity is invalid');
  }
  return Object.freeze({
    schema: PLATFORM_DEVELOPMENT_INTAKE_CONTRACT,
    mutationId,
    instruction,
    surface,
    route,
    buildSha,
    capturedAt,
    screenshot: exactScreenshot(screenshot),
  });
}

function exactRequest(value) {
  if (!exactKeys(value, [
    'schema', 'mutationId', 'instruction', 'surface', 'route', 'buildSha', 'capturedAt', 'screenshot',
  ]) || value.schema !== 'platform.development-intake.request.v1') {
    fail('development_intake_receipt_invalid', 'receipt request shape is invalid');
  }
  const request = buildPlatformDevelopmentIntakeRequest(value);
  if (!sameRequest(request, value)) {
    fail('development_intake_receipt_invalid', 'receipt request differs from its normalized value');
  }
  return request;
}

function exactTerminal(value) {
  if (value === undefined || value === null) return null;
  if (!exactKeys(value, [
    'status', 'summary', 'candidate', 'blocker', 'review', 'recordedAt', 'nothingPublished',
  ]) || !TERMINAL_STATUSES.has(value.status) || !printable(value.summary, 240)
    || !exactTimestamp(value.recordedAt) || typeof value.nothingPublished !== 'boolean') {
    fail('development_intake_receipt_invalid', 'terminal receipt shape is invalid');
  }
  if (value.status === 'READY_TO_PLAY') {
    const attendedReview = exactKeys(value.review, ['provider', 'verdict', 'patchDigest', 'reviewedAt'])
      && value.review.provider === 'claude' && value.review.verdict === 'APPROVE'
      && /^sha256:[0-9a-f]{64}$/.test(value.review.patchDigest)
      && exactTimestamp(value.review.reviewedAt);
    const liveReview = exactKeys(value.review, [
      'provider', 'verdict', 'platformCommitSha', 'deployedAt', 'stageTimings',
    ]) && value.review.provider === 'platform-delivery' && value.review.verdict === 'LIVE'
      && SHA.test(value.review.platformCommitSha) && exactTimestamp(value.review.deployedAt)
      && exactKeys(value.review.stageTimings, [
        'queueSeconds', 'authoringSeconds', 'ciMergeSeconds', 'rolloutSeconds', 'totalSeconds',
      ])
      && ['queueSeconds', 'authoringSeconds', 'ciMergeSeconds', 'rolloutSeconds', 'totalSeconds']
        .every((key) => Number.isSafeInteger(value.review.stageTimings[key])
          && value.review.stageTimings[key] >= 0 && value.review.stageTimings[key] <= 86_400)
      && value.review.stageTimings.totalSeconds === value.review.stageTimings.queueSeconds
        + value.review.stageTimings.authoringSeconds + value.review.stageTimings.ciMergeSeconds
        + value.review.stageTimings.rolloutSeconds;
    if (!exactKeys(value.candidate, ['repository', 'commitSha', 'artifactDigest', 'url'])
      || !/^Glera\/(p4g-workspace-meta|swipe-backend|feed-prototype|swipe-generator|swipe-ugc|playables)$/.test(value.candidate.repository)
      || !SHA.test(value.candidate.commitSha)
      || !/^sha256:[0-9a-f]{64}$/.test(value.candidate.artifactDigest)
      || !/^https:\/\/\S+$/.test(value.candidate.url)
      || value.blocker !== null
      || (!attendedReview && !liveReview)
      || value.nothingPublished !== !liveReview) {
      fail('development_intake_receipt_invalid', 'READY_TO_PLAY receipt is invalid');
    }
  } else if (value.candidate !== null
    || !exactKeys(value.blocker, ['reasonCode', 'operatorAction'])
    || !/^[a-z0-9_]{3,64}$/.test(value.blocker.reasonCode)
    || !printable(value.blocker.operatorAction, 240)
    || value.nothingPublished !== true
    || (value.review !== null && !exactKeys(
      value.review, ['provider', 'verdict', 'patchDigest', 'reviewedAt'],
    ))) {
    fail('development_intake_receipt_invalid', 'NEEDS_HELP receipt is invalid');
  }
  return Object.freeze({
    ...value,
    candidate: value.candidate ? Object.freeze({ ...value.candidate }) : null,
    blocker: value.blocker ? Object.freeze({ ...value.blocker }) : null,
    review: value.review ? Object.freeze({ ...value.review }) : null,
  });
}

export function validatePlatformDevelopmentIntakeReceipt(value, expectedRequest = null) {
  const legacyKeys = [
    'schema', 'requestId', 'mutationId', 'requestHash', 'delivery', 'request', 'replayed', 'createdAt',
  ];
  const allowedKeys = [
    legacyKeys,
    [...legacyKeys, 'terminal'],
    [...legacyKeys, 'cancellation'],
    [...legacyKeys, 'terminal', 'cancellation'],
  ];
  if (!allowedKeys.some((keys) => exactKeys(value, keys))
    || value.schema !== 'platform.development-intake.response.v1'
    || !UUID.test(String(value.requestId)) || !UUID.test(String(value.mutationId))
    || !HASH.test(String(value.requestHash)) || typeof value.replayed !== 'boolean'
    || !exactTimestamp(value.createdAt)
    || !exactKeys(value.delivery, ['deliveryId', 'status', 'issueUrl', 'nothingPublished'])
    || !UUID.test(String(value.delivery?.deliveryId))
    || !DELIVERY_STATUSES.has(value.delivery?.status)
    || typeof value.delivery?.nothingPublished !== 'boolean') {
    fail('development_intake_receipt_invalid', 'development intake receipt shape is invalid');
  }
  const confirmed = value.delivery.status === 'confirmed';
  if ((confirmed && !ISSUE_URL.test(String(value.delivery.issueUrl)))
    || (!confirmed && value.delivery.issueUrl !== null)) {
    fail('development_intake_receipt_invalid', 'development intake issue URL semantics are invalid');
  }
  const request = exactRequest(value.request);
  if (value.mutationId !== request.mutationId
    || (expectedRequest && !sameRequest(request, expectedRequest))) {
    fail('development_intake_receipt_invalid', 'development intake receipt identity is invalid');
  }
  let cancellation = null;
  if (value.cancellation !== undefined) {
    const item = value.cancellation;
    if (!exactKeys(item, [
      'mutationId', 'status', 'reason', 'requestedAt', 'cancelledAt',
      'issueClosed', 'lastErrorCode',
    ]) || !UUID.test(String(item.mutationId))
      || !CANCELLATION_STATUSES.has(item.status) || item.reason !== 'obsolete'
      || !exactTimestamp(item.requestedAt)
      || !(item.cancelledAt === null || exactTimestamp(item.cancelledAt))
      || typeof item.issueClosed !== 'boolean'
      || !(item.lastErrorCode === null || /^[a-z0-9_]{3,64}$/.test(item.lastErrorCode))
      || (item.status === 'confirmed') !== (item.cancelledAt !== null)
      || (item.issueClosed && value.delivery.issueUrl === null)) {
      fail('development_intake_receipt_invalid', 'development intake cancellation is invalid');
    }
    cancellation = Object.freeze({ ...item });
  }
  const terminal = exactTerminal(value.terminal);
  if (value.delivery.nothingPublished !== (terminal?.nothingPublished ?? true)) {
    fail('development_intake_receipt_invalid', 'delivery publication state differs from terminal');
  }
  const receipt = {
    schema: value.schema,
    requestId: value.requestId,
    mutationId: value.mutationId,
    requestHash: value.requestHash,
    delivery: Object.freeze({ ...value.delivery }),
    terminal,
    request,
    replayed: value.replayed,
    createdAt: value.createdAt,
  };
  if (cancellation) receipt.cancellation = cancellation;
  return Object.freeze(receipt);
}

export function buildPlatformDevelopmentIntakeCancelRequest({ mutationId, requestHash }) {
  if (!UUID.test(String(mutationId)) || !HASH.test(String(requestHash))) {
    fail('development_intake_invalid', 'development intake cancellation identity is invalid');
  }
  return Object.freeze({
    schema: 'platform.development-intake.cancel.v1',
    mutationId,
    requestHash,
    reason: 'obsolete',
  });
}

export function validatePlatformDevelopmentIntakeList(value) {
  if (!exactKeys(value, ['schema', 'items'])
    || value.schema !== 'platform.development-intake.list.v1' || !Array.isArray(value.items)) {
    fail('development_intake_receipt_invalid', 'development intake list shape is invalid');
  }
  const items = [];
  for (const item of value.items) {
    try {
      items.push(validatePlatformDevelopmentIntakeReceipt(item));
    } catch { /* one malformed historical row cannot hide healthy current work */ }
  }
  return Object.freeze({
    schema: value.schema,
    items: Object.freeze(items),
  });
}

export function platformDevelopmentIntakeFailureDisposition(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status < 500
    && !TRANSIENT_HTTP_STATUSES.has(status)
    ? 'rejected'
    : 'retry';
}

export function platformDevelopmentIntakeErrorMessage(error) {
  if (error?.code === SCREENSHOT_INVALID) {
    return 'Не удалось обработать скриншот. Выберите другое изображение.';
  }
  if (error?.code === 'development_intake_invalid') {
    return 'Описание должно содержать от 1 до 2000 символов.';
  }
  if (error?.code === 'development_intake_pending_not_persisted') {
    return 'Память Mini App недоступна. Скопируйте текст и перезапустите Mini App.';
  }
  return 'Не удалось сохранить задачу.';
}

function resolvedPlatformIntake(receipt) {
  return receipt.cancellation?.status === 'confirmed'
    || receipt.terminal?.status === 'READY_TO_PLAY';
}

function platformIntakeNeedsHelp(receipt) {
  return receipt.terminal?.status === 'NEEDS_HELP'
    || receipt.delivery.status === 'failed_terminal'
    || receipt.cancellation?.status === 'failed_terminal';
}

function platformIntakeQueuePresentation(receipts) {
  const newestFirst = [...receipts].sort((left, right) => (
    Date.parse(right.createdAt) - Date.parse(left.createdAt)
  ));
  const active = newestFirst.filter((receipt) => !resolvedPlatformIntake(receipt))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  let workPosition = 0;
  return active.map((receipt) => {
    if (platformIntakeNeedsHelp(receipt)) {
      return { receipt, label: 'Нужна помощь', state: 'needs_help' };
    }
    const position = workPosition;
    workPosition += 1;
    return {
      receipt,
      label: position === 0 ? 'В работе' : `В очереди · №${position}`,
      state: position === 0 ? 'active' : 'queued',
    };
  });
}

function draftKey(options) {
  return `platform-development-intake-draft:v1:${options.actorUserId}:${options.buildSha}:${options.route}`;
}

export function platformDevelopmentIntakePendingStorageKey(options) {
  if (!exactActorUserId(options?.actorUserId)
    || !SHA.test(String(options?.buildSha))) {
    fail('development_intake_invalid', 'pending request storage identity is invalid');
  }
  return `platform-development-intake-pending:v1:${options.actorUserId}:${options.buildSha}`;
}

function removeStored(storage, key) {
  try { storage?.removeItem(key); } catch { /* invalid persisted state stays unusable */ }
}

function sameRequest(left, right) {
  if (!left || !right) return false;
  return left.schema === right.schema
    && left.mutationId === right.mutationId
    && left.instruction === right.instruction
    && left.surface === right.surface
    && left.route === right.route
    && left.buildSha === right.buildSha
    && left.capturedAt === right.capturedAt
    && left.screenshot?.kind === right.screenshot?.kind
    && left.screenshot?.reason === right.screenshot?.reason
    && left.screenshot?.mimeType === right.screenshot?.mimeType
    && left.screenshot?.dataUrl === right.screenshot?.dataUrl;
}

export function restorePlatformDevelopmentIntakePendingRequest(storage, options) {
  const key = platformDevelopmentIntakePendingStorageKey(options);
  try {
    const raw = storage?.getItem(key);
    if (typeof raw !== 'string') return null;
    if (raw.length < 1 || raw.length > PENDING_STORAGE_MAX_CHARS) {
      removeStored(storage, key);
      return null;
    }
    const value = JSON.parse(raw);
    if (!exactKeys(value, ['schema', 'actorUserId', 'request']) || value.schema !== PENDING_SCHEMA
      || value.actorUserId !== options.actorUserId
      || !exactKeys(value.request, [
        'schema', 'mutationId', 'instruction', 'surface', 'route', 'buildSha', 'capturedAt', 'screenshot',
      ])
      || value.request.schema !== 'platform.development-intake.request.v1') {
      removeStored(storage, key);
      return null;
    }
    const request = buildPlatformDevelopmentIntakeRequest(value.request);
    if (request.buildSha !== options.buildSha || request.surface !== options.surface
      || !sameRequest(request, value.request)) {
      removeStored(storage, key);
      return null;
    }
    return request;
  } catch {
    removeStored(storage, key);
    return null;
  }
}

export function persistPlatformDevelopmentIntakePendingRequest(storage, options, request) {
  const key = platformDevelopmentIntakePendingStorageKey(options);
  let normalized;
  try {
    normalized = buildPlatformDevelopmentIntakeRequest(request);
  } catch {
    return false;
  }
  if (normalized.buildSha !== options.buildSha || normalized.route !== options.route
    || normalized.surface !== options.surface || !sameRequest(normalized, request)) return false;
  const serialized = JSON.stringify({
    schema: PENDING_SCHEMA,
    actorUserId: options.actorUserId,
    request: normalized,
  });
  if (serialized.length > PENDING_STORAGE_MAX_CHARS) return false;
  try {
    storage?.setItem(key, serialized);
    return storage?.getItem(key) === serialized;
  } catch {
    return false;
  }
}

export function persistPlatformDevelopmentIntakePendingRequestWithFallback(
  primaryStorage,
  fallbackStorage,
  options,
  request,
) {
  if (persistPlatformDevelopmentIntakePendingRequest(primaryStorage, options, request)) {
    return 'primary';
  }
  if (fallbackStorage && fallbackStorage !== primaryStorage
    && persistPlatformDevelopmentIntakePendingRequest(fallbackStorage, options, request)) {
    return 'fallback';
  }
  return null;
}

function safeDraft(storage, key) {
  try {
    const value = storage?.getItem(key);
    return typeof value === 'string' && value.length <= 2_000 ? value : null;
  } catch {
    return null;
  }
}

function storeDraft(storage, key, value) {
  try {
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
    return storage ? (value ? storage.getItem(key) === value : storage.getItem(key) === null) : false;
  } catch {
    return false;
  }
}

function storeDraftWithFallback(primaryStorage, fallbackStorage, key, value) {
  const storedPrimary = storeDraft(primaryStorage, key, value);
  if (!value) storeDraft(fallbackStorage, key, value);
  else if (storedPrimary) removeStored(fallbackStorage, key);
  else if (!storedPrimary) storeDraft(fallbackStorage, key, value);
}

export function mountPlatformDevelopmentIntakeControl(host, options) {
  if (!(host instanceof HTMLElement) || typeof options?.submit !== 'function'
    || typeof options?.createMutationId !== 'function' || !SHA.test(String(options?.buildSha))
    || !exactActorUserId(options?.actorUserId)
    || !printable(options?.surface, 128) || !printable(options?.route, 512)) {
    fail('development_intake_invalid', 'control options are invalid');
  }
  const root = document.createElement('section');
  const controlId = `platform-development-intake-${controlSequence += 1}`;
  root.className = 'platform-development-intake';
  root.innerHTML = `
    <button class="platform-development-intake__open" type="button" aria-expanded="false" aria-controls="${controlId}-form" aria-label="Доработать платформу" title="Доработать платформу">⚙</button>
    <form class="game__operator-flag-form" id="${controlId}-form" hidden>
      <p class="platform-development-intake__empty" data-intake-empty>Сейчас нет задач по платформе.</p>
      <label>Что поправить в платформе
        <textarea name="instruction" rows="4" required placeholder="Например: сделать подпись версии заметнее" aria-describedby="${controlId}-dictation-hint"></textarea>
      </label>
      <div class="game__operator-playable-rework-dictation">
        <button type="button" data-action="dictate">🎙 Надиктовать</button>
        <small id="${controlId}-dictation-hint">Откроется клавиатура — нажмите на ней 🎤</small>
      </div>
      <label>Скриншот (необязательно)
        <input name="screenshot" type="file" accept="image/*">
      </label>
      ${screenshotSelectionMarkup('intake')}
      <div class="game__operator-flag-actions">
        <button type="submit">Отдать в работу</button>
        <button type="button" data-action="cancel">Отмена</button>
      </div>
      <output class="game__operator-flag-status" aria-live="polite"></output>
    </form>
    <section class="platform-development-intake__details" id="${controlId}-details" hidden>
      <b>Правки платформы</b>
      <ol class="platform-development-intake__queue" data-intake-queue></ol>
      <small class="platform-development-intake__summary" data-intake-summary hidden></small>
      <p class="platform-development-intake__blocker" data-intake-blocker hidden></p>
      <a class="platform-development-intake__result" data-intake-result target="_blank" rel="noreferrer" hidden>Открыть результат</a>
      <button type="button" data-action="obsolete" hidden>Неактуально</button>
      <button type="button" data-action="new">Новая задача</button>
      <details class="platform-development-intake__technical">
        <summary>Технические детали</summary>
        <p data-intake-instruction></p>
        <small data-intake-status></small>
        <dl class="platform-development-intake__receipt" aria-label="Durable receipt">
          <div><dt>requestId</dt><dd data-intake-request-id></dd></div>
          <div><dt>mutationId</dt><dd data-intake-mutation-id></dd></div>
          <div><dt>requestHash</dt><dd data-intake-request-hash></dd></div>
          <div><dt>replayed</dt><dd data-intake-replayed></dd></div>
          <div><dt>Issue delivery</dt><dd data-intake-delivery-state></dd></div>
        </dl>
      </details>
    </section>`;
  host.appendChild(root);
  const open = root.querySelector('.platform-development-intake__open');
  const form = root.querySelector('form');
  const instruction = form.elements.namedItem('instruction');
  const file = form.elements.namedItem('screenshot');
  const status = root.querySelector('output');
  const submit = form.querySelector('button[type="submit"]');
  const dictate = form.querySelector('[data-action="dictate"]');
  const cancel = form.querySelector('[data-action="cancel"]');
  const details = root.querySelector('.platform-development-intake__details');
  const emptyNotice = form.querySelector('[data-intake-empty]');
  const queue = details.querySelector('[data-intake-queue]');
  const detailSummary = details.querySelector('[data-intake-summary]');
  const detailInstruction = details.querySelector('[data-intake-instruction]');
  const detailStatus = details.querySelector('[data-intake-status]');
  const detailRequestId = details.querySelector('[data-intake-request-id]');
  const detailMutationId = details.querySelector('[data-intake-mutation-id]');
  const detailRequestHash = details.querySelector('[data-intake-request-hash]');
  const detailReplayed = details.querySelector('[data-intake-replayed]');
  const detailDeliveryState = details.querySelector('[data-intake-delivery-state]');
  const blocker = details.querySelector('[data-intake-blocker]');
  const resultLink = details.querySelector('[data-intake-result]');
  const obsolete = details.querySelector('[data-action="obsolete"]');
  const screenshotSelection = form.querySelector('[data-intake-screenshot]');
  const screenshotName = form.querySelector('[data-intake-screenshot-name]');
  const removeScreenshot = form.querySelector('[data-action="remove-screenshot"]');
  // The keyboard must never push the field being typed into off the screen.
  const formViewport = observeOperatorFormViewport(form);
  const key = draftKey(options);
  const pendingKey = platformDevelopmentIntakePendingStorageKey(options);
  const primaryStorage = options.storage;
  const fallbackStorage = options.fallbackStorage === primaryStorage
    ? undefined : options.fallbackStorage;
  const primaryPending = restorePlatformDevelopmentIntakePendingRequest(primaryStorage, options);
  const fallbackPending = primaryPending
    ? null : restorePlatformDevelopmentIntakePendingRequest(fallbackStorage, options);
  let pendingRequest = primaryPending ?? fallbackPending;
  instruction.value = pendingRequest?.instruction
    ?? safeDraft(primaryStorage, key)
    ?? safeDraft(fallbackStorage, key)
    ?? '';
  let accepted = null;
  const acceptedById = new Map();
  let destroyed = false;
  let submitting = false;
  let cancelling = false;
  const vocabulary = resolveOperatorPresentationVocabulary(options.vocabulary);

  // The attached file is only a local preview: it is prepared and inlined into
  // the immutable request at submit, and «Удалить» detaches it before then.
  const renderScreenshotSelection = () => {
    const selected = file.files?.[0] || null;
    screenshotName.textContent = screenshotSelectionLabel(selected);
    screenshotSelection.hidden = selected === null;
  };
  const releaseScreenshotField = () => {
    file.value = '';
    file.disabled = false;
    removeScreenshot.disabled = false;
    renderScreenshotSelection();
  };
  // Submit latches the whole composition until the attempt reaches a terminal
  // outcome: preparation is awaited for seconds, and a detach or a replacement
  // during it would inline one image while the form shows another.
  const setSubmitting = (value) => {
    submitting = value;
    root.setAttribute('aria-busy', String(value));
    [instruction, file, submit, dictate, removeScreenshot, cancel]
      .forEach((element) => { element.disabled = value; });
    // Releasing the latch never releases the attachment identity that an
    // unfinished request already froze into its durable pending record.
    if (!value && pendingRequest) {
      file.disabled = true;
      removeScreenshot.disabled = true;
    }
  };

  const renderPending = () => {
    if (!pendingRequest) return;
    emptyNotice.hidden = true;
    instruction.value = pendingRequest.instruction;
    instruction.readOnly = true;
    file.disabled = true;
    removeScreenshot.disabled = true;
    submit.textContent = 'Повторить сохранение';
    status.textContent = 'Есть незавершённая отправка — повторите сохранение.';
  };

  const clearPending = () => {
    removeStored(primaryStorage, pendingKey);
    removeStored(fallbackStorage, pendingKey);
    pendingRequest = null;
  };

  const renderEmptyState = () => {
    accepted = null;
    acceptedById.clear();
    if (!pendingRequest) {
      setSubmitting(false);
      submit.textContent = 'Отдать в работу';
      status.textContent = '';
      releaseScreenshotField();
      instruction.readOnly = false;
      instruction.value = safeDraft(primaryStorage, key) ?? safeDraft(fallbackStorage, key) ?? '';
    }
    queue.replaceChildren();
    open.textContent = '⚙';
    delete open.dataset.intakeState;
    open.setAttribute('aria-label', 'Доработать платформу');
    open.setAttribute('aria-controls', form.id);
    open.setAttribute('aria-expanded', 'false');
    detailSummary.hidden = true;
    detailSummary.textContent = '';
    blocker.hidden = true;
    blocker.textContent = '';
    resultLink.hidden = true;
    resultLink.removeAttribute('href');
    obsolete.hidden = true;
    emptyNotice.hidden = false;
    details.hidden = true;
    form.hidden = true;
    open.hidden = false;
    return true;
  };

  const renderAcceptedState = () => {
    const acceptedReceipts = [...acceptedById.values()];
    const presentationRows = platformIntakeQueuePresentation(acceptedReceipts);
    accepted = presentationRows.find(({ state: rowState }) => rowState !== 'needs_help')?.receipt
      ?? presentationRows[0]?.receipt ?? null;
    if (!accepted) return renderEmptyState();
    emptyNotice.hidden = true;
    queue.replaceChildren(...presentationRows.map(({ receipt, label, state: rowState }) => {
      const item = document.createElement('li');
      const text = document.createElement('span');
      const state = document.createElement('b');
      item.dataset.intakeStatus = rowState;
      text.textContent = receipt.request.instruction;
      state.textContent = label;
      item.append(text, state);
      if (rowState === 'needs_help') {
        const rowPresentation = platformDevelopmentIntakePresentation(receipt, vocabulary);
        const summary = document.createElement('small');
        summary.textContent = rowPresentation?.blocker || receipt.terminal?.summary
          || 'Задача остановилась.';
        item.append(summary);
      }
      return item;
    }));
    const deliveryStatus = accepted.delivery.status;
    const cancellation = accepted.cancellation;
    const cancelled = cancellation?.status === 'confirmed';
    const presentation = platformDevelopmentIntakePresentation(accepted, vocabulary);
    const terminalReady = presentation?.state === 'ready';
    const failed = presentation?.state === 'needsHelp';
    const confirmed = deliveryStatus === 'confirmed';
    open.textContent = cancelled ? '×' : presentation?.icon || '…';
    open.dataset.intakeState = cancelled ? 'cancelled' : failed
      ? 'needs_help' : terminalReady ? 'ready' : confirmed ? 'confirmed' : 'pending';
    open.setAttribute('aria-label', cancelled ? '× Неактуально'
      : `${presentation?.icon || '…'} ${presentation?.label || 'Дорабатывается'}`);
    detailInstruction.textContent = accepted.request.instruction;
    detailRequestId.textContent = accepted.requestId;
    detailMutationId.textContent = accepted.mutationId;
    detailRequestHash.textContent = accepted.requestHash;
    detailReplayed.textContent = String(accepted.replayed);
    detailDeliveryState.textContent = deliveryStatus;
    detailStatus.textContent = cancelled
      ? cancellation.issueClosed
        ? 'Неактуально: инженерный тикет помечен и закрыт.'
        : 'Неактуально: задача отменена до создания инженерного тикета.'
      : presentation?.detail || 'Дорабатывается';
    const casualSummary = cancelled
      ? detailStatus.textContent
      : accepted.terminal?.summary || '';
    detailSummary.textContent = casualSummary;
    detailSummary.hidden = casualSummary.length === 0;
    blocker.textContent = presentation?.blocker || '';
    blocker.hidden = !presentation?.blocker;
    const resultUrl = terminalReady ? accepted.terminal.candidate.url : null;
    resultLink.hidden = !resultUrl;
    if (resultUrl) resultLink.href = resultUrl;
    else resultLink.removeAttribute('href');
    obsolete.hidden = typeof options.cancel !== 'function'
      || Boolean(accepted.terminal) || Boolean(cancellation);
    obsolete.disabled = false;
    form.hidden = true;
    open.hidden = false;
    open.setAttribute('aria-controls', details.id);
    open.setAttribute('aria-expanded', 'false');
    details.hidden = true;
    return true;
  };

  const renderAccepted = (receipt) => {
    let validated;
    try {
      validated = validatePlatformDevelopmentIntakeReceipt(receipt, pendingRequest);
    } catch {
      return false;
    }
    acceptedById.set(validated.requestId, validated);
    if (pendingRequest) {
      clearPending();
    }
    return renderAcceptedState();
  };

  const renderProjection = (receipts) => {
    const validated = [];
    for (const receipt of receipts) {
      try {
        validated.push(validatePlatformDevelopmentIntakeReceipt(receipt));
      } catch { /* one malformed historical row cannot hide healthy current work */ }
    }
    if (receipts.length > 0 && validated.length === 0) return false;
    if (pendingRequest) {
      const matching = validated.find((receipt) => {
        try {
          validatePlatformDevelopmentIntakeReceipt(receipt, pendingRequest);
          return true;
        } catch {
          return false;
        }
      });
      if (!matching) return false;
      clearPending();
    }
    acceptedById.clear();
    validated.forEach((receipt) => acceptedById.set(receipt.requestId, receipt));
    return validated.length > 0 ? renderAcceptedState() : renderEmptyState();
  };
  if (Array.isArray(options.existing) && options.existing.length > 0) {
    if (!renderProjection(options.existing)) renderPending();
  } else renderPending();

  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('pointerup', (event) => event.stopPropagation());
  root.addEventListener('click', (event) => event.stopPropagation());
  open.addEventListener('click', () => {
    if (accepted) {
      details.hidden = !details.hidden;
      open.setAttribute('aria-expanded', String(!details.hidden));
      return;
    }
    form.hidden = false;
    open.hidden = true;
    open.setAttribute('aria-expanded', 'true');
    instruction.focus();
  });
  dictate.addEventListener('click', () => {
    instruction.focus();
    const end = instruction.value.length;
    instruction.setSelectionRange?.(end, end);
  });
  instruction.addEventListener('input', () => storeDraftWithFallback(
    primaryStorage, fallbackStorage, key, instruction.value,
  ));
  file.addEventListener('change', () => {
    if (submitting || file.disabled) return;
    status.textContent = '';
    renderScreenshotSelection();
  });
  removeScreenshot.addEventListener('click', () => {
    if (submitting || removeScreenshot.disabled) return;
    file.value = '';
    status.textContent = '';
    renderScreenshotSelection();
    file.focus({ preventScroll: true });
  });
  cancel.addEventListener('click', () => {
    form.hidden = true;
    open.hidden = false;
    open.setAttribute('aria-expanded', 'false');
    open.focus({ preventScroll: true });
  });
  details.querySelector('[data-action="new"]').addEventListener('click', () => {
    accepted = null;
    pendingRequest = null;
    removeStored(primaryStorage, pendingKey);
    removeStored(fallbackStorage, pendingKey);
    setSubmitting(false);
    submit.textContent = 'Отдать в работу';
    status.textContent = '';
    releaseScreenshotField();
    instruction.readOnly = false;
    details.hidden = true;
    form.hidden = false;
    open.hidden = true;
    open.setAttribute('aria-controls', form.id);
    open.setAttribute('aria-expanded', 'true');
    instruction.value = safeDraft(primaryStorage, key) ?? safeDraft(fallbackStorage, key) ?? '';
    instruction.focus();
  });
  obsolete.addEventListener('click', async () => {
    if (destroyed || cancelling || !accepted || typeof options.cancel !== 'function') return;
    cancelling = true;
    obsolete.disabled = true;
    detailStatus.textContent = 'Сохраняю отмену…';
    try {
      const receipt = await options.cancel(
        accepted.requestId,
        buildPlatformDevelopmentIntakeCancelRequest({
          mutationId: options.createMutationId(),
          requestHash: accepted.requestHash,
        }),
      );
      if (!renderAccepted(receipt)) {
        fail('development_intake_receipt_mismatch', 'cancellation receipt is invalid');
      }
      void options.refresh?.();
    } catch {
      detailStatus.textContent = 'Не удалось отменить задачу.';
      obsolete.disabled = false;
    } finally {
      cancelling = false;
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (destroyed || submitting || submit.disabled) return;
    const selectedFile = pendingRequest ? null : (file.files?.[0] || null);
    setSubmitting(true);
    status.textContent = selectedFile ? 'Подготавливаю скриншот…' : 'Сохраняю…';
    try {
      if (!pendingRequest) {
        // One unedited phone screenshot is downscaled and inlined here; there
        // is no upload endpoint, so nothing leaves the request itself.
        const screenshot = await prepareScreenshotFromFile(selectedFile, SCREENSHOT_INVALID);
        if (destroyed) return;
        status.textContent = 'Сохраняю…';
        const normalizedInstruction = normalizeInstruction(instruction.value);
        instruction.value = normalizedInstruction;
        storeDraftWithFallback(primaryStorage, fallbackStorage, key, normalizedInstruction);
        const request = buildPlatformDevelopmentIntakeRequest({
          mutationId: options.createMutationId(),
          instruction: normalizedInstruction,
          surface: options.surface,
          route: options.route,
          buildSha: options.buildSha,
          screenshot,
        });
        if (!persistPlatformDevelopmentIntakePendingRequestWithFallback(
          primaryStorage, fallbackStorage, options, request,
        )) {
          fail('development_intake_pending_not_persisted', 'pending request could not be persisted');
        }
        pendingRequest = request;
        renderPending();
      }
      const receipt = await options.submit(pendingRequest);
      if (!renderAccepted(receipt)) {
        fail('development_intake_receipt_mismatch', 'receipt does not match the pending request');
      }
      status.textContent = 'Задача сохранена ✓';
      storeDraftWithFallback(primaryStorage, fallbackStorage, key, '');
      open.focus({ preventScroll: true });
    } catch (error) {
      if (pendingRequest && platformDevelopmentIntakeFailureDisposition(error) === 'rejected') {
        const originalInstruction = pendingRequest.instruction;
        removeStored(primaryStorage, pendingKey);
        removeStored(fallbackStorage, pendingKey);
        pendingRequest = null;
        instruction.value = originalInstruction;
        instruction.readOnly = false;
        releaseScreenshotField();
        submit.textContent = 'Отдать в работу';
        emptyNotice.hidden = false;
        storeDraftWithFallback(primaryStorage, fallbackStorage, key, originalInstruction);
        status.textContent = 'Запрос отклонён сервером. Исправьте описание и отправьте снова.';
      } else {
        status.textContent = platformDevelopmentIntakeErrorMessage(error);
      }
      setSubmitting(false);
    }
  });
  return Object.freeze({
    destroy() { destroyed = true; formViewport.release(); root.remove(); },
    update(receipts) {
      // A foreground projection must not close an actively composed follow-up
      // (notably when the OS file picker backgrounds and restores the TMA).
      if (!destroyed && Array.isArray(receipts) && (accepted || form.hidden)) {
        renderProjection(receipts);
      }
    },
  });
}
