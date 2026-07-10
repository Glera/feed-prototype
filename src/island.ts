/**
 * Island meta prototype — the PARALLEL experiment to the diamond meta world
 * (feed.ts openMetaWorld). Lives behind the TRIANGLE icon on the feed bar.
 *
 * Concept ("patchwork island"): the player's island is a showcase of their
 * created mechanics. Each mechanic is a building that THEMES its own sector —
 * ground tint + props + palette all come from the theme pack, so the island
 * grows out of what the player makes instead of being decorated from a catalog.
 *
 * Island state is authoritative in swipe-backend and revision-synchronised
 * across Telegram clients; localStorage is only the instant-paint/offline cache.
 * Playing a building launches the hosted UGC artifact when it exists, with a
 * client-side fork/stock build as fallback.
 */
import {
  ApiRequestError,
  apiIslandBake,
  apiIslandBakeJob,
  apiIslandTheme,
  type IslandBakeJob,
  type IslandBuildingState,
  type IslandPersistedState,
  type IslandStoredPack,
  type IslandTemplateId,
} from './api';
import { IslandStateSync, cacheIslandState, loadIslandState, replaceIslandState } from './island-state';
import { coverUrl, playableUrl } from './playables';
import { showConfirm } from './telegram';

declare const __ISLAND_SORT_RECIPE__: {
  version: number;
  baseBuild: string;
  sourcePalette: string[];
};

const SORT_RECIPE = __ISLAND_SORT_RECIPE__;

export interface IslandHostCtx { close(): void; }

type TplId = IslandTemplateId;
type PropKind = IslandStoredPack['prop'];
type Pack = IslandStoredPack;
type Building = IslandBuildingState;
type IslandState = IslandPersistedState;
interface CreationDraft {
  slot: number;
  tpl: TplId;
  prompt: string;
  pack: Pack;
  rerolls: number;
  ai?: boolean;
  avoid?: string;
}

const PACKS: Pack[] = [
  { id: 'forest', name: 'Mushroom forest', kw: ['mushroom', 'forest', 'moss', 'гриб', 'лес', 'мох'],
    ground: '#79A155', edge: '#5C7F41', boardBg: '#EAF2DC',
    items: ['#D9534F', '#F2E3C6', '#E8A33D', '#8A5A44', '#6FA34B', '#5B8BD8'], prop: 'mushroom', body: '#F2E3C6', roof: '#C94A3D' },
  { id: 'neon', name: 'Neon city', kw: ['neon', 'cyber', 'city', 'night', 'неон', 'кибер', 'город', 'ноч'],
    ground: '#3A3357', edge: '#5C51A0', boardBg: '#241F38',
    items: ['#41E0D0', '#FF5FA2', '#FFD84D', '#8F7FFF', '#9BF6FF', '#FF6B3D'], prop: 'crystal', body: '#4A4170', roof: '#41E0D0' },
  { id: 'sea', name: 'Underwater world', kw: ['water', 'sea', 'ocean', 'fish', 'reef', 'вод', 'мор', 'океан', 'рыб', 'риф'],
    ground: '#4E9DB0', edge: '#38798A', boardBg: '#E3F2F5',
    items: ['#FF8B7E', '#FFC85C', '#4FC9AE', '#4E8FD0', '#E858B8', '#8E6FE8'], prop: 'coral', body: '#DFF2EE', roof: '#FF8B7E' },
  { id: 'candy', name: 'Candy kingdom', kw: ['candy', 'sweet', 'caramel', 'cake', 'слад', 'конфет', 'карамел', 'торт'],
    ground: '#DE9FBE', edge: '#B96F92', boardBg: '#FBEFF5',
    items: ['#F26FA8', '#7EC9EE', '#F5D96E', '#A98FEF', '#6FDCA4', '#FF9B54'], prop: 'lollipop', body: '#FBEFF5', roof: '#F26FA8' },
  { id: 'lava', name: 'Volcano wastes', kw: ['lava', 'volcano', 'fire', 'ash', 'лав', 'вулкан', 'ог', 'пепел'],
    ground: '#5A4A47', edge: '#42332F', boardBg: '#F0E4DC',
    items: ['#FF7031', '#FFDD1C', '#9C4433', '#5E4B48', '#FFE08A', '#4EA6D8'], prop: 'rock', body: '#7A625C', roof: '#FF7031' },
];
const TPL: Record<TplId, { label: string; ds: string; playableId: string }> = {
  sort:  { label: 'Sorting', ds: 'sort items into flasks',        playableId: SORT_RECIPE.baseBuild },
  merge: { label: 'Merge',   ds: 'combine and grow the chain',    playableId: 'merge-locked-v1-swipe' },
  pins:  { label: 'Pins',    ds: 'pull the pins, catch it all',   playableId: 'pins-swipe' },
};
const CREATABLE_TPLS: TplId[] = ['sort'];
const SLOTS = [{ x: 115, y: 155 }, { x: 275, y: 170 }, { x: 115, y: 395 }, { x: 275, y: 380 }];
const GUEST_REWARD = 25;
const REROLL_COST = 30;
const IS_DEV = Boolean((import.meta as any).env?.DEV);
const UGC_BASE_URL = String((import.meta as any).env?.VITE_UGC_BASE_URL || 'https://swipe-ugc.onrender.com').replace(/\/$/, '');

function esc(t: string): string {
  return t.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] as string));
}
function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function levelOf(b: Building): number { return 1 + Math.floor(Math.log10(1 + b.plays)); }
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 240);
}
function hostedUrl(building: Building): string | null {
  if (building.rel) return IS_DEV ? `/ugc/${building.rel}` : `${UGC_BASE_URL}/${building.rel}`;
  return building.url ?? null;
}
function newJobId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Production must use the authenticated backend. The Vite endpoint and preset
// fallback exist only for local development, where Claude CLI is available.
async function aiTheme(prompt: string, avoid?: string): Promise<Pack | null> {
  try {
    const apiPack = await apiIslandTheme({ prompt, avoid });
    console.log('[island] backend theme:', apiPack.name, apiPack.items.join(' '));
    return {
      id: apiPack.id ?? '', name: apiPack.name.slice(0, 24), kw: apiPack.kw ?? [],
      ground: apiPack.ground, edge: apiPack.edge, boardBg: apiPack.boardBg,
      items: apiPack.items, prop: apiPack.prop, body: apiPack.body, roof: apiPack.roof,
    };
  } catch (e) {
    if (!IS_DEV) throw e;
    console.log('[island] backend theme unavailable in dev:', errorText(e), '→ Vite/CLI fallback');
  }

  try {
    const ctrl = new AbortController();
    // Generous: the dev endpoint may route through the Claude Code CLI
    // (subscription path), which takes tens of seconds. The UX is async
    // anyway — the player can dismiss the sheet and keep browsing.
    const timer = window.setTimeout(() => ctrl.abort(), 120000);
    const res = await fetch('/island-api/theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, avoid }),
      signal: ctrl.signal,
    });
    window.clearTimeout(timer);
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) { console.log('[island] dev theme API error:', data.error, '→ preset fallback'); return null; }
    const items = data.items as string[];
    if (!Array.isArray(items) || items.length !== 6) return null;
    console.log('[island] dev theme:', data.name, items.join(' '));
    return {
      id: '', name: String(data.name).slice(0, 24), kw: [],
      ground: String(data.ground), edge: String(data.edge), boardBg: String(data.boardBg),
      items, prop: data.prop as PropKind, body: String(data.body), roof: String(data.roof),
    };
  } catch (e) {
    console.log('[island] dev theme APIs unreachable:', errorText(e), '→ preset fallback');
    return null;
  }
}

function pickPack(txt: string, excl: string | null): Pack {
  const t = txt.toLowerCase();
  let p = t ? PACKS.find((x) => x.kw.some((k) => t.includes(k))) : undefined;
  if (!p || p.id === excl) {
    const pool = PACKS.filter((x) => x.id !== excl);
    p = pool[Math.floor(Math.random() * pool.length)];
  }
  return p;
}

// ── fork-at-launch (proof of the fork path) ─────────────────────────────────
// A created mechanic is a RECIPE (base playable + edits), materialised into a
// throwaway fork of the shipped artifact at launch time. The base build is
// fetched read-only and never modified. marble-sort is the first base: fully
// self-contained single file, all art procedural, marble palette = 6 hex
// constants — so the recipe is a palette substitution. Guards:
//   * recipe checks the artifact still contains the expected constants
//     (base rebuilt incompatibly → recipe is stale → play the stock build);
//   * any fetch/transform failure → stock build;
//   * boot watchdog in playSeries → stock build if the fork doesn't boot.
// Injected from swipe-ugc/recipes/sort at build time; the worker owns the source.
const SORT_MARBLES = SORT_RECIPE.sourcePalette;

async function forkedSortHtml(pk: Pack, dbg: (m: string) => void): Promise<string | null> {
  try {
    const src = playableUrl(TPL.sort.playableId, { auto: false });
    dbg(`fetch base: ${src}`);
    const res = await fetch(src);
    if (!res.ok) { dbg(`base fetch failed: HTTP ${res.status} → stock`); return null; }
    let html = await res.text();
    dbg(`base html: ${html.length} bytes`);
    let replaced = 0;
    const applyPalette = (text: string): string => {
      SORT_MARBLES.forEach((hex, i) => {
        const n = text.split(hex).length - 1;
        replaced += n;
        dbg(`  ${hex} → ${pk.items[i % pk.items.length]} (${n}x)`);
        text = text.split(hex).join(pk.items[i % pk.items.length]);
      });
      return text;
    };
    // Swipe deploys are shell + external payload; older artifacts are single-file.
    // The recipe edits whichever part actually carries the palette.
    const tag = html.match(/<script type="module" src="(\.[^"]*payload[^"]*)"><\/script>/);
    if (tag) {
      const purl = new URL(tag[1], new URL(src, location.href)).href;
      dbg(`shape: shell + external payload, fetch: ${purl}`);
      const pres = await fetch(purl);
      if (!pres.ok) { dbg(`payload fetch failed: HTTP ${pres.status} → stock`); return null; }
      let payload = await pres.text();
      dbg(`payload: ${payload.length} bytes`);
      if (!payload.includes(SORT_MARBLES[0])) { dbg('stale recipe: palette constants not found in payload → stock'); return null; }
      payload = applyPalette(payload).split('</script').join('<\\/script');
      html = html.replace(tag[0], () => `<script type="module">${payload}</script>`);
    } else if (html.includes(SORT_MARBLES[0])) {
      dbg('shape: single-file artifact');
      html = applyPalette(html);
    } else {
      dbg('stale recipe: no payload tag and no palette constants in html → stock');
      return null;
    }
    dbg(`palette applied: ${replaced} replacements`);
    // The fork boots in an about:blank frame: location.search is empty there, so
    // bake the launch params straight into the artifact (part of the recipe).
    html = html.split('window.location.search').join('"?auto=0"');
    html = html.split('location.search').join('"?auto=0"');
    // Insurance for artifacts with other relative refs (video files, covers).
    const dir = new URL(src, location.href).href.replace(/\?.*$/, '').replace(/[^/]*$/, '');
    html = html.replace('<head>', `<head><base href="${dir}">`);
    return html;
  } catch (e) {
    dbg(`transform error: ${String(e)} → stock (cross-origin base? client fork needs same-origin)`);
    return null;
  }
}

// Same shape the feed's outcomeFromMessage accepts, trimmed to what the swipe
// builds actually send ({source:'playable', type:'completed', success}).
function outcomeOf(data: unknown): 'won' | 'lost' | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const type = String(d.type ?? d.event ?? '').toLowerCase();
  const outcome = String(d.outcome ?? d.result ?? '').toLowerCase();
  const won = d.success === true || outcome === 'won' || outcome === 'win' || outcome === 'success';
  const lost = d.success === false || ['lost', 'lose', 'loss', 'fail', 'failed'].includes(outcome);
  if (['completed', 'complete', 'game_completed', 'game-completed'].includes(type)) {
    if (won) return 'won';
    if (lost) return 'lost';
  }
  if (['won', 'win', 'victory', 'success'].includes(type)) return 'won';
  if (['lost', 'loss', 'failed', 'fail'].includes(type)) return 'lost';
  return null;
}

// ── tiny SVG art ─────────────────────────────────────────────────────────────

function prop(kind: PropKind, x: number, y: number, c1: string, c2: string): string {
  const t = `transform="translate(${x},${y})"`;
  switch (kind) {
    case 'mushroom': return `<g ${t}><rect x="-2.5" y="-4" width="5" height="7" rx="2" fill="#F2E3C6"/><path d="M-7 -3 A7 6 0 0 1 7 -3 Z" fill="${c1}"/><circle cx="-2.5" cy="-6" r="1.3" fill="#fff" opacity=".85"/></g>`;
    case 'crystal': return `<g ${t}><polygon points="0,-12 5,-4 3,3 -3,3 -5,-4" fill="${c1}"/><polygon points="7,-7 10,-2 8,3 5,2" fill="${c2}"/></g>`;
    case 'coral': return `<g ${t}><circle cx="-4" cy="-2" r="4" fill="${c1}"/><circle cx="3" cy="-5" r="4.5" fill="${c2}"/><circle cx="4" cy="2" r="3.4" fill="${c1}"/></g>`;
    case 'lollipop': return `<g ${t}><rect x="-1" y="-3" width="2" height="8" fill="#F2E3C6"/><circle cx="0" cy="-7" r="5" fill="${c1}"/><circle cx="0" cy="-7" r="2.4" fill="${c2}"/></g>`;
    case 'rock': return `<g ${t}><polygon points="-7,4 -3,-6 4,-8 8,2 3,5" fill="${c1}"/><polyline points="-2,-2 1,0 0,3" stroke="${c2}" stroke-width="1.6" fill="none"/></g>`;
  }
}

function house(tpl: TplId, body: string, roof: string): string {
  const glyph = tpl === 'sort'
    ? '<circle cx="0" cy="-2" r="2"/><circle cx="0" cy="3" r="2"/>'
    : tpl === 'merge'
      ? '<circle cx="-2.5" cy="0" r="1.8"/><circle cx="2.5" cy="0" r="1.8"/><circle cx="0" cy="-4" r="1.8"/>'
      : '<rect x="-4" y="-1.5" width="8" height="3" rx="1.5"/>';
  return `<g><rect x="-14" y="-8" width="28" height="20" rx="2.5" fill="${body}"/>
    <polygon points="-17,-8 0,-22 17,-8" fill="${roof}"/>
    <rect x="-4" y="2" width="8" height="10" rx="1.5" fill="${roof}" opacity=".85"/>
    <g transform="translate(9,-14)"><circle r="6" fill="#fff"/><g fill="${roof}">${glyph}</g></g></g>`;
}

// Mock board used ONLY as the generation preview (playing uses the real build).
function board(tpl: TplId, pk: Pick<Pack, 'items' | 'boardBg' | 'edge'>): string {
  const dark = parseInt(pk.boardBg.slice(1, 3), 16) < 100;
  const cell = dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.09)';
  let s = `<svg viewBox="0 0 300 170" style="display:block;width:100%"><rect width="300" height="170" fill="${pk.boardBg}"/>`;
  if (tpl === 'sort') {
    const fills = [[0, 1, 0, 2], [3, 2, 1], [4, 0, 3, 1], [2]];
    fills.forEach((tube, i) => {
      const x = 42 + i * 60;
      s += `<rect x="${x - 17}" y="28" width="34" height="118" rx="15" fill="${cell}" stroke="${pk.edge}" stroke-width="1.6"/>`;
      tube.forEach((ci, j) => { s += `<circle cx="${x}" cy="${132 - j * 27}" r="12" fill="${pk.items[ci]}"/>`; });
    });
  } else if (tpl === 'merge') {
    const grid = [[1, 0, 2, -1, 0], [0, 3, -1, 1, 2], [2, -1, 4, 0, 1]];
    grid.forEach((row, r) => row.forEach((v, c) => {
      const x = 32 + c * 48, y = 38 + r * 48;
      s += `<rect x="${x - 20}" y="${y - 20}" width="40" height="40" rx="9" fill="${cell}"/>`;
      if (v >= 0) s += `<circle cx="${x}" cy="${y}" r="${9 + v * 2.4}" fill="${pk.items[v]}"/><circle cx="${x - 3}" cy="${y - 3}" r="${(9 + v * 2.4) * 0.3}" fill="#fff" opacity=".35"/>`;
    }));
  } else {
    s += `<line x1="95" y1="20" x2="95" y2="112" stroke="${pk.edge}" stroke-width="4"/>
          <line x1="205" y1="20" x2="205" y2="112" stroke="${pk.edge}" stroke-width="4"/>`;
    ([[130, 34, 0], [158, 32, 1], [144, 56, 2], [170, 58, 3], [122, 60, 4], [150, 82, 0], [132, 104, 1], [164, 104, 2]] as const)
      .forEach((b) => { s += `<circle cx="${b[0]}" cy="${b[1]}" r="12" fill="${pk.items[b[2]]}"/>`; });
    s += `<rect x="88" y="112" width="124" height="9" rx="4.5" fill="#AEB4BE" stroke="#7E848E" stroke-width="1.5"/>
          <circle cx="222" cy="116.5" r="7" fill="#7E848E"/>
          <path d="M110 138 L190 138 L182 164 L118 164 Z" fill="${cell}" stroke="${pk.edge}" stroke-width="1.6"/>`;
  }
  return s + '</svg>';
}

// ── styles (self-injected, namespaced .isl-*) ───────────────────────────────

const CSS = `
.island-world{position:absolute;inset:0;z-index:3000;display:flex;flex-direction:column;overflow:hidden;
  background:linear-gradient(180deg,#122231 0%,#0d1118 46%,#07090f 100%);color:#fff}
.isl-head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:calc(var(--safe-top) + 12px) 14px 8px}
.isl-ava{width:38px;height:38px;border-radius:50%;background:#2E6E86;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;flex:0 0 38px}
.isl-who{flex:1;min-width:0}
.isl-eyebrow{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.45)}
.isl-title{font-size:16px;font-weight:800;line-height:1.25}
.isl-stat{font-size:11.5px;color:rgba(255,255,255,.6)}
.isl-wallet{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:6px 12px;font-size:13px;font-weight:700;color:#FFD98A;flex:0 0 auto}
.isl-close{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.1);border:none;color:#fff;font-size:15px;flex:0 0 34px}
.isl-modes{flex:0 0 auto;display:flex;gap:8px;padding:4px 14px 10px}
.isl-mode{flex:1;font:inherit;font-size:12.5px;padding:8px 0;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);color:rgba(255,255,255,.7)}
.isl-mode--on{background:rgba(255,255,255,.18);color:#fff;font-weight:700}
.isl-worldbox{flex:1;min-height:0;position:relative}
.isl-worldbox svg{position:absolute;inset:0;width:100%;height:100%}
.isl-sector{cursor:pointer}
.isl-sector--new{transform-box:fill-box;transform-origin:center;animation:isl-pop .55s cubic-bezier(.2,1.4,.4,1)}
@keyframes isl-pop{from{opacity:0;transform:scale(.65)}}
.isl-plus{animation:isl-puls 2.4s ease-in-out infinite}
@keyframes isl-puls{0%,100%{opacity:.95}50%{opacity:.55}}
.isl-cta{position:absolute;left:14px;right:14px;bottom:calc(var(--safe-bottom) + 14px);border:none;border-radius:14px;
  padding:14px;font:inherit;font-size:15px;font-weight:800;color:#112011;background:linear-gradient(180deg,#8ff0a3,#3ccc78);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.36)}
.isl-scrim{position:absolute;inset:0;background:rgba(4,8,12,.6);opacity:0;pointer-events:none;transition:opacity .25s;z-index:5}
.isl-scrim--show{opacity:1;pointer-events:auto}
.isl-sheet{position:absolute;left:0;right:0;bottom:0;background:#141d28;border-top:1px solid rgba(255,255,255,.1);color:#fff;
  border-radius:20px 20px 0 0;padding:14px 16px calc(var(--safe-bottom) + 18px);transform:translateY(105%);
  transition:transform .32s cubic-bezier(.2,.9,.3,1);max-height:86%;overflow-y:auto;z-index:6}
.isl-sheet--show{transform:translateY(0)}
.isl-grab{width:38px;height:4px;border-radius:2px;background:rgba(255,255,255,.22);margin:0 auto 12px}
.isl-sheet h3{margin:0 0 3px;font-size:16px;font-weight:800}
.isl-sub{font-size:12.5px;color:rgba(255,255,255,.55);margin-bottom:13px}
.isl-tcards{display:flex;flex-direction:column;gap:9px}
.isl-tcard{display:flex;gap:12px;align-items:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);
  border-radius:13px;padding:9px;font:inherit;color:#fff;text-align:left}
.isl-tcard:active{transform:scale(.985)}
.isl-tcard__pv{width:92px;height:58px;border-radius:8px;overflow:hidden;flex:0 0 92px;background:rgba(255,255,255,.08)}
.isl-tcard__pv img{width:100%;height:100%;object-fit:cover;display:block}
.isl-tcard__nm{font-size:14px;font-weight:800}
.isl-tcard__ds{font-size:12px;color:rgba(255,255,255,.55);line-height:1.35}
.isl-chips{display:flex;flex-wrap:wrap;gap:7px;margin:10px 0 13px}
.isl-chip{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);border-radius:999px;padding:7px 12px;font:inherit;font-size:12px;color:#fff}
.isl-in{width:100%;border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:12px 13px;font:inherit;font-size:14px;background:rgba(255,255,255,.08);color:#fff}
.isl-in::placeholder{color:rgba(255,255,255,.35)}
.isl-btn{width:100%;border:none;border-radius:13px;padding:13px;font:inherit;font-size:14.5px;font-weight:800;margin-top:8px}
.isl-btn--pri{background:linear-gradient(180deg,#8ff0a3,#3ccc78);color:#112011;box-shadow:inset 0 1px 0 rgba(255,255,255,.36)}
.isl-btn--ghost{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);color:#fff}
.isl-btn:disabled{opacity:.4}
.isl-gensteps{list-style:none;margin:14px 0 8px;padding:0;display:flex;flex-direction:column;gap:10px;min-height:108px}
.isl-gensteps li{font-size:13px;color:rgba(255,255,255,.45);opacity:0;transition:opacity .4s;display:flex;gap:9px;align-items:center}
.isl-gensteps li.done{opacity:1;color:#fff}
.isl-gensteps .d{width:8px;height:8px;border-radius:50%;background:#3ccc78;flex:0 0 8px}
.isl-swrow{display:flex;gap:8px;margin:8px 0 4px;min-height:28px}
.isl-sw{width:26px;height:26px;border-radius:8px;opacity:0;transform:scale(.5);transition:all .35s}
.isl-sw--in{opacity:1;transform:scale(1)}
.isl-board{border-radius:13px;overflow:hidden;border:1px solid rgba(255,255,255,.14);margin:4px 0 9px}
.isl-pk{font-size:12.5px;color:rgba(255,255,255,.55)}
.isl-pk b{color:#fff}
.isl-play{position:absolute;inset:0;z-index:8;display:flex;flex-direction:column;background:var(--platform-bg)}
.isl-play__head{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:calc(var(--safe-top) + 10px) 14px 8px}
.isl-play__nm{flex:1;font-size:14px;font-weight:800}
.isl-dbg{flex:0 0 auto;font:600 10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,.08);
  border:1px solid rgba(255,255,255,.16);color:#9DC3CE;border-radius:8px;padding:5px 8px;max-width:150px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.isl-dbglog{position:absolute;left:10px;right:10px;bottom:calc(var(--safe-bottom) + 12px);max-height:46%;overflow-y:auto;
  background:rgba(7,12,18,.94);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;
  font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;color:#B8D2DC;white-space:pre-wrap;z-index:10}
.isl-play iframe{flex:1;min-height:0;width:100%;border:0;background:#000}
.isl-win{position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
  background:rgba(7,9,15,.88);text-align:center;padding:24px}
.isl-win__t{font-size:20px;font-weight:800}
.isl-win__m{font-size:13px;color:rgba(255,255,255,.6)}
.isl-like{border:2px solid #E8603C;background:transparent;color:#fff;border-radius:999px;padding:11px 22px;font:inherit;font-size:14.5px}
.isl-like--on{background:#E8603C;font-weight:800}
.isl-win__home{background:#fff;color:#10222C;border:none;border-radius:13px;padding:12px 30px;font:inherit;font-size:14.5px;font-weight:800}
.isl-toast{position:absolute;bottom:calc(var(--safe-bottom) + 84px);left:50%;transform:translate(-50%,24px);opacity:0;
  background:rgba(255,255,255,.95);color:#10222C;border-radius:12px;padding:10px 16px;font-size:12.5px;font-weight:600;
  transition:transform .3s,opacity .3s;max-width:86%;text-align:center;z-index:10;pointer-events:none}
.isl-toast--show{transform:translate(-50%,0);opacity:1}
@media (prefers-reduced-motion: reduce){.island-world *{animation:none!important;transition:none!important}}
`;

function ensureStyles(): void {
  if (document.querySelector('style[data-island-proto]')) return;
  const st = document.createElement('style');
  st.setAttribute('data-island-proto', '');
  st.textContent = CSS;
  document.head.appendChild(st);
}

// ── overlay ──────────────────────────────────────────────────────────────────

export function renderIslandWorld(ov: HTMLElement, ctx: IslandHostCtx): void {
  ensureStyles();
  const S: IslandState = loadIslandState();
  let guest = false;
  let cur: CreationDraft | null = null;
  let toastTimer = 0;
  let generationSeq = 0;
  const generationBySlot = new Map<number, number>();
  const readyDrafts = new Map<number, CreationDraft>();
  const pollingSlots = new Set<number>();
  let stateSync: IslandStateSync | null = null;

  const resolvePack = (id: string): Pack => PACKS.find((x) => x.id === id) ?? S.aiPacks?.[id] ?? PACKS[0];

  // Slots with a generation job in flight (player dismissed the sheet and kept
  // browsing). Rendered as a construction site; the job auto-builds on arrival.
  // In-memory only — a reload during generation simply frees the slot.
  const pendingSlots = new Set<number>();

  // Bake-on-confirm: after a mechanic is BUILT, ship it through the production
  // pipeline (bake → autoplay test → publish to swipe-ugc → per-player bot
  // message; the player's chat id comes from the mini-app initData). On success
  // the building switches from the client-side fork to the hosted build.
  async function bakeAndHost(slot: number, prompt: string): Promise<void> {
    const b = S.buildings.find((x) => x.slot === slot);
    if (!b || b.tpl !== 'sort' || hostedUrl(b) || pollingSlots.has(slot)) return;
    pollingSlots.add(slot);
    const packRef = b.pack;
    b.prompt = prompt;
    b.publishing = true;
    b.publishError = undefined;
    save();
    refreshIsland();
    const chat = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } } })
      .Telegram?.WebApp?.initDataUnsafe?.user?.id;
    let terminalFailure = false;
    try {
      let job: IslandBakeJob;
      try {
        if (!b.jobId) {
          b.jobId = newJobId();
          save();
          job = await apiIslandBake({ request_id: b.jobId, pack: resolvePack(packRef), prompt, tpl: 'sort' });
        } else {
          try {
            job = await apiIslandBakeJob(b.jobId);
          } catch (error) {
            // A local snapshot may outlive a bake request that never reached the
            // backend (WebView closed mid-flight). Replace only a missing job;
            // all real job failures keep their idempotent request id.
            if (!(error instanceof ApiRequestError) || error.status !== 404) throw error;
            b.jobId = newJobId();
            save();
            job = await apiIslandBake({ request_id: b.jobId, pack: resolvePack(packRef), prompt, tpl: 'sort' });
          }
        }
      } catch (e) {
        if (!IS_DEV) throw e;
        console.log('[island] backend bake unavailable in dev:', errorText(e), '→ Vite worker fallback');
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), 300000);
        const res = await fetch('/island-api/bake', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pack: resolvePack(packRef), prompt, chat }),
          signal: ctrl.signal,
        });
        window.clearTimeout(timer);
        const data = (await res.json()) as { rel?: string; url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(String(data.error ?? `HTTP ${res.status}`));
        job = { job_id: b.jobId ?? '', status: 'ready', rel: data.rel ?? '', url: data.url, error: '', ready: true };
      }

      let pollErrors = 0;
      for (let attempt = 0; !['ready', 'published', 'failed'].includes(job.status); attempt++) {
        if (attempt >= 180) {
          if (ov.isConnected) toast('Publishing continues in background');
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const current = S.buildings.find((x) => x.slot === slot);
        if (!current || current.pack !== packRef || !current.jobId) return;
        try {
          job = await apiIslandBakeJob(current.jobId);
          pollErrors = 0;
        } catch (e) {
          if (++pollErrors < 4) continue;
          throw e;
        }
      }
      if (job.status === 'failed') {
        terminalFailure = true;
        throw new Error(job.error || 'Bake job failed');
      }
      if (!job.url || !job.rel) throw new Error('Backend published no hosted URL; check UGC_BASE_URL');
      const now = S.buildings.find((x) => x.slot === slot);
      if (!now || now.pack !== packRef) return;   // slot was rebuilt meanwhile
      now.rel = job.rel;
      now.url = undefined;
      now.publishing = false;
      now.publishError = undefined;
      save();
      refreshIsland();
      console.log('[island] hosted:', job.url, job.ready ? '(ready)' : '(deploy pending)');
      if (ov.isConnected) toast(job.ready ? 'Published to hosting ✅' : 'Published; hosting is warming up');
    } catch (e) {
      const message = errorText(e);
      const now = S.buildings.find((x) => x.slot === slot);
      if (now && now.pack === packRef) {
        now.publishing = false;
        now.publishError = message;
        if (terminalFailure) now.jobId = undefined;
        save();
        refreshIsland();
      }
      console.error('[island] publish failed:', message);
      if (ov.isConnected) toast(`Publish failed · ${message}`);
    } finally {
      pollingSlots.delete(slot);
    }
  }

  const save = () => {
    if (stateSync) stateSync.changed();
    else cacheIslandState(S);
  };

  function resumePendingBakes(): void {
    S.buildings
      .filter((building) => building.tpl === 'sort' && Boolean(building.jobId) && !hostedUrl(building))
      .forEach((building) => { void bakeAndHost(building.slot, building.prompt ?? ''); });
  }

  stateSync = new IslandStateSync({
    read: () => S,
    apply: (state) => {
      replaceIslandState(S, state);
      refreshIsland(false);
      cacheIslandState(S);
    },
    onHydrated: resumePendingBakes,
  });

  ov.innerHTML =
    '<div class="isl-head">' +
      '<div class="isl-ava">G</div>' +
      '<div class="isl-who">' +
        '<div class="isl-eyebrow">Island · experiment</div>' +
        '<div class="isl-title">My Island</div>' +
        '<div class="isl-stat" data-stat></div>' +
      '</div>' +
      '<div class="isl-wallet">🧩 <span data-tok></span></div>' +
      '<button class="isl-close" type="button" aria-label="Close">✕</button>' +
    '</div>' +
    '<div class="isl-modes">' +
      '<button class="isl-mode isl-mode--on" type="button" data-mode="owner">My island</button>' +
      '<button class="isl-mode" type="button" data-mode="guest">As a guest</button>' +
    '</div>' +
    '<div class="isl-worldbox"><svg viewBox="0 0 390 540" preserveAspectRatio="xMidYMid slice"></svg></div>' +
    '<button class="isl-cta" type="button" data-guest-cta hidden>Play a series here · +' + GUEST_REWARD + ' 🧩</button>' +
    '<div class="isl-scrim" data-scrim></div>' +
    '<div class="isl-sheet" data-sheet></div>' +
    '<div class="isl-toast" data-toast></div>';

  const svg = ov.querySelector('svg') as unknown as SVGSVGElement;
  const sheet = ov.querySelector('[data-sheet]') as HTMLElement;
  const scrim = ov.querySelector('[data-scrim]') as HTMLElement;

  // Toasts sit at the BOTTOM (the top slides under the phone notch) and fade
  // in place instead of flying off-screen. Long error details are truncated —
  // the full text lives on the building card (publishError) and in the console —
  // and the display time scales with length so it's actually readable.
  const toast = (t: string) => {
    const el = ov.querySelector('[data-toast]') as HTMLElement;
    el.textContent = t.length > 140 ? `${t.slice(0, 140)}…` : t;
    el.classList.add('isl-toast--show');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => el.classList.remove('isl-toast--show'), Math.min(8000, Math.max(2400, t.length * 45)));
  };

  const openSheet = (html: string) => {
    sheet.innerHTML = '<div class="isl-grab"></div>' + html;
    sheet.classList.add('isl-sheet--show');
    scrim.classList.add('isl-scrim--show');
  };
  const closeSheet = () => {
    sheet.classList.remove('isl-sheet--show');
    scrim.classList.remove('isl-scrim--show');
  };
  scrim.addEventListener('click', closeSheet);

  function refreshIsland(persist = false): void {
    let s =
      '<rect width="390" height="540" fill="#20627A"/>' +
      '<ellipse cx="60" cy="66" rx="46" ry="7" fill="#35798F" opacity=".6"/>' +
      '<ellipse cx="330" cy="486" rx="52" ry="8" fill="#35798F" opacity=".6"/>' +
      '<ellipse cx="342" cy="46" rx="30" ry="6" fill="#35798F" opacity=".5"/>' +
      '<ellipse cx="195" cy="276" rx="176" ry="218" fill="#E4D49E"/>' +
      '<ellipse cx="195" cy="274" rx="156" ry="195" fill="#A8C078"/>' +
      '<ellipse cx="195" cy="274" rx="50" ry="34" fill="#D9CBA3"/>' +
      '<g transform="translate(195,274)"><rect x="-2" y="-26" width="4" height="26" fill="#8A6B4A"/><polygon points="2,-26 26,-21 2,-15" fill="#E8603C"/></g>';
    SLOTS.forEach((p, i) => {
      const b = S.buildings.find((x) => x.slot === i);
      if (!b) {
        if (pendingSlots.has(i)) {
          s += `<g><ellipse cx="${p.x}" cy="${p.y}" rx="70" ry="52" fill="#C9BC8E" stroke="#8FA662" stroke-width="2" stroke-dasharray="4 6"/>
            <g class="isl-plus"><text x="${p.x}" y="${p.y + 3}" text-anchor="middle" font-size="24">🏗️</text></g>
            <text x="${p.x}" y="${p.y + 28}" text-anchor="middle" font-size="11" fill="#5C7F41">generating…</text></g>`;
        } else if (readyDrafts.has(i) && !guest) {
          const draft = readyDrafts.get(i)!;
          s += `<g class="isl-sector" data-slot="${i}">
            <ellipse cx="${p.x}" cy="${p.y}" rx="70" ry="52" fill="${draft.pack.ground}" stroke="${draft.pack.edge}" stroke-width="2" stroke-dasharray="4 4"/>
            <g class="isl-plus"><text x="${p.x}" y="${p.y + 2}" text-anchor="middle" font-size="22">✨</text></g>
            <text x="${p.x}" y="${p.y + 27}" text-anchor="middle" font-size="11" fill="#fff">theme ready</text></g>`;
        } else if (!guest) {
          s += `<g class="isl-sector" data-slot="${i}">
            <ellipse cx="${p.x}" cy="${p.y}" rx="70" ry="52" fill="#B7C98B" stroke="#8FA662" stroke-width="2" stroke-dasharray="7 7"/>
            <g class="isl-plus"><circle cx="${p.x}" cy="${p.y - 6}" r="15" fill="#fff"/>
            <text x="${p.x}" y="${p.y - 0.5}" text-anchor="middle" font-size="20" font-weight="700" fill="#E8603C">+</text></g>
            <text x="${p.x}" y="${p.y + 26}" text-anchor="middle" font-size="11" fill="#5C7F41">build</text></g>`;
        } else {
          s += `<ellipse cx="${p.x}" cy="${p.y}" rx="70" ry="52" fill="#B7C98B" opacity=".55"/>`;
        }
        return;
      }
      const pk = resolvePack(b.pack);
      const offs: Array<[number, number]> = [[-42, 16], [36, 22], [-30, -28], [34, -22]];
      const props = offs.map((o, j) => prop(pk.prop, o[0], o[1], pk.items[j % pk.items.length], pk.items[(j + 1) % pk.items.length])).join('');
      // The publish chain (bake → test → push → deploy) keeps running after the
      // building appears — show it on the map so the slot reads as "busy" and
      // players don't fire a second job into it.
      const busy = Boolean(b.publishing) || pollingSlots.has(i);
      s += `<g class="isl-sector${b.fresh ? ' isl-sector--new' : ''}" data-b="${i}">
        <ellipse cx="${p.x}" cy="${p.y}" rx="70" ry="52" fill="${pk.ground}" stroke="${pk.edge}" stroke-width="2"${busy ? ' stroke-dasharray="4 4"' : ''}/>
        <g transform="translate(${p.x},${p.y})">${props}<g transform="translate(0,-4)">${house(b.tpl, pk.body, pk.roof)}</g></g>
        <g><rect x="${p.x - 56}" y="${p.y + 30}" width="112" height="18" rx="9" fill="rgba(255,255,255,.92)"/>
        <text x="${p.x}" y="${p.y + 43}" text-anchor="middle" font-size="10.5" font-weight="600" fill="#26241F">${esc(b.name)}</text></g>`;
      if (busy) {
        s += `<g class="isl-plus"><circle cx="${p.x + 46}" cy="${p.y - 36}" r="12" fill="rgba(255,255,255,.95)"/>
          <text x="${p.x + 46}" y="${p.y - 31}" text-anchor="middle" font-size="13">🏗️</text></g>
          <g><rect x="${p.x - 40}" y="${p.y + 51}" width="80" height="14" rx="7" fill="rgba(20,29,40,.78)"/>
          <text x="${p.x}" y="${p.y + 61.5}" text-anchor="middle" font-size="9.5" font-weight="600" fill="#FFD98A" class="isl-plus">publishing…</text></g>`;
      } else if (b.publishError) {
        s += `<g><circle cx="${p.x + 46}" cy="${p.y - 36}" r="12" fill="rgba(255,255,255,.95)"/>
          <text x="${p.x + 46}" y="${p.y - 31}" text-anchor="middle" font-size="13">⚠️</text></g>`;
      }
      s += '</g>';
      b.fresh = false;
    });
    svg.innerHTML = s;
    svg.querySelectorAll<SVGElement>('[data-slot]').forEach((g) =>
      g.addEventListener('click', () => openCreate(Number(g.dataset.slot))));
    svg.querySelectorAll<SVGElement>('[data-b]').forEach((g) =>
      g.addEventListener('click', () => openBuilding(Number(g.dataset.b))));
    const likes = S.buildings.reduce((a, b) => a + b.likes, 0);
    (ov.querySelector('[data-stat]') as HTMLElement).textContent =
      `♥ ${likes} · ${S.buildings.length}/${SLOTS.length} mechanics`;
    (ov.querySelector('[data-tok]') as HTMLElement).textContent = String(S.tokens);
    if (persist) save();
  }

  // ── creation flow ──────────────────────────────────────────────────────────

  function openCreate(slot: number, replacing?: string): void {
    const ready = readyDrafts.get(slot);
    if (ready) {
      cur = ready;
      stepPreview();
      return;
    }
    cur = { slot, tpl: 'sort', prompt: '', pack: PACKS[0], rerolls: 1 };
    const cards = CREATABLE_TPLS.map((id) =>
      `<button class="isl-tcard" type="button" data-t="${id}">
        <span class="isl-tcard__pv"><img src="${coverUrl(TPL[id].playableId)}" alt="" onerror="this.style.display='none'"></span>
        <span><span class="isl-tcard__nm">${TPL[id].label}</span><br><span class="isl-tcard__ds">${TPL[id].ds}</span></span>
      </button>`).join('');
    const sub = replacing
      ? `Step 1 of 3 · this REPLACES “${esc(replacing)}” — its plays and likes are lost`
      : 'Step 1 of 3 · pick a template — the theme comes next';
    openSheet(`<h3>${replacing ? 'Rebuild slot' : 'New mechanic'}</h3><div class="isl-sub">${sub}</div>
      <div class="isl-tcards">${cards}</div>`);
    sheet.querySelectorAll<HTMLElement>('[data-t]').forEach((c) =>
      c.addEventListener('click', () => { if (cur) { cur.tpl = c.dataset.t as TplId; stepPrompt(); } }));
  }

  function stepPrompt(): void {
    if (!cur) return;
    const chips = ['mushroom forest', 'neon city', 'underwater world', 'candy kingdom', 'volcano wastes']
      .map((c) => `<button class="isl-chip" type="button">${c}</button>`).join('');
    openSheet(`<h3>${TPL[cur.tpl].label}: theme</h3><div class="isl-sub">Step 2 of 3 · describe the world in your own words</div>
      <input class="isl-in" data-prm placeholder="e.g. rainy neon city at night" maxlength="40">
      <div class="isl-chips">${chips}</div>
      <button class="isl-btn isl-btn--pri" type="button" data-gen>Generate theme ✨</button>`);
    const inp = sheet.querySelector('[data-prm]') as HTMLInputElement;
    sheet.querySelectorAll<HTMLElement>('.isl-chip').forEach((c) =>
      c.addEventListener('click', () => { inp.value = c.textContent || ''; }));
    (sheet.querySelector('[data-gen]') as HTMLElement).addEventListener('click', () => {
      if (!cur) return;
      cur.prompt = inp.value.trim();
      stepGen();
    });
  }

  function stepGen(): void {
    if (!cur) return;
    const req = cur;
    readyDrafts.delete(req.slot);
    const generationId = ++generationSeq;
    generationBySlot.set(req.slot, generationId);
    pendingSlots.add(req.slot);
    refreshIsland();
    const steps = ['asking the theme model', 'validating the palette', 'deriving island colors', 'assembling on the engine'];
    openSheet(`<h3>Generating…</h3><div class="isl-sub">${esc(req.prompt || 'random theme')}</div>
      <ul class="isl-gensteps">${steps.map((x) => `<li><span class="d"></span>${x}</li>`).join('')}</ul>
      <div class="isl-swrow"></div>
      <button class="isl-btn isl-btn--ghost" type="button" data-dismiss>Keep browsing — build it when ready</button>
      <div class="isl-pk" style="margin-top:8px">Generation can take a minute. If you close this, the mechanic is built automatically and the island will show it when it's ready.</div>`);
    sheet.querySelector('[data-dismiss]')?.addEventListener('click', () => closeSheet());
    const lis = [...sheet.querySelectorAll('.isl-gensteps li')];
    const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
    lis.forEach((li, i) => window.setTimeout(() => li.classList.add('done'), rm ? 0 : 350 + i * 520));
    const minWait = new Promise<void>((r) => window.setTimeout(() => r(), rm ? 300 : 2400));
    void Promise.all([aiTheme(req.prompt, req.avoid), minWait]).then(([pack]) => {
      if (generationBySlot.get(req.slot) !== generationId) {
        refreshIsland();
        return;
      }
      generationBySlot.delete(req.slot);
      pendingSlots.delete(req.slot);
      const resolved = pack ?? pickPack(req.prompt, req.pack.id);
      const isAi = Boolean(pack);
      if (pack) {
        // Sequence ids collide when phone and Desktop generate concurrently.
        // A UUID-backed id makes independently-created packs mergeable.
        pack.id = `ai-${newJobId()}`;
        S.aiPacks = { ...(S.aiPacks ?? {}), [pack.id]: pack };
      }
      req.pack = resolved;
      req.ai = isAi;
      readyDrafts.set(req.slot, req);
      const interactive = ov.isConnected && sheet.classList.contains('isl-sheet--show') && cur === req;
      if (interactive) {
        save();
        stepPreview();
        return;
      }
      // Generation only prepares a theme. Closing the sheet must never publish
      // or create a building; the player returns to this draft and confirms Build.
      const nm = isAi ? resolved.name : (req.prompt ? cap(req.prompt) : resolved.name);
      if (ov.isConnected) {
        refreshIsland();
        toast(`Theme "${nm.slice(0, 16)}" is ready · tap the slot to Build`);
      }
    }).catch((error) => {
      if (generationBySlot.get(req.slot) !== generationId) return;
      generationBySlot.delete(req.slot);
      pendingSlots.delete(req.slot);
      const message = errorText(error);
      refreshIsland();
      console.error('[island] theme generation failed:', message);
      const interactive = ov.isConnected && sheet.classList.contains('isl-sheet--show') && cur === req;
      if (!interactive) {
        if (ov.isConnected) toast(`Theme failed · ${message}`);
        return;
      }
      openSheet(`<h3>Theme generation failed</h3><div class="isl-sub">${esc(message)}</div>
        <button class="isl-btn isl-btn--pri" type="button" data-retry>Retry</button>`);
      sheet.querySelector('[data-retry]')?.addEventListener('click', () => stepGen());
    });
  }

  function stepPreview(): void {
    if (!cur) return;
    const pk = cur.pack;
    const nm = cur.ai ? pk.name : (cur.prompt ? cap(cur.prompt) : pk.name);
    const rl = cur.rerolls > 0 ? 'Reroll · 1 free' : `Reroll · ${REROLL_COST} 🧩`;
    openSheet(`<h3>Theme preview</h3><div class="isl-sub">Step 3 of 3 · how the mechanic will look</div>
      <div class="isl-board">${board(cur.tpl, pk)}</div>
      <div class="isl-pk"><b>${esc(nm)}</b> · ${TPL[cur.tpl].label} · <span style="opacity:.65">${cur.ai ? 'AI theme ✨' : 'preset theme (AI offline)'}</span></div>
      <div class="isl-swrow" style="margin-top:8px">${pk.items.map((c) => `<span class="isl-sw isl-sw--in" style="background:${c}"></span>`).join('')}</div>
      <button class="isl-btn isl-btn--pri" type="button" data-build>Build on the island</button>
      <button class="isl-btn isl-btn--ghost" type="button" data-rr>${rl}</button>`);
    (sheet.querySelector('[data-build]') as HTMLElement).addEventListener('click', () => {
      if (!cur) return;
      const { slot, tpl: tplId, prompt } = cur;
      // Slots are the cap: building on an occupied slot replaces its mechanic.
      readyDrafts.delete(slot);
      S.buildings = S.buildings.filter((x) => x.slot !== slot);
      S.buildings.push({
        slot, tpl: tplId, pack: pk.id, name: nm.slice(0, 16), prompt,
        plays: 0, likes: 0, liked: false, fresh: true, publishing: true,
      });
      cur = null;
      closeSheet();
      refreshIsland(true);
      toast('Publishing…');
      void bakeAndHost(slot, prompt);
    });
    (sheet.querySelector('[data-rr]') as HTMLElement).addEventListener('click', () => {
      if (!cur) return;
      if (cur.rerolls > 0) cur.rerolls--;
      else if (S.tokens >= REROLL_COST) { S.tokens -= REROLL_COST; save(); }
      else { toast('Not enough tokens'); return; }
      readyDrafts.delete(cur.slot);
      (ov.querySelector('[data-tok]') as HTMLElement).textContent = String(S.tokens);
      cur.avoid = cur.ai ? cur.pack.name : undefined;
      stepGen();
    });
  }

  // ── building card + play (real mechanic in an iframe) ──────────────────────

  function openBuilding(slot: number): void {
    const b = S.buildings.find((x) => x.slot === slot);
    if (!b) return;
    if (guest) { playSeries(b); return; }
    const pk = resolvePack(b.pack);
    // The slot is "busy" for the whole publish chain — block actions that would
    // start a second job (rebuild) or orphan the running one (delete).
    const busy = Boolean(b.publishing) || pollingSlots.has(slot);
    const publishState = hostedUrl(b) ? 'HOSTED' : busy ? 'Publishing…' : b.publishError ? `Publish failed · ${b.publishError}` : 'Local draft';
    const retry = !hostedUrl(b) && !busy
      ? '<button class="isl-btn isl-btn--ghost" type="button" data-publish>Retry publish</button>'
      : '';
    openSheet(`<h3>${esc(b.name)}</h3>
      <div class="isl-sub">${TPL[b.tpl].label} · Lv ${levelOf(b)} · ${b.plays} plays · ♥ ${b.likes}<br>${esc(publishState)}</div>
      <div class="isl-board">${board(b.tpl, pk)}</div>
      <button class="isl-btn isl-btn--pri" type="button" data-play>▶ Play the series</button>
      ${retry}
      <button class="isl-btn isl-btn--ghost" type="button" data-rebuild${busy ? ' disabled' : ''}>Rebuild slot · replace this mechanic</button>
      <button class="isl-btn isl-btn--ghost" type="button" data-delete${busy ? ' disabled' : ''}>Delete mechanic</button>
      <div class="isl-pk" style="margin-top:10px">${busy
        ? 'Publishing in progress 🏗️ — rebuild and delete unlock when it finishes'
        : 'Guests like it after they beat it — switch to guest mode to feel it'}</div>`);
    (sheet.querySelector('[data-play]') as HTMLElement).addEventListener('click', () => { closeSheet(); playSeries(b); });
    sheet.querySelector('[data-publish]')?.addEventListener('click', () => {
      closeSheet();
      toast('Publishing…');
      void bakeAndHost(slot, b.prompt ?? '');
    });
    (sheet.querySelector('[data-rebuild]') as HTMLElement).addEventListener('click', () => {
      if (Boolean(b.publishing) || pollingSlots.has(slot)) { toast('Slot is busy — publishing in progress'); return; }
      closeSheet();
      openCreate(slot, b.name);
    });
    (sheet.querySelector('[data-delete]') as HTMLElement).addEventListener('click', async () => {
      if (Boolean(b.publishing) || pollingSlots.has(slot)) { toast('Slot is busy — publishing in progress'); return; }
      if (!await showConfirm(`Delete "${b.name}" from the island?`)) return;
      S.buildings = S.buildings.filter((x) => x.slot !== slot);
      closeSheet();
      refreshIsland(true);
      toast('Mechanic removed from the island');
    });
  }

  function playSeries(b: Building): void {
    const play = document.createElement('div');
    play.className = 'isl-play';
    play.innerHTML =
      '<div class="isl-play__head">' +
        `<div class="isl-play__nm">${esc(b.name)} <span style="opacity:.55;font-weight:600">· ${TPL[b.tpl].label}</span></div>` +
        '<button class="isl-dbg" type="button" data-dbg>boot…</button>' +
        '<button class="isl-close" type="button" aria-label="Back" data-back>✕</button>' +
      '</div>';
    const frame = document.createElement('iframe');
    frame.setAttribute('scrolling', 'no');
    frame.setAttribute('allow', 'autoplay');
    play.appendChild(frame);
    ov.appendChild(play);

    // Launch telemetry: every step of the fork/fallback path is logged. The
    // chip in the header shows the verdict; tapping it opens the full log.
    const dbgLines: string[] = [];
    const dbg = (m: string) => { dbgLines.push(m); console.log('[island]', m); };
    const chip = play.querySelector('[data-dbg]') as HTMLElement;
    const setChip = (t: string) => { chip.textContent = t; };
    chip.addEventListener('click', () => {
      const old = play.querySelector('.isl-dbglog');
      if (old) { old.remove(); return; }
      const panel = document.createElement('div');
      panel.className = 'isl-dbglog';
      panel.textContent = dbgLines.join('\n');
      play.appendChild(panel);
    });
    dbg(`launch: "${b.name}" tpl=${b.tpl} pack=${b.pack} guest=${guest}`);

    // Themed fork for sort; everything else (and every fallback) = stock build.
    const stockSrc = playableUrl(TPL[b.tpl].playableId, { auto: false });
    const pk = resolvePack(b.pack);
    let watchdog = 0;
    void (async () => {
      // Hosted build wins over the client-side fork: it's the tested, published
      // artifact. Real URL → query params work; no watchdog (cross-origin in
      // prod, and the artifact already passed the worker's autoplay gate).
      const hosted = hostedUrl(b);
      if (hosted) {
        dbg(`loading hosted build: ${hosted}`);
        setChip(`HOSTED · ${pk.name}`);
        frame.src = `${hosted}${hosted.includes('?') ? '&' : '?'}auto=0`;
        return;
      }
      let forked = false;
      if (b.tpl === 'sort') {
        const html = await forkedSortHtml(pk, dbg);
        if (html && frame.isConnected) {
          try {
            const doc = frame.contentWindow?.document;
            if (doc) { doc.open(); doc.write(html); doc.close(); forked = true; }
          } catch (e) { dbg(`doc.write failed: ${String(e)}`); forked = false; }
        }
      } else {
        dbg(`no fork recipe for tpl=${b.tpl} yet → stock`);
      }
      if (!forked) {
        dbg(`loading stock: ${stockSrc}`);
        setChip(`STOCK · ${b.tpl}`);
        frame.src = stockSrc;
        return;
      }
      dbg('fork written into frame');
      setChip(`FORK · ${pk.name}`);
      // Fork didn't boot (no canvas mounted) → quietly reload the stock build.
      watchdog = window.setTimeout(() => {
        try {
          if (frame.isConnected && !frame.contentWindow?.document.querySelector('canvas')) {
            dbg('watchdog: no canvas in 5s → reloading stock');
            setChip('STOCK · watchdog');
            frame.src = stockSrc;
          } else {
            dbg('watchdog: canvas mounted, fork is live');
          }
        } catch (e) {
          dbg(`watchdog error: ${String(e)} → stock`);
          setChip('STOCK · watchdog');
          frame.src = stockSrc;
        }
      }, 5000);
    })();

    const cleanup = () => {
      window.removeEventListener('message', onMsg);
      window.clearTimeout(watchdog);
      try { frame.src = 'about:blank'; } catch { /* noop */ }
      play.remove();
    };
    const showWin = () => {
      b.plays++;
      if (guest) S.tokens += GUEST_REWARD;
      const win = document.createElement('div');
      win.className = 'isl-win';
      win.innerHTML =
        '<div class="isl-win__t">Round won! 🎉</div>' +
        (guest ? `<div class="isl-win__m">+${GUEST_REWARD} 🧩 for playing on someone's island</div>`
               : '<div class="isl-win__m">Your own build — no tokens for self-plays</div>') +
        (guest ? `<button class="isl-like${b.liked ? ' isl-like--on' : ''}" type="button" data-like>${b.liked ? '♥ Liked' : '♡ Like this mechanic'}</button>` : '') +
        '<button class="isl-win__home" type="button" data-home>Back to island</button>';
      play.appendChild(win);
      win.querySelector('[data-like]')?.addEventListener('click', (e) => {
        const btn = e.currentTarget as HTMLElement;
        b.liked = !b.liked;
        b.likes += b.liked ? 1 : -1;
        btn.classList.toggle('isl-like--on', b.liked);
        btn.textContent = b.liked ? '♥ Liked' : '♡ Like this mechanic';
        save();
      });
      (win.querySelector('[data-home]') as HTMLElement).addEventListener('click', () => { cleanup(); refreshIsland(); });
      refreshIsland(true);
    };
    const onMsg = (e: MessageEvent) => {
      if (!ov.isConnected) { cleanup(); return; }
      if (e.source !== frame.contentWindow) return;
      const d = e.data as Record<string, unknown> | null;
      if (d && typeof d === 'object' && d.source === 'playable') dbg(`frame msg: ${String(d.type ?? d.event ?? '?')}`);
      const out = outcomeOf(e.data);
      if (out === 'won') { dbg('outcome: won'); showWin(); }
      else if (out === 'lost') { dbg('outcome: lost'); toast('So close — the mechanic restarts itself'); }
    };
    window.addEventListener('message', onMsg);
    (play.querySelector('[data-back]') as HTMLElement).addEventListener('click', () => { cleanup(); refreshIsland(); });
  }

  // ── header / modes ─────────────────────────────────────────────────────────

  (ov.querySelector('.isl-close') as HTMLElement).addEventListener('click', () => ctx.close());
  ov.querySelectorAll<HTMLElement>('[data-mode]').forEach((btn) =>
    btn.addEventListener('click', () => {
      guest = btn.dataset.mode === 'guest';
      ov.querySelectorAll('[data-mode]').forEach((el) =>
        el.classList.toggle('isl-mode--on', (el as HTMLElement).dataset.mode === (guest ? 'guest' : 'owner')));
      (ov.querySelector('[data-guest-cta]') as HTMLElement).hidden = !guest;
      (ov.querySelector('.isl-title') as HTMLElement).textContent = guest ? "Gleb's Island" : 'My Island';
      refreshIsland();
    }));
  (ov.querySelector('[data-guest-cta]') as HTMLElement).addEventListener('click', () => {
    const b = S.buildings[Math.floor(Math.random() * S.buildings.length)];
    if (b) playSeries(b);
  });

  // Paint the local cache immediately, then replace it with the authoritative
  // server snapshot. Polling keeps an already-open island fresh across devices.
  refreshIsland(false);
  // Wait for the first server read before resuming jobs so a stale device cache
  // cannot revive a bake that another client has already replaced.
  void stateSync.hydrate().finally(resumePendingBakes);
  const pollState = async () => {
    if (!ov.isConnected) return;
    await stateSync?.refresh();
    window.setTimeout(pollState, 10000);
  };
  window.setTimeout(pollState, 10000);
}
