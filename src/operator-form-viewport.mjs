/**
 * Keeps the focused field of an operator popover form on screen while the
 * on-screen keyboard is open.
 *
 * Both operator forms — the mechanic rework and the platform development
 * intake — are popovers anchored above the feed bar that grow upward. The
 * keyboard shrinks the visible viewport from the bottom, so a form taller than
 * what is left is clipped at the TOP: the instruction textarea leaves the
 * screen and the operator types blind (real iOS Telegram dogfood,
 * Glera/p4g-workspace-meta#108).
 *
 * Scrolling alone cannot repair that: the popover overflows above its
 * container, and no ancestor can scroll backwards past its own origin. So the
 * form first publishes the currently visible height as
 * `--operator-form-viewport`, which bounds it into its own scroll container
 * (see styles.css), and only then is the focused field centred inside it.
 *
 * Manual scrolling is never hijacked: there is no scroll listener, and a field
 * that is already fully visible is left exactly where the operator put it.
 */

/** The keyboard animates in after focus; measuring earlier reads the old viewport. */
const KEYBOARD_SETTLE_MS = 250;
/** A field flush against the edge of the visible band still counts as hidden. */
const VISIBLE_MARGIN_PX = 8;
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit',
]);

/**
 * The band of the layout viewport the operator can actually see. `visualViewport`
 * is the only surface that reports the keyboard; without it the whole layout
 * viewport is assumed visible.
 */
function visibleBand() {
  const viewport = typeof window === 'undefined' ? null : window.visualViewport;
  const height = Number(viewport?.height);
  if (Number.isFinite(height) && height > 0) {
    const offsetTop = Number(viewport.offsetTop);
    const top = Number.isFinite(offsetTop) ? offsetTop : 0;
    return { top, bottom: top + height, height };
  }
  const fallback = Number(typeof window === 'undefined' ? 0 : window.innerHeight) || 0;
  return { top: 0, bottom: fallback, height: fallback };
}

const isTextField = (node) => node instanceof HTMLTextAreaElement
  || (node instanceof HTMLInputElement && !NON_TEXT_INPUT_TYPES.has(node.type));

/**
 * Bind one operator form. Returns the control the caller releases from its own
 * destroy path — nothing here outlives the form it was mounted for.
 */
export function observeOperatorFormViewport(form) {
  const noop = Object.freeze({ reveal() {}, release() {} });
  if (!(form instanceof HTMLElement) || typeof window === 'undefined') return noop;
  const viewport = window.visualViewport ?? null;
  let released = false;
  let timer = null;

  const focusedField = () => {
    const active = form.ownerDocument?.activeElement ?? null;
    return isTextField(active) && form.contains(active) ? active : null;
  };
  const publishVisibleHeight = () => {
    const band = visibleBand();
    if (band.height > 0) {
      form.style.setProperty('--operator-form-viewport', `${Math.round(band.height)}px`);
    }
    return band;
  };
  const reveal = () => {
    if (released || form.hidden) return;
    const band = publishVisibleHeight();
    const field = focusedField();
    if (!field || band.height <= 0) return;
    const rect = field.getBoundingClientRect();
    if (rect.top >= band.top + VISIBLE_MARGIN_PX
      && rect.bottom <= band.bottom - VISIBLE_MARGIN_PX) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;
    field.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    });
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
    if (isTextField(event.target)) scheduleReveal();
  };
  const onViewportResize = () => reveal();

  form.addEventListener('focusin', onFocusIn);
  viewport?.addEventListener('resize', onViewportResize);
  publishVisibleHeight();

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
      viewport?.removeEventListener('resize', onViewportResize);
      form.style.removeProperty('--operator-form-viewport');
    },
  });
}
