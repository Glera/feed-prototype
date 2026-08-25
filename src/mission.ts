/**
 * Mission slice v0 — client orchestration.
 *
 * ONE admission rule guards everything below: `VITE_MISSION_ENABLED` (a build
 * flag, default off) AND the `mission_dogfood` capability `/session` exposes
 * only to an enrolled account. Without both, this module mounts no DOM node,
 * issues no `/api/mission/*` request and touches no storage key — the feed
 * behaves exactly as the pre-mission build. Every exported entry point starts
 * with that check, so `feed.ts` never has to.
 *
 * What lives here: the capability, the read-API projection, the client-owned
 * ceremony watermark, my own contribution history, and the wiring that turns an
 * outbox result receipt into the contribution ceremony. Markup lives in
 * `mission-ui.ts`; parsing and the watermark rules live in `mission-core.mjs`.
 *
 * The contribution ceremony deliberately reads the receipt that came back
 * through the durable results outbox rather than a local estimate. That is what
 * makes it survive a reload or a retry: the outbox replays the same run, the
 * server replays the committed receipt bytes, and the ceremony is rendered from
 * those bytes whenever they finally arrive.
 */
import { apiMissionCase } from './api';
import {
  advanceMissionWatermark,
  appendMissionHistory,
  isContributionPresented,
  missionCaseTitle,
  missionSurfaceEnabled,
  normaliseMissionWatermark,
  parseMissionCaseView,
  parseMissionContributionReceipt,
  parseMissionHistory,
  pendingMissionCeremonies,
  rememberPresentedContribution,
  type MissionCaseView,
  type MissionContributionReceipt,
  type MissionHistoryEntry,
  type MissionWatermark,
} from './mission-core.mjs';
import {
  buildMissionCaseScreen,
  buildMissionFulfilledCeremony,
  buildMissionHudBar,
  buildMissionUnlockedCeremony,
  launchMissionPawFlight,
  updateMissionHudBar,
} from './mission-ui';
import { onResultConfirmed } from './outbox';
import { userScopedStorageKey } from './user-scope';

const WATERMARK_KEY = 'mission-celebrated-events-v1';
const HISTORY_KEY = 'mission-my-contributions-v1';
/** Enough to cover a series chest plus a daily claim still in flight. */
const RECEIPT_CACHE_LIMIT = 8;
/** A win screen never outlives this; after it the waiter is released. */
const RECEIPT_WAIT_MS = 30_000;

const MISSION_FLAG_ENABLED =
  String((import.meta as any).env?.VITE_MISSION_ENABLED ?? '').toLowerCase() === 'true';

let capability = false;
let view: MissionCaseView | null = null;
let viewFingerprint = '';
let hudEl: HTMLElement | null = null;
let barEl: HTMLElement | null = null;
let navigationEl: HTMLElement | null = null;
let navigationOrder: HTMLElement[] = [];
let missionMapEl: HTMLButtonElement | null = null;
let viewportEl: HTMLElement | null = null;
let screenEl: HTMLElement | null = null;
let ceremonyEl: HTMLElement | null = null;
let refreshing: Promise<void> | null = null;
let refreshQueued = false;
let outboxBound = false;

const receipts = new Map<string, MissionContributionReceipt>();
const waiters = new Map<string, Set<(receipt: MissionContributionReceipt | null) => void>>();
/** Contribution seqs already celebrated — one ceremony per contribution, no
 *  matter which door the receipt came through (first answer, retry, replay). */
let presented: number[] = [];

// ── gating ──────────────────────────────────────────────────────────────────
/** The build flag alone. Exposed so diagnostics can tell «off» from «not enrolled». */
export function missionFlagEnabled(): boolean {
  return MISSION_FLAG_ENABLED;
}

/** Both gates. The single predicate every entry point below is guarded by. */
export function missionActive(): boolean {
  return missionSurfaceEnabled(MISSION_FLAG_ENABLED, capability);
}

/**
 * Adopt (or revoke) the `/session` capability. Revocation tears the surface
 * down: a build whose account lost enrolment must not keep a stale mission HUD.
 */
export function applyMissionCapability(available: unknown): void {
  if (!MISSION_FLAG_ENABLED) return;
  const next = available === true;
  if (next === capability) return;
  capability = next;
  if (!capability) {
    teardownMissionSurface();
    return;
  }
  bindOutbox();
  syncMissionSurface();
}

// ── storage (user-scoped, fail-quiet) ───────────────────────────────────────
function readJson(baseKey: string): unknown {
  try {
    const raw = localStorage.getItem(userScopedStorageKey(baseKey));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(baseKey: string, value: unknown): void {
  try {
    localStorage.setItem(userScopedStorageKey(baseKey), JSON.stringify(value));
  } catch { /* private mode */ }
}

function loadWatermark(): MissionWatermark {
  return normaliseMissionWatermark(readJson(WATERMARK_KEY));
}

function loadHistory(): MissionHistoryEntry[] {
  return parseMissionHistory(readJson(HISTORY_KEY));
}

// ── HUD ─────────────────────────────────────────────────────────────────────
/**
 * Register the HUD. Nothing is inserted here: the compact gift bar appears
 * only once the capability has actually arrived, so a build with the flag on but
 * an unenrolled account still renders the untouched HUD.
 */
export function mountMissionHud(hud: HTMLElement, viewport: HTMLElement): void {
  if (!MISSION_FLAG_ENABLED) return;
  hudEl = hud;
  viewportEl = viewport;
  barEl = null;   // a remount brought a brand-new HUD subtree
  syncMissionSurface();
}

/** Register existing bottom navigation; mission mode reorders additively. */
export function mountMissionNavigation(navigation: HTMLElement): void {
  if (!MISSION_FLAG_ENABLED) return;
  navigationEl = navigation;
  const switcher = navigation.querySelector<HTMLElement>('.feed-bar__switch');
  navigationOrder = switcher ? Array.from(switcher.children) as HTMLElement[] : [];
  syncMissionSurface();
}

function syncMissionNavigation(): void {
  const switcher = navigationEl?.querySelector<HTMLElement>('.feed-bar__switch');
  if (!switcher || !navigationEl) return;
  navigationEl.classList.add('feed-bar--mission');
  const labels: Record<string, string> = {
    daily: 'Daily', collections: 'Collections', feed: 'Feed',
  };
  for (const [name, label] of Object.entries(labels)) {
    const button = switcher.querySelector<HTMLElement>(`[data-bar-tab="${name}"]`);
    if (button) button.dataset.missionLabel = label;
  }
  for (const name of ['daily', 'collections', 'feed']) {
    const button = switcher.querySelector<HTMLElement>(`[data-bar-tab="${name}"]`);
    if (button) switcher.appendChild(button);
  }
  if (!missionMapEl) {
    missionMapEl = document.createElement('button');
    missionMapEl.type = 'button';
    missionMapEl.className = 'feed-bar__icon feed-bar__icon--mission-map';
    missionMapEl.dataset.missionLabel = 'Map';
    missionMapEl.disabled = true;
    missionMapEl.setAttribute('aria-label', 'Карта — скоро');
    missionMapEl.setAttribute('aria-disabled', 'true');
    missionMapEl.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M4 5.5 9 3l6 2.5L20 3v15.5L15 21l-6-2.5L4 21z"/>'
      + '<path d="M9 3v15.5M15 5.5V21"/></svg>';
    switcher.appendChild(missionMapEl);
  }
}

function syncMissionSurface(): void {
  if (!missionActive() || !hudEl) return;
  const stories = hudEl.querySelector<HTMLElement>('.stories');
  if (stories && !barEl) {
    hudEl.classList.add('hud--mission');
    barEl = buildMissionHudBar(openMissionCaseScreen, openMissionContractSheet);
    stories.appendChild(barEl);
  }
  const plus = hudEl.querySelector<HTMLElement>('.hud__level-plus');
  plus?.setAttribute('aria-hidden', 'false');
  plus?.setAttribute('role', 'button');
  plus?.setAttribute('aria-label', 'Добавить друга — скоро');
  syncMissionNavigation();
  renderMissionHud();
}

function renderMissionHud(): void {
  const active = view?.activeCase ?? null;
  if (barEl) {
    updateMissionHudBar(barEl, {
      progress: active?.bar.progress ?? 0,
      tokenGoal: active?.bar.tokenGoal ?? 0,
      nextStepThreshold: active?.bar.nextStepThreshold ?? null,
    });
  }
}

/**
 * A revoked capability leaves the original HUD nodes untouched and removes only
 * additive mission nodes/classes — the second half of the double gate.
 */
function teardownMissionSurface(): void {
  hudEl?.classList.remove('hud--mission');
  barEl?.remove();
  barEl = null;
  const plus = hudEl?.querySelector<HTMLElement>('.hud__level-plus');
  plus?.setAttribute('aria-hidden', 'true');
  plus?.removeAttribute('role');
  plus?.removeAttribute('aria-label');
  if (navigationEl) navigationEl.classList.remove('feed-bar--mission');
  const switcher = navigationEl?.querySelector<HTMLElement>('.feed-bar__switch');
  if (switcher) {
    missionMapEl?.remove();
    missionMapEl = null;
    for (const item of navigationOrder) {
      delete item.dataset.missionLabel;
      switcher.appendChild(item);
    }
  }
  screenEl?.remove();
  screenEl = null;
  ceremonyEl?.remove();
  ceremonyEl = null;
  view = null;
  viewFingerprint = '';
}

// ── read API ────────────────────────────────────────────────────────────────
/**
 * Re-project the case from the server and settle any ceremony the player is
 * owed. Called on entry and on every foreground (both run through
 * `applySessionBootstrap`), and once after a contribution so the shared bar and
 * community money catch up from receipts rather than from a local guess.
 */
export function refreshMissionCase(): Promise<void> {
  if (!missionActive()) return Promise.resolve();
  // A contribution committed WHILE a read is in flight would otherwise be
  // swallowed by that older response. Coalesce instead: share the in-flight
  // request, and run exactly one more read after it for whoever asked late.
  if (refreshing) {
    refreshQueued = true;
    return refreshing;
  }
  refreshing = (async () => {
    const parsed = parseMissionCaseView(await apiMissionCase());
    if (!parsed) return;
    const fingerprint = JSON.stringify(parsed);
    const changed = fingerprint !== viewFingerprint;
    view = parsed;
    viewFingerprint = fingerprint;
    if (changed) {
      renderMissionHud();
      // Rebuilding an unchanged screen would collapse a contract the player just
      // expanded, so the open screen is only re-rendered on a real change.
      if (screenEl) renderMissionCaseScreen();
    }
    presentNextCeremony();
  })().finally(() => {
    refreshing = null;
    if (!refreshQueued) return;
    refreshQueued = false;
    void refreshMissionCase();
  });
  return refreshing;
}

// ── ceremonies (watermark-gated, one at a time) ─────────────────────────────
function presentNextCeremony(): void {
  if (!missionActive() || ceremonyEl || !viewportEl || !view) return;
  const [next] = pendingMissionCeremonies(view, loadWatermark());
  if (!next) return;
  const currency = view.activeCase?.money.currency ?? 'EUR';
  // Committing the watermark BEFORE the ceremony is dismissed is deliberate: a
  // player who closes the app mid-ceremony has still been shown it, and a
  // celebration that replays on every boot is worse than one missed dismissal.
  writeJson(
    WATERMARK_KEY,
    advanceMissionWatermark(loadWatermark(), next.kind, next.event.eventSeq),
  );
  const close = (): void => {
    ceremonyEl?.remove();
    ceremonyEl = null;
    presentNextCeremony();
  };
  if (next.kind === 'unlocked') {
    const active = view.activeCase;
    // The successor the crossing activated — never the case that just closed.
    const nextCaseTitle = active && active.caseId !== next.event.caseId
      ? missionCaseTitle(active.contract?.document ?? {})
      : null;
    ceremonyEl = buildMissionUnlockedCeremony({ event: next.event, currency, nextCaseTitle, onClose: close });
  } else {
    ceremonyEl = buildMissionFulfilledCeremony({ event: next.event, currency, onClose: close });
  }
  viewportEl.appendChild(ceremonyEl);
}

// ── case screen ─────────────────────────────────────────────────────────────
function openMissionCaseScreen(): void {
  if (!missionActive() || !viewportEl || screenEl) return;
  renderMissionCaseScreen();
  void refreshMissionCase();
}

function openMissionContractSheet(): void {
  if (!missionActive() || !viewportEl) return;
  const reveal = (): void => {
    if (!screenEl) renderMissionCaseScreen();
    screenEl?.querySelector<HTMLButtonElement>('.mission-contract__summary')?.click();
  };
  if (view) {
    reveal();
    void refreshMissionCase();
  } else {
    void refreshMissionCase().then(reveal);
  }
}

function renderMissionCaseScreen(): void {
  if (!viewportEl || !view) return;
  const fresh = buildMissionCaseScreen({
    view,
    history: loadHistory(),
    onClose: closeMissionCaseScreen,
  });
  if (screenEl) screenEl.replaceWith(fresh);
  else viewportEl.appendChild(fresh);
  screenEl = fresh;
}

function closeMissionCaseScreen(): void {
  screenEl?.remove();
  screenEl = null;
}

// ── contribution receipts ───────────────────────────────────────────────────
function bindOutbox(): void {
  if (outboxBound || !MISSION_FLAG_ENABLED) return;
  outboxBound = true;
  onResultConfirmed((confirmed) => {
    if (!missionActive()) return;
    const receipt = parseMissionContributionReceipt(confirmed.balances.mission);
    if (!receipt) return;
    cacheContribution(confirmed.runId, receipt);
    recordContribution(receipt);
  });
}

function cacheContribution(runId: string, receipt: MissionContributionReceipt): void {
  if (receipts.size >= RECEIPT_CACHE_LIMIT) {
    const oldest = receipts.keys().next().value;
    if (oldest !== undefined) receipts.delete(oldest);
  }
  receipts.set(runId, receipt);
  const pending = waiters.get(runId);
  if (!pending) return;
  waiters.delete(runId);
  for (const resolve of pending) resolve(receipt);
}

/** History is deduplicated by the immutable contribution seq, so an outbox
 *  replay of the same run records the same entry rather than a second one. */
function recordContribution(receipt: MissionContributionReceipt): void {
  writeJson(HISTORY_KEY, appendMissionHistory(loadHistory(), {
    seq: receipt.seq,
    source: receipt.source,
    amount: receipt.amount,
    caseId: receipt.bar.caseId,
    at: new Date().toISOString(),
  }));
  // The receipt's own bar is server-derived, so it is not an optimistic paint;
  // `myContribution` and the money still come from the read API.
  void refreshMissionCase();
}

function awaitContribution(runId: string): Promise<MissionContributionReceipt | null> {
  const known = receipts.get(runId);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    const set = waiters.get(runId) ?? new Set();
    set.add(resolve);
    waiters.set(runId, set);
    window.setTimeout(() => {
      const current = waiters.get(runId);
      if (!current?.delete(resolve)) return;
      if (current.size === 0) waiters.delete(runId);
      resolve(null);
    }, RECEIPT_WAIT_MS);
  });
}

/**
 * The single presenter. Every door a contribution can arrive through ends here,
 * and the immutable contribution `seq` makes «the same fact» recognisable: a
 * retried claim, a replayed outbox result and the first answer all describe one
 * contribution and owe the player exactly one ceremony.
 */
function showContributionFlight(receipt: MissionContributionReceipt, origin: HTMLElement | null): void {
  if (!origin || !barEl || !viewportEl || isContributionPresented(presented, receipt.seq)) return;
  presented = rememberPresentedContribution(presented, receipt.seq);
  launchMissionPawFlight(receipt, origin, barEl, viewportEl);
}

/**
 * The series-win contribution ceremony. Mounted INTO the reward overlay and
 * prepended, so it sits above the challenge pill in the CTA stack, and only once
 * the exact run's receipt has come back through the outbox.
 */
export function presentMissionContribution(options: {
  runId: string;
  origin: () => HTMLElement | null;
  alive: () => boolean;
}): Promise<void> {
  if (!missionActive()) return Promise.resolve();
  return awaitContribution(options.runId).then((receipt) => {
    if (!receipt || !options.alive()) return;
    showContributionFlight(receipt, options.origin());
  });
}

/**
 * The daily-claim contribution ceremony. That path has no outbox, so the receipt
 * is read inline from the claim response — the same committed bytes, and the
 * reward line speaks paws instead of puzzles.
 *
 * Must be called on EVERY success of the claim, not only the first one: after a
 * lost response, or after the mandatory retryable 503 of an empty case queue,
 * the contribution is committed by a later background retry and its receipt
 * arrives only there. The seq dedupe above is what keeps that from celebrating
 * a contribution the player has already seen.
 */
export function presentMissionDailyContribution(response: unknown, parent: HTMLElement | null): void {
  if (!missionActive() || !parent) return;
  const block = (response as { mission_contribution?: unknown } | null)?.mission_contribution;
  const receipt = parseMissionContributionReceipt(block);
  if (!receipt) return;
  recordContribution(receipt);
  showContributionFlight(receipt, parent);
}
