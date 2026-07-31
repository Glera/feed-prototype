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

/**
 * Retheme the puzzle badge into the paw badge. The puzzle BALANCE only leaves
 * the surface — `feed.ts` keeps counting it and the server ledger is untouched.
 */
export function applyMissionPawBadge(badge: HTMLElement, myTokens: number): void {
  badge.dataset.mission = '1';
  badge.setAttribute('aria-label', 'Мои лапки');
  badge.replaceChildren();
  const icon = el('span', 'hud__puzzles-icon');
  icon.innerHTML = MISSION_PAW_SVG;
  badge.append(icon, el('span', 'hud__puzzles-value', String(myTokens)));
}

export function updateMissionPawBadge(badge: HTMLElement, myTokens: number): void {
  const value = badge.querySelector<HTMLElement>('.hud__puzzles-value');
  if (value) value.textContent = String(myTokens);
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
function tile(label: string, value: string): HTMLElement {
  const node = el('div', 'mission-tile');
  node.append(el('span', 'mission-tile__label', label), el('strong', 'mission-tile__value', value));
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

/** The full public contract, one tap away: the case document AND its resolved
 *  funding policy — source, eligible-pool definition and gift formula in words,
 *  with the raw pinned documents underneath for anyone who wants the bytes. */
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
  definition(list, 'Передать до', doc.latestFulfillmentAt);
  definition(list, 'Версия', `${contract.contractVersion} · ${contract.contractDigest.slice(0, 12)}`);
  wrap.appendChild(list);

  const policy = contract.fundingPolicy;
  const policyDoc = policy.document as Record<string, unknown>;
  const pool = (policyDoc.eligiblePool ?? {}) as Record<string, unknown>;
  const formula = (policyDoc.giftFormula ?? {}) as Record<string, unknown>;
  const policyList = el('div', 'mission-defs');
  policyList.appendChild(el('div', 'mission-defs__head', 'Политика финансирования'));
  definition(policyList, 'Источники пула', pool.sources);
  definition(policyList, 'Что считается', pool.definition);
  definition(policyList, 'Доля разблокировки', formula.unlockShare);
  definition(policyList, 'Формула подарка', formula.expression);
  definition(policyList, 'Округление', policyDoc.rounding);
  definition(policyList, 'Версия', `${policy.version} · ${policy.digest.slice(0, 12)}`);
  wrap.appendChild(policyList);

  const raw = el('details', 'mission-contract__raw');
  const rawSummary = document.createElement('summary');
  rawSummary.textContent = 'Документы целиком';
  raw.appendChild(rawSummary);
  const pre = el('pre', 'mission-contract__json');
  pre.textContent = JSON.stringify({ contract: doc, fundingPolicy: policyDoc }, null, 2);
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

  const tiles = el('section', 'mission-tiles');
  tiles.append(
    tile('Гарантировано', formatMissionMoney(active.money.guaranteedCents, currency)),
    tile('Открыто игрой', `+${formatMissionMoney(missionOpenedByPlayCents(active.money), currency)}`),
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
