const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const SCREENSHOT_DATA_URL_LIMIT = 500_000;
const SCREENSHOT_PASSTHROUGH_BYTES = 370_000;
const SCREENSHOT_INPUT_BYTES_LIMIT = 30_000_000;
const SCREENSHOT_INPUT_PIXELS_LIMIT = 16_000_000;
const SCREENSHOT_MAX_EDGE = 1_600;
const SCREENSHOT_MIN_EDGE = 320;
const SCREENSHOT_JPEG_QUALITIES = [0.86, 0.76, 0.66, 0.56, 0.46];
const SCREENSHOT_DECODE_TIMEOUT_MS = 15_000;
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

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(Object.assign(
      new Error('screenshot could not be read'),
      { code: 'playable_rework_screenshot_invalid' },
    ));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

async function encodedImageDimensions(file) {
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 262_144)).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes.slice(0, 8).every((value, index) => (
    value === [137, 80, 78, 71, 13, 10, 26, 10][index]
  ))) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8X') {
      return {
        width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
        height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
      };
    }
    if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      return {
        width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
      };
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 <= bytes.length) {
      while (bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
  }
  return null;
}

function decodeScreenshot(file, dimensions) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleanup = () => {};
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const failDecode = () => finish(() => {
      cleanup();
      reject(Object.assign(
        new Error('screenshot could not be decoded'),
        { code: 'playable_rework_screenshot_invalid' },
      ));
    });
    const timeout = setTimeout(failDecode, SCREENSHOT_DECODE_TIMEOUT_MS);
    if (typeof createImageBitmap === 'function') {
      const resize = Math.max(dimensions.width, dimensions.height) <= SCREENSHOT_MAX_EDGE
        ? {}
        : dimensions.width >= dimensions.height
          ? { resizeWidth: SCREENSHOT_MAX_EDGE, resizeQuality: 'high' }
          : { resizeHeight: SCREENSHOT_MAX_EDGE, resizeQuality: 'high' };
      createImageBitmap(file, resize)
        .then((image) => {
          if (settled) {
            image.close();
            return;
          }
          finish(() => resolve({
            image,
            release: () => image.close(),
            width: image.width,
            height: image.height,
          }));
        }, failDecode);
      return;
    }
    const url = URL.createObjectURL(file);
    cleanup = () => URL.revokeObjectURL(url);
    const image = new Image();
    image.onload = () => finish(() => resolve({
      image,
      release: cleanup,
      width: image.naturalWidth,
      height: image.naturalHeight,
    }));
    image.onerror = failDecode;
    image.src = url;
  });
}

function canvasJpeg(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob || blob.type !== 'image/jpeg') {
      reject(Object.assign(
        new Error('screenshot could not be encoded'),
        { code: 'playable_rework_screenshot_invalid' },
      ));
      return;
    }
    resolve(blob);
  }, 'image/jpeg', quality));
}

async function normalizedScreenshotDataUrl(image, sourceWidth, sourceHeight) {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)
    || sourceWidth < 1 || sourceHeight < 1) {
    throw Object.assign(
      new Error('screenshot dimensions are invalid'),
      { code: 'playable_rework_screenshot_invalid' },
    );
  }
  const canvas = document.createElement('canvas');
  let scale = Math.min(1, SCREENSHOT_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  while (true) {
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) break;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of SCREENSHOT_JPEG_QUALITIES) {
      const blob = await canvasJpeg(canvas, quality);
      if (blob.size <= SCREENSHOT_PASSTHROUGH_BYTES) {
        const dataUrl = await readFileAsDataUrl(blob);
        if (dataUrl.length <= SCREENSHOT_DATA_URL_LIMIT) return dataUrl;
      }
    }
    if (Math.min(canvas.width, canvas.height) <= SCREENSHOT_MIN_EDGE) break;
    scale *= 0.78;
  }
  throw Object.assign(
    new Error('screenshot could not be normalized'),
    { code: 'playable_rework_screenshot_invalid' },
  );
}

export async function screenshotFromFile(file) {
  if (!file) return Promise.resolve(Object.freeze({
    kind: 'unavailable', reason: 'not_attached', mimeType: null, dataUrl: null,
  }));
  const mimeType = String(file.type || '');
  if (file.size > SCREENSHOT_INPUT_BYTES_LIMIT
    || (mimeType && mimeType !== 'application/octet-stream' && !mimeType.startsWith('image/'))) {
    throw Object.assign(
      new Error('screenshot must be an image'),
      { code: 'playable_rework_screenshot_invalid' },
    );
  }
  if (['image/jpeg', 'image/png'].includes(mimeType) && file.size <= SCREENSHOT_PASSTHROUGH_BYTES) {
    const dataUrl = await readFileAsDataUrl(file);
    if (dataUrl.length <= SCREENSHOT_DATA_URL_LIMIT) {
      return Object.freeze({ kind: 'data_url', reason: null, mimeType, dataUrl });
    }
  }
  try {
    const dimensions = await encodedImageDimensions(file);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1
      || dimensions.width * dimensions.height > SCREENSHOT_INPUT_PIXELS_LIMIT) {
      throw Object.assign(
        new Error('screenshot dimensions are unsupported'),
        { code: 'playable_rework_screenshot_invalid' },
      );
    }
    const decoded = await decodeScreenshot(file, dimensions);
    try {
      const dataUrl = await normalizedScreenshotDataUrl(
        decoded.image,
        decoded.width,
        decoded.height,
      );
      return Object.freeze({ kind: 'data_url', reason: null, mimeType: 'image/jpeg', dataUrl });
    } finally {
      decoded.release();
    }
  } catch (error) {
    if (error?.code === 'playable_rework_screenshot_invalid') throw error;
    throw Object.assign(
      new Error('screenshot could not be processed'),
      { code: 'playable_rework_screenshot_invalid' },
    );
  }
}

const formatScreenshotBytes = (value) => value < 1_000_000
  ? `${Math.max(1, Math.round(value / 1_000))} КБ`
  : `${(value / 1_000_000).toFixed(1)} МБ`;

export function operatorPlayableReworkControlKey(occurrence, existing) {
  return `${occurrence.playableId}:${occurrence.mappingId}:${occurrence.rosterActivationId}:${occurrence.runtime.artifactDigest}:${existing?.requestId || ''}:${existing?.state || ''}:${existing?.execution?.state || ''}:${existing?.execution?.updatedAt || ''}:${existing?.releaseExecution?.state || ''}:${existing?.releaseExecution?.updatedAt || ''}`;
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
        <input name="screenshot" type="file" accept="image/*">
      </label>
      <div class="game__operator-playable-rework-screenshot" data-rework-screenshot hidden>
        <span data-rework-screenshot-name></span>
        <button type="button" data-action="remove-screenshot">Удалить</button>
      </div>
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
  const screenshotSelection = form.querySelector('[data-rework-screenshot]');
  const screenshotName = form.querySelector('[data-rework-screenshot-name]');
  const removeScreenshot = form.querySelector('[data-action="remove-screenshot"]');
  const details = root.querySelector('.game__operator-playable-rework-details');
  const taskInstruction = details.querySelector('[data-rework-task-instruction]');
  const taskCreated = details.querySelector('[data-rework-task-created]');
  const taskBlocker = details.querySelector('[data-rework-task-blocker]');
  const taskBlockerSummary = details.querySelector('[data-rework-task-blocker-summary]');
  let acceptedTask = existing;
  const renderAcceptedTask = (task) => {
    acceptedTask = task;
    open.disabled = false;
    const presentation = operatorPlayableReworkPresentation(task);
    open.textContent = presentation.icon;
    open.dataset.reworkState = presentation.state;
    const stateLabel = `${presentation.icon} ${presentation.label}`;
    open.setAttribute('aria-label', stateLabel);
    open.title = presentation.label;
    taskInstruction.textContent = task.request.instruction || 'Описание задачи недоступно.';
    const createdAt = task.createdAt || task.request.context?.capturedAt || '';
    const created = createdAt ? new Date(createdAt) : null;
    taskCreated.textContent = created && !Number.isNaN(created.valueOf())
      ? `Отправлено ${created.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}`
      : '';
    taskCreated.hidden = !taskCreated.textContent;
    taskBlockerSummary.textContent = presentation.blocker || '';
    taskBlocker.hidden = presentation.blocker === null;
    details.hidden = true;
    open.setAttribute('aria-controls', details.id);
    open.setAttribute('aria-expanded', 'false');
  };
  if (existing) renderAcceptedTask(existing);
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
    screenshotName.textContent = selected
      ? `${selected.name || 'Скриншот'} · ${formatScreenshotBytes(selected.size)}${selected.size > SCREENSHOT_PASSTHROUGH_BYTES ? ' · подготовим автоматически' : ''}`
      : '';
    screenshotSelection.hidden = selected === null;
    pendingRequest = null;
  };
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
    open.focus({ preventScroll: true });
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
      await options.submit(pendingRequest);
      if (destroyed) return;
      status.textContent = 'Задача сохранена ✓ · ждёт подключения Labs';
      form.querySelectorAll('textarea,input,button').forEach((element) => { element.disabled = true; });
      submitting = false;
      root.setAttribute('aria-busy', 'false');
      const acceptedRequest = pendingRequest;
      setTimeout(() => {
        if (!destroyed) {
          form.hidden = true;
          open.hidden = false;
          renderAcceptedTask({ state: 'open', request: acceptedRequest, createdAt: acceptedRequest.context.capturedAt });
          open.focus({ preventScroll: true });
        }
      }, 1200);
    } catch (error) {
      if (error?.code === 'playable_rework_stale') pendingRequest = null;
      if (destroyed) return;
      status.textContent = operatorPlayableReworkErrorMessage(error);
      setSubmitting(false);
    }
  });
  return Object.freeze({
    key: operatorPlayableReworkControlKey(occurrence, existing),
    destroy() { destroyed = true; root.remove(); },
  });
}
