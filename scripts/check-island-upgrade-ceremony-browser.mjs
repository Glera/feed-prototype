/**
 * Island house-upgrade ceremony proof (real production Feed build + stubbed backend).
 *
 * The server upgrades a house the instant a guest completion claim lands; the
 * ceremony is the OWNER-facing delivery of that fact, gated by the client
 * watermark `island-celebrated-stages-v1`. Proven end to end:
 *
 *   а. first entry with non-zero stages → NO ceremony, watermark initialised;
 *   б. stage +1 → entry plays exactly ONE ceremony with confetti, watermark advanced;
 *   в. stage +3 → ONE ceremony carrying the «×3» badge (never three scenes);
 *   г. two houses grew → a queue of two, ordered by slot;
 *   д. a tap skips the current scene and fast-forwards the rest; watermark advanced;
 *   е. a repeat entry with no growth is silent;
 *   ж. the island tab "!" lights for a pending upgrade and clears once celebrated;
 *   к. a scene killed halfway REPLAYS on the next entry (a silent level-up is the
 *      failure mode this feature exists to prevent), while houses celebrated
 *      before it are never replayed;
 *   и. growth landing while the owner is on the island celebrates without a
 *      re-entry, but never on top of an open building card;
 *   з. a building the server no longer returns leaves the watermark silently.
 *
 * Screenshots (scene = confetti + plaque) go to $CEREMONY_SHOT_DIR when set.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'island-upgrade-ceremony-'));
const port = 5247;
const origin = `http://127.0.0.1:${port}`;
const shotDir = process.env.CEREMONY_SHOT_DIR || '';
if (shotDir) mkdirSync(shotDir, { recursive: true });

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
  initData:'',initDataUnsafe:{user:{id:79124}},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},
  setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
  HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
  showConfirm(_m,cb){cb(true);},requestWriteAccess(cb){cb(true);},
  openTelegramLink(){},close(){}
}};`;

const WATERMARK_KEY = 'island-celebrated-stages-v1';
const HOUSE_A = '11111111-1111-4111-8111-111111111111';   // slot 2
const HOUSE_B = '22222222-2222-4222-8222-222222222222';   // slot 1
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── mutable stub state: the SERVER stage is the only source of growth ────────
const backend = {
  houses: [
    { buildingId: HOUSE_A, slot: 2, name: 'Neon sort', stage: 3 },
    { buildingId: HOUSE_B, slot: 1, name: 'Pins pond', stage: 2 },
  ],
  revision: 1,
};
const setStage = (buildingId, stage) => {
  const house = backend.houses.find((h) => h.buildingId === buildingId);
  house.stage = stage;
  backend.revision += 1;
};
const dropHouse = (buildingId) => {
  backend.houses = backend.houses.filter((h) => h.buildingId !== buildingId);
  backend.revision += 1;
};

const islandState = () => ({
  state: {
    tokens: 120,
    buildings: backend.houses.map((house) => ({
      slot: house.slot,
      tpl: 'sort',
      pack: 'neon',
      name: house.name,
      plays: 5,
      likes: 2,
      liked: false,
      buildingId: house.buildingId,
      rel: `a/${house.slot}.html`,
      contentDigest: 'sha256:deadbeef',
      stage: house.stage,
      foreign_claims: house.stage,
      pending_gifts: 0,          // gifts stay at zero: the badge under test is upgrades
    })),
  },
  revision: backend.revision,
  schema_version: 5,
  updated_at: new Date().toISOString(),
});

// Records every ceremony scene the DOM ever shows, with its final plaque text.
const ceremonyProbe = `
window.__ceremonies = [];
window.__confetti = 0;
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.classList && node.classList.contains('confetti')) { window.__confetti += 1; continue; }
      if (!node.classList || !node.classList.contains('isl-upgrade')) continue;
      const scene = { slot: node.getAttribute('data-upgrade'), text: '', openedAt: Date.now(), closedAt: 0 };
      window.__ceremonies.push(scene);
      const inner = new MutationObserver(() => {
        const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text) scene.text = text;
        if (!node.isConnected) { scene.closedAt = scene.closedAt || Date.now(); inner.disconnect(); }
      });
      inner.observe(document, { childList: true, subtree: true });
    }
  }
}).observe(document, { childList: true, subtree: true });`;

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
        user: { id: 79124, ref_code: 'cer', first_name: 'Cer' },
        ref_code: 'cer',
        balance: 0,
        puzzles: 10,
        is_new: false,
      });
    }
    if (url.pathname === '/api/daily/sync') {
      return json({
        day: '2026-07-28',
        reset_at: new Date(Date.now() + 3_600_000).toISOString(),
        seconds_remaining: 3600,
        puzzle_balance: 10,
        quests: [],
      });
    }
    // The client may push its own snapshot back; the SERVER answer is always the
    // authority, so a PUT can never invent or erase a stage.
    if (url.pathname === '/api/island/state') return json(islandState());
    if (url.pathname === '/api/island/friends') return json([]);
    if (url.pathname === '/api/island/activity') return json({ schema: 'island.activity.v1', cursor: 0, events: [] });
    if (url.pathname === '/api/challenges' && method === 'GET') return json([]);
    if (url.pathname === '/api/events') return json({ accepted: 0 });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"fixture unavailable"}' });
  });

  const page = await context.newPage();
  await page.addInitScript(ceremonyProbe);

  const metaTab = page.locator('[data-bar-tab="meta"]');
  const islandAlert = page.locator('[data-bar-tab="meta"] .feed-bar__daily-alert');
  const watermark = () => page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) || 'null'),
    WATERMARK_KEY,
  );
  const scenes = () => page.evaluate(() => window.__ceremonies.map((scene) => ({ ...scene })));
  const confetti = () => page.evaluate(() => window.__confetti);

  /** A fresh entry: reload the app, wait for the badge probe, open the island. */
  const enterIsland = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await metaTab.waitFor({ state: 'visible', timeout: 20_000 });
    await sleep(600);                       // let the lazy /island/state badge probe settle
  };
  const openIsland = async () => {
    await metaTab.click();
    await page.locator('.island-world svg [data-b]').first().waitFor({ state: 'attached', timeout: 20_000 });
  };
  /** Wait until the ceremony queue has drained (no scene open, none pending). */
  const settle = async (ms = 2600) => sleep(ms);

  // ── а. first entry: non-zero stages must NOT celebrate history ─────────────
  await page.goto(`${origin}/?initData=ceremony-browser`, { waitUntil: 'domcontentloaded' });
  await metaTab.waitFor({ state: 'visible', timeout: 20_000 });
  await sleep(600);
  assert.equal(await islandAlert.isVisible(), false, 'а: an unknown house must not light the "!" badge');
  await openIsland();
  await settle();
  assert.deepEqual(await scenes(), [], 'а: a first entry must never celebrate historical growth');
  assert.deepEqual(await watermark(), { [HOUSE_A]: 3, [HOUSE_B]: 2 }, 'а: watermark initialised at the current stages');

  // ── б. +1 on one house → exactly one ceremony, with confetti ───────────────
  // ── ж (part 1). the pending upgrade lights the island tab "!" ──────────────
  setStage(HOUSE_A, 4);
  await enterIsland();
  await islandAlert.waitFor({ state: 'visible', timeout: 15_000 });
  assert.match(
    await metaTab.getAttribute('class'),
    /feed-bar__icon--attention/,
    'ж: the island tab must read as needing attention while an upgrade waits',
  );
  await openIsland();
  await page.locator('.isl-upgrade__card').waitFor({ state: 'visible', timeout: 15_000 });
  if (shotDir) {
    await sleep(320);   // confetti mid-fall over the plaque
    await page.screenshot({ path: path.join(shotDir, 'upgrade-ceremony-scene.png') });
  }
  await settle();
  const single = await scenes();
  assert.equal(single.length, 1, `б: exactly one ceremony (got ${single.length})`);
  assert.equal(single[0].slot, '2', 'б: the ceremony focuses the house that grew');
  assert.match(single[0].text, /Уровень 3 → 4/, `б: plaque text "${single[0].text}"`);
  assert.doesNotMatch(single[0].text, /×/, 'б: a single step carries no ×K badge');
  assert.ok(await confetti() > 20, 'б: the shared chest confetti must burst');
  assert.deepEqual(await watermark(), { [HOUSE_A]: 4, [HOUSE_B]: 2 }, 'б: watermark advanced');
  // ── ж (part 2). celebrated → the badge clears without another probe ────────
  await islandAlert.waitFor({ state: 'hidden', timeout: 8000 });

  // ── в. +3 → ONE ceremony from→to with a ×3 badge ───────────────────────────
  setStage(HOUSE_A, 7);
  await enterIsland();
  await openIsland();
  if (shotDir) {
    await page.locator('.isl-upgrade__card').waitFor({ state: 'visible', timeout: 15_000 });
    await sleep(320);
    await page.screenshot({ path: path.join(shotDir, 'upgrade-ceremony-multi-step.png') });
  }
  await settle();
  const jump = await scenes();
  assert.equal(jump.length, 1, `в: a 3-level jump is ONE scene (got ${jump.length})`);
  assert.match(jump[0].text, /Уровень 4 → 7/, `в: plaque text "${jump[0].text}"`);
  assert.match(jump[0].text, /×3/, 'в: multi-level growth carries the ×K badge');
  assert.deepEqual(await watermark(), { [HOUSE_A]: 7, [HOUSE_B]: 2 }, 'в: watermark advanced to the top stage');

  // ── г. two houses grew → a queue of two, ordered by slot ───────────────────
  setStage(HOUSE_A, 8);
  setStage(HOUSE_B, 3);
  await enterIsland();
  await openIsland();
  await settle(5200);
  const queue = await scenes();
  assert.equal(queue.length, 2, `г: one scene per house (got ${queue.length})`);
  assert.deepEqual(queue.map((scene) => scene.slot), ['1', '2'], 'г: the queue runs in slot order');
  assert.match(queue[0].text, /Уровень 2 → 3/, `г: slot 1 plaque "${queue[0].text}"`);
  assert.match(queue[1].text, /Уровень 7 → 8/, `г: slot 2 plaque "${queue[1].text}"`);
  assert.ok(queue[1].openedAt > queue[0].openedAt, 'г: the scenes are sequential, not stacked');
  assert.deepEqual(await watermark(), { [HOUSE_A]: 8, [HOUSE_B]: 3 }, 'г: both watermarks advanced');

  // ── д. a tap skips the scene and fast-forwards the rest of the queue ───────
  setStage(HOUSE_A, 9);
  setStage(HOUSE_B, 4);
  await enterIsland();
  await openIsland();
  await page.locator('.isl-upgrade__card').waitFor({ state: 'visible', timeout: 15_000 });
  const tappedAt = Date.now();
  await page.locator('.isl-upgrade').dispatchEvent('pointerdown');
  await page.waitForFunction(
    () => window.__ceremonies.length === 2 && !document.querySelector('.isl-upgrade'),
    null,
    { timeout: 4000 },
  );
  const skippedMs = Date.now() - tappedAt;
  assert.ok(skippedMs < 1600, `д: a tap must fast-forward the queue (took ${skippedMs}ms)`);
  const skipped = await scenes();
  assert.equal(skipped.length, 2, 'д: skipping still shows every house in the queue');
  assert.deepEqual(await watermark(), { [HOUSE_A]: 9, [HOUSE_B]: 4 }, 'д: a skipped ceremony still advances the watermark');

  // ── е. a repeat entry with no growth is silent ─────────────────────────────
  await enterIsland();
  assert.equal(await islandAlert.isVisible(), false, 'е: nothing pending → no "!" badge');
  await openIsland();
  await settle();
  assert.deepEqual(await scenes(), [], 'е: an already celebrated island is silent on re-entry');
  assert.deepEqual(await watermark(), { [HOUSE_A]: 9, [HOUSE_B]: 4 }, 'е: watermark unchanged');

  // ── к. killed mid-scene → that scene REPLAYS, finished houses do not ───────
  // The watermark advances at the END of each house's own scene, so a silent
  // level-up is impossible; a repeated burst after a kill is the accepted cost.
  setStage(HOUSE_B, 5);
  setStage(HOUSE_A, 10);
  await enterIsland();
  await openIsland();
  // Wait until the SECOND scene (slot 2) is on screen, i.e. slot 1 already
  // finished and committed, then kill the page in the middle of it.
  await page.waitForFunction(
    () => window.__ceremonies.length === 2 && Boolean(document.querySelector('.isl-upgrade__card')),
    null,
    { timeout: 20_000 },
  );
  assert.deepEqual(
    await watermark(),
    { [HOUSE_A]: 9, [HOUSE_B]: 5 },
    'к: the finished scene committed; the running one has NOT',
  );
  await page.reload({ waitUntil: 'domcontentloaded' });   // kill mid-scene
  await metaTab.waitFor({ state: 'visible', timeout: 20_000 });
  await sleep(600);
  await islandAlert.waitFor({ state: 'visible', timeout: 15_000 });
  await openIsland();
  await settle();
  const replayed = await scenes();
  assert.equal(replayed.length, 1, `к: only the interrupted house replays (got ${replayed.length})`);
  assert.equal(replayed[0].slot, '2', 'к: a house celebrated before the kill is never replayed');
  assert.match(replayed[0].text, /Уровень 9 → 10/, `к: the interrupted scene replays intact "${replayed[0].text}"`);
  assert.deepEqual(await watermark(), { [HOUSE_A]: 10, [HOUSE_B]: 5 }, 'к: the replayed scene advanced the watermark');

  // ── и. growth that lands WHILE the owner is on the island ─────────────────
  // It celebrates without a re-entry (rule 6), but never on top of an open
  // building card — the scene waits for the map to be visible again.
  await enterIsland();
  await openIsland();
  await settle(1200);
  // The house group is an SVG <g> with gaps at its bounding-box centre — dispatch
  // the same click its handler listens for instead of aiming at a pixel.
  await page.locator('.island-world svg [data-b="2"]').dispatchEvent('click');
  await page.locator('.isl-sheet--show').waitFor({ state: 'visible', timeout: 8000 });
  setStage(HOUSE_B, 6);
  await sleep(13_000);                     // the island's own 10s state poll pulls it
  assert.equal(await page.locator('.isl-upgrade').count(), 0, 'и: a ceremony must not cover an open building card');
  assert.deepEqual(await scenes(), [], 'и: nothing is celebrated while the card is open');
  await page.locator('.isl-scrim').dispatchEvent('click');   // the tall sheet covers the scrim
  await page.locator('.isl-upgrade__card').waitFor({ state: 'visible', timeout: 8000 });
  await settle();
  const live = await scenes();
  assert.equal(live.length, 1, `и: exactly one live ceremony (got ${live.length})`);
  assert.match(live[0].text, /Уровень 5 → 6/, `и: plaque text "${live[0].text}"`);
  assert.deepEqual(await watermark(), { [HOUSE_A]: 10, [HOUSE_B]: 6 }, 'и: the live ceremony advanced the watermark');

  // ── з. a building the server dropped leaves the watermark silently ─────────
  dropHouse(HOUSE_B);
  await enterIsland();
  await openIsland();
  await settle();
  assert.deepEqual(await scenes(), [], 'з: a removed building must not celebrate anything');
  assert.deepEqual(await watermark(), { [HOUSE_A]: 10 }, 'з: the removed building is pruned from the watermark');

  console.log(
    'island upgrade ceremony browser: silent first entry + single/×K scenes + slot-ordered queue + tap skip + '
    + 'silent re-entry + "!" badge lifecycle + mid-scene kill replay + live upgrade behind an open card + '
    + 'removed-building prune verified',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
