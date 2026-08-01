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
  missionOpenedByPlayCents,
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
  title: string;
  progress: number;
  tokenGoal: number;
  myTokens: number;
}

/** The case bar: name, `N / goal`, and a thin track. Centre of the single HUD row. */
export function buildMissionHudBar(onOpen: () => void): HTMLButtonElement {
  const bar = document.createElement('button');
  bar.type = 'button';
  bar.className = 'hud__mission';
  bar.setAttribute('aria-label', 'Кейс миссии');
  bar.append(
    el('span', 'hud__mission-title', '—'),
    el('span', 'hud__mission-count', '0 / 0'),
    progressTrack('hud__mission-track', 0),
  );
  // The bar lives inside the stories scroller, whose drag handler listens on the
  // rail: a tap on the bar must open the case, not fling the rail.
  bar.addEventListener('pointerdown', (event) => event.stopPropagation());
  bar.addEventListener('pointerup', (event) => event.stopPropagation());
  bar.addEventListener('click', (event) => {
    event.stopPropagation();
    onOpen();
  });
  return bar;
}

export function updateMissionHudBar(bar: HTMLElement, state: MissionHudState): void {
  const title = bar.querySelector<HTMLElement>('.hud__mission-title');
  const count = bar.querySelector<HTMLElement>('.hud__mission-count');
  const fill = bar.querySelector<HTMLElement>('.hud__mission-track i');
  if (title) title.textContent = state.title;
  if (count) count.textContent = `${state.progress} / ${state.tokenGoal}`;
  if (fill) fill.style.width = `${missionBarPercent(state.progress, state.tokenGoal)}%`;
}

/** The only badge attribute the mission mutates, remembered per element. */
const BADGE_LABELS = new WeakMap<HTMLElement, string | null>();

/**
 * Retheme the puzzle badge into the paw badge — ADDITIVELY.
 *
 * The pre-mission children are never removed or rebuilt: `data-mission` makes
 * CSS hide them, and the paw is a sibling. That matters twice. The capability
 * can be revoked by the very next `/session`, and a teardown that had to
 * reconstruct markup could only ever restore a copy; here the original nodes
 * were never detached, so the restore is exact by construction. And `feed.ts`
 * holds a live reference to `.hud__puzzles-value` — replacing it would leave
 * that reference pointing at a detached node, freezing the puzzle counter after
 * a revoke. The puzzle balance keeps being counted and painted; it only leaves
 * the SURFACE, which is what the operator decision asked for.
 */
export function applyMissionPawBadge(badge: HTMLElement, myTokens: number): void {
  if (badge.querySelector('.hud__mission-paw')) {
    updateMissionPawBadge(badge, myTokens);
    return;
  }
  if (!BADGE_LABELS.has(badge)) BADGE_LABELS.set(badge, badge.getAttribute('aria-label'));
  const paw = el('span', 'hud__mission-paw');
  paw.innerHTML = MISSION_PAW_SVG;
  paw.appendChild(el('span', 'hud__mission-paw-value', String(myTokens)));
  badge.appendChild(paw);
  badge.setAttribute('aria-label', 'Мои лапки');
  badge.dataset.mission = '1';
}

export function updateMissionPawBadge(badge: HTMLElement, myTokens: number): void {
  const value = badge.querySelector<HTMLElement>('.hud__mission-paw-value');
  if (value) value.textContent = String(myTokens);
}

/** Undo the retheme exactly: drop the added node and put the label back. */
export function restoreMissionBadge(badge: HTMLElement): void {
  badge.querySelector('.hud__mission-paw')?.remove();
  delete badge.dataset.mission;
  if (!BADGE_LABELS.has(badge)) return;
  const label = BADGE_LABELS.get(badge) ?? null;
  BADGE_LABELS.delete(badge);
  if (label === null) badge.removeAttribute('aria-label');
  else badge.setAttribute('aria-label', label);
}

// ── contribution ceremony ───────────────────────────────────────────────────
/**
 * «Ты принёс N лапок» — mounted above the challenge pill in the CTA stack, and
 * rendered strictly from the committed receipt: no optimistic amount, no local
 * bar estimate. The bar underneath is the receipt's own `bar` block.
 */
export function buildMissionContributionCard(
  receipt: MissionContributionReceipt,
): HTMLElement {
  const card = el('section', 'mission-card');
  const head = el('div', 'mission-card__head');
  const icon = el('span', 'mission-card__icon');
  icon.innerHTML = MISSION_PAW_SVG;
  const copy = el('div', 'mission-card__copy');
  copy.append(
    el('strong', 'mission-card__title', `Ты принёс ${receipt.amount} лапок`),
    el('span', 'mission-card__sub', 'Вклад внесён — общий бар сдвинулся'),
  );
  head.append(icon, copy);
  const meter = el('div', 'mission-card__meter');
  meter.append(
    progressTrack('mission-card__track', missionBarPercent(receipt.bar.progress, receipt.bar.tokenGoal)),
    el('span', 'mission-card__count', `${receipt.bar.progress} / ${receipt.bar.tokenGoal}`),
  );
  card.append(head, meter);
  stopFeedGestures(card);
  return card;
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

function sumRow(label: string, value: string, tone = ''): HTMLElement {
  const row = el('div', `mission-sum${tone ? ` mission-sum--${tone}` : ''}`);
  row.append(el('span', 'mission-sum__label', label), el('span', 'mission-sum__value', value));
  return row;
}

function receiptInt(receipt: Record<string, unknown>, key: string): number {
  const value = receipt[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function receiptText(receipt: Record<string, unknown>, key: string): string {
  const value = receipt[key];
  return typeof value === 'string' ? value : '';
}

/** «Мы сделали это» — the three sums plus the successor that is already open. */
export function buildMissionUnlockedCeremony(options: {
  event: MissionCaseEvent;
  currency: string;
  nextCaseTitle: string | null;
  onClose: () => void;
}): HTMLElement {
  const { root, body, actions } = ceremonyShell(options.onClose);
  root.classList.add('mission-ceremony--unlocked');
  const payload = options.event.receipt;
  body.append(el('div', 'mission-ceremony__emoji', '🎉'));
  body.append(el('div', 'mission-ceremony__title', 'Мы сделали это'));
  const sums = el('div', 'mission-ceremony__sums');
  sums.append(
    sumRow('Гарантировано', formatMissionMoney(receiptInt(payload, 'guaranteedCents'), options.currency)),
    sumRow('Открыто игрой', `+${formatMissionMoney(receiptInt(payload, 'giftAdditionalCents'), options.currency)}`),
    sumRow(
      'Подарок ждёт передачи',
      formatMissionMoney(receiptInt(payload, 'giftTotalCents'), options.currency),
      'accent',
    ),
  );
  body.append(sums);
  if (options.nextCaseTitle) {
    body.append(el('div', 'mission-ceremony__next', `Следующая цель уже открыта — ${options.nextCaseTitle}`));
  }
  const button = el('button', 'mission-ceremony__btn', 'Дальше');
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
  body.append(el('div', 'mission-ceremony__next', 'записано в историю приюта'));
  const reference = receiptText(transfer, 'transferReference');
  if (reference) body.append(el('div', 'mission-ceremony__ref', `Перевод ${reference}`));
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
  snapshotRule: 'Правило снимка пула',
  poolConsumption: 'Расходование пула',
  eligiblePool: 'Источники пула',
};

const POLICY_ENUM_MEANINGS: Record<string, string> = {
  'floor-cents': 'вниз до целых центов',
  'guaranteed-plus-floor-proportional-share-v1':
    'гарантия плюс доля пула пропорционально прогрессу, вниз до цента',
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
  'currency', 'rounding', 'giftFormula', 'snapshotRule', 'poolConsumption', 'eligiblePool',
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
  const wrap = el('details', 'mission-contract');
  const summary = document.createElement('summary');
  summary.className = 'mission-contract__summary';
  summary.textContent = 'Контракт кейса';
  wrap.appendChild(summary);
  const contract = view.activeCase?.contract;
  if (!contract) {
    wrap.appendChild(el('div', 'mission-contract__empty', 'Контракт недоступен'));
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
  wrap.appendChild(list);

  wrap.appendChild(policySection(contract.fundingPolicy));

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
  wrap.appendChild(raw);
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

  const photo = el('div', 'mission-photo');
  photo.innerHTML = MISSION_PAW_SVG;
  photo.append(el('span', 'mission-photo__hint', 'Фото кейса появится с отчётом'));
  screen.appendChild(photo);

  const heading = el('header', 'mission-screen__head');
  heading.append(el('h2', 'mission-screen__title', missionCaseTitle(doc)));
  const subtitle = missionCaseSubtitle(doc);
  if (subtitle) heading.append(el('div', 'mission-screen__sub', subtitle));
  screen.appendChild(heading);

  const meter = el('section', 'mission-meter');
  meter.append(
    progressTrack('mission-meter__track', missionBarPercent(active.bar.progress, active.bar.tokenGoal)),
    el('div', 'mission-meter__count', `${active.bar.progress} / ${active.bar.tokenGoal} лапок сообщества`),
  );
  screen.appendChild(meter);

  // The four obligatory numbers: community tokens (the bar above), the promised
  // guarantee, the money the pool ACTUALLY holds against it (reserved + whatever
  // a crossing opened), and money that has really left — from fulfillment
  // receipts alone. The play-opened part is a detail INSIDE the reserved tile so
  // the promise is never visually confused with the held amount. «Мои лапки» is
  // the extra personal number the operator asked to keep in the 2×2.
  const tiles = el('section', 'mission-tiles');
  tiles.append(
    tile('Гарантировано', formatMissionMoney(active.money.guaranteedCents, currency)),
    tile(
      'Зарезервировано и открыто',
      formatMissionMoney(active.money.reservedAndOpenedCents, currency),
      `+${formatMissionMoney(missionOpenedByPlayCents(active.money), currency)} открыто игрой`,
    ),
    tile('Мои лапки', String(view.myContribution.caseTokens)),
    tile(
      'Передано',
      active.money.deliveredCents > 0
        ? formatMissionMoney(active.money.deliveredCents, currency)
        : 'ждём',
    ),
  );
  screen.appendChild(tiles);

  screen.appendChild(contractSection(view));
  screen.appendChild(historySection(history));
  return screen;
}
