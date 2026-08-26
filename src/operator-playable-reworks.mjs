import { observeOperatorFormViewport } from './operator-form-viewport.mjs';
import {
  prepareScreenshotFromFile,
  screenshotSelectionLabel,
  screenshotSelectionMarkup,
} from './operator-screenshot.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
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
const ESCALATION_ISSUE_STATUSES = new Set([
  'queued', 'send_started', 'outcome_unknown', 'retry_wait', 'confirmed', 'failed_terminal',
]);
const ESCALATION_ROUTING_STATUSES = new Set(['not_requested', 'pending', 'routed']);
const ESCALATION_DECISIONS = new Set(['pending', 'accepted', 'obsolete']);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISSUE_URL = /^https:\/\/github\.com\/Glera\/p4g-workspace-meta\/issues\/([1-9][0-9]*)$/;
const preservedInstruction = (value) => typeof value === 'string'
  && value.trim().length >= 1 && value.length <= 2_000
  && new TextEncoder().encode(value).length <= 8_000
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value);

export function isOperatorPlayableEscalation(value, requestId = undefined, requestHash = undefined) {
  if (!exactKeys(value, [
    'schema', 'requestId', 'requestHash', 'decision', 'actionable', 'allowedDecisions',
    'issue', 'routing', 'root', 'replayed',
  ]) || value.schema !== 'feed.playable-escalation.v1'
    || !UUID.test(value.requestId) || !HASH.test(value.requestHash)
    || (requestId !== undefined && value.requestId !== requestId)
    || (requestHash !== undefined && value.requestHash !== requestHash)
    || !ESCALATION_DECISIONS.has(value.decision)
    || typeof value.actionable !== 'boolean' || !Array.isArray(value.allowedDecisions)
    || typeof value.replayed !== 'boolean'
    || !exactKeys(value.issue, ['status', 'url', 'number'])
    || !ESCALATION_ISSUE_STATUSES.has(value.issue.status)
    || !exactKeys(value.routing, ['status', 'ticketDigest', 'boundAt'])
    || !ESCALATION_ROUTING_STATUSES.has(value.routing.status)
    || !exactKeys(value.root, ['administrativeClosure', 'state'])
    || !['open', 'closed'].includes(value.root.state)) return false;
  const issueConfirmed = value.issue.status === 'confirmed';
  const issueMatch = typeof value.issue.url === 'string' ? value.issue.url.match(ISSUE_URL) : null;
  if (issueConfirmed !== (issueMatch !== null
    && Number.isInteger(value.issue.number) && value.issue.number > 0
    && Number(issueMatch[1]) === value.issue.number)) return false;
  if (!issueConfirmed && (value.issue.url !== null || value.issue.number !== null)) return false;
  const allowed = value.allowedDecisions.join('\0');
  const expectedAllowed = value.actionable
    ? (issueConfirmed ? 'do\0obsolete' : 'obsolete')
    : '';
  if (allowed !== expectedAllowed
      || (value.actionable && value.decision !== 'pending')) return false;
  const routed = value.routing.status === 'routed';
  if (routed !== (HASH.test(value.routing.ticketDigest) && ISO_INSTANT.test(value.routing.boundAt))) return false;
  if (!routed && (value.routing.ticketDigest !== null || value.routing.boundAt !== null)) return false;
  const obsolete = value.decision === 'obsolete';
  if (obsolete) {
    if (value.root.state !== 'closed'
      || !exactKeys(value.root.administrativeClosure, ['kind', 'note', 'reason'])) return false;
    if (value.root.administrativeClosure.kind !== 'administrative'
      || value.root.administrativeClosure.reason !== 'obsolete'
      || !preservedInstruction(value.root.administrativeClosure.note)) return false;
  } else if (value.root.state !== 'open' || value.root.administrativeClosure !== null) return false;
  return true;
}

export function isOperatorPlayableReworkQueueItem(value, playableId = undefined) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && UUID.test(value.requestId)
    && HASH.test(value.requestHash)
    && ['open', 'claimed', 'closed'].includes(value.state)
    && SOURCE_ADAPTERS.has(value.sourceAdapter)
    && QUEUE_DISPOSITIONS.has(value.queueDisposition)
    && typeof value.batchPresent === 'boolean'
    && (value.operatorPresentation === undefined
      || ((exactKeys(value.operatorPresentation, ['kind', 'effectDelivered'])
        || exactKeys(value.operatorPresentation, ['kind', 'effectDelivered', 'escalation']))
        && ['current', 'superseded', 'capability_gap_root', 'capability_gap_root_covered']
          .includes(value.operatorPresentation.kind)
        && typeof value.operatorPresentation.effectDelivered === 'boolean'
        && (value.operatorPresentation.escalation === undefined
          || (['capability_gap_root', 'capability_gap_root_covered']
            .includes(value.operatorPresentation.kind)
            && isOperatorPlayableEscalation(
              value.operatorPresentation.escalation, value.requestId, value.requestHash,
            )))))
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
  const presentations = items.map((item) => operatorPlayableReworkPresentation(item));
  const actionable = items.filter((_item, index) => ![
    'superseded', 'capability_gap_root_covered', 'ready_for_approval', 'obsolete',
  ].includes(presentations[index].state));
  const locallyActive = actionable.filter((item) => item?.queueDisposition === 'active_batch').length;
  const hasBatch = locallyActive > 0 || actionable.some((item) => item?.batchPresent === true);
  // The list items are the projection rendered below. Server aggregate counts
  // can lag one mutation behind; using them here would leave the badge saying
  // “В работе · ещё 1” after that exact queued row was made obsolete.
  const active = hasBatch ? locallyActive : 0;
  const queued = actionable.filter((item) => item?.queueDisposition === 'queued').length;
  const duplicates = actionable.filter((item) => item?.queueDisposition === 'duplicate_of').length;
  const ready = presentations.some((item) => item.state === 'ready_for_approval');
  if (ready && actionable.length === 0) return Object.freeze({
    state: 'ready_for_approval', label: 'Готово к проверке',
    active: 0, queued, duplicates, unresolved: actionable.length,
  });
  const needsHelp = actionable.some((item) => [
    'needs_help', 'blocked', 'capability_gap_root',
  ].includes(operatorPlayableReworkPresentation(item).state));
  if (needsHelp) return Object.freeze({
    state: 'needs_help', label: 'Нужна помощь · добавить замечание',
    active, queued, duplicates, unresolved: actionable.length,
  });
  if (hasBatch && queued > 0) return Object.freeze({
    state: 'queued', label: `В работе · ещё ${queued}`,
    active, queued, duplicates, unresolved: actionable.length,
  });
  if (hasBatch) return Object.freeze({
    state: 'active', label: 'В работе · добавить замечание',
    active, queued, duplicates, unresolved: actionable.length,
  });
  if (items.length > 0 && actionable.length === 0) return Object.freeze({
    state: 'history', label: 'История правок',
    active: 0, queued: 0, duplicates: 0, unresolved: 0,
  });
  return Object.freeze({
    state: 'idle', label: '✎ Доработать механику',
    active, queued, duplicates, unresolved: actionable.length,
  });
}

export function operatorPlayableReworkControlKey(occurrence, queue = []) {
  const queueKey = (Array.isArray(queue) ? queue : []).map((item) => [
    item.requestId, item.state, item.queueDisposition, item.batchPresent,
    item.queueCounts?.active, item.queueCounts?.queued,
    item.execution?.state, item.execution?.updatedAt,
    item.releaseExecution?.state, item.releaseExecution?.updatedAt,
    item.operatorPresentation?.kind, item.operatorPresentation?.effectDelivered,
    item.operatorPresentation?.escalation?.decision,
    item.operatorPresentation?.escalation?.actionable,
    item.operatorPresentation?.escalation?.issue?.status,
    item.operatorPresentation?.escalation?.issue?.number,
    item.operatorPresentation?.escalation?.routing?.status,
  ].join(':')).join('|');
  return `${occurrence.playableId}:${occurrence.mappingId}:${occurrence.rosterActivationId}:${occurrence.runtime.artifactDigest}:${queueKey}`;
}

export function operatorPlayableReworkPresentation(task) {
  const presentation = task?.operatorPresentation;
  if (presentation?.kind === 'superseded') {
    return Object.freeze({
      state: 'superseded', icon: '↪', label: 'Заменена следующей правкой', blocker: null,
    });
  }
  if (presentation?.kind === 'capability_gap_root_covered') {
    return Object.freeze({
      state: 'capability_gap_root_covered', icon: '↪',
      label: 'Историческая заявка · выполнена successor', blocker: null,
    });
  }
  if (presentation?.kind === 'capability_gap_root') {
    if (presentation.escalation?.decision === 'accepted') {
      if (['outcome_unknown', 'failed_terminal'].includes(presentation.escalation.issue.status)) {
        return Object.freeze({
          state: 'needs_help', icon: '!', label: 'Не удалось передать в разработку',
          blocker: 'Инженерный тикет не подтверждён. Нужна помощь.',
        });
      }
      if (presentation.escalation.issue.status !== 'confirmed') {
        return Object.freeze({
          state: 'preparing', icon: '…', label: 'Создаётся инженерный тикет', blocker: null,
        });
      }
      if (presentation.escalation.routing.status !== 'routed') {
        return Object.freeze({
          state: 'preparing', icon: '…', label: 'Тикет создан · передаётся Mac B', blocker: null,
        });
      }
      return Object.freeze({
        state: 'escalated_to_mac_b', icon: '…', label: 'Передано Mac B', blocker: null,
      });
    }
    if (presentation.escalation?.decision === 'obsolete') {
      return Object.freeze({
        state: 'obsolete', icon: '↪', label: 'Неактуально', blocker: null,
      });
    }
    return Object.freeze({
      state: 'capability_gap_root', icon: '!',
      label: presentation.escalation ? 'Нужна обычная разработка' : 'Ждёт capability successor',
      blocker: task?.execution?.summary || 'Эта историческая заявка не исполняется напрямую.',
    });
  }
  if (presentation?.effectDelivered === true) {
    return Object.freeze({
      state: 'ready_for_approval', icon: '!', label: 'Готово к проверке', blocker: null,
    });
  }
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
    || (options.escalate != null && typeof options.escalate !== 'function')
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
  // Same bar-anchored composition as the platform intake: the keyboard must
  // never push the field being typed into off the screen.
  const formViewport = observeOperatorFormViewport(form);
  const renderQueueSummary = () => {
    const presentation = operatorPlayableReworkQueuePresentation(queue);
    root.dataset.reworkState = presentation.state;
    open.dataset.reworkState = presentation.state;
    open.setAttribute('aria-label', presentation.label);
    open.title = presentation.label;
    countBadge.textContent = String(presentation.unresolved);
    countBadge.hidden = presentation.unresolved === 0;
    summary.textContent = presentation.label;
    counts.textContent = [
      presentation.active ? `активно ${presentation.active}` : '',
      presentation.queued ? `в очереди ${presentation.queued}` : '',
      presentation.duplicates ? `возможных дублей ${presentation.duplicates}` : '',
    ].filter(Boolean).join(' · ') || 'Новых замечаний пока нет';
  };
  renderQueueSummary();
  const dispositionLabels = {
    active_batch: 'В работе', queued: 'В очереди',
    duplicate_of: 'Возможный дубль', closed: 'Завершено',
  };
  const sourceLabels = { telegram: 'Telegram', codex: 'Codex' };
  let destroyed = false;
  let submitting = false;
  let escalationSubmitting = false;
  let pendingRequest = null;
  for (const task of queue) {
    const escalationMutationIds = new Map();
    const article = document.createElement('article');
    article.className = 'game__operator-playable-rework-item';
    article.dataset.queueDisposition = task.queueDisposition;
    const itemHeading = document.createElement('div');
    itemHeading.className = 'game__operator-playable-rework-item-heading';
    const lifecycle = operatorPlayableReworkPresentation(task);
    const itemState = document.createElement('b');
    itemState.textContent = [
      'superseded', 'capability_gap_root', 'capability_gap_root_covered',
      'ready_for_approval', 'escalated_to_mac_b', 'obsolete',
    ].includes(lifecycle.state)
      ? lifecycle.label
      : dispositionLabels[task.queueDisposition];
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
    const escalation = task.operatorPresentation?.escalation;
    if (escalation?.issue?.url) {
      const issueLink = document.createElement('a');
      issueLink.className = 'game__operator-playable-rework-escalation-issue';
      issueLink.href = escalation.issue.url;
      issueLink.target = '_blank';
      issueLink.rel = 'noreferrer noopener';
      issueLink.textContent = `Тикет #${escalation.issue.number}`;
      article.append(issueLink);
    }
    if (lifecycle.state === 'capability_gap_root' && escalation?.actionable === true
      && typeof options.escalate === 'function') {
      const escalationActions = document.createElement('div');
      escalationActions.className = 'game__operator-playable-rework-escalation-actions';
      const canDo = escalation.allowedDecisions.includes('do');
      const canObsolete = escalation.allowedDecisions.includes('obsolete');
      const doButton = canDo ? document.createElement('button') : null;
      if (doButton) {
        doButton.type = 'button';
        doButton.dataset.action = 'escalate-rework';
        doButton.textContent = 'Делать (~день Mac B)';
      }
      const obsoleteButton = canObsolete ? document.createElement('button') : null;
      if (obsoleteButton) {
        obsoleteButton.type = 'button';
        obsoleteButton.dataset.action = 'obsolete-escalation';
        obsoleteButton.textContent = 'Неактуально';
      }
      const escalationStatus = document.createElement('small');
      escalationStatus.dataset.escalationStatus = '';
      escalationStatus.setAttribute('aria-live', 'polite');
      const act = async (decision) => {
        const selectedButton = decision === 'do' ? doButton : obsoleteButton;
        if (destroyed || escalationSubmitting
          || selectedButton === null || selectedButton.disabled) return;
        escalationSubmitting = true;
        if (doButton) doButton.disabled = true;
        if (obsoleteButton) obsoleteButton.disabled = true;
        escalationStatus.textContent = decision === 'do' ? 'Передаю Mac B…' : 'Закрываю…';
        try {
          if (!escalationMutationIds.has(decision)) {
            escalationMutationIds.set(decision, options.createMutationId());
          }
          const receipt = await options.escalate(
            task, decision, escalationMutationIds.get(decision),
          );
          if (destroyed) return;
          if (!isOperatorPlayableEscalation(receipt, task.requestId, task.requestHash)
            || receipt.decision !== (decision === 'do' ? 'accepted' : 'obsolete')
            || receipt.actionable
            || (decision === 'obsolete' && (receipt.root.state !== 'closed'
              || receipt.root.administrativeClosure?.reason !== 'obsolete'))) {
            fail('playable_escalation_invalid', 'escalation receipt differs');
          }
          task.operatorPresentation.escalation = receipt;
          escalationActions.remove();
          article.querySelector('.game__operator-playable-rework-blocker')?.remove();
          if (decision === 'obsolete') {
            itemState.textContent = 'Неактуально';
            article.dataset.queueDisposition = 'closed';
            const queueIndex = queue.indexOf(task);
            if (queueIndex >= 0) queue.splice(queueIndex, 1);
          } else {
            itemState.textContent = operatorPlayableReworkPresentation(task).label;
          }
          renderQueueSummary();
          queueMicrotask(() => { if (!destroyed) void options.refresh?.(); });
        } catch (error) {
          if (destroyed) return;
          escalationStatus.textContent = error?.code === 'request_timeout'
            ? 'Сервер не ответил вовремя. Повторите то же действие.'
            : error?.status === 0
              ? 'Нет связи с сервером. Повторите то же действие.'
              : 'Решение не сохранено. Обновите список и повторите.';
          const ambiguous = error?.code === 'request_timeout' || error?.status === 0;
          if (doButton) doButton.disabled = ambiguous ? decision !== 'do' : false;
          if (obsoleteButton) {
            obsoleteButton.disabled = ambiguous ? decision !== 'obsolete' : false;
          }
        } finally {
          escalationSubmitting = false;
        }
      };
      doButton?.addEventListener('click', () => void act('do'));
      obsoleteButton?.addEventListener('click', () => void act('obsolete'));
      escalationActions.append(...[doButton, obsoleteButton, escalationStatus].filter(Boolean));
      article.append(escalationActions);
    }
    if (task.state === 'open' && task.releaseId == null
      && !['superseded', 'capability_gap_root', 'capability_gap_root_covered', 'ready_for_approval']
        .includes(lifecycle.state)
      && typeof options.cancel === 'function') {
      const obsolete = document.createElement('button');
      obsolete.type = 'button';
      obsolete.className = 'game__operator-playable-rework-obsolete';
      obsolete.dataset.action = 'obsolete-rework';
      obsolete.textContent = 'Неактуально';
      obsolete.addEventListener('click', async () => {
        if (obsolete.disabled) return;
        obsolete.disabled = true;
        itemState.textContent = 'Отменяю…';
        try {
          await options.cancel(task);
          itemState.textContent = 'Неактуально';
          article.dataset.queueDisposition = 'closed';
          obsolete.remove();
          const queueIndex = queue.indexOf(task);
          if (queueIndex >= 0) queue.splice(queueIndex, 1);
          renderQueueSummary();
        } catch {
          itemState.textContent = dispositionLabels[task.queueDisposition];
          obsolete.disabled = false;
        }
      });
      article.append(obsolete);
    }
    list.append(article);
  }
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
    busy() { return submitting || escalationSubmitting; },
    destroy() { destroyed = true; formViewport.release(); root.remove(); },
  });
}
