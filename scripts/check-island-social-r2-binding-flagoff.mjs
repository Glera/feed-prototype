// Island Social Core — Codex R2 diff-only evidence: F002 builtin binding
// authority + fail-closed (point 4) and F005 flag-off inert surface (point 3).
// v1.4 §3.1 addendum (Codex R3): point 4c proves the documented semantics —
// rotating the mechanic's DEPLOY bytes under an UNCHANGED binding keeps the house
// working on the current deploy (no digest pin / no byte-compare); a mechanicId
// gone from the platform set fails closed (4b).
// Real client builds ↔ real backend ↔ real PG (same pattern as
// check-island-social-browser.mjs). Env: BOT_TOKEN, API_ORIGIN, VENV_PY,
// BACKEND_ROOT, DATABASE_URL, ARTIFACT_DIR, PY_SCRATCH.
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
const PY_SCRATCH = process.env.PY_SCRATCH || path.join(root, 'scripts', 'island-e2e-support');
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(root, 'e2e-artifacts', 'island-social');
const ON_PORT = 5214;
const OFF_PORT = 5215;
mkdirSync(ARTIFACT_DIR, { recursive: true });

const OWNER = 700000002;
const GUEST = 700000003;
const FRIEND_CODE = 'E2EFRIEND1';

function signInitData(userId, firstName, username, startParam) {
  const user = { id: userId, first_name: firstName };
  if (username) user.username = username;
  user.photo_url = `https://t.me/i/userpic/320/${userId}.jpg`;
  const fields = { user: JSON.stringify(user), auth_date: String(Math.floor(Date.now() / 1000)), query_id: `AAE${userId}` };
  if (startParam) fields.start_param = startParam;
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  fields.hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(fields).toString();
}
function py(script, argv = []) {
  const res = spawnSync(VENV_PY, [path.join(PY_SCRATCH, script), ...argv], {
    cwd: BACKEND_ROOT, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL, ENABLE_ISLAND_SOCIAL: '1', ENABLE_ISLAND_BOTS: '1', BOT_TOKEN, DEV_USER_IDS: '700000001' },
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`${script} failed: ${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}
const dbq = (sql) => JSON.parse(py('dbq.py', [sql]));

const fakePlayable = `<!doctype html><html><body><script>
const send=(m)=>parent.postMessage(Object.assign({source:'playable'},m),'*');
addEventListener('load',()=>{send({type:'static_ready'});setTimeout(()=>send({type:'completed',success:true}),1600);});
</script></body></html>`;
// A "deploy" of the mechanic — same behaviour, but a `data-deploy` marker so the
// test can prove which build the house actually loaded. `mechanicDeployBody` is
// the CURRENT deploy served to the mechanic iframes; point 4c rotates it.
const deployBody = (tag) => `<!doctype html><html><body data-deploy="${tag}"><script>
const send=(m)=>parent.postMessage(Object.assign({source:'playable'},m),'*');
addEventListener('load',()=>{send({type:'static_ready'});setTimeout(()=>send({type:'completed',success:true}),1600);});
</script></body></html>`;
let mechanicDeployBody = deployBody('v1');
const telegramSdkFixture = `window.Telegram={WebApp:{initData:'',initDataUnsafe:{},platform:'web',ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},close(){}}};`;

function buildInto(dir, islandEnabled, staticOrigin) {
  const env = { ...process.env, VITE_API_BASE: API_ORIGIN, VITE_UGC_BASE_URL: staticOrigin };
  if (islandEnabled) env.VITE_ISLAND_ENABLED = '1'; else delete env.VITE_ISLAND_ENABLED;
  const b = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', dir, '--emptyOutDir'],
    { cwd: root, encoding: 'utf8', env, timeout: 180_000 });
  assert.equal(b.status, 0, `build failed: ${b.stdout}\n${b.stderr}`);
}
function serve(dir, port) {
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', origin);
    if (url.pathname === '/versions.json') { res.setHeader('content-type', 'application/json'); return res.end('{}'); }
    if (url.pathname === '/' || url.pathname === '/index.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(readFileSync(path.join(dir, 'index.html'))); }
    if (url.pathname.endsWith('.html')) { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(fakePlayable); }
    if (url.pathname.endsWith('.payload.js')) { res.setHeader('content-type', 'application/javascript'); return res.end(''); }
    res.statusCode = 404; res.end();
  });
  return { server, origin };
}

const onDir = mkdtempSync(path.join(tmpdir(), 'r2-island-on-'));
const offDir = mkdtempSync(path.join(tmpdir(), 'r2-island-off-'));
const ON_ORIGIN = `http://127.0.0.1:${ON_PORT}`;
const OFF_ORIGIN = `http://127.0.0.1:${OFF_PORT}`;
buildInto(onDir, true, ON_ORIGIN);
buildInto(offDir, false, OFF_ORIGIN);
const on = serve(onDir, ON_PORT);
const off = serve(offDir, OFF_PORT);
await new Promise((r, j) => { on.server.once('error', j); on.server.listen(ON_PORT, '127.0.0.1', r); });
await new Promise((r, j) => { off.server.once('error', j); off.server.listen(OFF_PORT, '127.0.0.1', r); });

const summary = [];
let browser = null;
try {
  browser = await chromium.launch();
  const newPage = async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    await page.route('https://telegram.org/js/telegram-web-app.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: telegramSdkFixture }));
    await page.route('**/*.html', (r) => (new URL(r.request().url()).pathname === '/' ? r.continue() : r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: mechanicDeployBody })));
    return page;
  };
  // Open a page and await the /session bootstrap (the ?island= world + deeplink
  // handling run after it), matching check-island-social-browser.mjs's openPage.
  const gotoAwaitingSession = async (page, origin, query) => {
    const sessionSeen = page.waitForResponse((r) =>
      new URL(r.url()).pathname === '/api/session' && r.request().method() === 'POST').catch(() => null);
    await page.goto(`${origin}/?${new URLSearchParams(query).toString()}`, { waitUntil: 'domcontentloaded' });
    await sessionSeen;
  };
  const shot = (p, n) => p.screenshot({ path: path.join(ARTIFACT_DIR, `${n}.png`) });

  // ══ POINT 3 — flag-off build: i_/?island=/f_ are inert ══
  {
    const acceptCalls = [];
    const page = await newPage();
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/island/friends/accept') acceptCalls.push(1); });
    const q = new URLSearchParams({ initData: signInitData(GUEST, 'IslandGuest', 'guest', `f_${FRIEND_CODE}`), island: String(OWNER), tgWebAppStartParam: `f_${FRIEND_CODE}` });
    await page.goto(`${OFF_ORIGIN}/?${q.toString()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000); // give boot + any deeplink handling time to (not) fire
    assert.equal(await page.locator('.island-world').count(), 0, 'flag-off must not mount the island world');
    assert.equal(await page.locator('.isln-friends').count(), 0, 'flag-off must not mount the friends HUD');
    assert.equal(await page.locator('button.feed-bar__icon[data-bar-tab="meta"]').count(), 0, 'flag-off must not expose the island (meta) tab');
    assert.equal(acceptCalls.length, 0, `flag-off must not call friends/accept (got ${acceptCalls.length})`);
    await shot(page, 'R2-F005-flagoff-inert');
    summary.push('POINT 3 (F005): flag-off build — no island world / friends HUD / meta tab / accept call OK');
    await page.close();
  }

  // ══ POINT 4 — builtin binding authority (F002) ══
  const b = JSON.parse(py('r2_binding_setup.py'));

  // 4a: bot A slot has tpl != builtin.mechanicId → runtime resolves from binding
  {
    const A = b.bot_a;
    const page = await newPage();
    await gotoAwaitingSession(page, ON_ORIGIN, { initData: signInitData(GUEST, 'IslandGuest', 'guest'), island: String(A.bot) });
    await page.locator('.island-world').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator(`g.isl-sector[data-b="${A.slot}"]`).waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator(`g.isl-sector[data-b="${A.slot}"]`).dispatchEvent('click');
    const chip = page.locator('.isl-play [data-dbg]');
    await chip.waitFor({ state: 'visible', timeout: 10_000 });
    // Poll the chip until the runtime resolves (it starts as "boot…").
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel); return el && /BUILTIN|UNAVAILABLE|STOCK|HOSTED/.test(el.textContent || '');
    }, '.isl-play [data-dbg]', { timeout: 10_000 });
    const label = (await chip.textContent()) || '';
    assert.match(label, new RegExp(`BUILTIN · ${A.mechanicId}`), `expected runtime from binding mechanicId="${A.mechanicId}", chip="${label}" (tpl was "${A.tpl}")`);
    assert.doesNotMatch(label, new RegExp(`STOCK · ${A.tpl}`), 'runtime must NOT fall back to the mutable tpl');
    await shot(page, 'R2-F002-binding-authority');
    summary.push(`POINT 4a (F002): bot building tpl="${A.tpl}" but runtime = "${label}" (bound by mechanicId) OK`);
    await page.close();
  }

  // 4b: unknown mechanicId → fail closed, NO visit / claim created
  {
    const B = b.bot_b;
    const page = await newPage();
    await gotoAwaitingSession(page, ON_ORIGIN, { initData: signInitData(GUEST, 'IslandGuest', 'guest'), island: String(B.bot) });
    await page.locator('.island-world').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator(`g.isl-sector[data-b="${B.slot}"]`).waitFor({ state: 'attached', timeout: 10_000 });
    await page.locator(`g.isl-sector[data-b="${B.slot}"]`).dispatchEvent('click');
    await page.locator('.isl-win__t', { hasText: 'Механика недоступна' }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(1500); // allow any (erroneous) visit to have fired
    await shot(page, 'R2-F002-fail-closed');
    const visits = dbq(`SELECT count(*) FROM island_visits WHERE owner_id=${B.bot} AND guest_id=${GUEST}`)[0][0];
    const claims = dbq(`SELECT count(*) FROM island_completion_claims WHERE owner_id=${B.bot}`)[0][0];
    assert.equal(Number(visits), 0, `fail-closed must create NO visit, found ${visits}`);
    assert.equal(Number(claims), 0, `fail-closed must create NO claim, found ${claims}`);
    summary.push('POINT 4b (F002): unknown mechanicId → "Механика недоступна", no visit/claim OK');
    await page.close();
  }

  // ══ POINT 4c — deploy rotation under an UNCHANGED binding (v1.4 §3.1) ══
  // Delivery = current deploy: rotating the mechanic's served bytes with the
  // binding unchanged must keep the house working (no digest pin / byte-compare).
  {
    const A = b.bot_a;
    const visitAndAssert = async (expectDeployTag) => {
      const page = await newPage();
      await gotoAwaitingSession(page, ON_ORIGIN, { initData: signInitData(GUEST, 'IslandGuest', 'guest'), island: String(A.bot) });
      await page.locator('.island-world').waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator(`g.isl-sector[data-b="${A.slot}"]`).waitFor({ state: 'attached', timeout: 10_000 });
      await page.locator(`g.isl-sector[data-b="${A.slot}"]`).dispatchEvent('click');
      // Runtime still resolves from the (unchanged) binding mechanicId.
      await page.waitForFunction((sel) => {
        const el = document.querySelector(sel); return el && /BUILTIN/.test(el.textContent || '');
      }, '.isl-play [data-dbg]', { timeout: 10_000 });
      const label = (await page.locator('.isl-play [data-dbg]').textContent()) || '';
      assert.match(label, new RegExp(`BUILTIN · ${A.mechanicId}`), `binding must still resolve, chip="${label}"`);
      // The house boots + reaches its win screen on the CURRENT deploy.
      await page.locator('.isl-win').waitFor({ state: 'visible', timeout: 20_000 });
      // Prove the loaded iframe IS the current deploy (rotated) build.
      const tag = await page.evaluate(() => {
        const f = document.querySelector('.isl-play iframe');
        try { return f && f.contentDocument ? f.contentDocument.body.getAttribute('data-deploy') : null; }
        catch { return 'cross-origin'; }
      });
      assert.equal(tag, expectDeployTag, `expected the ${expectDeployTag} deploy to load, got "${tag}"`);
      return page;
    };
    const before = await visitAndAssert('v1');
    await shot(before, 'R2-F002-rotation-before-v1');
    await before.close();
    mechanicDeployBody = deployBody('v2'); // rotate the deploy; binding is untouched
    const after = await visitAndAssert('v2');
    await shot(after, 'R2-F002-rotation-after-v2');
    await after.close();
    summary.push('POINT 4c (F002/v1.4): deploy bytes rotated under unchanged binding → house still resolves BUILTIN and runs on the current deploy OK');
  }

  console.log('\nISLAND SOCIAL R2 EVIDENCE (binding + flag-off) — passed:');
  for (const l of summary) console.log('  •', l);
} finally {
  await browser?.close();
  await new Promise((r) => on.server.close(r));
  await new Promise((r) => off.server.close(r));
  rmSync(onDir, { recursive: true, force: true });
  rmSync(offDir, { recursive: true, force: true });
}
