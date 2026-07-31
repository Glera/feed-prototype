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
  missionCaseTitle,
  missionSurfaceEnabled,
  normaliseMissionWatermark,
  parseMissionCaseView,
  parseMissionContributionReceipt,
  parseMissionHistory,
  pendingMissionCeremonies,
  type MissionCaseView,
  type MissionContributionReceipt,
  type MissionHistoryEntry,
  type MissionWatermark,
} from './mission-core.mjs';
import {
  applyMissionPawBadge,
  buildMissionCaseScreen,
  buildMissionContributionCard,
  buildMissionFulfilledCeremony,
  buildMissionHudBar,
  buildMissionUnlockedCeremony,
  updateMissionHudBar,
  updateMissionPawBadge,
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
let badgeEl: HTMLElement | null = null;
let viewportEl: HTMLElement | null = null;
let screenEl: HTMLElement | null = null;
let ceremonyEl: HTMLElement | null = null;
let refreshing: Promise<void> | null = null;
let refreshQueued = false;
let outboxBound = false;

const receipts = new Map<string, MissionContributionReceipt>();
const waiters = new Map<string, Set<(receipt: MissionContributionReceipt | null) => void>>();

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
 * down: a build whose account lost enrolment must not keep a stale paw badge.
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

/** True while the paw badge owns the HUD counter, so the puzzle balance — which
 *  keeps accruing server-side — stops being painted over it. */
export function missionOwnsHudBadge(): boolean {
  return missionActive() && badgeEl?.dataset.mission === '1';
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
 * Register the HUD. Nothing is inserted here: the bar and the paw badge appear
 * only once the capability has actually arrived, so a build with the flag on but
 * an unenrolled account still renders the untouched HUD.
 */
export function mountMissionHud(hud: HTMLElement, viewport: HTMLElement): void {
  if (!MISSION_FLAG_ENABLED) return;
  hudEl = hud;
  viewportEl = viewport;
  barEl = null;   // a remount brought a brand-new HUD subtree
  badgeEl = hud.querySelector<HTMLElement>('.hud__puzzles');
  syncMissionSurface();
}

function syncMissionSurface(): void {
  if (!missionActive() || !hudEl) return;
  const stories = hudEl.querySelector<HTMLElement>('.stories');
  if (stories && !barEl) {
    hudEl.classList.add('hud--mission');
    barEl = buildMissionHudBar(openMissionCaseScreen);
    stories.appendChild(barEl);
  }
  if (badgeEl && badgeEl.dataset.mission !== '1') {
    applyMissionPawBadge(badgeEl, view?.myContribution.caseTokens ?? 0);
  }
  renderMissionHud();
}

function renderMissionHud(): void {
  const active = view?.activeCase ?? null;
  if (barEl) {
    updateMissionHudBar(barEl, {
      title: active ? missionCaseTitle(active.contract?.document ?? {}) : 'Кейс готовится',
      progress: active?.bar.progress ?? 0,
      tokenGoal: active?.bar.tokenGoal ?? 0,
      myTokens: view?.myContribution.caseTokens ?? 0,
    });
  }
  if (badgeEl?.dataset.mission === '1') {
    updateMissionPawBadge(badgeEl, view?.myContribution.caseTokens ?? 0);
  }
}

function teardownMissionSurface(): void {
  hudEl?.classList.remove('hud--mission');
  barEl?.remove();
  barEl = null;
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
 * `applySessionBootstrap`), and once after a contribution so the paw badge and
 * the community money catch up from receipts rather than from a local guess.
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
 * The series-win contribution ceremony. Mounted INTO the reward overlay and
 * prepended, so it sits above the challenge pill in the CTA stack, and only once
 * the exact run's receipt has come back through the outbox.
 */
export function presentMissionContribution(options: {
  runId: string;
  parent: () => HTMLElement | null;
  alive: () => boolean;
}): Promise<void> {
  if (!missionActive()) return Promise.resolve();
  return awaitContribution(options.runId).then((receipt) => {
    if (!receipt || !options.alive()) return;
    const parent = options.parent();
    if (!parent || parent.querySelector('.mission-card')) return;
    parent.prepend(buildMissionContributionCard(receipt));
  });
}

/**
 * The daily-claim contribution ceremony. That path has no outbox, so the receipt
 * is read inline from the claim response — the same committed bytes, and the
 * reward line speaks paws instead of puzzles.
 */
export function presentMissionDailyContribution(response: unknown, parent: HTMLElement | null): void {
  if (!missionActive() || !parent) return;
  const block = (response as { mission_contribution?: unknown } | null)?.mission_contribution;
  const receipt = parseMissionContributionReceipt(block);
  if (!receipt) return;
  recordContribution(receipt);
  parent.querySelector('.mission-card')?.remove();
  parent.prepend(buildMissionContributionCard(receipt));
}
