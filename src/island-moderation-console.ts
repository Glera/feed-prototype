/**
 * Island Social Core P3 — operator moderation console (ТЗ §2.2, item 7).
 *
 * Opened from the ?diag=1 debug panel. This page is NAVIGATION ONLY, never an
 * authorization boundary: the server enforces the `island_moderator_ids`
 * allowlist on EVERY moderation request (F015), so a non-moderator who reaches
 * this screen simply gets 403 on each call and sees an error toast. Do not add
 * any client-side gate here and mistake it for security.
 *
 * Minimal debug-style layout: a publications feed with per-building Takedown /
 * Restore (Takedown passes the exact artifact_rel from the list, so the server
 * exact-revision guard is satisfied), and a reports feed with resolve actions.
 */
import {
  ApiRequestError,
  apiIslandModerationPublications,
  apiIslandModerationRestore,
  apiIslandModerationReports,
  apiIslandModerationResolveReport,
  apiIslandModerationTakedown,
  type IslandModerationPublication,
  type IslandModerationReport,
} from './api';

function esc(t: string): string {
  return t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function errText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 403) return 'нет прав модератора (403)';
    if (error.status === 409) return 'ревизия артефакта устарела (409)';
    return `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

export async function mountIslandModerationConsole(): Promise<void> {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:#0c0f16;color:#cdd3df;' +
    'font:12px/1.5 ui-monospace,monospace;padding:12px;display:flex;flex-direction:column;gap:10px;overflow:auto;';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
  const title = document.createElement('div');
  title.textContent = 'ISLAND MODERATION';
  title.style.cssText = 'font-weight:700;color:#8cf;';

  const toastEl = document.createElement('div');
  toastEl.style.cssText = 'min-height:16px;color:#f5a;';
  const toast = (t: string) => { toastEl.textContent = t; window.setTimeout(() => { if (toastEl.textContent === t) toastEl.textContent = ''; }, 4000); };

  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex-direction:column;gap:14px;';

  const mkBtn = (label: string, fn: (b: HTMLButtonElement) => void, danger = false): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      `padding:7px 11px;background:${danger ? '#3a1b1b' : '#1b2230'};color:${danger ? '#fbb' : '#cfe'};` +
      'border:1px solid #345;border-radius:6px;font:600 12px ui-monospace,monospace;cursor:pointer;';
    b.onclick = () => fn(b);
    return b;
  };

  // Two-tap arm for irreversible-feeling actions (Telegram WebView blocks confirm()).
  const armed = new WeakSet<HTMLButtonElement>();
  const armThen = (b: HTMLButtonElement, armedLabel: string, run: () => Promise<void>) => {
    if (!armed.has(b)) {
      armed.add(b);
      const prev = b.textContent ?? '';
      b.textContent = armedLabel;
      window.setTimeout(() => { armed.delete(b); if (b.isConnected) b.textContent = prev; }, 3000);
      return;
    }
    armed.delete(b);
    void run();
  };

  let reportsFilter: string | undefined;
  // Accumulated pages + keyset cursors (P3-3c): "Показать ещё" sends `before` and
  // appends, so an operator sees the FULL feed, not just the first window.
  let pubItems: IslandModerationPublication[] = [];
  let pubNextBefore: string | null = null;
  let reportItems: IslandModerationReport[] = [];
  let reportNextBefore: string | null = null;

  async function reload(): Promise<void> {
    body.innerHTML = '<div style="color:#678">загрузка…</div>';
    try {
      const [pubs, reports] = await Promise.all([
        apiIslandModerationPublications(),
        apiIslandModerationReports({ status: reportsFilter }),
      ]);
      pubItems = pubs.publications;
      pubNextBefore = pubs.next_before;
      reportItems = reports.reports;
      reportNextBefore = reports.next_before;
    } catch (error) {
      body.innerHTML = `<div style="color:#f66">не удалось загрузить: ${esc(errText(error))}</div>`;
      return;
    }
    paint();
  }

  async function loadMorePubs(): Promise<void> {
    if (!pubNextBefore) return;
    try {
      const r = await apiIslandModerationPublications({ before: pubNextBefore });
      pubItems = pubItems.concat(r.publications);
      pubNextBefore = r.next_before;
      paint();
    } catch (error) { toast(`ещё: ${errText(error)}`); }
  }

  async function loadMoreReports(): Promise<void> {
    if (!reportNextBefore) return;
    try {
      const r = await apiIslandModerationReports({ status: reportsFilter, before: reportNextBefore });
      reportItems = reportItems.concat(r.reports);
      reportNextBefore = r.next_before;
      paint();
    } catch (error) { toast(`ещё: ${errText(error)}`); }
  }

  function paint(): void {
    body.innerHTML = '';
    body.append(renderPublications(pubItems), renderReports(reportItems));
  }

  const moreBtn = (label: string, fn: () => Promise<void>): HTMLButtonElement => {
    // Re-enable in a finally so a failed page fetch does not leave the button
    // stuck disabled: on success paint() rebuilds it; on error it stays in the
    // DOM, re-enabled and clickable, and the next_before cursor is unchanged (it
    // only advances after a successful fetch), so a retry repeats the same page.
    const b = mkBtn(label, async () => {
      b.disabled = true;
      try { await fn(); } finally { b.disabled = false; }
    });
    b.style.marginTop = '6px';
    return b;
  };

  function card(): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'background:#141926;border:1px solid #263043;border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px;';
    return el;
  }

  function renderPublications(pubs: IslandModerationPublication[]): HTMLElement {
    const section = document.createElement('div');
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:700;color:#9fb;margin-bottom:6px;';
    h.textContent = `Публикации UGC (${pubs.length})`;
    section.appendChild(h);
    if (!pubs.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#678;';
      empty.textContent = '(нет опубликованных домиков)';
      section.appendChild(empty);
    }
    for (const p of pubs) {
      const el = card();
      const who = p.owner.username ? `@${p.owner.username}` : (p.owner.first_name ?? `#${p.owner.id}`);
      const meta = document.createElement('div');
      meta.innerHTML =
        `<b>${esc(p.name)}</b> · ${esc(who)} (id ${p.owner.id})` +
        (p.taken_down ? ' · <span style="color:#F0605A;font-weight:700">СНЯТ</span>' : '') +
        `<br><span style="color:#89f">${esc(p.prompt ?? '(без prompt)')}</span>` +
        `<br><span style="color:#678">rel: ${esc(p.rel ?? '—')}</span>` +
        `<br><span style="color:#8a9">plays ${p.counts.plays} · ♥ ${p.counts.likes} (+🤖${p.counts.bot_likes}) · гости ${p.counts.foreign_claims} · жалобы ${p.reports.open}/${p.reports.total}</span>`;
      el.appendChild(meta);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
      if (p.url) {
        const link = document.createElement('a');
        link.href = p.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '↗ превью';
        link.style.cssText = 'padding:7px 11px;background:#1b2230;color:#8cf;border:1px solid #345;border-radius:6px;text-decoration:none;';
        row.appendChild(link);
      }
      if (p.taken_down) {
        row.appendChild(mkBtn('Restore', (b) => armThen(b, 'ещё раз = вернуть', async () => {
          try { await apiIslandModerationRestore(p.building_id, 'operator restore'); toast('возвращено'); await reload(); }
          catch (error) { toast(`restore: ${errText(error)}`); }
        })));
      } else {
        row.appendChild(mkBtn('Takedown', (b) => armThen(b, 'ещё раз = снять', async () => {
          if (!p.rel) { toast('нет artifact_rel'); return; }
          try { await apiIslandModerationTakedown(p.building_id, p.rel, 'operator takedown'); toast('снято'); await reload(); }
          catch (error) { toast(`takedown: ${errText(error)}`); }
        }), true));
      }
      el.appendChild(row);
      section.appendChild(el);
    }
    if (pubNextBefore) section.appendChild(moreBtn('▾ Показать ещё', loadMorePubs));
    return section;
  }

  function renderReports(reports: IslandModerationReport[]): HTMLElement {
    const section = document.createElement('div');
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:700;color:#fb9;margin:6px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
    h.appendChild(Object.assign(document.createElement('span'), { textContent: `Жалобы (${reports.length})` }));
    for (const f of [undefined, 'open', 'reviewed', 'dismissed', 'escalated'] as const) {
      const label = f ?? 'все';
      const b = mkBtn(reportsFilter === f ? `[${label}]` : label, async () => { reportsFilter = f; await reload(); });
      b.style.padding = '3px 7px';
      h.appendChild(b);
    }
    section.appendChild(h);
    if (!reports.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#678;';
      empty.textContent = '(нет жалоб)';
      section.appendChild(empty);
    }
    for (const r of reports) {
      const el = card();
      const meta = document.createElement('div');
      meta.innerHTML =
        `<b>${esc(r.reason)}</b> · статус <b>${esc(r.status)}</b>` +
        (r.taken_down ? ' · <span style="color:#F0605A">снят</span>' : '') +
        `<br><span style="color:#89f">${esc(r.text ?? '(без комментария)')}</span>` +
        `<br><span style="color:#678">от ${r.reporter_id} · rel ${esc(r.artifact_rel ?? '—')}</span>`;
      el.appendChild(meta);
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
      for (const status of ['reviewed', 'dismissed', 'escalated'] as const) {
        row.appendChild(mkBtn(status, async () => {
          try { await apiIslandModerationResolveReport(r.report_id, status, `operator ${status}`); toast(`отмечено: ${status}`); await reload(); }
          catch (error) { toast(`resolve: ${errText(error)}`); }
        }));
      }
      el.appendChild(row);
      section.appendChild(el);
    }
    if (reportNextBefore) section.appendChild(moreBtn('▾ Показать ещё', loadMoreReports));
    return section;
  }

  head.append(
    title,
    mkBtn('↻ Обновить', () => { void reload(); }),
    mkBtn('✕ Закрыть', () => wrap.remove()),
    toastEl,
  );
  wrap.append(head, body);
  document.body.appendChild(wrap);
  await reload();
}
