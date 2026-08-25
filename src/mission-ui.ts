/**
 * Mission slice v0 — the DOM half.
 *
 * Every builder here is a pure function of already-parsed server data plus
 * callbacks: it reads no globals, issues no request and owns no state. That is
 * what lets the whole surface be mounted, re-rendered and torn down from
 * `mission.ts` without `feed.ts` learning any mission markup.
 *
 * Values are written with `textContent`, never interpolated into `innerHTML`,
 * so operator-authored contract text (recipient, deliverable, transfer
 * reference) can never become markup.
 */
import {
  formatMissionMoney,
  missionBarPercent,
  missionCaseSubtitle,
  missionCaseTitle,
  missionSourceLabel,
  type MissionCaseContract,
  type MissionCaseEvent,
  type MissionCaseView,
  type MissionContributionReceipt,
  type MissionHistoryEntry,
} from './mission-core.mjs';

/** Paw glyph in the style of the existing HUD badges: one inline path, no asset. */
export const MISSION_PAW_SVG =
  '<svg class="mission-paw" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
  + '<ellipse cx="5.9" cy="10.1" rx="2.3" ry="3"/>'
  + '<ellipse cx="10.4" cy="6.5" rx="2.4" ry="3.2"/>'
  + '<ellipse cx="15.8" cy="7.2" rx="2.3" ry="3"/>'
  + '<ellipse cx="20.1" cy="11.4" rx="2" ry="2.6"/>'
  + '<path d="M12.4 12.1c2.9 0 5.5 2 6.3 4.4.9 2.5-.8 4.6-3.4 4.6-1.4 0-2-.5-2.9-.5-1 0-1.6.5-3 .5-2.6 0-4.3-2.1-3.4-4.6.8-2.4 3.5-4.4 6.4-4.4z"/>'
  + '</svg>';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stopFeedGestures(node: HTMLElement): void {
  for (const type of ['pointerdown', 'pointerup', 'click'] as const) {
    node.addEventListener(type, (event) => event.stopPropagation());
  }
}

function progressTrack(className: string, percent: number): HTMLElement {
  const track = el('div', className);
  const fill = document.createElement('i');
  fill.style.width = `${percent}%`;
  track.appendChild(fill);
  return track;
}

// ── HUD ─────────────────────────────────────────────────────────────────────
export interface MissionHudState {
  progress: number;
  tokenGoal: number;
  nextStepThreshold: number | null;
}

/** Static iteration-5 season bar. Its case and contract doors are sibling
 * buttons: the small info target stays independently focusable and never nests
 * one interactive role inside another. */
export function buildMissionHudBar(
  onOpen: () => void,
  onOpenContract: () => void,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'hud__mission';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'hud__mission-open';
  open.setAttribute('aria-label', 'Кейс миссии');
  const gift = el('span', 'hud__mission-gift', '🎁');
  gift.setAttribute('aria-hidden', 'true');
  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'hud__mission-info';
  info.textContent = 'ⓘ';
  info.setAttribute('aria-label', 'Полный контракт и материалы');
  for (const type of ['pointerdown', 'pointerup', 'click'] as const) {
    info.addEventListener(type, (event) => event.stopPropagation());
  }
  info.addEventListener('click', onOpenContract);
  const coin = el('span', 'hud__mission-coin');
  coin.innerHTML = MISSION_PAW_SVG;
  open.append(coin, progressTrack('hud__mission-track', 0), gift);
  open.appendChild(el('span', 'hud__mission-count', '0 / 0'));
  for (const type of ['pointerdown', 'pointerup'] as const) {
    open.addEventListener(type, (event) => event.stopPropagation());
  }
  open.addEventListener('click', (event) => {
    event.stopPropagation();
    onOpen();
  });
  bar.append(open, info);
  return bar;
}

export function updateMissionHudBar(bar: HTMLElement, state: MissionHudState): void {
  const count = bar.querySelector<HTMLElement>('.hud__mission-count');
  const fill = bar.querySelector<HTMLElement>('.hud__mission-track i');
  const target = state.nextStepThreshold ?? state.tokenGoal;
  if (count) count.textContent = `${state.progress} / ${target}`;
  if (fill) fill.style.width = `${missionBarPercent(state.progress, target)}%`;
}

// ── contribution ceremony ───────────────────────────────────────────────────
/** Own reward: one paw coin flies from the committed reward to the season bar.
 * No own-contribution toast or card is created. */
export function launchMissionPawFlight(
  receipt: MissionContributionReceipt,
  origin: HTMLElement,
  target: HTMLElement,
  viewport: HTMLElement,
): HTMLElement {
  const viewportRect = viewport.getBoundingClientRect();
  const from = origin.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const coin = el('span', 'mission-paw-flight');
  coin.innerHTML = MISSION_PAW_SVG;
  coin.setAttribute('role', 'status');
  coin.setAttribute('aria-live', 'polite');
  coin.setAttribute('aria-label', `+${receipt.amount} лапок в общий сезон`);
  coin.style.left = `${from.left - viewportRect.left + from.width / 2}px`;
  coin.style.top = `${from.top - viewportRect.top + from.height / 2}px`;
  viewport.appendChild(coin);
  const dx = to.left - from.left + (to.width - from.width) / 2;
  const dy = to.top - from.top + (to.height - from.height) / 2;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const duration = reducedMotion ? 1 : 720;
  const animation = coin.animate?.(
    [
      { transform: 'translate(-50%, -50%) scale(.72)', opacity: 0 },
      { transform: 'translate(-50%, -70%) scale(1.08)', opacity: 1, offset: .18 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(.58)`, opacity: 1 },
    ],
    { duration, easing: 'cubic-bezier(.22,.8,.28,1)', fill: 'forwards' },
  );
  const settle = (): void => {
    coin.remove();
    if (receipt.openedGiftSteps.length === 0) return;
    const gift = target.querySelector<HTMLElement>('.hud__mission-gift');
    gift?.classList.add('hud__mission-gift--bounce');
    window.setTimeout(() => gift?.classList.remove('hud__mission-gift--bounce'), reducedMotion ? 1 : 520);
  };
  if (animation) animation.addEventListener('finish', settle, { once: true });
  else window.setTimeout(settle, duration);
  return coin;
}

// ── UNLOCKED / FULFILLED ceremonies ─────────────────────────────────────────
function ceremonyShell(onClose: () => void): {
  root: HTMLElement;
  body: HTMLElement;
  actions: HTMLElement;
} {
  const root = el('div', 'mission-ceremony');
  const card = el('div', 'mission-ceremony__card');
  const body = el('div', 'mission-ceremony__body');
  const actions = el('div', 'mission-ceremony__actions');
  card.append(body, actions);
  root.appendChild(card);
  stopFeedGestures(root);
  root.addEventListener('click', (event) => {
    if (event.target === root) onClose();
  });
  return { root, body, actions };
}

function receiptInt(receipt: Record<string, unknown>, key: string): number {
  const value = receipt[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function receiptText(receipt: Record<string, unknown>, key: string): string {
  const value = receipt[key];
  return typeof value === 'string' ? value : '';
}

function formatPawCount(value: number): string {
  const count = Math.max(0, Math.trunc(value));
  const mod100 = count % 100;
  const mod10 = count % 10;
  const noun = mod100 >= 11 && mod100 <= 14
    ? 'лапок'
    : mod10 === 1
      ? 'лапка'
      : mod10 >= 2 && mod10 <= 4
        ? 'лапки'
        : 'лапок';
  return `${new Intl.NumberFormat('ru-RU').format(count)} ${noun}`;
}

export function buildMissionUnlockedCeremony(options: {
  event: MissionCaseEvent;
  currency: string;
  onClose: () => void;
}): HTMLElement {
  const { root, body, actions } = ceremonyShell(options.onClose);
  root.classList.add('mission-ceremony--unlocked');
  const payload = options.event.receipt;
  body.append(el('div', 'mission-ceremony__moment', 'сразу · подарок открыт'));
  body.append(el(
    'div',
    'mission-ceremony__title',
    `Приют получает ${formatMissionMoney(receiptInt(payload, 'giftTotalCents'), options.currency)}`,
  ));
  const paws = el('div', 'mission-ceremony__paws');
  paws.innerHTML = MISSION_PAW_SVG;
  paws.appendChild(el('strong', '', formatPawCount(receiptInt(payload, 'progress'))));
  body.appendChild(paws);
  const guaranteed = receiptInt(payload, 'guaranteedCents');
  const giftTotal = receiptInt(payload, 'giftTotalCents');
  const community = Math.max(0, giftTotal - guaranteed);
  const sums = el('div', 'mission-ceremony__sums');
  sums.append(
    el(
      'span',
      'mission-ceremony__breakdown',
      `${formatMissionMoney(guaranteed, options.currency)} — гарантия платформы`,
    ),
    el(
      'span',
      'mission-ceremony__breakdown',
      `${formatMissionMoney(community, options.currency)} — собрало сообщество`,
    ),
  );
  const released = receiptInt(payload, 'releasedUnopenedCents');
  if (released > 0) {
    sums.appendChild(el(
      'span',
      'mission-ceremony__released',
      `${formatMissionMoney(released, options.currency)} нераскрытого резерва вернулось в общий пул`,
    ));
  }
  body.append(sums);
  const button = el('button', 'mission-ceremony__btn', 'Ура!');
  (button as HTMLButtonElement).type = 'button';
  button.addEventListener('click', options.onClose);
  actions.appendChild(button);
  return root;
}

/** «Корм передан» — the transfer receipt, a photo placeholder, and the archive line. */
export function buildMissionFulfilledCeremony(options: {
  event: MissionCaseEvent;
  currency: string;
  onClose: () => void;
}): HTMLElement {
  const { root, body, actions } = ceremonyShell(options.onClose);
  root.classList.add('mission-ceremony--fulfilled');
  const transfer = options.event.transferReceipt ?? {};
  const photo = el('div', 'mission-photo mission-photo--ceremony');
  photo.innerHTML = MISSION_PAW_SVG;
  photo.append(el('span', 'mission-photo__hint', 'Фото отчёта приюта'));
  body.append(photo);
  body.append(el('div', 'mission-ceremony__title', 'Корм передан'));
  const amount = receiptInt(transfer, 'amountCents');
  const currency = receiptText(transfer, 'currency') || options.currency;
  const details = [
    amount > 0 ? formatMissionMoney(amount, currency) : '',
    receiptText(transfer, 'transferDate'),
    receiptText(transfer, 'recipient'),
  ].filter(Boolean).join(' · ');
  if (details) body.append(el('div', 'mission-ceremony__sub', details));
  const button = el('button', 'mission-ceremony__btn', 'Спасибо');
  (button as HTMLButtonElement).type = 'button';
  button.addEventListener('click', options.onClose);
  actions.appendChild(button);
  return root;
}

// ── case screen ─────────────────────────────────────────────────────────────
function tile(label: string, value: string, detail?: string): HTMLElement {
  const node = el('div', 'mission-tile');
  node.append(el('span', 'mission-tile__label', label), el('strong', 'mission-tile__value', value));
  if (detail) node.append(el('span', 'mission-tile__detail', detail));
  return node;
}

function definition(list: HTMLElement, term: string, value: unknown): void {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number'
      ? String(value)
      : Array.isArray(value)
        ? value.filter((item) => typeof item === 'string').join(', ')
        : '';
  if (!text) return;
  const row = el('div', 'mission-def');
  row.append(el('span', 'mission-def__term', term), el('span', 'mission-def__value', text));
  list.appendChild(row);
}

/**
 * `mission.funding-policy.v1` is a CLOSED, executable contract: every
 * money-bearing field is an enum with exactly one legal value, naming the one
 * behaviour the runtime implements. So one tap shows the enum ITSELF and adds
 * what it means — never a friendly sentence in place of the wire value, which is
 * how a reader could be told one thing while the runtime does another.
 */
const POLICY_LABELS: Record<string, string> = {
  currency: 'Валюта',
  rounding: 'Округление',
  giftFormula: 'Формула подарка',
  stepRule: 'Правило ступеней',
  snapshotRule: 'Правило снимка пула',
  poolConsumption: 'Расходование пула',
  eligiblePool: 'Источники пула',
};

const POLICY_ENUM_MEANINGS: Record<string, string> = {
  'declared-cents': 'все суммы заранее объявлены целыми центами',
  'guaranteed-plus-opened-steps-v1': 'гарантия плюс только открытые ступени',
  'prefunded-reserved-at-ready-open-once-v1':
    'вся лестница обеспечена до старта; каждая ступень открывается один раз',
  'ledger-seq-alloc-cutoff-v1': 'снимок пула по паре (ledger seq, alloc cutoff) под runtime-локом',
  'eligible-ledger-fifo-by-seq-v1': 'FIFO по seq и только из разрешённых источников',
};

const POOL_SOURCE_LABELS: Record<string, string> = {
  seed: 'посев',
  revenue_share: 'доля выручки',
  partner: 'партнёр',
  subscription_share: 'доля подписки',
};

/** Curated order for the fields v1 defines; anything the wire adds later follows,
 *  sorted — visible rather than silently dropped. */
const POLICY_FIELD_ORDER = [
  'currency', 'rounding', 'giftFormula', 'stepRule',
  'snapshotRule', 'poolConsumption', 'eligiblePool',
];

function poolSourceText(source: unknown): string {
  const raw = String(source);
  const label = POOL_SOURCE_LABELS[raw];
  return label ? `${label} (${raw})` : raw;
}

/** The exact wire value, plus its meaning when this build knows it. An enum this
 *  build has never seen is shown raw: an unrecognised money rule is precisely
 *  what the reader most needs to see, not what it should hide. */
function policyValueText(value: unknown): string {
  if (typeof value === 'string') {
    const meaning = POLICY_ENUM_MEANINGS[value];
    return meaning ? `${value} — ${meaning}` : value;
  }
  if (Array.isArray(value)) return value.map(poolSourceText).join(', ');
  if (value && typeof value === 'object') {
    const sources = (value as { sources?: unknown }).sources;
    if (Array.isArray(sources)) return sources.map(poolSourceText).join(', ');
    return JSON.stringify(value);
  }
  return value === null || value === undefined ? '—' : String(value);
}

/**
 * Driven by the DOCUMENT's own keys, never by a hand-written list. A hand-written
 * list is exactly what let this view fall behind the closed-schema change in
 * silence: `giftFormula` became a string, the code kept reading `.expression` off
 * it, and two money rules simply stopped being displayed. Now a key the backend
 * adds appears (raw), a key it removes disappears, and either way the browser
 * check's key-set assertion fails instead of the screen quietly omitting a rule.
 */
function policySection(policy: MissionCaseContract['fundingPolicy']): HTMLElement {
  const doc = policy.document as Record<string, unknown>;
  const keys = Object.keys(doc).filter((key) => key !== 'schema');
  const ordered = [
    ...POLICY_FIELD_ORDER.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !POLICY_FIELD_ORDER.includes(key)).sort(),
  ];
  const list = el('div', 'mission-defs mission-policy');
  const heading = policy.version
    ? `Политика финансирования · ${policy.version} · ${policy.digest.slice(0, 12)}`
    : 'Политика финансирования';
  list.appendChild(el('div', 'mission-defs__head', heading));
  for (const key of ordered) {
    const row = el('div', 'mission-def');
    row.dataset.policyKey = key;
    row.append(
      el('span', 'mission-def__term', POLICY_LABELS[key] ?? key),
      el('span', 'mission-def__value', policyValueText(doc[key])),
    );
    list.appendChild(row);
  }
  return list;
}

/** The full public contract, one tap away: the case document AND its resolved
 *  funding policy — every money-bearing field of the executable policy, with the
 *  raw pinned documents underneath for anyone who wants the bytes. */
function contractSection(view: MissionCaseView): HTMLElement {
  const wrap = el('section', 'mission-contract');
  const summary = document.createElement('button');
  summary.type = 'button';
  summary.className = 'mission-contract__summary';
  summary.textContent = 'ⓘ Полный контракт и материалы';
  wrap.appendChild(summary);
  const sheet = el('div', 'mission-contract-sheet');
  sheet.hidden = true;
  sheet.tabIndex = -1;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-labelledby', 'mission-contract-sheet-title');
  const close = el('button', 'mission-contract-sheet__close', '×');
  (close as HTMLButtonElement).type = 'button';
  close.setAttribute('aria-label', 'Закрыть контракт');
  const hideSheet = (): void => {
    sheet.hidden = true;
    summary.focus();
  };
  summary.addEventListener('click', () => {
    sheet.hidden = false;
    sheet.focus();
  });
  close.addEventListener('click', hideSheet);
  sheet.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      hideSheet();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(sheet.querySelectorAll<HTMLElement>(
      'button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  const title = el('h2', 'mission-contract-sheet__title', 'Полный контракт и материалы');
  title.id = 'mission-contract-sheet-title';
  sheet.append(close, title);
  wrap.appendChild(sheet);
  const contract = view.activeCase?.contract;
  if (!contract) {
    sheet.appendChild(el('div', 'mission-contract__empty', 'Контракт недоступен'));
    return wrap;
  }
  const doc = contract.document;
  const list = el('div', 'mission-defs');
  definition(list, 'Получатель', doc.recipient);
  definition(list, 'Гарантировано', doc.guaranteedDeliverable);
  definition(list, 'Сверх плана', doc.stretchDeliverables);
  definition(list, 'Остаток', doc.rolloverRule);
  definition(list, 'Подтверждение', doc.confirmationKind);
  // Executable since the backend's cutoff fix: UNLOCK is refused before this
  // instant, so it is a promise the player can hold the platform to, not a note.
  definition(list, 'Раньше не разблокируется', doc.unlockCutoffAt);
  definition(list, 'Передать до', doc.latestFulfillmentAt);
  definition(list, 'Версия', `${contract.contractVersion} · ${contract.contractDigest.slice(0, 12)}`);
  sheet.appendChild(list);

  sheet.appendChild(policySection(contract.fundingPolicy));

  const raw = el('details', 'mission-contract__raw');
  const rawSummary = document.createElement('summary');
  rawSummary.textContent = 'Документы целиком';
  raw.appendChild(rawSummary);
  const pre = el('pre', 'mission-contract__json');
  pre.textContent = JSON.stringify(
    { contract: doc, fundingPolicy: contract.fundingPolicy.document },
    null,
    2,
  );
  raw.appendChild(pre);
  sheet.appendChild(raw);
  return wrap;
}

function historySection(history: readonly MissionHistoryEntry[]): HTMLElement {
  const section = el('section', 'mission-history');
  section.appendChild(el('div', 'mission-history__head', 'Мои последние вклады'));
  if (history.length === 0) {
    section.appendChild(el('div', 'mission-history__empty', 'Пока пусто — пройди серию или ежедневное задание'));
    return section;
  }
  for (const entry of history) {
    const row = el('div', 'mission-history__row');
    row.append(
      el('span', 'mission-history__source', missionSourceLabel(entry.source) || 'вклад'),
      el('span', 'mission-history__amount', `+${entry.amount}`),
    );
    section.appendChild(row);
  }
  return section;
}

/** The case screen behind the HUD bar. */
export function buildMissionCaseScreen(options: {
  view: MissionCaseView;
  history: readonly MissionHistoryEntry[];
  onClose: () => void;
}): HTMLElement {
  const { view, history } = options;
  const screen = el('div', 'mission-screen');
  stopFeedGestures(screen);
  const close = el('button', 'mission-screen__close', '×');
  (close as HTMLButtonElement).type = 'button';
  close.setAttribute('aria-label', 'Закрыть');
  close.addEventListener('click', options.onClose);
  screen.appendChild(close);

  const active = view.activeCase;
  if (!active) {
    screen.appendChild(el('div', 'mission-screen__empty', 'Активного кейса сейчас нет'));
    return screen;
  }
  const doc = active.contract?.document ?? {};
  const currency = active.money.currency;

  const heading = el('header', 'mission-screen__head');
  heading.append(el('h2', 'mission-screen__title', missionCaseTitle(doc)));
  const subtitle = missionCaseSubtitle(doc);
  if (subtitle) heading.append(el('div', 'mission-screen__sub', subtitle));
  screen.appendChild(heading);

  const meterTarget = active.bar.nextStepThreshold ?? active.bar.tokenGoal;
  const meter = el('section', 'mission-meter');
  meter.append(
    progressTrack('mission-meter__track', missionBarPercent(active.bar.progress, meterTarget)),
    el('div', 'mission-meter__count', `${active.bar.progress} / ${meterTarget} лапок сообщества`),
  );
  screen.appendChild(meter);

  const photo = el('div', 'mission-photo');
  photo.innerHTML = MISSION_PAW_SVG;
  photo.append(el('span', 'mission-photo__hint', 'Медиа кейса появятся здесь'));
  screen.appendChild(photo);

  const tiles = el('section', 'mission-tiles');
  tiles.append(
    tile('уже собрано', formatMissionMoney(active.money.collectedCents, currency)),
    tile('Мой вклад', formatPawCount(view.myContribution.caseTokens)),
  );
  screen.appendChild(tiles);

  const ladder = el('section', 'mission-ladder');
  ladder.appendChild(el('div', 'mission-ladder__head', '🎁 Подарки сезона'));
  for (const step of [...active.giftLadder].sort((left, right) => left.stepIndex - right.stepIndex)) {
    const row = el('div', `mission-ladder__step mission-ladder__step--${step.state}`);
    const icon = el(
      'span',
      'mission-ladder__icon',
      step.state === 'guaranteed' ? '✓' : step.state === 'opened' ? '🎁' : '🔒',
    );
    icon.setAttribute('aria-hidden', 'true');
    const copy = el('span', 'mission-ladder__copy');
    copy.append(
      el('strong', 'mission-ladder__amount', formatMissionMoney(step.amountCents, currency)),
      el(
        'span',
        'mission-ladder__threshold',
        step.stepIndex === 0
          ? 'гарантированный подарок'
          : `за ${formatPawCount(step.thresholdTokens)} сообщества`,
      ),
    );
    if (step.state === 'reserved' && step.thresholdTokens === meterTarget) {
      copy.appendChild(progressTrack(
        'mission-ladder__track',
        missionBarPercent(active.bar.progress, step.thresholdTokens),
      ));
    }
    const state = el(
      'span',
      'mission-ladder__state',
      step.state === 'guaranteed' || step.state === 'opened' ? 'открыт' : 'впереди',
    );
    row.append(
      icon,
      copy,
      state,
    );
    ladder.appendChild(row);
  }
  screen.appendChild(ladder);

  screen.appendChild(contractSection(view));
  screen.appendChild(historySection(history));
  return screen;
}
