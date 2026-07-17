const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const INTENTS = new Set(['delete_candidate', 'edit_candidate']);

export class OperatorLevelFlagContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'OperatorLevelFlagContractError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new OperatorLevelFlagContractError(code, message); };
const plainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const exactKeys = (value, keys) => plainObject(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const uuid = (value, field) => {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_uuid', `${field} must be a canonical UUID`);
  return value;
};
const hash = (value, field, nullable = false) => {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail('invalid_hash', `${field} must be lowercase 64-hex`);
  return value;
};
const printable = (value, field, maxCharacters = 2_000) => {
  const characterCount = typeof value === 'string' ? [...value].length : 0;
  if (typeof value !== 'string' || characterCount < 1 || characterCount > maxCharacters || value !== value.trim()
    || new TextEncoder().encode(value).length > 8_000
    || [...value].some((character) => {
      const code = character.codePointAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })) fail('invalid_comment', `${field} must be printable UTF-8 without edge whitespace`);
  return value;
};
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const clone = (value) => JSON.parse(JSON.stringify(value));

export function operatorLevelFlaggingAvailable(value) {
  return value === true;
}

export function validateOperatorLevelFlagOccurrence(value) {
  if (!exactKeys(value, [
    'flagSurface', 'decisionId', 'contentImpressionId', 'catalogEntryId', 'seriesId', 'ordinal',
    'levelSpecHash', 'skinHash', 'levelEventId', 'levelImpressionId', 'runId', 'attemptEventId',
  ])) fail('invalid_occurrence', 'operator flag occurrence has an unsupported shape');
  if (!['preview', 'active_level'].includes(value.flagSurface)) {
    fail('invalid_surface', 'flagSurface is unsupported');
  }
  uuid(value.decisionId, 'decisionId');
  uuid(value.contentImpressionId, 'contentImpressionId');
  uuid(value.catalogEntryId, 'catalogEntryId');
  uuid(value.seriesId, 'seriesId');
  if (!Number.isInteger(value.ordinal) || value.ordinal < 1 || value.ordinal > 6) {
    fail('invalid_ordinal', 'ordinal must be 1..6');
  }
  hash(value.levelSpecHash, 'levelSpecHash');
  hash(value.skinHash, 'skinHash', true);
  uuid(value.levelEventId, 'levelEventId');
  if (value.levelImpressionId !== null) uuid(value.levelImpressionId, 'levelImpressionId');
  if (value.runId !== null) printable(value.runId, 'runId', 96);
  if (value.attemptEventId !== null) uuid(value.attemptEventId, 'attemptEventId');
  if (value.flagSurface === 'preview' && (value.levelImpressionId !== null || value.runId !== null)) {
    fail('invalid_surface', 'preview cannot claim active-level identity');
  }
  if (value.flagSurface === 'active_level' && value.levelImpressionId === null) {
    fail('invalid_surface', 'active_level requires levelImpressionId');
  }
  if ((value.runId === null) !== (value.attemptEventId === null)) {
    fail('invalid_occurrence', 'runId and attemptEventId must be present together');
  }
  return freeze({
    flagSurface: value.flagSurface,
    decisionId: value.decisionId,
    contentImpressionId: value.contentImpressionId,
    catalogEntryId: value.catalogEntryId,
    seriesId: value.seriesId,
    ordinal: value.ordinal,
    levelSpecHash: value.levelSpecHash,
    skinHash: value.skinHash,
    levelEventId: value.levelEventId,
    levelImpressionId: value.levelImpressionId,
    runId: value.runId,
    attemptEventId: value.attemptEventId,
  });
}

export function operatorLevelFlagOccurrenceKey(value) {
  const occurrence = validateOperatorLevelFlagOccurrence(value);
  return JSON.stringify(occurrence);
}

export function operatorLevelFlagSubjectKey(value) {
  const occurrence = validateOperatorLevelFlagOccurrence(value);
  return JSON.stringify([
    occurrence.catalogEntryId,
    occurrence.seriesId,
    occurrence.ordinal,
    occurrence.levelSpecHash,
    occurrence.skinHash,
  ]);
}

export function buildOperatorLevelFlagRequest({ mutationId, intent, comment, occurrence }) {
  uuid(mutationId, 'mutationId');
  if (!INTENTS.has(intent)) fail('invalid_intent', 'intent is unsupported');
  printable(comment, 'comment');
  const exact = validateOperatorLevelFlagOccurrence(occurrence);
  return freeze({
    schema: 'catalog.operator-flag.request.v1',
    mutationId,
    intent,
    comment,
    flagSurface: exact.flagSurface,
    subject: {
      catalogEntryId: exact.catalogEntryId,
      seriesId: exact.seriesId,
      ordinal: exact.ordinal,
      levelSpecHash: exact.levelSpecHash,
      skinHash: exact.skinHash,
    },
    causal: {
      decisionId: exact.decisionId,
      contentImpressionId: exact.contentImpressionId,
      levelImpressionId: exact.levelImpressionId,
      runId: exact.runId,
    },
  });
}

export function validateOperatorLevelFlagResponse(value, request) {
  if (!exactKeys(value, [
    'schema', 'flagId', 'mutationId', 'requestHash', 'actorUserId', 'intent', 'comment',
    'flagSurface', 'subject', 'causal', 'createdAt', 'replayed',
  ]) || value.schema !== 'catalog.operator-flag.v1' || typeof value.replayed !== 'boolean') {
    fail('invalid_response', 'operator flag response has an unsupported shape');
  }
  uuid(value.flagId, 'flagId');
  hash(value.requestHash, 'requestHash');
  if (!Number.isInteger(value.actorUserId) || value.actorUserId < 1
    || value.mutationId !== request.mutationId || value.intent !== request.intent
    || value.comment !== request.comment || value.flagSurface !== request.flagSurface
    || JSON.stringify(value.subject) !== JSON.stringify(request.subject)
    || JSON.stringify(value.causal) !== JSON.stringify(request.causal)
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    fail('invalid_response', 'operator flag response differs from the submitted request');
  }
  return freeze(clone(value));
}

export function operatorLevelFlagErrorMessage(error) {
  const code = typeof error?.code === 'string' ? error.code : null;
  const status = Number.isInteger(error?.status) ? error.status : 0;
  if (code === 'request_timeout') return 'Сервер не ответил. Попробуйте ещё раз.';
  if (status === 0) return 'Нет соединения. Попробуйте ещё раз.';
  if (status === 404) return 'Пометка сейчас недоступна.';
  if (code === 'operator_level_flag_conflict') return 'Эта пометка уже связана с другим запросом.';
  if (code === 'operator_level_flag_cp_unconfirmed') return 'События уровня ещё синхронизируются. Попробуйте снова.';
  if (code === 'invalid_operator_level_flag') return 'Не удалось подтвердить точный уровень. Обновите ленту.';
  if (status >= 500) return 'Сервис пометок временно недоступен.';
  return 'Не удалось сохранить пометку.';
}

export function mountOperatorLevelFlagControl(host, options) {
  if (!(host instanceof HTMLElement)) fail('invalid_host', 'host must be an HTMLElement');
  const occurrence = validateOperatorLevelFlagOccurrence(options?.occurrence);
  if (typeof options?.submit !== 'function' || typeof options?.createMutationId !== 'function') {
    fail('invalid_options', 'submit and createMutationId are required');
  }

  const root = document.createElement('section');
  root.className = 'game__operator-flag';
  root.dataset.flagSurface = occurrence.flagSurface;
  root.setAttribute('aria-label', 'Пометка сгенерированного уровня');
  root.innerHTML = `
    <button class="game__operator-flag-open" type="button">Пометить</button>
    <form class="game__operator-flag-form" hidden>
      <label>Что сделать
        <select name="intent">
          <option value="edit_candidate">Доработать</option>
          <option value="delete_candidate">Кандидат на удаление</option>
        </select>
      </label>
      <label>Что не понравилось
        <textarea name="comment" rows="3" required></textarea>
      </label>
      <div class="game__operator-flag-actions">
        <button type="submit">Сохранить</button>
        <button type="button" data-action="cancel">Отмена</button>
      </div>
      <output class="game__operator-flag-status" aria-live="polite"></output>
    </form>`;
  host.appendChild(root);

  const open = root.querySelector('.game__operator-flag-open');
  const form = root.querySelector('.game__operator-flag-form');
  const intent = form.elements.namedItem('intent');
  const comment = form.elements.namedItem('comment');
  const submitButton = form.querySelector('button[type="submit"]');
  const cancelButton = form.querySelector('[data-action="cancel"]');
  const status = root.querySelector('.game__operator-flag-status');
  let pending = null;
  let inFlight = false;
  let destroyed = false;

  const initialDraft = options?.initialDraft;
  if (initialDraft !== undefined && initialDraft !== null) {
    if (!exactKeys(initialDraft, ['intent', 'comment', 'opened'])
      || !INTENTS.has(initialDraft.intent) || typeof initialDraft.comment !== 'string'
      || typeof initialDraft.opened !== 'boolean') {
      fail('invalid_options', 'initialDraft has an unsupported shape');
    }
    intent.value = initialDraft.intent;
    comment.value = initialDraft.comment;
    form.hidden = !initialDraft.opened;
    open.hidden = initialDraft.opened;
  }

  const invalidatePending = () => {
    if (inFlight) return;
    pending = null;
    status.textContent = '';
  };
  const stop = (event) => event.stopPropagation();
  root.addEventListener('pointerdown', stop);
  root.addEventListener('pointerup', stop);
  root.addEventListener('click', stop);
  intent.addEventListener('change', invalidatePending);
  comment.addEventListener('input', invalidatePending);
  open.addEventListener('click', () => {
    form.hidden = false;
    open.hidden = true;
    comment.focus();
  });
  cancelButton.addEventListener('click', () => {
    form.hidden = true;
    open.hidden = false;
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (inFlight || destroyed) return;
    try {
      pending ??= buildOperatorLevelFlagRequest({
        mutationId: options.createMutationId(),
        intent: intent.value,
        comment: comment.value,
        occurrence,
      });
    } catch (error) {
      status.textContent = error instanceof OperatorLevelFlagContractError
        ? 'Комментарий должен быть от 1 до 2000 печатных символов без пробелов по краям.'
        : 'Не удалось подготовить пометку.';
      return;
    }
    inFlight = true;
    submitButton.disabled = true;
    cancelButton.disabled = true;
    intent.disabled = true;
    comment.disabled = true;
    status.textContent = 'Сохраняю…';
    void Promise.resolve(options.submit(pending)).then(() => {
      if (destroyed) return;
      status.textContent = 'Пометка сохранена';
      form.querySelectorAll('select, textarea, button').forEach((element) => { element.disabled = true; });
    }).catch((error) => {
      if (destroyed) return;
      status.textContent = operatorLevelFlagErrorMessage(error);
      submitButton.disabled = false;
      cancelButton.disabled = false;
      intent.disabled = false;
      comment.disabled = false;
    }).finally(() => { inFlight = false; });
  });

  return Object.freeze({
    occurrenceKey: operatorLevelFlagOccurrenceKey(occurrence),
    subjectKey: operatorLevelFlagSubjectKey(occurrence),
    captureDraft() {
      // Submit freezes mutation id + occurrence in `pending`. Never turn that
      // immutable request back into an editable draft for a newer occurrence.
      if (destroyed || inFlight || pending) return null;
      return Object.freeze({
        intent: intent.value,
        comment: comment.value,
        opened: !form.hidden,
      });
    },
    destroy() {
      destroyed = true;
      root.remove();
    },
  });
}
