/**
 * Shared celebration FX.
 *
 * Extracted verbatim from the feed chest ceremony (`burstStarConfetti`) so the
 * island can celebrate a house upgrade with the EXACT same burst — same colours,
 * same physics, same `.confetti` element (styles.css) — instead of growing a
 * second particle engine.
 */

/**
 * Level-up-style confetti: a one-shot burst that rains down evenly across the
 * WHOLE layer from the top. `layer` must be a positioned element (the feed
 * viewport or the island overlay); the pieces remove themselves.
 */
export function burstConfetti(layer: HTMLElement, zIndex = 2580): void {
  const colors = ['#ffd85a', '#45d68c', '#37a6ff', '#ff4f8b', '#ff9f45', '#b07bff', '#5ee6a8'];
  const rect = layer.getBoundingClientRect();
  const count = 40;
  for (let n = 0; n < count; n++) {
    const c = document.createElement('div');
    c.className = 'confetti';
    const w = 7 + Math.random() * 7, h = 10 + Math.random() * 10;
    // Spread evenly across the width (n-based columns + jitter) so the fall is uniform.
    const x = ((n + Math.random()) / count) * rect.width;
    c.style.cssText =
      `left:${x}px;top:-24px;width:${w}px;height:${h}px;z-index:${zIndex};` +
      `background:${colors[(n + Math.floor(Math.random() * colors.length)) % colors.length]};` +
      `border-radius:${Math.random() < 0.4 ? '50%' : '2px'};`;
    layer.appendChild(c);
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
