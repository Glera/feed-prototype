import type { Mechanic } from './mechanics';
import { createGamePlaceholder } from './game-placeholder';

/**
 * Vertical feed pager (Instagram-Reels / TikTok style).
 *
 * The whole point of phase 1: page the feed ONLY from the bottom gutter, never
 * from the game area. So pointer listeners live exclusively on `.gutter`
 * elements. A drag on a gutter translates the entire feed (gluing the current
 * page to its neighbour), then snaps to the nearest page on release based on
 * distance + flick velocity. Drags inside the game area are handled there and
 * are physically incapable of paging the feed.
 */

const DISTANCE_SNAP_FRAC = 0.18;   // drag past 18% of a page → commit to the next
const VELOCITY_SNAP = 0.45;        // px/ms flick that commits regardless of distance
const EDGE_RESISTANCE = 0.32;      // rubber-band factor past the first/last page

export class Feed {
  private viewport: HTMLElement;
  private feedEl: HTMLElement;
  private mechanics: Mechanic[];

  private pageH = 0;
  private index = 0;

  // Drag state
  private dragging = false;
  private startY = 0;
  private baseOffset = 0;     // -index * pageH at drag start
  private lastY = 0;
  private lastT = 0;
  private velocity = 0;       // px/ms, negative = moving up

  constructor(viewport: HTMLElement, feedEl: HTMLElement, mechanics: Mechanic[]) {
    this.viewport = viewport;
    this.feedEl = feedEl;
    this.mechanics = mechanics;
    this.build();
    this.measure();
    this.applyOffset(this.offsetForIndex(this.index), false);
    window.addEventListener('resize', this.onResize);
  }

  // ── Build DOM ──────────────────────────────────────────────────────────
  private build() {
    const frag = document.createDocumentFragment();
    this.mechanics.forEach((m, i) => {
      const page = document.createElement('div');
      page.className = 'page';

      // Single bottom gutter — the ONLY region that pages the feed, in both
      // directions (drag up → next game, drag down → previous). Its sensitivity
      // is enough to page both ways, so no second handle is needed.
      page.appendChild(createGamePlaceholder(m));
      page.appendChild(this.makeGutter(i));

      frag.appendChild(page);
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

    // Instantaneous velocity (sampled per move; good enough for flick detect).
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
    this.index = Math.max(0, Math.min(this.mechanics.length - 1, target));
    this.setTransition(animate);
    this.applyOffset(this.offsetForIndex(this.index), animate);
  }

  private offsetForIndex(i: number) { return -i * this.pageH; }

  private withResistance(raw: number) {
    const max = 0;
    const min = -(this.mechanics.length - 1) * this.pageH;
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
