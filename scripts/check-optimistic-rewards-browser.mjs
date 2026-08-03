/**
 * Optimistic reward proof (real production Feed build + stubbed backend).
 *
 * The claim/collect animation and the LOCAL puzzle delta must start in the same
 * tick as the tap, with the request running in parallel — the server answer is a
 * reconcile, never the trigger. Proven against a deliberately slow stub:
 *
 *   1. daily claim, server stalls 2000ms → the counter is already moving long
 *      before the response, and equals the SERVER balance once it lands;
 *   2. daily claim, server answers 409   → the optimistic reward is taken back,
 *      the quest becomes claimable again and an honest line is shown;
 *   3. daily claim, response lost (503)  → the optimistic state stays and the
 *      idempotent claim is retried in the background;
 *   4. island collect, server stalls     → the gift badge clears and the puzzles
 *      fly immediately; a smaller server grant (daily_cap) is reconciled down,
 *      and the idempotent claim id is written under the USER-SCOPED key while a
 *      legacy device-wide map (possibly another account's) is left untouched.
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
const buildRoot = mkdtempSync(path.join(tmpdir(), 'optimistic-rewards-browser-'));
const port = Number(process.env.OPTIMISTIC_REWARDS_PORT || 5241);
const origin = `http://127.0.0.1:${port}`;

const build = spawnSync(
  'npx',
  ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, VITE_API_BASE: origin, VITE_ISLAND_ENABLED: '1' },
    timeout: 240_000,
  },
);
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

// Smallest valid PNG, so a friend avatar can actually load in the harness.
const AVATAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin);
  if (url.pathname === '/avatar.png') {
    response.setHeader('content-type', 'image/png');
    response.end(AVATAR_PNG);
    return;
  }
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
  initData:'',initDataUnsafe:{user:{id:79123}},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},
  setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
  HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
  showConfirm(_m,cb){cb(true);},requestWriteAccess(cb){cb(true);},
  openTelegramLink(){},close(){}
}};`;

const QUEST_ID = 'play_3';
const REWARD = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── mutable stub state ───────────────────────────────────────────────────────
const backend = {
  puzzleBalance: 10,
  claimed: false,
  claimDelayMs: 0,
  claimStatus: 200,
  claimCalls: 0,
  collectDelayMs: 0,
  collectCalls: [],
  collectPuzzles: 3,
  collectDisposition: 'granted',
  pendingGifts: 3,
};

const dailyState = () => ({
  day: '2026-07-28',
  reset_at: new Date(Date.now() + 3_600_000).toISOString(),
  seconds_remaining: 3600,
  puzzle_balance: backend.puzzleBalance,
  quests: [{
    id: QUEST_ID,
    title: 'Сыграть 3 механики',
    progress: 3,
    target: 3,
    reward_puzzles: REWARD,
    completed: true,
    claimed: backend.claimed,
  }],
});

// One friend with a real photo, one with none, one whose photo 404s.
const friends = [
  { user_id: 90001, first_name: 'Photo', username: null, photo_url: `${origin}/avatar.png`, is_bot: false, has_island: true, published_buildings: 1 },
  { user_id: 90002, first_name: 'Ника', username: null, photo_url: null, is_bot: false, has_island: true, published_buildings: 1 },
  { user_id: 90003, first_name: 'Broken', username: null, photo_url: `${origin}/missing.png`, is_bot: false, has_island: true, published_buildings: 1 },
];

const islandState = () => ({
  state: {
    tokens: 120,
    buildings: [{
      slot: 1,
      tpl: 'sort',
      pack: 'neon',
      name: 'Neon sort',
      plays: 5,
      likes: 2,
      liked: false,
      buildingId: '11111111-1111-4111-8111-111111111111',
      rel: 'a/b.html',
      contentDigest: 'sha256:deadbeef',
      stage: 3,
      foreign_claims: 3,
      pending_gifts: backend.pendingGifts,
    }],
  },
  revision: 1,
  schema_version: 5,
  updated_at: new Date().toISOString(),
});

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 760 } });
  await context.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));
  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (value) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(value),
    });
    if (url.pathname === '/api/session') {
      return json({
        user: { id: 79123, ref_code: 'opt', first_name: 'Opt' },
        ref_code: 'opt',
        balance: 0,
        puzzles: backend.puzzleBalance,
        is_new: false,
      });
    }
    if (url.pathname === '/api/daily/sync') return json(dailyState());
    if (url.pathname === '/api/daily/claim') {
      backend.claimCalls += 1;
      if (backend.claimDelayMs > 0) await sleep(backend.claimDelayMs);
      if (backend.claimStatus !== 200) {
        return route.fulfill({
          status: backend.claimStatus,
          contentType: 'application/json',
          body: '{"detail":"daily quest is not complete"}',
        });
      }
      if (!backend.claimed) {
        backend.claimed = true;
        backend.puzzleBalance += REWARD;
      }
      return json(dailyState());
    }
    if (url.pathname === '/api/island/state' && method === 'GET') return json(islandState());
    if (url.pathname === '/api/island/state' && method === 'PUT') return json(islandState());
    if (url.pathname === '/api/island/friends' && method === 'GET') return json(friends);
    const collect = url.pathname.match(/^\/api\/island\/buildings\/([^/]+)\/collect$/);
    if (collect && method === 'POST') {
      backend.collectCalls.push(request.postDataJSON());
      if (backend.collectDelayMs > 0) await sleep(backend.collectDelayMs);
      backend.pendingGifts = 0;
      return json({
        disposition: backend.collectDisposition,
        gifts: 3,
        puzzles: backend.collectPuzzles,
        pending_gifts: 0,
      });
    }
    if (url.pathname === '/api/challenges' && method === 'GET') return json([]);
    if (url.pathname === '/api/events') return json({ accepted: 0 });
    if (url.pathname === '/api/island/activity') return json({ schema: 'island.activity.v1', cursor: 0, events: [] });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"fixture unavailable"}' });
  });

  const page = await context.newPage();
  const counter = page.locator('.hud__puzzles-value');
  const openDaily = async () => {
    await page.locator('[data-bar-tab="daily"]').click();
    await page.locator('.daily-panel__claim').waitFor({ state: 'visible' });
  };
  const readCounter = async () => Number(await counter.textContent());

  // ── 1. slow server: the animation and the local delta must not wait ────────
  backend.claimDelayMs = 2000;
  await page.goto(`${origin}/?initData=optimistic-browser&helpmap=0`, { waitUntil: 'domcontentloaded' });
  await counter.waitFor({ state: 'visible' });
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 10);
  await openDaily();
  const claimButton = page.locator('.daily-panel__claim');
  const tappedAt = Date.now();
  await claimButton.click();
  // The button commits immediately — no "Начисляем" limbo while the server thinks.
  assert.equal(await claimButton.textContent(), 'Получено', 'claim must commit optimistically');
  assert.equal(await claimButton.isDisabled(), true, 'a committed claim stays disabled');
  // A second tap during the flight must not produce a second claim.
  await claimButton.click({ force: true });
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) > 10);
  const firstCreditMs = Date.now() - tappedAt;
  assert.ok(
    firstCreditMs < 1500,
    `counter must move before the ${backend.claimDelayMs}ms response (moved after ${firstCreditMs}ms)`,
  );
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 14);
  await sleep(2600);
  assert.equal(await readCounter(), 14, 'server reconcile must not double-count the reward');
  assert.equal(backend.claimCalls, 1, 'double tap must not send a second claim');
  assert.equal(backend.puzzleBalance, 14);

  // ── 2. determined refusal: the optimistic reward is taken back ─────────────
  backend.claimed = false;
  backend.puzzleBalance = 10;
  backend.claimCalls = 0;
  backend.claimDelayMs = 400;
  backend.claimStatus = 409;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 10);
  await openDaily();
  await page.locator('.daily-panel__claim').click();
  // The optimistic reward is visibly credited first (the final piece and the
  // rollback settle inside one frame, so only the intermediate pieces are
  // observable) and is then taken back to the exact server balance.
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) > 10);
  await page.waitForFunction(
    () => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 10,
    null,
    { timeout: 8000 },
  );
  await page.locator('.activity-toast--show').waitFor({ state: 'visible' });
  assert.match(await page.locator('.activity-toast').textContent(), /Задание ещё не выполнено/);
  await page.waitForFunction(
    () => document.querySelector('.daily-panel__claim')?.textContent === 'Забрать',
    null,
    { timeout: 8000 },
  );
  assert.equal(await page.locator('.daily-panel__claim').isDisabled(), false, 'a refused quest stays claimable');

  // ── 3. lost response: keep the optimistic state and retry idempotently ─────
  backend.claimCalls = 0;
  backend.claimDelayMs = 0;
  backend.claimStatus = 503;
  await page.locator('.daily-panel__claim').click();
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 14);
  await sleep(2200);
  assert.equal(await readCounter(), 14, 'a lost response must keep the optimistic reward');
  assert.ok(backend.claimCalls >= 2, `lost claim must be retried (calls=${backend.claimCalls})`);
  backend.claimStatus = 200;
  await page.waitForFunction(
    () => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 14,
    null,
    { timeout: 12_000 },
  );
  await sleep(6000);
  assert.equal(await readCounter(), 14, 'the idempotent retry must not pay a second time');
  assert.equal(backend.puzzleBalance, 14, 'the server must award exactly once across retries');

  // ── 4. island collect: instant badge clear + exact server reconcile ────────
  // A leftover device-wide claim map from BEFORE per-user scoping. Claim ids are
  // what make a repeated collect a replay of the same append-only receipt, so the
  // migration here is conservative in the other direction: the legacy map is
  // never mutated or wholesale-copied (other accounts may still owe a replay).
  const COLLECT_CLAIM_KEY = 'island-collect-claims-v1';
  const SCOPED_COLLECT_CLAIM_KEY = `${COLLECT_CLAIM_KEY}:79123`;
  const FOREIGN_CLAIMS = { 'ffffffff-ffff-4fff-8fff-ffffffffffff': 'someone-elses-claim' };
  await page.evaluate(
    ([key, value]) => localStorage.setItem(key, JSON.stringify(value)),
    [COLLECT_CLAIM_KEY, FOREIGN_CLAIMS],
  );
  backend.collectDelayMs = 1500;
  backend.collectDisposition = 'daily_cap';
  backend.collectPuzzles = 0;          // capped: the server grants nothing
  backend.pendingGifts = 3;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Number(document.querySelector('.hud__puzzles-value')?.textContent) === 14);
  // The island tab carries the same "!" as daily while gifts are waiting there.
  const islandAlert = page.locator('[data-bar-tab="meta"] .feed-bar__daily-alert');
  await islandAlert.waitFor({ state: 'visible', timeout: 15_000 });
  assert.match(
    await page.locator('[data-bar-tab="meta"]').getAttribute('class'),
    /feed-bar__icon--attention/,
    'island tab must read as needing attention while gifts wait',
  );
  await page.locator('[data-bar-tab="meta"]').click();
  const gift = page.locator('.isl-puz[data-collect]');
  await gift.waitFor({ state: 'visible', timeout: 15_000 });
  const beforeCollect = await readCounter();
  // The gift puck bobs forever, so it never satisfies Playwright's stability
  // check — dispatch the same click the tap handler listens for.
  await gift.dispatchEvent('click');
  // The gift puck is gone and the puzzles are flying before the server answers.
  await gift.waitFor({ state: 'detached', timeout: 1200 });
  await page.waitForFunction(
    (base) => Number(document.querySelector('.hud__puzzles-value')?.textContent) > base,
    beforeCollect,
    { timeout: 1400 },
  );
  assert.equal(backend.collectCalls.length, 1, 'exactly one collect claim');
  await page.waitForFunction(
    (base) => Number(document.querySelector('.hud__puzzles-value')?.textContent) === base,
    beforeCollect,
    { timeout: 12_000 },
  );
  await sleep(800);
  assert.equal(
    await readCounter(),
    beforeCollect,
    'a capped collect must be reconciled back to the server amount',
  );
  // Nothing left to collect — the badge must clear without another request.
  await islandAlert.waitFor({ state: 'hidden', timeout: 8000 });

  // The claim id was filed under THIS user's key; the legacy device-wide map is
  // byte-identical to what it was before the collect.
  const claimStorage = await page.evaluate(
    ([scoped, legacy]) => ({
      scoped: localStorage.getItem(scoped),
      legacy: localStorage.getItem(legacy),
    }),
    [SCOPED_COLLECT_CLAIM_KEY, COLLECT_CLAIM_KEY],
  );
  assert.notEqual(claimStorage.scoped, null, 'the collect claim id must be stored under the user-scoped key');
  assert.deepEqual(
    JSON.parse(claimStorage.legacy),
    FOREIGN_CLAIMS,
    'a legacy device-wide claim map must be left untouched, never adopted or cleared',
  );

  // ── 5. friend avatars: a letter is a placeholder, never a photo overlay ────
  await page.locator('[data-bar-tab="feed"]').click();
  await page.locator('.island-world').waitFor({ state: 'detached', timeout: 8000 });
  const withPhoto = page.locator('.isln-friends [data-friend-visit="90001"]');
  const noPhoto = page.locator('.isln-friends [data-friend-visit="90002"]');
  const brokenPhoto = page.locator('.isln-friends [data-friend-visit="90003"]');
  await withPhoto.waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await withPhoto.locator('img').count(), 1, 'a real photo must render');
  assert.equal(
    await withPhoto.locator('.isln-friend__initial').count(),
    0,
    'the initial must not be drawn over a real photo',
  );
  assert.equal((await withPhoto.textContent()).trim(), '', 'no letter over the photo');
  assert.equal(await noPhoto.locator('img').count(), 0);
  assert.equal(
    (await noPhoto.locator('.isln-friend__initial').textContent()).trim(),
    'Н',
    'a friend without a photo keeps the initial placeholder',
  );
  await brokenPhoto.locator('.isln-friend__initial').waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(
    (await brokenPhoto.locator('.isln-friend__initial').textContent()).trim(),
    'B',
    'a failed photo falls back to the initial placeholder',
  );
  assert.equal(await brokenPhoto.locator('img').count(), 0);

  console.log('optimistic rewards browser: instant daily claim + honest refusal rollback + idempotent retry + island collect reconcile + user-scoped claim id with untouched legacy map + island nav badge + avatar placeholder verified');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
