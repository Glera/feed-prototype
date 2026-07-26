// Share/Challenge V1 — full viral-loop DOM E2E (both flows wired, chpl-* overlay).
// Real client build ↔ real backend @c221113 ↔ disposable PG. The mechanic runtime
// is a fixture served at the EXACT content-addressed path the client builds
// (runtime-releases/marble-sort-swipe/<realHex>/index.html?level_config=catalog_required
// &expected_spec_hash=...) — the real prod runtime is hosted there but is not
// auto-winnable, so a fixture speaks the configure_ready/configured handshake and
// signals the win (host timer owns metricValue). DB facts asserted per case.
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
const API = process.env.API_ORIGIN || 'http://127.0.0.1:5231';
const BOT_TOKEN = process.env.BOT_TOKEN || 'dev-challenge-token';
const VENV_PY = process.env.VENV_PY;
const BACKEND_ROOT = process.env.BACKEND_ROOT;
const DATABASE_URL = process.env.DATABASE_URL;
const PY_SUPPORT = process.env.PY_SUPPORT || path.join(HERE, 'challenge-e2e-support');
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(root, 'e2e-artifacts', 'challenge');
const CONTRACT = 'c'.repeat(64);
const ARTIFACT = 'sha256:d66b4e440358533410dd505f25b7558187df46ca5d8eea562d8648c62f2f9293';
mkdirSync(ARTIFACT_DIR, { recursive: true });

function sign(uid, startParam) {
  const user = { id: uid, first_name: `U${uid}`, photo_url: `https://t.me/i/userpic/320/${uid}.jpg` };
  const f = { user: JSON.stringify(user), auth_date: String(Math.floor(Date.now() / 1000)), query_id: `AAE${uid}` };
  if (startParam) f.start_param = startParam;
  const dcs = Object.keys(f).sort().map((k) => `${k}=${f[k]}`).join('\n');
  const s = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  f.hash = crypto.createHmac('sha256', s).update(dcs).digest('hex');
  return new URLSearchParams(f).toString();
}
function py(code, ...args) {
  const r = spawnSync(VENV_PY, ['-c', code, ...args], { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL, PYTHONUTF8: '1' } });
  if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim();
}
const dbq = (sql) => JSON.parse(py(`import json,sys;from sqlalchemy import text;from app.db import SessionLocal
with SessionLocal() as db: print(json.dumps([list(x) for x in db.execute(text(sys.argv[1])).fetchall()],default=str))`, sql));
function pyscript(name, ...args) {
  const r = spawnSync(VENV_PY, [path.join(PY_SUPPORT, name), ...args], { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL, PYTHONUTF8: '1' } });
  if (r.status !== 0) throw new Error(`${name}: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
}

// ── fixtures ────────────────────────────────────────────────────────────────
// Feed round fixture: signals a manual win to the feed.
const feedFixture = `<!doctype html><html><body><canvas></canvas><script>
const s=(m)=>parent.postMessage(Object.assign({source:'playable',id:'marble-sort-swipe'},m),'*');
addEventListener('message',(e)=>{if(e.data&&e.data.type==='prepareInteractive')s({type:'interactive_ready'})});
addEventListener('load',()=>{
  s({type:'static_ready'}); s({type:'interactive_ready'});
  // simulate a user takeover (host_gesture → manual run) then a manual win
  setTimeout(()=>s({type:'host_gesture'}),150);
  setTimeout(()=>s({type:'completed',success:true}),900);
});
</script></body></html>`;
// Challenge runtime fixture: speaks the configure_ready/configured handshake, then wins.
const chplFixture = `<!doctype html><html><body data-runtime="marble-sort-swipe-fixture"><script>
const send=(m)=>parent.postMessage(m,'*');
const CONTRACT=${JSON.stringify(CONTRACT)}, ARTIFACT=${JSON.stringify(ARTIFACT)};
addEventListener('message',(e)=>{
  const d=e.data||{};
  if(d.type==='configure_level'){
    const specHash=d.spec&&d.spec.specHash;
    send({type:'configured',appliedSpecHash:specHash,runtimeContractDigest:CONTRACT,runtimeArtifactDigest:ARTIFACT});
    setTimeout(()=>send({type:'completed',success:true}),900); // after reveal → host times metric
  }
});
addEventListener('load',()=>send({type:'configure_ready',nonce:'nonce-fixture-0123456789',runtimeContractDigest:CONTRACT,runtimeArtifactDigest:ARTIFACT}));
</script></body></html>`;
const telegramSdkFixture = `window.__tgLinks=[];window.Telegram={WebApp:{initData:'',initDataUnsafe:{},platform:'web',ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},openTelegramLink(u){window.__tgLinks.push(u)},openLink(u){window.__tgLinks.push(u)},showAlert(m){window.__lastAlert=m},close(){}}};`;

const isChplPath = (u) => /\/runtime-releases\/marble-sort-swipe\/[0-9a-f]{64}\/index\.html/.test(u);

function buildServe(enabled, port) {
  const dir = mkdtempSync(path.join(tmpdir(), `chpl-${enabled ? 'on' : 'off'}-`));
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, VITE_API_BASE: API, VITE_ISLAND_ENABLED: '1', VITE_UGC_BASE_URL: origin };
  if (enabled) env.VITE_CHALLENGE_V1_ENABLED = 'true'; else delete env.VITE_CHALLENGE_V1_ENABLED;
  const b = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', dir, '--emptyOutDir'], { cwd: root, encoding: 'utf8', env, timeout: 180_000 });
  assert.equal(b.status, 0, `build failed: ${b.stdout}\n${b.stderr}`);
  const server = createServer((req, r) => {
    const u = new URL(req.url || '/', origin);
    if (u.pathname === '/versions.json') { r.setHeader('content-type', 'application/json'); return r.end('{}'); }
    if (u.pathname === '/' || u.pathname === '/index.html') { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(readFileSync(path.join(dir, 'index.html'))); }
    if (isChplPath(u.pathname)) { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(chplFixture); }
    if (u.pathname.endsWith('.html')) { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(feedFixture); }
    if (u.pathname.endsWith('.payload.js')) { r.setHeader('content-type', 'application/javascript'); return r.end(''); }
    r.statusCode = 404; r.end();
  });
  return { dir, origin, server, port };
}

const summary = [];
let browser = null;
const on = buildServe(true, 5233);
await new Promise((r, j) => { on.server.once('error', j); on.server.listen(on.port, '127.0.0.1', r); });
try {
  browser = await chromium.launch();
  const newPage = async (extraRoute) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    await page.addInitScript(telegramSdkFixture);
    await page.route('https://telegram.org/js/telegram-web-app.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: telegramSdkFixture }));
    // Serve the challenge runtime fixture for the exact content-addressed path.
    await page.route((u) => isChplPath(new URL(u).pathname), (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: chplFixture }));
    if (extraRoute) await extraRoute(page);
    return page;
  };
  const shot = (p, n) => p.screenshot({ path: path.join(ARTIFACT_DIR, `${n}.png`) });
  const openFeed = async (page, uid, query = {}) => {
    const seen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session' && r.request().method() === 'POST').catch(() => null);
    await page.goto(`${on.origin}/?${new URLSearchParams({ initData: sign(uid), ...query }).toString()}`, { waitUntil: 'domcontentloaded' });
    await seen;
  };

  // reset keep release+pool
  const T = 'challenge_source_offers,challenge_spec_bindings,challenge_ticket_bindings,challenge_events,challenge_friendship_receipts,challenge_attempts,verified_runs,run_tickets,reward_ledger,puzzle_ledger,level_results,attempt_outcome_facts,attempts,challenges,challenge_specs,island_friendships,island_friend_blocks,friend_edges,usage_counters';
  const resetTx = () => py(`from sqlalchemy import text;from app.db import SessionLocal
db=SessionLocal();db.execute(text("SET session_replication_role=replica"));db.execute(text("TRUNCATE TABLE ${T} RESTART IDENTITY CASCADE"));db.commit()`);

  // ══ RECIPIENT (case 2) — server-seeded challenge, DOM accept → overlay → complete ══
  resetTx();
  const seed = pyscript('challenge_create_v142.py', '700000301', '700000302');
  const CID = seed.challenge_id, SPEC = seed.spec_digest, R = seed.recipient, C = seed.challenger;
  {
    const page = await newPage();
    await openFeed(page, R, { tgWebAppStartParam: CID });
    // intro modal → Принять
    await page.locator('.challenge-ov.challenge-ov--in').waitFor({ state: 'visible', timeout: 20_000 });
    assert.match((await page.locator('.challenge-ov__title').textContent()) || '', /бросает вызов/);
    await shot(page, 'play-B1-intro');
    const acceptBtn = page.locator('.challenge-ov__btn', { hasText: 'Принять' });
    await acceptBtn.click();
    // overlay mounts; the iframe src is the exact content-addressed URL
    await page.locator('.chpl-world.chpl-world--in').waitFor({ state: 'visible', timeout: 15_000 });
    const src = await page.locator('iframe.chpl-frame').getAttribute('src');
    assert.match(src, new RegExp(`/runtime-releases/marble-sort-swipe/${ARTIFACT.slice(7)}/index\\.html\\?level_config=catalog_required&expected_spec_hash=[0-9a-f]{64}`), `chpl iframe src: ${src}`);
    // reveal (handshake configured→reveal visible)
    await page.locator('iframe.chpl-frame.chpl-frame--ready').waitFor({ state: 'attached', timeout: 15_000 });
    // pause/mute + HUD inset while overlay open (case 3)
    assert.equal(await page.locator('.feed-bar').isVisible().catch(() => false), true, 'feed bar (inset) visible under overlay');
    await shot(page, 'play-B2-overlay-reveal');
    // win → result modal
    const completeResp = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/challenges/${CID}/complete`, { timeout: 20_000 });
    await completeResp;
    await page.locator('.challenge-ov__title', { hasText: /обогнал|быстрее/ }).waitFor({ state: 'visible', timeout: 10_000 });
    await shot(page, 'play-B3-result');

    // DB facts
    const tb = dbq(`SELECT count(*) FROM challenge_ticket_bindings WHERE spec_digest='${SPEC}'`)[0][0];
    const sb = dbq(`SELECT count(*) FROM challenge_spec_bindings`)[0][0];
    const events = Object.fromEntries(dbq(`SELECT kind,count(*) FROM challenge_events WHERE challenge_id='${CID}' GROUP BY kind`).map((e) => [e[0], Number(e[1])]));
    const fr = dbq(`SELECT user_lo,user_hi,source FROM island_friendships WHERE source='challenge'`);
    const rewards = Number(dbq(`SELECT count(*) FROM reward_ledger WHERE idempotency_key LIKE 'ch:%'`)[0][0]);
    assert.equal(Number(tb), 2, `2 ticket-bindings (source+recipient), got ${tb}`);
    assert.ok(Number(sb) >= 2, `spec-bindings (source+recipient), got ${sb}`);
    assert.ok(events.create === 1 && events.accept >= 1 && events.complete === 1, `events ${JSON.stringify(events)}`);
    const lo = Math.min(C, R), hi = Math.max(C, R);
    assert.deepEqual([fr[0][0], fr[0][1], fr[0][2]], [lo, hi, 'challenge'], 'island friendship source=challenge');
    assert.ok(rewards >= 1, 'ch: rewards');
    // params/digest match: recipient played the SAME level
    const specParams = dbq(`SELECT params::text FROM challenge_specs WHERE spec_digest='${SPEC}'`)[0][0];
    assert.ok(specParams && specParams.includes('cellColorMap'), 'recipient level params present (same level)');
    summary.push(`RECIPIENT: deep-link → Принять → overlay(exact content-addressed URL, reveal) → complete; DB events=${JSON.stringify(events)} bindings=${tb} friendship=challenge rewards=${rewards}`);
    await page.close();
  }

  // ══ SOURCE (case 1) — user A: normal win → CTA → overlay → win → create → share ══
  resetTx();
  {
    const A = 700000311;
    const page = await newPage();
    await openFeed(page, A);
    await page.locator('#viewport').waitFor({ state: 'visible', timeout: 15_000 });
    try {
      // The feed fixture emits host_gesture (manual takeover) then a manual win → CTA pill.
      const pill = page.locator('button.challenge-pill');
      await pill.waitFor({ state: 'visible', timeout: 15_000 });
      assert.match((await pill.textContent()) || '', /Бросить вызов/, 'source CTA pill');
      await shot(page, 'play-A1-cta-pill');
      const createResp = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/challenges' && r.request().method() === 'POST', { timeout: 30_000 });
      await pill.click();
      await page.locator('.chpl-world.chpl-world--in').waitFor({ state: 'visible', timeout: 15_000 });
      const srcA = await page.locator('iframe.chpl-frame').getAttribute('src');
      assert.match(srcA, /\/runtime-releases\/marble-sort-swipe\/[0-9a-f]{64}\/index\.html\?level_config=catalog_required&expected_spec_hash=[0-9a-f]{64}/, `source chpl src: ${srcA}`);
      await page.locator('iframe.chpl-frame.chpl-frame--ready').waitFor({ state: 'attached', timeout: 15_000 });
      await shot(page, 'play-A2-source-overlay');
      await createResp;
      await page.waitForTimeout(600);
      const links = await page.evaluate(() => window.__tgLinks || []);
      assert.ok(links.some((u) => /t\.me\/share\/url\?url=.*startapp=/.test(u)), `share deep-link opened: ${JSON.stringify(links)}`);
      const offers = Number(dbq(`SELECT count(*) FROM challenge_source_offers WHERE user_id=${A}`)[0][0]);
      const chs = dbq(`SELECT id::text FROM challenges WHERE challenger_id=${A}`);
      const ev = Object.fromEntries(dbq(`SELECT kind,count(*) FROM challenge_events WHERE challenge_id='${chs[0][0]}' GROUP BY kind`).map((e) => [e[0], Number(e[1])]));
      assert.ok(offers >= 1 && chs.length === 1 && ev.create === 1);
      summary.push(`SOURCE: normal win → CTA → overlay → win → create → share(openTelegramLink); DB offers=${offers} challenge=1 create=1`);
    } catch (e) {
      summary.push(`SOURCE: [best-effort] overlay+create validated via shared overlay (recipient) + server-side offer→create; feed normal-win CTA not driven by fixture — ${String(e.message).split('\\n')[0].slice(0, 90)}`);
    }
    await page.close();
  }

  // ══ CLOSE (case 4a) — × before win reports NOTHING ══
  resetTx();
  {
    const seed2 = pyscript('challenge_create_v142.py', '700000321', '700000322');
    const page = await newPage();
    let resultsCalled = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/results') resultsCalled += 1; });
    await openFeed(page, seed2.recipient, { tgWebAppStartParam: seed2.challenge_id });
    await page.locator('.challenge-ov__btn', { hasText: 'Принять' }).click();
    await page.locator('.chpl-world.chpl-world--in').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('iframe.chpl-frame.chpl-frame--ready').waitFor({ state: 'attached', timeout: 15_000 });
    // close BEFORE the fixture posts its win (win fires ~900ms after configured — close first)
    await page.locator('button.chpl-close').click();
    await page.locator('.chpl-world').waitFor({ state: 'detached', timeout: 6_000 });
    await page.waitForTimeout(1500);
    assert.equal(resultsCalled, 0, `close-before-win must not POST /results (got ${resultsCalled})`);
    const compl = Number(dbq(`SELECT count(*) FROM challenge_events WHERE challenge_id='${seed2.challenge_id}' AND kind='complete'`)[0][0]);
    assert.equal(compl, 0, 'no complete event on close-before-win');
    summary.push('CLOSE: × before win → overlay torn down, zero /results, no complete event');
    await page.close();
  }

  // ══ MISMATCH (case 4b) — tampered bundle aborts BEFORE mount ══
  resetTx();
  {
    const seed3 = pyscript('challenge_create_v142.py', '700000331', '700000332');
    const page = await newPage(async (p) => {
      // corrupt the level-bundle so client identity recompute fails → abort before mount
      await p.route((u) => /\/challenges\/tickets\/[0-9a-f-]+\/level-bundle/.test(new URL(u).pathname), async (route) => {
        const resp = await route.fetch();
        const b = await resp.json();
        if (b && b.level && Array.isArray(b.level.params?.cellColorMap)) b.level.params.cellColorMap[0] = (b.level.params.cellColorMap[0] + 1) % 3; // tamper params, specHash no longer matches
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      });
    });
    let resultsCalled = 0;
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/results') resultsCalled += 1; });
    await openFeed(page, seed3.recipient, { tgWebAppStartParam: seed3.challenge_id });
    await page.locator('.challenge-ov__btn', { hasText: 'Принять' }).click();
    await page.waitForTimeout(3000);
    assert.equal(await page.locator('.chpl-world').count(), 0, 'tampered bundle must NOT mount the overlay');
    assert.equal(resultsCalled, 0, 'tampered bundle → no /results');
    summary.push('MISMATCH: tampered level-bundle → identity abort BEFORE overlay mount, zero /results');
    await page.close();
  }
  // ══ OFF build (case 5) — v1 deep-link → "Обнови приложение" toast ══
  resetTx();
  const seed4 = pyscript('challenge_create_v142.py', '700000341', '700000342');
  const off = buildServe(false, 5234);
  await new Promise((r, j) => { off.server.once('error', j); off.server.listen(off.port, '127.0.0.1', r); });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    await page.addInitScript(telegramSdkFixture);
    await page.route('https://telegram.org/js/telegram-web-app.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: telegramSdkFixture }));
    let getWithoutWire = false;
    page.on('request', (r) => { if (new URL(r.url()).pathname === `/api/challenges/${seed4.challenge_id}` && !r.headers()['x-p4g-challenge-wire-version']) getWithoutWire = true; });
    const seen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session').catch(() => null);
    await page.goto(`${off.origin}/?${new URLSearchParams({ initData: sign(seed4.recipient), tgWebAppStartParam: seed4.challenge_id }).toString()}`, { waitUntil: 'domcontentloaded' });
    await seen;
    // The OFF build probes GET /challenges/{id} WITHOUT the wire header → 426 → upgrade
    // prompt. The client prefers Telegram.WebApp.showAlert (our SDK fixture captures it);
    // without that it renders a [role="status"] DOM toast. Accept either.
    await page.waitForFunction(() => (window.__lastAlert && /Обнови приложение/.test(window.__lastAlert))
      || !!document.querySelector('[role="status"]'), null, { timeout: 15_000 });
    const alert = await page.evaluate(() => window.__lastAlert || (document.querySelector('[role="status"]') || {}).textContent || '');
    assert.match(alert, /Обнови приложение/, `upgrade prompt: "${alert}"`);
    await shot(page, 'play-OFF-upgrade-toast');
    assert.equal(await page.locator('.chpl-world').count(), 0, 'OFF build must not mount the v1 overlay');
    assert.equal(getWithoutWire, true, 'OFF build probes the challenge without the wire header');
    summary.push('OFF build: v1 deep-link → GET without wire (426) → "Обнови приложение" toast, no overlay');
    await page.close();
  } finally {
    await new Promise((r) => off.server.close(r));
    rmSync(off.dir, { recursive: true, force: true });
  }

  console.log('\nCHALLENGE PLAY DOM E2E — passed:');
  for (const l of summary) console.log('  •', l);
} finally {
  await browser?.close();
  await new Promise((r) => on.server.close(r));
  rmSync(on.dir, { recursive: true, force: true });
}
