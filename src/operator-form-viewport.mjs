/**
 * Keeps the focused field of an operator popover form inside the band the
 * operator can actually SEE while the on-screen keyboard is open.
 *
 * Both operator forms — the mechanic rework and the platform development
 * intake — are popovers anchored above the feed bar that grow upward, and both
 * live inside `.feed`, which clips (`overflow: hidden` + `contain: paint`)
 * everything above `--top-zone-h`. So the popover is squeezed between two
 * edges that no single CSS constant knows about:
 *
 *   ┌─ layout viewport ────────────────────┐
 *   │  HUD / top zone   (clipped by .feed) │  ← nothing above this line renders
 *   ├──────────────────────────────────────┤  clip top
 *   │  ← the popover may only live here →  │
 *   ├──────────────────────────────────────┤  the popover's anchored bottom
 *   │  feed bar + its clearance            │
 *   ├──────────────────────────────────────┤  visual-viewport bottom
 *   │  on-screen keyboard                  │  ← only when the HOST does not
 *   └──────────────────────────────────────┘    shrink the layout viewport
 *
 * A bound written from CSS constants gets this wrong twice: it cannot see the
 * clip that `.feed` imposes at the top, and on a host that shrinks only the
 * VISUAL viewport (`visualViewport.height < innerHeight`, `offsetTop > 0`) a
 * bottom-anchored popover has to be lifted, not merely shortened — shortening
 * it alone drives it further behind the keyboard. Both mistakes shipped in the
 * first attempt at Glera/p4g-workspace-meta#108 and both reproduced on device.
 *
 * So everything here is MEASURED, never re-derived from the stylesheet, and
 * published as three custom properties consumed by styles.css:
 *
 *   --operator-form-lift              how far the popover must rise to clear
 *                                     the keyboard (0 when the host resizes
 *                                     the layout viewport, i.e. Telegram)
 *   --operator-form-max-height        the height actually available between
 *                                     the clip top and the lifted bottom
 *   --operator-form-field-max-height  the same minus the form's own padding
 *                                     and border, so no single field can be
 *                                     taller than the box that must show it
 *
 * Manual scrolling is never hijacked: there is no scroll listener on the page,
 * only the form's own scroll offset is ever moved (an ancestor with
 * `overflow: hidden` is still programmatically scrollable, and displacing the
 * feed behind the operator's back would be a worse bug than the one being
 * fixed), and a field that is already fully visible is left where it is.
 */

/** The keyboard animates in after focus; measuring earlier reads the old viewport. */
const KEYBOARD_SETTLE_MS = 250;
/** A field flush against the edge of the visible band still counts as hidden. */
const EDGE_MARGIN_PX = 6;
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
]);
/** `contain` values that clip painting exactly like `overflow: hidden` does. */
const CLIPPING_CONTAIN = /(^|\s)(paint|strict|content)(\s|$)/;

const isTextField = (node) => node instanceof HTMLTextAreaElement
  || (node instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(node.type));

const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

/**
 * The band of the LAYOUT viewport the operator can see, in client coordinates
 * (the same space `getBoundingClientRect()` reports in). `visualViewport` is
 * the only surface that reports the keyboard; without it the whole layout
 * viewport is assumed visible.
 */
function visualBand(viewport) {
  const height = finite(viewport?.height, 0);
  if (height > 0) {
    const top = Math.max(0, finite(viewport.offsetTop, 0));
    return { top, bottom: top + height };
  }
  const inner = finite(window.innerHeight, 0);
  return { top: 0, bottom: inner };
}

/**
 * The band left by every clipping ancestor. `getBoundingClientRect()` is blind
 * to `overflow: hidden` on an ancestor, which is precisely how the first fix
 * measured itself green while the field sat behind `.feed`'s top edge.
 */
function clipBand(form) {
  let top = 0;
  let bottom = finite(window.innerHeight, 0);
  for (let node = form.parentElement; node instanceof HTMLElement; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible'
      || CLIPPING_CONTAIN.test(style.contain || '');
    if (!clips) continue;
    const box = node.getBoundingClientRect();
    if (box.height <= 0) continue;
    top = Math.max(top, box.top);
    bottom = Math.min(bottom, box.bottom);
  }
  return { top, bottom };
}

/**
 * An `overflow: hidden` box has no scrollbar and no gesture: the operator can
 * never scroll it and can never scroll it back. So a non-zero offset on one is
 * always engine-initiated — typically revealing the caret of a focused field —
 * and it drags this bar-anchored popover straight out of the band it was just
 * fitted into. `.feed` is exactly such a box, and its scrollHeight runs to
 * thousands of pixels because the feed stacks its pages by transform.
 *
 * Restoring those offsets is not hijacking a scroll; it is undoing a scroll the
 * operator never asked for and cannot undo. Boxes that CAN be scrolled by hand
 * (`auto`/`scroll`, including this form itself) are never touched.
 */
function restoreEngineScroll(form) {
  for (let node = form.parentElement; node instanceof HTMLElement; node = node.parentElement) {
    if (node.scrollTop === 0) continue;
    if (window.getComputedStyle(node).overflowY !== 'hidden') continue;
    node.scrollTop = 0;
  }
}

/** Padding + border the form's own `max-height` has to pay for. */
function verticalInsets(style) {
  if (style.boxSizing !== 'border-box') return 0;
  return finite(parseFloat(style.paddingTop), 0) + finite(parseFloat(style.paddingBottom), 0)
    + finite(parseFloat(style.borderTopWidth), 0) + finite(parseFloat(style.borderBottomWidth), 0);
}

/**
 * Bind one operator form. Returns the control the caller releases from its own
 * destroy path — nothing here outlives the form it was mounted for.
 *
 * `options.viewport` is the visual-viewport source and defaults to
 * `window.visualViewport`. It is injectable so the divergent case a browser
 * harness cannot stage (visual viewport shrinks, layout viewport does not) is
 * still covered deterministically.
 */
export function observeOperatorFormViewport(form, options = {}) {
  const noop = Object.freeze({ reveal() {}, release() {} });
  if (!(form instanceof HTMLElement) || typeof window === 'undefined') return noop;
  const viewport = options.viewport === undefined ? (window.visualViewport ?? null) : options.viewport;
  let released = false;
  let timer = null;
  /** The lift currently applied, so the anchored bottom can be recovered from a measured rect. */
  let appliedLift = 0;

  const write = (name, value) => {
    if (value === null) {
      form.style.removeProperty(name);
      return;
    }
    if (form.style.getPropertyValue(name) !== value) form.style.setProperty(name, value);
  };
  const withdraw = () => {
    appliedLift = 0;
    write('--operator-form-lift', null);
    write('--operator-form-max-height', null);
    write('--operator-form-field-max-height', null);
  };

  const focusedField = () => {
    const active = form.ownerDocument?.activeElement ?? null;
    return isTextField(active) && form.contains(active) ? active : null;
  };

  /** The band this popover may occupy, or null while it is not rendered. */
  const measure = () => {
    if (form.getBoundingClientRect().height <= 0) return null;   // hidden / not laid out
    // Undo any engine caret-reveal first: measuring a displaced popover would
    // fit it to a band it is not actually in.
    restoreEngineScroll(form);
    const rect = form.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const band = visualBand(viewport);
    const clip = clipBand(form);
    // On a host that shrinks only the visual viewport the popover is anchored
    // to a layout bottom that now sits behind the keyboard; lifting it by that
    // gap keeps its designed clearance above the bar, measured from the edge
    // the operator can actually see. Telegram resizes the layout viewport, so
    // the gap — and the lift — are exactly 0 there.
    const lift = Math.max(0, Math.ceil(finite(window.innerHeight, 0) - band.bottom));
    const anchoredBottom = rect.bottom + appliedLift;
    const top = Math.max(clip.top, band.top);
    const bottom = Math.min(anchoredBottom - lift, clip.bottom, band.bottom);
    return { lift, top, bottom, height: Math.floor(bottom - top) };
  };

  /** Publish the measured band. Returns it, or null when there is nothing to bound. */
  const apply = () => {
    if (released) return null;
    const measured = measure();
    if (!measured || measured.height <= 0) {
      withdraw();
      return null;
    }
    appliedLift = measured.lift;
    write('--operator-form-lift', `${measured.lift}px`);
    write('--operator-form-max-height', `${measured.height}px`);
    const insets = verticalInsets(window.getComputedStyle(form));
    write('--operator-form-field-max-height', `${Math.max(0, Math.floor(measured.height - insets))}px`);
    return measured;
  };

  const reveal = () => {
    const measured = apply();
    if (!measured) return;
    const field = focusedField();
    if (!field) return;
    // Read AFTER publishing: the bound is what moved the field in the first place.
    const rect = field.getBoundingClientRect();
    if (rect.height <= 0) return;
    if (rect.top >= measured.top + EDGE_MARGIN_PX
      && rect.bottom <= measured.bottom - EDGE_MARGIN_PX) return;
    // Only the form's own scroll offset — never an ancestor's.
    form.scrollTop += (rect.top + rect.height / 2) - (measured.top + measured.bottom) / 2;
  };

  const scheduleReveal = () => {
    if (released) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      reveal();
    }, KEYBOARD_SETTLE_MS);
  };
  const onFocusIn = (event) => {
    if (!isTextField(event.target)) return;
    reveal();          // bound the popover now, before the keyboard animates
    scheduleReveal();  // and again once the viewport has actually changed
  };
  // iOS fires `scroll` on the visual viewport without a `resize` when the page
  // is panned under an open keyboard, so both are the same signal here.
  const onViewportChange = () => reveal();
  // Hiding the form must not leave a stale bound behind for the next open.
  const onHiddenChange = () => reveal();
  const hiddenObserver = new MutationObserver(onHiddenChange);

  form.addEventListener('focusin', onFocusIn);
  viewport?.addEventListener?.('resize', onViewportChange);
  viewport?.addEventListener?.('scroll', onViewportChange);
  window.addEventListener('resize', onViewportChange);
  hiddenObserver.observe(form, { attributes: true, attributeFilter: ['hidden'] });
  apply();

  return Object.freeze({
    reveal,
    release() {
      if (released) return;
      released = true;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      form.removeEventListener('focusin', onFocusIn);
      viewport?.removeEventListener?.('resize', onViewportChange);
      viewport?.removeEventListener?.('scroll', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
      hiddenObserver.disconnect();
      withdraw();
    },
  });
}
