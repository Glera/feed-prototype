import { observeOperatorFormViewport } from './operator-form-viewport.mjs';
import {
  prepareScreenshotFromFile,
  screenshotSelectionLabel,
  screenshotSelectionMarkup,
} from './operator-screenshot.mjs';

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
    && exactKeys(context, ['buildSha'])
    && context.buildSha === buildSha;
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
    schema: 'platform.development-intake.request.v1',
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
    || !exactTimestamp(value.recordedAt) || value.nothingPublished !== true) {
    fail('development_intake_receipt_invalid', 'terminal receipt shape is invalid');
  }
  if (value.status === 'READY_TO_PLAY') {
    if (!exactKeys(value.candidate, ['repository', 'commitSha', 'artifactDigest', 'url'])
      || !/^Glera\/(p4g-workspace-meta|swipe-backend|feed-prototype|swipe-generator|swipe-ugc|playables)$/.test(value.candidate.repository)
      || !SHA.test(value.candidate.commitSha)
      || !/^sha256:[0-9a-f]{64}$/.test(value.candidate.artifactDigest)
      || !/^https:\/\/\S+$/.test(value.candidate.url)
      || value.blocker !== null
      || !exactKeys(value.review, ['provider', 'verdict', 'patchDigest', 'reviewedAt'])
      || value.review.provider !== 'claude' || value.review.verdict !== 'APPROVE'
      || !/^sha256:[0-9a-f]{64}$/.test(value.review.patchDigest)
      || !exactTimestamp(value.review.reviewedAt)) {
      fail('development_intake_receipt_invalid', 'READY_TO_PLAY receipt is invalid');
    }
  } else if (value.candidate !== null
    || !exactKeys(value.blocker, ['reasonCode', 'operatorAction'])
    || !/^[a-z0-9_]{3,64}$/.test(value.blocker.reasonCode)
    || !printable(value.blocker.operatorAction, 240)
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
    || value.delivery?.nothingPublished !== true) {
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
  const receipt = {
    schema: value.schema,
    requestId: value.requestId,
    mutationId: value.mutationId,
    requestHash: value.requestHash,
    delivery: Object.freeze({ ...value.delivery }),
    terminal: exactTerminal(value.terminal),
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
  return Object.freeze({
    schema: value.schema,
    items: Object.freeze(value.items.map((item) => validatePlatformDevelopmentIntakeReceipt(item))),
  });
}

export function platformDevelopmentIntakeFailureDisposition(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status < 500
    && !TRANSIENT_HTTP_STATUSES.has(status)
    ? 'rejected'
    : 'retry';
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

function safeDraft(storage, key) {
  try {
    const value = storage?.getItem(key);
    return typeof value === 'string' && value.length <= 2_000 ? value : '';
  } catch {
    return '';
  }
}

function storeDraft(storage, key, value) {
  try {
    if (value) storage?.setItem(key, value);
    else storage?.removeItem(key);
  } catch { /* storage is best-effort; submission remains durable server-side */ }
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
      <b>Запрошенная правка платформы</b>
      <p data-intake-instruction></p>
      <small data-intake-status></small>
      <dl class="platform-development-intake__receipt" aria-label="Durable receipt">
        <div><dt>requestId</dt><dd data-intake-request-id></dd></div>
        <div><dt>mutationId</dt><dd data-intake-mutation-id></dd></div>
        <div><dt>requestHash</dt><dd data-intake-request-hash></dd></div>
        <div><dt>replayed</dt><dd data-intake-replayed></dd></div>
        <div><dt>Issue delivery</dt><dd data-intake-delivery-state></dd></div>
      </dl>
      <p class="platform-development-intake__blocker" data-intake-blocker hidden></p>
      <a class="platform-development-intake__result" data-intake-result target="_blank" rel="noreferrer" hidden>Открыть результат</a>
      <button type="button" data-action="obsolete" hidden>Неактуально</button>
      <button type="button" data-action="new">Новая задача</button>
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
  let pendingRequest = restorePlatformDevelopmentIntakePendingRequest(options.storage, options);
  instruction.value = pendingRequest?.instruction ?? safeDraft(options.storage, key);
  let accepted = null;
  let destroyed = false;
  let submitting = false;
  let cancelling = false;

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
    instruction.value = pendingRequest.instruction;
    instruction.readOnly = true;
    file.disabled = true;
    removeScreenshot.disabled = true;
    submit.textContent = 'Повторить сохранение';
    status.textContent = 'Есть незавершённая отправка — повторите сохранение.';
  };

  const renderAccepted = (receipt) => {
    let validated;
    try {
      validated = validatePlatformDevelopmentIntakeReceipt(receipt, pendingRequest);
    } catch {
      return false;
    }
    accepted = validated;
    if (pendingRequest) {
      removeStored(options.storage, pendingKey);
      pendingRequest = null;
    }
    const deliveryStatus = validated.delivery.status;
    const cancellation = validated.cancellation;
    const cancelled = cancellation?.status === 'confirmed';
    const cancellationFailed = cancellation?.status === 'failed_terminal';
    const terminalReady = validated.terminal?.status === 'READY_TO_PLAY';
    const terminalNeedsHelp = validated.terminal?.status === 'NEEDS_HELP';
    const failed = deliveryStatus === 'failed_terminal' || terminalNeedsHelp;
    const confirmed = deliveryStatus === 'confirmed';
    open.textContent = cancelled ? '×' : failed || cancellationFailed ? '!' : terminalReady ? '▶' : '✓';
    open.dataset.intakeState = cancelled ? 'cancelled' : failed || cancellationFailed
      ? 'needs_help' : terminalReady ? 'ready' : confirmed ? 'confirmed' : 'pending';
    open.setAttribute('aria-label', cancelled ? '× Неактуально' : failed || cancellationFailed
      ? '! Нужна помощь' : terminalReady ? '▶ Можно проверить' : confirmed ? '✓ Тикет создан' : '✓ Задача принята');
    detailInstruction.textContent = validated.request.instruction;
    detailRequestId.textContent = validated.requestId;
    detailMutationId.textContent = validated.mutationId;
    detailRequestHash.textContent = validated.requestHash;
    detailReplayed.textContent = String(validated.replayed);
    detailDeliveryState.textContent = deliveryStatus;
    detailStatus.textContent = cancelled
      ? cancellation.issueClosed
        ? 'Неактуально: инженерный тикет помечен и закрыт.'
        : 'Неактуально: задача отменена до создания инженерного тикета.'
      : cancellationFailed
        ? 'Не удалось закрыть инженерный тикет; нужна помощь.'
        : cancellation
          ? 'Отмена сохранена и синхронизируется.'
      : terminalNeedsHelp
      ? `NEEDS_HELP: ${validated.terminal.summary}`
      : terminalReady
        ? `READY_TO_PLAY: ${validated.terminal.summary}`
        : failed
          ? 'Синхронизация остановлена; изменения не опубликованы.'
      : confirmed ? 'Инженерный тикет создан; изменения ещё не опубликованы.'
        : 'Задача сохранена и ждёт синхронизации; изменения не опубликованы.';
    blocker.textContent = cancellationFailed
      ? `Не удалось завершить отмену: ${cancellation.lastErrorCode || 'unknown'}`
      : terminalNeedsHelp
      ? validated.terminal.blocker.operatorAction
      : failed ? 'Нужна помощь с конфигурацией инженерного контура.' : '';
    blocker.hidden = !(failed || cancellationFailed);
    const resultUrl = terminalReady
      ? validated.terminal.candidate.url
      : confirmed ? validated.delivery.issueUrl : null;
    resultLink.hidden = !resultUrl;
    if (resultUrl) resultLink.href = resultUrl;
    else resultLink.removeAttribute('href');
    obsolete.hidden = typeof options.cancel !== 'function'
      || Boolean(validated.terminal) || Boolean(cancellation);
    obsolete.disabled = false;
    form.hidden = true;
    open.hidden = false;
    open.setAttribute('aria-controls', details.id);
    open.setAttribute('aria-expanded', 'false');
    details.hidden = true;
    return true;
  };
  if (options.existing && !renderAccepted(options.existing)) renderPending();
  else if (!options.existing) renderPending();

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
  instruction.addEventListener('input', () => storeDraft(options.storage, key, instruction.value));
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
    removeStored(options.storage, pendingKey);
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
    instruction.value = safeDraft(options.storage, key);
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
        const request = buildPlatformDevelopmentIntakeRequest({
          mutationId: options.createMutationId(),
          instruction: instruction.value,
          surface: options.surface,
          route: options.route,
          buildSha: options.buildSha,
          screenshot,
        });
        if (!persistPlatformDevelopmentIntakePendingRequest(options.storage, options, request)) {
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
      storeDraft(options.storage, key, '');
      open.focus({ preventScroll: true });
    } catch (error) {
      if (pendingRequest && platformDevelopmentIntakeFailureDisposition(error) === 'rejected') {
        const originalInstruction = pendingRequest.instruction;
        removeStored(options.storage, pendingKey);
        pendingRequest = null;
        instruction.value = originalInstruction;
        instruction.readOnly = false;
        releaseScreenshotField();
        submit.textContent = 'Отдать в работу';
        storeDraft(options.storage, key, originalInstruction);
        status.textContent = 'Запрос отклонён сервером. Исправьте описание и отправьте снова.';
      } else {
        status.textContent = error?.code === SCREENSHOT_INVALID
          ? 'Не удалось обработать скриншот. Выберите другое изображение.'
          : 'Не удалось сохранить задачу.';
      }
      setSubmitting(false);
    }
  });
  return Object.freeze({
    destroy() { destroyed = true; formViewport.release(); root.remove(); },
    update(receipt) {
      // A foreground projection must not close an actively composed follow-up
      // (notably when the OS file picker backgrounds and restores the TMA).
      if (!destroyed && receipt && (accepted || form.hidden)) renderAccepted(receipt);
    },
  });
}
