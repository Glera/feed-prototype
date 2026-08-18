/**
 * Shared visibility predicate for the two operator popover forms (platform
 * development intake, mechanic rework).
 *
 * `getBoundingClientRect()` is blind to `overflow: hidden` on an ancestor, and
 * both popovers live inside `.feed`, which clips everything above
 * `--top-zone-h`. A contract written as `rect.top >= 0 && rect.bottom <=
 * innerHeight` therefore reports a field that is completely invisible behind
 * the feed's top edge as fully visible — which is exactly how the first attempt
 * at Glera/p4g-workspace-meta#108 measured itself green while the defect still
 * reproduced on device.
 *
 * So visibility here means: the field rect intersected with the clip box of
 * EVERY clipping ancestor is still the whole field, AND the engine's own hit
 * test at the field's centre reaches the field. Both checks import this, so the
 * two contracts cannot drift apart.
 */

/**
 * Source of the page-side measurement. Kept as source so the same body backs
 * both the `evaluate` measurement and the `waitForFunction` settle gate.
 */
const MEASURE_SOURCE = `(selector) => {
  const name = (el) => (el ? (String(el.className || '').trim().split(/\\s+/)[0] || el.tagName.toLowerCase()) : null);
  // Every ancestor that clips painting, exactly as the engine composites it.
  const clipBandOf = (start) => {
    let top = 0;
    let bottom = window.innerHeight;
    const by = [];
    for (let node = start; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible'
        || /(^|\\s)(paint|strict|content)(\\s|$)/.test(style.contain || '');
      if (!clips) continue;
      const box = node.getBoundingClientRect();
      if (box.height <= 0) continue;
      by.push(name(node));
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.bottom);
    }
    return { top, bottom, by };
  };
  const field = document.querySelector(selector);
  if (!field) return null;
  const rect = field.getBoundingClientRect();
  const clip = clipBandOf(field.parentElement);
  const hiddenAbove = Math.max(0, clip.top - rect.top);
  const hiddenBelow = Math.max(0, rect.bottom - clip.bottom);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  const form = field.closest('form');
  const formRect = form ? form.getBoundingClientRect() : null;
  const formClip = form ? clipBandOf(form.parentElement) : null;
  const round = (value) => Math.round(value * 100) / 100;
  return {
    innerHeight: window.innerHeight,
    top: round(rect.top),
    bottom: round(rect.bottom),
    height: round(rect.height),
    clipTop: round(clip.top),
    clipBottom: round(clip.bottom),
    clippedBy: clip.by,
    hiddenAbove: round(hiddenAbove),
    hiddenBelow: round(hiddenBelow),
    // The naive predicate the first attempt shipped, kept so a contract can
    // show it is not what is being asserted.
    naiveVisible: rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight,
    visible: rect.height > 0 && hiddenAbove <= 0.5 && hiddenBelow <= 0.5,
    hit: name(hit),
    hitsField: hit === field || field.contains(hit),
    focused: document.activeElement === field,
    formTop: formRect ? round(formRect.top) : null,
    formBottom: formRect ? round(formRect.bottom) : null,
    formWithinClip: formRect && formClip
      ? formRect.top >= formClip.top - 0.5 && formRect.bottom <= formClip.bottom + 0.5
      : null,
    published: form ? {
      lift: form.style.getPropertyValue('--operator-form-lift'),
      maxHeight: form.style.getPropertyValue('--operator-form-max-height'),
      fieldMaxHeight: form.style.getPropertyValue('--operator-form-field-max-height'),
    } : null,
    // Repairing the popover must never displace the feed behind the operator's
    // back — only the form's own scroll offset may move.
    feedScrollTop: document.querySelector('.feed')?.scrollTop ?? null,
    formScrollTop: form ? Math.round(form.scrollTop) : null,
  };
}`;

/** Page-side measurement, for `page.evaluate(measureOperatorFormField, selector)`. */
export const measureOperatorFormField = new Function(`return ${MEASURE_SOURCE};`)();

/** Page-side settle gate, for `page.waitForFunction(operatorFormFieldSettled, {...})`. */
export const operatorFormFieldSettled = new Function(`return (expected) => {
  const measure = ${MEASURE_SOURCE};
  const measured = measure(expected.selector);
  return Boolean(measured) && measured.innerHeight === expected.innerHeight
    && measured.focused && measured.visible && measured.hitsField;
};`)();

/**
 * The geometries the operator actually hits. 375×260 and 375×330 are the
 * keyboard-open heights that reproduced the defect; the third is a real
 * Telegram iPhone (safe-area insets present, a normal keyboard-open height),
 * where the clip `.feed` imposes is 59px lower still.
 */
export const OPERATOR_FORM_KEYBOARD_GEOMETRIES = Object.freeze([
  Object.freeze({ name: '375×260', width: 375, height: 260, safeTop: null, safeBottom: null }),
  Object.freeze({ name: '375×330', width: 375, height: 330, safeTop: null, safeBottom: null }),
  Object.freeze({
    name: '390×460 Telegram insets', width: 390, height: 460, safeTop: '59px', safeBottom: '34px',
  }),
]);

/**
 * Put the page into one geometry and wait for the form to settle into it.
 *
 * Insets are applied BEFORE the resize on purpose: changing them afterwards
 * relayouts the popover with no viewport event to recompute against, and lets
 * the engine reveal the caret by scrolling an ancestor. That is a harness
 * artifact — on a device the insets and the keyboard arrive together.
 */
export async function applyOperatorFormGeometry(page, geometry, selector) {
  await page.evaluate((insets) => {
    const style = document.documentElement.style;
    if (insets.safeTop === null) {
      style.removeProperty('--safe-top');
      style.removeProperty('--safe-bottom');
      return;
    }
    style.setProperty('--safe-top', insets.safeTop);
    style.setProperty('--safe-bottom', insets.safeBottom);
  }, { safeTop: geometry.safeTop, safeBottom: geometry.safeBottom });
  await page.setViewportSize({ width: geometry.width, height: geometry.height });
  // The caller asserts on the measurement, so a timeout here must not mask the
  // real (and far more readable) geometry assertion below it.
  await page.waitForFunction(
    operatorFormFieldSettled,
    { selector, innerHeight: geometry.height },
    { timeout: 5_000 },
  ).catch(() => {});
  return page.evaluate(measureOperatorFormField, selector);
}

/** One readable line for an assertion message. */
export const describeOperatorFormField = (measured) => (measured
  ? `rect ${measured.top}..${measured.bottom} vs clip ${measured.clipTop}..${measured.clipBottom}`
    + ` (hidden ${measured.hiddenAbove} above / ${measured.hiddenBelow} below, clipped by`
    + ` ${measured.clippedBy.join(' > ')}, hit ${measured.hit},`
    + ` naive predicate says ${measured.naiveVisible})`
  : 'the field is absent');
