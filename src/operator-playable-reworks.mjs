import {
  prepareScreenshotFromFile,
  screenshotSelectionLabel,
  screenshotSelectionMarkup,
} from './operator-screenshot.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const SCREENSHOT_INVALID = 'playable_rework_screenshot_invalid';
let controlSequence = 0;

const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const exactKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const printable = (value, max = 2_000) => typeof value === 'string' && value === value.trim()
  && value.length >= 1 && value.length <= max && new TextEncoder().encode(value).length <= max * 4
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
const normalizeInstruction = (value) => typeof value === 'string'
  ? value.replace(/\s+/gu, ' ').trim()
  : value;

export function operatorPlayableReworkErrorMessage(error) {
  if (error?.code === 'playable_rework_screenshot_invalid') return 'Не удалось обработать скриншот. Выберите другое изображение.';
  if (error?.code === 'playable_rework_stale') return 'Механика изменилась. Закройте форму и откройте её снова.';
  if (error?.code === 'playable_rework_invalid' && error?.message === 'invalid rework input') {
    return 'Описание должно содержать от 1 до 2000 символов.';
  }
  if (error?.code === 'playable_rework_invalid') {
    return 'Не удалось подтвердить текущую механику. Закройте форму и откройте её снова.';
  }
  if (error?.code === 'request_timeout') return 'Сервер не ответил вовремя. Повторите отправку.';
  if (error?.status === 0) return 'Нет связи с сервером. Задача не сохранена.';
  return 'Сервер не принял задачу. Повторите позже.';
}

export function buildOperatorPlayableReworkRequest({ mutationId, occurrence, instruction, screenshot }) {
  const normalizedInstruction = normalizeInstruction(instruction);
  if (!UUID.test(mutationId) || !printable(normalizedInstruction)) fail('playable_rework_invalid', 'invalid rework input');
  if (!exactKeys(occurrence, [
    'playableId', 'mappingId', 'rosterActivationId', 'runtime', 'feedPosition', 'level', 'runId',
  ]) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(occurrence.playableId)
    || !UUID.test(occurrence.mappingId) || !UUID.test(occurrence.rosterActivationId)
    || !Number.isInteger(occurrence.feedPosition) || occurrence.feedPosition < 0
    || !(occurrence.level === null || (Number.isInteger(occurrence.level) && occurrence.level > 0))
    || !(occurrence.runId === null || printable(occurrence.runId, 96))
    || !exactKeys(occurrence.runtime, ['version', 'artifactDigest', 'sourceCommit'])
    || !printable(occurrence.runtime.version, 96) || !DIGEST.test(occurrence.runtime.artifactDigest)
    || !(occurrence.runtime.sourceCommit === null || SHA.test(occurrence.runtime.sourceCommit))) {
    fail('playable_rework_invalid', 'exact playable occurrence is unavailable');
  }
  if (!exactKeys(screenshot, ['kind', 'reason', 'mimeType', 'dataUrl'])
    || !['unavailable', 'data_url'].includes(screenshot.kind)) fail('playable_rework_invalid', 'screenshot is invalid');
  if (screenshot.kind === 'unavailable') {
    if (!printable(screenshot.reason, 96) || screenshot.mimeType !== null || screenshot.dataUrl !== null) fail('playable_rework_invalid', 'screenshot is invalid');
  } else {
    const prefix = `data:${screenshot.mimeType};base64,`;
    if (!['image/jpeg', 'image/png'].includes(screenshot.mimeType) || screenshot.reason !== null
      || typeof screenshot.dataUrl !== 'string' || screenshot.dataUrl.length > 524_288
      || !screenshot.dataUrl.startsWith(prefix)) fail('playable_rework_invalid', 'screenshot is invalid');
  }
  return Object.freeze({
    schema: 'feed.playable-rework.request.v1',
    mutationId,
    playableId: occurrence.playableId,
    mappingId: occurrence.mappingId,
    rosterActivationId: occurrence.rosterActivationId,
    runtime: Object.freeze({ ...occurrence.runtime }),
    context: Object.freeze({
      feedPosition: occurrence.feedPosition,
      level: occurrence.level,
      runId: occurrence.runId,
      capturedAt: new Date().toISOString(),
      screenshot: Object.freeze({ ...screenshot }),
    }),
    instruction: normalizedInstruction,
  });
}

/** The shared capture-first preparation, bound to this form's failure code. */
export async function screenshotFromFile(file) {
  return prepareScreenshotFromFile(file, SCREENSHOT_INVALID);
}

const QUEUE_DISPOSITIONS = new Set(['active_batch', 'queued', 'duplicate_of', 'closed']);
const SOURCE_ADAPTERS = new Set(['telegram', 'codex']);
const preservedInstruction = (value) => typeof value === 'string'
  && value.trim().length >= 1 && value.length <= 2_000
  && new TextEncoder().encode(value).length <= 8_000
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);

export function isOperatorPlayableReworkQueueItem(value, playableId = undefined) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && UUID.test(value.requestId)
    && ['open', 'claimed', 'closed'].includes(value.state)
    && SOURCE_ADAPTERS.has(value.sourceAdapter)
    && QUEUE_DISPOSITIONS.has(value.queueDisposition)
    && typeof value.batchPresent === 'boolean'
    && Boolean(value.queueCounts) && typeof value.queueCounts === 'object'
    && Number.isInteger(value.queueCounts.active) && value.queueCounts.active >= 0 && value.queueCounts.active <= 200
    && Number.isInteger(value.queueCounts.queued) && value.queueCounts.queued >= 0 && value.queueCounts.queued <= 200
    && Boolean(value.request) && typeof value.request === 'object'
    && value.request.schema === 'feed.playable-rework.request.v1'
    && typeof value.request.playableId === 'string'
    && (playableId === undefined || value.request.playableId === playableId)
    && preservedInstruction(value.request.instruction)
    && Boolean(value.request.context) && typeof value.request.context === 'object'
    && typeof value.request.context.capturedAt === 'string';
}

export function groupOperatorPlayableReworkQueue(items) {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!isOperatorPlayableReworkQueueItem(item)
      || !['open', 'claimed'].includes(item.state)
      || item.queueDisposition === 'closed') continue;
    const group = groups.get(item.request.playableId) || [];
    group.push(item);
    groups.set(item.request.playableId, group);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const byCreated = String(right.createdAt || right.request.context.capturedAt)
        .localeCompare(String(left.createdAt || left.request.context.capturedAt));
      return byCreated || left.requestId.localeCompare(right.requestId);
    });
  }
  return groups;
}

export function operatorPlayableReworkQueuePresentation(queue) {
  const items = Array.isArray(queue) ? queue : [];
  const locallyActive = items.filter((item) => item?.queueDisposition === 'active_batch').length;
  const hasBatch = locallyActive > 0 || items.some((item) => item?.batchPresent === true);
  const active = hasBatch ? Math.max(
    locallyActive,
    items.reduce((count, item) => Math.max(count, item?.queueCounts?.active || 0), 0),
  ) : 0;
  const queued = Math.max(
    items.filter((item) => item?.queueDisposition === 'queued').length,
    items.reduce((count, item) => Math.max(count, item?.queueCounts?.queued || 0), 0),
  );
  const duplicates = items.filter((item) => item?.queueDisposition === 'duplicate_of').length;
  const needsHelp = items.some((item) => ['needs_help', 'blocked'].includes(
    operatorPlayableReworkPresentation(item).state,
  ));
  if (needsHelp) return Object.freeze({
    state: 'needs_help', label: 'Нужна помощь · добавить замечание',
    active, queued, duplicates, unresolved: items.length,
  });
  if (hasBatch && queued > 0) return Object.freeze({
    state: 'queued', label: `В работе · ещё ${queued}`,
    active, queued, duplicates, unresolved: items.length,
  });
  if (hasBatch) return Object.freeze({
    state: 'active', label: 'В работе · добавить замечание',
    active, queued, duplicates, unresolved: items.length,
  });
  return Object.freeze({
    state: 'idle', label: '✎ Доработать механику',
    active, queued, duplicates, unresolved: items.length,
  });
}

export function operatorPlayableReworkControlKey(occurrence, queue = []) {
  const queueKey = (Array.isArray(queue) ? queue : []).map((item) => [
    item.requestId, item.state, item.queueDisposition, item.batchPresent,
    item.queueCounts?.active, item.queueCounts?.queued,
    item.execution?.state, item.execution?.updatedAt,
    item.releaseExecution?.state, item.releaseExecution?.updatedAt,
  ].join(':')).join('|');
  return `${occurrence.playableId}:${occurrence.mappingId}:${occurrence.rosterActivationId}:${occurrence.runtime.artifactDigest}:${queueKey}`;
}

export function operatorPlayableReworkPresentation(task) {
  const projected = task?.releaseExecution;
  if (projected?.state === 'preparing') {
    return Object.freeze({ state: 'preparing', icon: '…', label: 'Готовится', blocker: null });
  }
  if (projected?.state === 'ready_for_approval') {
    return Object.freeze({ state: 'ready_for_approval', icon: '!', label: 'Готово к проверке', blocker: null });
  }
  if (projected?.state === 'needs_help') {
    return Object.freeze({
      state: 'needs_help',
      icon: '!',
      label: 'Нужна помощь',
      blocker: projected.summary || 'Автоматическая доработка остановилась.',
    });
  }
  if (task?.execution?.state === 'blocked') {
    return Object.freeze({
      state: 'blocked',
      icon: '!',
      label: 'Нужна помощь',
      blocker: task.execution.summary || 'Автоматическая доработка остановилась.',
    });
  }
  return Object.freeze({ state: task?.state || 'open', icon: '✓', label: 'Задача принята', blocker: null });
}

export function mountOperatorPlayableReworkControl(host, options) {
  if (!(host instanceof HTMLElement) || typeof options?.submit !== 'function'
    || typeof options?.createMutationId !== 'function'
    || (options.resolveOccurrence != null && typeof options.resolveOccurrence !== 'function')) {
    fail('playable_rework_invalid', 'control options are invalid');
  }
  const occurrence = options.occurrence;
  const queue = (Array.isArray(options.queue) ? options.queue : [])
    .filter((item) => isOperatorPlayableReworkQueueItem(item, occurrence.playableId));
  const queuePresentation = operatorPlayableReworkQueuePresentation(queue);
  const root = document.createElement('section');
  const controlId = `playable-rework-${controlSequence += 1}`;
  root.className = 'game__operator-flag game__operator-playable-rework';
  root.dataset.reworkState = queuePresentation.state;
  root.innerHTML = `
    <button class="game__operator-flag-open" type="button" aria-expanded="false" aria-controls="${controlId}-form">
      <span aria-hidden="true">✎</span><span class="game__operator-playable-rework-count" data-rework-count hidden></span>
    </button>
    <form class="game__operator-flag-form" id="${controlId}-form" hidden>
      <label>Что поправить
        <textarea name="instruction" rows="3" required placeholder="Например: увеличить номиналы карт" aria-describedby="${controlId}-dictation-hint"></textarea>
      </label>
      <div class="game__operator-playable-rework-dictation">
        <button type="button" data-action="dictate">🎙 Надиктовать</button>
        <small id="${controlId}-dictation-hint">Откроется клавиатура — нажмите на ней 🎤</small>
      </div>
      <label>Скриншот (необязательно)
        <input name="screenshot" type="file" accept="image/*">
      </label>
      ${screenshotSelectionMarkup('rework')}
      <div class="game__operator-flag-actions">
        <button type="submit">Отдать в работу</button>
        <button type="button" data-action="cancel">Отмена</button>
      </div>
      <output class="game__operator-flag-status" aria-live="polite"></output>
    </form>
    <section class="game__operator-playable-rework-details" id="${controlId}-details" hidden>
      <header class="game__operator-playable-rework-summary">
        <div><b data-rework-summary></b><small data-rework-counts></small></div>
        <button type="button" data-action="close-details" aria-label="Закрыть список">×</button>
      </header>
      <div class="game__operator-playable-rework-list" data-rework-list></div>
      <div class="game__operator-playable-rework-detail-actions">
        <button type="button" data-action="add-feedback">Добавить замечание</button>
      </div>
    </section>`;
  host.appendChild(root);
  const open = root.querySelector('.game__operator-flag-open');
  const form = root.querySelector('form');
  const instruction = form.elements.namedItem('instruction');
  const file = form.elements.namedItem('screenshot');
  const status = root.querySelector('output');
  const submit = form.querySelector('button[type="submit"]');
  const dictate = form.querySelector('[data-action="dictate"]');
  const screenshotSelection = form.querySelector('[data-rework-screenshot]');
  const screenshotName = form.querySelector('[data-rework-screenshot-name]');
  const removeScreenshot = form.querySelector('[data-action="remove-screenshot"]');
  const details = root.querySelector('.game__operator-playable-rework-details');
  const summary = details.querySelector('[data-rework-summary]');
  const counts = details.querySelector('[data-rework-counts]');
  const list = details.querySelector('[data-rework-list]');
  const countBadge = root.querySelector('[data-rework-count]');
  open.dataset.reworkState = queuePresentation.state;
  open.setAttribute('aria-label', queuePresentation.label);
  open.title = queuePresentation.label;
  countBadge.textContent = String(queuePresentation.unresolved);
  countBadge.hidden = queuePresentation.unresolved === 0;
  summary.textContent = queuePresentation.label;
  counts.textContent = [
    queuePresentation.active ? `активно ${queuePresentation.active}` : '',
    queuePresentation.queued ? `в очереди ${queuePresentation.queued}` : '',
    queuePresentation.duplicates ? `возможных дублей ${queuePresentation.duplicates}` : '',
  ].filter(Boolean).join(' · ') || 'Новых замечаний пока нет';
  const dispositionLabels = {
    active_batch: 'В работе', queued: 'В очереди',
    duplicate_of: 'Возможный дубль', closed: 'Завершено',
  };
  const sourceLabels = { telegram: 'Telegram', codex: 'Codex' };
  for (const task of queue) {
    const article = document.createElement('article');
    article.className = 'game__operator-playable-rework-item';
    article.dataset.queueDisposition = task.queueDisposition;
    const itemHeading = document.createElement('div');
    itemHeading.className = 'game__operator-playable-rework-item-heading';
    const itemState = document.createElement('b');
    itemState.textContent = dispositionLabels[task.queueDisposition];
    const itemMeta = document.createElement('small');
    const createdAt = task.createdAt || task.request.context?.capturedAt || '';
    const created = createdAt ? new Date(createdAt) : null;
    const createdLabel = created && !Number.isNaN(created.valueOf())
      ? created.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
      : 'время недоступно';
    itemMeta.textContent = `${sourceLabels[task.sourceAdapter]} · ${createdLabel}`;
    itemHeading.append(itemState, itemMeta);
    const itemInstruction = document.createElement('p');
    itemInstruction.textContent = task.request.instruction;
    article.append(itemHeading, itemInstruction);
    const lifecycle = operatorPlayableReworkPresentation(task);
    if (lifecycle.blocker) {
      const blocker = document.createElement('div');
      blocker.className = 'game__operator-playable-rework-blocker';
      const blockerHeading = document.createElement('b');
      blockerHeading.textContent = 'Почему остановилось';
      const blockerSummary = document.createElement('p');
      blockerSummary.dataset.reworkTaskBlockerSummary = '';
      blockerSummary.textContent = lifecycle.blocker;
      blocker.append(blockerHeading, blockerSummary);
      article.append(blocker);
    } else if (!['open', 'claimed'].includes(lifecycle.state)) {
      const lifecycleLabel = document.createElement('small');
      lifecycleLabel.textContent = lifecycle.label;
      article.append(lifecycleLabel);
    }
    list.append(article);
  }
  let destroyed = false;
  let submitting = false;
  let pendingRequest = null;
  const setSubmitting = (value) => {
    submitting = value;
    root.setAttribute('aria-busy', String(value));
    [instruction, file, submit, dictate, removeScreenshot,
      form.querySelector('[data-action="cancel"]')]
      .forEach((element) => { element.disabled = value; });
  };
  const renderScreenshotSelection = () => {
    const selected = file.files?.[0] || null;
    screenshotName.textContent = screenshotSelectionLabel(selected);
    screenshotSelection.hidden = selected === null;
    pendingRequest = null;
  };
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('pointerup', (event) => event.stopPropagation());
  root.addEventListener('click', (event) => event.stopPropagation());
  const showForm = () => {
    status.textContent = '';
    details.hidden = true;
    form.hidden = false;
    open.hidden = true;
    open.setAttribute('aria-controls', form.id);
    open.setAttribute('aria-expanded', 'true');
    instruction.focus();
  };
  open.addEventListener('click', () => {
    if (queue.length > 0) {
      details.hidden = !details.hidden;
      open.setAttribute('aria-controls', details.id);
      open.setAttribute('aria-expanded', String(!details.hidden));
      return;
    }
    showForm();
  });
  details.querySelector('[data-action="add-feedback"]').addEventListener('click', showForm);
  details.querySelector('[data-action="close-details"]').addEventListener('click', () => {
    details.hidden = true;
    open.setAttribute('aria-expanded', 'false');
    open.focus({ preventScroll: true });
  });
  dictate.addEventListener('click', () => {
    instruction.focus();
    const end = instruction.value.length;
    instruction.setSelectionRange?.(end, end);
  });
  file.addEventListener('change', () => {
    if (submitting) return;
    status.textContent = '';
    renderScreenshotSelection();
  });
  instruction.addEventListener('input', () => {
    if (!submitting) pendingRequest = null;
  });
  removeScreenshot.addEventListener('click', () => {
    if (submitting) return;
    file.value = '';
    status.textContent = '';
    renderScreenshotSelection();
    file.focus({ preventScroll: true });
  });
  form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    form.hidden = true;
    open.hidden = false;
    open.setAttribute('aria-expanded', 'false');
    if (queue.length > 0) {
      details.hidden = false;
      open.setAttribute('aria-controls', details.id);
      open.setAttribute('aria-expanded', 'true');
      details.querySelector('[data-action="close-details"]').focus({ preventScroll: true });
    } else {
      open.focus({ preventScroll: true });
    }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (destroyed || submitting) return;
    const selectedFile = file.files?.[0] || null;
    let submitOccurrence;
    try {
      submitOccurrence = options.resolveOccurrence?.() || occurrence;
      setSubmitting(true);
      status.textContent = selectedFile ? 'Подготавливаю скриншот…' : 'Сохраняю…';
      if (!pendingRequest) {
        const screenshot = await screenshotFromFile(selectedFile);
        if (destroyed) return;
        pendingRequest = buildOperatorPlayableReworkRequest({
          mutationId: options.createMutationId(), occurrence: submitOccurrence,
          instruction: instruction.value, screenshot,
        });
      }
      status.textContent = 'Сохраняю…';
      const receipt = await options.submit(pendingRequest);
      if (destroyed) return;
      status.textContent = receipt?.replayed
        ? 'Такое замечание уже сохранено.'
        : queuePresentation.active > 0
          ? 'Замечание сохранено. Текущая правка уже в работе — это попадёт в следующий пакет.'
          : 'Замечание сохранено.';
      root.dataset.reworkSubmitResult = receipt?.replayed ? 'replayed' : 'saved';
      setTimeout(() => {
        if (!destroyed) {
          form.reset();
          pendingRequest = null;
          renderScreenshotSelection();
          setSubmitting(false);
          form.hidden = true;
          open.hidden = false;
          open.setAttribute('aria-expanded', 'false');
          status.textContent = '';
          open.focus({ preventScroll: true });
          void options.refresh?.();
        }
      }, 2_400);
    } catch (error) {
      if (error?.code === 'playable_rework_stale') pendingRequest = null;
      if (destroyed) return;
      status.textContent = operatorPlayableReworkErrorMessage(error);
      setSubmitting(false);
    }
  });
  return Object.freeze({
    key: operatorPlayableReworkControlKey(occurrence, queue),
    playableId: occurrence.playableId,
    destroy() { destroyed = true; root.remove(); },
  });
}
