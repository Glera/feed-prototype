import {
  PLAYABLES,
  playableUrl,
  playablePayloadUrl,
  coverUrl,
  setCoverBucket,
  mechanicMountCost,
  mechanicPrefetchBytes,
  mechanicAssetUrls,
  type Playable,
} from './playables';
// Series-reward gift icons (inlined into the single-file feed bundle). One is picked
// at random per mechanic for the chest in the series-row panel.
import REWARD_ICON_1 from './assets/reward_lvl1.png';
import REWARD_ICON_2 from './assets/reward_lvl2.png';
import REWARD_ICON_3 from './assets/reward_lvl3.png';
import REWARD_ICON_4 from './assets/reward_lvl4.png';
const REWARD_ICONS = [REWARD_ICON_1, REWARD_ICON_2, REWARD_ICON_3, REWARD_ICON_4];
import STAR_GOLDEN from './assets/rarity_star_golden.png';
// Puzzle piece — meta-currency dropped from the series chest (1–5 per win). Flies
// up-right into the puzzle counter on the friends panel.
import PUZZLE_ICON from './assets/puzzle-icon-28387.png';
import {
  COLLECTIONS,
  collectedCardIndexes,
  collectionById,
  loadCollectionsProgressState,
  makeCollectionCard,
  randomCard,
  type CollectionCard,
} from './collections';
import {
  apiSession, apiMe, variantIdForMechanic,
  apiAllocateAuthorizedCatalogRequired, apiGetCatalogCanaryAuthorityRequired,
  apiGetCatalogFeedAuthorityRequired,
  apiGetCatalogTicketSpecsRequired, ApiRequestError,
  apiDailySync, apiDailyClaim, currentTzOffsetMinutes,
  apiCreateChallenge, apiAcceptChallenge, apiChallengeInbox,
  type BuiltinFeedBindingV1, type BuiltinFeedBindingsV1,
  type CatalogAllocationDecisionResult, type CatalogRunTicketRequestV2,
  type CatalogRunTicketViewV2, type CatalogRunTicketViewV3,
  type ChallengeView, type ChallengeInboxItem, type DailyStateResp, type PublicIslandView, type RunTicketRequest,
  type SessionResp,
} from './api';
import {
  queueResult,
  queueResultWithReceipt,
  queueRunTicketStart,
  flushResults,
  onResultTerminal,
  pendingPuzzles,
  type ConfirmedBalances,
} from './outbox';
import { ActiveDwellAccumulator } from './active-dwell.mjs';
import { catalogResultAllowsProgress } from './result-receipts.mjs';
import { loadCatalogGeneratedPreview } from './catalog-generated-preview.mjs';
import {
  CatalogPlayerV2Session,
  buildCatalogLevelImpression,
  validateCatalogTicketLevelSpecBundle,
  type CatalogFailureReason,
  type CatalogPlayerEffect,
  type CatalogTicketLevelSpecBundle,
} from './catalog-player-v2.mjs';
import {
  CATALOG_AUTHORITY_BOOTSTRAP_TIMEOUT_MS,
  CATALOG_AUTHORITY_PROJECTION_TIMEOUT_MS,
  CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS,
  buildCatalogCanaryRunIdentity,
  buildCatalogFeedAuthorityRequest,
  catalogCanaryAuthorityAllowsBackgroundAllocation,
  catalogCanaryAuthorityAllowsAllocation,
  catalogCanaryDogfoodEnabled,
  catalogCanaryInvitationMissing,
  catalogCanaryTicketStartIsSafe,
  catalogGeneratedPreviewUrl,
  catalogFallbackMatchesBinding,
  catalogAuthorityFallbackTimerPlan,
  catalogAuthorityStartEligible,
  catalogPendingSlotShouldFallbackForBinding,
  catalogSourceDecisionProjectionReady,
  catalogDogfoodAccountEligible,
  catalogFeedDogfoodEnabled,
  catalogFeedSurface,
  catalogFeedUsesBuiltinImpression,
  catalogRecallRecoveryEffect,
  generatedInsertionTarget,
  validateCatalogCanaryAuthorityResult,
  validateCatalogFeedAuthorityResult,
  type CatalogCanaryAuthorityResultV1,
  type CatalogFeedAuthorityRequestV1,
  type CatalogFeedAuthorityResultV1,
} from './catalog-feed-authority.mjs';
import {
  controlPlaneEventReceiptStatus,
  controlPlaneEventState,
  controlPlaneEnabled,
  flushControlPlane,
  initControlPlane,
  queueControlPlaneEvent,
} from './control-plane';
import { loadIslandState } from './island-state';
import { simulateActivity, islandSocialMode, ISLAND_SIM_EVENT, type SimBuildingRef } from './island-sim';
import { levelStarReward, seriesRewards } from './rewards.mjs';
import { seriesLength } from './series-policy.mjs';
import { track } from './telemetry';
import { getStartParam, shareChallenge, getInitData } from './telegram';
import {
  catalogLabAuthorizationAvailable,
  catalogLabAuthUrl,
} from './catalog-lab-navigation.mjs';

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

/** The feed entry's cover-art URL (per ENTRY id, so aliased entries can ship
 *  their own per-level cover). See coverUrl in playables.ts. */
function coverSrc(id: string): string {
  return coverUrl(id);
}

const LIVE_AHEAD = 0;              // explicit warm-next scheduling below owns ahead iframe lifetime
const LIVE_BEHIND = 0;             // back-swipe is disabled, so no idle previous iframe
// Byte-prefetch is deliberately independent from iframe mount. Pull shell +
// payload into HTTP cache early, but cap the rolling window by BOTH depth and
// bytes from versions.json. Unknown/old manifests use a conservative 1 MiB
// estimate. Fetches stay serialized and low priority. Escape: ?prefetch=off.
const MIB = 1024 * 1024;
function reserveAheadPolicy(): { depth: number; bytes: number } {
  const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (c?.saveData) return { depth: 1, bytes: 1 * MIB };
  if (c?.effectiveType === 'slow-2g' || c?.effectiveType === '2g') return { depth: 1, bytes: 1 * MIB };
  if (c?.effectiveType === '3g') return { depth: 2, bytes: 4 * MIB };
  return { depth: 4, bytes: 16 * MIB };                       // 4g / wifi / unknown (iOS)
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

function ticketUid(): string {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch { /* older webview */ }
  const bytes = new Uint8Array(16);
  try { crypto.getRandomValues(bytes); } catch {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ANALYTICS_POLL_MS = 1000;    // fallback for older non-SWIPE exports
const FRAME_READY_FALLBACK_MS = 900;
const STAGED_READY_FALLBACK_MS = 7000;
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
const REWARD_SHOT_MS = 540;          // chest star: pop up, then accelerate into the counter
const REWARD_PEEL_STAGGER_MS = 78;   // gap between successive peel-offs (halved from 155 — faster credit)
const RING_STEP_MS = 180;       // snappy ring growth per star impact (synced to the bump)

type PlayableOutcome = 'won' | 'lost';
type ControlPlaneExitState = 'preview' | 'playing' | 'won' | 'lost';
type ControlPlaneManualAction = {
  actionSeq: number;
  actionType: string;
  accepted: boolean;
  changedState: boolean;
};
type ControlPlaneLevel = {
  levelImpressionId: string;
  levelIndex: number;
  occurredAt: string;
  emitted: boolean;
};
type ControlPlaneExposure = {
  index: number;
  feedPosition: number;
  playableId: string;
  decisionId: string;
  impressionId: string;
  decisionAt: string;
  revealedAt: string | null;
  binding: BuiltinFeedBindingV1 | null;
  decisionEmitted: boolean;
  decisionEventId: string | null;
  impressionEmitted: boolean;
  closed: boolean;
  dwell: ActiveDwellAccumulator;
  levels: Map<number, ControlPlaneLevel>;
  exit: {
    reason: 'swipe' | 'background' | 'close';
    state: ControlPlaneExitState;
    dwellActiveMs: number;
    dwellCensored: boolean;
    occurredAt: string;
  } | null;
};
type GeneratedAuthoritySource = {
  decisionId: string;
  decisionEventId: string;
  binding: BuiltinFeedBindingV1;
};
type ControlPlaneAttempt = {
  runId: string;
  exposure: ControlPlaneExposure;
  levelIndex: number;
  ticket: RunTicketRequest;
  startedAt: string;
  readyAt: string | null;
  emitted: boolean;
  actions: Array<ControlPlaneManualAction & { occurredAt: string; emitted: boolean }>;
  result: {
    outcome: 'win' | 'lose';
    timeMs: number;
    occurredAt: string;
    emitted: boolean;
  } | null;
};
type CatalogFeedSlotPhase =
  | 'authority_pending'
  | 'delivery_pending'
  | 'catalog_ready'
  | 'catalog_mounted'
  | 'builtin_fallback'
  | 'disposed';
type CatalogFeedSlot = {
  index: number;
  exposure: ControlPlaneExposure;
  phase: CatalogFeedSlotPhase;
  request: CatalogFeedAuthorityRequestV1;
  authorityStarted: boolean;
  sourceDecisionAcknowledged: boolean;
  authorityClaimCommitted: boolean;
  authorityTimer: number | null;
  authorityTimerEpoch: number;
  authorityTimerStage: 'bootstrap' | 'projection' | 'delivery' | null;
  configurationTimer: number | null;
  ticketRequest: CatalogRunTicketRequestV2 | null;
  ticket: CatalogRunTicketViewV2 | CatalogRunTicketViewV3 | null;
  allocation: Extract<CatalogAllocationDecisionResult, { outcome: 'allocated' }> | null;
  bundle: CatalogTicketLevelSpecBundle | null;
  frameEpoch: number;
  session: CatalogPlayerV2Session | null;
  ordinal: number;
  failureEmitted: boolean;
  canaryProjectionRequired: boolean;
  insertionKind: 'source-bound' | 'generated';
};
type PreparedGeneratedOffer = {
  authority: CatalogCanaryAuthorityResultV1
    | Extract<CatalogFeedAuthorityResultV1, { outcome: 'catalog_authorized' }>;
  allocation: Extract<CatalogAllocationDecisionResult, { outcome: 'allocated' }>;
  ticketRequest: CatalogRunTicketRequestV2;
  ticket: CatalogRunTicketViewV2 | CatalogRunTicketViewV3;
  bundle: CatalogTicketLevelSpecBundle;
  previewUrls: Readonly<{ mobile: string; compact: string }>;
  canaryProjectionRequired: boolean;
};
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
  prepareInteractive?: () => Promise<void> | void;
};
type PlayableHostApi = {
  swipe?: SwipeApi;                  // uniform swipe-platform API (preferred)
  getAnalyticsHistory?: () => unknown[];
  getSwipeState?: () => Record<string, unknown>;
  hostGesture?: () => void;
  setEditorMode?: (enabled: boolean) => void;
  setHostPaused?: (paused: boolean) => void;
  prepareInteractive?: () => Promise<void> | void;
  setAutoPlayEnabled?: (enabled: boolean) => void;       // legacy fallback
  startAutoPlay?: (options?: { immediate?: boolean }) => void;  // legacy fallback
  stopAutoPlay?: () => void;
  toggleEditor?: () => void;
};

type MetaPlot = {
  id: string;
  name: string;
  template: string;
  mood: string;
  playableId: string;
  visitors: string;
  likes: string;
  earned: number;
  promo: string;
  tone: string;
  empty?: boolean;
};

type MetaTemplateId = 'merge' | 'sort' | 'pin';

type MetaTemplate = {
  id: MetaTemplateId;
  label: string;
  name: string;
  mood: string;
  playableId: string;
  visitors: string;
  likes: string;
  earned: number;
  promo: string;
  tone: string;
};

type MetaVariantSpec = {
  template: MetaTemplateId;
  theme: string;
  modifier: string;
  summary: string;
  series?: Record<string, number | string>;
  level?: number;
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
  // Lazy cover loading: only pages near the viewport fetch their JPEG (35–85 KB
  // each) — far pages get theirs when the window slides over them.
  private posterEls: HTMLImageElement[] = [];
  private coverLoaded = new Set<number>();
  // Drag renders are coalesced to one per animation frame — Android fires
  // pointermove faster than vsync, and render() walks every page.
  private dragRenderQueued = false;
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
  // ── Finger-aware warm prepare. The heavy warm phase (prepareInteractive:
  //    decode/GL init inside the warm frame) runs on the SAME main thread as
  //    the mechanic the user is playing — a 200-400ms block under an active
  //    finger is felt as a mid-gameplay рывок. Touches inside the mechanic
  //    never reach the host document, so a same-origin probe inside each
  //    frame tracks them; while a real finger is down, background warm
  //    preparation is parked in deferredWarmPrepare and flushed on release. ──
  private mechanicPointerDown = false;
  private mechanicPointerDownAt = 0;
  private deferredWarmPrepare = new Set<number>();
  private frameLoaded = new Set<number>();
  private frameStaticReady = new Set<number>();
  private frameUsesStagedReady = new Set<number>();
  private framePrepareRequested = new Set<number>();
  private frameReady = new Set<number>();
  // Only the exact staged-ready message opens control-plane dwell. Legacy
  // `ready`/`loaded` and timeout fallbacks may reveal a playable, but they are
  // not evidence that the mechanic accepted interaction.
  private frameInteractiveReady = new Set<number>();
  private frameInteractiveReadyAt = new Map<number, string>();
  private frameRevealed = new Set<number>();
  private framePaused = new Map<number, boolean>();
  private frameFallbackTimers = new Map<number, number>();
  private frameRevealTimers = new Map<number, number>();

  private totalStars = 0;
  // Puzzles fly up-right into the HUD counter. Collection progress is its own
  // persisted state; chest cards are deliberately only a visual drop for now.
  private totalPuzzles = 120;
  private collectionProgress = loadCollectionsProgressState();
  private puzzleBadgeEl: HTMLElement | null = null;
  private puzzleValueEl: HTMLElement | null = null;
  private puzzleBadgeSquash: Animation | null = null;
  private collectionsBtnEl: HTMLElement | null = null;
  private feedBarEl: HTMLElement | null = null;
  private dailyState: DailyStateResp | null = null;
  private dailyPanelEl: HTMLElement | null = null;
  // Daily is a central view (like meta/collections) but not part of the overlay
  // system; this flag lets shouldPauseFrame() freeze + mute the feed mechanic
  // while daily is up. Cleared synchronously in hideDailyPanel so the frame can
  // resume the instant we return to the feed (before the panel's fade-out ends).
  private dailyOpen = false;
  // Global "someone played your mechanic" activity sim (runs on every tab).
  private activityNotifierEl: HTMLElement | null = null;
  private activityNotifierTimer: number | null = null;
  private dailyTimerEl: HTMLElement | null = null;
  private dailyTickTimer: number | null = null;
  private dailySyncing = false;
  private dailyClaiming = new Set<string>();
  private dailyNavBtnEl: HTMLButtonElement | null = null;
  private dailyNavAlertEl: HTMLElement | null = null;
  // Telemetry (D3) state: which unit is on-screen, since when, and per-show guards.
  private shownIndex = -1;
  private shownAt = 0;
  private firstInputLogged = false;
  // Shadow control plane. All fields stay dormant unless the build flag is on
  // and /session supplies a reviewed playable->variant mapping. Unbound early
  // reveals are retained briefly so a cold /session does not erase the first
  // unit's honest dwell/exit.
  private builtinFeedBindings = new Map<string, BuiltinFeedBindingV1>();
  private cpExposure: ControlPlaneExposure | null = null;
  private cpPendingExposure: ControlPlaneExposure | null = null;
  private cpDeferredExposures: ControlPlaneExposure[] = [];
  private cpAttempts = new Map<string, ControlPlaneAttempt>();
  private cpFeedPosition = 0;
  // Default-off dogfood bridge. It never derives a catalog candidate locally:
  // every slot starts from a projected built-in opportunity and accepts only
  // the server's opaque authority → allocation → ticket → exact spec bundle.
  private readonly catalogDogfoodAccountEligible = catalogDogfoodAccountEligible(
    (import.meta as any).env,
    getInitData(),
  );
  private readonly catalogDogfoodEnabled = catalogFeedDogfoodEnabled(
    (import.meta as any).env,
    controlPlaneEnabled(),
  );
  private readonly catalogCanaryDogfoodEnabled = catalogCanaryDogfoodEnabled(
    (import.meta as any).env,
    this.catalogDogfoodEnabled,
    this.catalogDogfoodAccountEligible,
  );
  // One invitation can be offered to many nearby feed opportunities while
  // warm-up decisions overlap. The first eligible source owns it for this page
  // lifetime; every other slot continues through ordinary effectful policy.
  private catalogCanaryClaimed = false;
  private catalogSlots = new Map<number, CatalogFeedSlot>();
  private generatedOfferState: 'idle' | 'loading' | 'ready' | 'reserved' | 'empty' | 'failed' = 'idle';
  private generatedOffer: PreparedGeneratedOffer | null = null;
  private generatedTargetIndex: number | null = null;
  private generatedPrefetchScheduled = false;
  private generatedAuthoritySourceIds = new Set<string>();
  private catalogFrameEpoch = 0;
  private preloaderMountedAt = 0;
  // Preloader waits for BOTH the first mechanic AND the first server seed (capped).
  private mechanicsReady = false;
  private awaitingServerSeed = true;
  // Bottom-bar version label: platform (build) + backend (git SHA, after auth).
  private versionEl: HTMLElement | null = null;
  private catalogLabNavEl: HTMLButtonElement | null = null;
  private backendVersion: string | null = null;
  private sessionSyncPromise: Promise<boolean> | null = null;
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
  // Challenge (W2). Solve time = takeover → win, per unit. activeChallenge is set
  // when arriving via a deep-link; its completion is armed on the first manual win
  // of the challenged mechanic. challengePillEl is the "send a challenge" CTA.
  private manualStartMs = new Map<number, number>();
  private runTickets = new Map<string, RunTicketRequest>();
  private activeChallenge: ChallengeView | null = null;
  private publicIsland: PublicIslandView | null = null;
  private inboxChallenges: ChallengeInboxItem[] = [];   // top-rail: friends' challenges to play
  private challengeCompleted = false;
  private challengeOverlayOpen = false;
  // Series (W2): taking over a mechanic starts a multi-level run. Most mechanics run
  // 5 levels of the SAME level with varied params; pins runs its 2 real authored
  // levels (level 1 → level 2). Length is per-mechanic (seriesLenFor). Levels are
  // manual, no autoplay between them; only the × exits. Stars are paid ONLY on
  // completing the whole series, via the chest ceremony. A LOSS on a level just
  // retries THAT level (cleared levels are kept), see handleSeriesFail.
  private series: {
    index: number;
    done: number;
    reward: number;
    puzzles: number;
    payoutRunId: string;
    ticket: RunTicketRequest;
    lastRunId: string | null;
    playing: boolean;
    catalog: CatalogFeedSlot | null;
    catalogChestQueued: boolean;
  } | null = null;
  private seriesRowEl: HTMLElement | null = null;
  private chestEl: HTMLElement | null = null;
  private seriesTransitionEl: HTMLElement | null = null;
  private chestSparkTimer: number | null = null;
  private seriesWinShown = new Set<number>();   // series-end win screen is up on this unit
  private seriesLevelUpPending: number | null = null;   // level to celebrate on the first swipe off the series win screen (null = no level-up)
  private lastSolveMs = 0;                        // most recent manual solve time (result readout + challenge)
  private pendingSeriesParams = new Map<number, string>();   // encoded ?series= for the next mount of index i
  private pendingLevels = new Map<number, number>();          // ?level= for the next mount of index i (pins series)
  private seriesRowDragHidden = false;                        // series row faded out for the current page swipe
  private challengeIntroShown = false;
  private challengePillEl: HTMLElement | null = null;
  private pendingEditorLaunch = new Set<number>();
  private rewardSparkTimers = new Map<number, number>();
  private autoplayUiActive = new Set<number>();
  private platformAudioPrimed = false;
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
  private metaTokens = 1240;
  private metaClaimReady = 0;
  private metaSelectedPlotId = 'plot-a';
  private metaBuilderPlotId: string | null = null;
  private metaBuilderTemplate: MetaTemplateId = 'merge';
  private metaBuilderTheme = 'Neon rain';
  private metaBuilderModifier = 'Chain rewards';
  private metaRemixed = new Set<string>();
  private metaBuiltPlots = new Map<string, MetaTemplateId>();
  private metaVariants = new Map<string, MetaVariantSpec>();
  private metaPlotLevels = new Map<string, number>([
    ['plot-a', 0],
    ['plot-b', 0],
    ['plot-c', 0],
    ['plot-d', 0],
  ]);

  private prefetched = new Set<number>();
  private ready = new Set<number>();
  private prefetchQueue: number[] = [];
  private prefetchQueued = new Set<number>();
  private prefetching = false;
  private preloaderDone = false;
  private preloaderFinishing = false;
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
  // Default `adaptive`: idle-mount only light mechanics; heavy mechanics wait
  // for directional swipe intent. `?warm=idle`/`?warm=1` forces the legacy idle
  // mount for A/B, while `?warm=off` keeps every target cold until arrival.
  private warmMode = new URLSearchParams(location.search).get('warm') || 'adaptive';
  private warmNextEnabled = this.warmMode !== 'off';
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

  constructor(
    viewport: HTMLElement,
    feedEl: HTMLElement,
    playables: Playable[],
    challenge: ChallengeView | null = null,
    publicIsland: PublicIslandView | null = null,
  ) {
    this.viewport = viewport;
    this.feedEl = feedEl;
    this.playables = playables;
    this.N = playables.length;
    this.activeChallenge = challenge;
    this.publicIsland = publicIsland;
    this.initialTarget = Math.min(INITIAL_BATCH, this.N);
    this.build();
    const initialPlayableId = this.playables[this.realIndex()]?.id;
    if (initialPlayableId) this.beginControlPlaneDecision(this.realIndex(), initialPlayableId);
    this.pickCoverBucket();   // decide tall/compact cover aspect BEFORE any cover loads
    if (this.HOLD_COVER) document.documentElement.classList.add('holdcover');
    this.buildIncoming();
    this.mountHud();
    this.mountFeedBar();
    this.measure();
    this.render(false);
    this.updateIncomingPoster();
    this.updateMechanicStates();
    this.updateHud(false);
    this.mountPreloader();
    // Fake island social data (plays/likes/notifier/pucks) runs whenever the owner
    // has the 'fake' toggle on (default until real players exist); 'real' turns it off
    // so genuine backend likes/shares can be tested. Toggle lives in the debug panel.
    if (islandSocialMode() === 'fake') this.startIslandActivity();
    if (this.publicIsland) window.setTimeout(() => this.openIslandWorld(), 0);

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
      if (this.settlingTargetIndex === null) return;
      this.settleSlide();
    });

    this.updateLive();
    this.prefetchReserve();
    this.applyActiveStates();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('message', this.onWindowMessage);
    window.addEventListener('pointerdown', this.onPlatformPointerDown, { capture: true, passive: true });
    document.addEventListener('visibilitychange', this.onHostVisibilityChange);
    window.addEventListener('pagehide', this.pauseAllFrames);
    window.addEventListener('pagehide', this.onControlPlanePageHide);
    window.addEventListener('pageshow', this.onControlPlanePageShow);
    (window as any).__feedHostGesture = this.onHostGesture;
    window.setInterval(this.pollPlayableAnalytics, ANALYTICS_POLL_MS);
    window.setInterval(this.pollAutoplayUi, 250);
    onResultTerminal(this.onCatalogResultTerminal);
    this.initPerfTelemetry();
    // Debug hook: window.__feedWarm() → live snapshot of the next-mechanic warm
    // state (is it pre-warmed? if not, why — blocked, or calm window starved?).
    // Also open the feed with ?warm=1 to stream the warm lifecycle to the console.
    (window as unknown as { __feedWarm?: () => unknown }).__feedWarm = () => this.warmSnapshot();
    // Debug-panel hook: after seeding a test challenge, refresh the rail in place.
    (window as unknown as { __feedRefreshRail?: () => void }).__feedRefreshRail = () => { void this.refreshChallengeRail(); };
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
      if (await this.syncSessionBootstrap()) return;
    }
    // Backend never answered in the window — onForeground() will retry.
  }

  private async applySessionBootstrap(session: SessionResp): Promise<void> {
    // Initialize the authenticated durable queue only after /session has
    // created/refreshed the user row. This avoids a first-run FK race while
    // still flushing any events persisted by an earlier app launch.
    initControlPlane();
    this.applyBuiltinFeedBindings(session.builtin_feed_bindings);
    this.applyCatalogLabAuthorizationCapability(session.catalog_lab_authorization_available);
    this.applyServerBalance(session.balance);
    if (typeof session.puzzles === 'number') this.applyServerPuzzles(session.puzzles);
    await this.syncDaily(false);
    if (session.backend_version) {
      this.backendVersion = session.backend_version;
      this.renderVersionLabel();
    }
    this.applyConfirmedBalances(await flushResults());
    await this.syncDaily(false);
    void this.refreshChallengeRail();
    this.scheduleGeneratedOfferPrefetch();
  }

  /**
   * Generated discovery is deliberately detached from page navigation. The
   * browser may spend idle time on this work, but no feed slot waits for it.
   */
  private scheduleGeneratedOfferPrefetch(): void {
    if (!this.catalogDogfoodEnabled || this.generatedPrefetchScheduled
      || ['loading', 'ready', 'reserved'].includes(this.generatedOfferState)) return;
    this.generatedPrefetchScheduled = true;
    const run = () => {
      this.generatedPrefetchScheduled = false;
      void this.prefetchGeneratedOffer();
    };
    const idle = (window as typeof window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === 'function') idle(run, { timeout: 2_000 });
    else window.setTimeout(run, 0);
  }

  private generatedPreviewBaseUrl(): string {
    let base = new URLSearchParams(location.search).get('base') || './';
    if (!base.endsWith('/')) base += '/';
    return new URL(base, location.href).toString();
  }

  private generatedPreviewUrl(offer: PreparedGeneratedOffer): string {
    return this.coverBucket === '.c' ? offer.previewUrls.compact : offer.previewUrls.mobile;
  }

  private async loadGeneratedPreview(
    allocation: Extract<CatalogAllocationDecisionResult, { outcome: 'allocated' }>,
  ): Promise<Readonly<{ mobile: string; compact: string }>> {
    // Keep the public URL construction executable in the feed contract tests;
    // the loader then verifies the sidecar and both exact JPEG digests.
    catalogGeneratedPreviewUrl({
      baseUrl: this.generatedPreviewBaseUrl(),
      contentHash: allocation.manifest.contentHash,
      runtimeArtifactDigest: allocation.runtime.runtimeArtifactDigest,
    });
    const preview = await loadCatalogGeneratedPreview({
      baseUrl: this.generatedPreviewBaseUrl(),
      contentHash: allocation.manifest.contentHash,
      runtimeArtifactDigest: allocation.runtime.runtimeArtifactDigest,
    });
    const objectUrl = (bytes: Uint8Array) => URL.createObjectURL(new Blob(
      [bytes.slice().buffer],
      { type: 'image/jpeg' },
    ));
    return Object.freeze({
      mobile: objectUrl(preview.mobile.bytes),
      compact: objectUrl(preview.compact.bytes),
    });
  }

  private releaseGeneratedPreview(offer: PreparedGeneratedOffer | null): void {
    if (!offer) return;
    URL.revokeObjectURL(offer.previewUrls.mobile);
    URL.revokeObjectURL(offer.previewUrls.compact);
  }

  private retireGeneratedSlot(i: number): void {
    const slot = this.catalogSlots.get(i);
    if (slot?.insertionKind !== 'generated') return;
    this.disposeCatalogSlot(i);
    this.games[i]?.classList.remove('game--generated');
    this.releaseGeneratedPreview(this.generatedOffer);
    this.generatedOffer = null;
    this.generatedOfferState = 'idle';
    this.generatedTargetIndex = null;
    this.catalogCanaryClaimed = false;
    this.coverLoaded.delete(i);
    this.ensureCover(i);
    this.incomingIndex = -1;
    this.updateIncomingPoster();
    this.scheduleGeneratedOfferPrefetch();
  }

  private generatedAuthoritySource(): GeneratedAuthoritySource | null {
    const candidates = [
      this.cpExposure,
      this.cpPendingExposure,
      ...this.cpDeferredExposures,
    ].filter((item): item is ControlPlaneExposure => Boolean(item));
    const unique = new Map(candidates.map((item) => [item.decisionId, item]));
    const exposure = [...unique.values()]
      .filter((item) => item.binding && item.decisionEmitted && item.decisionEventId
        && !this.generatedAuthoritySourceIds.has(item.decisionId))
      .sort((left, right) => right.feedPosition - left.feedPosition)[0] ?? null;
    if (!exposure?.binding || !exposure.decisionEventId) return null;
    return {
      decisionId: exposure.decisionId,
      decisionEventId: exposure.decisionEventId,
      binding: exposure.binding,
    };
  }

  /**
   * Additive generated insertion is a policy opportunity, not a replacement
   * for the currently visible built-in.  The reviewed registry can initially
   * contain fewer mechanics than the local ring (today it contains Sort only),
   * so waiting for a mapped page would reduce a five-slot policy to one probe
   * per full loop.  Issue a fresh, durable, impression-less opportunity from
   * any reviewed binding instead.  The server still owns exact identity and a
   * fallback remains a no-op: the visible built-in continues untouched.
   */
  private generatedAuthorityProbe(): GeneratedAuthoritySource | null {
    const binding = this.builtinFeedBindings.get('marble-sort-swipe')
      ?? [...this.builtinFeedBindings.values()][0]
      ?? null;
    if (!binding) return null;
    const decisionId = ticketUid();
    const decisionEventId = queueControlPlaneEvent('builtin_feed_decision', {
      decision_id: decisionId,
      mapping_id: binding.mapping_id,
      feed_position: this.cpFeedPosition++,
    }, new Date().toISOString());
    if (!decisionEventId) return null;
    return { decisionId, decisionEventId, binding };
  }

  private async prefetchGeneratedOffer(): Promise<void> {
    if (!this.catalogDogfoodEnabled
      || ['loading', 'ready', 'reserved'].includes(this.generatedOfferState)) return;
    this.generatedOfferState = 'loading';
    try {
      let authority: PreparedGeneratedOffer['authority'] | null = null;
      let canaryProjectionRequired = false;

      if (this.catalogCanaryDogfoodEnabled && !this.catalogCanaryClaimed) {
        try {
          const canary = validateCatalogCanaryAuthorityResult(
            await apiGetCatalogCanaryAuthorityRequired(),
          );
          if (!catalogCanaryAuthorityAllowsAllocation(canary)) {
            throw new Error('generated canary authority expired before background allocation');
          }
          if (catalogCanaryAuthorityAllowsBackgroundAllocation(canary)) {
            authority = canary;
            canaryProjectionRequired = true;
            this.catalogCanaryClaimed = true;
          }
        } catch (error) {
          if (!(error instanceof ApiRequestError
            && catalogCanaryInvitationMissing(error.status, error.code))) throw error;
        }
      }

      if (!authority) {
        const source = this.generatedAuthoritySource() ?? this.generatedAuthorityProbe();
        if (!source) {
          this.generatedOfferState = 'idle';
          return;
        }
        this.generatedAuthoritySourceIds.add(source.decisionId);
        const flushed = await flushControlPlane({ force: true });
        if (!catalogSourceDecisionProjectionReady(
          Boolean(flushed),
          controlPlaneEventState(source.decisionEventId),
          controlPlaneEventReceiptStatus(source.decisionEventId),
        )) {
          throw new Error('background generated source decision was not durably projected');
        }
        const request = buildCatalogFeedAuthorityRequest(ticketUid(), source.decisionId);
        const result = validateCatalogFeedAuthorityResult(
          await apiGetCatalogFeedAuthorityRequired(request),
          request,
        );
        if (result.outcome === 'builtin_fallback') {
          if (!catalogFallbackMatchesBinding(result.fallback, source.binding)) {
            throw new Error('background generated fallback differs from its source opportunity');
          }
          this.generatedOfferState = 'empty';
          return;
        }
        if (Date.parse(result.expiresAt) <= Date.now()) {
          throw new Error('background generated authority expired before allocation');
        }
        authority = result;
      }

      const authorized = await apiAllocateAuthorizedCatalogRequired({
        schema: 'catalog.allocate-authorized.v2',
        authorizationId: authority.authorizationId,
      });
      if (authorized.schema !== 'catalog.allocate-authorized-result.v2'
        || authorized.authorizationId !== authority.authorizationId
        || authorized.authorizationDigest !== authority.authorizationDigest
        || authorized.allocation.allocationId !== authority.authorizationId
        || authorized.allocation.outcome !== 'allocated'
        || authorized.allocation.runtime.capabilities.catalogRequiredHandshake !== true) {
        throw new Error('background generated allocation differs from its exact authority');
      }
      if (canaryProjectionRequired && (
        authorized.allocation.catalog.entryState !== 'canary'
        || authorized.allocation.slotType !== 'canary-dogfood'
        || authorized.allocation.policyVersion !== 'catalog-canary-dogfood.v1'
      )) throw new Error('background canary allocation escaped its bounded invitation');
      if (!canaryProjectionRequired
        && authorized.allocation.catalog.entryState !== 'published') {
        throw new Error('background public authority selected non-published content');
      }
      const runIdentity = canaryProjectionRequired
        ? buildCatalogCanaryRunIdentity(authority.authorizationId)
        : null;
      const ticketRequest: CatalogRunTicketRequestV2 = {
        schema: 'run.start.v2',
        ticket_id: runIdentity?.ticketId ?? ticketUid(),
        run_id: runIdentity?.runId ?? `series-${runUid()}`,
        mechanic_id: authorized.allocation.runtime.playableId,
        variant_id: authorized.allocation.runtime.legacyVariantId,
        kind: 'series',
        decision_id: authorized.allocation.decisionId,
      };
      const start = await queueRunTicketStart(ticketRequest);
      const ticket = start.latest;
      if (start.status !== 'ok' || start.pending !== 0 || !ticket
        || !('schema' in ticket) || !['run.ticket.v2', 'run.ticket.v3'].includes(ticket.schema)
        || ticket.ticket_id !== ticketRequest.ticket_id
        || ticket.run_id !== ticketRequest.run_id
        || ticket.decision_id !== ticketRequest.decision_id
        || !catalogCanaryTicketStartIsSafe(ticket)) {
        throw new Error(`background generated ticket did not confirm (${start.status})`);
      }
      const bundle = validateCatalogTicketLevelSpecBundle(
        await apiGetCatalogTicketSpecsRequired(ticket.ticket_id),
      );
      this.assertCatalogDeliveryClosure(authorized.allocation, ticket, bundle);
      const previewUrls = await this.loadGeneratedPreview(authorized.allocation);
      const offer: PreparedGeneratedOffer = {
        authority,
        allocation: authorized.allocation,
        ticketRequest,
        ticket,
        bundle,
        previewUrls,
        canaryProjectionRequired,
      };
      this.generatedOffer = offer;
      this.generatedOfferState = 'ready';
      this.planGeneratedInsertion();
      track('generated_offer_prepared', {
        mechanic_id: offer.bundle.runtime.playableId,
        catalog_entry_id: offer.allocation.catalog.entryId,
      });
    } catch (error) {
      this.releaseGeneratedPreview(this.generatedOffer);
      this.generatedOffer = null;
      this.generatedOfferState = 'failed';
      this.catalogCanaryClaimed = false;
      console.warn('[generated-feed] background offer unavailable; builtin loop continues', error);
      track('generated_offer_unavailable', {
        reason: error instanceof ApiRequestError ? error.code ?? `http_${error.status}` : 'preparation_failure',
      });
    }
  }

  private planGeneratedInsertion(): void {
    if (this.generatedOfferState !== 'ready' || !this.generatedOffer
      || this.generatedTargetIndex !== null) return;
    const blocked = [...this.catalogSlots.keys()];
    if (this.activeChallenge) {
      for (let index = 0; index < this.N; index += 1) {
        if (this.playables[index]?.id === this.activeChallenge.mechanic_id) blocked.push(index);
      }
    }
    const target = generatedInsertionTarget(this.realIndex(), this.N, blocked, 2);
    if (target === null) return;
    this.generatedTargetIndex = target;
    this.games[target]?.classList.add('game--generated');
    this.coverLoaded.delete(target);
    this.ensureCover(target);
    this.incomingIndex = -1;
    this.updateIncomingPoster();
  }

  private syncSessionBootstrap(): Promise<boolean> {
    if (this.sessionSyncPromise) return this.sessionSyncPromise;
    const current = (async () => {
      const session = await apiSession();
      if (!session) return false;
      await this.applySessionBootstrap(session);
      return true;
    })();
    this.sessionSyncPromise = current;
    const clear = () => {
      if (this.sessionSyncPromise === current) this.sessionSyncPromise = null;
    };
    void current.then(clear, clear);
    return current;
  }

  // ── Durable shadow control plane ─────────────────────────────────────────
  // The static feed still chooses the playable locally. Identity does not:
  // /session supplies an immutable reviewed mapping and the wire carries only
  // its opaque id. Without that mapping this entire path fails closed while the
  // legacy feed/results path continues unchanged.
  private applyBuiltinFeedBindings(bindings?: BuiltinFeedBindingsV1): void {
    if (!controlPlaneEnabled()) return;
    if (!bindings || bindings.schema !== 'feed.builtin-bindings.v1' || !bindings.available) {
      // A later fail-closed bootstrap must not leave a previously installed
      // mapping available for new tickets/decisions in this page.
      this.builtinFeedBindings.clear();
      for (const exposure of this.cpDeferredExposures) {
        if (!exposure.decisionEmitted) exposure.binding = null;
      }
      this.failCatalogClaimsWithoutBinding(null);
      return;
    }

    const next = new Map<string, BuiltinFeedBindingV1>();
    for (const [playableId, binding] of Object.entries(bindings.by_playable_id ?? {})) {
      if (!playableId || binding.playable_id !== playableId) continue;
      if (!binding.mapping_id || !binding.variant_id || !binding.mapping_digest) continue;
      next.set(playableId, binding);
    }
    this.builtinFeedBindings = next;

    const stillDeferred: ControlPlaneExposure[] = [];
    for (const exposure of this.cpDeferredExposures) {
      const binding = next.get(exposure.playableId);
      if (!binding) {
        stillDeferred.push(exposure);
        continue;
      }
      // Once the decision is durable its mapping is immutable. A refreshed
      // session may contain a replacement mapping for future decisions only.
      if (!exposure.decisionEmitted) exposure.binding = binding;
      this.emitControlPlaneExposure(exposure);
      if (this.controlPlaneExposureNeedsRetry(exposure)) stillDeferred.push(exposure);
    }
    // A cold backend or temporarily unavailable localStorage can leave early
    // observations waiting. Keep only snapshots that are not durable yet.
    this.cpDeferredExposures = stillDeferred.slice(-64);
    this.failCatalogClaimsWithoutBinding(next);
    for (const attempt of this.cpAttempts.values()) this.flushControlPlaneAttempt(attempt);
  }

  private failCatalogClaimsWithoutBinding(
    bindings: ReadonlyMap<string, BuiltinFeedBindingV1> | null,
  ): void {
    for (const slot of [...this.catalogSlots.values()]) {
      if (!catalogPendingSlotShouldFallbackForBinding(
        slot.phase,
        true,
        bindings?.has(slot.exposure.playableId) === true,
      )) continue;
      // The 65s bootstrap exists only while /session is unresolved. Once the
      // authoritative document says this playable is absent (or bindings are
      // unavailable), keeping the poster would add latency without any chance
      // of catalog authority becoming valid.
      this.activateCatalogBuiltinFallback(slot, 'catalog_binding_unavailable');
    }
  }

  private controlPlaneExposureNeedsRetry(exposure: ControlPlaneExposure): boolean {
    const generated = this.catalogSlotForExposure(exposure)?.insertionKind === 'generated';
    return (!exposure.binding && !generated)
      || !exposure.decisionEmitted
      || Boolean(exposure.revealedAt && !exposure.impressionEmitted)
      || Boolean(exposure.exit);
  }

  private deferControlPlaneExposure(exposure: ControlPlaneExposure): void {
    if (!this.controlPlaneExposureNeedsRetry(exposure)) return;
    if (!this.cpDeferredExposures.includes(exposure)) this.cpDeferredExposures.push(exposure);
    if (this.cpDeferredExposures.length > 64) this.cpDeferredExposures.shift();
  }

  private retryDeferredControlPlaneExposures(): void {
    const pending: ControlPlaneExposure[] = [];
    for (const exposure of this.cpDeferredExposures) {
      if (!exposure.binding) exposure.binding = this.builtinFeedBindings.get(exposure.playableId) ?? null;
      this.emitControlPlaneExposure(exposure);
      if (this.controlPlaneExposureNeedsRetry(exposure)) pending.push(exposure);
    }
    this.cpDeferredExposures = pending.slice(-64);
  }

  private variantIdForPlayable(playableId: string): string {
    return this.builtinFeedBindings.get(playableId)?.variant_id ?? variantIdForMechanic(playableId);
  }

  private effectivePlayableId(i: number): string | undefined {
    const slot = this.catalogSlotForIndex(i);
    return slot && slot.phase !== 'builtin_fallback' && slot.bundle
      ? slot.bundle.runtime.playableId
      : this.playables[i]?.id;
  }

  private effectiveVariantId(i: number): string | null {
    const slot = this.catalogSlotForIndex(i);
    if (slot && slot.phase !== 'builtin_fallback' && slot.bundle) {
      return slot.bundle.runtime.legacyVariantId;
    }
    const playableId = this.playables[i]?.id;
    return playableId ? this.variantIdForPlayable(playableId) : null;
  }

  private beginControlPlaneDecision(i: number, playableId: string): ControlPlaneExposure | null {
    if (!controlPlaneEnabled()) return null;
    // A deep-link challenge is a forced social slot, not a choice by the
    // built-in feed policy. Until that slot has its own server-bound contract,
    // exclude it rather than falsely attributing its view/attempt to builtin.
    if (
      this.activeChallenge
      && this.activeChallenge.mechanic_id === playableId
    ) return null;
    if (
      this.cpPendingExposure
      && !this.cpPendingExposure.closed
      && this.cpPendingExposure.index === i
      && this.cpPendingExposure.playableId === playableId
    ) return this.cpPendingExposure;
    const now = performance.now();
    const dwell = new ActiveDwellAccumulator(now);
    const exposure: ControlPlaneExposure = {
      index: i,
      feedPosition: this.cpFeedPosition++,
      playableId,
      decisionId: ticketUid(),
      impressionId: ticketUid(),
      decisionAt: new Date().toISOString(),
      revealedAt: null,
      binding: this.builtinFeedBindings.get(playableId) ?? null,
      decisionEmitted: false,
      decisionEventId: null,
      impressionEmitted: false,
      closed: false,
      dwell,
      levels: new Map(),
      exit: null,
    };
    dwell.reset(now);
    this.attachPreparedGeneratedOffer(i, exposure);
    this.cpPendingExposure = exposure;
    if (exposure.binding) this.emitControlPlaneExposure(exposure);
    this.deferControlPlaneExposure(exposure);
    return exposure;
  }

  private attachPreparedGeneratedOffer(i: number, exposure: ControlPlaneExposure): void {
    if (this.generatedTargetIndex !== i || this.generatedOfferState !== 'ready'
      || !this.generatedOffer) return;
    const prepared = this.generatedOffer;
    this.disposeCatalogSlot(i);
    const existingFrame = this.frames.get(i);
    if (existingFrame) {
      // The page may have a warm built-in iframe. It is replaced only now, when
      // the complete generated closure is already in memory; no navigation ever
      // waits for discovery/allocation/spec delivery.
      this.clearAutoplayLoopTimer(i);
      this.disposeFrame(i, existingFrame);
      this.frames.delete(i);
      this.resetFrameReadiness(i);
    }
    const slot: CatalogFeedSlot = {
      index: i,
      exposure,
      phase: 'catalog_ready',
      request: buildCatalogFeedAuthorityRequest(ticketUid(), exposure.decisionId),
      authorityStarted: true,
      sourceDecisionAcknowledged: false,
      authorityClaimCommitted: true,
      authorityTimer: null,
      authorityTimerEpoch: 0,
      authorityTimerStage: null,
      configurationTimer: null,
      ticketRequest: prepared.ticketRequest,
      ticket: prepared.ticket,
      allocation: prepared.allocation,
      bundle: prepared.bundle,
      frameEpoch: 0,
      session: null,
      ordinal: 1,
      failureEmitted: false,
      canaryProjectionRequired: prepared.canaryProjectionRequired,
      insertionKind: 'generated',
    };
    this.catalogSlots.set(i, slot);
    // The catalog allocation already owns its durable decision. There is no
    // synthetic builtin_feed_decision for an additive generated insertion.
    exposure.decisionEmitted = true;
    this.generatedTargetIndex = null;
    this.generatedOfferState = 'reserved';
    this.catalogCanaryClaimed = prepared.canaryProjectionRequired;
    this.games[i]?.classList.add('game--generated', 'game--loading');
    this.games[i]?.classList.remove('game--ready');
  }

  private revealControlPlaneExposure(i: number, playableId: string): void {
    if (!controlPlaneEnabled()) return;
    const pending = this.cpPendingExposure;
    const exposure = pending?.index === i && pending.playableId === playableId
      ? pending
      : this.beginControlPlaneDecision(i, playableId);
    if (!exposure) return;
    if (this.cpPendingExposure === exposure) this.cpPendingExposure = null;
    exposure.revealedAt ??= new Date().toISOString();
    this.cpExposure = exposure;
    exposure.dwell.reset(performance.now(), this.controlPlaneDwellGates(exposure));
    this.emitControlPlaneExposure(exposure);
    this.deferControlPlaneExposure(exposure);
  }

  private emitControlPlaneExposure(exposure: ControlPlaneExposure): void {
    const preparedSlot = this.catalogSlotForExposure(exposure);
    if (preparedSlot?.insertionKind === 'generated'
      && !catalogFeedUsesBuiltinImpression(preparedSlot.phase)) {
      if (exposure.revealedAt) this.revealCatalogLevel(preparedSlot);
      if (exposure.impressionEmitted) {
        if (exposure.exit) this.emitControlPlaneExit(exposure);
        for (const attempt of this.cpAttempts.values()) {
          if (attempt.exposure === exposure) this.flushControlPlaneAttempt(attempt);
        }
      }
      return;
    }
    if (!exposure.binding) return;
    if (!exposure.decisionEmitted) {
      const decisionEvent = queueControlPlaneEvent('builtin_feed_decision', {
        decision_id: exposure.decisionId,
        mapping_id: exposure.binding.mapping_id,
        feed_position: exposure.feedPosition,
      }, exposure.decisionAt);
      if (!decisionEvent) return;
      exposure.decisionEmitted = true;
      exposure.decisionEventId = decisionEvent;
      this.scheduleGeneratedOfferPrefetch();
      const slot = this.catalogSlotForExposure(exposure);
      if (slot) this.beginCatalogAuthority(slot);
    }
    const catalogSlot = this.catalogSlotForExposure(exposure);
    if (catalogSlot && !catalogFeedUsesBuiltinImpression(catalogSlot.phase)) {
      if (exposure.revealedAt) this.revealCatalogLevel(catalogSlot);
      if (exposure.impressionEmitted) {
        if (exposure.exit) this.emitControlPlaneExit(exposure);
        for (const attempt of this.cpAttempts.values()) {
          if (attempt.exposure === exposure) this.flushControlPlaneAttempt(attempt);
        }
      }
      return;
    }
    if (exposure.revealedAt && !exposure.impressionEmitted) {
      const impressionEvent = queueControlPlaneEvent('unit_impression', {
        decision_id: exposure.decisionId,
        impression_id: exposure.impressionId,
        mechanic_id: exposure.playableId,
        slot_type: 'builtin',
      }, exposure.revealedAt);
      if (!impressionEvent) return;
      exposure.impressionEmitted = true;
    }
    if (exposure.impressionEmitted) {
      if (exposure.exit) this.emitControlPlaneExit(exposure);
      for (const attempt of this.cpAttempts.values()) {
        if (attempt.exposure === exposure) this.flushControlPlaneAttempt(attempt);
      }
    }
  }

  private catalogSlotForExposure(exposure: ControlPlaneExposure): CatalogFeedSlot | null {
    const slot = this.catalogSlots.get(exposure.index);
    return slot?.exposure === exposure && slot.phase !== 'disposed' ? slot : null;
  }

  private catalogSlotForIndex(i: number): CatalogFeedSlot | null {
    const slot = this.catalogSlots.get(i);
    return slot && slot.phase !== 'disposed' ? slot : null;
  }

  private catalogSlotIsCurrent(slot: CatalogFeedSlot): boolean {
    return this.catalogSlots.get(slot.index) === slot && slot.phase !== 'disposed';
  }

  private beginCatalogAuthority(slot: CatalogFeedSlot): void {
    if (!this.catalogSlotIsCurrent(slot) || !catalogAuthorityStartEligible(
      slot.phase,
      slot.authorityStarted,
      slot.exposure.decisionEmitted,
    )) return;
    slot.authorityStarted = true;
    this.armCatalogAuthorityFallback(slot);
    void this.resolveCatalogAuthority(slot);
  }

  private armCatalogAuthorityFallback(slot: CatalogFeedSlot): void {
    if (!this.catalogSlotIsCurrent(slot)) return;
    const stage = catalogAuthorityFallbackTimerPlan(
      slot.phase,
      slot.authorityStarted,
      slot.sourceDecisionAcknowledged,
      slot.authorityClaimCommitted,
      slot.authorityTimerStage,
    );
    if (!stage) return;
    if (slot.authorityTimer !== null) window.clearTimeout(slot.authorityTimer);
    const epoch = ++slot.authorityTimerEpoch;
    slot.authorityTimerStage = stage;
    const delay = stage === 'bootstrap'
      ? CATALOG_AUTHORITY_BOOTSTRAP_TIMEOUT_MS
      : stage === 'projection'
        ? CATALOG_AUTHORITY_PROJECTION_TIMEOUT_MS
        : CATALOG_AUTHORITY_DELIVERY_TIMEOUT_MS;
    // Bootstrap protects an initial/navigation claim whose session/binding
    // never arrives. Projection tolerates a cold durable CP backend. Only its
    // ACK starts the shorter canary→allocation→ticket→spec delivery budget.
    slot.authorityTimer = window.setTimeout(
      () => {
        if (!this.catalogSlotIsCurrent(slot)
          || slot.authorityTimerEpoch !== epoch
          || slot.authorityTimerStage !== stage) return;
        this.activateCatalogBuiltinFallback(slot, `${stage}_timeout`);
      },
      delay,
    );
  }

  private async resolveCatalogAuthority(slot: CatalogFeedSlot): Promise<void> {
    try {
      // The effectful endpoint accepts only an already projected opportunity.
      // Enqueue success is insufficient: wait for the durable inbox ACK first.
      const flushed = await flushControlPlane({ force: true });
      if (!this.catalogSlotIsCurrent(slot) || slot.phase !== 'authority_pending') return;
      if (!catalogSourceDecisionProjectionReady(
        Boolean(flushed),
        controlPlaneEventState(slot.exposure.decisionEventId),
        controlPlaneEventReceiptStatus(slot.exposure.decisionEventId),
      )) {
        throw new Error('source decision was not durably projected');
      }
      slot.sourceDecisionAcknowledged = true;
      this.armCatalogAuthorityFallback(slot);

      type OpaqueAuthority = CatalogCanaryAuthorityResultV1
        | Extract<CatalogFeedAuthorityResultV1, { outcome: 'catalog_authorized' }>;
      let authority: OpaqueAuthority | null = null;
      const retryDelays = [0, 120, 360];

      // A canary invitation is account-bound and intentionally contains no
      // entry/spec/runtime identity. Only its opaque authorization enters the
      // existing Player-v2 delivery closure. A precise no-invitation 404 is the
      // sole edge that falls through to ordinary effectful feed policy.
      if (this.catalogCanaryDogfoodEnabled && !this.catalogCanaryClaimed) {
        this.catalogCanaryClaimed = true;
        try {
          for (const [attempt, delay] of retryDelays.entries()) {
            if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
            if (!this.catalogSlotIsCurrent(slot) || slot.phase !== 'authority_pending') {
              this.catalogCanaryClaimed = false;
              return;
            }
            try {
              const raw = await apiGetCatalogCanaryAuthorityRequired();
              authority = validateCatalogCanaryAuthorityResult(raw);
              break;
            } catch (error) {
              if (error instanceof ApiRequestError
                && catalogCanaryInvitationMissing(error.status, error.code)) break;
              const retryable = error instanceof ApiRequestError
                && [0, 429, 502, 503, 504].includes(error.status);
              if (!retryable || attempt === retryDelays.length - 1) throw error;
            }
          }
        } catch (error) {
          // A terminal/invalid invitation is fail-closed once for this page;
          // nearby warm slots must not hammer the same broken authority. A
          // navigation that vanished before claiming is released above.
          throw error;
        }
        if (!authority) this.catalogCanaryClaimed = false;
        if (authority && !catalogCanaryAuthorityAllowsAllocation(authority)) {
          throw new Error('fresh catalog canary authority expired before allocation');
        }
      }

      if (!authority) {
        let normalAuthority: CatalogFeedAuthorityResultV1 | null = null;
        for (const [attempt, delay] of retryDelays.entries()) {
          if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
          if (!this.catalogSlotIsCurrent(slot) || slot.phase !== 'authority_pending') return;
          try {
            const raw = await apiGetCatalogFeedAuthorityRequired(slot.request);
            normalAuthority = validateCatalogFeedAuthorityResult(raw, slot.request);
            break;
          } catch (error) {
            const retryable = error instanceof ApiRequestError && (
              error.status === 0
              || (error.status === 404 && error.code === 'feed_authority_source_not_found')
              || (error.status === 503 && ['feed_authority_not_ready', 'feed_authority_integrity_failure'].includes(error.code ?? ''))
            );
            if (!retryable || attempt === retryDelays.length - 1) throw error;
          }
        }
        if (!normalAuthority) throw new Error('catalog authority returned no result');
        if (!this.catalogSlotIsCurrent(slot) || slot.phase !== 'authority_pending') return;
        if (normalAuthority.outcome === 'builtin_fallback') {
          if (!catalogFallbackMatchesBinding(normalAuthority.fallback, slot.exposure.binding)) {
            throw new Error('server fallback differs from the projected built-in opportunity');
          }
          this.activateCatalogBuiltinFallback(slot, 'server_policy_fallback');
          return;
        }
        if (Date.parse(normalAuthority.expiresAt) <= Date.now()) {
          throw new Error('catalog authority expired before allocation');
        }
        authority = normalAuthority;
      }
      if (!this.catalogSlotIsCurrent(slot) || slot.phase !== 'authority_pending') {
        if ('replayed' in authority) this.catalogCanaryClaimed = false;
        return;
      }
      const canaryAuthority = 'replayed' in authority;
      const canaryReplay = 'replayed' in authority ? authority.replayed : false;
      // GET can race across tabs: both pages may observe replayed=false while
      // only one commits allocation first. Gate every canary (not just an
      // explicit GET replay) on its exact projected configured impression.
      slot.canaryProjectionRequired = canaryAuthority;

      slot.phase = 'delivery_pending';
      const authorized = await apiAllocateAuthorizedCatalogRequired({
        schema: 'catalog.allocate-authorized.v2',
        authorizationId: authority.authorizationId,
      });
      if (!this.catalogSlotIsCurrent(slot) || slot.phase !== 'delivery_pending') {
        if (canaryAuthority) this.catalogCanaryClaimed = false;
        return;
      }
      if (authorized.schema !== 'catalog.allocate-authorized-result.v2'
        || authorized.authorizationId !== authority.authorizationId
        || authorized.authorizationDigest !== authority.authorizationDigest
        || authorized.allocation.allocationId !== authority.authorizationId) {
        throw new Error('authorized allocation differs from its effectful authority');
      }
      if (canaryAuthority && (authorized.allocation.outcome !== 'allocated'
        || authorized.allocation.catalog.entryState !== 'canary'
        || authorized.allocation.slotType !== 'canary-dogfood'
        || authorized.allocation.policyVersion !== 'catalog-canary-dogfood.v1')) {
        throw new Error('canary authorization did not resolve to its exact canary allocation');
      }
      if (authorized.allocation.outcome !== 'allocated') {
        this.activateCatalogBuiltinFallback(slot, 'catalog_runway_empty');
        return;
      }
      const allocation = authorized.allocation;
      if (allocation.runtime.capabilities.catalogRequiredHandshake !== true) {
        throw new Error('selected runtime does not require the catalog handshake');
      }

      const canaryRunIdentity = canaryAuthority
        ? buildCatalogCanaryRunIdentity(authority.authorizationId)
        : null;
      const ticketRequest: CatalogRunTicketRequestV2 = {
        schema: 'run.start.v2',
        ticket_id: canaryRunIdentity?.ticketId ?? ticketUid(),
        run_id: canaryRunIdentity?.runId ?? `series-${runUid()}`,
        mechanic_id: allocation.runtime.playableId,
        variant_id: allocation.runtime.legacyVariantId,
        kind: 'series',
        decision_id: allocation.decisionId,
      };
      slot.ticketRequest = ticketRequest;
      slot.allocation = allocation;
      const start = await queueRunTicketStart(ticketRequest);
      if (!this.catalogSlotIsCurrent(slot) || slot.phase !== 'delivery_pending') {
        if (canaryAuthority) this.catalogCanaryClaimed = false;
        return;
      }
      const ticket = start.latest;
      const exactCanaryTicket = canaryAuthority && ticket
        && 'schema' in ticket && ['run.ticket.v2', 'run.ticket.v3'].includes(ticket.schema)
        && ticket.ticket_id === ticketRequest.ticket_id
        && ticket.run_id === ticketRequest.run_id
        && ticket.decision_id === ticketRequest.decision_id;
      if (ticket?.state === 'revoked' || ticket?.state === 'superseded') {
        this.activateCatalogBuiltinFallback(
          slot,
          ticket.state === 'superseded'
            ? 'catalog_ticket_superseded'
            : 'catalog_ticket_revoked',
          true,
        );
        return;
      }
      // `replayed:true` recovers only the transport gap before play. An active
      // zero-progress ticket is safe to mount with the same exact identity. A
      // configured/played/terminal ticket is intentionally not resumed yet;
      // reviewed content cannot duplicate its chest or reward.
      if (canaryAuthority && exactCanaryTicket && !catalogCanaryTicketStartIsSafe(ticket)) {
        this.activateCatalogBuiltinFallback(
          slot,
          canaryReplay ? 'catalog_canary_resume_unsupported' : 'catalog_canary_ticket_not_fresh',
          true,
        );
        return;
      }
      if (start.status !== 'ok' || start.pending !== 0 || !ticket
        || !('schema' in ticket) || !['run.ticket.v2', 'run.ticket.v3'].includes(ticket.schema)
        || ticket.ticket_id !== ticketRequest.ticket_id
        || ticket.run_id !== ticketRequest.run_id || ticket.state !== 'active') {
        throw new Error(`catalog ticket start did not confirm (${start.status})`);
      }

      const catalogTicket = ticket as CatalogRunTicketViewV2 | CatalogRunTicketViewV3;

      const rawBundle = await apiGetCatalogTicketSpecsRequired(catalogTicket.ticket_id);
      if (!this.catalogSlotIsCurrent(slot) || slot.phase !== 'delivery_pending') {
        if (canaryAuthority) this.catalogCanaryClaimed = false;
        return;
      }
      const bundle = validateCatalogTicketLevelSpecBundle(rawBundle);
      this.assertCatalogDeliveryClosure(allocation, catalogTicket, bundle);
      slot.ticket = catalogTicket;
      slot.bundle = bundle;
      slot.phase = 'catalog_ready';
      if (slot.authorityTimer !== null) window.clearTimeout(slot.authorityTimer);
      slot.authorityTimer = null;
      slot.authorityTimerStage = null;
      slot.authorityTimerEpoch += 1;
      if (this.liveSet().has(slot.index)) this.mount(slot.index);
    } catch (error) {
      if (!this.catalogSlotIsCurrent(slot)) return;
      const code = error instanceof ApiRequestError ? error.code : null;
      const terminalTicket = code === 'catalog_ticket_revoked'
        || code === 'catalog_ticket_superseded';
      const staleInvitation = code === 'feed_authority_candidate_stale';
      const reason = code && [
        'feed_slot_authorization_expired',
        'feed_authority_candidate_stale',
        'feed_slot_authorization_not_found',
      ].includes(code)
        ? `catalog_invitation_${code}`
        : terminalTicket
          ? code
          : 'delivery_failure';
      console.warn('[catalog-player-v2] delivery fell back to reviewed builtin', error);
      this.activateCatalogBuiltinFallback(slot, reason, terminalTicket || staleInvitation);
    }
  }

  private assertCatalogDeliveryClosure(
    allocation: Extract<CatalogAllocationDecisionResult, { outcome: 'allocated' }>,
    ticket: CatalogRunTicketViewV2 | CatalogRunTicketViewV3,
    bundle: CatalogTicketLevelSpecBundle,
  ): void {
    const manifestLevels = allocation.manifest.levels;
    const exact = bundle.ticketId === ticket.ticket_id
      && bundle.decisionId === allocation.decisionId
      && bundle.decisionId === ticket.decision_id
      && bundle.catalogEntryId === allocation.catalog.entryId
      && bundle.catalogEntryId === ticket.catalog_entry_id
      && bundle.seriesId === allocation.catalog.seriesId
      && bundle.seriesId === ticket.series_id
      && bundle.manifestContentHash === allocation.manifest.contentHash
      && bundle.manifestContentHash === ticket.manifest_content_hash
      && bundle.runtime.releaseId === allocation.runtime.releaseId
      && bundle.runtime.releaseId === ticket.runtime_release_id
      && bundle.runtime.playableId === ticket.mechanic_id
      && bundle.runtime.legacyVariantId === ticket.variant_id
      && bundle.runtime.runtimeContractDigest === ticket.runtime_contract_digest
      && bundle.runtime.runtimeArtifactDigest === ticket.runtime_artifact_digest
      && bundle.levels.length === ticket.levels.length
      && bundle.levels.length === manifestLevels.length
      && bundle.levels.every((level, index) => level.ordinal === index + 1
        && level.specHash === ticket.levels[index]?.spec_hash
        && level.specHash === manifestLevels[index]?.specHash)
      && (allocation.schema === 'catalog.allocate-decision-result.v2'
        ? ticket.schema === 'run.ticket.v3'
          && bundle.schema === 'catalog.ticket-level-spec-bundle.v2'
          && allocation.manifest.skinHash === ticket.skin_hash
          && allocation.manifest.skinHash === bundle.skinHash
          && allocation.manifest.skinContractDigest === ticket.skin_contract_digest
          && allocation.manifest.skinContractDigest === bundle.skinContractDigest
        : ticket.schema === 'run.ticket.v2'
          && bundle.schema === 'catalog.ticket-level-spec-bundle.v1');
    if (!exact) throw new Error('ticket/spec bundle differs from the authorized allocation closure');
  }

  private activateCatalogBuiltinFallback(
    slot: CatalogFeedSlot,
    reason: string,
    showRecovery = false,
  ): void {
    if (!this.catalogSlotIsCurrent(slot) || slot.phase === 'builtin_fallback') return;
    if (slot.authorityTimer !== null) window.clearTimeout(slot.authorityTimer);
    if (slot.configurationTimer !== null) window.clearTimeout(slot.configurationTimer);
    slot.authorityTimer = null;
    slot.authorityTimerStage = null;
    slot.authorityTimerEpoch += 1;
    slot.configurationTimer = null;
    slot.canaryProjectionRequired = false;
    slot.session?.dispose(slot.frameEpoch);
    slot.session = null;

    const frame = this.frames.get(slot.index);
    if (frame) {
      this.disposeFrame(slot.index, frame);
      this.frames.delete(slot.index);
      this.resetFrameReadiness(slot.index);
    }

    const visibleRecovery = slot.index === this.realIndex()
      && (this.cpExposure === slot.exposure || this.shownIndex === slot.index);
    if (visibleRecovery) {
      // A projected catalog impression needs an exit; a rejected/unconfirmed
      // one does not exist server-side. Both cases still need a fresh builtin
      // impression identity and truthful later reveal timestamp. Otherwise the
      // old shownIndex suppresses markUnitShown on the replacement frame.
      if (slot.exposure.impressionEmitted) this.closeControlPlaneExposure('close', true);
      const now = performance.now();
      const dwell = new ActiveDwellAccumulator(now);
      dwell.reset(now);
      const recovery: ControlPlaneExposure = {
        ...slot.exposure,
        impressionId: ticketUid(),
        revealedAt: null,
        impressionEmitted: false,
        closed: false,
        dwell,
        levels: new Map(),
        exit: null,
      };
      slot.exposure = recovery;
      this.cpPendingExposure = recovery;
      this.cpExposure = null;
      if (this.shownIndex === slot.index) this.shownIndex = -1;
    }

    slot.phase = 'builtin_fallback';
    if (slot.insertionKind === 'generated') {
      this.games[slot.index]?.classList.remove('game--generated');
      this.releaseGeneratedPreview(this.generatedOffer);
      this.generatedOffer = null;
      this.generatedOfferState = 'failed';
      this.generatedTargetIndex = null;
      this.catalogCanaryClaimed = false;
      this.coverLoaded.delete(slot.index);
      this.ensureCover(slot.index);
      this.incomingIndex = -1;
      this.updateIncomingPoster();
    }
    if (this.series?.catalog === slot) {
      this.clearSeriesUi();
      this.series = null;
    }
    track('catalog_fallback', { mechanic_id: slot.exposure.playableId, reason });
    if (showRecovery && visibleRecovery) this.showCatalogRecoveryNotice();
    if (this.liveSet().has(slot.index)
      && (!slot.exposure.impressionEmitted || visibleRecovery)) this.mount(slot.index);
  }

  private showCatalogRecoveryNotice(): void {
    if (!this.seriesTransitionEl) {
      const el = document.createElement('div');
      el.className = 'series-transition';
      this.viewport.appendChild(el);
      this.seriesTransitionEl = el;
    }
    this.seriesTransitionEl.innerHTML =
      '<div class="series-transition__praise">Серия обновилась</div>'
      + '<div class="series-transition__sub">Продолжаем с проверенной версией</div>';
    requestAnimationFrame(() => this.seriesTransitionEl?.classList.add('series-transition--in'));
    window.setTimeout(() => this.hideSeriesTransition(), 1200);
  }

  private onCatalogResultTerminal = (event: {
    ticketId: string | null;
    code: string | null;
    status: number;
  }): void => {
    if (!event.ticketId) return;
    const slot = [...this.catalogSlots.values()].find((candidate) => {
      const ticketId = candidate.ticketRequest?.ticket_id;
      return ticketId === event.ticketId;
    });
    if (!slot) return;
    const terminalTicket = Boolean(catalogRecallRecoveryEffect(
      event.code,
      event.ticketId,
      slot.ticketRequest?.ticket_id ?? '',
    ));
    this.activateCatalogBuiltinFallback(
      slot,
      terminalTicket
        ? event.code ?? 'catalog_ticket_terminal'
        : `catalog_result_rejected_${event.code ?? event.status}`,
      true,
    );
  };

  private disposeCatalogSlot(i: number): void {
    const slot = this.catalogSlots.get(i);
    if (!slot) return;
    if (slot.canaryProjectionRequired) this.catalogCanaryClaimed = false;
    if (slot.authorityTimer !== null) window.clearTimeout(slot.authorityTimer);
    if (slot.configurationTimer !== null) window.clearTimeout(slot.configurationTimer);
    slot.session?.dispose(slot.frameEpoch);
    slot.authorityTimer = null;
    slot.authorityTimerStage = null;
    slot.authorityTimerEpoch += 1;
    const frame = this.frames.get(i);
    if (frame?.dataset.catalogPlayerV2 === '1') {
      this.disposeFrame(i, frame);
      this.frames.delete(i);
      this.resetFrameReadiness(i);
    }
    slot.phase = 'disposed';
    this.catalogSlots.delete(i);
  }

  private controlPlaneDwellGates(exposure: ControlPlaneExposure): {
    visible: boolean;
    foreground: boolean;
    interactiveReady: boolean;
  } {
    const current = exposure.index === this.shownIndex && exposure.index === this.realIndex();
    return {
      visible: !document.hidden,
      foreground: current
        && this.feedActuallyVisible(exposure.index)
        && this.framePaused.get(exposure.index) !== true
        && !this.shouldPauseFrame(exposure.index)
        && this.collectingRewardIndex === null,
      interactiveReady: this.frameInteractiveReady.has(exposure.index),
    };
  }

  private feedActuallyVisible(i: number): boolean {
    return i === this.realIndex()
      && this.frameRevealed.has(i)
      && this.preloaderDone
      && !document.hidden
      && !this.overlayOpen
      && !this.dailyOpen
      && !this.challengeOverlayOpen
      && this.levelUpPageState === 'idle'
      && !this.heldLevelUpOverlay
      && this.settlingTargetIndex === null;
  }

  private markCurrentUnitShownIfVisible(): void {
    const i = this.realIndex();
    if (this.feedActuallyVisible(i)) {
      this.markUnitShown(i);
      const slot = this.catalogSlotForIndex(i);
      if (slot) this.revealCatalogLevel(slot);
    }
  }

  private syncControlPlaneDwell(): void {
    const exposure = this.cpExposure;
    if (!exposure || exposure.closed) return;
    exposure.dwell.update(this.controlPlaneDwellGates(exposure), performance.now());
  }

  private controlPlaneExitState(i: number): ControlPlaneExitState {
    if (this.earnedThisCycle.has(i)) return 'won';
    if (this.failedThisCycle.has(i)) return 'lost';
    if (this.manualRuns.has(i)) return 'playing';
    return 'preview';
  }

  private closeControlPlaneExposure(
    reason: 'swipe' | 'background' | 'close',
    dwellCensored: boolean,
  ): void {
    const exposure = this.cpExposure;
    if (!exposure || exposure.closed) return;
    this.syncControlPlaneDwell();
    const finished = exposure.dwell.finish(performance.now(), dwellCensored);
    exposure.closed = true;
    exposure.exit = {
      reason,
      state: this.controlPlaneExitState(exposure.index),
      dwellActiveMs: finished.dwellActiveMs,
      dwellCensored: finished.dwellCensored,
      occurredAt: new Date().toISOString(),
    };
    this.cpExposure = null;
    if (exposure.impressionEmitted) this.emitControlPlaneExit(exposure);
    this.deferControlPlaneExposure(exposure);
  }

  private emitControlPlaneExit(exposure: ControlPlaneExposure): void {
    const exit = exposure.exit;
    if (!exposure.impressionEmitted || !exit) return;
    const eventId = queueControlPlaneEvent('unit_exit', {
      impression_id: exposure.impressionId,
      reason: exit.reason,
      state: exit.state,
      dwell_active_ms: exit.dwellActiveMs,
      dwell_censored: exit.dwellCensored,
    }, exit.occurredAt);
    if (!eventId) return;
    // One exposure has exactly one exit. Clear it after enqueue so a later
    // binding refresh cannot append a duplicate event with a new event_id.
    exposure.exit = null;
  }

  private registerControlPlaneAttempt(
    i: number,
    runId: string,
    ticket: RunTicketRequest,
  ): ControlPlaneAttempt | null {
    const existing = this.cpAttempts.get(runId);
    if (existing) return existing;
    const exposure = this.cpExposure;
    if (!controlPlaneEnabled() || !exposure || exposure.closed || exposure.index !== i) return null;
    const levelIndex = this.series?.index === i ? this.series.done + 1 : 1;
    const attempt: ControlPlaneAttempt = {
      runId,
      exposure,
      levelIndex,
      ticket,
      startedAt: new Date().toISOString(),
      readyAt: this.frameInteractiveReadyAt.get(i) ?? null,
      emitted: false,
      actions: [],
      result: null,
    };
    this.cpAttempts.set(runId, attempt);
    this.flushControlPlaneAttempt(attempt);
    return attempt;
  }

  private flushControlPlaneAttempt(attempt: ControlPlaneAttempt): void {
    const exposure = attempt.exposure;
    const catalogSlot = this.catalogSlotForExposure(exposure);
    const generated = catalogSlot?.insertionKind === 'generated';
    // A transient persistence failure must not permanently strand the parent
    // decision/impression while child attempt events keep accumulating.
    if ((!exposure.decisionEmitted || (exposure.revealedAt && !exposure.impressionEmitted))
      && !generated) {
      this.emitControlPlaneExposure(exposure);
    }
    this.deferControlPlaneExposure(exposure);
    if (!exposure.impressionEmitted || (!exposure.binding && !generated)) return;
    const catalogAttempt = Boolean(catalogSlot
      && catalogSlot.phase !== 'builtin_fallback'
      && attempt.ticket.schema === 'run.start.v2');
    let level = exposure.levels.get(attempt.levelIndex);
    if (catalogAttempt) {
      if (!catalogSlot?.ticketRequest || attempt.ticket.ticket_id !== catalogSlot.ticketRequest.ticket_id
        || attempt.ticket.decision_id !== catalogSlot.ticketRequest.decision_id
        || !level?.emitted) return;
      attempt.readyAt ??= level.occurredAt;
    } else {
      if (!attempt.readyAt) return;
      // An attempt created before a cold /session answered is a legacy attempt.
      // Its ticket identity is already frozen and must never be retroactively
      // relabelled or sent into the bound chain if the reviewed variant differs.
      if (!exposure.binding || attempt.ticket.variant_id !== exposure.binding.variant_id) return;
      if (!level) {
        level = {
          levelImpressionId: ticketUid(),
          levelIndex: attempt.levelIndex,
          occurredAt: attempt.readyAt,
          emitted: false,
        };
        exposure.levels.set(attempt.levelIndex, level);
      }
      if (!level.emitted) {
        const eventId = queueControlPlaneEvent('builtin_level_impression', {
          impression_id: exposure.impressionId,
          level_impression_id: level.levelImpressionId,
          level_index: level.levelIndex,
        }, level.occurredAt);
        if (!eventId) return;
        level.emitted = true;
      }
    }
    if (!level || !attempt.readyAt) return;
    if (!attempt.emitted) {
      const attemptOccurredAt = attempt.startedAt < attempt.readyAt
        ? attempt.readyAt
        : attempt.startedAt;
      const eventId = queueControlPlaneEvent('attempt_start', {
        run_id: attempt.runId,
        ticket_id: attempt.ticket.ticket_id,
        level_impression_id: level.levelImpressionId,
        level_index: attempt.levelIndex,
      }, attemptOccurredAt);
      if (!eventId) return;
      attempt.emitted = true;
      if (catalogAttempt && catalogSlot) this.watchCatalogControlPlaneConflict(catalogSlot, eventId);
    }
    for (const action of attempt.actions) {
      if (action.emitted) continue;
      const eventId = queueControlPlaneEvent('manual_action', {
        run_id: attempt.runId,
        level_impression_id: level.levelImpressionId,
        action_seq: action.actionSeq,
        action_type: action.actionType,
        accepted: action.accepted,
        changed_state: action.changedState,
      }, action.occurredAt);
      if (!eventId) return;
      action.emitted = true;
      if (catalogAttempt && catalogSlot) this.watchCatalogControlPlaneConflict(catalogSlot, eventId);
    }
    if (attempt.result && !attempt.result.emitted) {
      const eventId = queueControlPlaneEvent('attempt_result', {
        run_id: attempt.runId,
        outcome: attempt.result.outcome,
        time_ms: attempt.result.timeMs,
      }, attempt.result.occurredAt);
      if (eventId) {
        attempt.result.emitted = true;
        if (catalogAttempt && catalogSlot) this.watchCatalogControlPlaneConflict(catalogSlot, eventId);
      }
    }
  }

  private recordControlPlaneManualAction(i: number, action: ControlPlaneManualAction): void {
    if (i !== this.realIndex() || i !== this.shownIndex || !this.frameInteractiveReady.has(i)) return;
    const occurredAt = new Date().toISOString();
    this.enterManualMode(i);
    const runId = this.frames.get(i)?.dataset.runId;
    if (!runId) return;
    const ticket = this.ticketForRun(i, runId);
    if (!ticket) return;
    const attempt = this.registerControlPlaneAttempt(i, runId, ticket);
    if (!attempt) return;
    attempt.readyAt ??= this.frameInteractiveReadyAt.get(i) ?? occurredAt;
    attempt.actions.push({ ...action, occurredAt, emitted: false });
    this.flushControlPlaneAttempt(attempt);
  }

  private recordControlPlaneAttemptResult(
    i: number,
    runId: string,
    outcome: 'win' | 'lose',
    timeMs: number,
  ): void {
    const ticket = this.ticketForRun(i, runId);
    if (!ticket) return;
    const attempt = this.registerControlPlaneAttempt(i, runId, ticket);
    if (!attempt) return;
    attempt.result = {
      outcome,
      timeMs: Math.max(0, Math.round(timeMs)),
      occurredAt: new Date().toISOString(),
      emitted: false,
    };
    this.flushControlPlaneAttempt(attempt);
  }

  private markCurrentControlPlaneAttemptReady(i: number, occurredAt: string): void {
    const runId = this.frames.get(i)?.dataset.runId;
    if (!runId) return;
    const attempt = this.cpAttempts.get(runId);
    if (!attempt) return;
    attempt.readyAt ??= occurredAt;
    this.flushControlPlaneAttempt(attempt);
  }

  private onControlPlanePageHide = (event: PageTransitionEvent) => {
    if (event.persisted) {
      // BFCache is a pause of the same exposure/run, not a terminal unit exit.
      this.syncControlPlaneDwell();
      void flushControlPlane({ force: true });
      return;
    }
    this.closeControlPlaneExposure('close', true);
    void flushControlPlane({ force: true });
  };

  private onControlPlanePageShow = (event: PageTransitionEvent) => {
    if (!controlPlaneEnabled()) return;
    this.retryDeferredControlPlaneExposures();
    if (event.persisted) this.applyActiveStates();
    // Never bypass the same occlusion gate used by normal reveal. A BFCache
    // pageshow can fire while the preloader or a full-screen host view is up.
    if (!this.cpExposure) this.markCurrentUnitShownIfVisible();
    this.syncControlPlaneDwell();
  };

  // Foreground: push wins queued while away/offline, then re-read the balance.
  private async onForeground(): Promise<void> {
    // A cold backend may have exhausted the initial bounded /session retry
    // window. Foreground is the recovery edge for identity bindings and CP
    // initialization, not merely a balance refresh.
    this.retryDeferredControlPlaneExposures();
    if (await this.syncSessionBootstrap()) return;
    this.applyConfirmedBalances(await flushResults());
    const m = await apiMe();
    if (m && typeof m.balance === 'number') this.applyServerBalance(m.balance);
    if (m && typeof m.puzzles === 'number') this.applyServerPuzzles(m.puzzles);
    void this.syncDaily(false);
    void this.refreshChallengeRail();
  }

  // Bottom-bar version: platform build always; backend git SHA appended once the
  // caller is authenticated (from /session) — so you can see when the backend is
  // live with your latest push before testing changes.
  private renderVersionLabel(): void {
    if (!this.versionEl) return;
    // holdcover debug: show ONLY the short slot readout (platform/time/api make the
    // line overflow off-screen). This is the TRUE in-Telegram slot aspect → tells us
    // exactly what to bake at (fill-stretch = |slot − bake|).
    if (this.HOLD_COVER) {
      this.versionEl.textContent = this.dbgSlot
        ? `slot ${this.dbgSlot.w}×${this.dbgSlot.h}  a=${this.dbgSlot.a}  ${this.coverBucket === '.c' ? 'desk .80' : 'mob .65'}`
        : 'measuring slot…';
      return;
    }
    const rawStamp = typeof __PLATFORM_VERSION__ === 'string' ? __PLATFORM_VERSION__ : 'dev';
    const [builtAt, platformCommit = 'dev'] = rawStamp.split(' · ', 2);
    const date = builtAt === 'dev' ? 'dev' : builtAt.slice(5);
    const api = this.backendVersion ? ` · api ${this.backendVersion}` : '';
    this.versionEl.textContent = `${date} · platform ${platformCommit}${api}`;
  }

  private applyCatalogLabAuthorizationCapability(value: unknown): void {
    if (!this.catalogLabNavEl) return;
    this.catalogLabNavEl.hidden = !catalogLabAuthorizationAvailable(value);
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

  private applyConfirmedBalances(confirmed: ConfirmedBalances | null): void {
    if (!confirmed) return;
    this.applyServerBalance(confirmed.stars);
    if (confirmed.puzzles != null) this.applyServerPuzzles(confirmed.puzzles);
  }

  private applyServerPuzzles(puzzles: number): void {
    // The server ledger is authoritative. Add only the durable outbox entries
    // that have not reached it yet, rather than preserving arbitrary local state.
    const next = Math.max(0, puzzles + pendingPuzzles());
    if (next === this.totalPuzzles) return;
    this.totalPuzzles = next;
    this.updatePuzzleCounter();
  }

  private async syncDaily(showPanel = false): Promise<void> {
    if (this.dailySyncing) return;
    this.dailySyncing = true;
    try {
      const state = await apiDailySync();
      if (!state) return;
      this.dailyState = state;
      this.applyServerPuzzles(state.puzzle_balance);
      this.updateDailyNavAlert();
      this.renderDailyPanel();
      this.startDailyTimer();
      if (showPanel) this.showDailyPanel();
    } finally {
      this.dailySyncing = false;
    }
  }

  private bumpDailyProgress(questId: string, amount: number): void {
    const state = this.dailyState;
    if (!state || amount <= 0) return;
    const quest = state.quests.find((q) => q.id === questId);
    if (!quest || quest.claimed) return;
    quest.progress = Math.min(quest.target, quest.progress + amount);
    quest.completed = quest.progress >= quest.target;
    this.updateDailyNavAlert();
    this.renderDailyPanel();
  }

  private updateDailyNavAlert(): void {
    const ready = !!this.dailyState?.quests.some((quest) => quest.completed && !quest.claimed);
    if (this.dailyNavAlertEl) this.dailyNavAlertEl.hidden = !ready;
    if (this.dailyNavBtnEl) {
      this.dailyNavBtnEl.classList.toggle('feed-bar__icon--attention', ready);
      this.dailyNavBtnEl.setAttribute(
        'aria-label',
        ready ? 'Ежедневные задания, награда готова' : 'Ежедневные задания',
      );
    }
  }

  private showDailyPanel(): void {
    this.dailyOpen = true;
    this.applyActiveStates();   // freeze + mute the feed mechanic behind daily
    if (!this.dailyState) {
      this.mountDailyPanel(true);
      void this.syncDaily(true);
      return;
    }
    this.mountDailyPanel(false);
    this.renderDailyPanel();
    this.startDailyTimer();
  }

  private hideDailyPanel(): void {
    // Clear the pause flag first; if we're returning to the feed, applyActiveStates
    // resumes the mechanic now (not after the fade). If another view is opening,
    // its own open path re-pauses in the same tick, so no audible resume blip.
    const wasOpen = this.dailyOpen;
    this.dailyOpen = false;
    if (wasOpen) this.applyActiveStates();
    const panel = this.dailyPanelEl;
    if (!panel) return;
    panel.classList.remove('daily-panel--in');
    if (this.dailyTickTimer != null) {
      window.clearInterval(this.dailyTickTimer);
      this.dailyTickTimer = null;
    }
    window.setTimeout(() => {
      if (this.dailyPanelEl === panel) this.dailyPanelEl = null;
      if (this.dailyTimerEl && panel.contains(this.dailyTimerEl)) this.dailyTimerEl = null;
      panel.remove();
    }, 240);
  }

  private mountDailyPanel(loading: boolean): void {
    if (this.dailyPanelEl) return;
    this.comingSoonEl?.remove();
    this.comingSoonEl = null;
    const panel = document.createElement('div');
    panel.className = 'daily-panel';
    panel.innerHTML =
      '<div class="daily-panel__head">' +
        '<div><div class="daily-panel__title">Ежедневные задания</div><div class="daily-panel__timer">--:--:--</div></div>' +
      '</div>' +
      `<div class="daily-panel__list">${loading ? '<div class="daily-panel__loading">Загружаем…</div>' : ''}</div>`;
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.viewport.appendChild(panel);
    this.dailyPanelEl = panel;
    this.dailyTimerEl = panel.querySelector('.daily-panel__timer');
    requestAnimationFrame(() => panel.classList.add('daily-panel--in'));
  }

  private renderDailyPanel(): void {
    const state = this.dailyState;
    const panel = this.dailyPanelEl;
    if (!state || !panel) return;
    this.updateDailyTimer();
    const list = panel.querySelector<HTMLElement>('.daily-panel__list');
    if (!list) return;
    list.replaceChildren(...state.quests.map((quest) => {
      const row = document.createElement('div');
      row.className = 'daily-panel__quest' + (quest.completed ? ' daily-panel__quest--done' : '');

      const text = document.createElement('div');
      text.className = 'daily-panel__quest-text';
      const title = document.createElement('div');
      title.className = 'daily-panel__quest-title';
      title.textContent = quest.title;
      const progress = document.createElement('div');
      progress.className = 'daily-panel__progress';
      progress.textContent = `${Math.min(quest.progress, quest.target)} / ${quest.target}`;
      const bar = document.createElement('div');
      bar.className = 'daily-panel__bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(0, Math.min(100, (quest.progress / quest.target) * 100))}%`;
      bar.appendChild(fill);
      text.append(title, progress, bar);

      const reward = document.createElement('div');
      reward.className = 'daily-panel__reward';
      reward.innerHTML = `<img src="${PUZZLE_ICON}" alt="" draggable="false"><span>+${quest.reward_puzzles}</span>`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'daily-panel__claim';
      const claiming = this.dailyClaiming.has(quest.id);
      btn.disabled = !quest.completed || quest.claimed || claiming;
      btn.textContent = claiming ? 'Начисляем' : quest.claimed ? 'Получено' : quest.completed ? 'Забрать' : 'В процессе';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        void this.claimDailyQuest(quest.id, btn, reward);
      });

      row.append(text, reward, btn);
      return row;
    }));
  }

  private startDailyTimer(): void {
    if (!this.dailyTimerEl) return;
    if (this.dailyTickTimer != null) window.clearInterval(this.dailyTickTimer);
    this.updateDailyTimer();
    this.dailyTickTimer = window.setInterval(() => this.updateDailyTimer(), 1000);
  }

  private updateDailyTimer(): void {
    if (!this.dailyTimerEl || !this.dailyState) return;
    const left = Math.max(0, Math.ceil((Date.parse(this.dailyState.reset_at) - Date.now()) / 1000));
    this.dailyTimerEl.textContent = `Обновление через ${this.formatDailyTime(left)}`;
    if (left <= 0) void this.syncDaily(false);
  }

  private formatDailyTime(totalSeconds: number): string {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  private async claimDailyQuest(
    questId: string,
    button: HTMLButtonElement,
    rewardEl: HTMLElement,
  ): Promise<void> {
    if (this.dailyClaiming.has(questId)) return;
    const before = this.dailyState?.quests.find((q) => q.id === questId);
    const reward = before && before.completed && !before.claimed ? before.reward_puzzles : 0;
    if (reward <= 0) return;
    const puzzleBalanceBeforeClaim = this.totalPuzzles;
    const sourceIcon = rewardEl.querySelector<HTMLElement>('img') ?? rewardEl;
    const sourceRect = sourceIcon.getBoundingClientRect();
    const viewportRect = this.viewport.getBoundingClientRect();
    const origin = {
      x: sourceRect.left - viewportRect.left + sourceRect.width / 2,
      y: sourceRect.top - viewportRect.top + sourceRect.height / 2,
    };
    this.dailyClaiming.add(questId);
    button.disabled = true;
    button.textContent = 'Начисляем';
    const state = await apiDailyClaim(questId);
    if (!state) {
      this.dailyClaiming.delete(questId);
      button.textContent = 'Ошибка';
      window.setTimeout(() => this.renderDailyPanel(), 700);
      return;
    }
    this.dailyState = state;
    this.updateDailyNavAlert();
    this.launchDailyPuzzleReward(rewardEl, origin, reward, puzzleBalanceBeforeClaim + reward, () => {
      this.dailyClaiming.delete(questId);
      this.applyServerPuzzles(state.puzzle_balance);
      this.renderDailyPanel();
      this.updateDailyNavAlert();
    });
  }

  private launchDailyPuzzleReward(
    source: HTMLElement,
    origin: { x: number; y: number },
    count: number,
    targetBalance: number,
    onDone: () => void,
  ): void {
    const icon = source.querySelector<HTMLElement>('img') ?? source;
    const { x: cx, y: cy } = origin;
    const total = Math.max(0, Math.floor(count));
    if (total === 0 || !Number.isFinite(cx) || !Number.isFinite(cy)) {
      onDone();
      return;
    }

    // The source reward gives the same bottom-pinned squash/stretch cue as the
    // series gift before the individual puzzle pieces peel away from it.
    const previousOrigin = icon.style.transformOrigin;
    icon.style.transformOrigin = '50% 100%';
    const sourceAnimation = icon.animate?.([
      { transform: 'scale(1,1)', offset: 0 },
      { transform: 'scale(1.18,0.84)', offset: 0.24 },
      { transform: 'scale(0.88,1.18)', offset: 0.54 },
      { transform: 'scale(1.05,0.96)', offset: 0.8 },
      { transform: 'scale(1,1)', offset: 1 },
    ], { duration: 460, easing: 'cubic-bezier(0.33,1,0.68,1)' });
    if (sourceAnimation) {
      sourceAnimation.addEventListener('finish', () => {
        icon.style.transformOrigin = previousOrigin;
      }, { once: true });
    } else {
      icon.style.transformOrigin = previousOrigin;
    }

    let landed = 0;
    const STAGGER_MS = 85;
    const onLand = () => {
      // A foreground sync may already have applied the claimed server balance
      // while pieces are in flight. Never add the same reward twice in that case.
      if (this.totalPuzzles < targetBalance) {
        this.totalPuzzles += 1;
        this.updatePuzzleCounter();
      }
      landed += 1;
      if (landed === total) onDone();
    };
    for (let index = 0; index < total; index++) {
      window.setTimeout(() => {
        try {
          (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: { impactOccurred: (style: string) => void } } } })
            .Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
        } catch { /* noop */ }
        this.flyOnePuzzle(cx, cy, onLand, false);
      }, index * STAGGER_MS);
    }
  }

  private makeRunTicket(
    i: number,
    runId: string,
    kind: RunTicketRequest['kind'],
    challengeId?: string,
  ): RunTicketRequest | null {
    const mechanicId = this.playables[i]?.id;
    if (!mechanicId) return null;
    const challengeVariant = challengeId && this.activeChallenge?.id === challengeId
      ? this.activeChallenge.variant_id
      : null;
    const exposureVariant = !challengeVariant
      && this.cpExposure
      && !this.cpExposure.closed
      && this.cpExposure.index === i
      && this.cpExposure.playableId === mechanicId
      ? this.cpExposure.binding?.variant_id ?? null
      : null;
    return {
      ticket_id: ticketUid(),
      run_id: runId,
      mechanic_id: mechanicId,
      // A deep-linked challenge is bound to its creator's immutable variant.
      // A later reviewed built-in mapping must not relabel that challenge run.
      variant_id: challengeVariant ?? exposureVariant ?? this.variantIdForPlayable(mechanicId),
      kind,
      challenge_id: challengeId,
    };
  }

  private warmRunTicket(ticket: RunTicketRequest): void {
    if (!getInitData()) return;
    void queueRunTicketStart(ticket).then((started) => {
      if (started.confirmed > 0) void flushResults();
    });
  }

  private ticketForRun(i: number, runId: string): RunTicketRequest | null {
    if (this.series?.index === i) return this.series.ticket;
    const existing = this.runTickets.get(runId);
    if (existing) return existing;
    const mechanicId = this.playables[i]?.id;
    const challengeId = this.activeChallenge?.mechanic_id === mechanicId
      ? this.activeChallenge.id
      : undefined;
    const ticket = this.makeRunTicket(i, runId, 'single', challengeId);
    if (!ticket) return null;
    this.runTickets.set(runId, ticket);
    this.warmRunTicket(ticket);
    return ticket;
  }

  // Persist a manual win to the server (idempotent by run_id). The durable
  // outbox carries the run-ticket start intent and any challenge completion.
  private reportResult(
    i: number,
    runId: string,
    solveMs: number,
    starsOverride?: number,
  ): Promise<ConfirmedBalances | null> {
    const mechanicId = this.playables[i]?.id;
    if (!mechanicId) return Promise.resolve(null);
    // Use the same deterministic run-id roll as the backend, so the reward row
    // and authoritative ledger agree. During a series, per-level wins grant 0
    // and the final chest owns the payout.
    const stars = starsOverride ?? this.rewardStarsFor(i);
    // Durable: queue to localStorage + retry until the server confirms (survives
    // cold backend / reload). Idempotent by run_id server-side. Metric = solve time
    // (ms), lower is better — the same number that decides a challenge.
    const ticket = this.ticketForRun(i, runId);
    const seriesLevel = this.series?.index === i && starsOverride === 0
      ? this.series.done
      : undefined;
    const challengeId = this.activeChallenge?.mechanic_id === mechanicId
      ? this.activeChallenge.id
      : undefined;
    const queued = queueResult({
      mechanic_id: mechanicId,
      // Ticket identity is frozen at attempt start. A slow /session may install
      // a reviewed binding while the run is already in flight; never mutate the
      // result's variant underneath that existing ticket.
      variant_id: ticket?.variant_id ?? this.variantIdForPlayable(mechanicId),
      run_id: runId,
      metric_key: 'time_ms',
      metric_value: solveMs,
      stars,
      run_ticket: ticket ?? undefined,
      series_level: seriesLevel,
      complete_challenge_id: challengeId,
      tz_offset_minutes: currentTzOffsetMinutes(),
    });
    this.bumpDailyProgress('levels_10', 1);
    if (stars > 0) this.bumpDailyProgress('stars_50', stars);
    return queued;
  }

  private reportCatalogLevelResult(
    i: number,
    runId: string,
    solveMs: number,
    catalog: CatalogFeedSlot,
    completedLevel: number,
  ): Promise<boolean> {
    const level = catalog.bundle?.levels[completedLevel - 1];
    const ticket = catalog.ticketRequest;
    if (!level || !catalog.bundle || !ticket
      || this.series?.index !== i || this.series.catalog !== catalog) {
      if (this.catalogSlotIsCurrent(catalog)) {
        this.activateCatalogBuiltinFallback(catalog, 'catalog_level_binding_missing', true);
      }
      return Promise.resolve(false);
    }
    return queueResultWithReceipt({
      mechanic_id: catalog.bundle.runtime.playableId,
      variant_id: ticket.variant_id,
      run_id: runId,
      metric_key: 'time_ms',
      metric_value: solveMs,
      stars: 0,
      run_ticket: ticket,
      series_level: completedLevel,
      series_id: catalog.bundle.seriesId,
      ordinal: level.ordinal,
      applied_spec_hash: level.specHash,
      ...(catalog.bundle.schema === 'catalog.ticket-level-spec-bundle.v2'
        ? {
          schema: 'catalog.result.v2' as const,
          applied_skin_hash: catalog.bundle.skinHash,
        }
        : {}),
      tz_offset_minutes: currentTzOffsetMinutes(),
    }).then((receipt) => {
      if (receipt.status === 'confirmed' && catalogResultAllowsProgress(receipt, runId)) {
        this.bumpDailyProgress('levels_10', 1);
        return true;
      }
      // A terminal server rejection reaches the shared listener first. A local
      // persistence failure has no such edge and must fail closed here.
      if (this.catalogSlotIsCurrent(catalog)) {
        this.activateCatalogBuiltinFallback(
          catalog,
          receipt.status === 'storage_error'
            ? 'catalog_level_storage_error'
            : receipt.status === 'rejected'
              ? `catalog_level_rejected_${receipt.code ?? receipt.httpStatus}`
              : 'catalog_level_receipt_mismatch',
          true,
        );
      }
      return false;
    });
  }

  // Solve time for this unit's current manual run (takeover → now), ms. Falls back
  // to time-since-shown if we somehow missed the takeover mark.
  private solveMsFor(i: number): number {
    const start = this.manualStartMs.get(i) ?? this.shownAt;
    return Math.max(1, Math.round(performance.now() - start));
  }

  // ── Challenge loop (W2) ──────────────────────────────────────────────────
  // A manual win either COMPLETES the active challenge (recipient, on the
  // challenged mechanic) or OFFERS to start one (sender). All social calls no-op
  // gracefully outside Telegram (no initData → api returns null).
  private onManualWinChallenge(
    i: number,
    solveMs: number,
    runId: string,
    resultPromise: Promise<ConfirmedBalances | null>,
  ): void {
    const mechanicId = this.playables[i]?.id;
    if (!mechanicId) return;
    const ch = this.activeChallenge;
    if (ch && !this.challengeCompleted && ch.mechanic_id === mechanicId) {
      this.challengeCompleted = true;
      void this.completeActiveChallenge(solveMs, runId, resultPromise);
      return;
    }
    this.showChallengePill(mechanicId, solveMs, runId);
  }

  private async completeActiveChallenge(
    solveMs: number,
    runId: string,
    resultPromise: Promise<ConfirmedBalances | null>,
  ): Promise<void> {
    const ch = this.activeChallenge!;
    const confirmed = await resultPromise;
    const res = confirmed?.challenge ?? null;
    track('challenge_complete', { challenge_id: ch.id, time_ms: solveMs, beat: res?.beat ?? null });
    if (res && typeof res.balance === 'number') this.applyServerBalance(res.balance);
    if (res?.stars_awarded) this.bumpDailyProgress('stars_50', res.stars_awarded);
    this.showChallengeResult(
      ch,
      solveMs,
      runId,
      res?.beat ?? (solveMs < ch.challenger_value),
      res?.stars_awarded ?? 0,
    );
  }

  private async doCreateChallenge(mechanicId: string, solveMs: number, runId: string): Promise<boolean> {
    await flushResults();
    const res = await apiCreateChallenge({
      mechanic_id: mechanicId,
      variant_id: this.runTickets.get(runId)?.variant_id
        ?? (this.series?.lastRunId === runId ? this.series.ticket.variant_id : this.variantIdForPlayable(mechanicId)),
      source_run_id: runId,
    });
    track('share_tap', { mechanic_id: mechanicId, time_ms: solveMs, ok: !!res });
    if (!res) return false;
    const secs = (solveMs / 1000).toFixed(1);
    shareChallenge(res.share_url, res.deep_link, `Обгонишь меня? Я прошёл за ${secs}s ⚡`);
    return true;
  }

  private dismissChallengePill(): void {
    const el = this.challengePillEl;
    if (!el) return;
    this.challengePillEl = null;
    el.classList.remove('challenge-pill--in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    window.setTimeout(() => el.remove(), 400);   // fallback if no transition
  }

  // Bottom-center CTA after a win: "⚡ Бросить вызов" with the run's time. Tap →
  // create + share; auto-dismisses on the next swipe (markUnitShown) or after 8s.
  // `persist` keeps it up (no auto-timeout) — used by the series win screen, where
  // the pill IS the win-screen challenge CTA and must live as long as the screen.
  private showChallengePill(mechanicId: string, solveMs: number, runId: string, persist = false): void {
    if (!getInitData()) return;   // no Telegram identity → sharing can't work
    this.dismissChallengePill();
    const secs = (solveMs / 1000).toFixed(1);
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'challenge-pill';
    pill.textContent = `⚡ Бросить вызов · ${secs}s`;
    pill.addEventListener('pointerdown', (e) => e.stopPropagation());
    pill.addEventListener('click', async (e) => {
      e.stopPropagation();
      pill.disabled = true;
      pill.textContent = '⚡ Отправляю…';
      if (await this.doCreateChallenge(mechanicId, solveMs, runId)) {
        this.dismissChallengePill();
      } else {
        pill.disabled = false;
        pill.textContent = 'Нет сети · повторить';
      }
    });
    this.viewport.appendChild(pill);
    this.challengePillEl = pill;
    requestAnimationFrame(() => pill.classList.add('challenge-pill--in'));
    if (!persist) window.setTimeout(() => { if (this.challengePillEl === pill) this.dismissChallengePill(); }, 8000);
  }

  private maybeShowChallengeIntro(): void {
    const ch = this.activeChallenge;
    if (!ch || this.challengeIntroShown) return;
    this.challengeIntroShown = true;
    track('challenge_open', { challenge_id: ch.id, mechanic_id: ch.mechanic_id });
    void apiAcceptChallenge(ch.id);   // register the attempt + friend edge (best-effort)

    const name = ch.challenger.first_name || ch.challenger.username || 'Друг';
    const secs = (ch.challenger_value / 1000).toFixed(1);
    const card = this.buildChallengeOverlay();
    card.body.innerHTML =
      `<div class="challenge-ov__emoji">⚡</div>` +
      `<div class="challenge-ov__title">${this.esc(name)} бросает вызов</div>` +
      `<div class="challenge-ov__sub">Пройди быстрее <b>${secs}s</b></div>`;
    const go = this.overlayButton('Принять', () => card.close());
    card.actions.appendChild(go);
    card.show();
  }

  private showChallengeResult(
    ch: ChallengeView,
    solveMs: number,
    runId: string,
    beat: boolean,
    stars: number,
  ): void {
    const name = ch.challenger.first_name || ch.challenger.username || 'соперника';
    const you = (solveMs / 1000).toFixed(1);
    const them = (ch.challenger_value / 1000).toFixed(1);
    const card = this.buildChallengeOverlay();
    card.body.innerHTML =
      `<div class="challenge-ov__emoji">${beat ? '🏆' : '⏱️'}</div>` +
      `<div class="challenge-ov__title">${beat ? `Ты обогнал ${this.esc(name)}!` : `${this.esc(name)} пока быстрее`}</div>` +
      `<div class="challenge-ov__sub">Ты: <b>${you}s</b> · ${this.esc(name)}: <b>${them}s</b></div>` +
      (stars > 0 ? `<div class="challenge-ov__stars">+${stars} ⭐</div>` : '');
    const again = this.overlayButton('Ответный вызов ⚡', () => {
      card.close();
      void this.doCreateChallenge(ch.mechanic_id, solveMs, runId);
    });
    const close = this.overlayButton('Играть дальше', () => card.close(), true);
    card.actions.append(again, close);
    card.show();
  }

  private esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  }

  private overlayButton(label: string, onClick: () => void, ghost = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'challenge-ov__btn' + (ghost ? ' challenge-ov__btn--ghost' : '');
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // A centered modal card (independent DOM, above the feed). Fade+scale in; no
  // runtime glow — plain layers only (Android perf constraint).
  private buildChallengeOverlay(): { body: HTMLElement; actions: HTMLElement; show: () => void; close: () => void } {
    const scrim = document.createElement('div');
    scrim.className = 'challenge-ov';
    const card = document.createElement('div');
    card.className = 'challenge-ov__card';
    const body = document.createElement('div');
    const actions = document.createElement('div');
    actions.className = 'challenge-ov__actions';
    card.append(body, actions);
    scrim.appendChild(card);
    let shown = false;
    let closed = false;
    const finishClose = () => {
      if (closed) return;
      closed = true;
      scrim.remove();
      if (shown) this.challengeOverlayOpen = false;
      this.applyActiveStates();
    };
    const close = () => {
      scrim.classList.remove('challenge-ov--in');
      scrim.addEventListener('transitionend', finishClose, { once: true });
      window.setTimeout(finishClose, 400);
    };
    const show = () => {
      if (shown) return;
      shown = true;
      this.challengeOverlayOpen = true;
      this.syncControlPlaneDwell();
      this.viewport.appendChild(scrim);
      requestAnimationFrame(() => scrim.classList.add('challenge-ov--in'));
    };
    return { body, actions, show, close };
  }

  // ── Challenge inbox rail (top of feed) ───────────────────────────────────
  private async refreshChallengeRail(): Promise<void> {
    if (!getInitData()) return;   // no identity → no inbox
    this.inboxChallenges = await apiChallengeInbox();
    this.renderChallengeRail();
  }

  private renderChallengeRail(): void {
    const rail = this.storiesEl;
    if (!rail) return;
    rail.querySelectorAll('.story[data-challenge]').forEach((el) => el.remove());
    const me = rail.querySelector('.story--me');
    const frag = document.createDocumentFragment();
    for (const ch of this.inboxChallenges) {
      const name = ch.challenger.first_name || ch.challenger.username || 'Друг';
      const initial = (name.trim()[0] || '?').toUpperCase();
      const el = document.createElement('div');
      el.className = 'story';
      el.dataset.challenge = ch.id;
      el.innerHTML =
        `<div class="story__avatar story__avatar--challenge${ch.played ? ' story__avatar--viewed' : ''}">` +
          `<span>${this.esc(initial)}</span><i class="story__bolt" aria-hidden="true">⚡</i></div>` +
        `<div class="story__name">${this.esc(name)}</div>`;
      frag.appendChild(el);
    }
    if (me && me.nextSibling) rail.insertBefore(frag, me.nextSibling);
    else rail.appendChild(frag);
    this.hudEl?.classList.toggle('hud--stories-can-right', rail.scrollWidth > rail.clientWidth + 1);
  }

  // Tap an inbox card → play that challenge. Reload with ?c=<id> so we reuse the
  // exact deep-link landing path (reorder feed to the mechanic + intro + complete).
  private playChallengeFromRail(id: string | undefined): void {
    if (!id) return;
    track('challenge_open', { challenge_id: id, source: 'rail' });
    const u = new URL(location.href);
    u.searchParams.set('c', id);
    location.href = u.toString();
  }

  // ── Series (W2) ──────────────────────────────────────────────────────────
  // Every mechanic runs as a multi-level series once taken over. Levels are manual,
  // auto-advance in place (no autoplay between), stars only from the end chest.
  private seriesEnabled(i: number): boolean {
    // Challenge play is a one-shot "beat the time" — never a series.
    if (this.activeChallenge && this.playables[i]?.id === this.activeChallenge.mechanic_id) return false;
    return !!this.playables[i];
  }

  // Per-mechanic series length. pins runs its 2 real authored levels; everything
  // else keeps the default 5-level (param-varied) run. Add mechanics here as they
  // get real multi-level content.
  private seriesLenFor(mechanicId: string): number {
    return seriesLength(mechanicId);
  }

  // Length of the CURRENT series (based on the mechanic being played).
  private seriesLen(): number {
    if (this.series?.catalog?.bundle) return this.series.catalog.bundle.levels.length;
    return this.seriesLenFor(this.playables[this.series?.index ?? -1]?.id ?? '');
  }

  private ensureCatalogSeries(i: number): boolean {
    const slot = this.catalogSlotForIndex(i);
    if (!slot || !slot.bundle || !slot.ticketRequest || !slot.ticket
      || !['catalog_ready', 'catalog_mounted'].includes(slot.phase)) return false;
    if (this.series?.catalog === slot) {
      this.series.playing = true;
      return true;
    }
    if (this.series) return false;
    const payout = seriesRewards(slot.ticketRequest.run_id);
    this.series = {
      index: i,
      done: 0,
      reward: payout.stars,
      puzzles: payout.puzzles,
      payoutRunId: slot.ticketRequest.run_id,
      ticket: slot.ticketRequest,
      lastRunId: null,
      playing: true,
      catalog: slot,
      catalogChestQueued: false,
    };
    track('series_start', {
      mechanic_id: slot.bundle.runtime.playableId,
      source: 'catalog_player_v2',
      series_id: slot.bundle.seriesId,
    });
    this.renderSeriesRow({ forceVisible: true });
    return true;
  }

  // Which built-in game LEVEL to load for a given 1-based series level. pins maps
  // series level N → game level N (level 1 tube, level 2 authored). Mechanics that
  // vary by PARAMS (not levels) return null → no ?level= override.
  private seriesGameLevel(mechanicId: string, seriesLevel: number): number | null {
    const base = (mechanicId || '').replace(/-swipe$/, '');
    if (base === 'pins-l3') return 2 + seriesLevel;      // series L1 → game level 3, L2 → game level 4
    if (base === 'pins' || base.startsWith('pins-')) return seriesLevel;
    if (base === 'short-drama') return seriesLevel;      // series level N → clip N
    return null;
  }

  // First takeover of a mechanic starts its series (level 1 in progress).
  private maybeStartSeries(i: number): void {
    if (this.series || !this.seriesEnabled(i)) return;
    const payoutRunId = `series-${runUid()}`;
    const payout = seriesRewards(payoutRunId);
    const ticket = this.makeRunTicket(i, payoutRunId, 'series');
    if (!ticket) return;
    this.series = {
      index: i,
      done: 0,
      reward: payout.stars,
      puzzles: payout.puzzles,
      payoutRunId,
      ticket,
      lastRunId: null,
      playing: true,
      catalog: null,
      catalogChestQueued: false,
    };
    this.warmRunTicket(ticket);
    track('series_start', { mechanic_id: this.playables[i]?.id });
    this.renderSeriesRow({ forceVisible: true });
  }

  private handleSeriesWin(i: number, runId: string, solveMs: number): void {
    if (!this.series || this.series.index !== i) return;
    this.series.done += 1;
    this.series.lastRunId = runId;
    this.lastSolveMs = solveMs;   // shown on the series win screen + used for the challenge
    // Persist the run for time/telemetry but grant NO stars per level (series pays
    // out only at the chest).
    const catalog = this.series.catalog;
    const completedLevel = this.series.done;
    if (catalog) {
      // Progress is released by this exact run's durable server receipt, never
      // by the shared flush or by confirmation of another queued run.
      void this.reportCatalogLevelResult(i, runId, solveMs, catalog, completedLevel).then((confirmed) => {
        if (!confirmed || this.series?.catalog !== catalog || this.series.done !== completedLevel
          || catalog.phase === 'builtin_fallback') return;
        this.finishSeriesLevelWin(i, completedLevel);
      });
      return;
    }
    void this.reportResult(i, runId, solveMs, 0);
    this.finishSeriesLevelWin(i, completedLevel);
  }

  private finishSeriesLevelWin(i: number, completedLevel: number): void {
    if (!this.series || this.series.index !== i || this.series.done !== completedLevel) return;
    track('series_level_win', { mechanic_id: this.effectivePlayableId(i), level: this.series.done });
    const filledSlot = this.series.done - 1;
    // Hold the just-cleared slot as PENDING (not yet green) so the panel arrives
    // without it, and pulseSeriesSlot then plays the green-in as a fresh appearance.
    this.pulsePendingSlot = filledSlot;
    this.renderSeriesRow({ forceVisible: true });
    this.manualRuns.delete(i);
    // Keep `playing` true through the chest so a stray swipe can't page away
    // mid-ceremony; it's cleared when the end-panel appears.
    if (this.series.done >= this.seriesLen()) {
      const launchChest = () => {
        if (!this.series || this.series.index !== i || this.series.done !== completedLevel) return;
        // Final level: fill the LAST slot FIRST, then launch the chest — sequential,
        // not simultaneous (the slot stamp reads before the gift lifts off the panel).
        this.afterSeriesRowEntrance(() => {
          this.pulseSeriesSlot(filledSlot);
          window.setTimeout(() => this.beginChest(i), 780);
        });
      };
      const catalog = this.series.catalog;
      if (catalog) {
        // Confirm (or durably queue) the exact manifest-bound chest before any
        // reward animation. A hard recall therefore recovers neutrally instead
        // of showing a reward the server refused.
        void this.queueCatalogChestResult(i).then((confirmed) => {
          if (!confirmed || this.series?.catalog !== catalog || catalog.phase === 'builtin_fallback') return;
          launchChest();
        });
      } else launchChest();
      return;
    }
    // Smooth transition: cover the reboot (which would otherwise flash the mechanic's
    // own intro/swipe text) with a short congratulation, then reveal the next level
    // once its fresh iframe is ready.
    this.showSeriesTransition(this.series.done);
    // Light up the just-completed slot AFTER the transition dim has faded in — it
    // reads far more clearly against the darkened screen than on the live level.
    this.afterSeriesRowEntrance(() => this.pulseSeriesSlot(filledSlot));
    window.setTimeout(() => {
      if (!this.series || this.series.index !== i || !this.series.playing) return;
      this.advanceSeriesInPlace(i);
      this.awaitSeriesLevelReady(i);
    }, 980);
  }

  // Congratulation overlay that masks the between-levels reload. Sits below the slot
  // row so series progress stays visible.
  private showSeriesTransition(doneLevel: number): void {
    const praise = ['Отлично!', 'Класс!', 'Так держать!', 'Огонь!', 'Мастерски!'][Math.min(doneLevel - 1, 4)] || 'Класс!';
    if (!this.seriesTransitionEl) {
      const el = document.createElement('div');
      el.className = 'series-transition';
      this.viewport.appendChild(el);
      this.seriesTransitionEl = el;
    }
    this.seriesTransitionEl.innerHTML =
      `<div class="series-transition__praise">${praise}</div>` +
      `<div class="series-transition__sub">Уровень ${doneLevel} из ${this.seriesLen()} пройден</div>` +
      `<div class="series-transition__next">Готовим следующий…</div>`;
    requestAnimationFrame(() => this.seriesTransitionEl?.classList.add('series-transition--in'));
  }

  // Keep the transition up until the reloaded level is revealed (min read time, hard
  // cap so it can never stick).
  private awaitSeriesLevelReady(i: number): void {
    const shownAt = performance.now();
    const MIN_MS = 850, MAX_MS = 6000;
    const tick = () => {
      if (!this.series || this.series.index !== i) { this.hideSeriesTransition(); return; }
      const elapsed = performance.now() - shownAt;
      const ready = this.frameRevealed.has(i);
      if ((ready && elapsed >= MIN_MS) || elapsed >= MAX_MS) {
        this.hideSeriesTransition();
        if (this.series?.index === i && this.manualRuns.has(i)) this.setSeriesRowManualHidden(true);
        return;
      }
      window.setTimeout(tick, 120);
    };
    window.setTimeout(tick, MIN_MS);
  }

  private hideSeriesTransition(): void {
    const el = this.seriesTransitionEl;
    if (!el) return;
    this.seriesTransitionEl = null;
    el.classList.remove('series-transition--in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    window.setTimeout(() => el.remove(), 500);
  }

  // Relaunch the current mechanic in place for the next series level: fresh run id,
  // manual (no autoplay), varied params (identity for no-variation mechanics).
  private advanceSeriesInPlace(i: number): void {
    this.earnedThisCycle.delete(i);
    this.failedThisCycle.delete(i);
    this.claimedStarRewards.delete(i);
    this.pendingStarRewards.delete(i);
    this.manualRuns.add(i);   // reload then boots with auto:false → straight into manual
    this.manualStartMs.set(i, performance.now());
    // Reload the iframe for the next series level rather than swipe.restart():
    // restart() from a COMPLETED/endcard state leaves several mechanics stuck on
    // their win screen ("You're a pro!" / like+restart buttons) and never returns
    // to a playable round. A fresh iframe (auto:false, since manualRuns.has(i)) boots
    // directly into manual play — clean and mechanic-agnostic.
    // Compute this level's difficulty/economy overrides and hand them to the fresh
    // frame via ?series= (mount reads pendingSeriesParams). Mechanics that don't
    // vary return null → no query → identical replay.
    const nextSeriesLevel = (this.series?.done ?? 0) + 1;
    const mechId = this.playables[i]?.id ?? '';
    const catalogSeries = this.series?.catalog ?? null;
    const params = catalogSeries ? null : this.seriesParamsFor(mechId, nextSeriesLevel);
    if (params) this.pendingSeriesParams.set(i, encodeURIComponent(JSON.stringify(params)));
    else this.pendingSeriesParams.delete(i);
    // pins (and future level-based mechanics) load the REAL next level via ?level=;
    // param-varied mechanics return null and just replay the same level.
    const gameLevel = catalogSeries ? null : this.seriesGameLevel(mechId, nextSeriesLevel);
    if (gameLevel != null) this.pendingLevels.set(i, gameLevel);
    else this.pendingLevels.delete(i);
    // Suppress the in-slot arrival poster for this reload: it holds the unit's
    // cover (baked at the FIRST level), which otherwise flashes the wrong level
    // over the painted next-level board as the transition overlay fades out. The
    // transition masks the reload and the level warm-paints underneath, so no
    // placeholder is needed. Cleared on series teardown (clearSeriesUi).
    this.games[i]?.classList.add('game--series-reload');
    this.reloadFrame(i);      // assigns its own fresh run id
    this.updateMechanicState(i);
    this.applyActiveStates();
  }

  // ── Series slot row (5 slots + chest) ────────────────────────────────────
  // A random reward-gift icon per mechanic, cached so it stays STABLE across the many
  // re-renders of the series row (otherwise it would flicker between icons every tick).
  private seriesRewardIcon = new Map<number, string>();
  private pulsePendingSlot = -1;   // slot index rendered as PENDING (not green) until its pulse plays the green-in
  private rewardIconFor(idx: number): string {
    let ic = this.seriesRewardIcon.get(idx);
    if (!ic) { ic = REWARD_ICONS[Math.floor(Math.random() * REWARD_ICONS.length)]; this.seriesRewardIcon.set(idx, ic); }
    return ic;
  }

  private renderSeriesRow(options: { forceVisible?: boolean; giftBounce?: boolean } = {}): void {
    // The series row must NEVER show on the level-up screen — not the preview and not
    // an active-series row (after a series win the series is still set while the
    // level-up rides in). Bail for BOTH; it re-renders when the mechanic arrives
    // (settleSlide clears the level-up, then markUnitShown → renderSeriesRow).
    if (this.levelUpPageState !== 'idle' || this.heldLevelUpOverlay) { this.removeSeriesRow(true); return; }
    const active = this.series;
    // Autoplay PREVIEW: with no active series, show the same indicator for the
    // on-screen mechanic (done=0) so the player sees how many levels the series has
    // before taking over. Suppressed during reward/chest/win states.
    const idx = active ? active.index : this.shownIndex;
    const id = this.playables[idx]?.id ?? '';
    const previewReady = !active && this.frameRevealed.has(idx);
    const showPreview = !active && idx >= 0 && !!id && this.seriesEnabled(idx)
      && previewReady
      // Never on the level-up screen — wait for the next mechanic to actually arrive
      // (settleSlide clears the level-up page → markUnitShown re-renders this then).
      && this.levelUpPageState === 'idle' && !this.heldLevelUpOverlay
      && !this.manualRuns.has(idx) && this.collectingRewardIndex === null && !this.seriesWinShown.has(idx);
    if (!active && !showPreview) { this.removeSeriesRow(true); return; }
    const done = active ? active.done : 0;
    const catalogPreviewLength = this.catalogSlotForIndex(idx)?.bundle?.levels.length;
    const len = active ? this.seriesLen() : catalogPreviewLength ?? this.seriesLenFor(id);
    const rowKey = `${active ? 'active' : 'preview'}:${idx}:${len}`;
    if (this.seriesRowEl?.dataset.seriesRowKey && this.seriesRowEl.dataset.seriesRowKey !== rowKey) {
      this.removeSeriesRow(true);
    }
    if (!this.seriesRowEl) {
      const el = document.createElement('div');
      el.className = 'series-row';
      this.viewport.appendChild(el);
      this.seriesRowEl = el;
    }
    this.seriesRowEl.dataset.seriesRowKey = rowKey;
    this.seriesRowEl.style.setProperty('--series-row-w', `${this.seriesRowWidthPx(len)}px`);
    let html = '';
    for (let s = 0; s < len; s++) {
      const pending = s === this.pulsePendingSlot;   // fill held back for pulseSeriesSlot
      const isDone = s < done && !pending;
      const state = isDone ? 'done' : (s === done || pending) ? 'current' : 'todo';
      html += `<div class="series-slot series-slot--${state}">${isDone ? '✓' : s + 1}</div>`;
    }
    html += `<div class="series-chest${done >= len ? ' series-chest--ready' : ''}"><img class="series-chest__img" src="${this.rewardIconFor(idx)}" alt="reward" draggable="false"></div>`;
    this.seriesRowEl.innerHTML = `<div class="series-row__pill">${html}</div>`;
    const hideForManual = !!active && active.playing && this.manualRuns.has(idx) && !options.forceVisible;
    this.seriesRowEl.classList.toggle('series-row--manual-hidden', hideForManual);
    requestAnimationFrame(() => {
      this.seriesRowEl?.classList.add('series-row--in');
      if (options.giftBounce && !hideForManual) this.bounceSeriesChestOnce();
    });
  }

  private seriesRowWidthPx(len: number): number {
    const slots = Math.max(1, len);
    // Keep the pill's outer width stable before it enters. The row has fixed
    // slot/chest sizes, 7px flex gaps, 10px side padding, and the chest's 3px
    // visual nudge; reserving all of it avoids center-shift when contents settle.
    return 20 + slots * 24 + slots * 7 + 30 + 3;
  }

  private renderSeriesRowAfterReveal(index: number): void {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.shownIndex !== index) return;
        this.renderSeriesRow({ giftBounce: true });
      });
    });
  }

  private setSeriesRowManualHidden(hidden: boolean): void {
    this.seriesRowEl?.classList.toggle('series-row--manual-hidden', hidden);
  }

  private afterSeriesRowEntrance(fn: () => void): void {
    // CSS transform transition is 360ms. Wait a beat past it so the slot stamp
    // starts when the row has fully landed and is no longer translucent.
    window.setTimeout(() => {
      if (!this.seriesRowEl?.classList.contains('series-row--in')) return;
      fn();
    }, 430);
  }

  private bounceSeriesChestOnce(): void {
    const img = this.seriesRowEl?.querySelector<HTMLElement>('.series-chest__img');
    if (!img || !img.animate) return;
    img.animate([
      { transform: 'translateY(0) scale(1, 1)', offset: 0, easing: 'cubic-bezier(0.2,0.8,0.3,1)' },
      { transform: 'translateY(-12px) scale(0.96, 1.05)', offset: 0.38, easing: 'cubic-bezier(0.55,0,0.7,1)' },
      { transform: 'translateY(0) scale(1.24, 0.72)', offset: 0.58, easing: 'cubic-bezier(0.16,1,0.3,1)' },
      { transform: 'translateY(-3px) scale(0.94, 1.08)', offset: 0.76, easing: 'cubic-bezier(0.2,0.8,0.3,1)' },
      { transform: 'translateY(0) scale(1, 1)', offset: 1 },
    ], { duration: 560, fill: 'none' });
  }

  // A series level just completed → make its slot "light up": grow + brighten back
  // to size, and splash particles off it. Called after renderSeriesRow re-marks the
  // slot done.
  private pulseSeriesSlot(slotIdx: number): void {
    const row = this.seriesRowEl;
    if (!row || slotIdx < 0) return;
    const slot = row.querySelectorAll<HTMLElement>('.series-slot')[slotIdx];
    if (!slot) return;
    // It arrived PENDING (grey, number) — flip it to its completed green look now, so
    // the green-in below reads as the fill genuinely APPEARING, not already there.
    this.pulsePendingSlot = -1;
    slot.classList.remove('series-slot--current', 'series-slot--todo');
    slot.classList.add('series-slot--done');
    slot.textContent = '✓';
    const r = slot.getBoundingClientRect();
    const vp = this.viewport.getBoundingClientRect();
    const cx = r.left - vp.left + r.width / 2, cy = r.top - vp.top + r.height / 2;
    const DUR = 620;
    if (slot.animate) {
      // The green circle GROWS IN from large + transparent to its place — ONE smooth
      // ease-out, no mid-flight keyframe (that's what made it feel jerky).
      slot.animate([
        { transform: 'scale(3.4)', opacity: 0, offset: 0 },
        { transform: 'scale(1)', opacity: 1, offset: 1 },
      ], { duration: DUR, easing: 'cubic-bezier(0.17,0.84,0.28,1)', fill: 'backwards' });
      // A soft green halo blooms with it and fades — makes the appearance prominent.
      const halo = document.createElement('div');
      halo.style.cssText =
        `position:absolute;left:${cx}px;top:${cy}px;width:${r.width}px;height:${r.height}px;` +
        `margin:${-r.height / 2}px 0 0 ${-r.width / 2}px;border-radius:50%;pointer-events:none;z-index:2650;` +
        'background:radial-gradient(circle,rgba(69,214,140,0.6),rgba(69,214,140,0) 68%);will-change:transform,opacity;';
      this.viewport.appendChild(halo);
      halo.animate([
        { transform: 'scale(3.6)', opacity: 0, offset: 0 },
        { transform: 'scale(1.7)', opacity: 0.85, offset: 0.5 },
        { transform: 'scale(2.4)', opacity: 0, offset: 1 },
      ], { duration: DUR + 140, easing: 'cubic-bezier(0.2,0.7,0.3,1)', fill: 'forwards' })
        .addEventListener('finish', () => halo.remove(), { once: true });
    }
    // Particles splash as the circle lands in its place (not at launch).
    window.setTimeout(() => this.burstRewardCollectParticles(cx, cy, Math.max(14, r.width / 2)), Math.round(DUR * 0.66));
  }

  private removeSeriesRow(immediate = false): void {
    const el = this.seriesRowEl;
    if (!el) return;
    this.seriesRowEl = null;
    if (immediate) { el.remove(); return; }
    el.classList.remove('series-row--in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    window.setTimeout(() => el.remove(), 400);
  }

  // ── Chest ceremony: big chest → tap to spit stars → each flies to the HUD →
  //    after the last, advance to the next mechanic. ─────────────────────────
  private beginChest(i: number): void {
    if (!this.series) return;
    // The chest drops a MIX of three item types (W-collections): stars (fly up-left
    // into the level counter), puzzles (meta-currency, up-right into the puzzle
    // counter) and collection cards (down into the collections button). Counts:
    // stars = the series reward; puzzles 1–5; cards 1–3 (temporary: always drops
    // cards for now). The queue is shuffled so types interleave as you tap.
    type DropItem = { type: 'star' } | { type: 'puzzle' } | { type: 'card'; card: CollectionCard };
    const queue: DropItem[] = [];
    for (let n = 0; n < this.series.reward; n++) queue.push({ type: 'star' });
    const puzzleCount = this.series.puzzles;
    const puzzleTargetBalance = this.totalPuzzles + puzzleCount;
    for (let n = 0; n < puzzleCount; n++) queue.push({ type: 'puzzle' });
    const cardCount = 1 + Math.floor(Math.random() * 3);     // 1..3
    for (let n = 0; n < cardCount; n++) queue.push({ type: 'card', card: randomCard() });
    for (let n = queue.length - 1; n > 0; n--) {             // Fisher–Yates shuffle
      const m = Math.floor(Math.random() * (n + 1));
      [queue[n], queue[m]] = [queue[m], queue[n]];
    }
    track('series_complete', { mechanic_id: this.effectivePlayableId(i), reward: this.series.reward });
    // Does the chest payout cross a level threshold? Capture it now (before the
    // stars fly and nudge totalStars) so the level-up ceremony can ride in when
    // the player swipes off the series win screen (see onDown/onUp reward path).
    const levelBefore = this.levelForStars(this.totalStars);
    const levelAfter = this.levelForStars(this.totalStars + this.series.reward);
    this.seriesLevelUpPending = levelAfter > levelBefore ? levelAfter : null;
    // Lift the HUD (the counter the stars fly into) above the chest scrim so the
    // arrival lands on a bright counter, not a dimmed one. Cleared when the scrim
    // goes (showSeriesWinScreen / clearSeriesUi). The whole HUD moves because it's
    // the stacking-context root — a child's z-index can't escape it.
    this.hudEl?.classList.add('hud--chest-lift');
    // Same lift for the bottom bar so the collections button (the card-drop target)
    // is visible above the scrim and cards tuck into it. Cleared in showSeriesWinScreen.
    this.feedBarEl?.classList.add('feed-bar--chest-lift');

    // The chest flies IN from the slot-row chest icon and scales up to centre; the
    // slot panel fades out as it launches.
    const slotChest = this.seriesRowEl?.querySelector<HTMLElement>('.series-chest');
    const fromRect = slotChest?.getBoundingClientRect() ?? null;
    // Hide the panel's chest INSTANTLY (before the flyer appears) so it reads as the
    // SAME gift lifting off its spot — not a duplicate. The rest of the row fades.
    if (slotChest) slotChest.style.visibility = 'hidden';
    if (this.seriesRowEl) this.seriesRowEl.classList.remove('series-row--in');   // fade the panel
    window.setTimeout(() => this.removeSeriesRow(), 300);

    const scrim = document.createElement('div');
    scrim.className = 'chest-ov';
    scrim.innerHTML =
      '<div class="chest-ov__hint">Tap or hold!</div>' +
      // Same random gift icon as the series-row panel (rewardIconFor(i) is cached per
      // mechanic) — the one that lifts off the panel is the one you tap in the centre.
      `<button type="button" class="chest-ov__chest" aria-label="Open chest"><img class="chest-ov__chest__img" src="${this.rewardIconFor(i)}" alt="" draggable="false"></button>`;
    this.viewport.appendChild(scrim);
    this.chestEl = scrim;
    const chestBtn = scrim.querySelector<HTMLButtonElement>('.chest-ov__chest')!;
    requestAnimationFrame(() => {
      scrim.classList.add('chest-ov--in');
      if (fromRect && chestBtn.animate) {
        const to = chestBtn.getBoundingClientRect();
        const dx = (fromRect.left + fromRect.width / 2) - (to.left + to.width / 2);
        const dy = (fromRect.top + fromRect.height / 2) - (to.top + to.height / 2);
        const s = Math.max(0.12, fromRect.width / to.width);   // start at the slot icon's size
        // Decoupled jump: POSITION on the button, SQUASH/STRETCH on the img (whose
        // transform-origin is the bottom, so squashes keep the gift's base planted).
        // Two clean lines → velocity only jumps at push-off + impact, never mid-flight.
        const img = chestBtn.querySelector<HTMLElement>('.chest-ov__chest__img');
        const JUMP = Math.max(96, Math.min(180, Math.abs(dy) * 0.42));
        const DUR = 940;
        const SQ = 0.28;               // squash depth
        const g1 = s + (1 - s) * 0.45; // partway grown at the launch stretch
        // POSITION — hold on the panel through the push-off, LAUNCH (decelerate to the
        // apex), then FALL (accelerate) into the centre and stop on impact.
        chestBtn.animate([
          { transform: `translate(${dx}px, ${dy}px)`, offset: 0, easing: 'linear' },
          { transform: `translate(${dx}px, ${dy}px)`, offset: 0.15, easing: 'cubic-bezier(0.10,0.68,0.30,1)' },
          { transform: `translate(${dx * 0.32}px, ${-JUMP}px)`, offset: 0.54, easing: 'cubic-bezier(0.52,0.02,0.9,0.38)' },
          { transform: 'translate(0px, 0px)', offset: 0.88, easing: 'linear' },
          { transform: 'translate(0px, 0px)', offset: 1 },
        ], { duration: DUR, fill: 'backwards' });
        // SQUASH — grow s→1 with a push-off squash (short+wide), a launch stretch
        // (tall+thin), then an impact squash on landing → settle to 1:1.
        img?.animate([
          { transform: `scale(${s}, ${s})`, offset: 0, easing: 'cubic-bezier(0.3,0,0.5,1)' },
          { transform: `scale(${s * (1 + SQ * 0.5)}, ${s * (1 - SQ)})`, offset: 0.13, easing: 'cubic-bezier(0.2,0.7,0.3,1)' },
          { transform: `scale(${g1 * (1 - SQ * 0.4)}, ${g1 * (1 + SQ * 0.6)})`, offset: 0.27, easing: 'cubic-bezier(0.35,0,0.6,1)' },
          { transform: 'scale(1, 1)', offset: 0.55, easing: 'cubic-bezier(0.4,0,0.7,0.5)' },
          { transform: 'scale(1.02, 0.99)', offset: 0.85, easing: 'cubic-bezier(0.5,0,0.85,0.4)' },
          { transform: `scale(${1 + SQ * 0.55}, ${1 - SQ * 0.9})`, offset: 0.92, easing: 'cubic-bezier(0.15,0.85,0.3,1)' },
          { transform: 'scale(0.96, 1.05)', offset: 0.97, easing: 'ease-out' },
          { transform: 'scale(1, 1)', offset: 1 },
        ], { duration: DUR, fill: 'backwards' });
      }
    });
    this.startChestSparks(chestBtn);

    // ── Interaction ──────────────────────────────────────────────────────────
    // Tap-and-release (before HOLD_MS): drop ONE item. Press-and-HOLD for HOLD_MS:
    // the gift smoothly grows + trembles, then pops and drops ALL remaining items
    // at once. Release early → the gift settles back and drops one.
    const HOLD_MS = 500;   // hold-to-burst: shorter shake (~half a second is enough)
    const img = chestBtn.querySelector<HTMLElement>('.chest-ov__chest__img');
    let spent = false;
    let charging = false;
    let holdTimer = 0;
    let growAnim: Animation | null = null;
    let shakeAnim: Animation | null = null;

    const haptic = (kind: string) => {
      try { (window as unknown as { Telegram?: { WebApp?: { HapticFeedback?: { impactOccurred: (s: string) => void } } } }).Telegram?.WebApp?.HapticFeedback?.impactOccurred(kind); } catch { /* noop */ }
    };

    // Single launch origin captured from the CURRENT chest position. EVERYTHING —
    // stars, puzzles and collection cards — pops UP out of the gift first, then in a
    // second phase peels off to its own counter (stars → level, puzzles → puzzle
    // counter, cards → collections button).
    const originAt = (frac: number) => {
      const r = chestBtn.getBoundingClientRect();
      const vp = this.viewport.getBoundingClientRect();
      return { x: r.left - vp.left + r.width / 2, y: r.top - vp.top + r.height * frac };
    };

    const dispatch = (item: DropItem, up: { x: number; y: number }) => {
      if (item.type === 'star') this.flyOneStar(up.x, up.y);
      else if (item.type === 'puzzle') {
        this.flyOnePuzzle(up.x, up.y, () => {
          // A fast /results response may already have reconciled the full chest
          // while pieces are still flying. Never credit those arrivals twice.
          if (this.totalPuzzles < puzzleTargetBalance) {
            this.totalPuzzles += 1;
            this.updatePuzzleCounter();
          }
        }, false);
      }
      else this.flyOneCard(up.x, up.y, item.card);
    };

    const spendAndFinish = (winDelay = 760) => {
      if (spent) return;
      spent = true;
      this.persistSeriesReward(i);
      this.stopChestSparks();
      chestBtn.style.pointerEvents = 'none';
      const hint = scrim.querySelector<HTMLElement>('.chest-ov__hint');
      if (hint) hint.style.opacity = '0';
      // Hand off to the REAL win screen after the last items have flown.
      window.setTimeout(() => this.showSeriesWinScreen(i), winDelay);
    };

    // Remove the gift INSTANTLY once it bursts — no shrink/fade. The prizes have
    // already launched from the captured origin, so the gift just vanishes.
    const vanishGift = (_fromScale?: number) => {
      chestBtn.style.visibility = 'hidden';
    };

    // Drop ONE item (tap / early release).
    const dropOne = () => {
      if (spent || !queue.length) return;
      const item = queue.shift()!;
      haptic('medium');
      // Elastic squash→stretch on the img (bottom-pinned) as the item pops out.
      img?.animate([
        { transform: 'scale(1,1)', offset: 0 },
        { transform: 'scale(1.16,0.86)', offset: 0.26 },
        { transform: 'scale(0.9,1.16)', offset: 0.56 },
        { transform: 'scale(1.05,0.96)', offset: 0.8 },
        { transform: 'scale(1,1)', offset: 1 },
      ], { duration: 460, easing: 'cubic-bezier(0.33,1,0.68,1)' });
      this.burstStarConfetti();
      dispatch(item, originAt(0.34));
      if (!queue.length) {
        vanishGift(1);
        spendAndFinish();
      }
    };

    // Hold completed: pop the gift and drop EVERYTHING remaining simultaneously.
    const dropAll = () => {
      if (spent) return;
      charging = false;
      window.clearTimeout(holdTimer);
      if (!queue.length) { vanishGift(1); spendAndFinish(); return; }
      haptic('heavy');
      // Capture the origin BEFORE the gift pops (reads the enlarged rect, which is
      // fine — it's roughly centred).
      const up = originAt(0.34);
      const items = queue.splice(0);
      this.burstStarConfetti();
      growAnim?.cancel();
      shakeAnim?.cancel();
      vanishGift(1.32);
      // Peel the items off ONE AT A TIME (not all at once) so they form three
      // flowing "queue strips" — stars streaming to the level counter, puzzles to
      // the puzzle counter, cards to the collections button. Round-robin across the
      // types so all three strips build together.
      const byType: Record<DropItem['type'], DropItem[]> = { star: [], puzzle: [], card: [] };
      items.forEach((it) => byType[it.type].push(it));
      const sequence: DropItem[] = [];
      for (let more = true; more; ) {
        more = false;
        (['star', 'puzzle', 'card'] as DropItem['type'][]).forEach((t) => {
          const next = byType[t].shift();
          if (next) { sequence.push(next); more = true; }
        });
      }
      const STAGGER_MS = 85;
      sequence.forEach((item, idx) => window.setTimeout(() => { dispatch(item, up); haptic('light'); }, idx * STAGGER_MS));
      spendAndFinish((sequence.length - 1) * STAGGER_MS + 760);
    };

    const startCharge = () => {
      if (spent || charging || !queue.length) return;
      charging = true;
      if (chestBtn.animate) {
        growAnim = chestBtn.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.32)' }],
          { duration: HOLD_MS, easing: 'cubic-bezier(0.42,0.06,0.5,1)', fill: 'forwards' },
        );
        // Tremble on the img — a fast alternating jitter whose amplitude ramps up
        // toward the release point (reads as the gift straining to burst).
        const shakeKf: Keyframe[] = [];
        const STEPS = 34;
        for (let k = 0; k <= STEPS; k++) {
          const t = k / STEPS;
          const amp = t * t;                       // ramps up, gentle at first
          const dir = k % 2 === 0 ? 1 : -1;
          shakeKf.push({ transform: `translateX(${dir * amp * 3.2}px) rotate(${dir * amp * 3.4}deg)`, offset: t });
        }
        shakeAnim = img?.animate(shakeKf, { duration: HOLD_MS, easing: 'linear', fill: 'forwards' }) ?? null;
      }
      holdTimer = window.setTimeout(dropAll, HOLD_MS);
    };

    const endCharge = () => {
      if (!charging) return;
      charging = false;
      window.clearTimeout(holdTimer);
      // Smoothly settle the gift back to rest from wherever the grow/shake reached,
      // then drop a single item.
      const cur = getComputedStyle(chestBtn).transform;
      growAnim?.cancel();
      shakeAnim?.cancel();
      if (chestBtn.animate && cur && cur !== 'none') {
        chestBtn.animate(
          [{ transform: cur }, { transform: 'none' }],
          { duration: 200, easing: 'cubic-bezier(0.34,1.5,0.5,1)', fill: 'none' },
        );
      }
      dropOne();
    };

    chestBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      if (spent) return;
      try { chestBtn.setPointerCapture(e.pointerId); } catch { /* noop */ }
      startCharge();
    });
    const release = (e: Event) => { e.stopPropagation(); endCharge(); };
    chestBtn.addEventListener('pointerup', release);
    chestBtn.addEventListener('pointercancel', release);
  }

  private startChestSparks(anchor: HTMLElement): void {
    this.stopChestSparks();
    const emit = (count: number) => {
      if (!anchor.isConnected) { this.stopChestSparks(); return; }
      const r = anchor.getBoundingClientRect();
      const vp = this.viewport.getBoundingClientRect();
      const cx = r.left - vp.left + r.width / 2;
      const cy = r.top - vp.top + r.height * 0.72;   // from UNDER the chest
      for (let n = 0; n < count; n++) this.spawnChestSpark(cx, cy, r.width);
    };
    emit(14);
    this.chestSparkTimer = window.setInterval(() => emit(2 + Math.floor(Math.random() * 3)), 260);
  }

  private stopChestSparks(): void {
    if (this.chestSparkTimer) window.clearInterval(this.chestSparkTimer);
    this.chestSparkTimer = null;
  }

  private spawnChestSpark(cx: number, cy: number, size: number): void {
    const spark = document.createElement('div');
    spark.className = 'reward__spark';
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.7;
    const radius = size * (0.14 + Math.random() * 0.2);
    const x = cx + Math.cos(angle) * radius, y = cy + Math.sin(angle) * radius;
    const px = 7 + Math.random() * 8;
    const dist = 46 + Math.random() * 64;
    const dx = Math.cos(angle) * dist + (Math.random() - 0.5) * 24;
    const dy = Math.sin(angle) * dist - 16 - Math.random() * 26;
    spark.style.cssText = `left:${x}px;top:${y}px;width:${px}px;height:${px}px;z-index:2710;`;
    const r = Math.random();
    spark.style.background = r < 0.5 ? '#ffe27a' : (r < 0.8 ? '#ffac3a' : '#fff6d4');
    this.viewport.appendChild(spark);
    const duration = 520 + Math.random() * 360;
    if (!spark.animate) { window.setTimeout(() => spark.remove(), duration); return; }
    spark.animate([
      { transform: 'translate(-50%, -50%) scale(0.45)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0.95, offset: 0.18 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.18)`, opacity: 0 },
    ], { duration, easing: 'cubic-bezier(0.14,0.72,0.28,1)', fill: 'forwards' })
      .addEventListener('finish', () => spark.remove(), { once: true });
  }

  // A single gold ★ star unit — identical art to the reward row (buildRewardStarRow).
  private makeStarUnit(px: number): HTMLElement {
    const u = document.createElement('img');
    u.className = 'reward__star-unit';
    u.src = STAR_GOLDEN;
    u.draggable = false;
    u.alt = '';
    u.style.cssText =
      `display:block;width:${px}px;height:${px}px;object-fit:contain;` +
      'transform-origin:50% 100%;will-change:transform;' +
      'filter:drop-shadow(0 8px 16px rgba(255,147,42,0.42));';
    return u;
  }

  private startStarFlightTrail(cx: number, cy: number, toX: number, landY: number, jump: number): void {
    const start = performance.now();
    const dur = REWARD_SHOT_MS;
    const emit = () => {
      const age = performance.now() - start;
      const t = Math.max(0, Math.min(1, age / dur));
      let x = 0, y = 0;
      if (t < 0.32) {
        const q = t / 0.32;
        const e = 1 - Math.pow(1 - q, 3);
        y = -jump * e;
      } else {
        const q = (t - 0.32) / 0.68;
        const e = q * q;
        x = toX * e;
        y = -jump + (landY + jump) * e;
      }
      this.spawnStarTrailParticle(cx + x, cy + y);
      if (age < dur - 80) window.setTimeout(emit, 38 + Math.random() * 18);
    };
    emit();
  }

  private spawnStarTrailParticle(x: number, y: number): void {
    const p = document.createElement('i');
    p.className = 'star-trail';
    const size = 5 + Math.random() * 5;
    p.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;`;
    this.viewport.appendChild(p);
    const ang = Math.random() * Math.PI * 2;
    const dist = 16 + Math.random() * 30;
    const dx = Math.cos(ang) * dist;
    const dy = Math.sin(ang) * dist;
    const dur = 260 + Math.random() * 220;
    if (!p.animate) { window.setTimeout(() => p.remove(), dur); return; }
    p.animate([
      { transform: 'translate(-50%, -50%) scale(0.45)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 0.95, offset: 0.16 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.18)`, opacity: 0 },
    ], { duration: dur, easing: 'cubic-bezier(0.18,0.72,0.24,1)', fill: 'forwards' })
      .addEventListener('finish', () => p.remove(), { once: true });
  }

  // Pop one ★ from (cx,cy) to the HUD counter using the SAME 2-phase motion as the
  // old reward collect: squash → jump → accelerate into the counter (no fade), then
  // impact splash (burstRewardCollectParticles) + badge bump + ring step + credit.
  private flyOneStar(cx: number, cy: number): void {
    const vp = this.viewport.getBoundingClientRect();
    const badge = this.levelBadgeEl?.getBoundingClientRect();
    const badgeX = badge ? badge.left - vp.left + badge.width / 2 : 40;
    const badgeY = badge ? badge.top - vp.top + badge.height / 2 : 40;
    const badgeRadius = badge ? Math.min(badge.width, badge.height) / 2 : 28;
    const px = 54;
    // Decoupled: POSITION on the wrapper, SCALE on the ★ inside — so the grow/return
    // never fights the flight path (that fighting was the jerk).
    const unit = this.makeStarUnit(px);       // inner = the scaler
    unit.style.transformOrigin = '50% 50%';   // grow from centre for the pop
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:absolute;left:${cx - px / 2}px;top:${cy - px / 2}px;` +
      'margin:0;z-index:2720;pointer-events:none;will-change:transform;';
    wrap.appendChild(unit);
    this.viewport.appendChild(wrap);

    const toX = badgeX - cx;
    const toY = badgeY - cy;
    // Scatter the pop-out point: each star bursts to a DIFFERENT apex — a random
    // horizontal spread + a higher, varied pop height (the fixed pop read too low).
    const popH = px * (2.05 + Math.random() * 0.9);               // ~2.05–2.95 × px — longer first-phase rise from the gift
    const apexX = toX * 0.1 + (Math.random() - 0.5) * px * 2.2;   // horizontal scatter (± ~1.1 × px)
    const grow = 1.5;        // peak size mid-pop, then back to 100% by the counter
    this.startStarFlightTrail(cx, cy, toX, toY, popH);
    let done = false;
    const land = () => {
      if (done) return; done = true;
      wrap.remove();
      this.burstRewardCollectParticles(badgeX, badgeY, Math.max(22, badgeRadius - 2));   // splash (KEEP)
      this.bumpLevelBadge();
      this.totalStars += 1;
      this.updateHud(false);
      const lvl = this.levelForStars(this.totalStars);
      this.setLevelProgress(this.starsIntoLevel(this.totalStars) / this.starsForLevel(lvl), true, RING_STEP_MS);
    };
    if (!wrap.animate) {
      wrap.style.transform = `translate3d(${toX}px,${toY}px,0)`;
      window.setTimeout(land, REWARD_SHOT_MS);
      return;
    }
    // POSITION — pop up out of the gift (decelerate), then arc into the counter
    // (accelerate). Smooth across the top; velocity is continuous.
    wrap.animate([
      { transform: 'translate3d(0,0,0)', offset: 0, easing: 'cubic-bezier(0.15,0.72,0.3,1)' },
      { transform: `translate3d(${apexX}px,${-popH}px,0)`, offset: 0.34, easing: 'cubic-bezier(0.5,0.02,0.78,0.5)' },
      { transform: `translate3d(${toX}px,${toY}px,0)`, offset: 1 },
    ], { duration: REWARD_SHOT_MS, fill: 'forwards' });
    // SCALE — 1 → peak (grow, decelerating) → back to 100% by the top of the pop,
    // then hold 100% all the way into the counter so it lands at full weight.
    const flight = unit.animate([
      { transform: 'scale(0.32)', offset: 0, easing: 'cubic-bezier(0.12,0.7,0.3,1)' },   // pops out SMALL
      { transform: `scale(${grow})`, offset: 0.34, easing: 'cubic-bezier(0.5,0,0.6,1)' }, // grows to the peak (decelerating)
      { transform: 'scale(1)', offset: 0.56, easing: 'linear' },                          // back to 100% by the top of the pop
      { transform: 'scale(1)', offset: 1 },
    ], { duration: REWARD_SHOT_MS, fill: 'forwards' });
    const impactTimer = window.setTimeout(land, Math.max(0, REWARD_SHOT_MS - 8));
    flight.addEventListener('finish', () => {
      window.clearTimeout(impactTimer);
      land();
    }, { once: true });
  }

  // Pop one puzzle piece from (cx,cy) UP-RIGHT into the puzzle counter — the same
  // pop→arc→shrink motion as flyOneStar, just aimed at the top-right badge.
  private flyOnePuzzle(cx: number, cy: number, onLand?: () => void, credit = true, z = 2720): void {
    const vp = this.viewport.getBoundingClientRect();
    const badge = this.puzzleBadgeEl?.getBoundingClientRect();
    const badgeX = badge ? badge.left - vp.left + badge.width / 2 : vp.width - 40;
    const badgeY = badge ? badge.top - vp.top + badge.height / 2 : 40;
    const px = 58;   // comparable to / slightly larger than the star (54); the puzzle art has more transparent padding
    const unit = document.createElement('img');
    unit.src = PUZZLE_ICON;
    unit.draggable = false;
    unit.alt = '';
    unit.style.cssText =
      `display:block;width:${px}px;height:${px}px;object-fit:contain;` +
      'transform-origin:50% 50%;will-change:transform;' +
      'filter:drop-shadow(0 8px 16px rgba(140,90,220,0.45));';
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:absolute;left:${cx - px / 2}px;top:${cy - px / 2}px;` +
      `margin:0;z-index:${z};pointer-events:none;will-change:transform;`;
    wrap.appendChild(unit);
    this.viewport.appendChild(wrap);

    const toX = badgeX - cx;
    const toY = badgeY - cy;
    const popH = px * (1.9 + Math.random() * 0.9);
    const apexX = toX * 0.12 + (Math.random() - 0.5) * px * 2.0;
    const grow = 1.4;
    let done = false;
    const land = () => {
      if (done) return; done = true;
      wrap.remove();
      this.burstRewardCollectParticles(badgeX, badgeY, 20);
      if (credit) {
        this.totalPuzzles += 1;
        this.updatePuzzleCounter();
      }
      onLand?.();
      this.bumpPuzzleBadge();
    };
    if (!wrap.animate) {
      wrap.style.transform = `translate3d(${toX}px,${toY}px,0)`;
      window.setTimeout(land, REWARD_SHOT_MS);
      return;
    }
    wrap.animate([
      { transform: 'translate3d(0,0,0)', offset: 0, easing: 'cubic-bezier(0.15,0.72,0.3,1)' },
      { transform: `translate3d(${apexX}px,${-popH}px,0)`, offset: 0.34, easing: 'cubic-bezier(0.5,0.02,0.78,0.5)' },
      { transform: `translate3d(${toX}px,${toY}px,0)`, offset: 1 },
    ], { duration: REWARD_SHOT_MS, fill: 'forwards' });
    const flight = unit.animate([
      { transform: 'scale(0.32)', offset: 0, easing: 'cubic-bezier(0.12,0.7,0.3,1)' },
      { transform: `scale(${grow})`, offset: 0.34, easing: 'cubic-bezier(0.5,0,0.6,1)' },
      { transform: 'scale(1)', offset: 0.56, easing: 'linear' },
      { transform: 'scale(0.9)', offset: 1 },
    ], { duration: REWARD_SHOT_MS, fill: 'forwards' });
    const impactTimer = window.setTimeout(land, Math.max(0, REWARD_SHOT_MS - 8));
    flight.addEventListener('finish', () => { window.clearTimeout(impactTimer); land(); }, { once: true });
  }

  // ── "Someone played your mechanic" — global activity sim ─────────────────────
  // Dev-only presentation demo. Runs on every local tab, independent of
  // the island overlay. Each tick simulates a visit (plays/likes), slides a notifier
  // above the top panel. Production never starts this loop; real island plays
  // and likes are counted by the backend visit API.
  private startIslandActivity(): void {
    const buildings = (): SimBuildingRef[] =>
      loadIslandState().buildings.map((b) => ({ slot: b.slot, name: b.name }));
    const tick = () => {
      const ev = simulateActivity(buildings());
      if (ev) {
        this.showActivityNotifier(
          ev.visitors > 1
            ? `${ev.who} и ещё ${ev.visitors - 1} играли в «${ev.name}»`
            : `${ev.who} играл в «${ev.name}»`,
        );
        window.dispatchEvent(new CustomEvent(ISLAND_SIM_EVENT));
      }
      window.setTimeout(tick, 6000 + Math.random() * 5000);   // ~6–11s
    };
    window.setTimeout(tick, 3400 + Math.random() * 2200);     // first soon after boot
  }

  private showActivityNotifier(text: string): void {
    let el = this.activityNotifierEl;
    if (!el) {
      el = document.createElement('div');
      el.className = 'activity-toast';
      this.viewport.appendChild(el);
      this.activityNotifierEl = el;
    }
    el.textContent = text;
    // restart the slide-in + auto-hide
    el.classList.remove('activity-toast--show');
    void el.offsetWidth;   // reflow so the animation replays
    el.classList.add('activity-toast--show');
    if (this.activityNotifierTimer != null) window.clearTimeout(this.activityNotifierTimer);
    this.activityNotifierTimer = window.setTimeout(
      () => el?.classList.remove('activity-toast--show'),
      Math.min(6000, Math.max(3000, text.length * 55)),
    );
  }

  // Collect puzzles piled over a mechanic on the island: fan `n` pucks out of the
  // tapped point (scatter), each arcing into the ONE HUD counter. Rendered above the
  // island overlay (z 3200) so they read over the mechanic, not behind it.
  private addPuzzlesFromMeta(n: number, from?: { x: number; y: number }): void {
    const vp = this.viewport.getBoundingClientRect();
    const cx = from ? from.x - vp.left : vp.width / 2;
    const cy = from ? from.y - vp.top : vp.height / 2;
    const count = Math.max(1, Math.min(9, Math.round(n)));
    for (let k = 0; k < count; k++) {
      const jx = (Math.random() - 0.5) * 30;
      const jy = (Math.random() - 0.5) * 22;
      window.setTimeout(() => this.flyOnePuzzle(cx + jx, cy + jy, undefined, true, 3200), k * 85);
    }
  }

  // Drop one collection card. Like stars/puzzles it pops UP OUT of the gift first
  // (phase 1, above the gift), then in phase 2 arcs DOWN into the collections button
  // on the bar, shrinking as it tucks in. Rendered above the gift/scrim (z 2720).
  private flyOneCard(cx: number, cy: number, card: CollectionCard): void {
    const vp = this.viewport.getBoundingClientRect();
    const target = this.collectionsBtnEl?.getBoundingClientRect();
    const toCX = target ? target.left - vp.left + target.width / 2 : 60;
    const toCY = target ? target.top - vp.top + target.height / 2 : vp.height - 30;
    const w = 84;
    const cardEl = makeCollectionCard(card, w);
    const wrap = document.createElement('div');
    // Above the gift (z 2, in the scrim at 2700) AND the lifted bar (2706), so it
    // flies over the gift and lands visibly on the collections icon.
    wrap.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;z-index:2720;` +
      'margin:0;pointer-events:none;will-change:transform;transform:translate(-50%,-50%);';
    cardEl.style.transformOrigin = '50% 50%';
    wrap.appendChild(cardEl);
    this.viewport.appendChild(wrap);

    const toX = toCX - cx;
    const toY = toCY - cy;
    // Phase 1: pop UP to an apex above the gift (like stars/puzzles), scattered.
    // The card is much bigger than a star/puzzle, so it gets a HIGHER apex and a
    // LONGER launch phase (apex at offset 0.44, not 0.34) — it reads slower, so it
    // wants more air time flying out over the gift before arcing into the bar.
    const popH = w * (2.15 + Math.random() * 0.75);
    const apexX = toX * 0.12 + (Math.random() - 0.5) * w * 1.6;
    const APEX = 0.44;
    let done = false;
    const land = () => {
      if (done) return; done = true;
      wrap.remove();
      // The chest drop is presentation-only for this iteration. Collection
      // progress changes only through the dedicated persisted state, never from
      // this random animation (which may also contain duplicates).
      this.bumpCollectionsBtn();
    };
    const DUR = REWARD_SHOT_MS + 170;
    if (!wrap.animate) {
      wrap.style.transform = `translate(-50%,-50%) translate3d(${toX}px,${toY}px,0)`;
      window.setTimeout(land, DUR);
      return;
    }
    // POSITION — rise to the apex (decelerate), then arc DOWN into the button (accelerate).
    wrap.animate([
      { transform: 'translate(-50%,-50%) translate3d(0,0,0)', offset: 0, easing: 'cubic-bezier(0.15,0.72,0.3,1)' },
      { transform: `translate(-50%,-50%) translate3d(${apexX}px,${-popH}px,0)`, offset: APEX, easing: 'cubic-bezier(0.5,0.02,0.78,0.5)' },
      { transform: `translate(-50%,-50%) translate3d(${toX}px,${toY}px,0)`, offset: 1 },
    ], { duration: DUR, fill: 'forwards' });
    // SCALE — pop small→full during the rise, then shrink as it tucks into the bar.
    const flight = cardEl.animate([
      { transform: 'scale(0.34) rotate(-6deg)', offset: 0, easing: 'cubic-bezier(0.12,0.7,0.3,1)' },
      { transform: 'scale(1) rotate(0deg)', offset: APEX, easing: 'cubic-bezier(0.5,0,0.6,1)' },
      { transform: 'scale(0.92) rotate(0deg)', offset: 0.78, easing: 'linear' },
      { transform: 'scale(0.32) rotate(4deg)', offset: 1 },
    ], { duration: DUR, fill: 'forwards' });
    const impactTimer = window.setTimeout(land, Math.max(0, DUR - 8));
    flight.addEventListener('finish', () => { window.clearTimeout(impactTimer); land(); }, { once: true });
  }

  private persistSeriesReward(i: number): void {
    const series = this.series;
    const reward = series?.reward ?? 0;
    const mechanicId = this.playables[i]?.id;
    if (series && reward > 0 && mechanicId) {
      const catalog = series.catalog;
      if (catalog && series.catalogChestQueued) return;
      void queueResult({
        mechanic_id: catalog?.bundle?.runtime.playableId ?? mechanicId,
        variant_id: series.ticket.variant_id,
        run_id: series.payoutRunId, metric_key: 'series', metric_value: this.seriesLen(), stars: reward,
        expected_puzzles: series.puzzles,
        run_ticket: series.ticket,
        series_id: catalog?.bundle?.seriesId,
        tz_offset_minutes: currentTzOffsetMinutes(),
      });
      this.bumpDailyProgress('stars_50', reward);
    }
  }

  private queueCatalogChestResult(i: number): Promise<boolean> {
    const series = this.series;
    const catalog = series?.index === i ? series.catalog : null;
    if (!series || !catalog?.bundle || !catalog.ticketRequest) return Promise.resolve(false);
    if (series.catalogChestQueued) return Promise.resolve(false);
    series.catalogChestQueued = true;
    return queueResultWithReceipt({
      mechanic_id: catalog.bundle.runtime.playableId,
      variant_id: catalog.ticketRequest.variant_id,
      run_id: series.payoutRunId,
      metric_key: 'series',
      metric_value: this.seriesLen(),
      stars: series.reward,
      expected_puzzles: series.puzzles,
      run_ticket: catalog.ticketRequest,
      series_id: catalog.bundle.seriesId,
      ...(catalog.bundle.schema === 'catalog.ticket-level-spec-bundle.v2'
        ? { schema: 'catalog.result.v2' as const }
        : {}),
      tz_offset_minutes: currentTzOffsetMinutes(),
    }).then((receipt) => {
      if (receipt.status === 'confirmed'
        && catalogResultAllowsProgress(receipt, series.payoutRunId)) return true;
      // Terminal rejection is normally handled synchronously by the shared
      // listener. Storage failure has no server edge, so close it here too.
      if (this.catalogSlotIsCurrent(catalog)) {
        this.activateCatalogBuiltinFallback(
          catalog,
          receipt.status === 'storage_error'
            ? 'catalog_chest_storage_error'
            : receipt.status === 'rejected'
              ? `catalog_chest_rejected_${receipt.code ?? receipt.httpStatus}`
              : 'catalog_chest_receipt_mismatch',
          true,
        );
      }
      return false;
    });
  }

  // After the chest empties: show the REAL win screen — the same reward overlay a
  // normal win uses (Replay / Like / Post / Edit buttons + toast + the reward swipe),
  // just with NO star row to collect (the stars already flew from the chest). This
  // restores the original look AND the tap-OR-swipe advance. The series is cleared
  // when the player leaves (markUnitShown / ×).
  private showSeriesWinScreen(i: number): void {
    // Fade the chest overlay out.
    this.hudEl?.classList.remove('hud--chest-lift');   // scrim gone → drop the HUD lift
    this.feedBarEl?.classList.remove('feed-bar--chest-lift');
    this.stopChestSparks();
    const chest = this.chestEl;
    if (chest) {
      this.chestEl = null;
      chest.classList.remove('chest-ov--in');
      chest.addEventListener('transitionend', () => chest.remove(), { once: true });
      window.setTimeout(() => chest.remove(), 400);
    }
    const state = this.stateEls[i];
    if (!state) { this.clearSeriesUi(); this.series = null; this.advanceToNext(); return; }
    if (this.series) this.series.playing = false;   // unblock the feed swipe
    this.seriesWinShown.add(i);                      // guard updateMechanicState from wiping it
    this.earnedThisCycle.add(i);
    this.claimedStarRewards.add(i);
    this.pendingStarRewards.delete(i);               // nothing left to collect
    // Render the real win overlay directly (no star-row center), mark it earned so
    // the existing reward swipe (attachRewardSwipe → onUp) engages.
    state.replaceChildren();
    this.renderResultState(i, state, null);

    const reward = state.querySelector('.reward');
    const actions = reward?.querySelector('.reward__actions') ?? null;
    const toast = reward?.querySelector('.reward__toast') ?? null;
    const mechanicId = this.playables[i]?.id ?? '';

    // Result readout above the buttons (for now: the last level's solve time).
    if (reward && this.lastSolveMs > 0) {
      const res = document.createElement('div');
      res.className = 'reward__result';
      res.textContent = `Время: ${(this.lastSolveMs / 1000).toFixed(1)}s`;
      reward.insertBefore(res, actions);
    }
    // Restore the "tap or swipe for next game" hint (same as a normal win screen).
    if (reward) {
      const hint = document.createElement('div');
      hint.className = 'reward__hint';
      hint.innerHTML =
        '<span class="reward__swipe-cue" aria-hidden="true">⌃</span>' +
        '<span class="reward__hint-text">tap or swipe for next game</span>';
      reward.insertBefore(hint, toast);
    }

    state.classList.add('game__state--earned');
    state.classList.remove('game__state--failed');
    state.hidden = false;
    this.games[i]?.classList.add('game--earned');

    // Challenge CTA as a standalone bottom-center pill (NOT an in-row reward
    // action) — same style/placement as the post-win pill, so it reads as a
    // distinct call-to-action. Persistent while the win screen is up; cleared
    // when the player leaves the unit (markUnitShown → dismissChallengePill).
    const lastRunId = this.series?.lastRunId;
    if (lastRunId && !this.series?.catalog) {
      this.showChallengePill(mechanicId, this.lastSolveMs || 5000, lastRunId, true);
    }
  }

  // × (or any exit) mid-series: break it, no reward.
  private breakSeries(): void {
    if (!this.series) return;
    track('series_abandon', { mechanic_id: this.playables[this.series.index]?.id, done: this.series.done });
    this.seriesWinShown.delete(this.series.index);
    this.clearSeriesUi();
    this.series = null;
  }

  private clearSeriesUi(): void {
    this.seriesLevelUpPending = null;
    this.pulsePendingSlot = -1;
    this.dismissChallengePill();
    this.hudEl?.classList.remove('hud--chest-lift');
    this.feedBarEl?.classList.remove('feed-bar--chest-lift');
    // Restore normal arrival-poster behaviour (a future feed arrival at this unit
    // should show its cover again).
    this.feedEl?.querySelectorAll('.game--series-reload').forEach((el) => el.classList.remove('game--series-reload'));
    this.stopChestSparks();
    this.hideSeriesTransition();
    this.removeSeriesRow();
    const chest = this.chestEl;
    if (chest) {
      this.chestEl = null;
      chest.classList.remove('chest-ov--in');
      chest.addEventListener('transitionend', () => chest.remove(), { once: true });
      window.setTimeout(() => chest.remove(), 400);
    }
  }

  // Per-mechanic series param variation (ranges from the design). Returns a params
  // object to hand the mechanic on relaunch, or null = no variation (replay the
  // same level). Mechanic-side consumption of `params` is a per-playable follow-up;
  // until then every mechanic replays identically (safe).
  private seriesParamsFor(mechanicId: string, level: number): Record<string, unknown> | null {
    const base = mechanicId.replace(/-swipe$/, '');
    // Monotonic ramp across the series: level 1 → lo … last level → hi. Makes the
    // difference between levels obvious (vs. random, which can look the same).
    const len = this.seriesLenFor(mechanicId);
    const L = Math.max(1, Math.min(level, len));
    const ramp = (lo: number, hi: number) => Math.round(lo + (hi - lo) * (L - 1) / Math.max(1, len - 1));
    switch (base) {
      case 'merge-locked-v1':
        // orders ramp 1→5; item level nudges up with the series.
        return { orders: ramp(1, 5), itemLevelDelta: ramp(0, 1) };
      case 'marble-sort':
        // rectangles under the conveyor ramp 4→16 (levels 1-5: 4,7,10,13,16).
        return { rects: ramp(4, 16) };
      case 'merge-timepress-v1':
      case 'merge-timepress-v2':
        // orders ramp 3→6; difficulty nudges up. Generator item count sized to the
        // orders (mechanic-side).
        return { orders: ramp(3, 6), itemLevelDelta: ramp(0, 1) };
      default:
        // pins-v1, merge-timepress-no-orders-v1/v2, merge-second-board-v1/v2:
        // no variation yet (duplicate the level).
        return null;
    }
  }

  // The on-screen unit changed (a swipe settled, or the first unit revealed).
  // Emits swipe_away for the unit we're leaving, then unit_shown for the new one.
  // unit_shown fires ONLY here (a REVEALED, on-screen unit) — never for a warmed
  // off-screen frame — so it stays an honest denominator (D3).
  private markUnitShown(cur: number): void {
    if (!this.feedActuallyVisible(cur)) return;
    if (cur === this.shownIndex || cur < 0) return;
    const prev = this.shownIndex;
    if (prev >= 0) {
      const state = this.earnedThisCycle.has(prev) ? 'won'
        : this.failedThisCycle.has(prev) ? 'lost'
        : this.manualRuns.has(prev) ? 'playing' : 'autoplay';
      track('swipe_away', {
        mechanic_id: this.effectivePlayableId(prev),
        played: this.manualRuns.has(prev),
        state,
        ms_since_shown: Math.round(performance.now() - this.shownAt),
      });
      this.retireGeneratedSlot(prev);
    }
    this.dismissChallengePill();
    // Left the series' mechanic (swiped to another unit) → tear the series down.
    if (this.series && cur !== this.series.index) { this.seriesWinShown.delete(this.series.index); this.clearSeriesUi(); this.series = null; }
    this.shownIndex = cur;
    this.shownAt = performance.now();
    this.firstInputLogged = false;
    const id = this.playables[cur]?.id;
    if (id) this.revealControlPlaneExposure(cur, id);
    track('unit_shown', {
      mechanic_id: this.effectivePlayableId(cur),
      variant_id: this.effectiveVariantId(cur),
      feed_pos: cur,
      mode: this.manualRuns.has(cur) ? 'playing' : 'auto',
    });
    // Refresh the series indicator for the newly-shown unit. Defer it a couple
    // of frames so the iframe's first autoplay frame does not share a frame with
    // host-side DOM rebuild + panel entrance.
    this.renderSeriesRowAfterReveal(cur);
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
  private perfWindowStartedAt = performance.now();
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
    const first5 = this.longTaskLog.filter((t) => t.at >= this.perfWindowStartedAt && t.at <= this.perfWindowStartedAt + 5000);
    const first5Sorted = first5.map((t) => t.dur).sort((a, b) => a - b);
    const first5P95 = first5Sorted.length ? first5Sorted[Math.min(first5Sorted.length - 1, Math.ceil(first5Sorted.length * 0.95) - 1)] : 0;
    const first5Tbt = first5.reduce((sum, task) => sum + Math.max(0, task.dur - 50), 0);
    const lines: string[] = [
      `[perf] ${new Date().toISOString()}`,
      navigator.userAgent,
      this.longTaskSupported
        ? `long>50ms: ${this.longTaskLog.length} | during warm: ${warmTasks.length} | worst warm: ${worst}ms`
        : `frame-gaps≥100ms (rAF fallback, no Long Tasks API): ${this.longTaskLog.length} | during warm: ${warmTasks.length} | worst warm: ${worst}ms`,
      `first 5s: samples=${first5.length} p95=${first5P95}ms TBT=${first5Tbt}ms`,
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
    const first5 = this.longTaskLog.filter((t) => t.at >= this.perfWindowStartedAt && t.at <= this.perfWindowStartedAt + 5000);
    const first5Sorted = first5.map((t) => t.dur).sort((a, b) => a - b);
    const first5P95 = first5Sorted.length ? first5Sorted[Math.min(first5Sorted.length - 1, Math.ceil(first5Sorted.length * 0.95) - 1)] : 0;
    const first5Tbt = first5.reduce((sum, task) => sum + Math.max(0, task.dur - 50), 0);
    const lines: string[] = [
      this.longTaskSupported
        ? `long>50ms: ${this.longTaskLog.length} | during warm: ${warmTasks.length} | worst warm: ${worst}ms`
        : `gaps≥100ms: ${this.longTaskLog.length} | warm: ${warmTasks.length} | worst: ${worst}ms (rAF)`,
      `first5 p95:${first5P95}ms tbt:${first5Tbt}ms n:${first5.length}`,
    ];
    for (const [id, t] of this.bootTimingsLog) {
      const net = typeof t.responseEndAt === 'number' ? t.responseEndAt : '?';
      lines.push(`${id}: net→${net} eval→${t.evalDoneAt ?? '?'} mount ${t.mountMs ?? '?'}ms inter ${t.onInteractiveMs ?? '—'}ms`);
    }
    if (this.perfOverlayTextEl) this.perfOverlayTextEl.textContent = lines.slice(0, 14).join('\n');
  }


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
      // src is set lazily by ensureCover() — see ensureNearCovers().
      this.posterEls[i] = poster;
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

      // Host-owned provenance: visible on the baked arrival preview and on
      // autoplay regardless of what the mechanic runtime renders.
      const generatedBadge = document.createElement('div');
      generatedBadge.className = 'game__generated-badge';
      generatedBadge.setAttribute('aria-label', 'Generated catalog level');
      generatedBadge.innerHTML = '<span aria-hidden="true">✦</span> GENERATED';
      game.appendChild(generatedBadge);

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
        '<span class="game__reel-rec"><span class="game__reel-play">▶</span></span>';
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
    // Four fixed sections, left→right: Daily tasks · Meta · Mechanics feed ·
    // Collections. Tapping one makes it active (a soft pill slides under it).
    // "Лента механик" is the default view. Collections opens its own full-screen
    // catalog and remains the visual card-drop target from the chest. Paging is
    // via swipe (attachSwipeSurface below); these buttons don't page.
    type BarTab = { name: string; label: string; svg: string; onTap: () => void };
    const TABS: BarTab[] = [
      {
        name: 'daily', label: 'Ежедневные задания',
        svg: '<circle cx="12" cy="12" r="8"/>',
        onTap: () => this.showDailyPanel(),
      },
      {
        name: 'meta', label: 'Мета',
        svg: '<rect x="4.5" y="4.5" width="15" height="15" rx="2.5"/>',
        // The island-world meta experiment. The other meta prototype (openMetaWorld)
        // stays reachable via ?metaworld=1 for testing.
        // Open the opaque view FIRST (it pauses + covers the feed), THEN hide daily —
        // so the feed mechanic never resumes or shows during the daily→meta swap.
        onTap: () => { if (new URLSearchParams(location.search).has('metaworld')) this.openMetaWorld(); else this.openIslandWorld(); this.hideDailyPanel(); },
      },
      {
        name: 'feed', label: 'Лента механик',
        svg: '<path d="M12 3.5 L20.5 19 L3.5 19 Z"/>',
        onTap: () => { this.hideDailyPanel(); },
      },
      {
        name: 'collections', label: 'Коллекции',
        svg: '<path d="M12 3 L21 12 L12 21 L3 12 Z"/>',
        onTap: () => { this.openCollections(); this.hideDailyPanel(); },
      },
    ];
    const DEFAULT_TAB = 'feed';
    const switcher = document.createElement('div');
    switcher.className = 'feed-bar__switch';
    switcher.setAttribute('role', 'tablist');
    TABS.forEach((tab) => {
      const icon = document.createElement('button');
      icon.type = 'button';
      icon.className = 'feed-bar__icon' + (tab.name === DEFAULT_TAB ? ' feed-bar__icon--active' : '');
      icon.setAttribute('aria-label', tab.label);
      icon.dataset.barTab = tab.name;
      icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${tab.svg}</svg>`;
      if (tab.name === 'daily') {
        const alert = document.createElement('span');
        alert.className = 'feed-bar__daily-alert';
        alert.textContent = '!';
        alert.hidden = true;
        alert.setAttribute('aria-hidden', 'true');
        icon.appendChild(alert);
        this.dailyNavBtnEl = icon;
        this.dailyNavAlertEl = alert;
        this.updateDailyNavAlert();
      }
      if (tab.name === 'collections') {
        this.collectionsBtnEl = icon;
      }
      icon.addEventListener('pointerdown', (e) => e.stopPropagation());
      icon.addEventListener('click', (e) => {
        e.stopPropagation();
        // Bottom nav stays available on the meta: re-tapping the open meta is a
        // no-op; tapping any other tab closes the current overlay first, then opens.
        if (tab.name === 'meta' && this.overlayEl?.classList.contains('island-world')) return;
        if (this.overlayOpen) this.closeOverlay();
        switcher.querySelectorAll('.feed-bar__icon--active').forEach((el) => el.classList.remove('feed-bar__icon--active'));
        icon.classList.add('feed-bar__icon--active');
        tab.onTap();
      });
      switcher.appendChild(icon);
    });
    // Keep QA controls out of the normal production UI. A tester can still open
    // them explicitly via ?diag=1 or the Telegram start_param=diag allowlisted by
    // the backend; local Vite development shows the button automatically.
    const showDebug = Boolean((import.meta as any).env?.DEV)
      || new URLSearchParams(location.search).has('diag')
      || getStartParam() === 'diag';
    if (showDebug) {
      const dbg = document.createElement('button');
      dbg.type = 'button';
      dbg.className = 'feed-bar__icon';
      dbg.setAttribute('aria-label', 'Debug');
      dbg.textContent = '🐞';
      dbg.style.fontSize = '17px';
      dbg.style.opacity = '0.65';
      dbg.addEventListener('pointerdown', (e) => e.stopPropagation());
      dbg.addEventListener('click', (e) => { e.stopPropagation(); void import('./debug').then((m) => m.mountDebugPanel()); });
      switcher.appendChild(dbg);
    }
    bar.appendChild(switcher);

    // Account-gated operator entry. It starts hidden and is revealed only by
    // the exact /session capability; direct route access is still protected by
    // the same server-side dev-user checks as every LAB operation.
    const catalogLab = document.createElement('button');
    catalogLab.type = 'button';
    catalogLab.className = 'feed-bar__lab';
    catalogLab.hidden = true;
    catalogLab.textContent = 'LAB';
    catalogLab.setAttribute('aria-label', 'Catalog Lab access');
    catalogLab.addEventListener('pointerdown', (event) => event.stopPropagation());
    catalogLab.addEventListener('click', (event) => {
      event.stopPropagation();
      location.assign(catalogLabAuthUrl(location.href));
    });
    bar.appendChild(catalogLab);
    this.catalogLabNavEl = catalogLab;
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
    this.feedBarEl = bar;
  }

  // Kept while the daily panel transitions from its old toast implementation.
  private comingSoonEl: HTMLElement | null = null;

  // Catalog and progress come from static metadata + a compact persisted index
  // state. The random chest drop deliberately never mutates this state.
  private openCollections(): void {
    if (this.overlayOpen) return;
    this.overlayOpen = true;
    this.applyActiveStates();

    const ov = document.createElement('section');
    ov.className = 'collections-view';
    ov.setAttribute('aria-label', 'Коллекции');
    this.viewport.appendChild(ov);
    this.overlayEl = ov;
    this.renderCollectionsOverview(ov);
    track('collections_open', { collections: COLLECTIONS.length });
    // No opacity fade-in: the view is opaque and must cover the feed the instant
    // it mounts, otherwise switching between central views (e.g. daily→collections)
    // shows the feed mechanic through the fading-in layer.
  }

  private renderCollectionsOverview(ov: HTMLElement): void {
    const totalCollected = COLLECTIONS.reduce(
      (sum, collection) => sum + collectedCardIndexes(this.collectionProgress, collection.id).size,
      0,
    );
    const totalCards = COLLECTIONS.reduce((sum, collection) => sum + collection.cards.length, 0);
    ov.innerHTML =
      '<header class="collections-view__header">' +
        '<div>' +
          '<div class="collections-view__eyebrow">Альбом сезона</div>' +
          '<h1 class="collections-view__title">Коллекции</h1>' +
        '</div>' +
      '</header>' +
      '<main class="collections-view__body">' +
        '<section class="collections-intro">' +
          '<div class="collections-intro__copy">' +
            '<strong>Собери все карточки</strong>' +
            '<span>Открывай коллекции и следи за прогрессом.</span>' +
          '</div>' +
          `<div class="collections-intro__total"><strong>${totalCollected}</strong><span>из ${totalCards}</span></div>` +
        '</section>' +
        '<div class="collections-list" aria-label="Альбомы"></div>' +
      '</main>';

    const list = ov.querySelector<HTMLElement>('.collections-list');
    COLLECTIONS.forEach((collection) => {
      const collected = collectedCardIndexes(this.collectionProgress, collection.id);
      const count = collected.size;
      const percent = collection.cards.length ? Math.round(count / collection.cards.length * 100) : 0;
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'collection-tile';
      tile.setAttribute(
        'aria-label',
        `${collection.title}: собрано ${count} из ${collection.cards.length}, награда ${collection.rewardPuzzles} пазлов`,
      );
      tile.innerHTML =
        '<div class="collection-tile__art" aria-hidden="true"></div>' +
        '<div class="collection-tile__copy">' +
          `<span class="collection-tile__kicker">Коллекция · ${collection.cards.length} карт</span>` +
          `<strong class="collection-tile__title">${collection.title}</strong>` +
          `<span class="collection-tile__subtitle">${collection.subtitle}</span>` +
          '<div class="collection-reward collection-reward--tile">' +
            `<img src="${PUZZLE_ICON}" alt="" draggable="false" aria-hidden="true">` +
            '<span>Награда за сбор</span>' +
            `<strong>${collection.rewardPuzzles} пазлов</strong>` +
          '</div>' +
          '<div class="collection-tile__progress-line">' +
            `<span>Собрано</span><strong>${count}/${collection.cards.length}</strong>` +
          '</div>' +
          `<div class="collection-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${collection.cards.length}" aria-valuenow="${count}">` +
            `<i style="width:${percent}%"></i>` +
          '</div>' +
          '<span class="collection-tile__open">Открыть <b aria-hidden="true">→</b></span>' +
        '</div>';

      const art = tile.querySelector<HTMLElement>('.collection-tile__art');
      collection.cards.slice(0, 3).forEach((card) => {
        const preview = makeCollectionCard(card, 94);
        preview.classList.add('collection-tile__preview');
        if (!collected.has(card.index)) {
          preview.classList.add('coll-card--locked');
          const title = preview.querySelector<HTMLElement>('.coll-card__title');
          if (title) title.textContent = '???';
        }
        art?.appendChild(preview);
      });
      tile.addEventListener('click', () => this.renderCollectionDetails(ov, collection.id));
      list?.appendChild(tile);
    });
  }

  private renderCollectionDetails(ov: HTMLElement, collectionId: string): void {
    const collection = collectionById(collectionId);
    if (!collection) { this.renderCollectionsOverview(ov); return; }
    const collected = collectedCardIndexes(this.collectionProgress, collection.id);
    const count = collected.size;
    const percent = collection.cards.length ? Math.round(count / collection.cards.length * 100) : 0;
    ov.innerHTML =
      '<header class="collections-view__header collections-view__header--detail">' +
        '<button class="collections-view__back" type="button" aria-label="К списку коллекций">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 5 L8.5 12 L15.5 19"/></svg>' +
        '</button>' +
        '<div class="collections-view__heading">' +
          '<div class="collections-view__eyebrow">Коллекция</div>' +
          `<h1 class="collections-view__title">${collection.title}</h1>` +
        '</div>' +
        '<span class="collections-view__spacer" aria-hidden="true"></span>' +
      '</header>' +
      '<main class="collections-view__body collections-view__body--detail">' +
        '<section class="collection-detail__summary">' +
          '<div>' +
            `<span>${collection.subtitle}</span>` +
            `<strong>${count} из ${collection.cards.length} собрано</strong>` +
          '</div>' +
          `<b>${percent}%</b>` +
          `<div class="collection-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${collection.cards.length}" aria-valuenow="${count}">` +
            `<i style="width:${percent}%"></i>` +
          '</div>' +
          '<div class="collection-reward collection-reward--detail" aria-label="Награда за полную коллекцию">' +
            `<img src="${PUZZLE_ICON}" alt="" draggable="false" aria-hidden="true">` +
            '<span>Награда за полный сбор</span>' +
            `<strong>${collection.rewardPuzzles} пазлов</strong>` +
          '</div>' +
        '</section>' +
        '<div class="collection-card-grid" aria-label="Карточки коллекции"></div>' +
      '</main>';

    const grid = ov.querySelector<HTMLElement>('.collection-card-grid');
    collection.cards.forEach((card) => {
      const isCollected = collected.has(card.index);
      const slot = document.createElement('article');
      slot.className = `collection-card-slot collection-card-slot--${isCollected ? 'collected' : 'missing'}`;
      slot.setAttribute('aria-label', isCollected
        ? `Карточка ${card.index}: ${card.title}, собрана`
        : `Карточка ${card.index}: не собрана`);
      const cardEl = makeCollectionCard(card);
      cardEl.style.width = '100%';
      if (!isCollected) {
        cardEl.classList.add('coll-card--locked');
        const title = cardEl.querySelector<HTMLElement>('.coll-card__title');
        if (title) title.textContent = 'Не собрано';
        const lock = document.createElement('span');
        lock.className = 'collection-card-slot__lock';
        lock.setAttribute('aria-hidden', 'true');
        lock.innerHTML = '<svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8.5 10 V7.5 a3.5 3.5 0 0 1 7 0 V10"/></svg>';
        slot.append(cardEl, lock);
      } else {
        const picture = cardEl.querySelector<HTMLImageElement>('.coll-card__pic img');
        if (picture) picture.alt = card.title;
        slot.appendChild(cardEl);
      }
      const status = document.createElement('div');
      status.className = 'collection-card-slot__status';
      status.innerHTML = isCollected
        ? '<span aria-hidden="true">✓</span> Собрана'
        : `<span aria-hidden="true">${String(card.index).padStart(2, '0')}</span> Не найдена`;
      slot.appendChild(status);
      grid?.appendChild(slot);
    });

    ov.querySelector('.collections-view__back')?.addEventListener('click', () => this.renderCollectionsOverview(ov));
    ov.querySelector('.collections-view__body')?.scrollTo({ top: 0 });
    track('collection_open', { collection_id: collection.id, collected: count, total: collection.cards.length });
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
    // The rail is the challenge inbox (filled by refreshChallengeRail after
    // /session): friends' challenges to play. "You" leads; cards follow.
    hud.className = 'hud';
    hud.innerHTML =
      '<div class="stories" aria-label="Challenges">' +
        '<div class="story story--me">' +
          '<div class="hud__level" aria-label="Level progress">' +
            '<div class="hud__level-ring"></div>' +
            '<div class="hud__level-core"><span class="hud__level-value">1</span></div>' +
            '<span class="hud__level-plus" aria-hidden="true"></span>' +
          '</div>' +
          '<div class="story__name">You</div>' +
        '</div>' +
      '</div>' +
      // Puzzle counter (meta-currency), pinned top-right of the friends panel.
      // Chest puzzle drops fly up-right into it.
      '<div class="hud__puzzles" aria-label="Puzzles">' +
        `<img src="${PUZZLE_ICON}" alt="" draggable="false">` +
        `<span class="hud__puzzles-value">${this.totalPuzzles}</span>` +
      '</div>';
    this.viewport.appendChild(hud);
    this.hudEl = hud;
    this.levelBadgeEl = hud.querySelector('.hud__level');
    this.levelEl = hud.querySelector('.hud__level-value');
    this.levelProgressEl = hud.querySelector('.hud__level-ring');
    this.puzzleBadgeEl = hud.querySelector('.hud__puzzles');
    this.puzzleValueEl = hud.querySelector('.hud__puzzles-value');
    const stories = hud.querySelector<HTMLElement>('.stories');
    this.storiesEl = stories;
    if (stories) this.attachStoryScroller(stories);
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
      const chEl = t?.closest?.('.story[data-challenge]') as HTMLElement | null;
      if (chEl) { this.playChallengeFromRail(chEl.dataset.challenge); return; }
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
    this.renderSeriesRow();   // level-up is up now → drop any preview panel behind it
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
    this.incomingImg.src = this.coverForIndex(next);
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
    const catalogSlot = this.catalogSlotForIndex(i);
    const catalogSurface = catalogFeedSurface(catalogSlot?.phase ?? null);
    if (catalogSurface !== 'builtin') {
      // Authority/delivery pending deliberately means no iframe at all: the
      // opaque poster remains the only painted surface, so a warm built-in can
      // never be visible while its impression is suppressed.
      if (catalogSurface === 'catalog' && catalogSlot) {
        this.mountCatalogFrame(i, catalogSlot);
      }
      return;
    }
    this.resetFrameReadiness(i);
    this.games[i].classList.add('game--loading');
    this.games[i].classList.remove('game--ready');
    const frame = document.createElement('iframe');
    frame.className = 'game__frame';
    const runId = runUid();
    frame.dataset.runId = runId;
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('title', this.playables[i].id);
    frame.setAttribute('allow', 'autoplay');
    frame.addEventListener('load', () => {
      if (this.frames.get(i) !== frame) return;
      this.markWarmTimeline(i, 'loadAt');
      this.disableFrameDoubleTapZoom(frame);
      this.attachPointerActivityProbe(i, frame);
      this.frameLoaded.add(i);
      this.setFramePaused(i, this.shouldPauseFrame(i));
      if (this.platformAudioPrimed) window.setTimeout(() => this.callPlayableHostGesture(i), 0);
      this.queueFrameReadyFallback(i, frame);
      this.tryRevealFrame(i);
      this.ensureFrameAutoPlay(i);
      this.applyPendingEditor(i);
    });
    this.frames.set(i, frame);
    this.rollReward(i, runId);
    if (this.manualRuns.has(i)) {
      const ticket = this.ticketForRun(i, runId);
      if (ticket) this.registerControlPlaneAttempt(i, runId, ticket);
    }
    const seriesParam = this.pendingSeriesParams.get(i);
    this.pendingSeriesParams.delete(i);   // one-shot: consumed by this mount
    // Level for this mount: the pending (series-advance) value, else the mechanic's
    // DEFAULT game level for series-level 1 — so a fixed-level series (e.g. pins-l3 →
    // game level 3) loads its level even on the FIRST/preview mount, not level 1.
    const levelParam = this.pendingLevels.get(i) ?? (this.seriesGameLevel(this.playables[i].id, 1) ?? undefined);
    this.pendingLevels.delete(i);         // one-shot
    frame.src = playableUrl(this.playables[i].id, {
      hostPaused: this.shouldPauseFrame(i),
      auto: !this.manualRuns.has(i),
      series: seriesParam,
      level: levelParam,
    });
    this.warmTimeline.delete(this.playables[i].id);   // fresh run — drop the previous mount's marks
    this.markWarmTimeline(i, 'appendAt');
    this.slots[i].appendChild(frame);
  }

  private mountCatalogFrame(i: number, slot: CatalogFeedSlot): void {
    if (this.frames.has(i) || !slot.bundle || !slot.ticketRequest || !slot.ticket) return;
    const ordinal = this.series?.catalog === slot ? this.series.done + 1 : 1;
    if (!slot.bundle.levels[ordinal - 1]) {
      this.activateCatalogBuiltinFallback(slot, 'manifest_ordinal_missing');
      return;
    }
    this.resetFrameReadiness(i);
    this.games[i].classList.add('game--loading');
    this.games[i].classList.remove('game--ready');
    const frame = document.createElement('iframe');
    frame.className = 'game__frame';
    const runId = runUid();
    frame.dataset.runId = runId;
    frame.dataset.catalogPlayerV2 = '1';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('title', slot.bundle.runtime.playableId);
    frame.setAttribute('allow', 'autoplay');
    frame.referrerPolicy = 'origin';
    frame.addEventListener('load', () => {
      if (frame.dataset.catalogNavigated !== '1' || this.frames.get(i) !== frame) return;
      this.markWarmTimeline(i, 'loadAt');
      this.disableFrameDoubleTapZoom(frame);
      this.attachPointerActivityProbe(i, frame);
      this.frameLoaded.add(i);
      this.setFramePaused(i, this.shouldPauseFrame(i));
      if (this.platformAudioPrimed) window.setTimeout(() => this.callPlayableHostGesture(i), 0);
      // The configured ACK can legitimately arrive before iframe `load` (the
      // runtime ACKs after mount, while subresources may still be settling).
      // Re-check reveal from both sides of that race.
      this.tryRevealFrame(i);
      this.ensureFrameAutoPlay(i);
      this.applyPendingEditor(i);
    });
    frame.addEventListener('error', () => {
      if (this.frames.get(i) === frame) this.failCatalogConfiguration(slot, 'mount');
    });
    this.frames.set(i, frame);
    this.rollReward(i, runId);
    this.slots[i].appendChild(frame);
    const frameSource = frame.contentWindow;
    if (!frameSource) {
      this.activateCatalogBuiltinFallback(slot, 'frame_source_missing');
      return;
    }
    slot.frameEpoch = ++this.catalogFrameEpoch;
    slot.ordinal = ordinal;
    slot.failureEmitted = false;
    try {
      slot.session = new CatalogPlayerV2Session({
        bundle: slot.bundle,
        ordinal,
        frameEpoch: slot.frameEpoch,
        frameSource,
        baseUrl: location.href,
      });
    } catch (error) {
      console.warn('[catalog-player-v2] invalid ticket delivery bundle', error);
      this.activateCatalogBuiltinFallback(slot, 'contract_setup_failure');
      return;
    }
    slot.phase = 'catalog_mounted';
    frame.referrerPolicy = slot.session.navigation.referrerPolicy;
    frame.dataset.catalogNavigated = '1';
    frame.src = slot.session.navigation.src;
    if (slot.configurationTimer !== null) window.clearTimeout(slot.configurationTimer);
    slot.configurationTimer = window.setTimeout(
      () => this.failCatalogConfiguration(slot, 'timeout'),
      10_000,
    );
    this.warmTimeline.delete(slot.bundle.runtime.playableId);
    this.markWarmTimeline(i, 'appendAt');
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
    const catalogSlot = this.catalogSlotForIndex(i);
    if (frame.dataset.catalogPlayerV2 === '1' && catalogSlot) {
      catalogSlot.session?.dispose(catalogSlot.frameEpoch);
      catalogSlot.session = null;
      if (catalogSlot.configurationTimer !== null) window.clearTimeout(catalogSlot.configurationTimer);
      catalogSlot.configurationTimer = null;
      if (catalogSlot.phase === 'catalog_mounted') catalogSlot.phase = 'catalog_ready';
    }
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
    this.frameStaticReady.delete(i);
    this.frameUsesStagedReady.delete(i);
    this.framePrepareRequested.delete(i);
    this.deferredWarmPrepare.delete(i);
    this.frameReady.delete(i);
    this.frameInteractiveReady.delete(i);
    this.frameInteractiveReadyAt.delete(i);
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
    this.syncControlPlaneDwell();
  }

  private queueFrameReadyFallback(i: number, frame: HTMLIFrameElement) {
    const previous = this.frameFallbackTimers.get(i);
    if (previous) window.clearTimeout(previous);
    if (this.frameReady.has(i)) return;
    const delay = this.frameUsesStagedReady.has(i) ? STAGED_READY_FALLBACK_MS : FRAME_READY_FALLBACK_MS;
    const timer = window.setTimeout(() => {
      this.frameFallbackTimers.delete(i);
      if (this.frames.get(i) !== frame) return;
      this.frameReady.add(i);
      this.applyActiveStates();
      this.tryRevealFrame(i);
    }, delay);
    this.frameFallbackTimers.set(i, timer);
  }

  private handlePlayableStaticReady(i: number) {
    const frame = this.frames.get(i);
    if (!frame) return;
    this.frameStaticReady.add(i);
    this.frameUsesStagedReady.add(i);
    // Replace the 900ms legacy fallback with the staged hard cap. A real
    // interactive_ready/ready normally arrives well before this.
    this.queueFrameReadyFallback(i, frame);
    this.applyActiveStates();
    if (this.shouldPrepareInteractive(i)) this.requestInteractivePreparation(i);
  }

  private shouldPrepareInteractive(i: number): boolean {
    return i === this.realIndex()
      || i === this.warmIndex
      || i === this.settlingTargetIndex
      || this.liveHold.has(i);
  }

  // Same-origin probe: real (isTrusted) pointer state inside a mechanic frame.
  // Autoplay dispatches synthetic pointer events — those must not read as a
  // user finger. Cross-origin frames (none in the feed today) skip the probe;
  // warm prepare simply isn't finger-gated for them.
  private attachPointerActivityProbe(i: number, frame: HTMLIFrameElement) {
    try {
      const win = frame.contentWindow;
      if (!win) return;
      const down = (e: PointerEvent) => {
        if (!e.isTrusted) return;
        this.primePlatformAudio(i);
        this.mechanicPointerDown = true;
        this.mechanicPointerDownAt = performance.now();
      };
      const up = (e: PointerEvent) => {
        if (!e.isTrusted) return;
        this.mechanicPointerDown = false;
        this.flushDeferredWarmPrepare();
      };
      win.addEventListener('pointerdown', down, { capture: true, passive: true });
      win.addEventListener('pointerup', up, { capture: true, passive: true });
      win.addEventListener('pointercancel', up, { capture: true, passive: true });
    } catch { /* cross-origin frame */ }
  }

  // Defer ONLY pure background warm. Arrival-driven preparation (current,
  // settling target, liveHold during a drag) always beats smoothness — the
  // user is about to land there.
  private shouldDeferWarmPrepare(i: number): boolean {
    if (i === this.realIndex() || i === this.settlingTargetIndex || this.liveHold.has(i)) return false;
    if (this.dragging) return true;
    if (!this.mechanicPointerDown) return false;
    // A press that never ended (missed pointerup on unmount, a long hold)
    // must not starve the warm forever.
    return performance.now() - this.mechanicPointerDownAt < 2500;
  }

  private flushDeferredWarmPrepare() {
    if (!this.deferredWarmPrepare.size) return;
    for (const i of [...this.deferredWarmPrepare]) {
      this.deferredWarmPrepare.delete(i);
      if (!this.frames.has(i) || !this.frameStaticReady.has(i)) continue;
      this.requestInteractivePreparation(i);
    }
  }

  private requestInteractivePreparation(i: number) {
    if (this.frameReady.has(i) || this.framePrepareRequested.has(i)) return;
    const frame = this.frames.get(i);
    if (!frame) return;
    if (this.shouldDeferWarmPrepare(i)) {
      this.deferredWarmPrepare.add(i);
      this.wlog(`prepareInteractive #${i} deferred — finger down on the current mechanic`);
      // Re-check even if the release never flushes (stale press guard).
      window.setTimeout(() => this.flushDeferredWarmPrepare(), 2600);
      return;
    }
    this.framePrepareRequested.add(i);
    try {
      const api = this.playableApi(i);
      const result = (api?.swipe?.prepareInteractive ?? api?.prepareInteractive)?.();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        void (result as Promise<void>).catch(() => {});
      }
    } catch { /* cross-origin/legacy: postMessage below */ }
    this.postPlayableCommand(frame, 'prepareInteractive');
  }

  private handlePlayableReady(i: number, interactiveReady = false) {
    if (interactiveReady && !this.frameInteractiveReady.has(i)) {
      const occurredAt = new Date().toISOString();
      this.frameInteractiveReady.add(i);
      this.frameInteractiveReadyAt.set(i, occurredAt);
      this.markCurrentControlPlaneAttemptReady(i, occurredAt);
    }
    this.frameStaticReady.add(i);
    this.frameReady.add(i);
    const fallbackTimer = this.frameFallbackTimers.get(i);
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    this.frameFallbackTimers.delete(i);
    // A staged current frame stayed host-paused while it prepared. Resume it
    // before the 90ms poster fade so onInteractive runs behind the cover.
    this.applyActiveStates();
    if (this.platformAudioPrimed) this.callPlayableHostGesture(i);
    this.tryRevealFrame(i);
    this.ensureFrameAutoPlay(i);
    this.applyPendingEditor(i);
    this.syncControlPlaneDwell();
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
        const slot = this.catalogSlotForIndex(i);
        if (slot) this.revealCatalogLevel(slot);
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

  // TEMP (?holdcover=1): the arriving cover HOLDS (poster shown, mechanic autoplay
  // NOT started) until the first tap, which releases it → autoplay starts + poster
  // fades. Lets us screenshot the static cover and the live frame for alignment
  // checks. The autoplay overlay is kept "active" while held so its tap surface stays
  // live; the .holdcover CSS hides the dim veil so the cover reads clean.
  private readonly HOLD_COVER = typeof location !== 'undefined' && new URLSearchParams(location.search).get('holdcover') === '1';
  private holdReleased = new Set<number>();
  private dbgSlot: { w: number; h: number; a: number } | null = null;

  private ensureFrameAutoPlay(i: number) {
    if (this.manualRuns.has(i) || this.shouldPauseFrame(i)) return;
    if (this.HOLD_COVER && !this.holdReleased.has(i)) return;   // hold at cover until tapped

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

  private enterManualMode(i: number, deferControlPlaneAttempt = false) {
    if (i < 0 || i >= this.N) return;
    if (!this.manualRuns.has(i)) {
      // First transition autoplay → manual for this unit = a takeover.
      track('takeover', {
        mechanic_id: this.effectivePlayableId(i),
        ms_since_shown: Math.round(performance.now() - this.shownAt),
        ab_arm: null,   // W3: auto vs tap-to-start arm
      });
      // Start the solve-time clock on the first takeover of this unit (the win
      // metric — "how fast you solved it", lower is better).
      this.manualStartMs.set(i, performance.now());
      // Taking over a mechanic begins its configured series (unless this is a
      // one-shot challenge play).
      this.ensureCatalogSeries(i);
      this.maybeStartSeries(i);
    }
    this.manualRuns.add(i);
    const runId = this.frames.get(i)?.dataset.runId;
    if (runId) {
      const ticket = this.ticketForRun(i, runId);
      if (ticket && !deferControlPlaneAttempt) this.registerControlPlaneAttempt(i, runId, ticket);
    }
    if (this.series?.index === i && this.series.playing) this.setSeriesRowManualHidden(true);
    this.stopFrameAutoPlay(i);
    this.setAutoplayUi(i, false);
  }

  private activateManualFromAutoplay(i: number) {
    if (i !== this.realIndex()) return;
    this.enterManualMode(i, true);
    this.revealLabel(i);
    // Restart the round for the manual run. Prefer the in-place swipe.restart
    // (bundle already parsed → no iframe reload, no preloader flash); fall back to
    // a full remount otherwise. `?takeover=continue` keeps the in-progress autoplay
    // state and does neither.
    let reloaded = false;
    if (this.restartOnTakeover) {
      const swipe = this.playableApi(i)?.swipe;
      if (swipe?.hasRestart) {
        // instant: skip the first-time intro entrance (e.g. generator drop-in) —
        // the player already watched it during autoplay, so form the field ready.
        try { swipe.restart({ instant: true }); } catch { /* cross-origin */ }
      } else {
        reloaded = true;
        this.reloadFrame(i);
      }
    }
    if (!reloaded) {
      const runId = this.frames.get(i)?.dataset.runId;
      const ticket = runId ? this.ticketForRun(i, runId) : null;
      if (runId && ticket) this.registerControlPlaneAttempt(i, runId, ticket);
    }
    this.applyActiveStates();
  }

  private applyActiveStates() {
    this.frames.forEach((_f, i) => {
      this.setFramePaused(i, this.shouldPauseFrame(i));
      this.tryRevealFrame(i);
    });
    this.ensureNearCovers();
    this.pollAutoplayUi();
    this.markCurrentUnitShownIfVisible();
    this.syncControlPlaneDwell();
  }

  /** Pick the cover aspect bucket for THIS device from the real slot box (covers
   *  are baked in two aspects — tall ~0.55, compact ~0.72 — see gen-covers). The
   *  poster is object-fit:fill'd into the slot, so the nearer-aspect bake stretches
   *  least. Threshold = midpoint of the two clusters (0.636). Idempotent; re-run on
   *  resize — if the bucket flips, drop loaded covers so they refetch at the new
   *  aspect. */
  private coverBucket = '';
  private pickCoverBucket() {
    const slot = this.viewport.querySelector<HTMLElement>('.game__slot');
    let w = window.innerWidth, h = Math.max(1, window.innerHeight - 146);
    if (slot && slot.offsetWidth && slot.offsetHeight) { w = slot.offsetWidth; h = slot.offsetHeight; }
    this.dbgSlot = { w: Math.round(w), h: Math.round(h), a: +(w / h).toFixed(3) };
    // Buckets measured IN Telegram: mobile ~0.65 (Android 0.63 / iPhone 0.64–0.66),
    // desktop ~0.80. Threshold = midpoint 0.72 → mobile ('') vs desktop ('.c').
    const bucket = (w / h) > 0.72 ? '.c' : '';
    this.renderVersionLabel();   // reflect measured slot on the debug badge (holdcover)
    if (bucket === this.coverBucket && this.coverLoadedBucketSet) return;
    this.coverBucket = bucket;
    this.coverLoadedBucketSet = true;
    setCoverBucket(bucket);
    // Flip mid-session (resize/rotate): invalidate cached covers + re-request.
    if (this.coverLoaded.size) {
      this.coverLoaded.clear();
      this.ensureNearCovers();
      this.incomingIndex = -1;   // force updateIncomingPoster to refetch
      this.updateIncomingPoster();
    }
  }
  private coverLoadedBucketSet = false;

  /** Fetch the cover for page i (wrap-safe), once. */
  private ensureCover(i: number) {
    const n = ((i % this.N) + this.N) % this.N;
    if (this.coverLoaded.has(n)) return;
    const poster = this.posterEls[n];
    if (!poster) return;
    this.coverLoaded.add(n);
    poster.src = this.coverForIndex(n);
  }

  private coverForIndex(i: number): string {
    const slot = this.catalogSlotForIndex(i);
    const generated = this.generatedOffer && (
      this.generatedTargetIndex === i
      || (slot?.insertionKind === 'generated'
        && slot.allocation?.decisionId === this.generatedOffer.allocation.decisionId)
    );
    return generated ? this.generatedPreviewUrl(this.generatedOffer!) : coverSrc(this.playables[i].id);
  }

  /** Covers for the window the user can reach next: prev (back-swipe), current,
   *  and the two ahead (the incoming-poster ride reads from the same cache). */
  private ensureNearCovers() {
    const c = this.realIndex();
    for (const d of [-1, 0, 1, 2]) this.ensureCover(c + d);
  }

  private shouldPauseFrame(i: number): boolean {
    if (document.hidden) return true;
    if (this.overlayOpen) return true;   // a story / editor is up — freeze the whole feed
    if (this.dailyOpen) return true;     // daily central view is up — freeze + mute like any other non-feed tab
    if (this.collectingRewardIndex !== null) return true;   // star credit in flight — freeze EVERY frame behind the cover so nothing competes for the main thread
    if (this.catalogSlotForIndex(i)?.canaryProjectionRequired) return true;
    if (this.frameUsesStagedReady.has(i) && !this.frameReady.has(i)) return true;
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
    if (!this.shouldIdleWarm(next)) return `next #${next} is ${mechanicMountCost(this.playables[next].id)}; waiting for swipe intent`;
    return '';
  }

  private shouldIdleWarm(i: number): boolean {
    // Default: the immediate NEXT mechanic is ALWAYS pre-warmed during idle.
    // Gating heavy mechanics on swipe intent (the previous 'adaptive' default)
    // regressed on device: 9 of 10 mechanics are 'heavy' by the byte manifest,
    // so nothing pre-mounted no matter how long the player idled, every swipe
    // arrived on a loading cover, and the mount cost landed INSIDE the gesture.
    // The calm-frames gate + staged boot already make a background warm cheap
    // (~100-180ms worst on A32 after the mount surgery) — idle time is the
    // right place for it. mountCost still classifies byte-prefetch depth, and
    // '?warm=intent' keeps the intent-only behaviour for A/B comparisons.
    if (this.warmMode === 'intent') return mechanicMountCost(this.playables[i]?.id ?? '') === 'light';
    return true;
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
      mode: this.warmMode,
      nextMountCost: next >= 0 ? mechanicMountCost(this.playables[next]?.id ?? '') : null,
      blockedNow: reason || '(not blocked — warm is allowed right now)',
      fingerDown: this.mechanicPointerDown,
      deferredPrepare: [...this.deferredWarmPrepare],
      calmFramesSeenMax: this.warmCalmMax,
      calmFramesNeeded: WARM_NEXT_CALM_FRAMES,
      diagnosis: next >= 0 && !this.shouldIdleWarm(next)
        ? 'intent-only mount: byte-prefetch may run, iframe creation waits for directional swipe intent'
        : this.warmCalmMax < WARM_NEXT_CALM_FRAMES
          ? `the current mechanic never yielded ${WARM_NEXT_CALM_FRAMES} calm frames (≤${WARM_NEXT_CALM_FRAME_MS}ms) in a row → warm is STARVED (no idle window)`
          : 'a calm window was reached at least once',
      recentEvents: this.warmEvents.slice(-50),
    };
  }

  private scheduleWarmNext() {
    this.clearWarmTimer();
    const next = this.desiredWarmIndex();
    if (next === null) { this.wlog(`schedule blocked: ${this.warmBlockReason()}`); return; }
    if (!this.shouldIdleWarm(next)) { this.wlog(`idle mount skipped for #${next}: ${this.warmBlockReason()}`); return; }
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

  /** Mount the target only after a real directional gesture (or committed programmatic advance). */
  private mountIntentTarget(i: number) {
    if (!this.warmNextEnabled || i < 0 || i >= this.N) return;
    if (this.frames.has(i)) {
      if (this.frameStaticReady.has(i)) this.requestInteractivePreparation(i);
      return;
    }
    this.wlog(`INTENT mount #${i} (${mechanicMountCost(this.playables[i].id)})`);
    // onDown already placed the target in liveHold; updateLive performs the
    // expensive iframe navigation only now, after direction is known.
    this.updateLive();
    if (this.frameStaticReady.has(i)) this.requestInteractivePreparation(i);
  }

  private pauseAllFrames = () => {
    this.clearWarmTimer();
    this.frames.forEach((_frame, i) => this.setFramePaused(i, true));
    this.pauseStoryFrame(true);
    this.syncControlPlaneDwell();
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
      // Cold arrival: a staged CURRENT frame stays host-paused while it loads,
      // so the api gate above can't run and the slot sat at scale(1) — the
      // preloader filled the full frame, then the freshly revealed game
      // visibly shrank into the 0.92 autoplay frame (the "expands then
      // squeezes back" report). Pre-scale while loading so the mechanic
      // reveals INSIDE the frame it will live in. Manual runs keep
      // full-bleed — they never get the autoplay frame.
      if (!active && isCurrent && !manual && !this.frameReady.has(i)
        && !this.earnedThisCycle.has(i) && !this.failedThisCycle.has(i)) {
        active = true;
      }
      // TEMP holdcover: keep the overlay ACTIVE on the held unit so its tap surface
      // stays live (veil hidden via .holdcover CSS), even though the mechanic's own
      // autoplay hasn't started yet — the tap is what releases it.
      if (this.HOLD_COVER && isCurrent && !this.holdReleased.has(i)) active = true;
      this.setAutoplayUi(i, active, preview);

      // Hint above the fixed bar: only about TAPPING to play this mechanic (paging is
      // the bar's button now). Shown during autoplay/attract; hidden in manual play.
      const txt = this.swipebarTextEls[i];
      if (txt && txt.textContent !== 'tap to play or swipe') txt.textContent = 'tap to play or swipe';

      // Poster lifecycle: ONE-WAY hide once the mechanic is genuinely live on
      // screen (current + revealed + un-paused). Never re-shown mid-run — a
      // poster snapping over a live leaving frame would flash; remount
      // (resetFrameReadiness) restores it for the next cycle.
      if (isCurrent && !paused && this.frameRevealed.has(i) && (!this.HOLD_COVER || this.holdReleased.has(i))) {
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
    // Leaving a mechanic mid-series (× / bar) breaks the series, no reward. If the
    // series just finished, finishSeries() already cleared it → this is a no-op.
    this.breakSeries();
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
    frame.src = playableUrl(mechanic, { hostPaused: false, auto: true, level: this.seriesGameLevel(mechanic, 1) ?? undefined });
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

  // ── Meta world prototype ──────────────────────────────────────────────────
  // First pass at the creator meta: a player's location is a tiny park where
  // each plot is a playable mechanic that can earn visits, likes, and tokens.
  private openMetaWorld() {
    if (this.overlayOpen) return;
    this.overlayOpen = true;
    this.applyActiveStates();

    const ov = document.createElement('div');
    ov.className = 'meta-world';
    this.viewport.appendChild(ov);
    this.overlayEl = ov;
    this.renderMetaWorld(ov);
    if (ov.animate) ov.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: 'forwards' });
  }

  // ── Island meta prototype (PARALLEL experiment to the meta world above) ────
  // Triangle icon on the feed bar. The player's island is a showcase of their
  // created mechanics: each one is a building that themes its own sector.
  // UI/styles live in src/island.ts; state is server-authoritative with a local
  // cache managed by src/island-state.ts. This method owns overlay boilerplate.
  private openIslandWorld() {
    if (this.overlayOpen) return;
    this.overlayOpen = true;
    this.applyActiveStates();

    const ov = document.createElement('div');
    ov.className = 'island-world';
    this.viewport.appendChild(ov);
    this.overlayEl = ov;
    const islandLevel = this.levelForStars(this.totalStars);
    const ownIsland = !this.publicIsland;
    void import('./island').then((m) => m.renderIslandWorld(ov, {
      close: () => this.closeOverlay(),
      level: islandLevel,
      puzzles: () => this.totalPuzzles,
      publicIsland: this.publicIsland ?? undefined,
      // Collecting puzzles credits the shared counter — only on the player's OWN island.
      addPuzzles: ownIsland ? (n: number, from?: { x: number; y: number }) => this.addPuzzlesFromMeta(n, from) : undefined,
    }));
    // No opacity fade-in: the opaque view must cover the feed the instant it mounts,
    // else daily→meta shows the feed mechanic through the fading-in layer (flicker).
  }

  private metaTemplates(): MetaTemplate[] {
    return [
      {
        id: 'merge',
        label: 'Merge',
        name: 'Merge Kitchen',
        mood: 'Combine orders',
        playableId: 'merge-timepress-v1-swipe',
        visitors: '3.4K',
        likes: '811',
        earned: 124,
        promo: 'Rising creator',
        tone: 'green',
      },
      {
        id: 'sort',
        label: 'Sorting',
        name: 'Sort Harbor',
        mood: 'Sort by color',
        playableId: 'marble-sort-swipe',
        visitors: '940',
        likes: '176',
        earned: 42,
        promo: 'Friends route',
        tone: 'blue',
      },
      {
        id: 'pin',
        label: 'Pins',
        name: 'Pin Tower',
        mood: 'Pull the pins',
        playableId: 'pins-swipe',
        visitors: '1.8K',
        likes: '342',
        earned: 86,
        promo: 'Portal drop: 12%',
        tone: 'amber',
      },
    ];
  }

  private metaTemplateFor(id: MetaTemplateId): MetaTemplate {
    return this.metaTemplates().find((tpl) => tpl.id === id) ?? this.metaTemplates()[0];
  }

  private metaVariantSpec(template: MetaTemplateId): MetaVariantSpec {
    const theme = this.metaBuilderTheme;
    const modifier = this.metaBuilderModifier;
    if (template === 'sort') {
      const rects = modifier === 'Speed round' ? 4 : modifier === 'Limited moves' ? 16 : 12;
      return {
        template,
        theme,
        modifier,
        summary: `${rects} sorting targets`,
        series: { rects, theme, modifier },
      };
    }
    if (template === 'pin') {
      const level = modifier === 'Speed round' ? 1 : modifier === 'Limited moves' ? 3 : 2;
      return {
        template,
        theme,
        modifier,
        summary: `Pins level ${level}`,
        level,
      };
    }
    const orders = modifier === 'Speed round' ? 3 : modifier === 'Limited moves' ? 6 : 5;
    const itemLevelDelta = theme === 'Frozen cabin' || modifier === 'Limited moves' ? 1 : 0;
    return {
      template,
      theme,
      modifier,
      summary: `${orders} orders · items +${itemLevelDelta}`,
      series: { orders, itemLevelDelta, theme, modifier },
    };
  }

  private metaPlots(): MetaPlot[] {
    const slots = ['plot-a', 'plot-b', 'plot-c', 'plot-d'];
    return slots.map((id, idx) => {
      const templateId = this.metaBuiltPlots.get(id);
      if (!templateId) {
        return {
          id,
          name: `Empty Cell ${idx + 1}`,
          template: 'Choose template',
          mood: 'Merge · Sorting · Pins',
          playableId: '',
          visitors: '0',
          likes: '0',
          earned: 0,
          promo: 'Tap to build',
          tone: 'muted',
          empty: true,
        };
      }
      const tpl = this.metaTemplateFor(templateId);
      const level = this.metaPlotLevels.get(id) ?? 1;
      const variant = this.metaVariants.get(id);
      return {
        id,
        name: tpl.name,
        template: tpl.label,
        mood: variant ? variant.summary : tpl.mood,
        playableId: tpl.playableId,
        visitors: tpl.visitors,
        likes: tpl.likes,
        earned: tpl.earned + Math.max(0, level - 1) * 18,
        promo: variant ? `${variant.theme} · ${variant.modifier}` : tpl.promo,
        tone: tpl.tone,
      };
    });
  }

  private renderMetaWorld(ov: HTMLElement) {
    const plots = this.metaPlots();
    if (!plots.some((p) => p.id === this.metaSelectedPlotId)) this.metaSelectedPlotId = plots[0]?.id ?? 'plot-a';
    const selected = plots.find((p) => p.id === this.metaSelectedPlotId) ?? plots[0];
    const selectedLevel = this.metaPlotLevels.get(selected.id) ?? 0;
    const selectedUpgradeCost = 100 + selectedLevel * 70;
    const selectedCanUpgrade = !selected.empty && this.metaTokens >= selectedUpgradeCost;
    const builderPlot = this.metaBuilderPlotId ? plots.find((p) => p.id === this.metaBuilderPlotId) : null;
    const builderCost = builderPlot?.empty ? 120 : Math.max(90, 80 + (this.metaPlotLevels.get(builderPlot?.id ?? '') ?? 0) * 20);
    const builderCanPublish = !!builderPlot && this.metaTokens >= builderCost;
    const totalEarned = plots.reduce((sum, p) => sum + p.earned, 0);
    const builtCount = plots.filter((p) => !p.empty).length;
    const firstEmpty = plots.find((p) => p.empty);
    const builderPreview = this.metaVariantSpec(this.metaBuilderTemplate);
    const builderTemplates = this.metaTemplates();
    const builderThemes = ['Neon rain', 'Frozen cabin', 'Cozy bakery'];
    const builderModifiers = ['Chain rewards', 'Speed round', 'Limited moves'];

    ov.innerHTML =
      '<div class="meta-world__header">' +
        '<div>' +
          '<div class="meta-world__eyebrow">Creator District</div>' +
          '<div class="meta-world__title">My Park</div>' +
        '</div>' +
        `<div class="meta-world__wallet"><span>${this.metaTokens}</span><small>tokens</small></div>` +
        '<button class="meta-world__close" type="button" aria-label="Close">x</button>' +
      '</div>' +
      '<div class="meta-world__body">' +
        '<section class="meta-world__scene" aria-label="Player location">' +
          '<div class="meta-world__skyline">' +
            '<div class="meta-world__portal"><span>Portal</span></div>' +
            '<div class="meta-world__bank"><span>Bank</span></div>' +
          '</div>' +
          '<div class="meta-world__island">' +
            plots.map((p, idx) => {
              const level = this.metaPlotLevels.get(p.id) ?? 0;
              return (
                `<button class="meta-plot meta-plot--${p.tone}${p.empty ? ' meta-plot--empty' : ''}${p.id === selected.id ? ' meta-plot--active' : ''}" type="button" data-focus="${p.id}" style="--plot-i:${idx}">` +
                  `<span class="meta-plot__tower"><i></i></span>` +
                  `<span class="meta-plot__name">${p.name}</span>` +
                  `<span class="meta-plot__level">Lv ${level || '-'}</span>` +
                '</button>'
              );
            }).join('') +
          '</div>' +
        '</section>' +
        '<section class="meta-world__panel" aria-label="Meta actions">' +
          '<div class="meta-world__summary">' +
            `<div><strong>${totalEarned}</strong><span>daily yield</span></div>` +
            `<div><strong>${this.metaClaimReady}</strong><span>ready</span></div>` +
            `<div><strong>${builtCount}/4</strong><span>built</span></div>` +
          '</div>' +
          '<div class="meta-world__actions">' +
            `<button class="meta-world__primary" type="button" data-claim${this.metaClaimReady <= 0 ? ' disabled' : ''}>Claim ${this.metaClaimReady}</button>` +
            `<button class="meta-world__ghost" type="button" data-build-next${firstEmpty ? '' : ' disabled'}>${firstEmpty ? 'Build cell' : 'All built'}</button>` +
          '</div>' +
          `<div class="meta-selected meta-selected--${selected.tone}">` +
            '<div class="meta-selected__top">' +
              '<div>' +
                `<div class="meta-selected__kicker">${selected.empty ? 'Open slot' : selected.template}</div>` +
                `<div class="meta-selected__name">${selected.name}</div>` +
                `<div class="meta-selected__sub">${selected.mood}</div>` +
              '</div>' +
              `<div class="meta-selected__level">Lv ${selectedLevel || '-'}</div>` +
            '</div>' +
            '<div class="meta-selected__stats">' +
              `<span>${selected.visitors}<small>visits</small></span>` +
              `<span>${selected.likes}<small>likes</small></span>` +
              `<span>${selected.earned}<small>yield</small></span>` +
            '</div>' +
            '<div class="meta-selected__actions">' +
              (selected.empty
                ? '<button class="meta-selected__primary" type="button" data-generate-slot>Choose template</button>'
                : '<button class="meta-selected__primary" type="button" data-play>Play</button>' +
                  '<button type="button" data-remix>Remix</button>' +
                  `<button type="button" data-upgrade="${selected.id}"${selectedCanUpgrade ? '' : ' disabled'}>Upgrade ${selectedUpgradeCost}</button>`) +
            '</div>' +
          '</div>' +
          (builderPlot
            ? '<div class="meta-builder">' +
                '<div class="meta-builder__top">' +
                  `<strong>${builderPlot.empty ? 'Choose Template' : 'Remix Lab'}</strong>` +
                  `<span>${builderCost} tokens</span>` +
                '</div>' +
                '<div class="meta-builder__row">' +
                  '<small>Template</small>' +
                  '<div class="meta-builder__templates">' +
                    builderTemplates.map((tpl) => (
                      `<button class="meta-template meta-template--${tpl.tone}${tpl.id === this.metaBuilderTemplate ? ' is-active' : ''}" type="button" data-builder-template="${tpl.id}">` +
                        `<strong>${tpl.label}</strong>` +
                        `<span>${tpl.mood}</span>` +
                      '</button>'
                    )).join('') +
                  '</div>' +
                '</div>' +
                '<div class="meta-builder__row">' +
                  '<small>Look</small>' +
                  '<div class="meta-builder__chips">' +
                    builderThemes.map((name) => `<button class="${name === this.metaBuilderTheme ? 'is-active' : ''}" type="button" data-builder-theme="${name}">${name}</button>`).join('') +
                  '</div>' +
                '</div>' +
                '<div class="meta-builder__row">' +
                  '<small>Rule twist</small>' +
                  '<div class="meta-builder__chips">' +
                    builderModifiers.map((name) => `<button class="${name === this.metaBuilderModifier ? 'is-active' : ''}" type="button" data-builder-modifier="${name}">${name}</button>`).join('') +
                  '</div>' +
                '</div>' +
                '<div class="meta-builder__spec">' +
                  '<small>Generated spec</small>' +
                  `<strong>${builderPreview.summary}</strong>` +
                '</div>' +
                '<div class="meta-builder__actions">' +
                  '<button class="meta-world__ghost" type="button" data-builder-cancel>Cancel</button>' +
                  `<button class="meta-world__primary" type="button" data-builder-publish${builderCanPublish ? '' : ' disabled'}>Publish</button>` +
                '</div>' +
              '</div>'
            : '') +
          '<div class="meta-world__plots">' +
            plots.map((p) => {
              const level = this.metaPlotLevels.get(p.id) ?? 0;
              const cost = 100 + level * 70;
              const canUpgrade = !p.empty && this.metaTokens >= cost;
              return (
                `<article class="meta-card meta-card--${p.tone}${p.empty ? ' meta-card--empty' : ''}${p.id === selected.id ? ' meta-card--active' : ''}" data-select="${p.id}">` +
                  '<div class="meta-card__top">' +
                    '<div>' +
                      `<div class="meta-card__name">${p.name}</div>` +
                      `<div class="meta-card__sub">${p.template} · ${p.mood}</div>` +
                    '</div>' +
                    `<div class="meta-card__level">Lv ${level || '-'}</div>` +
                  '</div>' +
                  '<div class="meta-card__stats">' +
                    `<span>${p.visitors}<small>visits</small></span>` +
                    `<span>${p.likes}<small>likes</small></span>` +
                    `<span>${p.earned}<small>yield</small></span>` +
                  '</div>' +
                  '<div class="meta-card__foot">' +
                    `<span>${p.promo}</span>` +
                    (p.empty
                      ? '<button type="button" data-generate-slot>Choose</button>'
                      : `<button type="button" data-upgrade="${p.id}"${canUpgrade ? '' : ' disabled'}>Upgrade ${cost}</button>`) +
                  '</div>' +
                '</article>'
              );
            }).join('') +
          '</div>' +
        '</section>' +
      '</div>';

    ov.querySelector('.meta-world__close')!.addEventListener('click', () => this.closeOverlay());
    ov.querySelectorAll<HTMLElement>('[data-focus], [data-select]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.focus ?? el.dataset.select;
        if (!id) return;
        this.metaSelectedPlotId = id;
        const plot = this.metaPlots().find((p) => p.id === id);
        if (plot?.empty) {
          this.openMetaBuilder(ov, id);
        } else {
          this.metaBuilderPlotId = null;
          this.renderMetaWorld(ov);
        }
      });
    });
    ov.querySelector('[data-claim]')?.addEventListener('click', () => {
      if (this.metaClaimReady <= 0) return;
      this.metaTokens += this.metaClaimReady;
      this.metaClaimReady = 0;
      this.renderMetaWorld(ov);
    });
    ov.querySelector('[data-build-next]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      const next = this.metaPlots().find((p) => p.empty);
      if (next) this.openMetaBuilder(ov, next.id);
    });
    ov.querySelector('[data-generate-slot]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openMetaBuilder(ov, selected.id);
    });
    ov.querySelector('[data-play]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.playMetaPlot(ov, selected.id);
    });
    ov.querySelector('[data-remix]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openMetaBuilder(ov, selected.id);
    });
    ov.querySelectorAll<HTMLElement>('[data-upgrade]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.upgradeMetaPlot(ov, btn.dataset.upgrade!);
      });
    });
    ov.querySelectorAll<HTMLElement>('[data-builder-template]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.metaBuilderTemplate = btn.dataset.builderTemplate! as MetaTemplateId;
        this.renderMetaWorld(ov);
      });
    });
    ov.querySelectorAll<HTMLElement>('[data-builder-theme]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.metaBuilderTheme = btn.dataset.builderTheme!;
        this.renderMetaWorld(ov);
      });
    });
    ov.querySelectorAll<HTMLElement>('[data-builder-modifier]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.metaBuilderModifier = btn.dataset.builderModifier!;
        this.renderMetaWorld(ov);
      });
    });
    ov.querySelector('[data-builder-cancel]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.metaBuilderPlotId = null;
      this.renderMetaWorld(ov);
    });
    ov.querySelector('[data-builder-publish]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.publishMetaBuilder(ov);
    });
  }

  private openMetaBuilder(ov: HTMLElement, id: string) {
    this.metaSelectedPlotId = id;
    this.metaBuilderTemplate = this.metaBuiltPlots.get(id) ?? this.metaBuilderTemplate;
    this.metaBuilderPlotId = id;
    this.renderMetaWorld(ov);
  }

  private upgradeMetaPlot(ov: HTMLElement, id: string) {
    const plot = this.metaPlots().find((p) => p.id === id);
    if (!plot || plot.empty) return;
    const level = this.metaPlotLevels.get(id) ?? 0;
    const cost = 100 + level * 70;
    if (this.metaTokens < cost) return;
    this.metaTokens -= cost;
    this.metaPlotLevels.set(id, level + 1);
    this.metaClaimReady += 18 + level * 4;
    this.renderMetaWorld(ov);
  }

  private publishMetaBuilder(ov: HTMLElement) {
    const id = this.metaBuilderPlotId;
    if (!id) return;
    const plot = this.metaPlots().find((p) => p.id === id);
    if (!plot) return;
    const level = this.metaPlotLevels.get(id) ?? 0;
    const cost = plot.empty ? 120 : Math.max(90, 80 + level * 20);
    if (this.metaTokens < cost) return;
    this.metaTokens -= cost;
    const variant = this.metaVariantSpec(this.metaBuilderTemplate);
    if (plot.empty) {
      this.metaBuiltPlots.set(id, this.metaBuilderTemplate);
      this.metaVariants.set(id, variant);
      this.metaPlotLevels.set(id, 1);
      this.metaClaimReady += 28;
    } else {
      this.metaBuiltPlots.set(id, this.metaBuilderTemplate);
      this.metaVariants.set(id, variant);
      this.metaRemixed.add(id);
      this.metaClaimReady += 20 + level * 3;
    }
    this.metaSelectedPlotId = id;
    this.metaBuilderPlotId = null;
    this.renderMetaWorld(ov);
  }

  private playMetaPlot(ov: HTMLElement, id: string) {
    const plot = this.metaPlots().find((p) => p.id === id);
    if (!plot || plot.empty) {
      this.openMetaBuilder(ov, id);
      return;
    }
    const idx = this.playables.findIndex((p) => p.id === plot.playableId);
    if (idx < 0) return;
    const currentPos = Math.round(this.pos);
    const currentIndex = this.indexForPos(currentPos);
    const forward = (idx - currentIndex + this.N) % this.N;
    const backward = forward - this.N;
    const step = Math.abs(backward) < forward ? backward : forward;
    const wasMounted = this.frames.has(idx);
    this.queueMetaVariantForIndex(idx, id);
    this.closeOverlay();
    window.setTimeout(() => {
      this.goTo(currentPos + step, true);
      if (wasMounted) {
        this.queueMetaVariantForIndex(idx, id);
        this.reloadFrame(idx);
      }
    }, 0);
  }

  private queueMetaVariantForIndex(idx: number, plotId: string) {
    const variant = this.metaVariants.get(plotId);
    if (!variant) {
      this.pendingSeriesParams.delete(idx);
      this.pendingLevels.delete(idx);
      return;
    }
    if (variant.series) this.pendingSeriesParams.set(idx, encodeURIComponent(JSON.stringify(variant.series)));
    else this.pendingSeriesParams.delete(idx);
    if (variant.level != null) this.pendingLevels.set(idx, variant.level);
    else this.pendingLevels.delete(idx);
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
    this.feedBarEl?.querySelectorAll('.feed-bar__icon--active')
      .forEach((el) => el.classList.remove('feed-bar__icon--active'));
    this.feedBarEl?.querySelector<HTMLElement>('[data-bar-tab="feed"]')
      ?.classList.add('feed-bar__icon--active');
    this.applyActiveStates();   // resume the background feed game
  }

  private callPlayableHostGesture(i: number): boolean {
    const api = this.playableApi(i);
    if (typeof api?.hostGesture !== 'function') return false;
    try { api.hostGesture(); return true; }
    catch { return false; }
  }

  private onPlatformPointerDown = (e: PointerEvent) => {
    if (!e.isTrusted) return;
    this.primePlatformAudio(this.realIndex());
  };

  private primePlatformAudio(preferredIndex: number = this.realIndex()): void {
    this.platformAudioPrimed = true;
    const ordered = new Set<number>();
    if (preferredIndex >= 0) ordered.add(preferredIndex);
    ordered.add(this.realIndex());
    this.frames.forEach((_frame, i) => ordered.add(i));
    for (const i of ordered) this.callPlayableHostGesture(i);
  }

  private unlockAudioForCurrentAndNext(fromIndex: number = this.realIndex(), includePrevious = false) {
    this.platformAudioPrimed = true;
    const current = ((fromIndex % this.N) + this.N) % this.N;
    const next = (current + 1) % this.N;
    this.primePlatformAudio(current);
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
    const policy = reserveAheadPolicy();
    let plannedBytes = 0;
    for (let d = 1; d <= policy.depth; d++) {
      const j = ((base + d) % this.N + this.N) % this.N;
      const estimatedBytes = mechanicPrefetchBytes(this.playables[j].id) ?? MIB;
      if (d > 1 && plannedBytes + estimatedBytes > policy.bytes) break;
      this.enqueuePrefetch(j);
      plannedBytes += estimatedBytes;
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
      // Fetch the exact cache-busted payload URL referenced by exported HTML;
      // omitting its ?v hash creates a distinct cache entry in WebViews.
      const id = this.playables[i].id;
      // priority:'low' (Chromium fetch-priority hint; ignored elsewhere) keeps
      // background bytes from competing with the warm iframe's own load.
      const lowPriority = { mode: 'no-cors', priority: 'low', cache: 'force-cache' } as RequestInit;
      Promise.allSettled([
        fetch(playableUrl(id, { hostPaused: true, auto: true }), lowPriority),
        fetch(playablePayloadUrl(id), lowPriority),
        ...mechanicAssetUrls(id).map((url) => fetch(url, lowPriority)),
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
    if (this.preloaderDone || this.preloaderFinishing) return;
    this.preloaderFinishing = true;
    const el = this.preloaderEl;
    const complete = () => {
      if (this.preloaderDone) return;
      this.preloaderDone = true;
      this.preloaderFinishing = false;
      // D3 guard metric: full opaque/fading cover lifetime (p95 < 0.5s).
      track('loader_visible', { ms: Math.round(performance.now() - this.preloaderMountedAt) });
      el?.remove();
      this.applyActiveStates();
      this.maybeShowChallengeIntro();
    };
    if (!el) {
      complete();
      return;
    }
    el.classList.add('preloader--hidden');
    el.addEventListener('transitionend', complete, { once: true });
    window.setTimeout(complete, 450);
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
    // Series win screen: the chest already paid out (no stars to collect), but if
    // that payout leveled the player up, ride the level-up ceremony in on this
    // swipe — reuse the reward drag (page held, level-up page prepared, null index).
    if (mode === 'feed' && this.seriesLevelUpPending !== null && this.seriesWinShown.has(current)) {
      this.dragMode = 'reward';
      this.rewardDragIndex = null;
      this.dragAllowsBack = false;
      this.prepareLevelUpPage(this.seriesLevelUpPending, Math.round(this.basePos));
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
    // A real upward direction is the mount boundary for heavy next mechanics.
    // Plain taps and sub-slop finger noise never create an iframe. An active
    // series cannot page away, so it must not trigger unrelated work either.
    if (dy <= -MIN_SWIPE_INTENT_PX && !(this.series && this.series.playing)) {
      const next = this.indexForPos(Math.round(this.basePos) + 1);
      this.mountIntentTarget(next);
    }
    // Reward-collect drags don't scroll the page: the win star must stay PUT so the
    // collect flight starts from its resting spot (and pulses there) instead of
    // riding the finger upward first. The flick threshold still uses dy/velocity.
    if (this.dragMode === 'reward') return;
    const rawProgress = -dy / this.pageH;         // drag up → positive → next; drag down → negative → previous
    const pageProgress = this.dragAllowsBack
      ? Math.max(-1, Math.min(1, rawProgress))
      : Math.max(0, Math.min(1, rawProgress));
    this.pos = this.basePos + pageProgress;
    this.queueDragRender();
    // Fade the (fixed) series row OUT while the page swipes — it re-fades IN for the
    // mechanic that settles (markUnitShown → renderSeriesRow) or on snap-back (onUp).
    if (!this.seriesRowDragHidden && this.seriesRowEl && Math.abs(pageProgress) > 0.03) {
      this.seriesRowDragHidden = true;
      this.seriesRowEl.classList.remove('series-row--in');
    }
  }

  /** One render per animation frame no matter how fast pointermove fires. The
   *  `dragging` guard drops a frame queued just before onUp so it can't stomp
   *  the settle animation with a stale transition-less render. */
  private queueDragRender() {
    if (this.dragRenderQueued) return;
    this.dragRenderQueued = true;
    requestAnimationFrame(() => {
      this.dragRenderQueued = false;
      if (this.dragging && this.dragMode !== 'reward') this.render(false);
    });
  }

  private onUp(e: PointerEvent, surface: HTMLElement) {
    if (!this.dragging) return;
    this.dragging = false;
    try { surface.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    // Warm prepare parked during the drag resumes now — if the drag commits,
    // the target index would stop deferring anyway (settling/liveHold).
    this.flushDeferredWarmPrepare();

    // Series row was faded out for this swipe → fade it back in once the page settles.
    // markUnitShown re-renders it on a unit change; this also covers a snap-back to
    // the same mechanic (no unit change). Idempotent.
    if (this.seriesRowDragHidden) {
      this.seriesRowDragHidden = false;
      window.setTimeout(() => {
        const current = this.realIndex();
        if (!this.series && this.shownIndex !== current && !this.frameRevealed.has(current)) {
          this.removeSeriesRow(true);
          return;
        }
        this.renderSeriesRow();
      }, 360);
    }

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
        this.goTo(commitBasePos + (step > 0 ? step : 1), false, commitBasePos);
      } else {
        this.levelUpPageState = 'settled';
        this.goTo(commitBasePos, false, commitBasePos);
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
      // Series win: no stars to collect (the chest paid out), so just ride the
      // level-up ceremony page in. A further swipe/tap on it advances to the next
      // game (mode 'levelup'). The pill is done — dismiss it as the ceremony opens.
      const seriesLevelUpEntering =
        rewardIndex === null && this.levelUpPageState === 'entering' && this.levelUpPageEl !== null;
      if ((step > 0 || tapToAdvance) && seriesLevelUpEntering) {
        this.seriesLevelUpPending = null;
        this.dismissChallengePill();
        this.unlockAudioForCurrentAndNext(fromIndex);
        this.animateLevelUpPageIn();
        return;
      }
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
          this.slideToNext(rewardIndex, commitBasePos + 1, commitBasePos);
        }
        return;
      }
      this.removeLevelUpPage();
      this.goTo(commitBasePos + step, false, commitBasePos);
      return;
    }

    this.dragMode = 'feed';
    this.rewardDragIndex = null;
    const autoplayTapIndex = this.dragAutoplayIndex;
    this.dragAutoplayIndex = null;
    this.dragAllowsBack = false;
    if (step === 0 && autoplayTapIndex !== null && !movedPastTap) {
      this.unlockAudioForCurrentAndNext(autoplayTapIndex, true);
      this.goTo(commitBasePos, false, commitBasePos);
      if (this.HOLD_COVER && !this.holdReleased.has(autoplayTapIndex)) {
        // TEMP: first tap RELEASES the held cover → start autoplay + fade the poster
        // (NOT a takeover to manual), so the live autoplay frame can be screenshotted.
        this.holdReleased.add(autoplayTapIndex);
        this.games[autoplayTapIndex]?.classList.add('game--live');
        this.ensureFrameAutoPlay(autoplayTapIndex);
        this.pollAutoplayUi();
        return;
      }
      this.activateManualFromAutoplay(autoplayTapIndex);
      return;
    }
    // Held level-up overlay: a plain tap (not just a swipe) dismisses it and advances.
    if (this.heldLevelUpOverlay && step === 0 && !movedPastTap) {
      this.unlockAudioForCurrentAndNext(fromIndex);
      this.releaseHeldLevelUp();
      this.goTo(commitBasePos + 1, false, commitBasePos);
      return;
    }
    // During an in-progress series, a swipe never pages away — only the × exits
    // (breaks the series). Snap back in place.
    if (this.series && this.series.playing && step !== 0) {
      this.goTo(commitBasePos, false, commitBasePos);
      return;
    }
    if (step !== 0 && autoplayTapIndex !== null) {
      this.prepareAutoplayNavigationTarget(this.indexForPos(commitBasePos + step));
    }
    if (step !== 0) this.unlockAudioForCurrentAndNext(fromIndex, allowsBack);
    if (step > 0) this.releaseHeldLevelUp();
    this.goTo(commitBasePos + step, false, commitBasePos);
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
    if (this.handleCatalogPlayerMessage(i, e)) return;
    const d = e.data as Record<string, unknown> | null;
    if (d && typeof d === 'object' && d.source === 'playable' && d.type === 'boot_timings') {
      this.handleBootTimings(i, d);
      return;
    }
    if (this.isPlayableStaticReadyMessage(e.data)) {
      this.handlePlayableStaticReady(i);
      return;
    }
    const manualAction = this.manualActionFromMessage(e.data);
    if (manualAction) {
      this.recordControlPlaneManualAction(i, manualAction);
      return;
    }
    if (this.isPlayableReadyMessage(e.data)) {
      this.handlePlayableReady(i, this.isPlayableInteractiveReadyMessage(e.data));
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

  private handleCatalogPlayerMessage(i: number, event: MessageEvent): boolean {
    const slot = this.catalogSlotForIndex(i);
    const session = slot?.session;
    if (!slot || !session || this.frames.get(i)?.dataset.catalogPlayerV2 !== '1') return false;
    const data = event.data as Record<string, unknown> | null;
    const type = data && typeof data === 'object' ? String(data.type ?? '') : '';
    if (['configure_ready', 'configured', 'configure_failed'].includes(type)) {
      const transition = session.handleMessage({
        source: event.source,
        origin: event.origin,
        data: event.data,
      }, slot.frameEpoch);
      this.applyCatalogPlayerEffects(slot, transition.effects);
      if (session.snapshot().phase === 'configured') this.markCatalogConfigured(slot);
      return true;
    }
    if (slot.canaryProjectionRequired) return true;
    // No gameplay/readiness signal is accepted before the exact configured ACK.
    return session.snapshot().phase !== 'configured';
  }

  private applyCatalogPlayerEffects(slot: CatalogFeedSlot, effects: readonly CatalogPlayerEffect[]): void {
    if (!this.catalogSlotIsCurrent(slot)) return;
    for (const effect of effects) {
      if (effect.frameEpoch !== slot.frameEpoch) continue;
      if (effect.type === 'post_configure_level') {
        try {
          this.frames.get(slot.index)?.contentWindow?.postMessage(effect.message, effect.targetOrigin);
        } catch {
          this.failCatalogConfiguration(slot, 'contract');
        }
      } else if (effect.type === 'catalog_configuration_failure') {
        if (!slot.failureEmitted) {
          const eventId = queueControlPlaneEvent(
            slot.session?.binding.skinHash
              ? 'catalog_configuration_failure_v2'
              : 'catalog_configuration_failure',
            effect.payload,
            new Date().toISOString(),
          );
          if (eventId) slot.failureEmitted = true;
        }
        this.activateCatalogBuiltinFallback(slot, `configuration_${effect.payload.reason}`);
      } else if (effect.type === 'catalog_reveal_ready') {
        this.emitCatalogLevelImpression(slot);
      }
    }
  }

  private markCatalogConfigured(slot: CatalogFeedSlot): void {
    const i = slot.index;
    if (!this.catalogSlotIsCurrent(slot) || this.frameReady.has(i)) return;
    // Another tab may already have committed this canary closure even when our
    // GET originally said replayed=false. Exact configured pixels may reveal
    // (making the upcoming impression truthful), but the runtime stays paused
    // and non-interactive until the specialized impression is projected.
    if (slot.configurationTimer !== null) window.clearTimeout(slot.configurationTimer);
    slot.configurationTimer = null;
    this.frameStaticReady.add(i);
    this.frameReady.add(i);
    if (!slot.canaryProjectionRequired) this.frameInteractiveReady.add(i);
    if (!slot.canaryProjectionRequired && this.manualRuns.has(i)) {
      const runId = this.frames.get(i)?.dataset.runId;
      const ticket = runId ? this.ticketForRun(i, runId) : null;
      if (runId && ticket) this.registerControlPlaneAttempt(i, runId, ticket);
    }
    this.applyActiveStates();
    this.tryRevealFrame(i);
    this.ensureFrameAutoPlay(i);
    this.applyPendingEditor(i);
  }

  private failCatalogConfiguration(slot: CatalogFeedSlot, reason: CatalogFailureReason): void {
    if (!this.catalogSlotIsCurrent(slot) || !slot.session) return;
    const transition = slot.session.fail(reason, slot.frameEpoch);
    this.applyCatalogPlayerEffects(slot, transition.effects);
  }

  private revealCatalogLevel(slot: CatalogFeedSlot): void {
    if (!this.catalogSlotIsCurrent(slot) || !slot.session
      || slot.phase !== 'catalog_mounted' || !this.feedActuallyVisible(slot.index)) return;
    const transition = slot.session.setVisible(true, slot.frameEpoch);
    this.applyCatalogPlayerEffects(slot, transition.effects);
  }

  private emitCatalogLevelImpression(slot: CatalogFeedSlot): void {
    const exposure = slot.exposure;
    const session = slot.session;
    if (!session || !this.catalogSlotIsCurrent(slot) || !this.feedActuallyVisible(slot.index)) return;
    let level = exposure.levels.get(slot.ordinal);
    if (!level) {
      level = {
        levelImpressionId: ticketUid(),
        levelIndex: slot.ordinal,
        occurredAt: new Date().toISOString(),
        emitted: false,
      };
      exposure.levels.set(slot.ordinal, level);
    }
    if (level.emitted) return;
    const eventId = queueControlPlaneEvent(
      session.binding.skinHash
        ? 'catalog_level_impression_v2'
        : 'catalog_level_impression',
      buildCatalogLevelImpression(session.binding, exposure.impressionId, level.levelImpressionId),
      level.occurredAt,
    );
    if (!eventId) return;
    level.emitted = true;
    if (slot.canaryProjectionRequired) {
      if (slot.configurationTimer !== null) window.clearTimeout(slot.configurationTimer);
      slot.configurationTimer = window.setTimeout(() => {
        this.activateCatalogBuiltinFallback(slot, 'catalog_control_plane_unconfirmed', true);
      }, 2500);
      void this.confirmCanaryCatalogProjection(slot, eventId, level);
      return;
    }
    this.commitCatalogLevelImpression(slot, level);
    this.watchCatalogControlPlaneConflict(slot, eventId);
  }

  private commitCatalogLevelImpression(slot: CatalogFeedSlot, level: ControlPlaneLevel): void {
    const exposure = slot.exposure;
    if (!this.catalogSlotIsCurrent(slot) || level.levelIndex !== slot.ordinal) return;
    exposure.revealedAt ??= level.occurredAt;
    exposure.impressionEmitted = true;
    this.frameInteractiveReadyAt.set(slot.index, level.occurredAt);
    for (const attempt of this.cpAttempts.values()) {
      if (attempt.exposure === exposure) this.flushControlPlaneAttempt(attempt);
    }
  }

  private async confirmCanaryCatalogProjection(
    slot: CatalogFeedSlot,
    eventId: string,
    level: ControlPlaneLevel,
  ): Promise<void> {
    for (const delay of [0, 120, 360, 900]) {
      if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
      if (!this.catalogSlotIsCurrent(slot) || !slot.canaryProjectionRequired) return;
      await flushControlPlane({ force: true });
      if (!this.catalogSlotIsCurrent(slot) || !slot.canaryProjectionRequired) return;
      const receipt = controlPlaneEventReceiptStatus(eventId);
      if (receipt === 'projected') {
        slot.canaryProjectionRequired = false;
        if (slot.configurationTimer !== null) window.clearTimeout(slot.configurationTimer);
        slot.configurationTimer = null;
        this.commitCatalogLevelImpression(slot, level);
        this.frameInteractiveReady.add(slot.index);
        this.applyActiveStates();
        this.ensureFrameAutoPlay(slot.index);
        this.applyPendingEditor(slot.index);
        return;
      }
      if (['stored', 'pending_dependency', 'rejected'].includes(receipt)) {
        this.activateCatalogBuiltinFallback(
          slot,
          receipt === 'rejected'
            ? 'catalog_control_plane_conflict'
            : `catalog_control_plane_${receipt}`,
          true,
        );
        return;
      }
    }
    this.activateCatalogBuiltinFallback(slot, 'catalog_control_plane_unconfirmed', true);
  }

  private watchCatalogControlPlaneConflict(slot: CatalogFeedSlot, eventId: string): void {
    void flushControlPlane({ force: true }).then(() => {
      if (controlPlaneEventState(eventId) === 'rejected') {
        this.activateCatalogBuiltinFallback(slot, 'catalog_control_plane_conflict', true);
      }
    });
  }

  private onHostGesture = (playableId?: string) => {
    const current = this.realIndex();
    const i = playableId && this.effectivePlayableId(current) !== playableId
      ? this.playables.findIndex((p) => p.id === playableId)
      : current;
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
    return d.source === 'playable' && (type === 'interactive_ready' || type === 'ready' || type === 'loaded');
  }

  private isPlayableInteractiveReadyMessage(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    return d.source === 'playable' && String(d.type ?? '').toLowerCase() === 'interactive_ready';
  }

  private manualActionFromMessage(data: unknown): ControlPlaneManualAction | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (d.source !== 'playable' || d.type !== 'manual_action') return null;
    if (!Number.isSafeInteger(d.actionSeq) || Number(d.actionSeq) < 0) return null;
    if (typeof d.actionType !== 'string' || d.actionType.length < 1 || d.actionType.length > 96) return null;
    if (typeof d.accepted !== 'boolean' || typeof d.changedState !== 'boolean') return null;
    return {
      actionSeq: Number(d.actionSeq),
      actionType: d.actionType,
      accepted: d.accepted,
      changedState: d.changedState,
    };
  }

  private isPlayableStaticReadyMessage(data: unknown): boolean {
    if (!data || typeof data !== 'object') return false;
    const d = data as Record<string, unknown>;
    return d.source === 'playable' && String(d.type ?? '').toLowerCase() === 'static_ready';
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
    const mechanicId = this.effectivePlayableId(i);
    const attemptTimeMs = this.solveMsFor(i);
    this.recordControlPlaneAttemptResult(i, runId, outcome === 'won' ? 'win' : 'lose', attemptTimeMs);
    if (outcome === 'won') {
      const solveMs = attemptTimeMs;
      track('win', { mechanic_id: mechanicId, mode: 'manual', time_ms: solveMs }, runId);
      // Series owns the win: no per-level reward or challenge pill — it advances the
      // series (and pays out only at the chest).
      if (this.series && this.series.index === i) {
        this.handleSeriesWin(i, runId, solveMs);
      } else {
        const resultPromise = this.reportResult(i, runId, solveMs);
        this.handleWin(i);
        this.onManualWinChallenge(i, solveMs, runId, resultPromise);
      }
    } else {
      track('lose', { mechanic_id: mechanicId, mode: 'manual' }, runId);
      // In a series, a loss on ANY level restarts the whole series from level 1
      // (with a "so close, try again" beat). Outside a series, the normal loss state.
      if (this.series && this.series.index === i) this.handleSeriesFail(i);
      else this.handleLoss(i);
    }
  }

  // Series loss: reset to level 1 and replay the whole run, masked by a short
  // "so close" congratulation so the reboot doesn't flash the mechanic's intro.
  private handleSeriesFail(i: number): void {
    if (!this.series || this.series.index !== i) { this.handleLoss(i); return; }
    track('series_fail', { mechanic_id: this.effectivePlayableId(i), level: this.series.done + 1 });
    // Retry the CURRENT level, not the whole series — `done` (levels already
    // cleared) is preserved, so advanceSeriesInPlace relaunches level `done + 1`.
    this.series.playing = true;
    this.renderSeriesRow();
    this.manualRuns.delete(i);
    this.showSeriesRetry();
    window.setTimeout(() => {
      if (!this.series || this.series.index !== i || !this.series.playing) return;
      this.advanceSeriesInPlace(i);   // done unchanged → relaunches the current level
      this.awaitSeriesLevelReady(i);
    }, 700);
  }

  // "So close — try again" overlay shown when a series run is lost (reuses the
  // between-levels transition styling).
  private showSeriesRetry(): void {
    if (!this.seriesTransitionEl) {
      const el = document.createElement('div');
      el.className = 'series-transition';
      this.viewport.appendChild(el);
      this.seriesTransitionEl = el;
    }
    this.seriesTransitionEl.innerHTML =
      `<div class="series-transition__praise">Почти получилось!</div>` +
      `<div class="series-transition__sub">Это было близко — попробуй ещё раз!</div>` +
      `<div class="series-transition__next">Перезапускаем уровень…</div>`;
    requestAnimationFrame(() => this.seriesTransitionEl?.classList.add('series-transition--in'));
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
    // The series-end win screen is rendered directly (0-star, real buttons) — don't
    // let the normal state machine hide/re-render over it.
    if (this.seriesWinShown.has(i)) return;

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
    this.manualStartMs.set(i, performance.now());   // fresh solve-time clock
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
    this.manualStartMs.set(i, performance.now());   // fresh solve-time clock
    const swipe = this.playableApi(i)?.swipe;
    if (swipe?.hasRestart) {
      // In-place restart keeps the frame → give it a fresh run id so the next
      // completion isn't deduped away by completedRunIds.
      const frame = this.frames.get(i);
      if (frame) {
        const oldRun = frame.dataset.runId;
        if (oldRun) this.completedRunIds.delete(oldRun);
        const runId = runUid();
        frame.dataset.runId = runId;
        this.ticketForRun(i, runId);
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
      const u = this.makeStarUnit(unitPx);
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

    // A catalog authorization is a finite, server-owned series. Once its chest has
    // been earned the ticket cannot be replayed or extended locally, so the primary
    // action must leave the unit instead of manufacturing an extra ordinal.
    const completedCatalogSeries = Boolean(
      this.series?.index === i
      && this.series.catalog
      && this.series.done >= this.seriesLen(),
    );
    const replay = this.rewardButton(
      completedCatalogSeries ? '↑' : '↻',
      completedCatalogSeries ? 'Next mechanic' : 'Replay',
      'reward__action--replay',
    );
    replay.addEventListener('click', () => {
      if (!completedCatalogSeries) {
        this.replayManual(i);
        return;
      }
      this.seriesWinShown.delete(i);
      this.clearSeriesUi();
      this.series = null;
      this.advanceToNext();
    });
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
    if (!this.rewardStars[i]) this.rollReward(i, this.frames.get(i)?.dataset.runId);
    return this.rewardStars[i] || 1;
  }

  // The visual roll mirrors the backend's deterministic 1–5 reward for this run.
  private rollReward(i: number, runId?: string): void {
    this.rewardStars[i] = runId ? levelStarReward(runId) : 1;
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
  private slideToNext(leavingIdx: number, advanceToPos: number, fromPos?: number) {
    this.holdNextAutoplay = true;
    const arrivingIdx = this.indexForPos(advanceToPos);
    this.games[arrivingIdx]?.classList.add('game--arriving');
    this.games[leavingIdx]?.classList.add('game--leaving');
    this.goTo(advanceToPos, false, fromPos);
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
      p.style.zIndex = '2725';   // above the chest scrim (2700) so the collect splash isn't dimmed
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

  // Puzzle counter (top-right): value + a squash pulse when a puzzle lands, matching
  // the level badge's absorb reaction.
  private updatePuzzleCounter() {
    if (this.puzzleValueEl) this.puzzleValueEl.textContent = String(this.totalPuzzles);
  }

  private bumpPuzzleBadge() {
    const el = this.puzzleBadgeEl;
    if (!el) return;
    if (!el.animate) {
      el.classList.remove('hud__puzzles--bump');
      void el.offsetWidth;
      el.classList.add('hud__puzzles--bump');
      window.setTimeout(() => el.classList.remove('hud__puzzles--bump'), 440);
      return;
    }
    const P = 0.16, H = 0.707 * P;
    this.puzzleBadgeSquash?.cancel();
    this.puzzleBadgeSquash = el.animate([
      { transform: 'scale(1, 1)' },
      { transform: `scale(${1 + H}, ${1 - H})`, offset: 0.25 },
      { transform: `scale(${1 + P}, ${1 - P})`, offset: 0.5 },
      { transform: `scale(${1 + H}, ${1 - H})`, offset: 0.75 },
      { transform: 'scale(1, 1)' },
    ], { duration: 220, easing: 'linear' });
  }

  // Collections button (bottom bar): scale-pop when a card tucks in.
  private bumpCollectionsBtn() {
    const el = this.collectionsBtnEl;
    if (!el) return;
    el.classList.remove('feed-bar__icon--bump');
    void el.offsetWidth;
    el.classList.add('feed-bar__icon--bump');
    window.setTimeout(() => el.classList.remove('feed-bar__icon--bump'), 440);
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
    this.renderSeriesRow();   // level-up overlay is up → drop any preview panel behind it
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
    this.planGeneratedInsertion();
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
  goTo(targetPos: number, instant: boolean = false, navigationFromPos?: number) {
    // During a long pointer drag `this.pos` can already round to the target page
    // before pointerup.  The visual interpolation must keep that fractional pos,
    // but the navigation commit (exit/source decision) still belongs to the page
    // where the gesture started.  Callers from onUp pass that stable base pos.
    const fromPos = navigationFromPos ?? Math.round(this.pos);
    const fromIndex = this.indexForPos(fromPos);
    const targetIndex = this.indexForPos(targetPos);
    const changed = targetPos !== this.pos;
    const pageChanged = targetIndex !== fromIndex;
    if (changed && pageChanged) {
      // This is the navigation commit. Close the source now even when the
      // target stalls before reveal: that target is issued-without-seen, while
      // the source still has an honest swipe exit instead of a later close.
      this.closeControlPlaneExposure('swipe', false);
      const targetPlayableId = this.playables[targetIndex]?.id;
      if (targetPlayableId) this.beginControlPlaneDecision(targetIndex, targetPlayableId);
      // Every settled navigation is an additive factory opportunity.  This is
      // intentionally independent of whether the target built-in has already
      // received its own reviewed control-plane mapping.
      this.scheduleGeneratedOfferPrefetch();
      if (!this.series) this.removeSeriesRow(true);
      this.clearWarmTimer();
      this.warmIndex = null;
      this.liveHold = new Set([fromIndex, targetIndex]);
      this.settlingTargetIndex = targetIndex;
      // Programmatic advances have no pointer-move intent signal. Start their
      // target navigation at commit; the host poster carries the transition.
      if (this.warmNextEnabled) this.updateLive();
      this.stopRewardSparks(fromIndex);
      if (this.isForwardCycleWrap(fromPos, targetPos)) this.resetCycleAfterSettle = true;
      // Live-ride teleport for PROGRAMMATIC advances (× / ▲ button / post-win):
      // the parked-in-viewport page sits at translateY(0) already — animating
      // "to 0" would show no ride. Recompute it at its normal off-screen
      // offset first (settlingTargetIndex is set, so the park override is off)
      // and force the style flush; the animated pass below then rides it in.
      if (!instant) {
        const savedPos = this.pos;
        this.pos = fromPos;
        this.render(false);
        // The resident COVER layer is parked at translateY(0) too (in-viewport,
        // hidden under the opaque current page). A gesture ride works because
        // dragging mirrors the arriving page's offset frame by frame, so the
        // layer has a flushed off-screen position before the settle animation.
        // A programmatic slide has no drag phase: the ride target ≈ the parked
        // spot, so the cover POPPED to the final position at z:1010 instantly,
        // covering the pages while they animated underneath (visible snap on
        // the × path; post-win the reward flyover masked it). Teleport it to
        // the arriving page's off-screen offset first; the flush below commits
        // it, and the animated pass rides it in like a swipe.
        if (this.incomingIndex === targetIndex && this.incomingEl) {
          this.incomingEl.style.transition = 'none';
          this.incomingEl.style.transform =
            this.pageTransformState[targetIndex] || `translate3d(0, ${this.pageH}px, 0)`;
          this.incomingEl.style.zIndex = '1010';
        }
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
    // Slot aspect may have crossed the bucket threshold (rotate/resize) — re-pick
    // the cover bucket; if it flipped, pickCoverBucket refetches covers itself.
    this.pickCoverBucket();
    // Slot geometry changed with the viewport — re-measure the resident
    // poster layer's box (force by resetting the identity guard).
    this.incomingIndex = -1;
    this.updateIncomingPoster();
  };
}

export function createFeed(
  viewport: HTMLElement,
  feedEl: HTMLElement,
  challenge: ChallengeView | null = null,
  publicIsland: PublicIslandView | null = null,
) {
  let order = PLAYABLES;
  let ch = challenge;
  // Arriving via a challenge deep-link: put the challenged mechanic first so the
  // recipient lands right on it (no runtime pager surgery). If it isn't in the
  // feed, ignore the challenge and boot normally.
  if (ch) {
    const idx = PLAYABLES.findIndex((p) => p.id === ch!.mechanic_id);
    if (idx > 0) order = [PLAYABLES[idx], ...PLAYABLES.slice(0, idx), ...PLAYABLES.slice(idx + 1)];
    else if (idx < 0) ch = null;
  }
  return new Feed(viewport, feedEl, order, ch, publicIsland);
}
