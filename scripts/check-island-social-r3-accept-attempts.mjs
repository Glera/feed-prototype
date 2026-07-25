// Island Social Core — Codex R3 evidence (R2-F002): friend-accept attempt cap
// PERSISTS across app reopens under a transient 5xx.
//
// The f_<code> start param survives reopen and runs persistPendingFriendAccept on
// every boot; for the SAME code the accumulated attempt count must be preserved
// (not reset), so a stuck 5xx stops after the bounded cap (5) instead of retrying
// forever; a NEW code resets to 0; a definitive outcome clears the key.
//
// Real client build (VITE_ISLAND_ENABLED=1) with signed initData; /friends/accept
// is stubbed to a transient 503 so we exercise the retry-cap without a real edge.
// localStorage is asserted across reopens (same page context) + DB fact (no
// friendship created while every accept 503s).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const PORT = 5214;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = 'island-pending-friend-accept-v1';
const CAP = 5;
const GUEST = 700000031; // fresh, not used elsewhere
const CODE1 = 'STUCK5XXAA';
const CODE2 = 'NEWCODEBB1';

function signInitData(userId, firstName, username, startParam) {
  const user = { id: userId, first_name: firstName, username, photo_url: `https://t.me/i/userpic/320/${userId}.jpg` };
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
    env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL, ENABLE_ISLAND_SOCIAL: '1', BOT_TOKEN, DEV_USER_IDS: '700000001' },
    timeout: 60_000,
  });
  if (res.status !== 0) throw new Error(`${script} failed: ${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}
const dbq = (sql) => JSON.parse(py('dbq.py', [sql]));

const buildRoot = mkdtempSync(path.join(tmpdir(), 'r3-accept-'));
const build = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'],
  { cwd: root, encoding: 'utf8', env: { ...process.env, VITE_API_BASE: API_ORIGIN, VITE_ISLAND_ENABLED: '1', VITE_UGC_BASE_URL: ORIGIN }, timeout: 180_000 });
assert.equal(build.status, 0, `build failed: ${build.stdout}\n${build.stderr}`);

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', ORIGIN);
  if (url.pathname === '/versions.json') { res.setHeader('content-type', 'application/json'); return res.end('{}'); }
  if (url.pathname === '/' || url.pathname === '/index.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(readFileSync(path.join(buildRoot, 'index.html'))); }
  res.statusCode = 404; res.end();
});
await new Promise((r, j) => { server.once('error', j); server.listen(PORT, '127.0.0.1', r); });
const telegramSdkFixture = `window.Telegram={WebApp:{initData:'',initDataUnsafe:{},platform:'web',ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},close(){}}};`;

let browser = null;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 760 } });
  await context.route('https://telegram.org/js/telegram-web-app.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: telegramSdkFixture }));
  // Stub the accept endpoint to a TRANSIENT 503 for the whole run.
  let acceptCount = 0;
  await context.route('**/api/island/friends/accept', (r) => { acceptCount += 1; return r.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"transient upstream"}' }); });
  const page = await context.newPage();
  const readLS = () => page.evaluate((k) => localStorage.getItem(k), KEY);

  // One "boot" = a fresh navigation carrying f_<code>; localStorage persists in
  // this context so the attempt counter accumulates across boots.
  const boot = async (code) => {
    const before = acceptCount;
    const sessionSeen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session' && r.request().method() === 'POST').catch(() => null);
    await page.goto(`${ORIGIN}/?${new URLSearchParams({ initData: signInitData(GUEST, 'Retrier', 'retrier', `f_${code}`), tgWebAppStartParam: `f_${code}` }).toString()}`, { waitUntil: 'domcontentloaded' });
    await sessionSeen;
    await page.waitForTimeout(1500); // allow the post-bootstrap accept attempt to run (or prove it did not)
    return acceptCount - before;
  };

  // Boots 1..5 with the SAME code → attempts accumulate 1..5 (not reset per boot).
  for (let i = 1; i <= CAP; i += 1) {
    const calls = await boot(CODE1);
    assert.equal(calls, 1, `boot ${i}: expected exactly one accept attempt, got ${calls}`);
    const ls = JSON.parse(await readLS());
    assert.equal(ls && ls.code, CODE1, `boot ${i}: code should persist`);
    assert.equal(ls.attempts, i, `boot ${i}: attempts must accumulate to ${i} (got ${ls.attempts}) — not reset on reopen`);
  }

  // Boot 6 with the same code: cap reached → NO further accept, key cleared.
  const capCalls = await boot(CODE1, { expectAccept: false });
  assert.equal(capCalls, 0, `after cap ${CAP}, no further accept attempt must fire (got ${capCalls})`);
  assert.equal(await readLS(), null, 'reaching the cap must clear the pending-accept key');

  // A NEW code resets the counter to a fresh bounded sequence (attempts back to 1).
  const newCalls = await boot(CODE2);
  assert.equal(newCalls, 1, 'a new code triggers a fresh accept attempt');
  const ls2 = JSON.parse(await readLS());
  assert.equal(ls2.code, CODE2, 'new code is persisted');
  assert.equal(ls2.attempts, 1, `a NEW code resets attempts to 1 (got ${ls2.attempts})`);

  // DB fact: every accept 503'd, so NO friendship was created for this guest.
  const fr = dbq(`SELECT count(*) FROM island_friendships WHERE user_lo=${GUEST} OR user_hi=${GUEST}`)[0][0];
  assert.equal(Number(fr), 0, `no friendship must exist while every accept is 5xx (got ${fr})`);

  console.log('\nISLAND SOCIAL R3 EVIDENCE (R2-F002 accept attempts) — passed:');
  console.log(`  • same code: attempts persisted 1→${CAP} across reopens (transient 503), not reset`);
  console.log(`  • cap ${CAP} reached → no further accept, pending key cleared`);
  console.log('  • new code → attempts reset to 1');
  console.log(`  • DB: 0 friendships created (accept={acceptCount:${acceptCount}} all 503)`);
} finally {
  await browser?.close();
  await new Promise((r) => server.close(r));
  rmSync(buildRoot, { recursive: true, force: true });
}
