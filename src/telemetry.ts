/**
 * Telemetry client (D3). Queue events, flush every ~5s and on visibilitychange /
 * pagehide. The final flush uses navigator.sendBeacon — which CANNOT set an
 * Authorization header — so we send initData in the body (`init_data`); the
 * backend reads it from there or the header. Never throws; telemetry must never
 * break the feed.
 *
 * Event names + props follow D3. Emit with track(name, props). The server stamps
 * user_id from auth and created_at; we send session_id + client_ts.
 */
import { API_BASE } from './api';
import { getInitData } from './telegram';

interface Ev {
  session_id: string;
  name: string;
  props?: Record<string, unknown>;
  client_ts: string;
  run_id?: string;
}

const FLUSH_MS = 5000;
const EVENTS_URL = `${API_BASE}/api/events`;

const sessionId: string =
  (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;

let queue: Ev[] = [];
let timer: number | null = null;

export function sessionIdOf(): string {
  return sessionId;
}

export function track(name: string, props?: Record<string, unknown>, runId?: string): void {
  queue.push({
    session_id: sessionId,
    name,
    props,
    client_ts: new Date().toISOString(),
    run_id: runId,
  });
  if (timer == null) timer = window.setTimeout(flush, FLUSH_MS);
}

/** Regular flush via fetch (keepalive so an in-flight one survives a nav). */
function flush(): void {
  if (timer != null) { window.clearTimeout(timer); timer = null; }
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  const body = JSON.stringify({ events, init_data: getInitData() });
  try {
    fetch(EVENTS_URL, {
      method: 'POST',
      // text/plain is a CORS-simple content type → NO preflight (the backend
      // parses the body regardless of type). Avoids a per-flush OPTIONS RTT and,
      // crucially, keeps the terminal beacon (below) from needing a cached one.
      headers: { 'Content-Type': 'text/plain' },
      body,
      keepalive: true,
    }).catch(() => { /* drop — telemetry is best-effort */ });
  } catch {
    /* noop */
  }
}

/** Terminal flush on background/close — sendBeacon (survives unload). */
function beaconFlush(): void {
  if (timer != null) { window.clearTimeout(timer); timer = null; }
  if (queue.length === 0) return;
  const events = queue;
  queue = [];
  const payload = JSON.stringify({ events, init_data: getInitData() });
  try {
    // text/plain Blob → CORS-simple → sendBeacon fires WITHOUT a preflight (a
    // cross-origin application/json beacon needs a cached preflight that a short
    // session may never have warmed). Backend parses the body regardless of type.
    const blob = new Blob([payload], { type: 'text/plain' });
    if (navigator.sendBeacon && navigator.sendBeacon(EVENTS_URL, blob)) return;
  } catch {
    /* fall through */
  }
  try {
    fetch(EVENTS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: payload, keepalive: true }).catch(() => {});
  } catch { /* noop */ }
}

export function initTelemetry(): void {
  document.addEventListener('visibilitychange', () => { if (document.hidden) beaconFlush(); });
  window.addEventListener('pagehide', beaconFlush);
}
