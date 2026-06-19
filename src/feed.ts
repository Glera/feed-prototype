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
 * Loading model (phase 2):
 *  - A small LIVE window of neighbours (prev / current / next) is instantiated
 *    and rendered, so sliding either way shows no loader.
 *  - Only the CURRENT game RUNS; neighbours are PAUSED (ready but frozen) via
 *    the playable's own visibility lifecycle (flip the iframe document's
 *    `hidden` + dispatch `visibilitychange`; works same-origin). The next game
 *    RESUMES only after the slide settles; the previous one pauses.
 *  - Beyond the live window, RESERVE_AHEAD bundles are PREFETCHED (bytes only).
 *  - A fill-bar preloader covers the initial batch.
 */

const DISTANCE_SNAP_FRAC = 0.18;   // drag past 18% of a page → commit to the next
const VELOCITY_SNAP = 0.45;        // px/ms flick that commits regardless of distance

const LIVE_AHEAD = 1;              // instantiate this many ahead (ready & rendered, paused)
const LIVE_BEHIND = 1;             // and this many behind (instant back-swipe)
const RESERVE_AHEAD = 5;           // prefetch this many bundles ahead (bytes only)
const PREFETCH_BEHIND = 1;
const INITIAL_BATCH = 5;           // preloader fills until the first N are ready
const PRELOADER_TIMEOUT_MS = 15000;
const ANALYTICS_POLL_MS = 350;     // fallback for older non-SWIPE exports
const STAR_FLIGHT_MS = 920;
const AUTO_ADVANCE_AFTER_STAR_MS = 180;
const LEVEL_RESET_MS = 420;

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
  private frames = new Map<number, HTMLIFrameElement>();
  private runSeq = 0;
  private completedRunIds = new Set<string>();

  private totalStars = 0;
  private earnedThisCycle = new Set<number>();
  private failedThisCycle = new Set<number>();
  private hudEl: HTMLElement | null = null;
  private levelEl: HTMLElement | null = null;
  private starCounterEl: HTMLElement | null = null;
  private starCountEl: HTMLElement | null = null;
  private levelFillEl: HTMLElement | null = null;
  private levelResetTimer: number | null = null;

  private prefetched = new Set<number>();
  private ready = new Set<number>();
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
    this.starsPerLevel = Math.max(1, this.N);
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
      this.pos = this.realIndex();      // keep pos bounded; same visual (delta mod N)
      this.render(false);
      this.applyActiveStates();
    });

    this.updateLive();
    this.prefetchReserve();
    this.applyActiveStates();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('message', this.onWindowMessage);
    window.setInterval(this.pollPlayableAnalytics, ANALYTICS_POLL_MS);
  }

  private realIndex(): number {
    return ((Math.round(this.pos) % this.N) + this.N) % this.N;
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
    });
    this.feedEl.appendChild(frag);
  }

  private makeGutter(i: number): HTMLElement {
    const gutter = document.createElement('div');
    gutter.className = 'gutter';
    gutter.dataset.index = String(i);
    gutter.innerHTML =
      '<div class="gutter__grip"></div>' +
      '<div class="gutter__label"><span class="gutter__chev">▲</span> Swipe to switch game <span class="gutter__chev">▼</span></div>';
    this.attachGutter(gutter);
    return gutter;
  }

  private mountHud() {
    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML =
      '<div class="hud__level"><span class="hud__level-kicker">LVL</span><span class="hud__level-value">1</span></div>' +
      '<div class="hud__progress" aria-label="Level progress"><div class="hud__progress-fill"></div></div>' +
      '<div class="hud__stars"><span class="hud__star-icon">★</span><span class="hud__stars-value">0</span></div>';
    this.viewport.appendChild(hud);
    this.hudEl = hud;
    this.levelEl = hud.querySelector('.hud__level-value');
    this.starCounterEl = hud.querySelector('.hud__stars');
    this.starCountEl = hud.querySelector('.hud__stars-value');
    this.levelFillEl = hud.querySelector('.hud__progress-fill');
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
      pg.style.transition = animate && !wrapped ? 'transform 0.36s var(--ease-snap)' : 'none';
      pg.style.transform = `translate3d(0, ${delta * this.pageH}px, 0)`;
      this.pageDelta[i] = delta;
    }
  }

  // ── Live window (instantiate neighbours, tear down the far ones) ───────────
  private liveSet(): Set<number> {
    const s = new Set<number>();
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
    const frame = document.createElement('iframe');
    frame.className = 'game__frame';
    frame.dataset.runId = String(++this.runSeq);
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('title', this.playables[i].id);
    frame.addEventListener('load', () => {
      this.games[i].classList.remove('game--loading');
      this.setFramePaused(i, this.shouldPauseFrame(i));
      this.markReady(i);
    });
    frame.src = playableUrl(this.playables[i].id);
    this.slots[i].appendChild(frame);
    this.frames.set(i, frame);
  }

  private unmount(i: number) {
    const frame = this.frames.get(i);
    if (!frame) return;
    const runId = frame.dataset.runId;
    if (runId) this.completedRunIds.delete(runId);
    frame.remove();
    this.frames.delete(i);
    this.games[i].classList.add('game--loading');
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
      Object.defineProperty(doc, 'hidden', { configurable: true, get: () => paused });
      Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => (paused ? 'hidden' : 'visible') });
      doc.dispatchEvent(new win.Event('visibilitychange'));
    } catch {
      /* cross-origin or not ready — leave as-is */
    }
  }

  private applyActiveStates() {
    this.frames.forEach((_f, i) => this.setFramePaused(i, this.shouldPauseFrame(i)));
  }

  private shouldPauseFrame(i: number): boolean {
    return i !== this.realIndex() || this.earnedThisCycle.has(i) || this.failedThisCycle.has(i);
  }

  // ── Prefetch reserve (bytes only) ──────────────────────────────────────────
  private prefetchReserve() {
    const base = this.realIndex();
    for (let d = -PREFETCH_BEHIND; d <= RESERVE_AHEAD; d++) {
      const j = ((base + d) % this.N + this.N) % this.N;
      if (this.frames.has(j) || this.prefetched.has(j)) continue;
      this.prefetched.add(j);
      fetch(playableUrl(this.playables[j].id), { mode: 'no-cors' })
        .then(() => this.markReady(j))
        .catch(() => this.markReady(j));
    }
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
    this.dragging = true;
    this.startY = e.clientY;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    this.velocity = 0;
    this.basePos = Math.round(this.pos);
    gutter.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (!this.dragging || this.pageH === 0) return;
    const dy = e.clientY - this.startY;
    const dt = e.timeStamp - this.lastT;
    if (dt > 0) this.velocity = (e.clientY - this.lastY) / dt;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    this.pos = this.basePos - dy / this.pageH;   // drag up → pos increases → next
    this.render(false);
  }

  private onUp(e: PointerEvent, gutter: HTMLElement) {
    if (!this.dragging) return;
    this.dragging = false;
    try { gutter.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    const dy = e.clientY - this.startY;
    let step = 0;
    const fastUp = this.velocity <= -VELOCITY_SNAP;
    const fastDown = this.velocity >= VELOCITY_SNAP;
    const farUp = dy <= -this.pageH * DISTANCE_SNAP_FRAC;
    const farDown = dy >= this.pageH * DISTANCE_SNAP_FRAC;
    if (fastUp || farUp) step = 1;
    else if (fastDown || farDown) step = -1;

    this.goTo(this.basePos + step);
  }

  // ── Playable completion / progression ────────────────────────────────────
  private onWindowMessage = (e: MessageEvent) => {
    const i = this.frameIndexForSource(e.source);
    if (i < 0) return;
    const outcome = this.outcomeFromMessage(e.data);
    if (!outcome) return;
    this.handlePlayableCompleted(i, outcome);
  };

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

  private pollPlayableAnalytics = () => {
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
    state.replaceChildren();
    state.hidden = !earned && !failed;
    if (!earned && !failed) return;

    const badge = document.createElement('div');
    badge.className = 'game__state-badge';
    badge.textContent = earned ? '★' : '↻';
    state.appendChild(badge);

    const title = document.createElement('div');
    title.className = 'game__state-title';
    title.textContent = earned ? 'Star earned' : 'Try again';
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
    if (this.starCountEl) this.starCountEl.textContent = String(this.totalStars);
    if (this.levelFillEl) {
      this.levelFillEl.style.transition = animate ? '' : 'none';
      this.levelFillEl.style.transform = `scaleX(${progress})`;
      if (!animate) {
        this.levelFillEl.offsetHeight;
        this.levelFillEl.style.transition = '';
      }
    }
  }

  private addStarToHud() {
    const previous = this.totalStars;
    const next = previous + 1;
    const previousLevel = Math.floor(previous / this.starsPerLevel) + 1;
    const nextLevel = Math.floor(next / this.starsPerLevel) + 1;
    this.totalStars = next;
    if (this.starCountEl) this.starCountEl.textContent = String(this.totalStars);

    this.starCounterEl?.classList.add('hud__stars--bump');
    window.setTimeout(() => this.starCounterEl?.classList.remove('hud__stars--bump'), 260);

    if (nextLevel > previousLevel && this.levelFillEl) {
      this.levelFillEl.style.transform = 'scaleX(1)';
      if (this.levelResetTimer !== null) window.clearTimeout(this.levelResetTimer);
      this.levelResetTimer = window.setTimeout(() => {
        this.updateHud(true);
        this.hudEl?.classList.add('hud--level-up');
        window.setTimeout(() => this.hudEl?.classList.remove('hud--level-up'), 420);
      }, LEVEL_RESET_MS);
      return;
    }

    this.updateHud(true);
  }

  private scheduleAutoAdvanceAfterStar(i: number) {
    window.setTimeout(() => {
      if (this.dragging || this.realIndex() !== i || !this.earnedThisCycle.has(i)) return;
      this.goTo(Math.round(this.pos) + 1);
    }, AUTO_ADVANCE_AFTER_STAR_MS);
  }

  private playStarFlight(i: number) {
    const star = document.createElement('div');
    star.className = 'star-flight';
    star.textContent = '★';
    this.viewport.appendChild(star);

    const viewportRect = this.viewport.getBoundingClientRect();
    const targetRect = this.starCounterEl?.getBoundingClientRect();
    const size = 92;
    const startX = viewportRect.width / 2 - size / 2;
    const startY = viewportRect.height / 2 - size / 2;
    const targetX = targetRect ? targetRect.left - viewportRect.left + targetRect.width / 2 - size / 2 : viewportRect.width - size;
    const targetY = targetRect ? targetRect.top - viewportRect.top + targetRect.height / 2 - size / 2 : 18;

    if (!star.animate) {
      star.remove();
      this.addStarToHud();
      this.scheduleAutoAdvanceAfterStar(i);
      return;
    }

    const animation = star.animate([
      { transform: `translate3d(${startX}px, ${startY}px, 0) scale(0.35) rotate(-18deg)`, opacity: 0 },
      { transform: `translate3d(${startX}px, ${startY}px, 0) scale(1.35) rotate(0deg)`, opacity: 1, offset: 0.18 },
      { transform: `translate3d(${startX}px, ${startY}px, 0) scale(1.12) rotate(8deg)`, opacity: 1, offset: 0.38 },
      { transform: `translate3d(${targetX}px, ${targetY}px, 0) scale(0.38) rotate(26deg)`, opacity: 0.9 },
    ], {
      duration: STAR_FLIGHT_MS,
      easing: 'cubic-bezier(0.2, 0.78, 0.22, 1)',
      fill: 'forwards',
    });
    animation.addEventListener('finish', () => {
      star.remove();
      this.addStarToHud();
      this.scheduleAutoAdvanceAfterStar(i);
    }, { once: true });
  }

  // ── Paging ───────────────────────────────────────────────────────────────
  goTo(targetPos: number) {
    const fromPos = Math.round(this.pos);
    const changed = targetPos !== this.pos;
    this.pos = targetPos;
    if (changed && this.isForwardCycleWrap(fromPos, targetPos)) this.resetCycle();
    this.render(true);
    if (changed) {
      this.updateLive();        // bring the new neighbour live, drop the far tail
      this.prefetchReserve();   // keep the reserve topped up
    }
    // resume/pause happens on the transitionend (= after the slide)
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  private measure() {
    this.pageH = this.viewport.clientHeight;
  }

  private onResize = () => {
    this.measure();
    this.render(false);
  };
}

export function createFeed(viewport: HTMLElement, feedEl: HTMLElement) {
  return new Feed(viewport, feedEl, PLAYABLES);
}
