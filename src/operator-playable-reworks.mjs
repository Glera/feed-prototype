const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
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
  if (error?.code === 'playable_rework_screenshot_invalid') return 'Скриншот должен быть JPG/PNG до 380 КБ.';
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

function screenshotFromFile(file) {
  if (!file) return Promise.resolve(Object.freeze({
    kind: 'unavailable', reason: 'not_attached', mimeType: null, dataUrl: null,
  }));
  if (!['image/jpeg', 'image/png'].includes(file.type) || file.size > 380_000) {
    return Promise.reject(Object.assign(new Error('screenshot must be JPG/PNG up to 380 KB'), { code: 'playable_rework_screenshot_invalid' }));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(Object.assign(new Error('screenshot could not be read'), { code: 'playable_rework_screenshot_invalid' }));
    reader.onload = () => resolve(Object.freeze({ kind: 'data_url', reason: null, mimeType: file.type, dataUrl: reader.result }));
    reader.readAsDataURL(file);
  });
}

export function operatorPlayableReworkControlKey(occurrence, existing) {
  return `${occurrence.playableId}:${occurrence.mappingId}:${occurrence.rosterActivationId}:${occurrence.runtime.artifactDigest}:${existing?.requestId || ''}:${existing?.state || ''}:${existing?.execution?.state || ''}:${existing?.execution?.updatedAt || ''}`;
}

export function mountOperatorPlayableReworkControl(host, options) {
  if (!(host instanceof HTMLElement) || typeof options?.submit !== 'function'
    || typeof options?.createMutationId !== 'function'
    || (options.resolveOccurrence != null && typeof options.resolveOccurrence !== 'function')) {
    fail('playable_rework_invalid', 'control options are invalid');
  }
  const occurrence = options.occurrence;
  const existing = options.existing?.request?.playableId === occurrence.playableId
    && ['open', 'claimed'].includes(options.existing.state)
    ? options.existing : null;
  const root = document.createElement('section');
  const controlId = `playable-rework-${controlSequence += 1}`;
  root.className = 'game__operator-flag game__operator-playable-rework';
  root.innerHTML = `
    <button class="game__operator-flag-open" type="button" aria-expanded="false" aria-controls="${controlId}-form" aria-label="✎ Доработать механику" title="Доработать механику">✎</button>
    <form class="game__operator-flag-form" id="${controlId}-form" hidden>
      <label>Что поправить
        <textarea name="instruction" rows="3" required placeholder="Например: увеличить номиналы карт" aria-describedby="${controlId}-dictation-hint"></textarea>
      </label>
      <div class="game__operator-playable-rework-dictation">
        <button type="button" data-action="dictate">🎙 Надиктовать</button>
        <small id="${controlId}-dictation-hint">Откроется клавиатура — нажмите на ней 🎤</small>
      </div>
      <label>Скриншот (необязательно)
        <input name="screenshot" type="file" accept="image/jpeg,image/png">
      </label>
      <div class="game__operator-flag-actions">
        <button type="submit">Отдать в работу</button>
        <button type="button" data-action="cancel">Отмена</button>
      </div>
      <output class="game__operator-flag-status" aria-live="polite"></output>
    </form>
    <section class="game__operator-playable-rework-details" id="${controlId}-details" hidden>
      <b>Запрошенная правка</b>
      <p data-rework-task-instruction></p>
      <small data-rework-task-created></small>
      <div class="game__operator-playable-rework-blocker" data-rework-task-blocker hidden>
        <b>Почему остановилось</b>
        <p data-rework-task-blocker-summary></p>
        <small>В ленту изменения не опубликованы.</small>
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
  const details = root.querySelector('.game__operator-playable-rework-details');
  const taskInstruction = details.querySelector('[data-rework-task-instruction]');
  const taskCreated = details.querySelector('[data-rework-task-created]');
  const taskBlocker = details.querySelector('[data-rework-task-blocker]');
  const taskBlockerSummary = details.querySelector('[data-rework-task-blocker-summary]');
  let acceptedTask = existing;
  const renderAcceptedTask = (task) => {
    acceptedTask = task;
    open.disabled = false;
    const blocked = task.execution?.state === 'blocked';
    const claimed = task.state === 'claimed';
    open.textContent = blocked || claimed ? '!' : '✓';
    open.dataset.reworkState = blocked ? 'blocked' : claimed ? 'claimed' : 'open';
    const stateLabel = blocked ? '! Нужна помощь' : claimed ? '! Готово к проверке' : '✓ Задача принята';
    open.setAttribute('aria-label', stateLabel);
    open.title = stateLabel.slice(2);
    taskInstruction.textContent = task.request.instruction || 'Описание задачи недоступно.';
    const createdAt = task.createdAt || task.request.context?.capturedAt || '';
    const created = createdAt ? new Date(createdAt) : null;
    taskCreated.textContent = created && !Number.isNaN(created.valueOf())
      ? `Отправлено ${created.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`
      : '';
    taskCreated.hidden = !taskCreated.textContent;
    taskBlockerSummary.textContent = blocked
      ? task.execution.summary || 'Автоматическая доработка остановилась.'
      : '';
    taskBlocker.hidden = !blocked;
    details.hidden = true;
    open.setAttribute('aria-controls', details.id);
    open.setAttribute('aria-expanded', 'false');
  };
  if (existing) renderAcceptedTask(existing);
  let destroyed = false;
  let pendingRequest = null;
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('pointerup', (event) => event.stopPropagation());
  root.addEventListener('click', (event) => event.stopPropagation());
  open.addEventListener('click', () => {
    if (acceptedTask) {
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
  form.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    form.hidden = true;
    open.hidden = false;
    open.setAttribute('aria-expanded', 'false');
    open.focus({ preventScroll: true });
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (destroyed || submit.disabled) return;
    submit.disabled = true;
    status.textContent = 'Сохраняю…';
    try {
      if (!pendingRequest) {
        const screenshot = await screenshotFromFile(file.files?.[0] || null);
        const currentOccurrence = options.resolveOccurrence?.() || occurrence;
        pendingRequest = buildOperatorPlayableReworkRequest({
          mutationId: options.createMutationId(), occurrence: currentOccurrence,
          instruction: instruction.value, screenshot,
        });
      }
      await options.submit(pendingRequest);
      status.textContent = 'Задача сохранена ✓ · ждёт подключения Labs';
      form.querySelectorAll('textarea,input,button').forEach((element) => { element.disabled = true; });
      setTimeout(() => {
        if (!destroyed) {
          form.hidden = true;
          open.hidden = false;
          renderAcceptedTask({ state: 'open', request: pendingRequest, createdAt: pendingRequest.context.capturedAt });
          open.focus({ preventScroll: true });
        }
      }, 1200);
    } catch (error) {
      if (error?.code === 'playable_rework_stale') pendingRequest = null;
      status.textContent = operatorPlayableReworkErrorMessage(error);
      submit.disabled = false;
    }
  });
  return Object.freeze({
    key: operatorPlayableReworkControlKey(occurrence, existing),
    destroy() { destroyed = true; root.remove(); },
  });
}
