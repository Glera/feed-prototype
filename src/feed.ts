import { PLAYABLES, playableUrl, type Playable } from './playables';

/**
 * Vertical feed pager (Instagram-Reels / TikTok style) over real playables.
 *
 * Gesture separation (phase 1): paging is wired ONLY to the bottom gutter, so
 * in-game gestures (inside the playable's <iframe>) never page the feed.
 *
 * Lazy loading (phase 2): mini-games are heavy (3–5 MB, live physics/WebGL), so
 * we keep only a sliding window of <iframe>s mounted — always RESERVE_AHEAD
 * loaded ahead of the current page (the "reserve"), a few behind for instant
 * back-swipe, and nothing beyond that. A preloader screen covers the initial
 * batch so the first swipes are seamless.
 */

const DISTANCE_SNAP_FRAC = 0.18;   // drag past 18% of a page → commit to the next
const VELOCITY_SNAP = 0.45;        // px/ms flick that commits regardless of distance
const EDGE_RESISTANCE = 0.32;      // rubber-band factor past the first/last page

// Lazy-load window.
const RESERVE_AHEAD = 5;           // always keep this many games loaded AHEAD of current
const KEEP_BEHIND = 1;             // and this many behind (instant back-swipe). Don't load beyond.
const INITIAL_BATCH = 5;           // preloader waits for the first N to finish loading
const PRELOADER_TIMEOUT_MS = 15000;

export class Feed {
  private viewport: HTMLElement;
  private feedEl: HTMLElement;
  private playables: Playable[];

  private pageH = 0;
  private index = 0;

  // Per-index DOM + mount state.
  private slots: HTMLElement[] = [];          // where each iframe mounts
  private games: HTMLElement[] = [];          // the .game container (toggles loading state)
  private frames: (HTMLIFrameElement | null)[] = [];

  // Preloader state.
  private preloaderEl: HTMLElement | null = null;
  private preloaderProgressEl: HTMLElement | null = null;
  private initialTarget = 0;
  private initialLoaded = new Set<number>();
  private preloaderDone = false;

  // Drag state.
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
    this.mountWindow();
    window.addEventListener('resize', this.onResize);
  }

  // ── Build DOM ──────────────────────────────────────────────────────────
  private build() {
    const frag = document.createDocumentFragment();
    this.playables.forEach((p, i) => {
      const page = document.createElement('div');
      page.className = 'page';

      // Game container — the playable mounts here. Does NOT fill the page; the
      // gutter below stays free as the paging handle.
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
      this.frames[i] = null;
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

  // ── Lazy-load window ──────────────────────────────────────────────────────
  private mountWindow() {
    const lo = Math.max(0, this.index - KEEP_BEHIND);
    const hi = Math.min(this.playables.length - 1, this.index + RESERVE_AHEAD);
    for (let i = 0; i < this.playables.length; i++) {
      if (i >= lo && i <= hi) this.mount(i);
      else this.unmount(i);
    }
  }

  private mount(i: number) {
    if (this.frames[i]) return;
    const frame = document.createElement('iframe');
    frame.className = 'game__frame';
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('title', this.playables[i].id);
    frame.addEventListener('load', () => {
      this.games[i].classList.remove('game--loading');
      this.onFrameLoad(i);
    });
    frame.src = playableUrl(this.playables[i].id);
    this.slots[i].appendChild(frame);
    this.frames[i] = frame;
  }

  private unmount(i: number) {
    const frame = this.frames[i];
    if (!frame) return;
    frame.remove();                       // destroying the element frees its browsing context
    this.frames[i] = null;
    this.games[i].classList.add('game--loading');
  }

  // ── Preloader ─────────────────────────────────────────────────────────────
  private mountPreloader() {
    const el = document.createElement('div');
    el.className = 'preloader';
    el.innerHTML =
      '<div class="preloader__spinner"></div>' +
      '<div class="preloader__title">Loading mini-games…</div>' +
      '<div class="preloader__progress">0 / ' + this.initialTarget + '</div>';
    this.viewport.appendChild(el);
    this.preloaderEl = el;
    this.preloaderProgressEl = el.querySelector('.preloader__progress');
    // Safety net: never trap the user behind the preloader if a bundle stalls.
    window.setTimeout(() => this.finishPreloader(), PRELOADER_TIMEOUT_MS);
  }

  private onFrameLoad(i: number) {
    if (this.preloaderDone || i >= this.initialTarget) return;
    this.initialLoaded.add(i);
    if (this.preloaderProgressEl) {
      this.preloaderProgressEl.textContent = `${this.initialLoaded.size} / ${this.initialTarget}`;
    }
    if (this.initialLoaded.size >= this.initialTarget) this.finishPreloader();
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
    if (changed) this.mountWindow();        // top up the reserve ahead, drop the far tail
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
    this.viewport.style.setProperty('--ph', `${this.pageH}px`);
    const pages = this.feedEl.querySelectorAll<HTMLElement>('.page');
    pages.forEach((p) => { p.style.height = `${this.pageH}px`; });
  }

  private onResize = () => {
    this.measure();
    this.applyOffset(this.offsetForIndex(this.index), false);
  };
}

// Convenience for main.ts.
export function createFeed(viewport: HTMLElement, feedEl: HTMLElement) {
  return new Feed(viewport, feedEl, PLAYABLES);
}
