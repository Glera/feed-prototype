/**
 * Durable results outbox. A win must never be lost to a cold Render instance or
 * a network blip, so we DON'T fire-and-forget /results — we persist each win to
 * localStorage and retry until the server confirms. Idempotent on the server
 * (dedup by run_id), so replays are safe. Flushed on boot, on foreground, and
 * right after enqueue.
 */
import { apiPostResult, type ResultIn } from './api';

const KEY = 'swipe_pending_results_v1';

function load(): ResultIn[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(q: ResultIn[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(q)); } catch { /* storage blocked */ }
}

export function pendingCount(): number {
  return load().length;
}

/** Enqueue a win and try to flush immediately. */
export function queueResult(r: ResultIn): void {
  const q = load();
  if (!q.some((x) => x.run_id === r.run_id)) {
    q.push(r);
    save(q);
  }
  void flushResults();
}

let flushing = false;

/** Retry pending results in order; drop each once the server confirms. Stops at
 *  the first failure (offline / cold backend) to retry later. Returns the latest
 *  server balance seen, or null if nothing was confirmed. */
export async function flushResults(): Promise<number | null> {
  if (flushing) return null;
  flushing = true;
  let lastBalance: number | null = null;
  try {
    for (const r of [...load()]) {
      const res = await apiPostResult(r);
      if (!res) break; // keep it queued; try again next time
      save(load().filter((x) => x.run_id !== r.run_id));
      lastBalance = res.balance;
    }
  } finally {
    flushing = false;
  }
  return lastBalance;
}

/** Clear the queue (used by the debug reset). */
export function clearOutbox(): void {
  save([]);
}
