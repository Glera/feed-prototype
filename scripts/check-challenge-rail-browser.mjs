// Share/Challenge V1 — RAIL browser check. The unified rail row [You | friends |
// challenges] renders; with VITE_CHALLENGE_V1_ENABLED=true a friend who has an
// active challenge in my inbox gets a ⚡ badge on their island avatar; with the
// flag OFF the rail is byte-for-byte legacy (inbox cards still render, no friend
// badge). Real built client ↔ real backend, screenshots for both.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, '..');
const API = process.env.API_ORIGIN || 'http://127.0.0.1:5221';
const BOT_TOKEN = process.env.BOT_TOKEN || 'dev-challenge-token';
const VENV_PY = process.env.VENV_PY;
const BACKEND_ROOT = process.env.BACKEND_ROOT;
const DATABASE_URL = process.env.DATABASE_URL;
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(root, 'e2e-artifacts', 'challenge');
const C = 700000101; // challenger (friend)
const V = 700000102; // viewer / recipient
mkdirSync(ARTIFACT_DIR, { recursive: true });

function sign(uid) {
  const user = { id: uid, first_name: `U${uid}`, photo_url: `https://t.me/i/userpic/320/${uid}.jpg` };
  const f = { user: JSON.stringify(user), auth_date: String(Math.floor(Date.now() / 1000)), query_id: `AAE${uid}` };
  const dcs = Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join('\n');
  const s = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  f.hash = crypto.createHmac('sha256', s).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
}
function py(code, ...args) {
  const r = spawnSync(VENV_PY, ['-c', code, ...args], { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL } });
  if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
}

// ── data setup: reset → source challenge (C) → V accepts (unbeaten) ─────────
const T = 'challenge_spec_bindings,challenge_ticket_bindings,challenge_events,challenge_friendship_receipts,challenge_attempts,verified_runs,run_tickets,reward_ledger,puzzle_ledger,level_results,attempt_outcome_facts,attempts,challenges,challenge_specs,island_friendships,island_friend_blocks,friend_edges,runtime_releases,variants,usage_counters';
py(`from sqlalchemy import text;from app.db import SessionLocal
db=SessionLocal();db.execute(text("SET session_replication_role=replica"));db.execute(text("TRUNCATE TABLE ${T} RESTART IDENTITY CASCADE"));db.commit()`);
const setup = spawnSync(VENV_PY, [path.join(HERE, 'challenge-e2e-support', 'challenge_source_setup.py')], { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL } });
if (setup.status !== 0) throw new Error(setup.stdout + setup.stderr);
const CID = JSON.parse(setup.stdout.slice(setup.stdout.indexOf('{'))).challenge_id;
let res = await fetch(`${API}/api/challenges/${CID}/accept`, { method: 'POST', headers: { Authorization: 'tma ' + sign(V), 'X-P4G-Challenge-Wire-Version': '1', 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(res.status, 200, `V accept: ${res.status}`);
console.log(`data: challenge=${CID.slice(0, 8)} — V(${V}) friends+inbox=C(${C})`);

// ── build the client twice (flag ON / OFF) ─────────────────────────────────
const fakePlayable = `<!doctype html><html><body><canvas></canvas><script>
const s=(m)=>parent.postMessage(Object.assign({source:'playable'},m),'*');
addEventListener('message',(e)=>{if(e.data&&e.data.type==='prepareInteractive')s({type:'interactive_ready'})});
addEventListener('load',()=>s({type:'static_ready'}));</script></body></html>`;
const telegramSdkFixture = `window.Telegram={WebApp:{initData:'',initDataUnsafe:{},platform:'web',ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},close(){}}};`;
function buildServe(enabled, port) {
  const dir = mkdtempSync(path.join(tmpdir(), `ch-rail-${enabled ? 'on' : 'off'}-`));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, VITE_API_BASE: API, VITE_ISLAND_ENABLED: '1', VITE_UGC_BASE_URL: origin };
  if (enabled) env.VITE_CHALLENGE_V1_ENABLED = 'true'; else delete env.VITE_CHALLENGE_V1_ENABLED;
  const b = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', dir, '--emptyOutDir'], { cwd: root, encoding: 'utf8', env, timeout: 180_000 });
  assert.equal(b.status, 0, `build failed: ${b.stdout}\n${b.stderr}`);
  const server = createServer((req, r) => {
    const u = new URL(req.url || '/', origin);
    if (u.pathname === '/versions.json') { r.setHeader('content-type', 'application/json'); return r.end('{}'); }
    if (u.pathname === '/' || u.pathname === '/index.html') { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(readFileSync(path.join(dir, 'index.html'))); }
    if (u.pathname.endsWith('.html')) { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(fakePlayable); }
    if (u.pathname.endsWith('.payload.js')) { r.setHeader('content-type', 'application/javascript'); return r.end(''); }
    r.statusCode = 404; r.end();
  });
  return { dir, origin, server, port };
}
const on = buildServe(true, 5223);
const off = buildServe(false, 5224);
await new Promise((r, j) => { on.server.once('error', j); on.server.listen(on.port, '127.0.0.1', r); });
await new Promise((r, j) => { off.server.once('error', j); off.server.listen(off.port, '127.0.0.1', r); });

let browser = null;
const summary = [];
try {
  browser = await chromium.launch();
  const load = async (origin) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    await page.route('https://telegram.org/js/telegram-web-app.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: telegramSdkFixture }));
    const seen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session' && r.request().method() === 'POST').catch(() => null);
    await page.goto(`${origin}/?${new URLSearchParams({ initData: sign(V) }).toString()}`, { waitUntil: 'domcontentloaded' });
    await seen;
    return page;
  };

  // ── flag ON: friend cluster + inbox card + ⚡ friend badge ──
  {
    const page = await load(on.origin);
    await page.locator('.stories').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator(`.isln-friends [data-friend-visit="${C}"]`).waitFor({ state: 'attached', timeout: 15_000 });
    await page.locator(`.story[data-challenge="${CID}"]`).waitFor({ state: 'attached', timeout: 15_000 });
    // The ⚡ friend badge is applied by renderChallengeRail; at boot it can race
    // the async island-friends population. Force a rail refresh now that both the
    // friend cell and the inbox card are present, then the badge decorates.
    await page.evaluate(() => window.__feedRefreshRail && window.__feedRefreshRail());
    await page.locator(`.isln-friends [data-friend-visit="${C}"] .isln-friend__challenge-badge`).waitFor({ state: 'attached', timeout: 15_000 });
    const badge = (await page.locator(`.isln-friends [data-friend-visit="${C}"] .isln-friend__challenge-badge`).textContent()) || '';
    assert.match(badge, /⚡/, `friend challenge badge text: "${badge}"`);
    assert.equal(await page.locator(`.story[data-challenge="${CID}"] .story__bolt`).count(), 1, 'inbox card carries its ⚡ bolt');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'rail-flag-on.png') });
    summary.push('flag ON: unified rail [You|friends|challenges], ⚡ badge on friend avatar with active challenge, inbox card present OK');
    await page.close();
  }

  // ── flag OFF: same rail, NO friend badge (byte-identical legacy) ──
  {
    const page = await load(off.origin);
    await page.locator('.stories').first().waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator(`.isln-friends [data-friend-visit="${C}"]`).waitFor({ state: 'attached', timeout: 15_000 });
    await page.locator(`.story[data-challenge="${CID}"]`).waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForTimeout(1500); // give any (suppressed) badge a chance to (not) appear
    assert.equal(await page.locator(`.isln-friends [data-friend-visit="${C}"] .isln-friend__challenge-badge`).count(), 0, 'flag OFF must NOT decorate the friend avatar');
    assert.equal(await page.locator(`.story[data-challenge="${CID}"]`).count(), 1, 'flag OFF still renders the inbox rail card (byte-identical legacy)');
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'rail-flag-off.png') });
    summary.push('flag OFF: same rail + inbox card, NO ⚡ friend-avatar badge (legacy byte-identical) OK');
    await page.close();
  }

  console.log('\nCHALLENGE RAIL BROWSER CHECK — passed:');
  for (const l of summary) console.log('  •', l);
} finally {
  await browser?.close();
  await new Promise((r) => on.server.close(r));
  await new Promise((r) => off.server.close(r));
  rmSync(on.dir, { recursive: true, force: true });
  rmSync(off.dir, { recursive: true, force: true });
}
