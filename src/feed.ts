import { PLAYABLES, playableUrl, type Playable } from './playables';

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

const LIVE_AHEAD = 0;              // explicit warm-next scheduling below owns ahead iframe lifetime
const LIVE_BEHIND = 0;             // back-swipe is disabled, so no idle previous iframe
const RESERVE_AHEAD = 0;           // byte-prefetching big HTMLs heated phones without preparing iframes
const INITIAL_BATCH = 1;           // get the first mechanic visible; warm-next starts after it settles
const PRELOADER_TIMEOUT_MS = 15000;
const ANALYTICS_POLL_MS = 1000;    // fallback for older non-SWIPE exports
const FRAME_READY_FALLBACK_MS = 900;
const FRAME_REVEAL_DELAY_MS = 90;
const WARM_NEXT_DELAY_MS = 900;    // let the current game paint/play before parsing the next bundle
const WARM_NEXT_IDLE_TIMEOUT_MS = 1800;
const LEVEL_PROGRESS_MS = 340;
const STARS_PER_LEVEL = 5;

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
  restart: () => void;
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
  private starsPerLevel: number;

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
  private gutters: HTMLElement[] = [];
  private stateEls: HTMLElement[] = [];
  private autoplayEls: HTMLElement[] = [];
  private swipebarTextEls: HTMLElement[] = [];
  private labelEls: HTMLElement[] = [];
  private labelTimers = new Map<number, number>();
  private frames = new Map<number, HTMLIFrameElement>();
  private runSeq = 0;
  private completedRunIds = new Set<string>();
  private liveHold = new Set<number>();
  private settlingTargetIndex: number | null = null;
  private resetCycleAfterSettle = false;
  private warmIndex: number | null = null;
  private warmTimer: number | null = null;
  private frameLoaded = new Set<number>();
  private frameReady = new Set<number>();
  private frameRevealed = new Set<number>();
  private frameFallbackTimers = new Map<number, number>();
  private frameRevealTimers = new Map<number, number>();

  private totalStars = 0;
  private earnedThisCycle = new Set<number>();
  private failedThisCycle = new Set<number>();
  private pendingStarRewards = new Set<number>();
  private claimedStarRewards = new Set<number>();
  private hudEl: HTMLElement | null = null;
  private storiesEl: HTMLElement | null = null;
  private storiesMomentumFrame: number | null = null;
  private levelBadgeEl: HTMLElement | null = null;
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
    this.starsPerLevel = STARS_PER_LEVEL;
    this.initialTarget = Math.min(INITIAL_BATCH, this.N);
    this.build();
    this.mountHud();
    this.measure();
    this.render(false);
    this.updateMechanicStates();
    this.updateHud(false);
    this.mountPreloader();

    // After a slide settles: normalise the ring position, resume the arrived
    // game and pause the rest. transitionend bubbles up from the pages.
    this.feedEl.addEventListener('transitionend', (e) => {
      if (e.propertyName !== 'transform' || this.dragging) return;
      if (this.levelUpPageState === 'entering') {
        this.settleLevelUpPage();
        return;
      }
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
      this.scheduleWarmNext();
      this.prefetchReserve();
      this.pumpPrefetchQueue();
      if (leavingLevelUp) this.removeLevelUpPage();
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

      const spinner = document.createElement('div');
      spinner.className = 'game__spinner';
      game.appendChild(spinner);

      const label = document.createElement('div');
      label.className = 'game__label';
      label.textContent = p.id;
      game.appendChild(label);

      // Full-screen dim over the GAME AREA (inset above the swipe bar) shown only
      // while autoplay runs — a "this is a demo" veil that also captures tap-anywhere
      // to take over. The label itself lives in the swipe bar below.
      const autoplay = document.createElement('div');
      autoplay.className = 'game__autoplay';
      autoplay.dataset.autoplayIndex = String(i);
      this.attachSwipeSurface(autoplay);
      game.appendChild(autoplay);

      // Reserved dark bar BELOW the game (slot/overlays are inset above it). Left
      // EMPTY for now — buttons land here later. It stays the swipe surface; a swipe
      // here pages (and collects a pending reward, via preferReward). dataset
      // .autoplayIndex lets a tap take over during autoplay.
      const swipebar = document.createElement('div');
      swipebar.className = 'game__swipebar';
      swipebar.dataset.autoplayIndex = String(i);
      this.attachSwipeSurface(swipebar, () => true, true);
      game.appendChild(swipebar);

      // Slowly-blinking hint text, floating ABOVE the bar (not inside it). Label
      // switches by mode in pollAutoplayUi. Purely visual (pointer-events: none).
      const swipeHint = document.createElement('div');
      swipeHint.className = 'game__swipehint';
      swipeHint.textContent = 'tap to play or swipe for next game';
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
        const transform = `translate3d(0, ${delta * this.pageH}px, 0)`;
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
    return Math.floor((this.totalStars + 1) / this.starsPerLevel) + 1;
  }

  private levelUpMarkup(level: number): string {
    return '<div class="levelup__card">' +
      '<div class="levelup__kicker">LEVEL UP</div>' +
      '<div class="levelup__badge"><span class="levelup__star">★</span><span class="levelup__num">' + level + '</span></div>' +
      '<div class="levelup__title">Level ' + level + '</div>' +
    '</div>';
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
    this.resetFrameReadiness(i);
    this.games[i].classList.add('game--loading');
    this.games[i].classList.remove('game--ready');
    const frame = document.createElement('iframe');
    frame.className = 'game__frame';
    frame.dataset.runId = String(++this.runSeq);
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('title', this.playables[i].id);
    frame.setAttribute('allow', 'autoplay');
    frame.addEventListener('load', () => {
      if (this.frames.get(i) !== frame) return;
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
    this.slots[i].appendChild(frame);
  }

  private unmount(i: number) {
    const frame = this.frames.get(i);
    if (!frame) return;
    const runId = frame.dataset.runId;
    if (runId) this.completedRunIds.delete(runId);
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
    const fallbackTimer = this.frameFallbackTimers.get(i);
    if (fallbackTimer) window.clearTimeout(fallbackTimer);
    this.frameFallbackTimers.delete(i);
    const revealTimer = this.frameRevealTimers.get(i);
    if (revealTimer) window.clearTimeout(revealTimer);
    this.frameRevealTimers.delete(i);
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
      this.games[i].classList.remove('game--loading');
      this.games[i].classList.add('game--ready');
      this.markReady(i);
      this.ensureFrameAutoPlay(i);
      this.applyPendingEditor(i);
      if (i === this.realIndex()) this.scheduleWarmNext();
    }, FRAME_REVEAL_DELAY_MS);
    this.frameRevealTimers.set(i, timer);
  }

  private canRevealFrame(i: number): boolean {
    if (!this.shouldPauseFrame(i)) return true;
    // A warm or incoming page is paused on purpose, but it is safe to remove the
    // spinner while it is off-screen/settling so the eventual swipe is seamless.
    return this.warmIndex === i || this.liveHold.has(i);
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
      if (!paused) this.ensureFrameAutoPlay(i);
    } catch {
      /* cross-origin or not ready — leave as-is */
    }
  }

  private ensureFrameAutoPlay(i: number) {
    if (this.manualRuns.has(i) || this.shouldPauseFrame(i)) return;
    // While a reward star is still flying to the counter, hold off starting the
    // next mechanic's autoplay — it kicks in once the collect finishes (afterCollect).
    if (this.collectingRewardIndex !== null) return;
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
        try { swipe.restart(); } catch { /* cross-origin */ }
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
    if (this.settlingTargetIndex === i) return true;
    return i !== this.realIndex() || (this.earnedThisCycle.has(i) && !this.manualRuns.has(i)) || this.failedThisCycle.has(i);
  }

  private desiredWarmIndex(): number | null {
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
  }

  private scheduleWarmNext() {
    this.clearWarmTimer();
    const next = this.desiredWarmIndex();
    if (next === null) return;
    if (this.warmIndex === next && this.frames.has(next)) return;
    this.warmTimer = window.setTimeout(() => {
      this.warmTimer = null;
      this.scheduleIdlePrefetch(() => this.startWarmNext(next), WARM_NEXT_IDLE_TIMEOUT_MS);
    }, WARM_NEXT_DELAY_MS);
  }

  private startWarmNext(expected: number) {
    if (this.desiredWarmIndex() !== expected) {
      this.scheduleWarmNext();
      return;
    }
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
    for (let i = 0; i < this.N; i++) {
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

      // Swipe bar label: only the autoplay/attract state offers "tap to play"
      // (tapping takes over the demo); once the player is playing, has won, or has
      // failed, tapping does nothing new — so it's swipe-only.
      const txt = this.swipebarTextEls[i];
      const label = active ? 'tap to play or swipe for next game' : 'swipe for next game';
      if (txt && txt.textContent !== label) txt.textContent = label;

      // Manual play (taken over, not won/failed): show the close (×) → next.
      const manualPlaying = isCurrent && manual && !paused
        && !this.earnedThisCycle.has(i) && !this.failedThisCycle.has(i);
      this.games[i]?.classList.toggle('game--manual', manualPlaying);
    }
  };

  // Advance forward one mechanic (the close × and any "skip" affordance use this).
  private advanceToNext() {
    if (this.dragging) return;
    const base = Math.round(this.pos);
    this.unlockAudioForCurrentAndNext(this.indexForPos(base));
    this.releaseHeldLevelUp();
    this.goTo(base + 1);
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
  private prefetchReserve() {
    const base = this.realIndex();
    for (let d = 1; d <= RESERVE_AHEAD; d++) {
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
      fetch(playableUrl(this.playables[i].id, { hostPaused: true, auto: true }), { mode: 'no-cors' })
        .then(() => this.markReady(i))
        .catch(() => this.markReady(i))
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
    const requestIdleCallback = (window as any).requestIdleCallback as
      | undefined
      | ((callback: () => void, options?: { timeout: number }) => number);
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout });
      return;
    }
    window.setTimeout(fn, 120);
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
    if (this.ready.size >= this.initialTarget) this.finishPreloader();
  }

  private finishPreloader() {
    if (this.preloaderDone) return;
    this.preloaderDone = true;
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
      if (step > 0) {
        this.levelUpPageState = 'leaving';
        this.unlockAudioForCurrentAndNext(fromIndex);
        this.goTo(commitBasePos + step);
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
        this.collectReward(rewardIndex);
        if (willShowLevelUp) this.animateLevelUpPageIn();
        else this.goTo(commitBasePos + 1);
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
      const history = this.playableApi(i)?.getAnalyticsHistory?.();
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
    if (i !== this.realIndex() || !runId || this.completedRunIds.has(runId)) return;
    this.completedRunIds.add(runId);

    if (outcome === 'won') this.handleWin(i);
    else this.handleLoss(i);
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

  private renderRewardState(i: number, state: HTMLElement) {
    const icon = this.renderResultState(i, state, '★', 'reward__star');
    // Readable affordance on the win screen (sits in the centred content, well above
    // the bar). Both a tap and a swipe collect + advance.
    const hint = document.createElement('div');
    hint.className = 'reward__hint';
    hint.textContent = 'tap or swipe for next game';
    state.appendChild(hint);
    this.startRewardSparks(i, icon);
  }

  private renderFailedState(i: number, state: HTMLElement) {
    this.renderResultState(i, state, '↻', 'reward__star reward__star--retry');
  }

  private renderResultState(i: number, state: HTMLElement, iconText: string, iconClass: string): HTMLElement {
    const reward = document.createElement('div');
    reward.className = 'reward';

    const icon = document.createElement('div');
    icon.className = iconClass;
    icon.textContent = iconText;
    reward.appendChild(icon);

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

    return icon;
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

  private collectReward(i: number) {
    if (!this.pendingStarRewards.has(i) || this.collectingRewardIndex !== null) return false;
    this.collectingRewardIndex = i;
    this.stopRewardSparks(i);

    const state = this.stateEls[i];
    const source = state?.querySelector<HTMLElement>('.reward__star') ?? null;
    const reward = state?.querySelector<HTMLElement>('.reward') ?? null;
    state?.classList.add('game__state--collecting');
    reward?.classList.add('reward--collecting');
    if (source) source.style.visibility = 'hidden';

    const afterCollect = () => {
      this.collectingRewardIndex = null;
      this.pendingStarRewards.delete(i);
      this.claimedStarRewards.add(i);
      state?.classList.remove('game__state--collecting');
      this.updateMechanicState(i);
      this.finishStarReward(i);
      // Star has landed in the counter — now kick off the next mechanic's autoplay
      // (it was held back by the collectingRewardIndex gate in ensureFrameAutoPlay).
      this.ensureFrameAutoPlay(this.realIndex());
      this.pollAutoplayUi();
    };

    this.playRewardStarCollect(source, afterCollect);
    return true;
  }

  private rewardWouldLevelUp(): boolean {
    const currentLevel = Math.floor(this.totalStars / this.starsPerLevel) + 1;
    const nextLevel = Math.floor((this.totalStars + 1) / this.starsPerLevel) + 1;
    return nextLevel > currentLevel;
  }

  private playRewardStarCollect(source: HTMLElement | null, onDone: () => void) {
    const vp = this.viewport.getBoundingClientRect();
    const src = source?.getBoundingClientRect();
    const badge = this.levelBadgeEl?.getBoundingClientRect();
    const sz = src ? Math.max(src.width, src.height) : 128;
    const startX = src ? src.left - vp.left + src.width / 2 : vp.width / 2;
    const startY = src ? src.top - vp.top + src.height / 2 : vp.height * 0.46;
    const badgeX = badge ? badge.left - vp.left + badge.width / 2 : 40;
    const badgeY = badge ? badge.top - vp.top + badge.height / 2 : 40;

    const star = document.createElement('div');
    star.className = 'star-flight star-flight--collect';
    star.textContent = '★';
    star.style.width = `${sz}px`;
    star.style.height = `${sz}px`;
    star.style.fontSize = `${Math.round(sz * 0.92)}px`;
    star.style.transform = `translate3d(${startX - sz / 2}px, ${startY - sz / 2}px, 0)`;
    this.viewport.appendChild(star);

    if (!star.animate) {
      star.remove();
      this.burstRewardCollectParticles(badgeX, badgeY);
      this.bumpLevelBadge();
      onDone();
      return;
    }

    // Level-up-style confetti rains down evenly across the whole screen.
    this.burstStarConfetti();

    // On swipe the star stays put and does ONE pronounced pulse: the size INCREASE
    // accelerates into the peak (ease-in), then the DECREASE accelerates as it
    // launches to the badge (ease-in). Slightly dips DOWN at the peak (anticipation
    // against the upward swipe). transform-origin is 50% 50% (CSS for --collect), so
    // scaling keeps the glyph centred on the avatar.
    const dipY = startY + Math.max(16, sz * 0.13);
    const anim = star.animate([
      {
        transform: `translate3d(${startX - sz / 2}px, ${startY - sz / 2}px, 0) scale(1) rotate(0deg)`,
        opacity: 1,
        offset: 0,
        easing: 'cubic-bezier(0.4, 0, 0.8, 0.6)',        // quick grow into the peak
      },
      {
        transform: `translate3d(${startX - sz / 2}px, ${dipY - sz / 2}px, 0) scale(1.85) rotate(0deg)`,
        opacity: 1,
        offset: 0.26,                                    // peak reached even sooner → FASTER grow,
                                                         // leaving more of the timeline for a SLOWER shrink
        easing: 'cubic-bezier(0.45, 0, 0.7, 0.65)',      // gentle, slower shrink toward the badge
      },
      {
        transform: `translate3d(${badgeX - sz / 2}px, ${badgeY - sz / 2}px, 0) scale(0.3) rotate(360deg)`,
        opacity: 1,
        offset: 1,                                       // spins a full turn while flying to the counter
      },
    ], { duration: 900, fill: 'forwards' });

    anim.addEventListener('finish', () => {
      star.remove();
      this.burstRewardCollectParticles(badgeX, badgeY);
      this.bumpLevelBadge();
      onDone();
    }, { once: true });
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

  private burstRewardCollectParticles(x: number, y: number) {
    const colors = ['#ffd85a', '#fff1a8', '#ffb13d', '#ff7b38', '#ffffff'];
    for (let n = 0; n < 18; n++) {
      const p = document.createElement('div');
      p.className = 'star-particle';
      const size = 5 + Math.random() * 6;
      const angle = Math.random() * Math.PI * 2;
      const dist = 34 + Math.random() * 44;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      p.style.background = colors[n % colors.length];
      this.viewport.appendChild(p);

      const dur = 420 + Math.random() * 260;
      if (!p.animate) { window.setTimeout(() => p.remove(), dur); continue; }
      const anim = p.animate([
        { transform: 'translate(-50%, -50%) scale(0.35)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1)`, opacity: 0.95, offset: 0.38 },
        { transform: `translate(calc(-50% + ${dx * 1.1}px), calc(-50% + ${dy + 34}px)) scale(0.12)`, opacity: 0 },
      ], { duration: dur, easing: 'cubic-bezier(0.18, 0.7, 0.3, 1)', fill: 'forwards' });
      anim.addEventListener('finish', () => p.remove(), { once: true });
    }
  }

  private reloadFrame(i: number) {
    const frame = this.frames.get(i);
    if (frame) {
      const runId = frame.dataset.runId;
      if (runId) this.completedRunIds.delete(runId);
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

  private updateHud(animate: boolean = true) {
    const level = Math.floor(this.totalStars / this.starsPerLevel) + 1;
    const progress = (this.totalStars % this.starsPerLevel) / this.starsPerLevel;
    if (this.levelEl) this.levelEl.textContent = String(level);
    this.setLevelProgress(progress, animate);
  }

  private setLevelProgress(progress: number, animate: boolean = true) {
    if (!this.levelProgressEl) return;
    const clamped = Math.max(0, Math.min(1, progress));
    this.levelProgressEl.style.transition = animate ? '' : 'none';
    this.levelProgressEl.style.setProperty('--level-progress', `${clamped * 360}deg`);
    if (!animate) {
      this.levelProgressEl.offsetHeight;
      this.levelProgressEl.style.transition = '';
    }
  }

  private bumpLevelBadge() {
    this.levelBadgeEl?.classList.add('hud__level--bump');
    window.setTimeout(() => this.levelBadgeEl?.classList.remove('hud__level--bump'), 260);
  }

  private pulseLevelUp() {
    this.hudEl?.classList.add('hud--level-up');
    window.setTimeout(() => this.hudEl?.classList.remove('hud--level-up'), 420);
  }

  private finishStarReward(i: number): boolean {
    const prev = this.totalStars;
    const prevLevel = Math.floor(prev / this.starsPerLevel) + 1;
    this.totalStars = prev + 1;
    const nextLevel = Math.floor(this.totalStars / this.starsPerLevel) + 1;

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
      window.setTimeout(() => this.bumpLevelBadge(), LEVEL_PROGRESS_MS);
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
        c.style.cssText =
          `left:${Math.random() * rect.width}px;top:-24px;width:${w}px;height:${h}px;` +
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

    emitWave(36);                                   // opening burst
    // A short celebratory tail is enough; unbounded DOM confetti makes the held
    // level-up screen warm phones if the player pauses here.
    if (this.confettiTimer) window.clearInterval(this.confettiTimer);
    let waves = 0;
    this.confettiTimer = window.setInterval(() => {
      if (!parent.isConnected) { this.stopConfetti(); return; }
      if (++waves > 6) { this.stopConfetti(); return; }
      emitWave(8);
    }, 600);
  }

  private stopConfetti() {
    if (this.confettiTimer) { window.clearInterval(this.confettiTimer); this.confettiTimer = null; }
  }

  // ── Paging ───────────────────────────────────────────────────────────────
  goTo(targetPos: number) {
    const fromPos = Math.round(this.pos);
    const fromIndex = this.indexForPos(fromPos);
    const targetIndex = this.indexForPos(targetPos);
    const changed = targetPos !== this.pos;
    const pageChanged = targetIndex !== fromIndex;
    if (changed && pageChanged) {
      this.liveHold = new Set([fromIndex, targetIndex]);
      this.settlingTargetIndex = targetIndex;
      this.stopRewardSparks(fromIndex);
      if (this.isForwardCycleWrap(fromPos, targetPos)) this.resetCycleAfterSettle = true;
    }
    this.pos = targetPos;
    this.render(true);
    if (changed && pageChanged) {
      this.prefetchReserve();   // keep the reserve topped up
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
  };
}

export function createFeed(viewport: HTMLElement, feedEl: HTMLElement) {
  return new Feed(viewport, feedEl, PLAYABLES);
}
