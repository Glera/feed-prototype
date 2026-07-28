/**
 * Owner activity notifications ("someone played mine") against the real
 * production Feed build and a stubbed /api/island/activity.
 *
 * Session start (unchanged contract): a missing local cursor is a BASELINE read
 * — historical claims are never replayed — and a reopen resumes from the
 * persisted watermark.
 *
 * Live in-session behaviour (the same feed, read on a light poll):
 *   а. a claim landing in the background surfaces within one poll, with the "!"
 *      on the island tab;
 *   б/в. everything inside the 2-minute window is coalesced into ONE toast, and
 *      the next toast cannot appear before that window is over;
 *   г. claims that land while the player is inside a mechanic wait for the
 *      return to browse;
 *   д. a fresh session never re-toasts what was already shown;
 *   е. human and bot facts stay visibly distinct in a coalesced line;
 *   ж. tapping the toast opens the player's island.
 *
 * Time is virtualised with Playwright's clock so the 75s poll and the 2-minute
 * rate limit are exercised in seconds.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'island-real-activity-'));
const shotDir = process.env.ACTIVITY_SHOT_DIR || mkdtempSync(path.join(tmpdir(), 'island-activity-shots-'));
const port = 5248;
const origin = `http://127.0.0.1:${port}`;

const build = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, VITE_ISLAND_ENABLED: '1' },
  timeout: 180_000,
});
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin);
  if (url.pathname === '/versions.json') {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(readFileSync(path.join(buildRoot, 'index.html')));
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const telegramSdk = `
window.Telegram={WebApp:{
  initData:'signed',initDataUnsafe:{user:{id:42}},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},
  setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
  HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
  openTelegramLink(){},close(){}
}};`;

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const activityRequests = [];
  let emitNewActivity = false;
  // Live phase: a mutable claim log with the real cursor semantics.
  let liveMode = false;
  let giftsPending = false;
  const live = { events: [], nextSeq: 12 };
  const addClaim = (name, isBot = false) => {
    live.nextSeq += 1;
    live.events.push({
      claim_id: `c0000000-0000-4000-8000-${String(live.nextSeq).padStart(12, '0')}`,
      seq: live.nextSeq,
      occurred_at: new Date().toISOString(),
      source: isBot ? 'bot' : 'human',
      actor: { id: isBot ? 900000000000001 : 7, name, is_bot: isBot },
      building: { id: 'b0000000-0000-4000-8000-000000000001', name: 'Neon City' },
    });
    giftsPending = true;   // a claim is exactly what puts something on the island
  };
  const islandState = () => ({
    state: {
      tokens: 0,
      buildings: [{
        slot: 1,
        tpl: 'sort',
        pack: 'neon',
        name: 'Neon City',
        plays: 3,
        likes: 1,
        liked: false,
        buildingId: 'b0000000-0000-4000-8000-000000000001',
        rel: 'a/b.html',
        contentDigest: 'sha256:deadbeef',
        stage: 3,
        foreign_claims: 3,
        pending_gifts: giftsPending ? 1 : 0,
      }],
    },
    revision: 1,
    schema_version: 5,
    updated_at: new Date().toISOString(),
  });
  await context.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));
  await context.route('**/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    });
    if (url.pathname === '/api/session') {
      return json({
        user: { id: 42, ref_code: 'activity', first_name: 'Owner' },
        ref_code: 'activity',
        balance: 0,
        puzzles: 0,
        is_new: false,
      });
    }
    if (url.pathname === '/api/island/activity') {
      assert.equal(request.method(), 'GET');
      const afterSeq = url.searchParams.get('after_seq');
      activityRequests.push(afterSeq);
      if (liveMode) {
        const high = live.events.reduce((max, event) => Math.max(max, event.seq), 12);
        // Missing cursor → high-water mark only, exactly like the server.
        if (afterSeq === null) return json({ schema: 'island.activity.v1', cursor: high, events: [] });
        const after = Number(afterSeq);
        return json({
          schema: 'island.activity.v1',
          cursor: Math.max(after, high),
          events: live.events.filter((event) => event.seq > after),
        });
      }
      if (!emitNewActivity) {
        assert.equal(afterSeq, null, 'first activity read must bootstrap without a cursor');
        return json({ schema: 'island.activity.v1', cursor: 10, events: [] });
      }
      assert.equal(afterSeq, '10', 'reopen did not resume from the persisted server cursor');
      return json({
        schema: 'island.activity.v1',
        cursor: 12,
        events: [
          {
            claim_id: 'a0000000-0000-4000-8000-000000000001',
            seq: 11,
            occurred_at: '2026-07-26T20:00:00Z',
            source: 'human',
            actor: { id: 7, name: 'Анна', is_bot: false },
            building: { id: 'b0000000-0000-4000-8000-000000000001', name: 'Neon City' },
          },
          {
            claim_id: 'a0000000-0000-4000-8000-000000000002',
            seq: 12,
            occurred_at: '2026-07-26T20:00:01Z',
            source: 'bot',
            actor: { id: 900000000000001, name: 'Луна', is_bot: true },
            building: { id: 'b0000000-0000-4000-8000-000000000001', name: 'Neon City' },
          },
        ],
      });
    }
    if (url.pathname === '/api/challenges' && request.method() === 'GET') return json([]);
    if (url.pathname === '/api/events') return json({ accepted: 0 });
    if (url.pathname === '/api/daily') return json({ day: '2026-07-26', tasks: [] });
    if (url.pathname === '/api/daily/sync') {
      return json({
        day: '2026-07-26',
        reset_at: new Date(Date.now() + 3_600_000).toISOString(),
        seconds_remaining: 3600,
        puzzle_balance: 0,
        quests: [],
      });
    }
    if (url.pathname === '/api/island/friends') return json([]);
    if (url.pathname === '/api/island/state') return json(islandState());
    return json({ detail: 'fixture unavailable' }, 404);
  });

  const first = await context.newPage();
  await first.goto(`${origin}/?initData=activity-browser`, { waitUntil: 'domcontentloaded' });
  await first.waitForFunction(() =>
    localStorage.getItem('island-activity-cursor-v1:42') === '10');
  assert.equal(await first.locator('.activity-toast').count(), 0,
    'cursor bootstrap replayed historical activity');
  await first.close();

  emitNewActivity = true;
  const reopened = await context.newPage();
  await reopened.goto(`${origin}/?initData=activity-browser`, { waitUntil: 'domcontentloaded' });
  const toast = reopened.locator('.activity-toast');
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  // One batch → ONE line. The human leads it and the bot stays visibly a bot.
  assert.match(
    await toast.textContent(),
    /👤 Анна сыграл\(а\) в твои механики · 🤖 1/,
    'a mixed batch is one coalesced line with the bot counted apart',
  );
  await reopened.waitForTimeout(1200);
  assert.equal(
    await reopened.evaluate(() => document.querySelectorAll('.activity-toast').length),
    1,
    'a coalesced batch must not queue a second toast',
  );
  assert.equal(
    await reopened.evaluate(() => localStorage.getItem('island-activity-cursor-v1:42')),
    '12',
    'the watermark records what was SHOWN',
  );
  assert.deepEqual(activityRequests, [null, '10']);
  await reopened.close();

  // ── live session: poll, coalescing, rate limit, interception, tap ─────────
  liveMode = true;
  const page = await context.newPage();
  // Record every toast the session ever shows (text at the moment it is shown).
  await page.addInitScript(`
    window.__toasts = [];
    new MutationObserver(() => {
      const el = document.querySelector('.activity-toast');
      if (!el || !el.classList.contains('activity-toast--show')) return;
      const text = (el.textContent || '').trim();
      if (!text) return;
      if (window.__toasts[window.__toasts.length - 1] !== text) window.__toasts.push(text);
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });`);
  await page.clock.install();
  await page.clock.resume();
  await page.goto(`${origin}/?initData=activity-live`, { waitUntil: 'domcontentloaded' });
  const toasts = () => page.evaluate(() => window.__toasts.slice());
  const metaAlert = page.locator('[data-bar-tab="meta"] .feed-bar__daily-alert');
  // Time skips fire the app's own timers; the short real wait lets the resulting
  // fetch/промises settle before the next assertion.
  const advance = async (ms) => { await page.clock.fastForward(ms); await page.waitForTimeout(700); };
  await page.waitForFunction(() =>
    localStorage.getItem('island-activity-cursor-v1:42') === '12', null, { timeout: 15_000 });
  assert.deepEqual(await toasts(), [], 'a quiet session start says nothing');

  // а. a claim in the background is surfaced by the light poll, with the badge.
  addClaim('Ника');
  await advance(80_000);
  await page.locator('.activity-toast--show').waitFor({ state: 'visible', timeout: 10_000 });
  assert.deepEqual(
    await toasts(),
    ['👤 Ника — новое прохождение «Neon City»'],
    'а: a single live claim reads exactly like the session-start message',
  );
  await metaAlert.waitFor({ state: 'visible', timeout: 10_000 });   // а: the "!" lights up
  await page.screenshot({ path: path.join(shotDir, 'activity-toast-single.png') });

  // б/в. four more claims inside the window → ONE toast, and not before 2 minutes.
  addClaim('Пётр');
  addClaim('Оля');
  addClaim('Ким');
  addClaim('Женя');
  await advance(80_000);            // the poll reads them…
  assert.equal((await toasts()).length, 1, 'в: no second toast inside the 2-minute window');
  await advance(45_000);            // …and the window opens at ~125s
  const coalesced = await toasts();
  assert.equal(coalesced.length, 2, `б: exactly one more toast (${JSON.stringify(coalesced)})`);
  assert.equal(
    coalesced[1],
    '👤 Женя и ещё 3 сыграли в твои механики',
    'б: four claims coalesce into one line led by the freshest human',
  );
  await page.screenshot({ path: path.join(shotDir, 'activity-toast-coalesced.png') });

  // г. claims that land while the player is inside a mechanic wait for browse.
  await page.evaluate(() => window.__feedHostGesture());
  await page.waitForFunction(() => Boolean(document.querySelector('.game--manual')), null, { timeout: 10_000 });
  addClaim('Марта');
  await advance(80_000);
  await advance(80_000);            // well past the rate-limit window
  assert.equal((await toasts()).length, 2, 'г: nothing is shown over an intercepted mechanic');
  await page.locator('.game--manual .game__close').first().dispatchEvent('click');
  await page.waitForTimeout(900);
  const afterBrowse = await toasts();
  assert.equal(afterBrowse.length, 3, `г: the held claim arrives on return to browse (${JSON.stringify(afterBrowse)})`);
  assert.equal(afterBrowse[2], '👤 Марта — новое прохождение «Neon City»');

  // е. a bots-only batch is explicitly a bot batch.
  addClaim('Луна', true);
  addClaim('Веста', true);
  await advance(130_000);
  const botBatch = await toasts();
  assert.equal(botBatch.length, 4, `е: the bot batch is shown (${JSON.stringify(botBatch)})`);
  assert.equal(
    botBatch[3],
    '🤖 Веста и ещё 1 сыграли в твои механики',
    'е: a bots-only batch never borrows a human face',
  );

  // ж. tapping the toast opens the player's own island.
  await page.locator('.activity-toast--show').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('.activity-toast').click();
  await page.locator('.island-world').waitFor({ state: 'attached', timeout: 10_000 });
  assert.equal(
    await page.locator('.island-world.island-world--guest').count(),
    0,
    'ж: the toast opens the OWN island',
  );
  const shownThrough = await page.evaluate(() => localStorage.getItem('island-activity-cursor-v1:42'));
  assert.equal(shownThrough, String(live.nextSeq), 'the watermark ends at the last SHOWN claim');
  await page.close();

  // д. a fresh session does not repeat what was already shown.
  const relaunched = await context.newPage();
  await relaunched.addInitScript('window.__toasts = [];');
  await relaunched.clock.install();
  await relaunched.clock.resume();
  await relaunched.goto(`${origin}/?initData=activity-live`, { waitUntil: 'domcontentloaded' });
  await relaunched.clock.fastForward(90_000);
  await relaunched.waitForTimeout(1200);
  assert.equal(
    await relaunched.locator('.activity-toast--show').count(),
    0,
    'д: a re-entry never repeats an already shown claim',
  );
  await relaunched.close();

  console.log(
    'island real activity browser: baseline + cursor resume + live poll toast with "!" + '
    + '2-minute coalescing/rate limit + held during interception + bot-only marking + '
    + 'tap opens the island + no repeat on re-entry verified',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
