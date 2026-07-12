/**
 * On-device debug panel (open with ?diag=1 or t.me/<bot>?startapp=diag).
 * Shows initData/auth + /session status + live event log, and lets you flush the
 * pending-results outbox or reset your own server state. QA tool; no-op unless
 * explicitly opened.
 */
import { apiDiagnose, apiReset, apiResetDaily, apiSeedChallenge } from './api';
import { getEventLog } from './telemetry';
import { pendingCount, pendingStars, starsEverQueued, flushResults, clearOutbox } from './outbox';

export async function mountDebugPanel(): Promise<void> {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.93);color:#4f8;' +
    'font:12px/1.5 ui-monospace,monospace;padding:12px;display:flex;flex-direction:column;gap:8px;';

  const head = document.createElement('pre');
  head.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all;color:#8cf;';

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

  const logEl = document.createElement('pre');
  logEl.style.cssText = 'margin:0;white-space:pre-wrap;flex:1;overflow:auto;border-top:1px solid #333;padding-top:8px;';

  const mkBtn = (label: string, fn: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:9px 13px;background:#1b2230;color:#cfe;border:1px solid #345;border-radius:6px;font:600 12px ui-monospace,monospace;';
    b.onclick = () => fn(b);
    return b;
  };

  async function refreshHead(): Promise<void> {
    const d = await apiDiagnose();
    // stars_ever_queued (local lifetime) vs server balance vs pending tells us
    // where stars go: ever==server → all delivered; ever>server+pending → lost
    // (localStorage cleared); pending>0 → not yet flushed.
    let serverBalance: unknown = '?';
    try { serverBalance = JSON.parse(String(d.sessionBody)).balance; } catch { /* not json */ }
    head.textContent = 'SWIPE DIAG\n' + JSON.stringify({
      ...d,
      server_balance: serverBalance,
      stars_ever_queued: starsEverQueued(),
      pending_results: pendingCount(),
      pending_stars: pendingStars(),
    }, null, 1);
  }
  function refreshLog(): void {
    const l = getEventLog();
    logEl.textContent = l.slice().reverse()
      .map((e) => `${e.t}  ${e.name}${e.props ? '  ' + JSON.stringify(e.props) : ''}`)
      .join('\n') || '(no events yet)';
  }

  let armed = false;
  const resetBtn = mkBtn('⟲ Reset my state', async (b) => {
    if (!armed) { armed = true; b.textContent = 'Tap again to RESET'; setTimeout(() => { armed = false; b.textContent = '⟲ Reset my state'; }, 3000); return; }
    b.textContent = 'resetting…';
    await apiReset();
    clearOutbox();
    location.reload();
  });

  let dailyArmed = false;
  const resetDailyBtn = mkBtn('Reset dailies (next day)', async (b) => {
    if (!dailyArmed) {
      dailyArmed = true;
      b.textContent = 'Tap again to reset dailies';
      setTimeout(() => {
        dailyArmed = false;
        b.textContent = 'Reset dailies (next day)';
      }, 3000);
      return;
    }
    b.textContent = 'resetting dailies…';
    const state = await apiResetDaily();
    if (!state) {
      dailyArmed = false;
      b.textContent = 'daily reset failed';
      setTimeout(() => { b.textContent = 'Reset dailies (next day)'; }, 1800);
      return;
    }
    location.reload();
  });

  const copyBtn = mkBtn('📋 Copy log', async (b) => {
    const text = `${head.textContent}\n\n--- events ---\n${logEl.textContent}`;
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* blocked */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy'); document.body.removeChild(ta);
      } catch { ok = false; }
    }
    b.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { b.textContent = '📋 Copy log'; }, 1500);
  });

  const seedBtn = mkBtn('⚡ Seed test challenge', async (b) => {
    b.textContent = 'seeding…';
    const r = await apiSeedChallenge();
    (window as unknown as { __feedRefreshRail?: () => void }).__feedRefreshRail?.();
    b.textContent = r ? `от ${r.from} · ${(r.beat_ms / 1000).toFixed(1)}s ✓` : 'seed failed';
    setTimeout(() => { b.textContent = '⚡ Seed test challenge'; }, 2000);
  });

  btns.append(
    mkBtn('↻ Refresh', () => { void refreshHead(); refreshLog(); }),
    copyBtn,
    seedBtn,
    mkBtn('Flush pending', async () => { await flushResults(); await refreshHead(); }),
    resetDailyBtn,
    resetBtn,
    mkBtn('✕ Close', () => { clearInterval(iv); wrap.remove(); }),
  );

  wrap.append(head, btns, logEl);
  document.body.appendChild(wrap);
  await refreshHead();
  refreshLog();
  const iv = window.setInterval(refreshLog, 1000);
}
