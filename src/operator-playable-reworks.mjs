const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const exactKeys = (value, keys) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const printable = (value, max = 2_000) => typeof value === 'string' && value === value.trim()
  && value.length >= 1 && value.length <= max && new TextEncoder().encode(value).length <= max * 4
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

export function buildOperatorPlayableReworkRequest({ mutationId, occurrence, instruction, screenshot }) {
  if (!UUID.test(mutationId) || !printable(instruction)) fail('playable_rework_invalid', 'invalid rework input');
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
    instruction,
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
  root.className = 'game__operator-flag game__operator-playable-rework';
  root.innerHTML = `
    <button class="game__operator-flag-open" type="button">Доработать механику</button>
    <form class="game__operator-flag-form" hidden>
      <label>Что поправить
        <textarea name="instruction" rows="3" required placeholder="Например: увеличить номиналы карт"></textarea>
      </label>
      <label>Скриншот (необязательно)
        <input name="screenshot" type="file" accept="image/jpeg,image/png">
      </label>
      <div class="game__operator-flag-actions">
        <button type="submit">Отдать в работу</button>
        <button type="button" data-action="cancel">Отмена</button>
      </div>
      <output class="game__operator-flag-status" aria-live="polite"></output>
    </form>`;
  host.appendChild(root);
  const open = root.querySelector('.game__operator-flag-open');
  const form = root.querySelector('form');
  const instruction = form.elements.namedItem('instruction');
  const file = form.elements.namedItem('screenshot');
  const status = root.querySelector('output');
  const submit = form.querySelector('button[type="submit"]');
  if (existing) {
    open.disabled = true;
    open.textContent = existing.state === 'claimed' ? 'Готово к проверке ✓' : 'Задача принята ✓';
  }
  let destroyed = false;
  let pendingRequest = null;
  root.addEventListener('pointerdown', (event) => event.stopPropagation());
  root.addEventListener('pointerup', (event) => event.stopPropagation());
  root.addEventListener('click', (event) => event.stopPropagation());
  open.addEventListener('click', () => { form.hidden = false; open.hidden = true; instruction.focus(); });
  form.querySelector('[data-action="cancel"]').addEventListener('click', () => { form.hidden = true; open.hidden = false; });
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
      setTimeout(() => { if (!destroyed) { form.hidden = true; open.hidden = false; open.disabled = true; open.textContent = 'Задача принята ✓'; } }, 1200);
    } catch (error) {
      if (error?.code === 'playable_rework_stale') pendingRequest = null;
      status.textContent = error?.code === 'playable_rework_screenshot_invalid'
        ? 'Скриншот должен быть JPG/PNG до 380 КБ.' : 'Не удалось сохранить задачу.';
      submit.disabled = false;
    }
  });
  return Object.freeze({
    key: `${occurrence.playableId}:${occurrence.mappingId}:${occurrence.rosterActivationId}:${occurrence.runtime.artifactDigest}:${existing?.requestId || ''}`,
    destroy() { destroyed = true; root.remove(); },
  });
}
