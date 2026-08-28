/**
 * Human labels for operator-only product surfaces.
 *
 * The backend publishes the same exact schema for authorized sessions.  This
 * local copy is the backward-compatible bootstrap vocabulary; one validator
 * and these presentation helpers are the only place machine lifecycle tokens
 * become operator copy.
 */

const exactKeys = (value, keys) => Boolean(value) && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const printable = (value) => typeof value === 'string' && value === value.trim()
  && value.length >= 1 && value.length <= 64
  && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);

const canonical = Object.freeze({
  schema: 'platform.operator-presentation-vocabulary.v1',
  audience: Object.freeze({
    labs: Object.freeze({ label: 'Только в Labs', icon: '◇', tone: 'gray' }),
    exactUser: Object.freeze({ label: 'Только мне', icon: '●', tone: 'blue' }),
    team: Object.freeze({ label: 'Команда тестирует', icon: '◆', tone: 'purple' }),
    public: Object.freeze({ label: 'Доступно всем', icon: '✓', tone: 'green' }),
  }),
  workState: Object.freeze({
    working: Object.freeze({ label: 'Дорабатывается', icon: '…', tone: 'amber' }),
    ready: Object.freeze({ label: 'Можно проверить', icon: '▶', tone: 'cyan' }),
    needsHelp: Object.freeze({ label: 'Нужна помощь', icon: '!', tone: 'red' }),
    previousStopped: Object.freeze({
      label: 'Предыдущая попытка остановилась', icon: '↪', tone: 'neutral',
    }),
  }),
});

const exactPresentation = (value, tones) => exactKeys(value, ['label', 'icon', 'tone'])
  && printable(value.label) && printable(value.icon) && tones.has(value.tone);

export function resolveOperatorPresentationVocabulary(value) {
  if (!exactKeys(value, ['schema', 'audience', 'workState'])
    || value.schema !== canonical.schema
    || !exactKeys(value.audience, ['labs', 'exactUser', 'team', 'public'])
    || !exactKeys(value.workState, ['working', 'ready', 'needsHelp', 'previousStopped'])) {
    return canonical;
  }
  const audienceTones = new Set(['gray', 'blue', 'purple', 'green']);
  const workTones = new Set(['amber', 'cyan', 'red', 'neutral']);
  if (!Object.values(value.audience).every((entry) => exactPresentation(entry, audienceTones))
    || !Object.values(value.workState).every((entry) => exactPresentation(entry, workTones))) {
    return canonical;
  }
  return Object.freeze({
    schema: value.schema,
    audience: Object.freeze(Object.fromEntries(Object.entries(value.audience)
      .map(([key, entry]) => [key, Object.freeze({ ...entry })]))),
    workState: Object.freeze(Object.fromEntries(Object.entries(value.workState)
      .map(([key, entry]) => [key, Object.freeze({ ...entry })]))),
  });
}

export function operatorAudiencePresentation(vocabulary, key) {
  const resolved = resolveOperatorPresentationVocabulary(vocabulary);
  return resolved.audience[key] || resolved.audience.labs;
}

export function operatorWorkStatePresentation(vocabulary, key) {
  const resolved = resolveOperatorPresentationVocabulary(vocabulary);
  return resolved.workState[key] || resolved.workState.previousStopped;
}

const detail = (presentation, summary) => {
  const clean = typeof summary === 'string' ? summary.trim() : '';
  return clean ? `${presentation.label}: ${clean}` : presentation.label;
};

/** One projection used by both the intake control and the dev-diff sheet. */
export function platformDevelopmentIntakePresentation(receipt, vocabulary) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (receipt.cancellation?.status === 'confirmed') return Object.freeze({ visible: false });

  const terminalReady = receipt.terminal?.status === 'READY_TO_PLAY';
  const terminalNeedsHelp = receipt.terminal?.status === 'NEEDS_HELP';
  const deliveryFailed = receipt.delivery?.status === 'failed_terminal';
  const cancellationFailed = receipt.cancellation?.status === 'failed_terminal';
  const cancelling = Boolean(receipt.cancellation) && !cancellationFailed;

  let key = 'working';
  let summary = 'Задача ждёт синхронизации.';
  let blocker = null;
  if (cancellationFailed) {
    key = 'needsHelp';
    summary = 'Не удалось завершить отмену.';
    blocker = `Код: ${receipt.cancellation.lastErrorCode || 'unknown'}`;
  } else if (cancelling) {
    summary = 'Отмена сохранена и синхронизируется.';
  } else if (terminalNeedsHelp) {
    key = 'needsHelp';
    summary = receipt.terminal.summary;
    blocker = receipt.terminal.blocker?.operatorAction || null;
  } else if (terminalReady) {
    key = 'ready';
    summary = receipt.terminal.summary;
  } else if (deliveryFailed) {
    key = 'needsHelp';
    summary = 'Синхронизация остановлена; изменения не опубликованы.';
    blocker = 'Нужна помощь с конфигурацией инженерного контура.';
  } else if (receipt.delivery?.status === 'confirmed') {
    summary = 'Инженерный тикет создан; изменения ещё не опубликованы.';
  }

  const presentation = operatorWorkStatePresentation(vocabulary, key);
  return Object.freeze({
    visible: true,
    state: key,
    label: presentation.label,
    icon: presentation.icon,
    tone: presentation.tone,
    detail: detail(presentation, summary),
    blocker,
  });
}
