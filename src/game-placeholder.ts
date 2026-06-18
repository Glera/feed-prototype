import type { Mechanic } from './mechanics';

/**
 * Builds a placeholder "mini-game" container.
 *
 * The key phase-1 job here is to prove gesture separation: this container owns
 * a draggable puck. Dragging anywhere inside the game area moves the puck and
 * MUST NOT page the feed. Feed paging is wired only to the gutter (see feed.ts),
 * so in-game drags are naturally isolated — the puck just makes that visible.
 */
export function createGamePlaceholder(m: Mechanic): HTMLElement {
  const game = document.createElement('div');
  game.className = 'game';
  game.style.background = `linear-gradient(160deg, ${m.accent[0]}, ${m.accent[1]})`;

  const label = document.createElement('div');
  label.className = 'game__label';
  label.textContent = m.title;
  game.appendChild(label);

  const puck = document.createElement('div');
  puck.className = 'game__puck';
  puck.textContent = '🎮';
  game.appendChild(puck);

  const hint = document.createElement('div');
  hint.className = 'game__hint';
  hint.textContent = 'Drag here = in-game · feed stays put';
  game.appendChild(hint);

  // ── In-game drag (independent of feed paging) ────────────────────────────
  // Position the puck in game-local coordinates. We center it after layout.
  let px = 0, py = 0;          // puck centre, in game-local px
  let dragging = false;
  let grabDX = 0, grabDY = 0;  // pointer offset from puck centre at grab

  const place = () => { puck.style.transform = `translate(${px}px, ${py}px)`; };

  // Center once the element has a measured size.
  requestAnimationFrame(() => {
    const r = game.getBoundingClientRect();
    px = r.width / 2 - puck.offsetWidth / 2;
    py = r.height / 2 - puck.offsetHeight / 2;
    place();
  });

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  const onDown = (e: PointerEvent) => {
    dragging = true;
    const gameRect = game.getBoundingClientRect();
    const puckRect = puck.getBoundingClientRect();
    // Where inside the puck did we grab (so it doesn't jump to centre)?
    grabDX = e.clientX - (puckRect.left + puckRect.width / 2);
    grabDY = e.clientY - (puckRect.top + puckRect.height / 2);
    // If the press was outside the puck, snap the puck under the finger.
    const overPuck = e.target === puck;
    if (!overPuck) { grabDX = 0; grabDY = 0; }
    moveTo(e, gameRect);
    game.setPointerCapture(e.pointerId);
    // Stop the event from reaching anything else. (Feed never listens here,
    // but this keeps the intent explicit.)
    e.stopPropagation();
  };

  const moveTo = (e: PointerEvent, gameRect?: DOMRect) => {
    const r = gameRect ?? game.getBoundingClientRect();
    px = clamp(e.clientX - r.left - grabDX - puck.offsetWidth / 2, 0, r.width - puck.offsetWidth);
    py = clamp(e.clientY - r.top - grabDY - puck.offsetHeight / 2, 0, r.height - puck.offsetHeight);
    place();
  };

  const onMove = (e: PointerEvent) => { if (dragging) { moveTo(e); e.stopPropagation(); } };
  const onUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { game.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };

  game.addEventListener('pointerdown', onDown);
  game.addEventListener('pointermove', onMove);
  game.addEventListener('pointerup', onUp);
  game.addEventListener('pointercancel', onUp);

  return game;
}
