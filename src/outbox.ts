/**
 * Durable results outbox. A win must never be lost to a cold Render instance or
 * a network blip, so we DON'T fire-and-forget /results — we persist each win to
 * localStorage and retry until the server confirms. Idempotent on the server
 * (dedup by run_id), so replays are safe. Flushed on boot, on foreground, and
 * right after enqueue.
 */
import { apiPostResult, type ResultIn } from './api';

const LEGACY_KEY = 'swipe_pending_results_v1';
const LEGACY_EVER_KEY = 'swipe_stars_ever_v1';
const KEY = 'swipe_pending_results_v2';
const EVER_KEY = 'swipe_stars_ever_v2';
const migratedScopes = new Set<string>();

export interface ConfirmedBalances {
  stars: number;
  puzzles: number | null;
}

function telegramUserId(): string | null {
  const id = (window as unknown as {
    Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } };
  }).Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return Number.isSafeInteger(id) ? String(id) : null;
}

function storageKeys(): { queue: string; ever: string; scoped: boolean } {
  const userId = telegramUserId();
  const keys = userId
    ? { queue: `${KEY}:${userId}`, ever: `${EVER_KEY}:${userId}`, scoped: true }
    : { queue: KEY, ever: EVER_KEY, scoped: false };
  if (keys.scoped) migrateLegacy(keys);
  return keys;
}

function migrateLegacy(keys: { queue: string; ever: string }): void {
  if (migratedScopes.has(keys.queue)) return;
  try {
    // Also adopt an unscoped v2 entry created before Telegram exposed the user
    // identity during this page boot.
    const queue = localStorage.getItem(KEY) || localStorage.getItem(LEGACY_KEY);
    const ever = localStorage.getItem(EVER_KEY) || localStorage.getItem(LEGACY_EVER_KEY);
    if (queue && !localStorage.getItem(keys.queue)) localStorage.setItem(keys.queue, queue);
    if (ever && !localStorage.getItem(keys.ever)) localStorage.setItem(keys.ever, ever);
    localStorage.removeItem(KEY);
    localStorage.removeItem(EVER_KEY);
    localStorage.removeItem(LEGACY_KEY);
    localStorage.removeItem(LEGACY_EVER_KEY);
  } catch { /* storage blocked */ }
  migratedScopes.add(keys.queue);
}

/** Total stars ever enqueued on this device — compare vs server balance to see if
 *  wins are being lost (localStorage cleared) vs merely pending. */
export function starsEverQueued(): number {
  try { return Number(localStorage.getItem(storageKeys().ever) || '0') || 0; } catch { return 0; }
}

/** Sum of stars still waiting to be confirmed by the server. */
export function pendingStars(): number {
  return load().reduce((s, r) => s + (r.stars ?? 1), 0);
}

export function pendingPuzzles(): number {
  return load().reduce((sum, result) => sum + Math.max(0, result.expected_puzzles ?? 0), 0);
}

function load(): ResultIn[] {
  try {
    const v = JSON.parse(localStorage.getItem(storageKeys().queue) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(q: ResultIn[]): void {
  try { localStorage.setItem(storageKeys().queue, JSON.stringify(q)); } catch { /* storage blocked */ }
}

export function pendingCount(): number {
  return load().length;
}

/** Enqueue a win and try to flush immediately. */
export function queueResult(r: ResultIn): Promise<ConfirmedBalances | null> {
  const q = load();
  if (!q.some((x) => x.run_id === r.run_id)) {
    q.push(r);
    save(q);
    try {
      const keys = storageKeys();
      localStorage.setItem(keys.ever, String(starsEverQueued() + (r.stars ?? 1)));
    } catch { /* noop */ }
  }
  return flushResults();
}

let flushPromise: Promise<ConfirmedBalances | null> | null = null;

/** Retry pending results in order; drop each once the server confirms. Stops at
 *  the first failure (offline / cold backend) to retry later. Returns the latest
 *  server balance seen, or null if nothing was confirmed. */
export function flushResults(): Promise<ConfirmedBalances | null> {
  if (flushPromise) return flushPromise;
  flushPromise = flushLoop().finally(() => { flushPromise = null; });
  return flushPromise;
}

async function flushLoop(): Promise<ConfirmedBalances | null> {
  let confirmed: ConfirmedBalances | null = null;
  while (true) {
    const result = load()[0];
    if (!result) break;
    const response = await apiPostResult(result);
    if (!response) break; // keep it queued; try again next time
    save(load().filter((candidate) => candidate.run_id !== result.run_id));
    confirmed = {
      stars: response.balance,
      puzzles: typeof response.puzzle_balance === 'number' ? response.puzzle_balance : null,
    };
  }
  return confirmed;
}

/** Clear the queue (used by the debug reset). */
export function clearOutbox(): void {
  save([]);
}
