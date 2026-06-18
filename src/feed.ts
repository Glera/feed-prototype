import { PLAYABLES, playableUrl, type Playable } from './playables';

/**
 * Vertical feed pager (Instagram-Reels / TikTok style) over real playables.
 *
 * Gesture separation (phase 1): paging is wired ONLY to the bottom gutter, so
 * in-game gestures (inside the playable's <iframe>) never page the feed.
 *
 * Loading model (phase 2):
 *  - A small LIVE window of neighbours (prev / current / next) is instantiated
 *    and fully rendered, so sliding either way is instant — no loader after the
 *    slide.
 *  - Only the CURRENT game runs; neighbours are PAUSED (ready but frozen) via
 *    the playable's own visibility lifecycle (we flip the iframe document's
 *    `hidden` + dispatch `visibilitychange`; works because the bundles are
 *    same-origin on Render / via the dev middleware). The next game is RESUMED
 *    only after the slide settles, and the previous one is paused — so we never
 *    run several games at once ("no slideshow").
 *  - Beyond the live window, RESERVE_AHEAD bundles are PREFETCHED (bytes only)
 *    into the HTTP cache so promoting them to live is instant.
 *  - A fill-bar preloader covers the initial batch.
 *
 * Page sizing is pure CSS (% off the viewport), so it never depends on JS
 * measure timing — exactly one page stays on screen.
 */

const DISTANCE_SNAP_FRAC = 0.18;   // drag past 18% of a page → commit to the next
const VELOCITY_SNAP = 0.45;        // px/ms flick that commits regardless of distance
const EDGE_RESISTANCE = 0.32;      // rubber-band factor past the first/last page

const LIVE_AHEAD = 1;              // instantiate this many ahead (ready & rendered, paused)
const LIVE_BEHIND = 1;            // and this many behind (instant back-swipe)
const RESERVE_AHEAD = 5;           // prefetch this many bundles ahead (bytes only)
const PREFETCH_BEHIND = 1;
const INITIAL_BATCH = 5;           // preloader fills until the first N are ready
const PRELOADER_TIMEOUT_MS = 15000;

export class Feed {
  private viewport: HTMLElement;
  private feedEl: HTMLElement;
  private playables: Playable[];

  private pageH = 0;
  private index = 0;

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
  private baseOffset = 0;
  private lastY = 0;
  private lastT = 0;
  private velocity = 0;

  constructor(viewport: HTMLElement, feedEl: HTMLElement, playables: Playable[]) {
    this.viewport = viewport;
    this.feedEl = feedEl;
    this.playables = playables;
    this.initialTarget = Math.min(INITIAL_BATCH, playables.length);
    this.build();
    this.measure();
    this.applyOffset(this.offsetForIndex(this.index), false);
    this.mountPreloader();

    // Resume the arrived game / pause the rest only AFTER the slide settles.
    this.feedEl.addEventListener('transitionend', (e) => {
      if (e.propertyName !== 'transform' || this.dragging) return;
      this.applyActiveStates();
    });

    this.updateLive();          // instantiate the initial live window
    this.prefetchReserve();     // warm the reserve in the background
    this.applyActiveStates();   // current runs, neighbours pause (once loaded)
    window.addEventListener('resize', this.onResize);
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

  // ── Live window (instantiate neighbours, tear down the far ones) ───────────
  private updateLive() {
    const lo = Math.max(0, this.index - LIVE_BEHIND);
    const hi = Math.min(this.playables.length - 1, this.index + LIVE_AHEAD);
    for (let i = 0; i < this.playables.length; i++) {
      if (i >= lo && i <= hi) this.mount(i);
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
      this.setFramePaused(i, i !== this.index);   // neighbours start paused
      this.markReady(i);
    });
    frame.src = playableUrl(this.playables[i].id);
    this.slots[i].appendChild(frame);
    this.frames.set(i, frame);
  }

  private unmount(i: number) {
    const frame = this.frames.get(i);
    if (!frame) return;
    frame.remove();                       // destroying the element frees its browsing context
    this.frames.delete(i);
    this.games[i].classList.add('game--loading');
  }

  // Pause/resume a playable by flipping its document visibility — the same
  // signal the playable's lifecycle already honors (document.hidden +
  // visibilitychange). Best-effort: only works while the bundle is same-origin
  // (Render / dev middleware); cross-origin (?base=other host) throws and we
  // simply leave it running.
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

  // Run the current game, pause every other live one.
  private applyActiveStates() {
    this.frames.forEach((_f, i) => this.setFramePaused(i, i !== this.index));
  }

  // ── Prefetch reserve (bytes only) ──────────────────────────────────────────
  private prefetchReserve() {
    const from = Math.max(0, this.index - PREFETCH_BEHIND);
    const to = Math.min(this.playables.length - 1, this.index + RESERVE_AHEAD);
    for (let j = from; j <= to; j++) {
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
    this.baseOffset = this.offsetForIndex(this.index);
    this.setTransition(false);
    gutter.setPointerCapture(e.pointerId);
  }

  private onMove(e: PointerEvent) {
    if (!this.dragging) return;
    const dy = e.clientY - this.startY;
    const dt = e.timeStamp - this.lastT;
    if (dt > 0) this.velocity = (e.clientY - this.lastY) / dt;
    this.lastY = e.clientY;
    this.lastT = e.timeStamp;
    this.applyOffset(this.withResistance(this.baseOffset + dy), false);
  }

  private onUp(e: PointerEvent, gutter: HTMLElement) {
    if (!this.dragging) return;
    this.dragging = false;
    try { gutter.releasePointerCapture(e.pointerId); } catch { /* noop */ }

    const dy = e.clientY - this.startY;
    let target = this.index;
    const fastUp = this.velocity <= -VELOCITY_SNAP;
    const fastDown = this.velocity >= VELOCITY_SNAP;
    const farUp = dy <= -this.pageH * DISTANCE_SNAP_FRAC;
    const farDown = dy >= this.pageH * DISTANCE_SNAP_FRAC;

    if (fastUp || farUp) target = this.index + 1;
    else if (fastDown || farDown) target = this.index - 1;

    this.goTo(target, true);
  }

  // ── Paging ───────────────────────────────────────────────────────────────
  goTo(target: number, animate: boolean) {
    const clamped = Math.max(0, Math.min(this.playables.length - 1, target));
    const changed = clamped !== this.index;
    this.index = clamped;
    this.setTransition(animate);
    this.applyOffset(this.offsetForIndex(this.index), animate);
    if (changed) {
      this.updateLive();          // bring the new neighbour live, drop the far tail
      this.prefetchReserve();     // keep the reserve topped up
    }
    // Resume/pause happens on the transition end (= after the slide). If there's
    // no animation (resize), apply immediately.
    if (!animate) this.applyActiveStates();
  }

  private offsetForIndex(i: number) { return -i * this.pageH; }

  private withResistance(raw: number) {
    const max = 0;
    const min = -(this.playables.length - 1) * this.pageH;
    if (raw > max) return max + (raw - max) * EDGE_RESISTANCE;
    if (raw < min) return min + (raw - min) * EDGE_RESISTANCE;
    return raw;
  }

  private applyOffset(y: number, animate: boolean) {
    this.setTransition(animate);
    this.feedEl.style.transform = `translate3d(0, ${y}px, 0)`;
  }

  private setTransition(on: boolean) {
    this.feedEl.style.transition = on ? 'transform 0.36s var(--ease-snap)' : 'none';
  }

  // ── Layout ────────────────────────────────────────────────────────────────
  private measure() {
    this.pageH = this.viewport.clientHeight;
  }

  private onResize = () => {
    this.measure();
    this.applyOffset(this.offsetForIndex(this.index), false);
  };
}

export function createFeed(viewport: HTMLElement, feedEl: HTMLElement) {
  return new Feed(viewport, feedEl, PLAYABLES);
}
