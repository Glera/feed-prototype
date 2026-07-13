/**
 * Monotonic active-dwell accumulator.
 *
 * Time is counted only while all three gates are open:
 *   visible ∩ foreground ∩ interactive_ready.
 *
 * The host owns `visible`/`foreground`; the playable readiness handshake owns
 * `interactiveReady`. Callers supply the clock so the implementation stays
 * deterministic in tests and uses performance.now() in the browser.
 */
export class ActiveDwellAccumulator {
  constructor(now = 0) {
    this.reset(now);
  }

  reset(now = 0, gates = {}) {
    this._activeMs = 0;
    this._lastNow = finiteNow(now, 0);
    this._visible = gates.visible === true;
    this._foreground = gates.foreground === true;
    this._interactiveReady = gates.interactiveReady === true;
    this._activeSince = this._isActive() ? this._lastNow : null;
  }

  update(gates, now) {
    const current = this._normalizeNow(now);
    this._accrue(current);
    if (Object.prototype.hasOwnProperty.call(gates, 'visible')) {
      this._visible = gates.visible === true;
    }
    if (Object.prototype.hasOwnProperty.call(gates, 'foreground')) {
      this._foreground = gates.foreground === true;
    }
    if (Object.prototype.hasOwnProperty.call(gates, 'interactiveReady')) {
      this._interactiveReady = gates.interactiveReady === true;
    }
    this._activeSince = this._isActive() ? current : null;
  }

  snapshot(now, dwellCensored = true) {
    const current = this._peekNow(now);
    const running = this._activeSince == null ? 0 : current - this._activeSince;
    return {
      dwellActiveMs: Math.max(0, Math.round(this._activeMs + running)),
      dwellCensored: dwellCensored === true,
    };
  }

  finish(now, dwellCensored = false) {
    const current = this._normalizeNow(now);
    this._accrue(current);
    this._visible = false;
    this._activeSince = null;
    return {
      dwellActiveMs: Math.max(0, Math.round(this._activeMs)),
      dwellCensored: dwellCensored === true,
    };
  }

  _isActive() {
    return this._visible && this._foreground && this._interactiveReady;
  }

  _accrue(now) {
    if (this._activeSince != null) this._activeMs += now - this._activeSince;
    this._lastNow = now;
  }

  _normalizeNow(now) {
    const value = finiteNow(now, this._lastNow);
    return Math.max(this._lastNow, value);
  }

  _peekNow(now) {
    return Math.max(this._lastNow, finiteNow(now, this._lastNow));
  }
}

function finiteNow(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}
