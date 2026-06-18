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

export class Feed {
  private viewport: HTMLElement;
  private feedEl: HTMLElement;
  private playables: Playable[];
  private N: number;

  private pageH = 0;
  private pos = 0;                  // continuous ring position (settles to an integer)
  private pageEls: HTMLElement[] = [];
  private pageDelta: number[] = [];

  private slots: HTMLElement[] = [];
  private games: HTMLElement[] = [];
  private frames = new Map<number, HTMLIFrameElement>();

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
    this.initialTarget = Math.min(INITIAL_BATCH, this.N);
    this.build();
    this.measure();
    this.render(false);
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

      page.appendChild(game);
      page.appendChild(this.makeGutter(i));
      frag.appendChild(page);

      this.pageEls[i] = page;
      this.games[i] = game;
      this.slots[i] = slot;
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
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('title', this.playables[i].id);
    frame.addEventListener('load', () => {
      this.games[i].classList.remove('game--loading');
      this.setFramePaused(i, i !== this.realIndex());
      this.markReady(i);
    });
    frame.src = playableUrl(this.playables[i].id);
    this.slots[i].appendChild(frame);
    this.frames.set(i, frame);
  }

  private unmount(i: number) {
    const frame = this.frames.get(i);
    if (!frame) return;
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
    const active = this.realIndex();
    this.frames.forEach((_f, i) => this.setFramePaused(i, i !== active));
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

  // ── Paging ───────────────────────────────────────────────────────────────
  goTo(targetPos: number) {
    const changed = targetPos !== this.pos;
    this.pos = targetPos;
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
