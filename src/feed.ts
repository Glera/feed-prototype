import { PLAYABLES, playableUrl, type Playable } from './playables';
import { apiSession, apiMe, variantIdForMechanic } from './api';
import { queueResult, flushResults } from './outbox';
import { track } from './telemetry';
import { getStartParam } from './telegram';

// Injected at build time (vite define) — the platform build stamp, shown on the feed bar.
declare const __PLATFORM_VERSION__: string;

/**
 * Infinite vertical feed pager (Instagram-Reels / TikTok style) over real playables.
 *
 * INFINITE LOOP: pages are absolutely stacked and positioned individually on a
 * ring. Each page's offset from the current position is wrapped into
 * (-N/2, N/2], so a page that scrolls far enough off one edge reappears on the
 * other — after the last game comes the first again (and swiping back from the
 * first lands on the last). The wrap always happens off-screen, so it's seamless.
 *
 * Gesture separation: in-game gestures stay inside the playable iframe. Paging
 * is exposed only by explicit host overlays: autoplay, reward, and level-up.
 *
 * Loading model:
 *  - The CURRENT game is active.
 *  - One NEXT game may be mounted warm in the background, but it is host-paused
 *    and has autoplay stopped until the slide settles on it.
 *  - Drag/settle never waits for iframe creation; if the next warm page is ready,
 *    it is already painted under the incoming page.
 *  - A fill-bar preloader covers only the first visible game.
 */

const DISTANCE_SNAP_FRAC = 0.06;   // short upward drag commits to the next page
const DISTANCE_SNAP_PX = 14;       // absolute cap so mobile swipes feel sharp
const TAP_SLOP_PX = 8;             // micro movement still counts as a tap
const MIN_SWIPE_INTENT_PX = 8;     // velocity alone cannot turn a tiny wiggle into a swipe
const VELOCITY_SNAP = 0.24;        // px/ms flick that commits regardless of distance

// Mechanics excluded from the ?livein=1 live-iframe-ride experiment (see
// liveRideOk). Empty: every warm frame paints a start screen since
// warm-paint's timer-drive.
const LiveRideExcluded = new Set<string>([]);

// ── Ride cover ──────────────────────────────────────────────────────────────
// The image that RIDES IN on the arriving page (and fronts a loading slot):
// the mechanic's designed cover art `<id>.cover.jpg` when it ships one, else
// this standard platform card. On arrival the cover fades out (game--live)
// and the live mechanic takes over — deliberately a CARD → GAME reveal, not a
// pixel-faithful continuation: it is guaranteed smooth (a static host-document
// <img> rides; nothing is captured or encoded in the background) and reads as
// intentional design. Replaced the live-canvas-snapshot pipeline, whose
// per-second composites taxed the shared main thread and whose fidelity
// depended on each mechanic's warm paint.
const RIDE_PLACEHOLDER_SRC = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 375 620">'
  // Bright enough to read through the autoplay dim veil that covers the
  // arriving page — a darker card composited under the dim looked like the
  // old "arrived black" bug.
  + '<defs>'
  + '<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">'
  + '<stop offset="0" stop-color="#35496f"/><stop offset="0.55" stop-color="#243352"/><stop offset="1" stop-color="#141c31"/>'
  + '</linearGradient>'
  + '<radialGradient id="glow" cx="0.5" cy="0.42" r="0.65">'
  + '<stop offset="0" stop-color="#6f8dff" stop-opacity="0.30"/><stop offset="1" stop-color="#6f8dff" stop-opacity="0"/>'
  + '</radialGradient>'
  + '</defs>'
  + '<rect width="375" height="620" fill="url(#bg)"/>'
  + '<rect width="375" height="620" fill="url(#glow)"/>'
  + '<circle cx="187.5" cy="260" r="46" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="3"/>'
  + '<path d="M175 238 L210 260 L175 282 Z" fill="#ffffff" fill-opacity="0.4"/>'
  + '</svg>'
);

/** The mechanic's cover-art URL — resolves next to its html like the payload. */
function coverSrc(id: string): string {
  return playableUrl(id).split('?')[0].replace(/\.html$/, '.cover.jpg');
}

const LIVE_AHEAD = 0;              // explicit warm-next scheduling below owns ahead iframe lifetime
const LIVE_BEHIND = 0;             // back-swipe is disabled, so no idle previous iframe
// Byte-prefetch depth (html + payload.js into the HTTP cache; NO iframe, no
// main-thread cost, no JS-heap cost). Reels-style: pull content as far ahead
// as the network can afford — in an infinite no-repeat feed every prefetched
// byte gets used, the only waste is the tail when the user quits. Depth is
// ADAPTIVE so a slow/metered connection isn't smothered by background bytes
// (Network Information API — Android Chrome; iOS lacks it and gets the fast
// default). Fetches are serialized, idle-gated and priority:'low' so they
// never compete with the warm iframe's own load. Escape hatch: ?prefetch=off.
function reserveAheadDepth(): number {
  const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (c?.saveData) return 1;                                  // user asked to save data — respect it
  if (c?.effectiveType === 'slow-2g' || c?.effectiveType === '2g') return 1;
  if (c?.effectiveType === '3g') return 2;
  return 4;                                                   // 4g / wifi / unknown (iOS)
}
const INITIAL_BATCH = 1;           // get the first mechanic visible; warm-next starts after it settles
const PRELOADER_TIMEOUT_MS = 15000;
const SERVER_SEED_CAP_MS = 2500;   // max the preloader waits for the first /session

// Globally-unique run id per playthrough. MUST be unique across sessions/reloads:
// it's the /results idempotency key (lw:{run_id}); a per-session counter (1,2,3…)
// collides on reload and the ledger silently dedupes the new session's wins.
function runUid(): string {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* older webview */ }
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
const ANALYTICS_POLL_MS = 1000;    // fallback for older non-SWIPE exports
const FRAME_READY_FALLBACK_MS = 900;
const FRAME_REVEAL_DELAY_MS = 90;
// 150ms, was 900: the wait existed to shield the running demo from the warm
// boot hitch. The hitch is gone (quality-bench cached, compile streamed off-
// thread, assets inert, spine + first frame deferred out of mount) — warm now
// starts right after the slide settles so fast flicking still lands on a
// prepared mechanic. The small delay + calm-frame gate below only avoid
// competing with the settle frame itself.
const WARM_NEXT_DELAY_MS = 150;
const WARM_NEXT_IDLE_TIMEOUT_MS = 600;
const WARM_NEXT_CALM_FRAME_MS = 24;
// 3 calm frames, was 8 — the warm boot no longer produces a hitch worth
// hiding; the gate now only keeps the warm off the settle frame itself.
const WARM_NEXT_CALM_FRAMES = 3;
const WARM_NEXT_IDLE_MIN_MS = 3;
// A busy 60fps mechanic can starve the calm gate forever; after this many
// stuck rounds the low-impact task runs anyway (see scheduleLowImpactTask).
const STUCK_ROUNDS_MAX = 3;
const LEVEL_PROGRESS_MS = 340;
const STARS_PER_LEVEL = 5;    // level-1 base; higher levels need more (starsForLevel)
// Reward-star collect: the N earned stars line up in a row on the win screen, then
// on tap each peels off IN TURN and bounces to the counter — squash (вжалась с
// расширением) → jump (прыжок) → fly (полет) → impact + particles + removal. No
// scatter/decay phase; each star flies straight from its row slot.
const REWARD_BOUNCE_MS = 620;        // per-star: squash + jump + fly to the counter
const REWARD_PEEL_STAGGER_MS = 78;   // gap between successive peel-offs (halved from 155 — faster credit)
const RING_STEP_MS = 180;       // snappy ring growth per star impact (synced to the bump)

type PlayableOutcome = 'won' | 'lost';
type SwipeApi = {
  version: number;
  hasAutoPlay: boolean;
  hasEditor: boolean;
  hasRestart: boolean;
  startAutoPlay: () => void;
  stopAutoPlay: () => void;
  isAutoPlayActive: () => boolean;
  openEditor: () => void;
  closeEditor: () => void;
  isEditorOpen: () => boolean;
  restart: (opts?: { instant?: boolean }) => void;
};
type PlayableHostApi = {
  swipe?: SwipeApi;                  // uniform swipe-platform API (preferred)
  getAnalyticsHistory?: () => unknown[];
  getSwipeState?: () => Record<string, unknown>;
  hostGesture?: () => void;
  setEditorMode?: (enabled: boolean) => void;
  setHostPaused?: (paused: boolean) => void;
  setAutoPlayEnabled?: (enabled: boolean) => void;       // legacy fallback
  startAutoPlay?: (options?: { immediate?: boolean }) => void;  // legacy fallback
  stopAutoPlay?: () => void;
  toggleEditor?: () => void;
};

export class Feed {
  private viewport: HTMLElement;
  private feedEl: HTMLElement;
  private playables: Playable[];
  private N: number;

  private pageH = 0;
  private pos = 0;                  // continuous ring position (settles to an integer)
  private pageEls: HTMLElement[] = [];
  private pageDelta: number[] = [];
  private pageNearState: boolean[] = [];
  private pageInViewportState: boolean[] = [];
  private pageVisibilityState: boolean[] = [];
  private pageTransitionState: string[] = [];
  private pageTransformState: string[] = [];
  private pageZState: string[] = [];

  private slots: HTMLElement[] = [];
  private games: HTMLElement[] = [];
  private rewardEls: HTMLElement[] = [];
  private rewardStars: number[] = [];   // current reward per frame; swipe feed awards one star per win
  private gutters: HTMLElement[] = [];
  private stateEls: HTMLElement[] = [];
  private autoplayEls: HTMLElement[] = [];
  private swipebarTextEls: HTMLElement[] = [];
  private labelEls: HTMLElement[] = [];
  private labelTimers = new Map<number, number>();
  private frames = new Map<number, HTMLIFrameElement>();
  private completedRunIds = new Set<string>();
  private liveHold = new Set<number>();
  private settlingTargetIndex: number | null = null;
  private resetCycleAfterSettle = false;
  private warmIndex: number | null = null;
  // ── Warm-up debugging (open with ?warm=1 to log to console; call window.__feedWarm()
  //    anytime for a live snapshot: is the next mechanic pre-warmed, and if not why). ──
  private warmDbg = new URLSearchParams(location.search).get('warm') === '1';
  private warmEvents: string[] = [];
  private warmCalmMax = 0;   // most consecutive "calm" frames the low-impact scheduler has seen
  private warmTimer: number | null = null;
  private warmIdleCancel: (() => void) | null = null;
  private frameLoaded = new Set<number>();
  private frameReady = new Set<number>();
  private frameRevealed = new Set<number>();
  private framePaused = new Map<number, boolean>();
  private frameFallbackTimers = new Map<number, number>();
  private frameRevealTimers = new Map<number, number>();

  private totalStars = 0;
  // Telemetry (D3) state: which unit is on-screen, since when, and per-show guards.
  private shownIndex = -1;
  private shownAt = 0;
  private firstInputLogged = false;
  private preloaderMountedAt = 0;
  // Preloader waits for BOTH the first mechanic AND the first server seed (capped).
  private mechanicsReady = false;
  private awaitingServerSeed = true;
  // Bottom-bar version label: platform (build) + backend (git SHA, after auth).
  private versionEl: HTMLElement | null = null;
  private backendVersion: string | null = null;
  private earnedThisCycle = new Set<number>();
  private failedThisCycle = new Set<number>();
  private pendingStarRewards = new Set<number>();
  private claimedStarRewards = new Set<number>();
  private hudEl: HTMLElement | null = null;
  private storiesEl: HTMLElement | null = null;
  private storiesMomentumFrame: number | null = null;
  private levelBadgeEl: HTMLElement | null = null;
  private levelBadgeSquash: Animation | null = null;   // in-flight counter squash (star-arrival reaction)
  private levelEl: HTMLElement | null = null;
  private levelProgressEl: HTMLElement | null = null;
  private heldLevelUpOverlay: HTMLElement | null = null;
  private heldLevelUpIndex: number | null = null;
  private levelUpPageEl: HTMLElement | null = null;
  private levelUpPageState: 'idle' | 'entering' | 'settled' | 'leaving' = 'idle';
  private levelUpPageBasePos = 0;
  private confettiTimer: number | null = null;
  private manualRuns = new Set<number>();
  private pendingEditorLaunch = new Set<number>();
  private rewardSparkTimers = new Map<number, number>();
  private autoplayUiActive = new Set<number>();
  private likeCounts = new Map<number, number>();
  private likedMechanics = new Set<number>();
  private postedStories = new Set<number>();
  private dragMode: 'feed' | 'reward' | 'levelup' = 'feed';
  private rewardDragIndex: number | null = null;
  private dragAutoplayIndex: number | null = null;
  private dragAllowsBack = false;
  private collectingRewardIndex: number | null = null;
  private autoplayLoopTimers = new Map<number, number>();
  private holdNextAutoplay = false;

  // Friend stories (top rail). Tapping one opens a full-screen story showing a
  // playable mechanic; the background feed game is paused while it's open.
  private readonly friends: { name: string; initial: string; tone: string; hours: number }[] = [
    { name: 'Ava',  initial: 'A', tone: 'sky',    hours: 2 },
    { name: 'Mila', initial: 'M', tone: 'rose',   hours: 1 },
    { name: 'Leo',  initial: 'L', tone: 'mint',   hours: 5 },
    { name: 'Nika', initial: 'N', tone: 'sun',    hours: 3 },
    { name: 'Tim',  initial: 'T', tone: 'violet', hours: 8 },
    { name: 'Zoe',  initial: 'Z', tone: 'sky',    hours: 1 },
    { name: 'Max',  initial: 'M', tone: 'rose',   hours: 12 },
    { name: 'Eva',  initial: 'E', tone: 'mint',   hours: 4 },
    { name: 'Sam',  initial: 'S', tone: 'sun',    hours: 6 },
    { name: 'Kai',  initial: 'K', tone: 'violet', hours: 2 },
    { name: 'Mia',  initial: 'M', tone: 'sky',    hours: 9 },
    { name: 'Dan',  initial: 'D', tone: 'rose',   hours: 3 },
    { name: 'Liza', initial: 'L', tone: 'mint',   hours: 7 },
    { name: 'Ben',  initial: 'B', tone: 'sun',    hours: 1 },
  ];
  private viewedFriends = new Set<number>();   // in-memory only (no persistence yet)
  private overlayOpen = false;                 // story-view OR editor overlay is up
  private overlayEl: HTMLElement | null = null;
  private storyFrame: HTMLIFrameElement | null = null;  // the open story's mechanic iframe

  private prefetched = new Set<number>();
  private ready = new Set<number>();
  private prefetchQueue: number[] = [];
  private prefetchQueued = new Set<number>();
  private prefetching = false;
  private preloaderDone = false;
  private preloaderFillEl: HTMLElement | null = null;
  private preloaderProgressEl: HTMLElement | null = null;
  private preloaderEl: HTMLElement | null = null;
  private initialTarget = 0;

  // When the user taps to take over an autoplay demo, restart the mechanic from
  // scratch (fresh level) by default. `?takeover=continue` keeps the old behavior
  // — manual play picks up exactly where the autoplay left off. (Kept as a toggle
  // while we decide which feels better.)
  private restartOnTakeover =
    (new URLSearchParams(location.search).get('takeover') || 'restart') !== 'continue';
  // Warm-prefetch the next mechanic so it's mounted/parsed before the advance (default
  // 'idle' — warms during idle time). Disable with ?warm=off to compare the un-warmed
  // arrival (mechanic mounts on advance).
  private warmNextEnabled =
    (new URLSearchParams(location.search).get('warm') || 'idle') !== 'off';
  // LIVE RIDE experiment (default OFF, ?livein=1 to test): the warm NEXT page
  // parks at translateY(0) INSIDE the viewport, hidden under the opaque
  // current page — the browser renders+rasterises the live iframe there, and
  // the raster CAN survive the teleport to the normal offset when a slide
  // starts, riding the REAL mechanic in. Measured to be FLAKY though: during
  // a ~500ms finger drag the page sits off-screen long enough for the render
  // throttler to drop the iframe raster again (one recording rode, the next
  // arrived black), so the stable poster ride stays the default. The robust
  // successor is a live canvas SNAPSHOT into the host ride layer.
  private liveInEnabled = new URLSearchParams(location.search).get('livein') === '1';

  /** True when the arriving page can ride LIVE: feature on, its warm frame
   *  revealed, and its start screen actually painted while warm (DOM-scene
   *  mechanics build theirs only on un-pause — they ride the poster). */
  private liveRideOk(i: number): boolean {
    return this.liveInEnabled && i >= 0 && this.frameRevealed.has(i)
      && !LiveRideExcluded.has(this.playables[i]?.id ?? '');
  }

  private dragging = false;
  private startY = 0;
  private basePos = 0;
  private lastY = 0;
  private lastT = 0;
  private velocity = 0;

  constructor(viewport: HTMLElement, feedEl: HTMLElement, playables: Playable[]) {
    this.viewport = viewport;
    this.feedEl = feedEl;
    this.playables = playables;
    this.N = playables.length;
    this.initialTarget = Math.min(INITIAL_BATCH, this.N);
    this.build();
    this.buildIncoming();
    this.mountHud();
    this.mountFeedBar();
    this.measure();
    this.render(false);
    this.updateIncomingPoster();
    this.updateMechanicStates();
    this.updateHud(false);
    this.mountPreloader();

    // After a slide settles: normalise the ring position, resume the arrived
    // game and pause the rest. transitionend bubbles up from the pages.
    this.feedEl.addEventListener('transitionend', (e) => {
      if (e.propertyName !== 'transform' || this.dragging) return;
      // Settle ONLY when the sliding PAGE (or the level-up page) finishes its transform
      // transition — NOT when an inner element's transform transition bubbles up here.
      // The reel/slot autoplay scale (0.34s) and the reward buttons (0.16s) also fire
      // 'transform' transitionend events; if we settled on those, settleSlide() would
      // render(false) mid-slide and SNAP the page into place with no animation. That
      // race is exactly why the arrival was sometimes animated and sometimes not.
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (this.levelUpPageState === 'entering') {
        if (t === this.levelUpPageEl) this.settleLevelUpPage();
        return;
      }
      if (!t.classList.contains('page')) return;
      this.settleSlide();
    });

    this.updateLive();
    this.prefetchReserve();
    this.applyActiveStates();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('message', this.onWindowMessage);
    document.addEventListener('visibilitychange', this.onHostVisibilityChange);
    window.addEventListener('pagehide', this.pauseAllFrames);
    (window as any).__feedHostGesture = this.onHostGesture;
    window.setInterval(this.pollPlayableAnalytics, ANALYTICS_POLL_MS);
    window.setInterval(this.pollAutoplayUi, 250);
    window.setInterval(this.tickReelTimecode, 1000);
    this.initPerfTelemetry();
    // Debug hook: window.__feedWarm() → live snapshot of the next-mechanic warm
    // state (is it pre-warmed? if not, why — blocked, or calm window starved?).
    // Also open the feed with ?warm=1 to stream the warm lifecycle to the console.
    (window as unknown as { __feedWarm?: () => unknown }).__feedWarm = () => this.warmSnapshot();
    this.bootServer();
  }

  // ── Backend (W1): identity + server-side star balance + telemetry ──────────
  // Seeds totalStars from the server so the counter survives close/reopen. The
  // in-memory flow still owns the counter DURING a session (optimistic); each win
  // is persisted via /results (idempotent). No-op outside Telegram (no initData →
  // apiSession returns null → we keep the existing in-memory behaviour).
  private async bootServer(): Promise<void> {
    track('session_start', { entry: getStartParam() ? 'challenge' : 'direct', start_param: getStartParam() });
    // Re-sync + flush pending wins whenever the app returns to the foreground
    // (Telegram may resume without a reload; the backend is warm by then).
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void this.onForeground(); });
    // Let the preloader wait for the first seed, but only briefly — a cold/offline
    // backend must NOT hang the whole feed. After the cap, proceed; the retry loop
    // + outbox reconcile in the background.
    const cap = window.setTimeout(() => this.settleServerSeed(), SERVER_SEED_CAP_MS);
    await this.bootSync();
    window.clearTimeout(cap);
    this.settleServerSeed();
  }

  // /session with backoff to survive a cold free Render instance (30–60s wake),
  // then flush any wins that a previous session couldn't persist (outbox).
  private async bootSync(): Promise<void> {
    const delays = [0, 2000, 5000, 10000, 15000];
    for (const d of delays) {
      if (d) await new Promise((r) => setTimeout(r, d));
      const s = await apiSession();
      if (!s) continue;
      this.applyServerBalance(s.balance);
      if (s.backend_version) { this.backendVersion = s.backend_version; this.renderVersionLabel(); }
      const b = await flushResults();
      if (b != null) this.applyServerBalance(b);
      return;
    }
    // Backend never answered in the window — onForeground() will retry.
  }

  // Foreground: push wins queued while away/offline, then re-read the balance.
  private async onForeground(): Promise<void> {
    const b = await flushResults();
    if (b != null) this.applyServerBalance(b);
    const m = await apiMe();
    if (m && typeof m.balance === 'number') this.applyServerBalance(m.balance);
  }

  // Bottom-bar version: platform build always; backend git SHA appended once the
  // caller is authenticated (from /session) — so you can see when the backend is
  // live with your latest push before testing changes.
  private renderVersionLabel(): void {
    if (!this.versionEl) return;
    const stamp = (typeof __PLATFORM_VERSION__ === 'string' ? __PLATFORM_VERSION__ : 'dev').slice(5);
    const api = this.backendVersion ? ` · api ${this.backendVersion}` : '';
    this.versionEl.textContent = `platform · ${stamp}${api}`;
  }

  // Apply a server balance WITHOUT clobbering optimistic local progress: if the
  // player won during a slow /session, totalStars already reflects it and the
  // server catches up next sync — so take the max (never flicker back).
  private applyServerBalance(balance: number): void {
    const next = Math.max(this.totalStars, balance);
    if (next === this.totalStars) return;
    this.totalStars = next;
    this.updateHud(false);
    this.renderLevelUpPage(false);
  }

  // Persist a manual win to the server (idempotent by run_id) — the ledger is the
  // source of truth for balance across sessions. Fire-and-forget; the local
  // counter already reflects the win optimistically.
  private reportResult(i: number, runId: string): void {
    const mechanicId = this.playables[i]?.id;
    if (!mechanicId) return;
    // Persist the SAME star count the reward row grants locally (rollReward = 1–5),
    // so the server balance matches the on-screen counter across reopen. Reading
    // rewardStarsFor here rolls it once; handleWin shows the same value.
    const stars = this.rewardStarsFor(i);
    // Durable: queue to localStorage + retry until the server confirms (survives
    // cold backend / reload). Idempotent by run_id server-side.
    queueResult({
      mechanic_id: mechanicId,
      variant_id: variantIdForMechanic(mechanicId),
      run_id: runId,
      metric_key: 'win',
      metric_value: 1,
      stars,
    });
  }

  // The on-screen unit changed (a swipe settled, or the first unit revealed).
  // Emits swipe_away for the unit we're leaving, then unit_shown for the new one.
  // unit_shown fires ONLY here (a REVEALED, on-screen unit) — never for a warmed
  // off-screen frame — so it stays an honest denominator (D3).
  private markUnitShown(cur: number): void {
    if (cur === this.shownIndex || cur < 0) return;
    const prev = this.shownIndex;
    if (prev >= 0) {
      const state = this.earnedThisCycle.has(prev) ? 'won'
        : this.failedThisCycle.has(prev) ? 'lost'
        : this.manualRuns.has(prev) ? 'playing' : 'autoplay';
      track('swipe_away', {
        mechanic_id: this.playables[prev]?.id,
        played: this.manualRuns.has(prev),
        state,
        ms_since_shown: Math.round(performance.now() - this.shownAt),
      });
    }
    this.shownIndex = cur;
    this.shownAt = performance.now();
    this.firstInputLogged = false;
    const id = this.playables[cur]?.id;
    track('unit_shown', {
      mechanic_id: id,
      variant_id: id ? variantIdForMechanic(id) : null,
      feed_pos: cur,
      mode: this.manualRuns.has(cur) ? 'playing' : 'auto',
    });
  }

  // ── Warm-cost telemetry ──────────────────────────────────────────────────
  // Answers "what exactly does the warm hitch cost, and at which boot stage"
  // on real devices, without devtools:
  //  - long-task observer on the host thread (shared with same-origin iframes),
  //    each task attributed to the warm window that was open when it ran;
  //  - per-mechanic boot-stage timings pushed by shared/bootstrap.ts
  //    ('boot_timings' messages: eval-done / mount / onInteractive).
  // Always collected (cheap); rendered as an on-screen overlay with ?perf=1.
  private bootTimingsLog = new Map<string, Record<string, unknown>>();
  private longTaskLog: { at: number; dur: number; warmId: string | null; src: string }[] = [];
  private perfOverlayEl: HTMLElement | null = null;
  private perfOverlayTextEl: HTMLElement | null = null;
  private perfDebug = new URLSearchParams(location.search).get('perf') === '1';
  // WebKit has no Long Tasks API — on iOS the counter would read as a
  // reassuring 0 forever. Track support so the overlay says "n/a" instead.
  private longTaskSupported = false;

  private initPerfTelemetry() {
    try {
      this.longTaskSupported =
        (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes?.includes('longtask') ?? false;
      // WebKit fallback: no Long Tasks API on iOS, but a main-thread stall is
      // still observable as a gap between consecutive host rAF callbacks. No
      // frame attribution — correlate the gap timestamps with the warm window
      // and the mechanics' boot_timings stages instead.
      if (!this.longTaskSupported) this.initFrameGapSampler();
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.duration < 50) continue;
          const warmId = this.warmIndex !== null ? this.playables[this.warmIndex]?.id ?? null : null;
          // TaskAttributionTiming (Chromium): which frame the task ran in —
          // separates "warm iframe boot" from "host/current-mechanic work"
          // that merely happened while a warm window was open.
          const att = (e as { attribution?: { containerSrc?: string }[] }).attribution?.[0];
          const src = att?.containerSrc ? (att.containerSrc.split('/').pop() ?? '').split('?')[0] : e.name;
          const entry = { at: Math.round(e.startTime), dur: Math.round(e.duration), warmId, src };
          this.longTaskLog.push(entry);
          if (this.longTaskLog.length > 300) this.longTaskLog.shift();
          if (warmId) console.warn(`[perf] ${entry.dur}ms long task during warm of ${warmId} (src: ${src})`);
          this.updatePerfOverlay();
        }
      });
      obs.observe({ entryTypes: ['longtask'] });
    } catch { /* longtask API missing (old webview) — boot timings still flow */ }
  }

  // rAF frame-gap sampler — WebKit's substitute for the long-task observer.
  // A gap ≥100ms between consecutive host rAF callbacks (~6 dropped frames at
  // 60Hz) means the shared main thread stalled: by a warm iframe boot, the
  // current mechanic, or the host itself. Entries share longTaskLog with
  // src='frame-gap'. Gaps spanning a hidden period are discarded (rAF stops
  // while hidden — that's not a stall).
  private lastRafT = 0;
  private initFrameGapSampler() {
    const FRAME_GAP_MS = 100;
    const tick = (now: number) => {
      if (this.lastRafT && !document.hidden) {
        const gap = now - this.lastRafT;
        if (gap >= FRAME_GAP_MS) {
          const warmId = this.warmIndex !== null ? this.playables[this.warmIndex]?.id ?? null : null;
          const entry = { at: Math.round(now - gap), dur: Math.round(gap), warmId, src: 'frame-gap' };
          this.longTaskLog.push(entry);
          if (this.longTaskLog.length > 300) this.longTaskLog.shift();
          if (warmId) console.warn(`[perf] ${entry.dur}ms frame gap during warm of ${warmId}`);
          this.updatePerfOverlay();
        }
      }
      this.lastRafT = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', () => { this.lastRafT = 0; });
  }

  // Host-clock warm timeline per playable id: when the iframe was appended,
  // when its load event fired, when it was revealed. Same clock as the
  // frame-gap/long-task log, so a stall lands on a concrete interval.
  private warmTimeline = new Map<string, Record<string, number>>();

  private markWarmTimeline(i: number, key: 'appendAt' | 'loadAt' | 'revealAt') {
    const id = this.playables[i]?.id;
    if (!id) return;
    const t = this.warmTimeline.get(id) ?? {};
    t[key] = Math.round(performance.now());
    this.warmTimeline.set(id, t);
  }

  private handleBootTimings(i: number, data: Record<string, unknown>) {
    const id = this.playables[i]?.id ?? `#${i}`;
    const timings = { ...(data.timings as Record<string, number>) };
    // Convert iframe-clock stage timestamps (fields ending in "At") into the
    // HOST clock via the difference of the two timeOrigins — puts boot stages
    // and the frame-gap log on one axis.
    if (typeof timings.timeOrigin === 'number' && timings.timeOrigin > 0 && performance.timeOrigin) {
      const offset = timings.timeOrigin - performance.timeOrigin;
      for (const [k, v] of Object.entries(timings)) {
        if (k.endsWith('At') && typeof v === 'number') timings[`host_${k}`] = Math.round(v + offset);
      }
    }
    const merged = { ...(this.bootTimingsLog.get(id) ?? {}), ...timings, stage: data.stage as never };
    this.bootTimingsLog.set(id, merged);
    console.log(`[perf] boot ${id} [${String(data.stage)}]`, merged);
    this.updatePerfOverlay();
  }

  // Full untruncated report — what the overlay's copy button puts on the
  // clipboard (the overlay itself clips long lines on narrow screens).
  private perfReport(): string {
    const warmTasks = this.longTaskLog.filter((t) => t.warmId);
    const worst = warmTasks.reduce((m, t) => Math.max(m, t.dur), 0);
    const lines: string[] = [
      `[perf] ${new Date().toISOString()}`,
      navigator.userAgent,
      this.longTaskSupported
        ? `long>50ms: ${this.longTaskLog.length} | during warm: ${warmTasks.length} | worst warm: ${worst}ms`
        : `frame-gaps≥100ms (rAF fallback, no Long Tasks API): ${this.longTaskLog.length} | during warm: ${warmTasks.length} | worst warm: ${worst}ms`,
      '',
      '── boot timings per mechanic ──',
    ];
    for (const [id, t] of this.bootTimingsLog) {
      lines.push(`${id}: ${JSON.stringify(t)}`);
      // Host-clock warm timeline — directly comparable with the long-task /
      // frame-gap timestamps above. host_* fields inside the JSON are the
      // iframe's own boot stages converted to the same clock.
      const wt = this.warmTimeline.get(id);
      if (wt) lines.push(`  host timeline: append@${wt.appendAt ?? '?'} load@${wt.loadAt ?? '?'} reveal@${wt.revealAt ?? '?'}`);
    }
    if (this.longTaskLog.length) {
      lines.push('', '── long tasks (>50ms) ──');
      for (const t of this.longTaskLog) {
        lines.push(`at ${t.at}ms: ${t.dur}ms src=${t.src}${t.warmId ? ` DURING WARM of ${t.warmId}` : ''}`);
      }
    }
    return lines.join('\n');
  }

  private copyPerfReport(btn: HTMLElement) {
    const text = this.perfReport();
    const done = (ok: boolean) => {
      btn.textContent = ok ? 'copied ✓' : 'copy';
      window.setTimeout(() => { btn.textContent = 'copy'; }, 1500);
      // Clipboard blocked (Telegram/older webviews) — show the report in a
      // selectable textarea so it can be copied by hand. Never dead-ends.
      if (!ok) this.showPerfReportSheet(text);
    };
    // Clipboard API needs a secure context + user gesture (we're in one — this
    // is a tap handler). Legacy execCommand fallback for older webviews.
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(this.copyViaTextarea(text)));
    } else {
      done(this.copyViaTextarea(text));
    }
  }

  // Fullscreen selectable report — manual copy fallback when both clipboard
  // paths are unavailable. Tap-to-select-all; close button dismisses.
  private showPerfReportSheet(text: string) {
    const wrap = document.createElement('div');
    // Safe-area padding + controls at the BOTTOM — the top edge hides under
    // the notch/status bar where taps don't register.
    wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.88);display:flex;flex-direction:column;gap:8px;padding:calc(env(safe-area-inset-top, 0px) + 12px) 12px calc(env(safe-area-inset-bottom, 0px) + 12px);';
    const close = document.createElement('button');
    close.textContent = 'close';
    close.style.cssText = 'align-self:flex-start;background:#c33;border:0;border-radius:6px;color:#fff;font:bold 14px monospace;padding:10px 22px;';
    close.addEventListener('click', () => wrap.remove());
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.readOnly = true;
    ta.style.cssText = 'flex:1;background:#111;color:#9f9;font:11px/1.4 monospace;border:1px solid #444;border-radius:6px;padding:8px;white-space:pre;resize:none;';
    ta.addEventListener('focus', () => ta.select());
    wrap.appendChild(ta);
    wrap.appendChild(close);
    document.body.appendChild(wrap);
    ta.focus();
    ta.select();
  }

  private copyViaTextarea(text: string): boolean {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  private updatePerfOverlay() {
    if (!this.perfDebug) return;
    if (!this.perfOverlayEl) {
      const el = document.createElement('div');
      // pointer-events:none on the panel so it never eats game taps. The copy
      // button lives at the BOTTOM-left as its own fixed element — the top of
      // the screen sits under the notch/status bar where taps don't land.
      el.style.cssText = 'position:fixed;left:4px;top:4px;z-index:99999;background:rgba(0,0,0,0.72);color:#9f9;font:10px/1.5 monospace;padding:6px 8px;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere;max-width:92vw;overflow:hidden;border-radius:6px;';
      const btn = document.createElement('button');
      btn.textContent = 'copy';
      btn.style.cssText = 'position:fixed;left:8px;bottom:calc(env(safe-area-inset-bottom, 0px) + 72px);z-index:99999;pointer-events:auto;background:#1c4;border:0;border-radius:6px;color:#fff;font:bold 13px monospace;padding:8px 16px;box-shadow:0 2px 8px rgba(0,0,0,0.4);';
      btn.addEventListener('click', () => this.copyPerfReport(btn));
      const txt = document.createElement('div');
      el.appendChild(txt);
      document.body.appendChild(el);
      document.body.appendChild(btn);
      this.perfOverlayEl = el;
      this.perfOverlayTextEl = txt;
    }
    const warmTasks = this.longTaskLog.filter((t) => t.warmId);
    const worst = warmTasks.reduce((m, t) => Math.max(m, t.dur), 0);
    const lines: string[] = [
      this.longTaskSupported
        ? `long>50ms: ${this.longTaskLog.length} | during warm: ${warmTasks.length} | worst warm: ${worst}ms`
        : `gaps≥100ms: ${this.longTaskLog.length} | warm: ${warmTasks.length} | worst: ${worst}ms (rAF)`,
    ];
    for (const [id, t] of this.bootTimingsLog) {
      const net = typeof t.responseEndAt === 'number' ? t.responseEndAt : '?';
      lines.push(`${id}: net→${net} eval→${t.evalDoneAt ?? '?'} mount ${t.mountMs ?? '?'}ms inter ${t.onInteractiveMs ?? '—'}ms`);
    }
    if (this.perfOverlayTextEl) this.perfOverlayTextEl.textContent = lines.slice(0, 14).join('\n');
  }

  // Camcorder-style running timecode on the video reel. Counts up while a mechanic
  // is shown; resets when the shown mechanic changes. One cheap text update/sec.
  private reelTimeIndex = -1;
  private reelTimeSeconds = 0;
  private tickReelTimecode = () => {
    if (document.hidden) return;
    const i = this.realIndex();
    if (i !== this.reelTimeIndex) { this.reelTimeIndex = i; this.reelTimeSeconds = 0; }
    else this.reelTimeSeconds++;
    const s = this.reelTimeSeconds;
    const txt = `0:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    const el = this.games[i]?.querySelector<HTMLElement>('.game__reel-time');
    if (el && el.textContent !== txt) el.textContent = txt;
  };

  private realIndex(): number {
    return this.indexForPos(this.pos);
  }

  private indexForPos(pos: number): number {
    return ((Math.round(pos) % this.N) + this.N) % this.N;
  }

  // ── Build DOM ──────────────────────────────────────────────────────────
  private build() {
    const frag = document.createDocumentFragment();
    this.playables.forEach((p, i) => {
      const page = document.createElement('div');
      page.className = 'page';

      const game = document.createElement('div');
      game.className = 'game game--loading';

      const slot = document.createElement('div');
      slot.className = 'game__slot';
      game.appendChild(slot);

      // Start-screen poster — HOST-document pixels shown while this page is
      // not live yet, so the swipe carries a real start screen even though
      // both Chromium and WebKit refuse to rasterise an off-screen iframe's
      // layer (Telegram webviews included). Hidden one-way via .game--live
      // once the mechanic is current + revealed + un-paused; re-shown on
      // remount (resetFrameReadiness).
      const poster = document.createElement('img');
      poster.className = 'game__poster';
      poster.draggable = false;
      poster.src = coverSrc(p.id);
      // No cover art shipped → the standard platform card (data URI, can't fail).
      poster.addEventListener('error', () => { poster.src = RIDE_PLACEHOLDER_SRC; }, { once: true });
      // INSIDE the slot: the poster then shares the iframe's exact box AND the
      // autoplay "footage frame" scale (.game--autoplay .game__slot 0.92), so
      // it never reads bigger than the mechanic it stands in for.
      slot.appendChild(poster);

      const spinner = document.createElement('div');
      spinner.className = 'game__spinner';
      game.appendChild(spinner);

      const label = document.createElement('div');
      label.className = 'game__label';
      label.textContent = p.id;
      game.appendChild(label);

      // Reward badge (top-left): the single star this mechanic awards on a win.
      const reward = document.createElement('div');
      reward.className = 'game__reward';
      game.appendChild(reward);
      this.rewardEls[i] = reward;

      // Full-screen dim over the GAME AREA (inset above the swipe bar) shown only
      // while autoplay runs — a "this is a demo" veil that also captures tap-anywhere
      // to take over. The label itself lives in the swipe bar below.
      const autoplay = document.createElement('div');
      autoplay.className = 'game__autoplay';
      autoplay.dataset.autoplayIndex = String(i);
      this.attachSwipeSurface(autoplay);
      game.appendChild(autoplay);

      // The bottom bar is now a single FIXED element (mountFeedBar) that doesn't page
      // with the mechanics — the per-game slot is still inset by --swipebar-h to leave
      // room for it. Here we only keep the per-mechanic hint text floating above it.
      const swipeHint = document.createElement('div');
      swipeHint.className = 'game__swipehint';
      swipeHint.textContent = 'tap to play or swipe';
      game.appendChild(swipeHint);
      this.swipebarTextEls[i] = swipeHint;

      // Close (×) — shown only in manual play (see .game--manual). Tapping it
      // advances to the next mechanic, like a swipe.
      const close = document.createElement('button');
      close.className = 'game__close';
      close.type = 'button';
      close.setAttribute('aria-label', 'Next mechanic');
      close.textContent = '✕';
      close.addEventListener('pointerdown', (e) => e.stopPropagation());
      close.addEventListener('click', (e) => { e.stopPropagation(); this.advanceToNext(); });
      game.appendChild(close);

      // "Footage reel" chrome shown during autoplay (see .game--autoplay): camera
      // viewfinder corner brackets + a blinking REC/play indicator, so a demo reads
      // as a clip playing. Purely decorative (pointer-events: none).
      const reel = document.createElement('div');
      reel.className = 'game__reel';
      reel.innerHTML =
        '<span class="game__reel-scan"></span>' +
        '<span class="game__reel-corner game__reel-corner--tl"></span>' +
        '<span class="game__reel-corner game__reel-corner--tr"></span>' +
        '<span class="game__reel-corner game__reel-corner--bl"></span>' +
        '<span class="game__reel-corner game__reel-corner--br"></span>' +
        '<span class="game__reel-rec"><span class="game__reel-play">▶</span></span>' +
        '<span class="game__reel-time">0:00:00</span>';
      game.appendChild(reel);

      const state = document.createElement('div');
      state.className = 'game__state';
      state.hidden = true;
      this.attachRewardSwipe(state);
      game.appendChild(state);

      page.appendChild(game);

      // Legacy bottom swipe component, kept commented while swipe lives on
      // autoplay/reward/level-up overlays instead.
      // const gutter = this.makeGutter(i);
      // page.appendChild(gutter);

      frag.appendChild(page);

      this.pageEls[i] = page;
      this.games[i] = game;
      // this.gutters[i] = gutter;
      this.slots[i] = slot;
      this.stateEls[i] = state;
      this.autoplayEls[i] = autoplay;
      this.labelEls[i] = label;
    });
    this.feedEl.appendChild(frag);
  }

  // Single FIXED bottom bar — lives at the feed's bottom and does NOT page with the
  // mechanics (the per-game slots reserve --swipebar-h of space above it). A centered
  // button advances to the next mechanic.
  private mountFeedBar() {
    const bar = document.createElement('div');
    bar.className = 'feed-bar';
    // Cosmetic tab switcher (no functionality yet): a row of simple line-drawn
    // geometric icons. Tapping one makes it active — a soft translucent pill
    // slides under it. Paging is via swipe (attachSwipeSurface below); these
    // icons don't page. Shapes kept elementary on purpose.
    const SWITCH_SHAPES: [string, string][] = [
      ['circle',   '<circle cx="12" cy="12" r="8"/>'],
      ['square',   '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/>'],
      ['triangle', '<path d="M12 3.5 L20.5 19 L3.5 19 Z"/>'],
      ['diamond',  '<path d="M12 3 L21 12 L12 21 L3 12 Z"/>'],
    ];
    const switcher = document.createElement('div');
    switcher.className = 'feed-bar__switch';
    switcher.setAttribute('role', 'tablist');
    SWITCH_SHAPES.forEach(([name, inner], idx) => {
      const icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'feed-bar__icon' + (idx === 0 ? ' feed-bar__icon--active' : '');
      icon.setAttribute('aria-label', name);
      icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
      icon.addEventListener('pointerdown', (e) => e.stopPropagation());
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        switcher.querySelectorAll('.feed-bar__icon--active').forEach((el) => el.classList.remove('feed-bar__icon--active'));
        icon.classList.add('feed-bar__icon--active');
      });
      switcher.appendChild(icon);
    });
    bar.appendChild(switcher);
    // Platform build stamp, bottom-left of the bar — so it's clear which platform
    // build is live (mechanics carry their own badge in their bottom-left corner).
    const ver = document.createElement('div');
    ver.className = 'feed-bar__version';
    ver.style.cssText = 'position:absolute;left:10px;bottom:calc(env(safe-area-inset-bottom,0px) + 6px);' +
      "font:600 10px/1.2 -apple-system,system-ui,sans-serif;color:rgba(255,255,255,0.62);" +
      'letter-spacing:0.2px;pointer-events:none;white-space:nowrap;';
    bar.appendChild(ver);
    this.versionEl = ver;
    this.renderVersionLabel();
    // Make the bar itself a paging swipe surface. On Android a swipe that STARTS
    // over the bottom bar (thumb from the bottom) otherwise fell through to the
    // browser → URL-bar collapse → the feed reflows (bar "grows") and the first
    // swipe is consumed. attachSwipeSurface skips the button (tap still advances),
    // and .feed-bar has touch-action:none (styles.css) so the browser never scrolls.
    this.attachSwipeSurface(bar);
    this.feedEl.appendChild(bar);
  }

  // private makeGutter(i: number): HTMLElement {
  //   const gutter = document.createElement('div');
  //   gutter.className = 'gutter';
  //   gutter.dataset.index = String(i);
  //   gutter.innerHTML =
  //     '<div class="gutter__grip"></div>' +
  //     '<div class="gutter__label"><span class="gutter__chev">▲</span> Swipe up for next game</div>';
  //   this.attachGutter(gutter);
  //   return gutter;
  // }

  private mountHud() {
    const hud = document.createElement('div');
    const friendStories = this.friends.map((f, idx) => this.friendStoryMarkup(f, idx)).join('');
    hud.className = 'hud';
    hud.innerHTML =
      '<div class="stories" aria-label="Friends">' +
        '<div class="story story--me">' +
          '<div class="hud__level" aria-label="Level progress">' +
            '<div class="hud__level-ring"></div>' +
            '<div class="hud__level-core"><span class="hud__level-value">1</span></div>' +
            '<span class="hud__level-plus" aria-hidden="true"></span>' +
          '</div>' +
          '<div class="story__name">You</div>' +
        '</div>' +
        friendStories +
      '</div>';
    this.viewport.appendChild(hud);
    this.hudEl = hud;
    this.levelBadgeEl = hud.querySelector('.hud__level');
    this.levelEl = hud.querySelector('.hud__level-value');
    this.levelProgressEl = hud.querySelector('.hud__level-ring');
    const stories = hud.querySelector<HTMLElement>('.stories');
    this.storiesEl = stories;
    if (stories) this.attachStoryScroller(stories);
  }

  private friendStoryMarkup(f: { name: string; initial: string; tone: string }, idx: number): string {
    const viewed = this.viewedFriends.has(idx) ? ' story__avatar--viewed' : '';
    return (
      `<div class="story" data-friend="${idx}">` +
        `<div class="story__avatar story__avatar--${f.tone}${viewed}"><span>${f.initial}</span></div>` +
        `<div class="story__name">${f.name}</div>` +
      `</div>`
    );
  }

  private attachStoryScroller(scroller: HTMLElement) {
    let tracking = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    let lastScrollLeft = 0;
    let lastMoveT = 0;
    let scrollVelocity = 0;
    const dragIntentPx = 6;
    const minFlingVelocity = 0.06; // px/ms
    const maxFlingVelocity = 1.2;

    const updateMask = () => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      this.hudEl?.classList.toggle('hud--stories-can-left', scroller.scrollLeft > 1);
      this.hudEl?.classList.toggle('hud--stories-can-right', scroller.scrollLeft < maxScroll - 1);
    };

    const startMomentum = (initialVelocity: number) => {
      this.stopStoriesMomentum();
      let velocity = Math.max(-maxFlingVelocity, Math.min(maxFlingVelocity, initialVelocity));
      let previousT = performance.now();

      const step = (now: number) => {
        const dt = Math.min(32, now - previousT);
        previousT = now;
        const maxScroll = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const before = scroller.scrollLeft;
        scroller.scrollLeft = Math.max(0, Math.min(maxScroll, before + velocity * dt));
        updateMask();

        const hitEdge = scroller.scrollLeft === before && ((before <= 0 && velocity < 0) || (before >= maxScroll && velocity > 0));
        velocity *= Math.pow(0.88, dt / 16.67);
        if (hitEdge || Math.abs(velocity) < 0.022) {
          this.storiesMomentumFrame = null;
          return;
        }
        this.storiesMomentumFrame = requestAnimationFrame(step);
      };

      this.storiesMomentumFrame = requestAnimationFrame(step);
    };

    const endDrag = (e: PointerEvent) => {
      if (!tracking && !dragging) return;
      const wasTap = tracking && !dragging;   // pressed without horizontal drag = a tap
      const shouldFling = dragging && e.type === 'pointerup' && Math.abs(scrollVelocity) >= minFlingVelocity;
      tracking = false;
      dragging = false;
      scroller.classList.remove('stories--dragging');
      try { scroller.releasePointerCapture(e.pointerId); } catch { /* noop */ }
      if (shouldFling) startMomentum(scrollVelocity);
      if (!wasTap) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.hud__level-plus')) { this.openEditor(); return; }
      const storyEl = t?.closest?.('.story[data-friend]') as HTMLElement | null;
      if (storyEl) this.openStory(Number(storyEl.dataset.friend));
    };

    scroller.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      this.stopStoriesMomentum();
      tracking = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = scroller.scrollLeft;
      lastScrollLeft = startScrollLeft;
      lastMoveT = e.timeStamp;
      scrollVelocity = 0;
    });

    scroller.addEventListener('pointermove', (e) => {
      if (!tracking) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dx) < dragIntentPx && Math.abs(dy) < dragIntentPx) return;
        if (Math.abs(dx) <= Math.abs(dy)) {
          tracking = false;
          return;
        }
        dragging = true;
        scroller.classList.add('stories--dragging');
        scroller.setPointerCapture(e.pointerId);
      }
      e.preventDefault();
      scroller.scrollLeft = startScrollLeft - dx;
      const dt = e.timeStamp - lastMoveT;
      if (dt > 0) {
        scrollVelocity = (scroller.scrollLeft - lastScrollLeft) / dt;
        lastScrollLeft = scroller.scrollLeft;
        lastMoveT = e.timeStamp;
      }
    });

    scroller.addEventListener('scroll', updateMask, { passive: true });
    scroller.addEventListener('pointerup', endDrag);
    scroller.addEventListener('pointercancel', endDrag);
    scroller.addEventListener('lostpointercapture', endDrag);
    window.addEventListener('resize', updateMask);
    requestAnimationFrame(updateMask);
  }

  private resetStoriesToMyLevel() {
    if (!this.storiesEl) return;
    this.stopStoriesMomentum();
    this.storiesEl.scrollLeft = 0;
    this.hudEl?.classList.remove('hud--stories-can-left');
    this.hudEl?.classList.toggle('hud--stories-can-right', this.storiesEl.scrollWidth > this.storiesEl.clientWidth + 1);
  }

  private stopStoriesMomentum() {
    if (this.storiesMomentumFrame === null) return;
    cancelAnimationFrame(this.storiesMomentumFrame);
    this.storiesMomentumFrame = null;
  }

  // ── Ring rendering ─────────────────────────────────────────────────────────
  // Position every page relative to `pos`, wrapping the offset into (-N/2, N/2]
  // so far pages cross to the other side off-screen (the infinite loop). A page
  // that wraps this frame gets no transition so it never visibly streaks across.
  private render(animate: boolean) {
    const N = this.N;
    for (let i = 0; i < N; i++) {
      let delta = ((i - this.pos) % N + N) % N;   // [0, N)
      if (delta > N / 2) delta -= N;              // (-N/2, N/2]
      const prev = this.pageDelta[i];
      const wrapped = prev !== undefined && Math.abs(delta - prev) > N / 2;
      const pg = this.pageEls[i];
      const near = this.liveHold.has(i) || (delta > -0.05 && delta <= 1.55);
      const wasNear = this.pageNearState[i] === true;
      const shouldTouchDom = near || wasNear || prev === undefined || animate;

      if (shouldTouchDom) {
        const transition = animate && !wrapped ? 'transform 0.36s var(--ease-snap)' : 'none';
        // PEEK: keep the NEXT page 56px inside the viewport, hidden under the
        // opaque fixed feed bar (58px + safe-area). An iframe fully outside
        // the viewport is render-throttled by Chromium — its layer is never
        // rasterised, so a swipe used to reveal a BLACK rectangle until the
        // browser finished the first full paint mid-slide, defeating
        // warm-paint entirely. A deeper peek also pre-rasterises enough tiles
        // that the slide doesn't checkerboard. Scales in with delta so
        // dragging never sees a jump.
        const peek = 56 * Math.min(Math.max(delta, 0), 1);
        // Live ride: while nothing moves, the ready NEXT page parks at 0 in
        // the viewport (under the current page — its z is lower), so its live
        // iframe stays rendered+rasterised; any gesture/slide recomputes the
        // normal offset on the next render() (an instant, invisible teleport
        // that the raster survives).
        const parkedInViewport = !this.dragging && this.settlingTargetIndex === null
          && delta > 0.5 && delta < 1.5 && this.liveRideOk(i);
        const transform = parkedInViewport
          ? 'translate3d(0, 0, 0)'
          : `translate3d(0, ${delta * this.pageH - peek}px, 0)`;
        const zIndex = String(1000 - Math.round(Math.abs(delta) * 10));
        const visible = near;
        const inViewport = delta > -0.98 && delta < 0.98;

        if (this.pageTransitionState[i] !== transition) {
          pg.style.transition = transition;
          this.pageTransitionState[i] = transition;
        }
        if (this.pageTransformState[i] !== transform) {
          pg.style.transform = transform;
          this.pageTransformState[i] = transform;
        }
        if (this.pageZState[i] !== zIndex) {
          pg.style.zIndex = zIndex;
          this.pageZState[i] = zIndex;
        }
        if (this.pageVisibilityState[i] !== visible) {
          pg.style.visibility = visible ? 'visible' : 'hidden';
          this.pageVisibilityState[i] = visible;
        }
        if (this.pageNearState[i] !== near) {
          pg.classList.toggle('page--near', near);
          this.pageNearState[i] = near;
        }
        if (this.pageInViewportState[i] !== inViewport) {
          pg.classList.toggle('page--in-viewport', inViewport);
          this.pageInViewportState[i] = inViewport;
        }
      } else if (this.pageVisibilityState[i] !== false) {
        pg.style.visibility = 'hidden';
        this.pageVisibilityState[i] = false;
      }
      this.pageDelta[i] = delta;
    }
    this.driveIncoming(animate);
    this.renderLevelUpPage(animate);
  }

  private renderLevelUpPage(animate: boolean) {
    const page = this.levelUpPageEl;
    if (!page) return;
    const progress = Math.max(0, Math.min(1, this.pos - this.levelUpPageBasePos));
    let delta = 1 - progress;
    if (this.levelUpPageState === 'settled') {
      delta = this.dragging && this.dragMode === 'levelup' ? -progress : 0;
    } else if (this.levelUpPageState === 'leaving') {
      delta = -progress;
    }
    page.style.transition = animate ? 'transform 0.36s var(--ease-snap)' : 'none';
    page.style.transform = `translate3d(0, ${delta * this.pageH}px, 0)`;
    page.style.visibility = 'visible';
  }

  private syncSettlingPositionToVisual(): number {
    if (this.settlingTargetIndex === null || this.pageH <= 0) return this.pos;
    const targetPage = this.pageEls[this.settlingTargetIndex];
    const y = this.currentTranslateY(targetPage);
    if (!Number.isFinite(y)) return this.pos;
    this.pos = this.pos - y / this.pageH;
    this.settlingTargetIndex = null;
    this.render(false);
    return this.pos;
  }

  private currentTranslateY(el: HTMLElement | undefined): number {
    if (!el) return 0;
    try {
      const transform = getComputedStyle(el).transform;
      if (!transform || transform === 'none') return 0;
      return new DOMMatrixReadOnly(transform).m42;
    } catch {
      return 0;
    }
  }

  private previewRewardLevel(): number {
    return this.levelForStars(this.totalStars + this.rewardStarsFor(this.realIndex()));
  }

  private levelUpMarkup(level: number): string {
    return '<div class="levelup__card">' +
      '<div class="levelup__kicker">LEVEL UP</div>' +
      '<div class="levelup__badge"><span class="levelup__star">★</span><span class="levelup__num">' + level + '</span></div>' +
      '<div class="levelup__title">Level ' + level + '</div>' +
    '</div>' +
    '<div class="levelup__hint">tap or swipe for next game</div>';
  }

  private prepareLevelUpPage(level: number, basePos: number) {
    this.removeLevelUpPage();
    this.levelUpPageBasePos = basePos;
    this.levelUpPageState = 'entering';
    const page = document.createElement('div');
    page.className = 'levelup levelup--page';
    page.innerHTML = this.levelUpMarkup(level);
    this.feedEl.appendChild(page);
    this.levelUpPageEl = page;
    this.attachSwipeSurface(page, () => this.levelUpPageState === 'settled');
    this.spawnConfetti(page);
    this.renderLevelUpPage(false);
  }

  private animateLevelUpPageIn() {
    if (!this.levelUpPageEl) return;
    this.levelUpPageState = 'entering';
    this.pos = this.levelUpPageBasePos + 1;
    this.render(true);
  }

  private settleLevelUpPage() {
    if (!this.levelUpPageEl) return;
    this.levelUpPageState = 'settled';
    this.pos = this.levelUpPageBasePos;
    this.liveHold = new Set([this.indexForPos(this.levelUpPageBasePos)]);
    this.render(false);
    this.updateLive();
    this.applyActiveStates();
  }

  private removeLevelUpPage() {
    if (!this.levelUpPageEl) {
      this.levelUpPageState = 'idle';
      return;
    }
    this.stopConfetti();
    this.levelUpPageEl.remove();
    this.levelUpPageEl = null;
    this.levelUpPageState = 'idle';
  }

  // ── Incoming-poster ride ────────────────────────────────────────────────
  // The only way to show the next mechanic RIDING in: browsers rasterise
  // lazily outside the viewport — iframe layers AND host page layers alike —
  // so anything parked at translateY(pageH) arrives as an empty rectangle no
  // matter what it contains (measured frame-by-frame; will-change doesn't
  // extend the tile interest area far enough). This layer PERMANENTLY lives
  // at translateY(0) inside the viewport, hidden UNDER the opaque current
  // page (z:1), so its raster always exists. On slide/drag it teleports to
  // the arriving page's offset (raster survives transform changes) and
  // mirrors the page's transform/transition ABOVE the pages (z:1010, under
  // the feed bar). At settle it parks back under the arrived page, whose
  // in-slot poster shows the identical pixels — seamless handoff.
  private incomingEl!: HTMLElement;
  private incomingImg!: HTMLImageElement;
  private incomingIndex = -1;
  private incomingPosterOk = false;

  private buildIncoming() {
    const el = document.createElement('div');
    el.className = 'incoming-poster';
    const img = document.createElement('img');
    img.draggable = false;
    img.addEventListener('load', () => { this.incomingPosterOk = true; });
    // No cover art → the standard platform card (data URI — its own load
    // event re-arms incomingPosterOk, so the ride is never disabled).
    img.addEventListener('error', () => {
      this.incomingPosterOk = false;
      if (img.src !== RIDE_PLACEHOLDER_SRC) img.src = RIDE_PLACEHOLDER_SRC;
    });
    el.appendChild(img);
    this.feedEl.appendChild(el);
    this.incomingEl = el;
    this.incomingImg = img;
  }

  /** Point the resident layer at the NEXT mechanic's poster and copy the
   *  arriving page's slot box (page-local, includes the autoplay 0.92 scale). */
  private updateIncomingPoster() {
    if (!this.incomingEl) return;
    const next = (this.realIndex() + 1) % this.N;
    if (next === this.incomingIndex) return;
    this.incomingIndex = next;
    this.incomingPosterOk = false;
    this.incomingImg.src = coverSrc(this.playables[next].id);
    const game = this.games[next];
    const slot = game?.querySelector<HTMLElement>('.game__slot');
    if (game && slot) {
      // UNSCALED layout box via offset* (transforms don't affect it), then
      // replicate the autoplay footage-frame scale explicitly — an arriving
      // page is always in autoplay-preview, but its game--autoplay class may
      // land AFTER this measurement, so reading getBoundingClientRect here
      // raced it and the poster rode in 8% larger than the mechanic
      // (.game--autoplay .game__slot { transform: scale(0.92) } — keep in
      // sync with styles.css).
      this.incomingImg.style.top = `${game.offsetTop + slot.offsetTop}px`;
      this.incomingImg.style.left = `${game.offsetLeft + slot.offsetLeft}px`;
      this.incomingImg.style.width = `${slot.offsetWidth}px`;
      this.incomingImg.style.height = `${slot.offsetHeight}px`;
      this.incomingImg.style.transform = 'scale(0.92)';
      this.incomingImg.style.transformOrigin = '50% 50%';
    }
  }

  /** Mirror the arriving page's motion during a drag or an animated slide;
   *  park under the pages otherwise. Called at the end of every render(). */
  private driveIncoming(animate: boolean) {
    if (!this.incomingEl) return;
    // Under ?livein=1 the live iframe rides instead of the cover.
    if (this.liveRideOk(this.incomingIndex)) return;
    const i = this.incomingIndex;
    const delta = i >= 0 ? this.pageDelta[i] : undefined;
    const riding = i >= 0 && this.incomingPosterOk && delta !== undefined && (
      (this.dragging && delta > 0.001 && delta < 1.2) ||
      (animate && this.settlingTargetIndex === i)
    );
    if (riding) {
      this.incomingEl.style.zIndex = '1010';
      this.incomingEl.style.transition = this.pageTransitionState[i] || 'none';
      this.incomingEl.style.transform = this.pageTransformState[i] || 'translate3d(0, 0, 0)';
    } else if (!this.dragging && this.settlingTargetIndex === null) {
      this.incomingEl.style.zIndex = '1';
      this.incomingEl.style.transition = 'none';
      this.incomingEl.style.transform = 'translate3d(0, 0, 0)';
    }
  }

  // ── Live window (instantiate neighbours, tear down the far ones) ───────────
  private liveSet(): Set<number> {
    const s = new Set<number>(this.liveHold);
    s.add(this.realIndex());
    if (this.warmIndex !== null) s.add(this.warmIndex);
    for (let d = -LIVE_BEHIND; d <= LIVE_AHEAD; d++) {
      s.add(((this.realIndex() + d) % this.N + this.N) % this.N);
    }
    return s;
  }

  private updateLive() {
    const live = this.liveSet();
    for (let i = 0; i < this.N; i++) {
      if (live.has(i)) this.mount(i);
      else this.unmount(i);
    }
  }

  private mount(i: number) {
    if (this.frames.has(i)) return;
    this.rollReward(i);
    this.resetFrameReadiness(i);
    this.games[i].classList.add('game--loading');
    this.games[i].classList.remove('game--ready');
    const frame = document.createElement('iframe');
    frame.className = 'game__frame';
    frame.dataset.runId = runUid();
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('title', this.playables[i].id);
    frame.setAttribute('allow', 'autoplay');
    frame.addEventListener('load', () => {
      if (this.frames.get(i) !== frame) return;
      this.markWarmTimeline(i, 'loadAt');
      this.disableFrameDoubleTapZoom(frame);
      this.frameLoaded.add(i);
      this.setFramePaused(i, this.shouldPauseFrame(i));
      this.queueFrameReadyFallback(i, frame);
      this.tryRevealFrame(i);
      this.ensureFrameAutoPlay(i);
      this.applyPendingEditor(i);
    });
    this.frames.set(i, frame);
    frame.src = playableUrl(this.playables[i].id, {
      hostPaused: this.shouldPauseFrame(i),
      auto: !this.manualRuns.has(i),
    });
    this.warmTimeline.delete(this.playables[i].id);   // fresh run — drop the previous mount's marks
    this.markWarmTimeline(i, 'appendAt');
    this.slots[i].appendChild(frame);
  }

  private unmount(i: number) {
    const frame = this.frames.get(i);
    if (!frame) return;
    const runId = frame.dataset.runId;
    if (runId) this.completedRunIds.delete(runId);
    this.clearAutoplayLoopTimer(i);
    this.disposeFrame(i, frame);
    this.frames.delete(i);
    this.resetFrameReadiness(i);
    this.stopRewardSparks(i);
    this.games[i].classList.add('game--loading');
    this.games[i].classList.remove('game--ready');
  }

  private disposeFrame(i: number, frame: HTMLIFrameElement) {
    try { this.setFramePaused(i, true); } catch { /* noop */ }
    try { this.stopFrameAutoPlay(i); } catch { /* noop */ }
    try { frame.src = 'about:blank'; } catch { /* noop */ }
    frame.remove();
  }

  private disableFrameDoubleTapZoom(frame: HTMLIFrameElement) {
    try {
      const doc = frame.contentDocument;
      if (!doc) return;

      let meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
      if (!meta) {
        meta = doc.createElement('meta');
        meta.name = 'viewport';
        doc.head?.appendChild(meta);
      }
      const content = meta.getAttribute('content') || 'width=device-width, initial-scale=1.0';
      const baseContent = content
        .replace(/\s*,?\s*user-scalable\s*=\s*[^,\s]+/gi, '')
        .replace(/\s*,?\s*maximum-scale\s*=\s*[^,\s]+/gi, '')
        .replace(/,\s*,/g, ',')
        .replace(/^\s*,|,\s*$/g, '')
        .trim() || 'width=device-width, initial-scale=1.0';
      meta.setAttribute('content', `${baseContent}, user-scalable=no, maximum-scale=1.0`);

      if (doc.getElementById('feed-host-touch-guard')) return;
      const style = doc.createElement('style');
      style.id = 'feed-host-touch-guard';
      style.textContent = 'html,body,canvas,#app,#root{touch-action:manipulation;-webkit-tap-highlight-color:transparent;}';
      doc.head?.appendChild(style);
    } catch {
      /* cross-origin mechanics keep their own viewport policy */
    }
  }

  private resetFrameReadiness(i: number) {
    this.frameLoaded.delete(i);
    this.frameReady.delete(i);
    this.frameRevealed.delete(i);
    this.framePaused.delete(i);
    const fallbackTimer = this.frameFallbackTimers.get(i);
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    this.frameFallbackTimers.delete(i);
    const revealTimer = this.frameRevealTimers.get(i);
    if (revealTimer) window.clearTimeout(revealTimer);
    this.frameRevealTimers.delete(i);
    // Fresh mount → the cover fronts the page again until this run goes live
    // (see the .game--live toggle in pollAutoplayUi).
    this.games[i]?.classList.remove('game--live');
  }

  private queueFrameReadyFallback(i: number, frame: HTMLIFrameElement) {
    const previous = this.frameFallbackTimers.get(i);
    if (previous) window.clearTimeout(previous);
    if (this.frameReady.has(i)) return;
    const timer = window.setTimeout(() => {
      this.frameFallbackTimers.delete(i);
      if (this.frames.get(i) !== frame) return;
      this.frameReady.add(i);
      this.tryRevealFrame(i);
    }, FRAME_READY_FALLBACK_MS);
    this.frameFallbackTimers.set(i, timer);
  }

  private handlePlayableReady(i: number) {
    this.frameReady.add(i);
    const fallbackTimer = this.frameFallbackTimers.get(i);
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    this.frameFallbackTimers.delete(i);
    this.tryRevealFrame(i);
    this.ensureFrameAutoPlay(i);
    this.applyPendingEditor(i);
  }

  private tryRevealFrame(i: number) {
    const frame = this.frames.get(i);
    if (!frame || this.frameRevealed.has(i) || this.frameRevealTimers.has(i)) return;
    if (!this.frameLoaded.has(i) || !this.frameReady.has(i) || !this.canRevealFrame(i)) return;

    const timer = window.setTimeout(() => {
      this.frameRevealTimers.delete(i);
      if (this.frames.get(i) !== frame) return;
      if (!this.frameLoaded.has(i) || !this.frameReady.has(i) || !this.canRevealFrame(i)) return;
      this.frameRevealed.add(i);
      this.markWarmTimeline(i, 'revealAt');
      this.wlog(`#${i} revealed (ready)${i === this.warmIndex ? ' — this is the pre-warmed next mechanic ✓' : ''}`);
      this.games[i].classList.remove('game--loading');
      this.games[i].classList.add('game--ready');
      this.markReady(i);
      this.ensureFrameAutoPlay(i);
      this.applyPendingEditor(i);
      if (i === this.realIndex()) {
        this.scheduleWarmNext();
        this.markUnitShown(i);   // revealed while current (first load / cold arrival)
      }
    }, FRAME_REVEAL_DELAY_MS);
    this.frameRevealTimers.set(i, timer);
  }

  private canRevealFrame(i: number): boolean {
    if (!this.shouldPauseFrame(i)) return true;
    // The ON-SCREEN frame must always drop its spinner, even when it's paused/
    // frozen — this is the fix for the backward-swipe "stuck on a dark preloader"
    // bug: swiping back to a mechanic already earned/failed this cycle re-mounts
    // it, but `shouldPauseFrame` is true for those frames, so the spinner never
    // cleared. A paused frame just shows its frozen content — always better than
    // an endless spinner. (Warm/incoming pages are also safe to de-spinner while
    // off-screen so the eventual swipe is seamless.)
    return i === this.realIndex() || this.warmIndex === i || this.liveHold.has(i);
  }

  private playableApi(i: number): PlayableHostApi | null {
    const frame = this.frames.get(i);
    if (!frame) return null;
    try {
      return ((frame.contentWindow as Window & { __playable?: PlayableHostApi } | null)?.__playable) ?? null;
    } catch {
      return null;
    }
  }

  private postPlayableCommand(frame: HTMLIFrameElement | null | undefined, type: string, extra: Record<string, unknown> = {}) {
    try {
      frame?.contentWindow?.postMessage({ target: 'playable-swipe', type, ...extra }, '*');
    } catch {
      /* missing/cross-origin frame */
    }
  }

  // Pause/resume a playable by flipping its document visibility — the same
  // signal the playable's lifecycle honors. Best-effort: works same-origin
  // (Render / dev middleware); cross-origin still gets the postMessage commands.
  private setFramePaused(i: number, paused: boolean) {
    const frame = this.frames.get(i);
    if (!frame) return;
    if (this.frameLoaded.has(i) && this.framePaused.get(i) === paused) return;
    this.postPlayableCommand(frame, 'setHostPaused', { paused });
    if (paused) this.postPlayableCommand(frame, 'stopAutoPlay');
    try {
      const win = frame.contentWindow as (Window & typeof globalThis) | null;
      const doc = win?.document;
      if (!win || !doc) return;
      const api = (win as Window & { __playable?: PlayableHostApi }).__playable;
      if (paused) {
        try { api?.swipe?.stopAutoPlay(); } catch { /* noop */ }
        if (typeof api?.setAutoPlayEnabled === 'function') api.setAutoPlayEnabled(false);
        else if (typeof api?.stopAutoPlay === 'function') api.stopAutoPlay();
      }
      if (typeof api?.setHostPaused === 'function') api.setHostPaused(paused);
      Object.defineProperty(doc, 'hidden', { configurable: true, get: () => paused });
      Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (paused ? 'hidden' : 'visible') });
      doc.dispatchEvent(new win.Event('visibilitychange'));
      if (this.frameLoaded.has(i)) this.framePaused.set(i, paused);
      if (!paused) this.ensureFrameAutoPlay(i);
    } catch {
      if (this.frameLoaded.has(i)) this.framePaused.set(i, paused);
      /* cross-origin or not ready — leave as-is */
    }
  }

  private ensureFrameAutoPlay(i: number) {
    if (this.manualRuns.has(i) || this.shouldPauseFrame(i)) return;
    // While a reward star is still flying to the counter, hold off starting the
    // next mechanic's autoplay — it kicks in once the collect finishes (afterCollect).
    if (this.collectingRewardIndex !== null) return;
    // Don't start autoplay while the post-reward mechanic is still sliding into place —
    // kicking off physics/finger mid-slide janks the arrival (started after it lands).
    if (this.holdNextAutoplay) return;
    const frame = this.frames.get(i);
    const api = this.playableApi(i);
    try {
      // Prefer the uniform swipe API; fall back to the legacy per-game hooks.
      if (api?.swipe) {
        if (api.swipe.hasAutoPlay) api.swipe.startAutoPlay();
      } else if (typeof api?.setAutoPlayEnabled === 'function') api.setAutoPlayEnabled(true);
      else if (typeof api?.startAutoPlay === 'function') api.startAutoPlay({ immediate: true });
    } catch {
      /* cross-origin or unsupported autoplay API */
    }
    this.postPlayableCommand(frame, 'startAutoPlay');
  }

  private stopFrameAutoPlay(i: number) {
    this.postPlayableCommand(this.frames.get(i), 'stopAutoPlay');
    const api = this.playableApi(i);
    try {
      if (api?.swipe) {
        api.swipe.stopAutoPlay();
        if (typeof api?.setAutoPlayEnabled === 'function') api.setAutoPlayEnabled(false);
      } else {
        if (typeof api?.setAutoPlayEnabled === 'function') api.setAutoPlayEnabled(false);
        if (typeof api?.stopAutoPlay === 'function') api.stopAutoPlay();
      }
    } catch {
      /* cross-origin or unsupported autoplay API */
    }
  }

  private enterManualMode(i: number) {
    if (i < 0 || i >= this.N) return;
    if (!this.manualRuns.has(i)) {
      // First transition autoplay → manual for this unit = a takeover.
      track('takeover', {
        mechanic_id: this.playables[i]?.id,
        ms_since_shown: Math.round(performance.now() - this.shownAt),
        ab_arm: null,   // W3: auto vs tap-to-start arm
      });
    }
    this.manualRuns.add(i);
    this.stopFrameAutoPlay(i);
    this.setAutoplayUi(i, false);
  }

  private activateManualFromAutoplay(i: number) {
    if (i !== this.realIndex()) return;
    this.enterManualMode(i);
    this.revealLabel(i);
    // Restart the round for the manual run. Prefer the in-place swipe.restart
    // (bundle already parsed → no iframe reload, no preloader flash); fall back to
    // a full remount otherwise. `?takeover=continue` keeps the in-progress autoplay
    // state and does neither.
    if (this.restartOnTakeover) {
      const swipe = this.playableApi(i)?.swipe;
      if (swipe?.hasRestart) {
        // instant: skip the first-time intro entrance (e.g. generator drop-in) —
        // the player already watched it during autoplay, so form the field ready.
        try { swipe.restart({ instant: true }); } catch { /* cross-origin */ }
      } else {
        this.reloadFrame(i);
      }
    }
    this.applyActiveStates();
  }

  private applyActiveStates() {
    this.frames.forEach((_f, i) => {
      this.setFramePaused(i, this.shouldPauseFrame(i));
      this.tryRevealFrame(i);
    });
    this.pollAutoplayUi();
  }

  private shouldPauseFrame(i: number): boolean {
    if (document.hidden) return true;
    if (this.overlayOpen) return true;   // a story / editor is up — freeze the whole feed
    if (this.collectingRewardIndex !== null) return true;   // star credit in flight — freeze EVERY frame behind the cover so nothing competes for the main thread
    if (this.settlingTargetIndex === i) return true;
    return i !== this.realIndex() || (this.earnedThisCycle.has(i) && !this.manualRuns.has(i)) || this.failedThisCycle.has(i);
  }

  private desiredWarmIndex(): number | null {
    if (!this.warmNextEnabled) return null;
    if (this.N < 2 || document.hidden || this.overlayOpen || this.isGestureBusy()) return null;
    if (this.levelUpPageState !== 'idle') return null;
    const current = this.realIndex();
    if (!this.frameRevealed.has(current)) return null;
    const next = (current + 1) % this.N;
    if (next === current || this.earnedThisCycle.has(next) || this.failedThisCycle.has(next)) return null;
    return next;
  }

  private clearWarmTimer() {
    if (this.warmTimer) {
      window.clearTimeout(this.warmTimer);
      this.warmTimer = null;
    }
    if (this.warmIdleCancel) {
      this.warmIdleCancel();
      this.warmIdleCancel = null;
    }
  }

  // ── Warm-up diagnostics ──────────────────────────────────────────────────
  private wlog(msg: string) {
    const line = `[warm +${Math.round(performance.now())}ms] ${msg}`;
    this.warmEvents.push(line);
    if (this.warmEvents.length > 400) this.warmEvents.shift();
    if (this.warmDbg) console.log(line);
  }
  // Human-readable reason desiredWarmIndex() would refuse to warm (empty = allowed).
  private warmBlockReason(): string {
    if (!this.warmNextEnabled) return 'warmNextEnabled=false';
    if (this.N < 2) return 'only one mechanic';
    if (document.hidden) return 'document.hidden (tab/app backgrounded)';
    if (this.overlayOpen) return 'overlayOpen (story/editor up)';
    if (this.isGestureBusy()) return 'gestureBusy (dragging/settling)';
    if (this.levelUpPageState !== 'idle') return `levelUp active (${this.levelUpPageState})`;
    const cur = this.realIndex();
    if (!this.frameRevealed.has(cur)) return `current #${cur} not revealed yet`;
    const next = (cur + 1) % this.N;
    if (next === cur) return 'next === current';
    if (this.earnedThisCycle.has(next)) return `next #${next} already earned this cycle`;
    if (this.failedThisCycle.has(next)) return `next #${next} already failed this cycle`;
    return '';
  }
  // Live snapshot — exposed as window.__feedWarm() (see constructor). Answers
  // "is the next mechanic pre-warmed, and if not, why".
  private warmSnapshot() {
    const cur = this.realIndex();
    const next = this.N > 1 ? (cur + 1) % this.N : -1;
    const reason = this.warmBlockReason();
    return {
      current: cur,
      next,
      nextIsWarmed: this.warmIndex === next && this.frameRevealed.has(next),
      warmIndex: this.warmIndex,
      nextMounted: this.frames.has(next),
      nextRevealed: this.frameRevealed.has(next),
      blockedNow: reason || '(not blocked — warm is allowed right now)',
      calmFramesSeenMax: this.warmCalmMax,
      calmFramesNeeded: WARM_NEXT_CALM_FRAMES,
      diagnosis: this.warmCalmMax < WARM_NEXT_CALM_FRAMES
        ? `the current mechanic never yielded ${WARM_NEXT_CALM_FRAMES} calm frames (≤${WARM_NEXT_CALM_FRAME_MS}ms) in a row → warm is STARVED (no idle window)`
        : 'a calm window was reached at least once',
      recentEvents: this.warmEvents.slice(-50),
    };
  }

  private scheduleWarmNext() {
    this.clearWarmTimer();
    const next = this.desiredWarmIndex();
    if (next === null) { this.wlog(`schedule blocked: ${this.warmBlockReason()}`); return; }
    if (this.warmIndex === next && this.frames.has(next)) { this.wlog(`already warm: #${next}`); return; }
    this.wlog(`scheduled → will try to warm #${next} once the page goes calm`);
    this.warmTimer = window.setTimeout(() => {
      this.warmTimer = null;
      this.warmIdleCancel = this.scheduleLowImpactTask(() => {
        this.warmIdleCancel = null;
        this.startWarmNext(next);
      }, WARM_NEXT_IDLE_TIMEOUT_MS);
    }, WARM_NEXT_DELAY_MS);
  }

  private startWarmNext(expected: number) {
    if (this.desiredWarmIndex() !== expected) {
      this.wlog(`warm of #${expected} aborted (state changed): ${this.warmBlockReason()}`);
      this.scheduleWarmNext();
      return;
    }
    this.wlog(`START warming #${expected} (calm window opened; max calm frames seen=${this.warmCalmMax})`);
    this.warmIndex = expected;
    this.setAutoplayUi(expected, true, true);
    this.updateLive();
    this.setFramePaused(expected, true);
    this.tryRevealFrame(expected);
  }

  private pauseAllFrames = () => {
    this.clearWarmTimer();
    this.frames.forEach((_frame, i) => this.setFramePaused(i, true));
    this.pauseStoryFrame(true);
  };

  private onHostVisibilityChange = () => {
    if (document.hidden) {
      this.pauseAllFrames();
      return;
    }
    this.applyActiveStates();
    this.tryRevealFrame(this.realIndex());
    this.scheduleWarmNext();
    this.pumpPrefetchQueue();
  };

  private pollAutoplayUi = () => {
    if (document.hidden) return;
    if (this.isGestureBusy()) return;
    const indices = new Set<number>(this.autoplayUiActive);
    indices.add(this.realIndex());
    if (this.warmIndex !== null) indices.add(this.warmIndex);
    if (this.settlingTargetIndex !== null) indices.add(this.settlingTargetIndex);
    this.liveHold.forEach((i) => indices.add(i));
    this.manualRuns.forEach((i) => indices.add(i));

    for (const i of indices) {
      if (i < 0 || i >= this.N) continue;
      const isCurrent = i === this.realIndex();
      const paused = this.shouldPauseFrame(i);
      const manual = this.manualRuns.has(i);

      // Autoplay / attract overlay. Warm/incoming frames get the same visual
      // treatment while staying host-paused, so a prepared next mechanic never
      // flashes as a fully-coloured raw frame during the swipe.
      const preview = this.shouldShowAutoplayPreview(i, isCurrent, manual);
      let active = preview;
      if (!active && isCurrent && !manual && !paused) {
        const api = this.playableApi(i);
        try {
          if (api?.swipe) {
            // Autoplay mechanics mirror the running demo. Mechanics WITHOUT autoplay
            // get the same overlay anyway — an attract prompt waiting for the first
            // tap/swipe (dismissed by activateManualFromAutoplay).
            active = api.swipe.hasAutoPlay ? api.swipe.isAutoPlayActive() : true;
          } else {
            const state = api?.getSwipeState?.();
            // Legacy swipe games report their own autoplay state; plain playables
            // (no swipe state) also get the attract prompt.
            active = state ? (state.autoPlayActive === true || state.autoPlayRequested === true) : true;
          }
        } catch { /* cross-origin */ }
      }
      this.setAutoplayUi(i, active, preview);

      // Hint above the fixed bar: only about TAPPING to play this mechanic (paging is
      // the bar's button now). Shown during autoplay/attract; hidden in manual play.
      const txt = this.swipebarTextEls[i];
      if (txt && txt.textContent !== 'tap to play or swipe') txt.textContent = 'tap to play or swipe';

      // Poster lifecycle: ONE-WAY hide once the mechanic is genuinely live on
      // screen (current + revealed + un-paused). Never re-shown mid-run — a
      // poster snapping over a live leaving frame would flash; remount
      // (resetFrameReadiness) restores it for the next cycle.
      if (isCurrent && !paused && this.frameRevealed.has(i)) {
        this.games[i]?.classList.add('game--live');
      }
      // Live-ride pages show their real iframe: the in-slot poster (z above
      // the frame) must not cover it — neither while parked in the viewport
      // nor during the ride. Reverts automatically after remount.
      this.games[i]?.classList.toggle('game--warmlive', this.liveRideOk(i));

      const playable = isCurrent && !paused && !this.earnedThisCycle.has(i) && !this.failedThisCycle.has(i);
      // Manual play hides the blinking hint (the close × takes over as the affordance).
      this.games[i]?.classList.toggle('game--manual', playable && manual);
      // Close (×) only in MANUAL play — during autoplay the demo is paged by tap/swipe.
      this.games[i]?.classList.toggle('game--show-close', playable && manual);
    }
  };

  // Advance forward one mechanic (the close × and any "skip" affordance use this).
  private advanceToNext() {
    if (this.dragging) return;
    const base = Math.round(this.pos);
    // The ✕ and the bottom-bar ▲ leave the win screen WITHOUT the collect gesture,
    // so credit any earned-but-uncollected stars here — otherwise they'd be lost.
    this.creditPendingRewardImmediate(this.indexForPos(base));
    this.unlockAudioForCurrentAndNext(this.indexForPos(base));
    this.releaseHeldLevelUp();
    this.goTo(base + 1);
  }

  // Bank a pending, uncollected reward the moment the win screen is left by a path
  // that skips the fly-to-counter collect (the ✕ or the bottom-bar ▲). Stars are
  // earned by SEEING the win screen, not only by the explicit collect — so no win
  // ever loses its stars. Idempotent and mutually exclusive with the collect path:
  // `claimedStarRewards`/`pendingStarRewards` gate both, and a collect in flight
  // (`collectingRewardIndex`) owns the credit itself.
  private creditPendingRewardImmediate(i: number): void {
    if (this.collectingRewardIndex === i) return;
    if (!this.pendingStarRewards.has(i) || this.claimedStarRewards.has(i)) return;
    this.pendingStarRewards.delete(i);
    this.claimedStarRewards.add(i);
    const stars = this.rewardStarsFor(i);
    const levelBefore = this.levelForStars(this.totalStars);
    this.totalStars += stars;
    const levelAfter = this.levelForStars(this.totalStars);
    track('reward_collected', { mechanic_id: this.playables[i]?.id, stars });
    if (levelAfter > levelBefore) track('level_up', { level: levelAfter });
    this.updateHud(true);   // reflect the new total on the level counter (no level-up ceremony)
  }

  private shouldShowAutoplayPreview(i: number, isCurrent: boolean, manual: boolean): boolean {
    if (manual || this.earnedThisCycle.has(i) || this.failedThisCycle.has(i)) return false;
    const baseIndex = this.indexForPos(this.basePos);
    if (this.settlingTargetIndex === i && i !== baseIndex) return true;
    if (this.dragging && this.liveHold.has(i) && i !== baseIndex) return true;
    if (isCurrent) return false;
    return i === this.warmIndex;
  }

  private setAutoplayUi(i: number, active: boolean, preview: boolean = false) {
    const game = this.games[i];
    const previewChanged = !!game?.classList.contains('game--autoplay-preview') !== preview;
    if (this.autoplayUiActive.has(i) === active && !previewChanged) return;
    if (active) this.autoplayUiActive.add(i);
    else this.autoplayUiActive.delete(i);
    game?.classList.toggle('game--autoplay', active);
    game?.classList.toggle('game--autoplay-preview', preview);
  }

  private primeIncomingAutoplayPreview(indices: number[]) {
    for (const i of indices) {
      if (i < 0 || i >= this.N) continue;
      if (this.earnedThisCycle.has(i) || this.failedThisCycle.has(i)) continue;
      this.setAutoplayUi(i, true, true);
    }
  }

  private prepareAutoplayNavigationTarget(i: number) {
    if (i < 0 || i >= this.N) return;
    if (this.earnedThisCycle.has(i) || this.failedThisCycle.has(i)) return;
    this.manualRuns.delete(i);
    this.pendingEditorLaunch.delete(i);
    this.games[i]?.classList.remove('game--manual');
    this.setAutoplayUi(i, true, true);
  }

  // ── Friend story (Instagram-style) ─────────────────────────────────────────
  private openStory(idx: number) {
    if (this.overlayOpen) return;
    const f = this.friends[idx];
    if (!f) return;
    this.markFriendViewed(idx);

    // Any available swipe mechanic — picked per-friend so it's stable per session.
    const mechanic = this.playables[idx % this.N].id;

    this.overlayOpen = true;
    this.applyActiveStates();   // pause the background feed game (one mechanic at a time)

    const ov = document.createElement('div');
    ov.className = 'story-view';
    ov.innerHTML =
      '<div class="story-view__header">' +
        `<div class="story__avatar story__avatar--${f.tone} story-view__avatar"><span>${f.initial}</span></div>` +
        `<div class="story-view__meta"><div class="story-view__name">${f.name}</div>` +
        `<div class="story-view__time">${f.hours}h ago</div></div>` +
        '<button class="story-view__close" type="button" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="story-view__stage"></div>' +
      '<div class="story-view__emojis">' +
        ['😂', '😮', '😍', '😢', '👏', '🔥', '🎉', '❤️']
          .map((em) => `<button class="story-view__emoji" type="button">${em}</button>`).join('') +
      '</div>' +
      '<div class="story-view__footer">' +
        `<input class="story-view__reply" type="text" placeholder="Reply to ${f.name}…" />` +
        '<button class="story-view__heart" type="button" aria-label="Like">' +
          '<svg class="story-view__heart-icon" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>' +
          '</svg>' +
        '</button>' +
      '</div>';
    this.viewport.appendChild(ov);
    this.overlayEl = ov;

    const frame = document.createElement('iframe');
    frame.className = 'story-view__frame';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('allow', 'autoplay');
    frame.addEventListener('load', () => this.disableFrameDoubleTapZoom(frame));
    frame.src = playableUrl(mechanic, { hostPaused: false, auto: true });
    ov.querySelector('.story-view__stage')!.appendChild(frame);
    this.storyFrame = frame;

    ov.querySelector('.story-view__close')!.addEventListener('click', () => this.closeOverlay());

    const heart = ov.querySelector('.story-view__heart') as HTMLElement;
    heart.addEventListener('click', () => {
      const liked = heart.classList.toggle('story-view__heart--liked');
      if (liked && heart.animate) {
        heart.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.4)' }, { transform: 'scale(1)' }],
          { duration: 300, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.4)' },
        );
      }
    });

    const reply = ov.querySelector('.story-view__reply') as HTMLInputElement;
    reply.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter' && reply.value.trim()) { reply.value = ''; reply.blur(); }
    });
    // IG-style: focusing the reply field reveals quick emoji reactions over the
    // mechanic and PAUSES it while the player types / picks a reaction.
    reply.addEventListener('focus', () => { ov.classList.add('story-view--reacting'); this.pauseStoryFrame(true); });
    reply.addEventListener('blur', () => { ov.classList.remove('story-view--reacting'); this.pauseStoryFrame(false); });
    ov.querySelectorAll('.story-view__emoji').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();                       // keep focus until we dismiss ourselves
        this.flyEmoji(ov, (btn as HTMLElement).textContent || '👍');
        reply.blur();                             // dismiss → resumes the mechanic
      });
    });

    if (ov.animate) ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
  }

  // Pause/resume the story's own mechanic iframe (separate from the feed frames).
  private pauseStoryFrame(paused: boolean) {
    const frame = this.storyFrame;
    if (!frame) return;
    const effectivePaused = paused || document.hidden;
    this.postPlayableCommand(frame, 'setHostPaused', { paused: effectivePaused });
    if (effectivePaused) this.postPlayableCommand(frame, 'stopAutoPlay');
    try {
      const win = frame.contentWindow as (Window & typeof globalThis) | null;
      const doc = win?.document;
      if (!win || !doc) return;
      const api = (win as any).__playable;
      if (effectivePaused) {
        try { api?.swipe?.stopAutoPlay(); } catch { /* noop */ }
        if (typeof api?.setAutoPlayEnabled === 'function') api.setAutoPlayEnabled(false);
        else if (typeof api?.stopAutoPlay === 'function') api.stopAutoPlay();
      }
      if (typeof api?.setHostPaused === 'function') api.setHostPaused(effectivePaused);
      Object.defineProperty(doc, 'hidden', { configurable: true, get: () => effectivePaused });
      Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (effectivePaused ? 'hidden' : 'visible') });
      doc.dispatchEvent(new win.Event('visibilitychange'));
      if (!effectivePaused) {
        if (api?.swipe?.hasAutoPlay) api.swipe.startAutoPlay();
        else if (typeof api?.setAutoPlayEnabled === 'function') api.setAutoPlayEnabled(true);
        else if (typeof api?.startAutoPlay === 'function') api.startAutoPlay({ immediate: true });
      }
    } catch { /* cross-origin — leave as-is */ }
  }

  private flyEmoji(parent: HTMLElement, emoji: string) {
    const el = document.createElement('div');
    el.className = 'story-view__fly';
    el.textContent = emoji;
    el.style.left = `${28 + Math.random() * 44}%`;
    parent.appendChild(el);
    if (!el.animate) { window.setTimeout(() => el.remove(), 1100); return; }
    const rise = 150 + Math.random() * 90;
    const a = el.animate([
      { transform: 'translate(-50%, 0) scale(0.6)', opacity: 0 },
      { transform: 'translate(-50%, -26px) scale(1.25)', opacity: 1, offset: 0.2 },
      { transform: `translate(-50%, -${rise}px) scale(1)`, opacity: 0 },
    ], { duration: 1100, easing: 'cubic-bezier(0.2, 0.6, 0.3, 1)', fill: 'forwards' });
    a.addEventListener('finish', () => el.remove(), { once: true });
  }

  private markFriendViewed(idx: number) {
    this.viewedFriends.add(idx);
    const avatar = this.storiesEl?.querySelector(`.story[data-friend="${idx}"] .story__avatar`);
    avatar?.classList.add('story__avatar--viewed');
  }

  // ── Mechanic editor (placeholder) ──────────────────────────────────────────
  // Stub for the future editor where players assemble a customised mechanic
  // from templates / examples. Opened from the "+" on the player's own avatar.
  private openEditor() {
    if (this.overlayOpen) return;
    this.overlayOpen = true;
    this.applyActiveStates();

    const templates = ['Merge', 'Sort', 'Pin Pull', 'Time Press', 'Blank'];
    const ov = document.createElement('div');
    ov.className = 'editor';
    ov.innerHTML =
      '<div class="editor__header">' +
        '<div class="editor__title">Mechanic Editor</div>' +
        '<button class="editor__close" type="button" aria-label="Close">✕</button>' +
      '</div>' +
      '<div class="editor__body">' +
        '<div class="editor__hero">🛠️</div>' +
        '<div class="editor__lead">Build your own mechanic</div>' +
        '<div class="editor__sub">Coming soon — start from a template or remix an example, then tune the rules and ship it to your feed.</div>' +
        '<div class="editor__templates">' +
          templates.map((t) => `<div class="editor__tpl"><div class="editor__tpl-art"></div><div class="editor__tpl-name">${t}</div></div>`).join('') +
        '</div>' +
        '<button class="editor__cta" type="button" disabled>Start building</button>' +
      '</div>';
    this.viewport.appendChild(ov);
    this.overlayEl = ov;
    ov.querySelector('.editor__close')!.addEventListener('click', () => this.closeOverlay());
    if (ov.animate) ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
  }

  private closeOverlay() {
    if (!this.overlayOpen) return;
    this.overlayOpen = false;
    const ov = this.overlayEl;
    const storyFrame = this.storyFrame;
    if (storyFrame) {
      this.pauseStoryFrame(true);
      try { storyFrame.src = 'about:blank'; } catch { /* noop */ }
      storyFrame.remove();
    }
    this.overlayEl = null;
    this.storyFrame = null;
    if (ov && ov.animate) {
      const a = ov.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: 'forwards' });
      a.addEventListener('finish', () => ov.remove(), { once: true });
    } else if (ov) {
      ov.remove();
    }
    this.applyActiveStates();   // resume the background feed game
  }

  private callPlayableHostGesture(i: number): boolean {
    const api = this.playableApi(i);
    if (typeof api?.hostGesture !== 'function') return false;
    try { api.hostGesture(); return true; }
    catch { return false; }
  }

  private unlockAudioForCurrentAndNext(fromIndex: number = this.realIndex(), includePrevious = false) {
    const current = ((fromIndex % this.N) + this.N) % this.N;
    const next = (current + 1) % this.N;
    this.callPlayableHostGesture(current);
    this.callPlayableHostGesture(next);
    if (includePrevious) {
      const prev = ((current - 1) % this.N + this.N) % this.N;
      this.callPlayableHostGesture(prev);
    }
  }

  // ── Prefetch reserve (bytes only) ──────────────────────────────────────────
  private prefetchEnabled = (new URLSearchParams(location.search).get('prefetch') || 'on') !== 'off';

  private prefetchReserve() {
    if (!this.prefetchEnabled) return;
    const base = this.realIndex();
    for (let d = 1; d <= reserveAheadDepth(); d++) {
      const j = ((base + d) % this.N + this.N) % this.N;
      this.enqueuePrefetch(j);
    }
  }

  private enqueuePrefetch(i: number) {
    if (this.frames.has(i) || this.prefetched.has(i) || this.prefetchQueued.has(i)) return;
    this.prefetched.add(i);
    this.prefetchQueued.add(i);
    this.prefetchQueue.push(i);
    this.pumpPrefetchQueue();
  }

  private pumpPrefetchQueue() {
    if (this.prefetching || this.isGestureBusy()) return;
    const i = this.prefetchQueue.shift();
    if (i === undefined) return;
    this.prefetchQueued.delete(i);
    if (this.frames.has(i)) {
      this.pumpPrefetchQueue();
      return;
    }

    this.prefetching = true;
    this.scheduleIdlePrefetch(() => {
      if (this.isGestureBusy()) {
        this.prefetching = false;
        this.requeuePrefetchFront(i);
        this.pumpPrefetchQueue();
        return;
      }
      // The html URL must match the future warm-mount iframe src BYTE-FOR-BYTE
      // (query params included) or the HTTP cache misses. The blob-boot
      // payload.js is param-less and referenced relatively by the html — fetch
      // it too, it's the part V8 stream-compiles at boot.
      const id = this.playables[i].id;
      // priority:'low' (Chromium fetch-priority hint; ignored elsewhere) keeps
      // background bytes from competing with the warm iframe's own load.
      const lowPriority = { mode: 'no-cors', priority: 'low' } as RequestInit;
      Promise.allSettled([
        fetch(playableUrl(id, { hostPaused: true, auto: true }), lowPriority),
        fetch(`${playableUrl(id).split('?')[0].replace(/\.html$/, '')}.payload.js`, lowPriority),
      ])
        .then(() => this.markReady(i))
        .finally(() => {
          this.prefetching = false;
          this.pumpPrefetchQueue();
        });
    });
  }

  private requeuePrefetchFront(i: number) {
    if (this.frames.has(i) || this.prefetchQueued.has(i)) return;
    this.prefetchQueued.add(i);
    this.prefetchQueue.unshift(i);
  }

  private isGestureBusy(): boolean {
    return this.dragging || this.settlingTargetIndex !== null;
  }

  private scheduleIdlePrefetch(fn: () => void, timeout = 800) {
    this.scheduleLowImpactTask(fn, timeout);
  }

  private scheduleLowImpactTask(fn: () => void, timeout = 800): () => void {
    let cancelled = false;
    let raf = 0;
    let fallbackTimer = 0;
    let idleId = 0;
    let calmFrames = 0;
    let stuckRounds = 0;
    let lastFrameT = performance.now();
    let calmWindowStartedAt = lastFrameT;
    const requestIdleCallback = (window as any).requestIdleCallback as
      | undefined
      | ((callback: (deadline: { timeRemaining: () => number; didTimeout?: boolean }) => void, options?: { timeout: number }) => number);
    const cancelIdleCallback = (window as any).cancelIdleCallback as undefined | ((id: number) => void);

    const clear = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      if (fallbackTimer) { window.clearTimeout(fallbackTimer); fallbackTimer = 0; }
      if (idleId && cancelIdleCallback) { cancelIdleCallback(idleId); idleId = 0; }
    };

    const run = () => {
      if (cancelled) return;
      clear();
      fn();
    };

    const waitForCalmFrames = (now: number) => {
      if (cancelled) return;
      const dt = now - lastFrameT;
      lastFrameT = now;
      if (!document.hidden && !this.isGestureBusy() && dt <= WARM_NEXT_CALM_FRAME_MS) calmFrames++;
      else calmFrames = 0;
      if (calmFrames > this.warmCalmMax) this.warmCalmMax = calmFrames;   // warm diagnostics
      if (calmFrames >= WARM_NEXT_CALM_FRAMES) {
        scheduleIdle();
        return;
      }
      // If the page never becomes calm, retry — but only a few rounds. A
      // mechanic rendering at full frame budget (autoplay demo) never yields
      // an idle window at all, and indefinite starvation is worse than the
      // warm task itself: staged boot + payload streaming cut the warm cost
      // to ~100-180ms worst-case, while an un-warmed fast swipe boots from
      // the network in plain sight. Force the task after STUCK_ROUNDS_MAX.
      if (now - calmWindowStartedAt > timeout * 2) {
        if (++stuckRounds >= STUCK_ROUNDS_MAX) {
          this.wlog(`calm gate starved ${stuckRounds} rounds — forcing the task (warm is cheap post staged-boot)`);
          run();
          return;
        }
        this.wlog(`calm gate stuck: max ${this.warmCalmMax}/${WARM_NEXT_CALM_FRAMES} calm frames — current mechanic too busy, retrying`);
        fallbackTimer = window.setTimeout(() => {
          fallbackTimer = 0;
          calmFrames = 0;
          calmWindowStartedAt = performance.now();
          lastFrameT = calmWindowStartedAt;
          raf = requestAnimationFrame(waitForCalmFrames);
        }, timeout);
        return;
      }
      raf = requestAnimationFrame(waitForCalmFrames);
    };

    const scheduleIdle = () => {
      if (cancelled) return;
      if (typeof requestIdleCallback === 'function') {
        idleId = requestIdleCallback((deadline) => {
          idleId = 0;
          if (cancelled) return;
          if (!document.hidden && !this.isGestureBusy() && deadline.timeRemaining() >= WARM_NEXT_IDLE_MIN_MS) {
            run();
            return;
          }
          calmFrames = 0;
          raf = requestAnimationFrame(waitForCalmFrames);
        }, { timeout });
        return;
      }
      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = 0;
        if (!document.hidden && !this.isGestureBusy()) run();
      }, 0);
    };

    raf = requestAnimationFrame(waitForCalmFrames);
    return () => {
      cancelled = true;
      clear();
    };
  }

  // ── Preloader (rectangular fill bar) ───────────────────────────────────────
  private mountPreloader() {
    const el = document.createElement('div');
    el.className = 'preloader';
    el.innerHTML =
      '<div class="preloader__title">Loading mini-games…</div>' +
      '<div class="preloader__bar"><div class="preloader__fill"></div></div>' +
      '<div class="preloader__progress">0 / ' + this.initialTarget + '</div>';
    this.viewport.appendChild(el);
    this.preloaderEl = el;
    this.preloaderMountedAt = performance.now();
    this.preloaderFillEl = el.querySelector('.preloader__fill');
    this.preloaderProgressEl = el.querySelector('.preloader__progress');
    window.setTimeout(() => this.finishPreloader(), PRELOADER_TIMEOUT_MS);
  }

  private markReady(i: number) {
    if (this.preloaderDone || i >= this.initialTarget) return;
    this.ready.add(i);
    const frac = this.ready.size / this.initialTarget;
    if (this.preloaderFillEl) this.preloaderFillEl.style.width = `${Math.round(frac * 100)}%`;
    if (this.preloaderProgressEl) this.preloaderProgressEl.textContent = `${this.ready.size} / ${this.initialTarget}`;
    if (this.ready.size >= this.initialTarget) { this.mechanicsReady = true; this.maybeDismissPreloader(); }
  }

  // Dismiss only when BOTH the first mechanic is ready AND the first server seed
  // has settled (or its short cap elapsed) — so the balance is on the HUD before
  // the feed shows, without ever hanging on a cold/offline backend.
  private maybeDismissPreloader(): void {
    if (this.mechanicsReady && !this.awaitingServerSeed) this.finishPreloader();
  }

  private settleServerSeed(): void {
    if (!this.awaitingServerSeed) return;
    this.awaitingServerSeed = false;
    this.maybeDismissPreloader();
  }

  private finishPreloader() {
    if (this.preloaderDone) return;
    this.preloaderDone = true;
    // D3 guard metric: how long the first-load preloader was visible (p95 < 0.5s).
    track('loader_visible', { ms: Math.round(performance.now() - this.preloaderMountedAt) });
    const el = this.preloaderEl;
    if (!el) return;
    el.classList.add('preloader--hidden');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }

  // ── Overlay pointer handling ─────────────────────────────────────────────
  // private attachGutter(gutter: HTMLElement) {
  //   this.attachSwipeSurface(gutter);
  // }

  private attachRewardSwipe(state: HTMLElement) {
    this.attachSwipeSurface(
      state,
      () => !state.hidden && (state.classList.contains('game__state--earned') || state.classList.contains('game__state--failed')),
      true,
    );
  }

  private attachSwipeSurface(surface: HTMLElement, canStart: () => boolean = () => true, preferReward = false) {
    surface.addEventListener('pointerdown', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('button, input, textarea, select, a')) return;
      if (!canStart()) return;
      if (surface === this.levelUpPageEl && this.levelUpPageState === 'settled') {
        this.onDown(e, surface, 'levelup');
        return;
      }
      const rewardIndex = this.rewardSwipeIndexFor(surface, preferReward);
      if (rewardIndex !== null) this.onDown(e, surface, 'reward', rewardIndex);
      else this.onDown(e, surface, 'feed');
    });
    surface.addEventListener('pointermove', (e) => this.onMove(e));
    surface.addEventListener('pointerup', (e) => this.onUp(e, surface));
    surface.addEventListener('pointercancel', (e) => this.onUp(e, surface));
  }

  private rewardSwipeIndexFor(surface: HTMLElement, preferReward: boolean): number | null {
    if (this.collectingRewardIndex !== null) return null;
    const current = this.realIndex();
    if (!this.pendingStarRewards.has(current)) return null;
    if (preferReward || surface === this.gutters[current]) return current;
    return null;
  }

  private onDown(e: PointerEvent, surface: HTMLElement, mode: 'feed' | 'reward' | 'levelup', rewardIndex: number | null = null) {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    this.clearWarmTimer();
    if (this.settlingTargetIndex !== null) this.syncSettlingPositionToVisual();
    const current = this.realIndex();
    const next = (current + 1) % this.N;
    const prev = ((current - 1) % this.N + this.N) % this.N;
    const autoplayIndex = mode === 'feed' ? this.autoplayTapIndexFor(surface) : null;
    this.dragMode = mode;
    this.rewardDragIndex = rewardIndex;
    this.dragAutoplayIndex = autoplayIndex;
    this.dragAllowsBack = autoplayIndex !== null;
    if (mode === 'feed' || mode === 'reward') {
      this.liveHold = this.dragAllowsBack ? new Set([prev, current, next]) : new Set([current, next]);
      this.primeIncomingAutoplayPreview(this.dragAllowsBack ? [prev, next] : [next]);
    } else if (mode === 'levelup') {
      this.liveHold = new Set([current, next]);
      this.primeIncomingAutoplayPreview([next]);
    }

    this.dragging = true;
    this.startY = e.clientY;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    this.velocity = 0;
    this.basePos = this.pos;
    if (mode === 'levelup') this.basePos = this.levelUpPageBasePos;
    if (mode === 'reward' && rewardIndex !== null && this.rewardWouldLevelUp()) {
      this.prepareLevelUpPage(this.previewRewardLevel(), Math.round(this.basePos));
    }
    if (mode === 'feed' || mode === 'reward') this.render(false);
    surface.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (!this.dragging || this.pageH === 0) return;
    const dy = e.clientY - this.startY;
    const dt = e.timeStamp - this.lastT;
    if (dt > 0) this.velocity = (e.clientY - this.lastY) / dt;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    // Reward-collect drags don't scroll the page: the win star must stay PUT so the
    // collect flight starts from its resting spot (and pulses there) instead of
    // riding the finger upward first. The flick threshold still uses dy/velocity.
    if (this.dragMode === 'reward') return;
    const rawProgress = -dy / this.pageH;         // drag up → positive → next; drag down → negative → previous
    const pageProgress = this.dragAllowsBack
      ? Math.max(-1, Math.min(1, rawProgress))
      : Math.max(0, Math.min(1, rawProgress));
    this.pos = this.basePos + pageProgress;
    this.render(false);
  }

  private onUp(e: PointerEvent, surface: HTMLElement) {
    if (!this.dragging) return;
    this.dragging = false;
    try { surface.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    const dy = e.clientY - this.startY;
    let step = 0;
    const hasSwipeIntent = Math.abs(dy) >= MIN_SWIPE_INTENT_PX;
    const fastUp = hasSwipeIntent && this.velocity <= -VELOCITY_SNAP;
    const fastDown = hasSwipeIntent && this.dragAllowsBack && this.velocity >= VELOCITY_SNAP;
    const snapDistance = Math.min(this.pageH * DISTANCE_SNAP_FRAC, DISTANCE_SNAP_PX);
    const farUp = dy <= -snapDistance;
    const farDown = this.dragAllowsBack && dy >= snapDistance;
    const movedPastTap = Math.abs(dy) > TAP_SLOP_PX;
    if (fastUp || farUp) step = 1;
    else if (fastDown || farDown) step = -1;

    const fromIndex = this.indexForPos(this.basePos);
    const commitBasePos = Math.round(this.basePos);
    const allowsBack = this.dragAllowsBack;

    if (this.dragMode === 'levelup') {
      this.dragMode = 'feed';
      this.rewardDragIndex = null;
      this.dragAutoplayIndex = null;
      this.dragAllowsBack = false;
      // Dismiss the level-up by a swipe-up OR a plain tap (anywhere except buttons).
      const tapToLeave = step === 0 && !movedPastTap;
      if (step > 0 || tapToLeave) {
        this.levelUpPageState = 'leaving';
        this.unlockAudioForCurrentAndNext(fromIndex);
        this.goTo(commitBasePos + (step > 0 ? step : 1));
      } else {
        this.levelUpPageState = 'settled';
        this.goTo(commitBasePos);
      }
      return;
    }

    if (this.dragMode === 'reward') {
      const rewardIndex = this.rewardDragIndex;
      this.dragMode = 'feed';
      this.rewardDragIndex = null;
      this.dragAutoplayIndex = null;
      this.dragAllowsBack = false;
      // After a win, advance by a swipe-up OR a plain tap anywhere (except buttons,
      // which stop the gesture before it starts) — both collect and move on.
      const tapToAdvance = step === 0 && !movedPastTap;
      if ((step > 0 || tapToAdvance) && rewardIndex !== null) {
        const willShowLevelUp = this.levelUpPageState === 'entering' && this.levelUpPageEl !== null;
        this.unlockAudioForCurrentAndNext(fromIndex);
        if (willShowLevelUp) {
          // Level-up path owns its own transition (the level-up page animates in
          // immediately); collectReward credits + reveals it in the background.
          this.collectReward(rewardIndex, null);
          this.animateLevelUpPageIn();
        } else {
          // INSTANT swipe: start the slide to the next game NOW, and fly the earned
          // stars into the counter IN PARALLEL (flyRewardStarsInPlace lifts the real
          // stars onto the fixed viewport layer, not the sliding page, so the flight
          // plays out fully even as the won page leaves — gesture reacts immediately,
          // the collect animation still runs). Credit lands with the stars
          // (idempotent — never lost). No freeze/cover.
          const state = this.stateEls[rewardIndex];
          const units = state ? Array.from(state.querySelectorAll<HTMLElement>('.reward__star-unit')) : [];
          this.stopRewardSparks(rewardIndex);
          // Lift the SAME star elements onto the fixed layer (pinned in place) and hop
          // them to the counter one-by-one — no clones, so nothing visibly disappears
          // /reappears. They animate independently while the won page slides away.
          this.flyRewardStarsInPlace(units, () => this.creditPendingRewardImmediate(rewardIndex));
          this.slideToNext(rewardIndex, commitBasePos + 1);
        }
        return;
      }
      this.removeLevelUpPage();
      this.goTo(commitBasePos + step);
      return;
    }

    this.dragMode = 'feed';
    this.rewardDragIndex = null;
    const autoplayTapIndex = this.dragAutoplayIndex;
    this.dragAutoplayIndex = null;
    this.dragAllowsBack = false;
    if (step === 0 && autoplayTapIndex !== null && !movedPastTap) {
      this.unlockAudioForCurrentAndNext(autoplayTapIndex, true);
      this.goTo(commitBasePos);
      this.activateManualFromAutoplay(autoplayTapIndex);
      return;
    }
    // Held level-up overlay: a plain tap (not just a swipe) dismisses it and advances.
    if (this.heldLevelUpOverlay && step === 0 && !movedPastTap) {
      this.unlockAudioForCurrentAndNext(fromIndex);
      this.releaseHeldLevelUp();
      this.goTo(commitBasePos + 1);
      return;
    }
    if (step !== 0 && autoplayTapIndex !== null) {
      this.prepareAutoplayNavigationTarget(this.indexForPos(commitBasePos + step));
    }
    if (step !== 0) this.unlockAudioForCurrentAndNext(fromIndex, allowsBack);
    if (step > 0) this.releaseHeldLevelUp();
    this.goTo(commitBasePos + step);
  }

  private autoplayTapIndexFor(surface: HTMLElement): number | null {
    const raw = surface.dataset.autoplayIndex;
    if (raw === undefined) return null;
    const index = Number(raw);
    if (!Number.isInteger(index) || index !== this.realIndex()) return null;
    if (!this.autoplayUiActive.has(index)) return null;
    return index;
  }

  // ── Playable completion / progression ────────────────────────────────────
  private onWindowMessage = (e: MessageEvent) => {
    const i = this.frameIndexForSource(e.source);
    if (i < 0) return;
    const d = e.data as Record<string, unknown> | null;
    if (d && typeof d === 'object' && d.source === 'playable' && d.type === 'boot_timings') {
      this.handleBootTimings(i, d);
      return;
    }
    if (this.isPlayableReadyMessage(e.data)) {
      this.handlePlayableReady(i);
      return;
    }
    if (this.isHostGestureMessage(e.data)) {
      if (!this.hostGestureDeliveredSynchronously(e.data)) {
        this.unlockAudioForCurrentAndNext(i);
        this.enterManualMode(i);
      }
      this.revealLabel(i);
      return;
    }
    const outcome = this.outcomeFromMessage(e.data);
    if (!outcome) return;
    this.handlePlayableCompleted(i, outcome);
  };

  private onHostGesture = (playableId?: string) => {
    const i = playableId ? this.playables.findIndex((p) => p.id === playableId) : this.realIndex();
    const idx = i >= 0 ? i : this.realIndex();
    // First in-iframe user input on the current unit (fires before takeover below).
    if (idx === this.shownIndex && !this.firstInputLogged) {
      this.firstInputLogged = true;
      track('first_input', {
        mechanic_id: this.playables[idx]?.id,
        ms_since_shown: Math.round(performance.now() - this.shownAt),
      });
    }
    this.unlockAudioForCurrentAndNext(idx);
    this.enterManualMode(idx);
    this.revealLabel(idx);
  };

  // Mechanic name is hidden by default (so it never overlaps the game) and
  // flashed on the first tap on the level, then auto-hidden.
  private revealLabel(i: number) {
    const label = this.labelEls[i];
    if (!label) return;
    label.classList.add('game__label--show');
    const prev = this.labelTimers.get(i);
    if (prev) clearTimeout(prev);
    this.labelTimers.set(i, window.setTimeout(() => label.classList.remove('game__label--show'), 2200));
  }

  private frameIndexForSource(source: MessageEventSource | null): number {
    if (!source) return -1;
    for (const [i, frame] of this.frames) {
      if (frame.contentWindow === source) return i;
    }
    return -1;
  }

  private outcomeFromMessage(data: unknown): PlayableOutcome | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    const type = String(d.type ?? d.event ?? '').toLowerCase();
    const event = String(d.event ?? '').toUpperCase();
    const outcome = String(d.outcome ?? d.result ?? '').toLowerCase();
    const won = d.success === true || outcome === 'won' || outcome === 'win' || outcome === 'success';
    const lost = d.success === false || outcome === 'lost' || outcome === 'lose' || outcome === 'loss' || outcome === 'fail' || outcome === 'failed';

    if (type === 'completed' || type === 'complete' || type === 'game_completed' || type === 'game-completed') {
      if (won) return 'won';
      if (lost) return 'lost';
    }
    if (type === 'won' || type === 'win' || type === 'victory' || type === 'success') return 'won';
    if (type === 'lost' || type === 'loss' || type === 'failed' || type === 'fail') return 'lost';
    if (event === 'CHALLENGE_SOLVED') return 'won';
    if (event === 'CHALLENGE_FAILED') return 'lost';
    return null;
  }

  private isHostGestureMessage(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    return d.source === 'playable' && d.type === 'host_gesture';
  }

  private isPlayableReadyMessage(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    const type = String(d.type ?? '').toLowerCase();
    return d.source === 'playable' && (type === 'ready' || type === 'loaded');
  }

  private hostGestureDeliveredSynchronously(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    return (data as Record<string, unknown>).deliveredSynchronously === true;
  }

  private pollPlayableAnalytics = () => {
    if (document.hidden) return;
    const i = this.realIndex();
    const frame = this.frames.get(i);
    const runId = frame?.dataset.runId;
    if (!frame || !runId || this.completedRunIds.has(runId)) return;

    try {
      const api = this.playableApi(i);
      if (api?.swipe) return;
      const history = api?.getAnalyticsHistory?.();
      if (!Array.isArray(history)) return;
      for (let n = history.length - 1; n >= 0; n--) {
        const outcome = this.outcomeFromAnalytics(history[n]);
        if (outcome) {
          this.handlePlayableCompleted(i, outcome);
          return;
        }
      }
    } catch {
      /* cross-origin or no analytics hook */
    }
  };

  private outcomeFromAnalytics(record: unknown): PlayableOutcome | null {
    if (!record || typeof record !== 'object') return null;
    const r = record as Record<string, unknown>;
    const event = String(r.event ?? '').toUpperCase();
    if (event === 'CHALLENGE_SOLVED') return 'won';
    if (event === 'CHALLENGE_FAILED') return 'lost';
    if (event === 'COMPLETED') {
      const params = r.params && typeof r.params === 'object' ? r.params as Record<string, unknown> : {};
      const outcome = String(params.outcome ?? '').toLowerCase();
      if (outcome === 'won') return 'won';
      if (outcome === 'lost') return 'lost';
    }
    return null;
  }

  private handlePlayableCompleted(i: number, outcome: PlayableOutcome) {
    const frame = this.frames.get(i);
    const runId = frame?.dataset.runId;
    if (i !== this.realIndex() || !runId) return;

    // Autoplay demo (the player hasn't taken over): never award a star or show the
    // win/fail endcard. The demo just loops — restart and keep playing.
    if (!this.manualRuns.has(i)) {
      this.loopAutoplayMechanic(i);
      return;
    }

    if (this.completedRunIds.has(runId)) return;
    this.completedRunIds.add(runId);
    const mechanicId = this.playables[i]?.id;
    if (outcome === 'won') {
      track('win', { mechanic_id: mechanicId, mode: 'manual' }, runId);
      this.reportResult(i, runId);
      this.handleWin(i);
    } else {
      track('lose', { mechanic_id: mechanicId, mode: 'manual' }, runId);
      this.handleLoss(i);
    }
  }

  // Restart an autoplaying mechanic so the demo loops on win/loss. A short beat lets
  // the result read, then we reset in place and resume autoplay. Deduped per frame
  // so repeated completion signals don't stack restarts.
  private loopAutoplayMechanic(i: number) {
    if (this.autoplayLoopTimers.has(i)) return;
    const t = window.setTimeout(() => {
      this.autoplayLoopTimers.delete(i);
      if (this.manualRuns.has(i) || i !== this.realIndex() || this.collectingRewardIndex !== null) return;
      const api = this.playableApi(i);
      try {
        api?.swipe?.restart();
        if (api?.swipe?.hasAutoPlay) api.swipe.startAutoPlay();
      } catch { /* cross-origin */ }
      // The demo just restarted — reset the camcorder timecode so it counts from 0 again.
      this.reelTimeSeconds = 0;
      const timeEl = this.games[i]?.querySelector<HTMLElement>('.game__reel-time');
      if (timeEl) timeEl.textContent = '0:00:00';
    }, 800);
    this.autoplayLoopTimers.set(i, t);
  }

  private clearAutoplayLoopTimer(i: number) {
    const t = this.autoplayLoopTimers.get(i);
    if (!t) return;
    window.clearTimeout(t);
    this.autoplayLoopTimers.delete(i);
  }

  private handleWin(i: number) {
    if (this.earnedThisCycle.has(i)) {
      this.manualRuns.delete(i);
      this.failedThisCycle.delete(i);
      this.updateMechanicState(i);
      this.applyActiveStates();
      this.resetStoriesToMyLevel();
      return;
    }
    this.failedThisCycle.delete(i);
    this.manualRuns.delete(i);
    this.earnedThisCycle.add(i);
    this.pendingStarRewards.add(i);
    this.claimedStarRewards.delete(i);
    this.updateMechanicState(i);
    this.applyActiveStates();
    this.resetStoriesToMyLevel();
  }

  private handleLoss(i: number) {
    if (this.earnedThisCycle.has(i) || this.failedThisCycle.has(i)) return;
    this.failedThisCycle.add(i);
    this.updateMechanicState(i);
    this.applyActiveStates();
  }

  private updateMechanicStates() {
    for (let i = 0; i < this.N; i++) this.updateMechanicState(i);
  }

  private updateMechanicState(i: number) {
    const game = this.games[i];
    const state = this.stateEls[i];
    if (!game || !state) return;

    const earned = this.earnedThisCycle.has(i);
    const failed = this.failedThisCycle.has(i);
    const manual = this.manualRuns.has(i);
    const pendingReward = earned && this.pendingStarRewards.has(i) && this.collectingRewardIndex !== i;
    game.classList.toggle('game--earned', earned);
    game.classList.toggle('game--failed', failed);
    state.classList.toggle('game__state--earned', pendingReward && !manual);
    state.classList.toggle('game__state--failed', failed);
    this.stopRewardSparks(i);
    state.replaceChildren();
    state.hidden = (!pendingReward || manual) && !failed;
    if (!earned && !failed) return;
    if (earned && !pendingReward) return;

    if (pendingReward && !manual) {
      this.renderRewardState(i, state);
      return;
    }

    if (failed) {
      this.renderFailedState(i, state);
    }
  }

  private replayManual(i: number) {
    this.manualRuns.add(i);
    this.pendingEditorLaunch.delete(i);
    this.failedThisCycle.delete(i);
    this.updateMechanicState(i);
    this.reloadFrame(i);
    this.applyActiveStates();
  }

  // "+1 уровень": bank the current win's stars, then restart the level IN PLACE for
  // a fresh manual run. Resets the win-cycle so COMPLETING the replayed level earns
  // AND credits a new reward — otherwise `earnedThisCycle` short-circuits handleWin
  // (no new reward shows) and the unchanged in-place `runId` makes `completedRunIds`
  // swallow the replayed completion.
  // public (not private) so noUnusedLocals tolerates it while its only call
  // site stays commented out — see the "+1 уровень" note below.
  public restartLevelInPlace(i: number) {
    this.creditPendingRewardImmediate(i);      // don't lose the stars earned this win (idempotent)
    this.earnedThisCycle.delete(i);
    this.failedThisCycle.delete(i);
    this.claimedStarRewards.delete(i);
    this.rewardStars[i] = 0;                    // re-roll a fresh reward on the next win
    this.manualRuns.add(i);
    const swipe = this.playableApi(i)?.swipe;
    if (swipe?.hasRestart) {
      // In-place restart keeps the frame → give it a fresh run id so the next
      // completion isn't deduped away by completedRunIds.
      const frame = this.frames.get(i);
      if (frame) {
        const oldRun = frame.dataset.runId;
        if (oldRun) this.completedRunIds.delete(oldRun);
        frame.dataset.runId = runUid();
      }
      try { swipe.restart({ instant: true }); } catch { /* cross-origin */ }
    } else {
      this.reloadFrame(i);                      // reload assigns its own fresh run id
    }
    this.updateMechanicState(i);                // reward claimed → hide the win overlay
    this.applyActiveStates();
  }

  private renderRewardState(i: number, state: HTMLElement) {
    // Show as many stars as were earned this win, lined up in a ROW — they peel
    // off one-by-one on tap (see flyRewardStarsInPlace).
    const row = this.buildRewardStarRow(this.rewardStarsFor(i));
    this.renderResultState(i, state, row);
    // Readable affordance — placed directly UNDER the action buttons (which sit under
    // the star row), in the reward grid flow. Both a tap and a swipe collect + advance.
    // Win-screen affordance = a SOFT-SWIPE gesture cue (a gently rising chevron —
    // "swipe up for the next game") above the blinking label. The chevron animation
    // was lost when the per-page swipe gutter became a fixed static bottom bar; this
    // restores the soft-swipe hint right by the stars.
    const hint = document.createElement('div');
    hint.className = 'reward__hint';
    hint.innerHTML =
      '<span class="reward__swipe-cue" aria-hidden="true">⌃</span>' +
      '<span class="reward__hint-text">tap or swipe for next game</span>';
    const reward = state.querySelector('.reward');
    const toast = reward?.querySelector('.reward__toast') ?? null;
    reward?.insertBefore(hint, toast);

    // "+1 уровень" CTA temporarily disabled (commented out per request). Kept the
    // code + restartLevelInPlace() intact for when it's re-enabled.
    // const replayLevel = document.createElement('button');
    // replayLevel.type = 'button';
    // replayLevel.className = 'reward__replay-level';
    // replayLevel.textContent = '+1 уровень';
    // const stop = (e: Event) => e.stopPropagation();
    // replayLevel.addEventListener('pointerdown', stop);
    // replayLevel.addEventListener('pointerup', stop);
    // replayLevel.addEventListener('click', (e) => {
    //   e.stopPropagation();
    //   this.restartLevelInPlace(i);
    // });
    // const actions = reward?.querySelector('.reward__actions') ?? null;
    // reward?.insertBefore(replayLevel, actions);

    this.startRewardSparks(i, row);
  }

  // A centred flex row of `n` gold stars that cascade in ("выстроиться друг за
  // другом"). Styled inline so styles.css is untouched. Each `.reward__star-unit`
  // is measured at collect time for its fly-from position.
  private buildRewardStarRow(n: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'reward__stars';
    row.style.cssText = 'display:flex;align-items:flex-end;justify-content:center;gap:clamp(2px,1.4vw,8px);pointer-events:none;';
    const unitPx = n >= 7 ? 46 : n >= 5 ? 54 : 64;   // fit up to 10 across the panel
    for (let k = 0; k < n; k++) {
      const u = document.createElement('span');
      u.className = 'reward__star-unit';
      u.textContent = '★';
      u.style.cssText =
        `display:inline-block;font-size:${unitPx}px;line-height:1;color:#ffd85a;` +
        'transform-origin:50% 100%;will-change:transform;' +
        'filter:drop-shadow(0 8px 16px rgba(255,147,42,0.34));' +
        'text-shadow:0 3px 0 #8d4a12, 0 0 14px rgba(255,221,89,0.5), 0 0 26px rgba(255,105,28,0.22);';
      // Cascade drop-in — each star lands a beat after the previous.
      if (u.animate) u.animate([
        { transform: 'translateY(-46px) scale(0.35)', opacity: 0 },
        { transform: 'translateY(7px) scale(1.1)', opacity: 1, offset: 0.72 },
        { transform: 'translateY(0) scale(1)', opacity: 1 },
      ], { duration: 460, delay: k * 95, easing: 'cubic-bezier(0.2,0.8,0.3,1.3)', fill: 'backwards' });
      row.appendChild(u);
    }
    return row;
  }

  private renderFailedState(i: number, state: HTMLElement) {
    // On a loss: no big centre icon — just the 4 action buttons.
    this.renderResultState(i, state, null);
  }

  private renderResultState(i: number, state: HTMLElement, centerEl: HTMLElement | null): void {
    const reward = document.createElement('div');
    reward.className = 'reward';

    if (centerEl) reward.appendChild(centerEl);

    const actions = document.createElement('div');
    actions.className = 'reward__actions';
    reward.appendChild(actions);

    const replay = this.rewardButton('↻', 'Replay', 'reward__action--replay');
    replay.addEventListener('click', () => this.replayManual(i));
    actions.appendChild(replay);

    const swipe = this.playableApi(i)?.swipe;

    const likedInitially = this.likedMechanics.has(i);
    const like = this.rewardButton(likedInitially ? '♥' : '♡', 'Like', 'reward__action--like');
    const likeCount = document.createElement('span');
    likeCount.className = 'reward__count';
    likeCount.textContent = this.formatLikeCount(this.getLikeCount(i));
    like.appendChild(likeCount);
    like.classList.toggle('reward__action--liked', likedInitially);
    like.addEventListener('click', () => {
      const liked = !this.likedMechanics.has(i);
      const next = this.getLikeCount(i) + (liked ? 1 : -1);
      if (liked) this.likedMechanics.add(i);
      else this.likedMechanics.delete(i);
      this.likeCounts.set(i, Math.max(0, next));
      like.classList.toggle('reward__action--liked', liked);
      like.firstElementChild!.textContent = liked ? '♥' : '♡';
      likeCount.textContent = this.formatLikeCount(this.getLikeCount(i));
      if (like.animate) {
        like.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.16)' }, { transform: 'scale(1)' }],
          { duration: 230, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.4)' },
        );
      }
    });
    actions.appendChild(like);

    const post = this.rewardButton(this.postedStories.has(i) ? '✓' : '◎', 'Post to story', 'reward__action--post');
    post.classList.toggle('reward__action--posted', this.postedStories.has(i));
    post.addEventListener('click', () => this.postMechanicAsStory(i, post));
    actions.appendChild(post);

    const edit = this.rewardButton('✎', 'Edit level', 'reward__action--edit');
    edit.addEventListener('click', () => {
      if (swipe?.hasEditor) {
        try { swipe.openEditor(); } catch { /* noop */ }
        state.hidden = true;
        return;
      }
      this.openMechanicEditor(i);
    });
    actions.appendChild(edit);

    const toast = document.createElement('div');
    toast.className = 'reward__toast';
    reward.appendChild(toast);

    state.appendChild(reward);

    // No separate swipe hint here — the permanent swipe bar shows below this overlay
    // (the overlay is inset above it) in the exact same spot, already reading
    // "swipe for next mechanic", and a swipe on it collects the reward.
  }

  private rewardButton(icon: string, label: string, extraClass: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = `reward__action ${extraClass}`;
    btn.type = 'button';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = `<span class="reward__icon">${icon}</span>`;
    const stop = (e: Event) => {
      e.stopPropagation();
    };
    btn.addEventListener('pointerdown', stop);
    btn.addEventListener('pointerup', (e) => e.stopPropagation());
    return btn;
  }

  // Current star reward for this frame's CURRENT appearance.
  private rewardStarsFor(i: number): number {
    if (!this.rewardStars[i]) this.rollReward(i);
    return this.rewardStars[i];
  }

  // A won mechanic awards a RANDOM 1–5 stars (re-rolled fresh each appearance).
  private rollReward(i: number): void {
    this.rewardStars[i] = 1 + Math.floor(Math.random() * 5);
    const el = this.rewardEls[i];
    if (el) el.innerHTML = '<span class="game__reward-star">★</span>'.repeat(this.rewardStars[i]);
  }

  private getLikeCount(i: number): number {
    const existing = this.likeCounts.get(i);
    if (existing !== undefined) return existing;
    let hash = 0;
    const id = this.playables[i]?.id ?? String(i);
    for (let n = 0; n < id.length; n++) hash = (hash * 31 + id.charCodeAt(n)) >>> 0;
    const count = 320 + (hash % 9400);
    this.likeCounts.set(i, count);
    return count;
  }

  private formatLikeCount(count: number): string {
    if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K`;
    return String(count);
  }

  private postMechanicAsStory(i: number, button: HTMLButtonElement) {
    this.postedStories.add(i);
    button.classList.add('reward__action--posted');
    const icon = button.querySelector('.reward__icon');
    if (icon) icon.textContent = '✓';
    const you = this.storiesEl?.querySelector('.story--me');
    you?.classList.add('story--posted');
    const toast = this.stateEls[i]?.querySelector<HTMLElement>('.reward__toast');
    if (toast) {
      toast.textContent = 'Posted to story';
      toast.classList.remove('reward__toast--show');
      toast.offsetHeight;
      toast.classList.add('reward__toast--show');
    }
  }

  private openMechanicEditor(i: number) {
    this.manualRuns.add(i);
    this.failedThisCycle.delete(i);
    this.pendingEditorLaunch.add(i);
    this.updateMechanicState(i);
    this.reloadFrame(i);
    this.applyActiveStates();
    this.applyPendingEditor(i);
  }

  private applyPendingEditor(i: number, attempt: number = 0) {
    if (!this.pendingEditorLaunch.has(i)) return;
    const api = this.playableApi(i);
    try {
      if (typeof api?.setEditorMode === 'function') {
        api.setEditorMode(true);
        this.pendingEditorLaunch.delete(i);
        return;
      }
      if (typeof api?.toggleEditor === 'function') {
        api.toggleEditor();
        this.pendingEditorLaunch.delete(i);
        return;
      }
    } catch {
      /* retry below */
    }

    if (attempt < 10) {
      window.setTimeout(() => this.applyPendingEditor(i, attempt + 1), 120);
      return;
    }

    this.pendingEditorLaunch.delete(i);
    this.openEditor();
  }

  private startRewardSparks(i: number, star: HTMLElement) {
    this.stopRewardSparks(i);
    const emit = (count: number) => {
      if (!star.isConnected) { this.stopRewardSparks(i); return; }
      const starRect = star.getBoundingClientRect();
      // Position in VIEWPORT coordinates: sparks live on the fixed viewport layer,
      // not inside the page overlay, so a collect-swipe can't drag them upward.
      const vp = this.viewport.getBoundingClientRect();
      const cx = starRect.left - vp.left + starRect.width / 2;
      const cy = starRect.top - vp.top + starRect.height / 2;
      for (let n = 0; n < count; n++) this.spawnRewardSpark(i, cx, cy, starRect.width);
    };

    emit(16);
    // Loop continuously while the win screen is up — stops only on collect
    // (stopRewardSparks) or when the star leaves the DOM (emit's isConnected guard).
    const timer = window.setInterval(() => emit(2 + Math.floor(Math.random() * 3)), 260);
    this.rewardSparkTimers.set(i, timer);
  }

  private stopRewardSparks(i: number) {
    const timer = this.rewardSparkTimers.get(i);
    if (timer) window.clearInterval(timer);
    this.rewardSparkTimers.delete(i);
  }

  private spawnRewardSpark(i: number, cx: number, cy: number, starSize: number) {
    const state = this.stateEls[i];
    if (!state || state.hidden) return;
    const spark = document.createElement('div');
    spark.className = 'reward__spark';
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.55;
    const radius = starSize * (0.16 + Math.random() * 0.22);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    const size = 6 + Math.random() * 7;
    const dist = 44 + Math.random() * 58;
    const dx = Math.cos(angle) * dist + (Math.random() - 0.5) * 22;
    const dy = Math.sin(angle) * dist - 18 - Math.random() * 24;
    spark.style.left = `${x}px`;
    spark.style.top = `${y}px`;
    spark.style.width = `${size}px`;
    spark.style.height = `${size}px`;
    // Brighter palette — leans gold/white with hot-orange accents.
    const r = Math.random();
    spark.style.background = r < 0.5 ? '#ffe27a' : (r < 0.8 ? '#ffac3a' : '#fff6d4');
    // Fixed viewport layer so a collect-swipe doesn't carry the sparks up the page.
    this.viewport.appendChild(spark);

    const duration = 520 + Math.random() * 360;
    if (!spark.animate) {
      window.setTimeout(() => spark.remove(), duration);
      return;
    }
    const anim = spark.animate([
      { transform: 'translate(-50%, -50%) scale(0.45)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0.95, offset: 0.18 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.18)`, opacity: 0 },
    ], { duration, easing: 'cubic-bezier(0.14, 0.72, 0.28, 1)', fill: 'forwards' });
    anim.addEventListener('finish', () => spark.remove(), { once: true });
  }

  // Paired slide to the next mechanic: the won page slides OUT (carrying its dark
  // overlay) while the next slides IN. Both iframes are hidden during the slide
  // (game--leaving / game--arriving) to avoid compositing judder; the incoming
  // autoplay starts once it has arrived. Runs IMMEDIATELY — the star credit is a
  // parallel background op, so it never gates this transition.
  private slideToNext(leavingIdx: number, advanceToPos: number) {
    this.holdNextAutoplay = true;
    const arrivingIdx = this.indexForPos(advanceToPos);
    this.games[arrivingIdx]?.classList.add('game--arriving');
    this.games[leavingIdx]?.classList.add('game--leaving');
    this.goTo(advanceToPos);
    window.setTimeout(() => {
      this.games[arrivingIdx]?.classList.remove('game--arriving');
      this.games[leavingIdx]?.classList.remove('game--leaving');
      this.updateMechanicState(leavingIdx);   // reward claimed → tear down the won overlay
    }, 430);
    window.setTimeout(() => {
      this.holdNextAutoplay = false;
      this.ensureFrameAutoPlay(this.realIndex());
      this.pollAutoplayUi();
    }, 720);
  }

  private collectReward(i: number, advanceToPos: number | null = null) {
    if (!this.pendingStarRewards.has(i) || this.collectingRewardIndex !== null) return false;
    this.collectingRewardIndex = i;
    this.applyActiveStates();   // freeze all frames for the duration of the credit
    this.stopRewardSparks(i);

    const state = this.stateEls[i];
    const units = state ? Array.from(state.querySelectorAll<HTMLElement>('.reward__star-unit')) : [];
    const reward = state?.querySelector<HTMLElement>('.reward') ?? null;
    state?.classList.add('game__state--collecting');
    reward?.classList.add('reward--collecting');

    const afterCollect = () => {
      this.collectingRewardIndex = null;
      this.pendingStarRewards.delete(i);
      this.claimedStarRewards.add(i);
      this.finishStarReward(i);   // credits the star (counter bump ~LEVEL_PROGRESS_MS)
      if (advanceToPos !== null) {
        // Star is credited — now the won page SLIDES OUT (carrying its dark win overlay)
        // while the next mechanic slides in. The won page's iframe is hidden during the
        // slide (game--leaving) so a ready iframe layer isn't composited+moved (judder);
        // its dark overlay is the panel that visibly drives away. The incoming iframe is
        // likewise hidden (game--arriving) until it has arrived. This reads as a real
        // paired slide (previous leaves, next enters) — not a dark curtain lifting.
        window.setTimeout(() => {
          this.holdNextAutoplay = true;       // don't start the incoming autoplay mid-slide
          const arrivingIdx = this.indexForPos(advanceToPos);
          const leavingIdx = i;
          this.games[arrivingIdx]?.classList.add('game--arriving');
          this.games[leavingIdx]?.classList.add('game--leaving');
          this.goTo(advanceToPos);
          // Once both have arrived (slide 0.36s + settle buffer): reveal the incoming
          // mechanic (static), and tear down the now-off-screen won screen.
          window.setTimeout(() => {
            this.games[arrivingIdx]?.classList.remove('game--arriving');
            this.games[leavingIdx]?.classList.remove('game--leaving');
            state?.classList.remove('game__state--collecting');
            reward?.classList.remove('reward--collecting');
            this.updateMechanicState(leavingIdx);
          }, 430);
          // A beat after it's shown, START its autoplay — appears static first, then plays.
          window.setTimeout(() => {
            this.holdNextAutoplay = false;
            this.ensureFrameAutoPlay(this.realIndex());
            this.pollAutoplayUi();
          }, 720);
        }, LEVEL_PROGRESS_MS + 90);
      } else {
        // No advance (level-up path owns the transition) — just clear the won screen.
        state?.classList.remove('game__state--collecting');
        reward?.classList.remove('reward--collecting');
        this.updateMechanicState(i);
      }
    };

    // Reuse the SAME star elements (no clones / no disappear-reappear) here too —
    // the level-up screen owns the transition, but the collect flight is identical.
    this.flyRewardStarsInPlace(units, afterCollect);
    return true;
  }

  private rewardWouldLevelUp(): boolean {
    const currentLevel = this.levelForStars(this.totalStars);
    const nextLevel = this.levelForStars(this.totalStars + this.rewardStarsFor(this.realIndex()));
    return nextLevel > currentLevel;
  }

  // Fly the earned stars into the level counter: lift each REAL `.reward__star-unit`
  // onto the fixed viewport, pinned exactly where it sat (no clone → no visible
  // disappear/appear), where it waits and then hops to the counter one-by-one
  // (squash → jump → fly, WAAPI/compositor). The ring grows one star's worth per
  // impact. Used by BOTH the win-screen swipe (won page slides away — the lifted
  // stars animate independently on the fixed layer) and the level-up collect.
  private flyRewardStarsInPlace(units: HTMLElement[], onDone: () => void) {
    const vp = this.viewport.getBoundingClientRect();
    const badge = this.levelBadgeEl?.getBoundingClientRect();
    const badgeX = badge ? badge.left - vp.left + badge.width / 2 : 40;
    const badgeY = badge ? badge.top - vp.top + badge.height / 2 : 40;
    const badgeRadius = badge ? Math.min(badge.width, badge.height) / 2 : 28;
    const n = units.length;
    this.burstStarConfetti();
    if (n === 0) { onDone(); return; }

    const level = this.levelForStars(this.totalStars);
    const need = this.starsForLevel(level);
    const base = this.starsIntoLevel(this.totalStars);
    let landed = 0;
    const onLand = () => {
      this.burstRewardCollectParticles(badgeX, badgeY, Math.max(22, badgeRadius - 2));
      this.bumpLevelBadge();
      landed++;
      this.setLevelProgress(Math.min(1, (base + landed) / need), true, RING_STEP_MS);
      if (landed >= n) onDone();
    };

    // Capture every star's rect BEFORE lifting any — reparenting empties the flex row
    // and would reflow the rest.
    const starts = units.map((u) => {
      const r = u.getBoundingClientRect();
      return { left: r.left - vp.left, top: r.top - vp.top, w: r.width, h: r.height };
    });

    units.forEach((unit, k) => {
      const s = starts[k];
      // Pin the SAME element on the viewport at its exact spot; keep its natural size.
      unit.style.position = 'absolute';
      unit.style.left = `${s.left}px`;
      unit.style.top = `${s.top}px`;
      unit.style.margin = '0';
      unit.style.zIndex = '2660';               // above the sliding pages + HUD (see .star-flight--collect)
      unit.style.pointerEvents = 'none';
      unit.style.transformOrigin = '50% 100%';   // squash/leap anchored to the base
      unit.style.willChange = 'transform';
      unit.style.transform = 'none';             // sits in place until its turn
      this.viewport.appendChild(unit);

      // Offset (from the pinned spot) that lands the star's CENTRE on the badge centre.
      const toX = badgeX - s.left - s.w / 2;
      const toY = badgeY - s.top - s.h / 2;
      const jump = Math.max(s.w, s.h) * 0.55;
      let done = false;
      const land = () => { if (done) return; done = true; onLand(); unit.remove(); };

      const launch = () => {
        // The transform-origin is bottom-center (50% 100%) for the squash/jump, so
        // scaling to 0.5 pulls the star's CENTRE down by s.h/4. Lift the final Y by
        // that much so the shrunken star's centre lands on the counter centre.
        const landY = toY - s.h * 0.25;
        if (!unit.animate) {
          unit.style.transform = `translate3d(${toX}px, ${landY}px, 0) scale(0.5, 0.5)`;
          window.setTimeout(land, REWARD_BOUNCE_MS);
          return;
        }
        const anim = unit.animate([
          { transform: 'translate3d(0,0,0) scale(1,1)', easing: 'cubic-bezier(0.4,0,0.6,1)' },
          { transform: 'translate3d(0,0,0) scale(1.34,0.66)', offset: 0.26, easing: 'cubic-bezier(0.2,0.7,0.3,1)' },        // squash — longer wind-up before the jump
          { transform: `translate3d(0,${-jump}px,0) scale(0.78,1.26)`, offset: 0.40, easing: 'cubic-bezier(0.33,0,0.3,1)' },  // jump — stretch tall
          // settle back to ORIGINAL size at the apex, then ACCELERATE into the counter
          // (ease-IN, no trailing slow-down) so it lands at full speed and is removed
          // crisply on impact — and shrinks to HALF size over the flight.
          { transform: `translate3d(0,${-jump}px,0) scale(1,1)`, offset: 0.52, easing: 'cubic-bezier(0.55,0.055,0.675,0.19)' },
          { transform: `translate3d(${toX}px,${landY}px,0) scale(0.5,0.5)`, opacity: 1 },
        ], { duration: REWARD_BOUNCE_MS, fill: 'forwards' });
        anim.addEventListener('finish', land, { once: true });
      };
      window.setTimeout(launch, k * REWARD_PEEL_STAGGER_MS);
    });
  }

  // Level-up-style confetti: a one-shot burst that rains down evenly across the
  // WHOLE screen from the top. Lives on the fixed viewport layer.
  private burstStarConfetti() {
    const colors = ['#ffd85a', '#45d68c', '#37a6ff', '#ff4f8b', '#ff9f45', '#b07bff', '#5ee6a8'];
    const rect = this.viewport.getBoundingClientRect();
    const count = 40;
    for (let n = 0; n < count; n++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      const w = 7 + Math.random() * 7, h = 10 + Math.random() * 10;
      // Spread evenly across the width (n-based columns + jitter) so the fall is uniform.
      const x = ((n + Math.random()) / count) * rect.width;
      c.style.cssText =
        `left:${x}px;top:-24px;width:${w}px;height:${h}px;z-index:2580;` +
        `background:${colors[(n + Math.floor(Math.random() * colors.length)) % colors.length]};` +
        `border-radius:${Math.random() < 0.4 ? '50%' : '2px'};`;
      this.viewport.appendChild(c);
      const dur = 1500 + Math.random() * 1100;
      if (!c.animate) { window.setTimeout(() => c.remove(), dur); continue; }
      const driftX = (Math.random() - 0.5) * 150;
      const fall = rect.height + 80;
      const rot = Math.random() * 900 - 450;
      const a = c.animate([
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${driftX}px, ${fall}px) rotate(${rot}deg)`, opacity: 1, offset: 0.85 },
        { transform: `translate(${driftX}px, ${fall + 40}px) rotate(${rot}deg)`, opacity: 0 },
      ], { duration: dur, delay: Math.random() * 220, easing: 'cubic-bezier(0.3, 0.2, 0.5, 1)', fill: 'forwards' });
      a.addEventListener('finish', () => c.remove(), { once: true });
    }
  }

  // Ember burst at the counter when the star lands — styled like the coal sparks
  // ("угольки") in the pins playable: hot orange embers with a glowing core that
  // pop outward (upward-biased), wiggle, and fade.
  private burstRewardCollectParticles(x: number, y: number, rimRadius: number = 17) {
    for (let n = 0; n < 9; n++) {
      const p = document.createElement('div');
      p.className = 'ember';
      const size = 4 + Math.random() * 5;
      // Radial splash (all directions), matching the coin-into-piggy burst in
      // merge-second-board-v2 (`spawnBurst`, ~6 sparks radiating off the slot) —
      // reads as the star "splashing" into the counter, not a one-way ember spray.
      // Each spark STARTS at the badge rim (startR) and flies OUTWARD so nothing
      // piles up on the counter centre (which read as a red disc).
      const angle = Math.random() * Math.PI * 2;
      const startR = rimRadius + Math.random() * 6;
      const endR = startR + 24 + Math.random() * 34;
      const ux = Math.cos(angle), uy = Math.sin(angle);
      const wob = (Math.random() - 0.5) * 16;   // slight sideways wiggle
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      this.viewport.appendChild(p);

      const at = (r: number) => `translate(calc(-50% + ${ux * r + wob}px), calc(-50% + ${uy * r}px))`;
      const dur = 420 + Math.random() * 360;
      if (!p.animate) { window.setTimeout(() => p.remove(), dur); continue; }
      const anim = p.animate([
        { transform: `${at(startR)} scale(0.6)`, opacity: 0 },
        { transform: `${at((startR + endR) / 2)} scale(1)`, opacity: 1, offset: 0.3 },
        { transform: `${at(endR)} scale(0.25)`, opacity: 0 },
      ], { duration: dur, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' });
      anim.addEventListener('finish', () => p.remove(), { once: true });
    }
  }

  private reloadFrame(i: number) {
    const frame = this.frames.get(i);
    if (frame) {
      const runId = frame.dataset.runId;
      if (runId) this.completedRunIds.delete(runId);
      this.clearAutoplayLoopTimer(i);
      this.disposeFrame(i, frame);
      this.frames.delete(i);
      this.resetFrameReadiness(i);
    }
    this.games[i].classList.add('game--loading');
    if (this.liveSet().has(i)) this.mount(i);
  }

  private resetCycle() {
    const reload = new Set([...this.earnedThisCycle, ...this.failedThisCycle]);
    this.manualRuns.clear();
    this.pendingEditorLaunch.clear();
    this.pendingStarRewards.clear();
    this.claimedStarRewards.clear();
    this.collectingRewardIndex = null;
    if (reload.size === 0) return;
    this.earnedThisCycle.clear();
    this.failedThisCycle.clear();
    reload.forEach((i) => this.stopRewardSparks(i));
    this.updateMechanicStates();
    reload.forEach((i) => this.reloadFrame(i));
  }

  private isForwardCycleWrap(fromPos: number, targetPos: number): boolean {
    if (targetPos <= fromPos) return false;
    const from = ((fromPos % this.N) + this.N) % this.N;
    const to = ((targetPos % this.N) + this.N) % this.N;
    return from === this.N - 1 && to === 0;
  }

  // Stars required to CLEAR a given level: L1=5, L2=6, L3=7 … +1 per level,
  // capped at 10 from L6 on. (Reward per win is 1–5, so a single reward crosses
  // at most one boundary — the level-up path stays single-shot.)
  private starsForLevel(level: number): number { return Math.min(STARS_PER_LEVEL + (level - 1), 10); }
  // Current level for a cumulative star total (walks the rising thresholds).
  private levelForStars(total: number): number {
    let level = 1, rem = Math.max(0, Math.floor(total));
    while (rem >= this.starsForLevel(level)) { rem -= this.starsForLevel(level); level++; }
    return level;
  }
  // Stars accumulated WITHIN the current level (the ring's numerator).
  private starsIntoLevel(total: number): number {
    let level = 1, rem = Math.max(0, Math.floor(total));
    while (rem >= this.starsForLevel(level)) { rem -= this.starsForLevel(level); level++; }
    return rem;
  }

  private updateHud(animate: boolean = true) {
    const level = this.levelForStars(this.totalStars);
    const progress = this.starsIntoLevel(this.totalStars) / this.starsForLevel(level);
    if (this.levelEl) this.levelEl.textContent = String(level);
    this.setLevelProgress(progress, animate);
  }

  private setLevelProgress(progress: number, animate: boolean = true, durationMs?: number) {
    if (!this.levelProgressEl) return;
    const clamped = Math.max(0, Math.min(1, progress));
    this.levelProgressEl.style.transition = !animate
      ? 'none'
      : durationMs != null ? `--level-progress ${durationMs}ms ease-out` : '';
    this.levelProgressEl.style.setProperty('--level-progress', `${clamped * 360}deg`);
    if (!animate) {
      this.levelProgressEl.offsetHeight;
      this.levelProgressEl.style.transition = '';
    }
  }

  private bumpLevelBadge() {
    const el = this.levelBadgeEl;
    if (!el) return;
    if (!el.animate) {                   // ancient browser fallback — CSS scale-pop
      el.classList.remove('hud__level--bump');
      void el.offsetWidth;
      el.classList.add('hud__level--bump');
      window.setTimeout(() => el.classList.remove('hud__level--bump'), 440);
      return;
    }
    // Anisotropic SQUASH — wide-and-flat sine pulse (sx=1+p, sy=1-p), matching
    // the coin-into-piggy reaction in merge-second-board-v2 (COINBOX_SQUASH:
    // intensity 0.16 over 220ms). Reads as the counter "absorbing" the star,
    // not the generic uniform scale-pop the CSS --bump gives. Cancel any
    // in-flight squash first so consecutive arrivals restart cleanly.
    const P = 0.16, H = 0.707 * P;       // H = value at sine quarter-points
    this.levelBadgeSquash?.cancel();
    this.levelBadgeSquash = el.animate([
      { transform: 'scale(1, 1)' },
      { transform: `scale(${1 + H}, ${1 - H})`, offset: 0.25 },
      { transform: `scale(${1 + P}, ${1 - P})`, offset: 0.5 },
      { transform: `scale(${1 + H}, ${1 - H})`, offset: 0.75 },
      { transform: 'scale(1, 1)' },
    ], { duration: 220, easing: 'linear' });
  }

  private pulseLevelUp() {
    this.hudEl?.classList.add('hud--level-up');
    window.setTimeout(() => this.hudEl?.classList.remove('hud--level-up'), 420);
  }

  private finishStarReward(i: number): boolean {
    const prev = this.totalStars;
    const prevLevel = this.levelForStars(prev);
    this.totalStars = prev + this.rewardStarsFor(i);
    const nextLevel = this.levelForStars(this.totalStars);

    if (nextLevel > prevLevel) {
      this.setLevelProgress(1, true);
      if (!this.levelUpPageEl) {
        const overlay = this.playLevelUp(nextLevel);
        this.holdLevelUpUntilSwipe(i, overlay);
      }
      window.setTimeout(() => {
        this.updateHud(false);                 // ring resets to the new level (0 progress)
        this.pulseLevelUp();
      }, LEVEL_PROGRESS_MS);
      return true;
    } else {
      this.updateHud(true);
      // No bump here — the single counter pulse fires in flyRewardStarsInPlace's
      // onLand (exactly when the star arrives/is removed), so it isn't duplicated.
      return false;
    }
  }

  private playLevelUp(level: number): HTMLElement {
    const overlay = document.createElement('div');
    overlay.className = 'levelup';
    overlay.innerHTML = this.levelUpMarkup(level);
    // Legacy bottom swipe hint, kept here for quick restore if needed:
    // overlay.insertAdjacentHTML('beforeend',
    //   '<div class="levelup__gutter-hint">' +
    //     '<div class="gutter__grip"></div>' +
    //     '<div class="gutter__label"><span class="gutter__chev">▲</span> Swipe up for next game</div>' +
    //   '</div>');
    this.viewport.appendChild(overlay);
    this.attachSwipeSurface(overlay);
    this.spawnConfetti(overlay);

    const card = overlay.querySelector('.levelup__card') as HTMLElement | null;
    if (overlay.animate) overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
    if (card && card.animate) {
      card.animate([
        { transform: 'scale(0.4)', opacity: 0 },
        { transform: 'scale(1.14)', opacity: 1, offset: 0.55 },
        { transform: 'scale(1)', opacity: 1 },
      ], { duration: 460, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.4)', fill: 'forwards' });
    }
    return overlay;
  }

  private holdLevelUpUntilSwipe(i: number, overlay: HTMLElement) {
    this.releaseHeldLevelUp(false);
    this.heldLevelUpOverlay = overlay;
    this.heldLevelUpIndex = i;
    this.gutters[i]?.classList.add('gutter--levelup-prompt');
  }

  private releaseHeldLevelUp(animate: boolean = true) {
    this.stopConfetti();
    const overlay = this.heldLevelUpOverlay;
    const index = this.heldLevelUpIndex;
    this.heldLevelUpOverlay = null;
    this.heldLevelUpIndex = null;
    if (index !== null) this.gutters[index]?.classList.remove('gutter--levelup-prompt');
    if (!overlay) return;

    if (!animate || !overlay.animate) {
      overlay.remove();
      return;
    }
    const out = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' });
    out.addEventListener('finish', () => overlay.remove(), { once: true });
  }

  private spawnConfetti(parent: HTMLElement) {
    const colors = ['#ffd85a', '#45d68c', '#37a6ff', '#ff4f8b', '#ff9f45', '#b07bff', '#5ee6a8'];
    const emitWave = (count: number) => {
      const rect = this.viewport.getBoundingClientRect();
      for (let n = 0; n < count; n++) {
        const c = document.createElement('div');
        c.className = 'confetti';
        const w = 6 + Math.random() * 6, h = 9 + Math.random() * 9;
        // Spread evenly across the width (column + jitter) so the fall is uniform.
        const x = ((n + Math.random()) / count) * rect.width;
        c.style.cssText =
          `left:${x}px;top:-24px;width:${w}px;height:${h}px;` +
          `background:${colors[(n + Math.floor(Math.random() * colors.length)) % colors.length]};` +
          `border-radius:${Math.random() < 0.4 ? '50%' : '2px'};`;
        parent.appendChild(c);
        const dur = 2400 + Math.random() * 1000;   // longer, lazier fall
        if (!c.animate) { window.setTimeout(() => c.remove(), dur); continue; }
        const driftX = (Math.random() - 0.5) * 150;
        const fall = rect.height + 80;
        const rot = Math.random() * 900 - 450;
        const a = c.animate([
          { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
          { transform: `translate(${driftX}px, ${fall}px) rotate(${rot}deg)`, opacity: 1, offset: 0.85 },
          { transform: `translate(${driftX}px, ${fall + 40}px) rotate(${rot}deg)`, opacity: 0 },
        ], { duration: dur, delay: Math.random() * 260, easing: 'cubic-bezier(0.3, 0.2, 0.5, 1)', fill: 'forwards' });
        a.addEventListener('finish', () => c.remove(), { once: true });
      }
    };

    emitWave(34);                                   // opening burst
    // Rain continuously and evenly until the level-up screen is dismissed (tap/swipe)
    // — stops when the parent leaves the DOM or stopConfetti() is called. Modest
    // per-wave count keeps the steady-state node count (and heat) in check.
    if (this.confettiTimer) window.clearInterval(this.confettiTimer);
    this.confettiTimer = window.setInterval(() => {
      if (!parent.isConnected) { this.stopConfetti(); return; }
      emitWave(7);
    }, 520);
  }

  private stopConfetti() {
    if (this.confettiTimer) { window.clearInterval(this.confettiTimer); this.confettiTimer = null; }
  }

  // Normalise after a slide arrives: resume the arrived game, pause the rest, warm
  // the next. Runs on transitionend, or synchronously for an instant (no-slide) goTo.
  private settleSlide() {
    const leavingLevelUp = this.levelUpPageState === 'leaving';
    this.settlingTargetIndex = null;
    this.pos = this.realIndex();      // keep pos bounded; same visual (delta mod N)
    this.liveHold.clear();
    this.render(false);
    if (this.resetCycleAfterSettle) {
      this.resetCycleAfterSettle = false;
      this.resetCycle();
    }
    this.updateLive();
    this.applyActiveStates();
    // Warm diagnostics: was the mechanic we just landed on already pre-warmed?
    this.wlog(`arrived at #${this.realIndex()} → ${this.frameRevealed.has(this.realIndex()) ? 'WARM ✓ (no preloader)' : 'COLD ✗ (shows preloader now)'}`);
    this.warmCalmMax = 0;   // reset the calm-window tracker for the new current mechanic
    // Clear the level-up page (→ state 'idle') BEFORE scheduling the warm. Otherwise
    // desiredWarmIndex() short-circuits on `levelUpPageState !== 'idle'` and the next
    // mechanic never gets pre-warmed — it cold-loads (dark preloader) on the next
    // swipe. That's the "level-up breaks the next mechanic's warming" bug.
    if (leavingLevelUp) this.removeLevelUpPage();
    this.scheduleWarmNext();
    this.prefetchReserve();
    this.pumpPrefetchQueue();
    // Arrived: re-park the resident poster layer under the new current page
    // (render(false) above already reset transform/z) and repoint it at the
    // NEW next mechanic for the following swipe.
    this.updateIncomingPoster();
    // Telemetry: we left the previous unit and are now showing this one (only if
    // it's revealed — a cold-arriving frame emits unit_shown from tryRevealFrame).
    if (this.frameRevealed.has(this.realIndex())) this.markUnitShown(this.realIndex());
  }

  // ── Paging ───────────────────────────────────────────────────────────────
  goTo(targetPos: number, instant: boolean = false) {
    const fromPos = Math.round(this.pos);
    const fromIndex = this.indexForPos(fromPos);
    const targetIndex = this.indexForPos(targetPos);
    const changed = targetPos !== this.pos;
    const pageChanged = targetIndex !== fromIndex;
    if (changed && pageChanged) {
      this.clearWarmTimer();
      this.warmIndex = null;
      this.liveHold = new Set([fromIndex, targetIndex]);
      this.settlingTargetIndex = targetIndex;
      this.stopRewardSparks(fromIndex);
      if (this.isForwardCycleWrap(fromPos, targetPos)) this.resetCycleAfterSettle = true;
      // Live-ride teleport for PROGRAMMATIC advances (▲ button / post-win):
      // the parked-in-viewport page sits at translateY(0) already — animating
      // "to 0" would show no ride. Recompute it at its normal off-screen
      // offset first (settlingTargetIndex is set, so the park override is off)
      // and force the style flush; the animated pass below then rides it in.
      if (!instant) {
        const savedPos = this.pos;
        this.pos = fromPos;
        this.render(false);
        void this.feedEl.offsetHeight;
        this.pos = savedPos;
      }
    }
    this.pos = targetPos;
    this.render(!instant);
    if (changed && pageChanged) {
      if (instant) { this.settleSlide(); return; }   // no slide — settle now (used under the collect cover)
      this.prefetchReserve();   // keep the reserve topped up
      // Safety net: the page-only transitionend filter above means we no longer settle
      // on stray inner transitions. If the page's own transform transitionend is ever
      // missed (interrupted/coalesced), settle anyway just after the slide should end.
      window.setTimeout(() => {
        if (!this.dragging && this.settlingTargetIndex === targetIndex) this.settleSlide();
      }, 460);
    } else if (changed) {
      this.settlingTargetIndex = null;
    } else {
      this.settlingTargetIndex = null;
      this.liveHold.clear();
      this.updateLive();
      this.applyActiveStates();
      this.pumpPrefetchQueue();
    }
    // resume/pause happens on the transitionend (= after the slide)
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  private measure() {
    this.pageH = this.feedEl.getBoundingClientRect().height;
  }

  private onResize = () => {
    this.measure();
    this.render(false);
    // Slot geometry changed with the viewport — re-measure the resident
    // poster layer's box (force by resetting the identity guard).
    this.incomingIndex = -1;
    this.updateIncomingPoster();
  };
}

export function createFeed(viewport: HTMLElement, feedEl: HTMLElement) {
  return new Feed(viewport, feedEl, PLAYABLES);
}
