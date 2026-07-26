// Share/Challenge V1 — Codex R2 P1-4 ADVERSARIAL DOM probe (security).
//
// After the overlay reaches configured/reveal, the iframe is navigated to a
// DIFFERENT origin which then posts {type:'completed',success:true}. The overlay's
// gameplay guard must NOT accept that win (source+origin+live configured-epoch all
// required; a post-reveal re-navigation revokes the epoch). Evidence is behavioural:
// no POST /results, no `complete` challenge_event, no result screen.
//
// Second half addresses the author's concern: the LEGITIMATE runtime must NOT be
// falsely revoked — a legit fixture that never self-reloads is accepted, and the
// chpl frame is requested exactly once between mount and win.
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
const API = process.env.API_ORIGIN || 'http://127.0.0.1:5241';
const BOT_TOKEN = process.env.BOT_TOKEN || 'dev-challenge-token';
const VENV_PY = process.env.VENV_PY;
const BACKEND_ROOT = process.env.BACKEND_ROOT;
const DATABASE_URL = process.env.DATABASE_URL;
const PY_SUPPORT = path.join(HERE, 'challenge-e2e-support');
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || path.join(root, 'e2e-artifacts', 'challenge');
const APP_PORT = 5233;
const EVIL_PORT = 5235;
const APP = `http://127.0.0.1:${APP_PORT}`;
const EVIL = `http://127.0.0.1:${EVIL_PORT}`;
const CONTRACT = 'c'.repeat(64);
const ARTIFACT = 'sha256:d66b4e440358533410dd505f25b7558187df46ca5d8eea562d8648c62f2f9293';
mkdirSync(ARTIFACT_DIR, { recursive: true });

function sign(uid) {
  const user = { id: uid, first_name: `U${uid}` };
  const f = { user: JSON.stringify(user), auth_date: String(Math.floor(Date.now() / 1000)), query_id: `AAE${uid}` };
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

// Legit runtime fixture: handshake then (optionally) win. NEVER self-reloads.
const chplFixture = (win) => `<!doctype html><html><body data-legit="1"><script>
const send=(m)=>parent.postMessage(m,'*');
const C=${JSON.stringify(CONTRACT)},A=${JSON.stringify(ARTIFACT)};
addEventListener('message',(e)=>{const d=e.data||{};
  if(d.type==='configure_level'){
    send({type:'configured',appliedSpecHash:d.spec&&d.spec.specHash,runtimeContractDigest:C,runtimeArtifactDigest:A});
    ${win ? `setTimeout(()=>send({type:'completed',success:true}),900);` : ''}
  }});
addEventListener('load',()=>send({type:'configure_ready',nonce:'nonce-legit-0123456789',runtimeContractDigest:C,runtimeArtifactDigest:A}));
</script></body></html>`;
// Foreign-origin document: immediately claims a win.
const evilDoc = `<!doctype html><html><body data-evil="1"><script>
const send=(m)=>parent.postMessage(m,'*');
addEventListener('load',()=>{
  for (let k=0;k<5;k++) setTimeout(()=>{
    send({type:'completed',success:true});
    send({type:'configured',appliedSpecHash:'f'.repeat(64),runtimeContractDigest:${JSON.stringify(CONTRACT)},runtimeArtifactDigest:${JSON.stringify(ARTIFACT)}});
  }, k*200);
});
</script></body></html>`;
const tg = `window.__tgLinks=[];window.Telegram={WebApp:{initData:'',initDataUnsafe:{},platform:'web',ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},openTelegramLink(u){window.__tgLinks.push(u)},openLink(u){window.__tgLinks.push(u)},showAlert(m){window.__lastAlert=m},close(){}}};`;
const isChpl = (p) => /\/runtime-releases\/marble-sort-swipe\/[0-9a-f]{64}\/index\.html/.test(p);

const appDir = mkdtempSync(path.join(tmpdir(), 'xorig-'));
const build = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', appDir, '--emptyOutDir'], {
  cwd: root, encoding: 'utf8',
  env: { ...process.env, VITE_API_BASE: API, VITE_ISLAND_ENABLED: '1', VITE_CHALLENGE_V1_ENABLED: 'true', VITE_UGC_BASE_URL: APP },
  timeout: 180_000,
});
assert.equal(build.status, 0, `build failed: ${build.stdout}\n${build.stderr}`);

let legitWins = true;
const appServer = createServer((req, r) => {
  const u = new URL(req.url || '/', APP);
  if (u.pathname === '/versions.json') { r.setHeader('content-type', 'application/json'); return r.end('{}'); }
  if (u.pathname === '/' || u.pathname === '/index.html') { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(readFileSync(path.join(appDir, 'index.html'))); }
  if (isChpl(u.pathname)) { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end(chplFixture(legitWins)); }
  if (u.pathname.endsWith('.html')) { r.setHeader('content-type', 'text/html; charset=utf-8'); return r.end('<!doctype html><html><body></body></html>'); }
  if (u.pathname.endsWith('.payload.js')) { r.setHeader('content-type', 'application/javascript'); return r.end(''); }
  r.statusCode = 404; r.end();
});
const evilServer = createServer((req, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end(evilDoc); });
await new Promise((res, rej) => { appServer.once('error', rej); appServer.listen(APP_PORT, '127.0.0.1', res); });
await new Promise((res, rej) => { evilServer.once('error', rej); evilServer.listen(EVIL_PORT, '127.0.0.1', res); });

const summary = [];
let browser = null;
try {
  browser = await chromium.launch();
  const T = 'challenge_source_offers,challenge_spec_bindings,challenge_ticket_bindings,challenge_events,challenge_friendship_receipts,challenge_attempts,verified_runs,run_tickets,reward_ledger,puzzle_ledger,level_results,attempt_outcome_facts,attempts,challenges,challenge_specs,island_friendships,island_friend_blocks,friend_edges,usage_counters';
  const resetTx = () => py(`from sqlalchemy import text;from app.db import SessionLocal
db=SessionLocal();db.execute(text("SET session_replication_role=replica"));db.execute(text("TRUNCATE TABLE ${T} RESTART IDENTITY CASCADE"));db.commit()`);

  const openRecipient = async (seed) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
    await page.addInitScript(tg);
    await page.route('https://telegram.org/js/telegram-web-app.js', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: tg }));
    const state = { results: 0, chplLoads: 0 };
    page.on('request', (r) => {
      const p = new URL(r.url()).pathname;
      if (p === '/api/results') state.results += 1;
      if (isChpl(p)) state.chplLoads += 1;
    });
    const seen = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/session').catch(() => null);
    await page.goto(`${APP}/?${new URLSearchParams({ initData: sign(seed.recipient), tgWebAppStartParam: seed.challenge_id }).toString()}`, { waitUntil: 'domcontentloaded' });
    await seen;
    await page.locator('.challenge-ov__btn', { hasText: 'Принять' }).click();
    await page.locator('.chpl-world.chpl-world--in').waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('iframe.chpl-frame.chpl-frame--ready').waitFor({ state: 'attached', timeout: 20_000 });
    return { page, state };
  };

  // ══ A. ADVERSARIAL: post-reveal cross-origin navigation claims a win ══
  resetTx();
  legitWins = false;   // the legit fixture reaches reveal but never wins on its own
  {
    const seed = pyscript('challenge_create_v142.py', '700000701', '700000702');
    const { page, state } = await openRecipient(seed);
    // navigate the frame to a FOREIGN origin which immediately claims completed
    await page.evaluate((evil) => {
      const f = document.querySelector('iframe.chpl-frame');
      if (f) f.src = `${evil}/evil.html`;
    }, EVIL);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'xorigin-A-foreign-win-rejected.png') });
    assert.equal(state.results, 0, `foreign-origin win must NOT post /results (got ${state.results})`);
    const compl = Number(dbq(`SELECT count(*) FROM challenge_events WHERE challenge_id='${seed.challenge_id}' AND kind='complete'`)[0][0]);
    assert.equal(compl, 0, `foreign-origin win must NOT commit a complete event (got ${compl})`);
    assert.equal(await page.locator('.challenge-ov__title', { hasText: /обогнал|быстрее/ }).count(), 0, 'no result screen from a foreign win');
    summary.push('A (P1-4): post-reveal cross-origin navigation + completed → win REJECTED (0 /results, 0 complete events, no result screen)');
    await page.close();
  }

  // ══ B. LEGITIMATE runtime is NOT falsely revoked ══
  resetTx();
  legitWins = true;    // same-origin legit fixture wins normally after reveal
  {
    const seed = pyscript('challenge_create_v142.py', '700000711', '700000712');
    const { page, state } = await openRecipient(seed);
    const completeResp = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/challenges/${seed.challenge_id}/complete`, { timeout: 25_000 });
    await completeResp;
    await page.locator('.challenge-ov__title', { hasText: /обогнал|быстрее/ }).waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'xorigin-B-legit-accepted.png') });
    const compl = Number(dbq(`SELECT count(*) FROM challenge_events WHERE challenge_id='${seed.challenge_id}' AND kind='complete'`)[0][0]);
    assert.equal(compl, 1, `legit win must commit exactly one complete event (got ${compl})`);
    assert.equal(state.results, 1, `legit win posts exactly one /results (got ${state.results})`);
    assert.equal(state.chplLoads, 1, `the legit runtime must be fetched exactly once — no self-reload after reveal (got ${state.chplLoads})`);
    summary.push(`B (no false revoke): legit same-origin runtime → win ACCEPTED (1 /results, 1 complete), chpl frame fetched exactly once (no self-reload)`);
    await page.close();
  }

  console.log('\nCHALLENGE X-ORIGIN DOM PROBE — passed:');
  for (const l of summary) console.log('  •', l);
} finally {
  await browser?.close();
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => evilServer.close(r));
  rmSync(appDir, { recursive: true, force: true });
}
