// Island Social Core P1-D — browser E2E against a REAL local backend + PostgreSQL.
//
// Unlike the other scripts/check-*-browser.mjs (which fake the backend), this one
// drives the real production Feed build (VITE_ISLAND_ENABLED=1) against a running
// uvicorn stand (VITE_API_BASE) backed by a disposable migrated PostgreSQL. Auth
// uses genuine HMAC-signed Telegram initData via the client's ?initData= dev
// override, so every island API call is authenticated end-to-end. After each UI
// action the harness asserts the resulting PostgreSQL facts.
//
// Prereqs (set by the P1-D runner, not by this script):
//   - backend on API_ORIGIN with ENABLE_ISLAND_SOCIAL=1, ENABLE_ISLAND_BOTS=1,
//     BOT_TOKEN, INITDATA_MAX_AGE=0, ISLAND_PLAY_MIN_WIN_MS small, and
//     ALLOWED_ORIGINS including this harness's static origin.
//   - bots seeded, owner island seeded (seed_e2e.py).
// Env in:
//   BOT_TOKEN, API_ORIGIN, VENV_PY, BACKEND_ROOT, DATABASE_URL, PY_SCRATCH,
//   ARTIFACT_DIR, STATIC_PORT
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOT_TOKEN = process.env.BOT_TOKEN || 'dev-island-e2e-token';
const API_ORIGIN = process.env.API_ORIGIN || 'http://127.0.0.1:5211';
const VENV_PY = process.env.VENV_PY;
const BACKEND_ROOT = process.env.BACKEND_ROOT;
const DATABASE_URL = process.env.DATABASE_URL;
// Python DB-setup helpers live alongside this harness; override with PY_SCRATCH.
const PY_SCRATCH = process.env.PY_SCRATCH || path.join(root, 'scripts', 'island-e2e-support');
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(root, 'e2e-artifacts', 'island-social');
const STATIC_PORT = Number(process.env.STATIC_PORT || 5213);
const STATIC_ORIGIN = `http://127.0.0.1:${STATIC_PORT}`;

for (const [k, v] of Object.entries({ VENV_PY, BACKEND_ROOT, DATABASE_URL, PY_SCRATCH })) {
  assert.ok(v, `missing required env ${k}`);
}
mkdirSync(ARTIFACT_DIR, { recursive: true });

// ── test cohort (must match seed_e2e.py / reset_e2e.py) ──────────────────────
const OWNER = 700000002;
const GUEST = 700000003;
const INVITER = 700000004;
const ACCEPTER = 700000010; // fresh, distinct from the API-driver cohort
const BOT_ID = 900000000000001;
const B0 = 'b0000000-0000-4000-8000-000000000000';
const B1 = 'b1000000-0000-4000-8000-000000000001';
const FRIEND_CODE = 'E2EFRIEND1';

// ── signed initData (mirrors app/auth.py + scratchpad/mkinit.py exactly) ─────
function signInitData(userId, firstName, username, startParam) {
  const user = { id: userId, first_name: firstName };
  if (username) user.username = username;
  user.photo_url = `https://t.me/i/userpic/320/${userId}.jpg`;
  const fields = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `AAE${userId}`,
  };
  if (startParam) fields.start_param = startParam;
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  fields.hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(fields).toString();
}

// ── python bridge to the stand DB ────────────────────────────────────────────
function py(scriptName, argv = []) {
  const res = spawnSync(VENV_PY, [path.join(PY_SCRATCH, scriptName), ...argv], {
    cwd: BACKEND_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPATH: BACKEND_ROOT,
      DATABASE_URL,
      ENABLE_ISLAND_SOCIAL: '1',
      ENABLE_ISLAND_BOTS: '1',
      BOT_TOKEN,
      DEV_USER_IDS: '700000001',
    },
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`${scriptName} failed: ${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}
const dbq = (sql) => JSON.parse(py('dbq.py', [sql]));
const resetDb = () => py('reset_e2e.py');

// ── static origin: serves the built client + a fake win-emitting playable ────
const buildRoot = mkdtempSync(path.join(tmpdir(), 'island-social-browser-'));
const fakePlayable = `<!doctype html><html><body><canvas></canvas><script>
const send = (m) => parent.postMessage(Object.assign({ source: 'playable' }, m), '*');
addEventListener('message', (e) => {
  if (e.data && e.data.type === 'prepareInteractive') send({ type: 'interactive_ready' });
});
addEventListener('load', () => {
  send({ type: 'static_ready' });
  // Emit a win well past the backend's island_play_min_win_ms so /result grants.
  setTimeout(() => send({ type: 'completed', success: true }), 1600);
});
</script></body></html>`;
const p2CardHtml = `<!doctype html><html><body><main class="reward"></main><script type="module">
import { mountIslandVisitAwardCard } from '/island-p2-card.mjs';
const query = new URLSearchParams(location.search);
const guestInitData = query.get('initData') || '';
const ownerInitData = query.get('ownerInitData') || '';
const auth = (initData) => ({ Authorization: 'tma ' + initData, 'Content-Type': 'application/json' });
const call = async (path, initData, method = 'GET', body) => {
  const response = await fetch(${JSON.stringify(API_ORIGIN)} + path, {
    method, headers: auth(initData), body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(response.status + ':' + JSON.stringify(data));
  return data;
};
window.p2 = { award: null, publicView: null, result: null, collect: null };
const award = await call(
  '/api/island/visit-award/from-chest',
  guestInitData,
  'POST',
  { run_id: 'island-p2-browser-chest' },
);
window.p2.award = award;
mountIslandVisitAwardCard({
  parent: document.querySelector('.reward'),
  award,
  escapeHtml: (value) => String(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
  onAccept: async () => {
    await call('/api/island/visit-award/' + encodeURIComponent(award.roll_id) + '/accept', guestInitData, 'POST');
    window.p2.publicView = await call('/api/island/public/' + award.target.owner_id, guestInitData);
    document.body.dataset.accepted = '1';
  },
  onDecline: async () => {
    await call('/api/island/visit-award/' + encodeURIComponent(award.roll_id) + '/decline', guestInitData, 'POST');
  },
  onError: (error) => { window.p2.error = String(error); },
});
window.completeP2Visit = async () => {
  const building = window.p2.publicView.buildings[0];
  const visitId = crypto.randomUUID();
  await call('/api/island/visits/start', guestInitData, 'POST', {
    visit_id: visitId,
    owner_id: window.p2.award.target.owner_id,
    building_id: building.buildingId,
  });
  await new Promise((resolve) => setTimeout(resolve, 1600));
  window.p2.result = await call('/api/island/visits/' + visitId + '/result', guestInitData, 'POST', {
    outcome: 'completed',
    duration_ms: 1600,
  });
  document.body.dataset.visited = '1';
  return window.p2.result;
};
window.collectP2Gift = async () => {
  const building = window.p2.publicView.buildings[0];
  window.p2.collect = await call(
    '/api/island/buildings/' + building.buildingId + '/collect',
    ownerInitData,
    'POST',
    { claim_id: crypto.randomUUID() },
  );
  document.body.dataset.collected = '1';
  return window.p2.collect;
};
</script></body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', STATIC_ORIGIN);
  if (url.pathname === '/versions.json') {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
    return;
  }
  if (url.pathname === '/p2-card.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(p2CardHtml);
    return;
  }
  if (url.pathname === '/island-p2-card.mjs') {
    response.setHeader('content-type', 'application/javascript; charset=utf-8');
    response.end(readFileSync(path.join(root, 'src', 'island-p2-card.mjs')));
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(readFileSync(path.join(buildRoot, 'index.html')));
    return;
  }
  if (url.pathname.endsWith('.html')) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fakePlayable);
    return;
  }
  if (url.pathname.endsWith('.payload.js')) {
    response.setHeader('content-type', 'application/javascript; charset=utf-8');
    response.end('');
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(STATIC_PORT, '127.0.0.1', resolve);
});

// ── build the real production client, pointed at the real backend ────────────
const build = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    VITE_API_BASE: API_ORIGIN,
    VITE_ISLAND_ENABLED: '1',
    VITE_ISLAND_VISIT_AWARDS_ENABLED: '1',
    VITE_UGC_BASE_URL: STATIC_ORIGIN, // guest playable iframes load from our fake origin
  },
  timeout: 180_000,
});
if (build.status !== 0) {
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
}

const telegramSdkFixture = `
window.Telegram = { WebApp: {
  initData: '', initDataUnsafe: {}, platform: 'web',
  ready(){}, expand(){}, disableVerticalSwipes(){}, enableClosingConfirmation(){},
  setHeaderColor(){}, setBackgroundColor(){}, lockOrientation(){}, onEvent(){}, offEvent(){},
  HapticFeedback: { impactOccurred(){}, notificationOccurred(){}, selectionChanged(){} },
  close(){},
} };`;

const summary = [];
let browser = null;
try {
  browser = await chromium.launch();
  // `beforeNav(page)` runs AFTER routes are set up but BEFORE navigation, so a
  // caller can register response waiters that must not miss a response fired on
  // boot / right after /session (see CASE D — F011: the waiter must precede nav).
  const openPage = async (initData, extraQuery = {}, beforeNav) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
    await page.route('https://telegram.org/js/telegram-web-app.js', (r) => r.fulfill({
      status: 200, contentType: 'application/javascript', body: telegramSdkFixture,
    }));
    const q = new URLSearchParams({ initData, ...extraQuery });
    const sessionSeen = page.waitForResponse((r) =>
      new URL(r.url()).pathname === '/api/session' && r.request().method() === 'POST').catch(() => null);
    if (beforeNav) beforeNav(page);
    await page.goto(`${STATIC_ORIGIN}/?${q.toString()}`, { waitUntil: 'domcontentloaded' });
    await sessionSeen;
    return page;
  };
  const shot = (page, name) => page.screenshot({ path: path.join(ARTIFACT_DIR, `${name}.png`) });

  // ══ CASE A — owner: MAX badge, stages, foundation CTA, collect (no double) ══
  resetDb();
  {
    const page = await openPage(signInitData(OWNER, 'IslandOwner', 'owner'));
    // open own island via the Meta feed-bar tab (VITE_ISLAND_ENABLED gate)
    await page.locator('button.feed-bar__icon[data-bar-tab="meta"]').waitFor({ state: 'visible' });
    await page.locator('button.feed-bar__icon[data-bar-tab="meta"]').click();
    const world = page.locator('.island-world');
    await world.waitFor({ state: 'visible' });
    await page.locator('.isl-worldbox svg').waitFor({ state: 'visible' });

    // stages + MAX badge on B1 (foreign_claims=10)
    await page.locator('g.isl-sector[data-b="1"] g.isl-max').waitFor({ state: 'attached' });
    assert.equal(await page.locator('g.isl-sector[data-b="1"] g.isl-max text').first().textContent(), 'MAX',
      'B1 MAX badge missing');
    assert.equal(await page.locator('g.isl-sector[data-b="0"] g.isl-max').count(), 0,
      'B0 (stage 2) must not show a MAX badge');

    // foundation CTA on an empty unlocked slot
    await page.locator('g.isl-foundation').first().waitFor({ state: 'attached' });
    const foundationText = (await page.locator('g.isl-foundation').first().textContent()) || '';
    assert.match(foundationText, /Создай механику/, 'foundation CTA text missing');

    // collect puck on B0 shows pending_gifts=3
    const puck = page.locator('g.isl-puz[data-collect="0"]');
    await puck.waitFor({ state: 'attached' });
    assert.match((await puck.textContent()) || '', /3/, 'collect puck should show pending_gifts=3');
    await shot(page, 'A1-owner-island-max-foundation-puck');

    // double-tap: fire two rapid clicks; the in-flight guard must yield ONE /collect
    let collectPosts = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === `/api/island/buildings/${B0}/collect`) collectPosts += 1;
    });
    const collectResp = page.waitForResponse((r) =>
      new URL(r.url()).pathname === `/api/island/buildings/${B0}/collect`);
    // dispatchEvent fires the SVG click listener directly — a synthetic mouse
    // click registers as a map pan (panMoved) and is suppressed. Two rapid
    // dispatches exercise the in-flight double-tap guard.
    await puck.dispatchEvent('click');
    await puck.dispatchEvent('click').catch(() => {});
    await collectResp;
    await page.locator('[data-toast]').waitFor({ state: 'visible' }).catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, 'A2-owner-collect-toast');

    // DB facts
    const collectRows = dbq(`SELECT disposition, gifts, puzzles FROM island_collect_claims WHERE building_id='${B0}'`);
    assert.equal(collectRows.length, 1, `expected exactly one collect claim, got ${collectRows.length}`);
    assert.deepEqual(collectRows[0], ['granted', 3, 3], `collect row wrong: ${JSON.stringify(collectRows[0])}`);
    const pending = dbq(`SELECT pending_gifts FROM island_building_social WHERE building_id='${B0}'`)[0][0];
    assert.equal(pending, 0, 'pending_gifts should be 0 after collect');
    const ledger = dbq(`SELECT puzzles FROM puzzle_ledger WHERE idempotency_key LIKE 'island:collect:%'`);
    assert.equal(ledger.length, 1, 'exactly one collect ledger grant');
    assert.equal(collectPosts, 1, `double-tap fired ${collectPosts} collect POSTs (expected 1)`);
    // puck gone after collect
    assert.equal(await page.locator('g.isl-puz[data-collect="0"]').count(), 0, 'puck should disappear after collect');
    summary.push('A owner: MAX badge + foundation CTA + collect(3, single POST, pending->0) OK');
    await page.close();
  }

  // ══ CASE B — guest claim (granted) then repeat_day, real win via iframe ══
  resetDb();
  {
    const page = await openPage(signInitData(GUEST, 'IslandGuest', 'guest'), { island: String(OWNER) });
    const world = page.locator('.island-world');
    await world.waitFor({ state: 'visible' });
    // guest taps the B0 sector to play the series
    const sector = page.locator('g.isl-sector[data-b="0"]');
    await sector.waitFor({ state: 'attached' });
    const resultResp1 = page.waitForResponse((r) =>
      new URL(r.url()).pathname.startsWith('/api/island/visits/') && new URL(r.url()).pathname.endsWith('/result'));
    await sector.dispatchEvent('click');
    // win modal appears after the fake playable emits 'completed'
    await page.locator('.isl-win').waitFor({ state: 'visible', timeout: 20_000 });
    await resultResp1;
    await page.locator('.isl-gift[data-gift]:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });
    const gift1 = (await page.locator('.isl-gift[data-gift]').textContent()) || '';
    assert.match(gift1, /\+\s*3/, `granted gift text wrong: "${gift1}"`);
    await shot(page, 'B1-guest-gift-granted');

    let outcomes = dbq(`SELECT disposition, puzzles FROM island_completion_outcomes ORDER BY day_bucket, claim_id`);
    assert.deepEqual(outcomes, [['granted', 3]], `first claim DB fact wrong: ${JSON.stringify(outcomes)}`);

    // leave the win modal, visit again same day → repeat_day
    await page.locator('.isl-win__home[data-home]').click();
    const resultResp2 = page.waitForResponse((r) =>
      new URL(r.url()).pathname.startsWith('/api/island/visits/') && new URL(r.url()).pathname.endsWith('/result'));
    await page.locator('g.isl-sector[data-b="0"]').dispatchEvent('click');
    await page.locator('.isl-win').waitFor({ state: 'visible', timeout: 20_000 });
    await resultResp2;
    await page.locator('.isl-gift[data-gift]:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });
    const gift2 = (await page.locator('.isl-gift[data-gift]').textContent()) || '';
    assert.match(gift2, /приходи завтра/, `repeat_day gift text wrong: "${gift2}"`);
    await shot(page, 'B2-guest-gift-repeat-day');

    outcomes = dbq(`SELECT disposition FROM island_completion_outcomes ORDER BY day_bucket, claim_id`);
    assert.deepEqual(outcomes.map((r) => r[0]).sort(), ['granted', 'repeat_day'],
      `expected granted+repeat_day, got ${JSON.stringify(outcomes)}`);
    const giftLedger = dbq(`SELECT count(*) FROM puzzle_ledger WHERE idempotency_key LIKE 'island:gift:%'`)[0][0];
    assert.equal(Number(giftLedger), 1, 'exactly one gift ledger grant (repeat_day grants nothing)');
    summary.push('B guest: granted(+3) then repeat_day, DB outcomes match OK');
    await page.close();
  }

  // ══ CASE C — bot badge on a bot island ══
  {
    const page = await openPage(signInitData(GUEST, 'IslandGuest', 'guest'), { island: String(BOT_ID) });
    await page.locator('.island-world').waitFor({ state: 'visible' });
    await page.locator('.island-world .isl-botbadge').waitFor({ state: 'attached', timeout: 10_000 });
    const badge = (await page.locator('.island-world .isl-botbadge').textContent()) || '';
    assert.match(badge, /бот/, `bot badge text wrong: "${badge}"`);
    const isBot = dbq(`SELECT count(*) FROM island_bots WHERE user_id=${BOT_ID}`)[0][0];
    assert.equal(Number(isBot), 1, 'bot owner must be a seeded bot');
    await shot(page, 'C1-bot-badge');
    summary.push('C guest: bot badge shown on bot island OK');
    await page.close();
  }

  // ══ CASE D — friend accept via f_<code> deeplink, HUD cell + DB ══
  {
    // F011: register the accept waiter BEFORE navigation — the accept now fires
    // right after the first /session bootstrap (F004), so a waiter set after
    // openPage() returns could miss it and pass falsely.
    let acceptResp;
    const page = await openPage(
      signInitData(ACCEPTER, 'FriendAccepter', 'accepter', `f_${FRIEND_CODE}`),
      { tgWebAppStartParam: `f_${FRIEND_CODE}` },
      (p) => {
        acceptResp = p.waitForResponse((r) =>
          new URL(r.url()).pathname === '/api/island/friends/accept', { timeout: 15_000 });
      },
    );
    await acceptResp;
    // Wait until the initial preloader has faded before asserting the HUD, then
    // require a VISIBLE, clickable inviter cell (not merely attached).
    await page.locator('.preloader--hidden').waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {});
    const cell = page.locator(`.isln-friends [data-friend-visit="${INVITER}"]`);
    await cell.waitFor({ state: 'visible', timeout: 10_000 });
    await cell.scrollIntoViewIfNeeded();
    assert.ok(await cell.isEnabled(), 'inviter friend cell must be visible and clickable');
    await shot(page, 'D1-friend-accepted-hud');
    const fr = dbq(`SELECT user_lo, user_hi, source, removed_at IS NULL FROM island_friendships`);
    const lo = Math.min(ACCEPTER, INVITER), hi = Math.max(ACCEPTER, INVITER);
    assert.equal(fr.length, 1, `expected 1 friendship, got ${fr.length}`);
    assert.deepEqual([fr[0][0], fr[0][1], fr[0][2], fr[0][3]], [lo, hi, 'invite', true],
      `friendship DB fact wrong: ${JSON.stringify(fr[0])}`);
    summary.push('D accepter: f_<code> deeplink → HUD cell + active invite friendship OK');
    await page.close();
  }

  // ══ CASE E — DOGFOOD (§7): fresh user → auto-friend bot → bot tick grows
  //    house → collect by tap → visit bot → win → gift ══
  {
    const dog = JSON.parse(py('dogfood_setup.py'));
    const U = dog.user, botId = dog.bot_id, DBID = dog.building;
    // The bot tick grows the house up to the per-player caps (F001) and the
    // pending_gifts cap of 9; the exact number depends on the seeded config, so
    // assert it grew, is entirely bot-sourced, and stays within the cap.
    const grew = dog.grown.pending_gifts;
    assert.ok(grew >= 1 && grew <= 9, `bot tick should grow pending in 1..9, got ${grew}`);
    assert.equal(dog.grown.bot_claims, grew, 'grown pending must be entirely bot-sourced');

    // 1) fresh user opens own island: grown house + pending puck
    const page = await openPage(signInitData(U, 'Dogfooder', 'dogfooder'));
    await page.locator('button.feed-bar__icon[data-bar-tab="meta"]').click();
    await page.locator('.island-world .isl-worldbox svg').waitFor({ state: 'visible' });
    const puck = page.locator('g.isl-puz[data-collect="0"]');
    await puck.waitFor({ state: 'attached' });
    assert.match((await puck.textContent()) || '', new RegExp(String(grew)), `grown house should show ${grew} pending gifts`);
    await shot(page, 'E1-dogfood-house-grown');

    // 2) collect by tap
    const collectResp = page.waitForResponse((r) =>
      new URL(r.url()).pathname === `/api/island/buildings/${DBID}/collect`);
    await puck.dispatchEvent('click');
    await collectResp;
    await page.waitForTimeout(500);
    await shot(page, 'E2-dogfood-collected');
    const collect = dbq(`SELECT disposition, gifts, puzzles FROM island_collect_claims WHERE building_id='${DBID}'`);
    assert.deepEqual(collect[0], ['granted', grew, grew], `dogfood collect wrong: ${JSON.stringify(collect[0])}`);

    // 3) visit the auto-friended bot, win, receive a gift
    await page.close();
    const gpage = await browser.newPage({ viewport: { width: 390, height: 760 } });
    await gpage.route('https://telegram.org/js/telegram-web-app.js', (r) => r.fulfill({
      status: 200, contentType: 'application/javascript', body: telegramSdkFixture }));
    // Builtin bot playables may resolve to a non-fixture origin; serve the
    // win-emitting fake for any playable html so the visit reaches a win.
    await gpage.route('**/*.html', (r) => {
      if (new URL(r.request().url()).pathname === '/') return r.continue();
      return r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fakePlayable });
    });
    {
      const q = new URLSearchParams({ initData: signInitData(U, 'Dogfooder', 'dogfooder'), island: String(botId) });
      await gpage.goto(`${STATIC_ORIGIN}/?${q.toString()}`, { waitUntil: 'domcontentloaded' });
    }
    await gpage.locator('.island-world .isl-worldbox svg').waitFor({ state: 'visible' });
    const resultResp = gpage.waitForResponse((r) =>
      new URL(r.url()).pathname.startsWith('/api/island/visits/') && new URL(r.url()).pathname.endsWith('/result'));
    await gpage.locator('g.isl-sector[data-b]').first().dispatchEvent('click');
    await gpage.locator('.isl-win').waitFor({ state: 'visible', timeout: 20_000 });
    await resultResp;
    await gpage.locator('.isl-gift[data-gift]:not([hidden])').waitFor({ state: 'visible', timeout: 10_000 });
    const gift = (await gpage.locator('.isl-gift[data-gift]').textContent()) || '';
    assert.match(gift, /\+\s*3/, `dogfood bot-visit gift wrong: "${gift}"`);
    await shot(gpage, 'E3-dogfood-bot-visit-gift');
    const outcome = dbq(`SELECT disposition, puzzles FROM island_completion_outcomes WHERE guest_id=${U}`);
    assert.deepEqual(outcome[0], ['granted', 3], `dogfood visit outcome wrong: ${JSON.stringify(outcome[0])}`);
    summary.push(`E dogfood: fresh user → auto-friend bot → bot tick(pending=${grew}) → collect(${grew}) → visit bot → gift(+3) OK`);
    await gpage.close();
  }

  // ══ CASE F — P2 real vertical: exact chest → production card → public
  //    transition → real visit result → owner collect, all against PostgreSQL ══
  resetDb();
  py('seed_p2_e2e.py');
  {
    const guestInitData = signInitData(GUEST, 'IslandGuest', 'guest');
    const ownerInitData = signInitData(OWNER, 'IslandOwner', 'owner');
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    const q = new URLSearchParams({ initData: guestInitData, ownerInitData });
    await page.goto(`${STATIC_ORIGIN}/p2-card.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });
    const card = page.locator('.isln-award');
    await card.waitFor({ state: 'visible', timeout: 15_000 });
    const award = await page.evaluate(() => window.p2.award);
    assert.equal(award.won, true, 'exact chest must win under the stand config');
    assert.equal(award.holdout, false, 'stand config disables holdout');
    assert.equal(award.target.owner_id, OWNER, 'human public owner must beat bot fallback');
    assert.match((await card.textContent()) || '', /\+3/, 'card gift preview missing');
    await shot(page, 'F1-p2-exact-chest-card');

    await page.locator('.isln-award__go').click();
    await page.locator('body[data-accepted="1"]').waitFor({ state: 'attached' });
    const publicView = await page.evaluate(() => window.p2.publicView);
    assert.equal(publicView.owner.id, OWNER, 'card did not transition to the awarded island');
    assert.ok(publicView.buildings.length > 0, 'awarded island has no public building');

    const result = await page.evaluate(() => window.completeP2Visit());
    assert.equal(result.disposition, 'granted', `P2 visit result wrong: ${JSON.stringify(result)}`);
    assert.equal(result.gift?.puzzles, 3, 'guest gift must use the server P1 grant');
    const collect = await page.evaluate(() => window.collectP2Gift());
    assert.equal(collect.disposition, 'granted', `P2 collect wrong: ${JSON.stringify(collect)}`);
    assert.equal(collect.gifts, 1, 'owner must collect the one real P2 visit gift');
    await shot(page, 'F2-p2-visited-and-collected');

    const awardFacts = dbq(
      `SELECT state, target_owner_id, won, holdout FROM island_visit_awards WHERE run_id='island-p2-browser-chest'`,
    );
    assert.deepEqual(awardFacts, [['accepted', OWNER, true, false]]);
    const outcomeFacts = dbq(
      `SELECT disposition, puzzles FROM island_completion_outcomes WHERE guest_id=${GUEST}`,
    );
    assert.deepEqual(outcomeFacts, [['granted', 3]]);
    const collectFacts = dbq(
      `SELECT disposition, gifts, puzzles FROM island_collect_claims WHERE owner_id=${OWNER}`,
    );
    assert.deepEqual(collectFacts, [['granted', 1, 1]]);
    summary.push('F P2: exact chest → real card → island → visit(+3) → owner collect(1), DB facts OK');
    await page.close();
  }

  console.log('\nISLAND SOCIAL BROWSER E2E — all cases passed:');
  for (const line of summary) console.log('  •', line);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
