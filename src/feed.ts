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
 * Gesture separation (phase 1): paging is wired ONLY to the bottom gutter, so
 * in-game gestures (inside the playable's <iframe>) never page the feed.
 *
 * Loading model:
 *  - Only the CURRENT game is mounted while the feed is idle.
 *  - During a drag/settle we temporarily mount the outgoing and incoming games;
 *    non-current games enter the playable host-paused state and do not run
 *    requestAnimationFrame until resumed.
 *  - Ahead bundles are PREFETCHED (bytes only), so the next mount is warm
 *    without spending CPU/GPU on hidden gameplay.
 *  - A fill-bar preloader covers the initial batch.
 */

const DISTANCE_SNAP_FRAC = 0.18;   // drag past 18% of a page → commit to the next
const VELOCITY_SNAP = 0.45;        // px/ms flick that commits regardless of distance

const LIVE_AHEAD = 0;              // idle feed mounts current only; ahead is bytes-prefetched
const LIVE_BEHIND = 0;             // back-swipe is disabled, so no idle previous iframe
const RESERVE_AHEAD = 2;           // prefetch this many bundles ahead (bytes only)
const INITIAL_BATCH = 2;           // preloader fills until the first N are ready
const PRELOADER_TIMEOUT_MS = 15000;
const ANALYTICS_POLL_MS = 1000;    // fallback for older non-SWIPE exports
const FRAME_READY_FALLBACK_MS = 900;
const FRAME_REVEAL_DELAY_MS = 90;
const LEVEL_PROGRESS_MS = 340;
const AUTO_ADVANCE_AFTER_REWARD_MS = 120;
const STARS_PER_LEVEL = 5;

type PlayableOutcome = 'won' | 'lost';

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

  private slots: HTMLElement[] = [];
  private games: HTMLElement[] = [];
  private stateEls: HTMLElement[] = [];
  private labelEls: HTMLElement[] = [];
  private labelTimers = new Map<number, number>();
  private frames = new Map<number, HTMLIFrameElement>();
  private runSeq = 0;
  private completedRunIds = new Set<string>();
  private liveHold = new Set<number>();
  private settlingTargetIndex: number | null = null;
  private frameLoaded = new Set<number>();
  private frameReady = new Set<number>();
  private frameRevealed = new Set<number>();
  private frameFallbackTimers = new Map<number, number>();
  private frameRevealTimers = new Map<number, number>();

  private totalStars = 0;
  private earnedThisCycle = new Set<number>();
  private failedThisCycle = new Set<number>();
  private hudEl: HTMLElement | null = null;
  private storiesEl: HTMLElement | null = null;
  private levelBadgeEl: HTMLElement | null = null;
  private levelEl: HTMLElement | null = null;
  private levelProgressEl: HTMLElement | null = null;

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
      this.settlingTargetIndex = null;
      this.pos = this.realIndex();      // keep pos bounded; same visual (delta mod N)
      this.liveHold.clear();
      this.render(false);
      this.updateLive();
      this.applyActiveStates();
    });

    this.updateLive();
    this.prefetchReserve();
    this.applyActiveStates();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('message', this.onWindowMessage);
    (window as any).__feedHostGesture = this.onHostGesture;
    window.setInterval(this.pollPlayableAnalytics, ANALYTICS_POLL_MS);
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

      const state = document.createElement('div');
      state.className = 'game__state';
      state.hidden = true;
      game.appendChild(state);

      page.appendChild(game);
      page.appendChild(this.makeGutter(i));
      frag.appendChild(page);

      this.pageEls[i] = page;
      this.games[i] = game;
      this.slots[i] = slot;
      this.stateEls[i] = state;
      this.labelEls[i] = label;
    });
    this.feedEl.appendChild(frag);
  }

  private makeGutter(i: number): HTMLElement {
    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    gutter.dataset.index = String(i);
    gutter.innerHTML =
      '<div class="gutter__grip"></div>' +
      '<div class="gutter__label"><span class="gutter__chev">▲</span> Swipe up for next game</div>';
    this.attachGutter(gutter);
    return gutter;
  }

  private mountHud() {
    const hud = document.createElement('div');
    const friendStories = [
      ['Ava', 'A', 'sky'],
      ['Mila', 'M', 'rose'],
      ['Leo', 'L', 'mint'],
      ['Nika', 'N', 'sun'],
      ['Tim', 'T', 'violet'],
      ['Zoe', 'Z', 'sky'],
      ['Max', 'M', 'rose'],
      ['Eva', 'E', 'mint'],
      ['Sam', 'S', 'sun'],
      ['Kai', 'K', 'violet'],
      ['Mia', 'M', 'sky'],
      ['Dan', 'D', 'rose'],
      ['Liza', 'L', 'mint'],
      ['Ben', 'B', 'sun'],
    ].map(([name, initial, tone]) => this.friendStoryMarkup(name, initial, tone)).join('');
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

  private friendStoryMarkup(name: string, initial: string, tone: string): string {
    return (
      `<div class="story">` +
        `<div class="story__avatar story__avatar--${tone}"><span>${initial}</span></div>` +
        `<div class="story__name">${name}</div>` +
      `</div>`
    );
  }

  private attachStoryScroller(scroller: HTMLElement) {
    let tracking = false;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startScrollLeft = 0;
    const dragIntentPx = 6;

    const updateMask = () => {
      const maxScroll = scroller.scrollWidth - scroller.clientWidth;
      this.hudEl?.classList.toggle('hud--stories-can-left', scroller.scrollLeft > 1);
      this.hudEl?.classList.toggle('hud--stories-can-right', scroller.scrollLeft < maxScroll - 1);
    };

    const endDrag = (e: PointerEvent) => {
      if (!tracking && !dragging) return;
      tracking = false;
      dragging = false;
      scroller.classList.remove('stories--dragging');
      try { scroller.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };

    scroller.addEventListener('pointerdown', (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      tracking = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
      startScrollLeft = scroller.scrollLeft;
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
    this.storiesEl.scrollLeft = 0;
    this.hudEl?.classList.remove('hud--stories-can-left');
    this.hudEl?.classList.toggle('hud--stories-can-right', this.storiesEl.scrollWidth > this.storiesEl.clientWidth + 1);
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
      pg.style.transition = animate && !wrapped ? 'transform 0.36s var(--ease-snap)' : 'none';
      pg.style.transform = `translate3d(0, ${delta * this.pageH}px, 0)`;
      pg.style.zIndex = String(1000 - Math.round(Math.abs(delta) * 10));
      pg.style.visibility = near ? 'visible' : 'hidden';
      pg.classList.toggle('page--near', near);
      this.pageDelta[i] = delta;
    }
  }

  // ── Live window (instantiate neighbours, tear down the far ones) ───────────
  private liveSet(): Set<number> {
    const s = new Set<number>(this.liveHold);
    s.add(this.realIndex());
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
      this.frameLoaded.add(i);
      this.setFramePaused(i, this.shouldPauseFrame(i));
      this.queueFrameReadyFallback(i, frame);
      this.tryRevealFrame(i);
    });
    this.frames.set(i, frame);
    frame.src = playableUrl(this.playables[i].id, { hostPaused: this.shouldPauseFrame(i) });
    this.slots[i].appendChild(frame);
  }

  private unmount(i: number) {
    const frame = this.frames.get(i);
    if (!frame) return;
    const runId = frame.dataset.runId;
    if (runId) this.completedRunIds.delete(runId);
    frame.remove();
    this.frames.delete(i);
    this.resetFrameReadiness(i);
    this.games[i].classList.add('game--loading');
    this.games[i].classList.remove('game--ready');
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
  }

  private tryRevealFrame(i: number) {
    const frame = this.frames.get(i);
    if (!frame || this.frameRevealed.has(i) || this.frameRevealTimers.has(i)) return;
    if (!this.frameLoaded.has(i) || !this.frameReady.has(i) || this.shouldPauseFrame(i)) return;

    const timer = window.setTimeout(() => {
      this.frameRevealTimers.delete(i);
      if (this.frames.get(i) !== frame) return;
      if (!this.frameLoaded.has(i) || !this.frameReady.has(i) || this.shouldPauseFrame(i)) return;
      this.frameRevealed.add(i);
      this.games[i].classList.remove('game--loading');
      this.games[i].classList.add('game--ready');
      this.markReady(i);
    }, FRAME_REVEAL_DELAY_MS);
    this.frameRevealTimers.set(i, timer);
  }

  // Pause/resume a playable by flipping its document visibility — the same
  // signal the playable's lifecycle honors. Best-effort: works same-origin
  // (Render / dev middleware); cross-origin throws and we leave it running.
  private setFramePaused(i: number, paused: boolean) {
    const frame = this.frames.get(i);
    if (!frame) return;
    try {
      const win = frame.contentWindow as (Window & typeof globalThis) | null;
      const doc = win?.document;
      if (!win || !doc) return;
      const api = (win as any).__playable;
      if (typeof api?.setHostPaused === 'function') api.setHostPaused(paused);
      Object.defineProperty(doc, 'hidden', { configurable: true, get: () => paused });
      Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (paused ? 'hidden' : 'visible') });
      doc.dispatchEvent(new win.Event('visibilitychange'));
    } catch {
      /* cross-origin or not ready — leave as-is */
    }
  }

  private applyActiveStates() {
    this.frames.forEach((_f, i) => {
      this.setFramePaused(i, this.shouldPauseFrame(i));
      this.tryRevealFrame(i);
    });
  }

  private shouldPauseFrame(i: number): boolean {
    if (this.settlingTargetIndex === i) return true;
    return i !== this.realIndex() || this.earnedThisCycle.has(i) || this.failedThisCycle.has(i);
  }

  private callPlayableHostGesture(i: number): boolean {
    const frame = this.frames.get(i);
    if (!frame) return false;
    try {
      const api = (frame.contentWindow as any)?.__playable;
      if (typeof api?.hostGesture !== 'function') return false;
      api.hostGesture();
      return true;
    } catch {
      return false;
    }
  }

  private unlockAudioForCurrentAndNext(fromIndex: number = this.realIndex()) {
    const current = ((fromIndex % this.N) + this.N) % this.N;
    const next = (current + 1) % this.N;
    this.callPlayableHostGesture(current);
    this.callPlayableHostGesture(next);
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
    if (this.prefetching) return;
    const i = this.prefetchQueue.shift();
    if (i === undefined) return;
    this.prefetchQueued.delete(i);
    if (this.frames.has(i)) {
      this.pumpPrefetchQueue();
      return;
    }

    this.prefetching = true;
    this.scheduleIdlePrefetch(() => {
      fetch(playableUrl(this.playables[i].id, { hostPaused: true }), { mode: 'no-cors' })
        .then(() => this.markReady(i))
        .catch(() => this.markReady(i))
        .finally(() => {
          this.prefetching = false;
          this.pumpPrefetchQueue();
        });
    });
  }

  private scheduleIdlePrefetch(fn: () => void) {
    const requestIdleCallback = (window as any).requestIdleCallback as
      | undefined
      | ((callback: () => void, options?: { timeout: number }) => number);
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(fn, { timeout: 800 });
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

  // ── Gutter pointer handling ──────────────────────────────────────────────
  private attachGutter(gutter: HTMLElement) {
    gutter.addEventListener('pointerdown', (e) => this.onDown(e, gutter));
    gutter.addEventListener('pointermove', (e) => this.onMove(e));
    gutter.addEventListener('pointerup', (e) => this.onUp(e, gutter));
    gutter.addEventListener('pointercancel', (e) => this.onUp(e, gutter));
  }

  private onDown(e: PointerEvent, gutter: HTMLElement) {
    const current = this.realIndex();
    const next = (current + 1) % this.N;
    this.liveHold = new Set([current, next]);
    this.updateLive();
    this.applyActiveStates();

    this.dragging = true;
    this.startY = e.clientY;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    this.velocity = 0;
    this.basePos = Math.round(this.pos);
    this.unlockAudioForCurrentAndNext(current);
    gutter.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (!this.dragging || this.pageH === 0) return;
    const dy = e.clientY - this.startY;
    const dt = e.timeStamp - this.lastT;
    if (dt > 0) this.velocity = (e.clientY - this.lastY) / dt;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    const forwardProgress = Math.max(0, -dy / this.pageH);
    this.pos = this.basePos + forwardProgress;   // drag up → pos increases → next
    this.render(false);
  }

  private onUp(e: PointerEvent, gutter: HTMLElement) {
    if (!this.dragging) return;
    this.dragging = false;
    try { gutter.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    const dy = e.clientY - this.startY;
    let step = 0;
    const fastUp = this.velocity <= -VELOCITY_SNAP;
    const farUp = dy <= -this.pageH * DISTANCE_SNAP_FRAC;
    if (fastUp || farUp) step = 1;

    this.goTo(this.basePos + step);
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
      const history = (frame.contentWindow as any)?.__playable?.getAnalyticsHistory?.();
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
    if (this.earnedThisCycle.has(i)) return;
    this.failedThisCycle.delete(i);
    this.earnedThisCycle.add(i);
    this.updateMechanicState(i);
    this.applyActiveStates();
    this.resetStoriesToMyLevel();
    this.playStarFlight(i);
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
    game.classList.toggle('game--earned', earned);
    game.classList.toggle('game--failed', failed);
    state.classList.toggle('game__state--earned', earned);
    state.classList.toggle('game__state--failed', failed);
    state.replaceChildren();
    state.hidden = !earned && !failed;
    if (!earned && !failed) return;

    if (earned) return;

    const badge = document.createElement('div');
    badge.className = 'game__state-badge';
    badge.textContent = '↻';
    state.appendChild(badge);

    const title = document.createElement('div');
    title.className = 'game__state-title';
    title.textContent = 'Try again';
    state.appendChild(title);

    if (failed) {
      const btn = document.createElement('button');
      btn.className = 'game__restart';
      btn.type = 'button';
      btn.textContent = 'Restart';
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.restart(i);
      });
      state.appendChild(btn);
    }
  }

  private restart(i: number) {
    if (this.earnedThisCycle.has(i)) return;
    this.failedThisCycle.delete(i);
    this.updateMechanicState(i);
    this.reloadFrame(i);
    this.applyActiveStates();
  }

  private reloadFrame(i: number) {
    const frame = this.frames.get(i);
    if (frame) {
      const runId = frame.dataset.runId;
      if (runId) this.completedRunIds.delete(runId);
      frame.remove();
      this.frames.delete(i);
    }
    this.games[i].classList.add('game--loading');
    if (this.liveSet().has(i)) this.mount(i);
  }

  private resetCycle() {
    const reload = new Set([...this.earnedThisCycle, ...this.failedThisCycle]);
    if (reload.size === 0) return;
    this.earnedThisCycle.clear();
    this.failedThisCycle.clear();
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

  private finishStarReward(i: number) {
    const prev = this.totalStars;
    const prevLevel = Math.floor(prev / this.starsPerLevel) + 1;
    this.totalStars = prev + 1;
    const nextLevel = Math.floor(this.totalStars / this.starsPerLevel) + 1;

    if (nextLevel > prevLevel) {
      // Fill the ring, then play the congratulatory level-up screen (confetti)
      // BEFORE auto-advancing to the next mechanic.
      this.setLevelProgress(1, true);
      this.playLevelUp(nextLevel, () => {
        this.updateHud(false);                 // ring resets to the new level (0 progress)
        this.pulseLevelUp();
        this.scheduleAutoAdvanceAfterStar(i, AUTO_ADVANCE_AFTER_REWARD_MS);
      });
    } else {
      this.updateHud(true);
      this.scheduleAutoAdvanceAfterStar(i, LEVEL_PROGRESS_MS + AUTO_ADVANCE_AFTER_REWARD_MS);
    }
  }

  // Congratulatory level-up screen: a popped badge + confetti rain, held briefly
  // then faded out. `onDone` fires after the fade (drives the auto-advance).
  private playLevelUp(level: number, onDone: () => void) {
    const overlay = document.createElement('div');
    overlay.className = 'levelup';
    overlay.innerHTML =
      '<div class="levelup__card">' +
        '<div class="levelup__kicker">LEVEL UP</div>' +
        '<div class="levelup__badge"><span class="levelup__star">★</span><span class="levelup__num">' + level + '</span></div>' +
        '<div class="levelup__title">Level ' + level + '</div>' +
      '</div>';
    this.viewport.appendChild(overlay);
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

    const HOLD = 1600;
    window.setTimeout(() => {
      if (!overlay.animate) { overlay.remove(); onDone(); return; }
      const out = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: 'forwards' });
      out.addEventListener('finish', () => { overlay.remove(); onDone(); }, { once: true });
    }, HOLD);
  }

  private spawnConfetti(parent: HTMLElement) {
    const colors = ['#ffd85a', '#45d68c', '#37a6ff', '#ff4f8b', '#ff9f45', '#b07bff', '#5ee6a8'];
    const rect = this.viewport.getBoundingClientRect();
    const count = 48;
    for (let n = 0; n < count; n++) {
      const c = document.createElement('div');
      c.className = 'confetti';
      const w = 6 + Math.random() * 6, h = 9 + Math.random() * 9;
      c.style.cssText =
        `left:${Math.random() * rect.width}px;top:-24px;width:${w}px;height:${h}px;` +
        `background:${colors[n % colors.length]};border-radius:${Math.random() < 0.4 ? '50%' : '2px'};`;
      parent.appendChild(c);
      if (!c.animate) { window.setTimeout(() => c.remove(), 1900); continue; }
      const driftX = (Math.random() - 0.5) * 140;
      const fall = rect.height + 80;
      const rot = Math.random() * 900 - 450;
      const a = c.animate([
        { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${driftX}px, ${fall}px) rotate(${rot}deg)`, opacity: 1, offset: 0.82 },
        { transform: `translate(${driftX}px, ${fall + 40}px) rotate(${rot}deg)`, opacity: 0 },
      ], { duration: 1500 + Math.random() * 800, delay: Math.random() * 380, easing: 'cubic-bezier(0.3, 0.2, 0.5, 1)', fill: 'forwards' });
      a.addEventListener('finish', () => c.remove(), { once: true });
    }
  }

  private scheduleAutoAdvanceAfterStar(i: number, delayMs: number) {
    window.setTimeout(() => {
      if (this.dragging || this.realIndex() !== i || !this.earnedThisCycle.has(i)) return;
      this.goTo(Math.round(this.pos) + 1);
    }, delayMs);
  }

  // Playable-style radial burst (ported from merge spawnBurst): particles fly
  // out at random angles, arc DOWN with gravity, and fade — plus a soft impact
  // flash. `land` biases up/outward (bounced off the floor) and arcs harder;
  // `collect` is a tight full-radial pop at the level badge.
  private burstStarParticles(x: number, y: number, kind: 'land' | 'collect' = 'collect') {
    const colors = ['#ffd85a', '#fff1a8', '#ffb13d', '#ffffff', '#ffe27a'];
    const count = kind === 'collect' ? 12 : 16;
    const spread = kind === 'collect' ? 54 : 82;
    const grav = kind === 'collect' ? 34 : 112;

    const impact = document.createElement('div');
    impact.className = 'star-impact';
    impact.style.left = `${x}px`;
    impact.style.top = `${y}px`;
    this.viewport.appendChild(impact);
    if (impact.animate) {
      const a = impact.animate([
        { transform: 'translate(-50%, -50%) scale(0.4, 0.3)', opacity: 0.8 },
        { transform: 'translate(-50%, -50%) scale(1.55, 1.0)', opacity: 0 },
      ], { duration: 360, easing: 'cubic-bezier(0.14, 0.74, 0.3, 1)', fill: 'forwards' });
      a.addEventListener('finish', () => impact.remove(), { once: true });
    } else {
      window.setTimeout(() => impact.remove(), 360);
    }

    for (let n = 0; n < count; n++) {
      const angle = kind === 'land'
        ? -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15
        : Math.random() * Math.PI * 2;
      const dist = spread * (0.45 + Math.random() * 0.55);
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const size = (kind === 'collect' ? 7 : 9) * (0.6 + Math.random() * 0.6);

      const p = document.createElement('div');
      p.className = 'star-particle';
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;
      p.style.width = `${size}px`;
      p.style.height = `${size}px`;
      p.style.background = colors[n % colors.length];
      this.viewport.appendChild(p);

      const dur = 460 + Math.random() * 320;
      if (!p.animate) { window.setTimeout(() => p.remove(), dur); continue; }
      const a = p.animate([
        { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 1, offset: 0 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1)`, opacity: 1, offset: 0.4 },
        { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + grav}px)) scale(0.1)`, opacity: 0, offset: 1 },
      ], { duration: dur, easing: 'cubic-bezier(0.18, 0.7, 0.3, 1)', fill: 'forwards' });
      a.addEventListener('finish', () => p.remove(), { once: true });
    }
  }

  // Star reward, playable-style (ported feel from the merge piggy drop+squash):
  //  1. falls from above the screen with gravity (cubic ease-in → accelerates)
  //  2. lands at centre and squashes elastically (sin pulse), little rebound
  //  3. flies into the level badge ACCELERATING (ease-in), shrinking
  // Particle splash on the landing impact and again on collect at the badge.
  // Driven by rAF for precise squash control (transform-origin 50%/76% pins the
  // bottom during the squash).
  private playStarFlight(i: number) {
    const star = document.createElement('div');
    star.className = 'star-flight';
    star.textContent = '★';
    this.viewport.appendChild(star);

    const vp = this.viewport.getBoundingClientRect();
    const badge = this.levelBadgeEl?.getBoundingClientRect();
    const sz = 92;
    const cx = vp.width / 2;
    const groundY = vp.height * 0.44;           // landing point
    const startY = -sz * 0.7;                   // above the screen
    const bx = badge ? badge.left - vp.left + badge.width / 2 : 40;
    const by = badge ? badge.top - vp.top + badge.height / 2 : 40;

    if (!star.animate || typeof requestAnimationFrame !== 'function') {
      star.remove();
      this.finishStarReward(i);
      return;
    }

    const DROP = 360, SQUASH = 150, REBOUND = 160, HOLD = 70, FLY = 470;
    const TOTAL = DROP + SQUASH + REBOUND + HOLD + FLY;
    const t0 = performance.now();
    let landed = false, done = false;

    const frame = (now: number) => {
      if (done) return;
      const e = now - t0;
      let x = cx, y = groundY, sx = 1, sy = 1, op = 1;

      if (e < DROP) {
        const t = e / DROP; const eased = t * t * t;          // accelerate down
        y = startY + (groundY - startY) * eased;
        op = Math.min(1, t * 3);
      } else if (e < DROP + SQUASH) {
        const t = (e - DROP) / SQUASH; const sq = Math.sin(t * Math.PI);
        sx = 1 + sq * 0.32; sy = 1 - sq * 0.3;                // squash (bottom pinned by origin)
        if (!landed) { landed = true; this.burstStarParticles(cx, groundY + sz * 0.32, 'land'); }
      } else if (e < DROP + SQUASH + REBOUND) {
        const t = (e - DROP - SQUASH) / REBOUND; const up = Math.sin(t * Math.PI);
        y = groundY - sz * 0.3 * up;                          // little elastic hop
        sx = 1 - up * 0.08; sy = 1 + up * 0.08;
      } else if (e < DROP + SQUASH + REBOUND + HOLD) {
        y = groundY;
      } else {
        const t = Math.min(1, (e - DROP - SQUASH - REBOUND - HOLD) / FLY);
        const eased = t * t;                                  // accelerate toward the badge
        x = cx + (bx - cx) * eased; y = groundY + (by - groundY) * eased;
        sx = sy = 1 - 0.64 * eased; op = 1 - 0.22 * t;
      }

      star.style.opacity = String(op);
      star.style.transform = `translate3d(${x - sz / 2}px, ${y - sz / 2}px, 0) scale(${sx}, ${sy})`;

      if (e >= TOTAL) {
        done = true;
        star.remove();
        this.burstStarParticles(bx, by, 'collect');
        this.bumpLevelBadge();
        this.finishStarReward(i);
      } else {
        requestAnimationFrame(frame);
      }
    };
    requestAnimationFrame(frame);
  }

  // ── Paging ───────────────────────────────────────────────────────────────
  goTo(targetPos: number) {
    const fromPos = Math.round(this.pos);
    const fromIndex = this.indexForPos(fromPos);
    const targetIndex = this.indexForPos(targetPos);
    const changed = targetPos !== this.pos;
    if (changed) {
      this.liveHold = new Set([fromIndex, targetIndex]);
      this.settlingTargetIndex = targetIndex;
      if (this.isForwardCycleWrap(fromPos, targetPos)) this.resetCycle();
      this.updateLive();        // mount the incoming game while it is still host-paused
      this.applyActiveStates();
    }
    this.pos = targetPos;
    this.render(true);
    if (changed) {
      this.prefetchReserve();   // keep the reserve topped up
    } else {
      this.settlingTargetIndex = null;
      this.liveHold.clear();
      this.updateLive();
      this.applyActiveStates();
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
