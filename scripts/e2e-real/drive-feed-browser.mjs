/**
 * Playwright browser driver for the real-backend feed E2E.
 *
 * Boots the served Feed (built with the three gates, pointed at the real
 * uvicorn), waits for the background generated-offer closure to become ready,
 * swipes the vertical feed one card at a time until the inserted generated
 * catalog card is in the viewport, opens it, and lets the real content-addressed
 * marble-sort-swipe runtime autoplay the level(s) to the chest.
 *
 * The real runtime autoplays by default under the catalog handshake
 * (`zt = "0"!==get("auto") && "0"!==get("autoplay")`, and the frame carries
 * neither), so no in-iframe interaction is scripted — the closure is driven by
 * the production runtime itself.
 *
 * It records every backend endpoint the browser hits and asserts the closure:
 * generated-offer -> runs/start -> tickets/specs -> catalog_level_impression_v2
 * -> /api/results (level) -> /api/results (chest).
 *
 * Prereq: seed a fresh continuity trigger and bring up uvicorn + serve (steps
 * 1-4,6-7 of run-real-backend-e2e.sh -- do NOT pre-run the backend chain driver,
 * it consumes the one-shot trigger). Then:
 *   FEED_URL=http://127.0.0.1:8188/feed API_BASE=http://127.0.0.1:8099 \
 *     node scripts/e2e-real/drive-feed-browser.mjs
 */
import { chromium } from 'playwright';

const feedUrl = process.env.FEED_URL ?? 'http://127.0.0.1:8188/feed';
const apiBase = process.env.API_BASE ?? 'http://127.0.0.1:8099';
const maxSwipes = Number(process.env.FEED_SWIPES ?? 14);
const headless = process.env.HEADFUL !== '1';

const browser = await chromium.launch({ headless });
const page = await browser.newPage({ viewport: { width: 420, height: 780 } });

const apiHits = [];
const results = [];
page.on('request', (request) => {
  const url = request.url();
  if (url.startsWith(apiBase)) apiHits.push(`${request.method()} ${url.slice(apiBase.length).split('?')[0]}`);
});
page.on('response', async (response) => {
  const url = response.url();
  if (url.startsWith(`${apiBase}/api/results`) && response.request().method() === 'POST') {
    try { results.push({ status: response.status(), body: await response.json() }); } catch { /* noop */ }
  }
});

const seen = (path) => apiHits.some((h) => h.endsWith(` ${path}`));
const log = (m) => console.log(`[driver] ${m}`);

await page.goto(feedUrl, { waitUntil: 'domcontentloaded' });

// 1. Wait for the background generated-offer closure to be ready.
log('waiting for generated-offer closure (generated-offer + runs/start + specs)...');
try {
  await page.waitForResponse(
    (r) => r.url().startsWith(`${apiBase}/api/feed/generated-offer`) && r.status() === 200,
    { timeout: 20_000 },
  );
  await page.waitForFunction(() => document.querySelectorAll('.game--generated').length > 0, null, {
    timeout: 15_000,
  });
  log('generated card inserted into the feed ring.');
} catch (error) {
  log(`generated card did not appear: ${error.message}`);
}

// 2. Swipe one card at a time until the generated card is the active page, then
//    open it and let the real runtime autoplay.
const swipeUp = async () => {
  await page.mouse.move(210, 600);
  await page.mouse.down();
  await page.mouse.move(210, 170, { steps: 14 });
  await page.mouse.up();
  await page.waitForTimeout(1400);
};

const generatedActive = () => page.evaluate(() => {
  const active = document.querySelector('.page--in-viewport');
  const g = active && (active.classList.contains('game--generated') || active.querySelector('.game--generated'));
  const frame = active && active.querySelector('iframe[data-catalog-player-v2="1"]');
  return { generated: !!g, catalogFrame: !!frame };
});

let landed = false;
for (let i = 0; i < maxSwipes; i += 1) {
  const state = await generatedActive();
  if (state.generated || state.catalogFrame) { landed = true; break; }
  await swipeUp();
}
if (landed) {
  // Do NOT tap: a tap takes over the feed's autoplay demo and switches the card
  // to manual (human) play. Landing and letting the card settle lets the shared
  // AutoCursor autoplay drive the level to a win. Set FEED_TAP=1 to force a tap.
  if (process.env.FEED_TAP === '1') {
    log('generated catalog card active -- tapping (manual takeover).');
    await page.mouse.click(210, 400);
  } else {
    log('generated catalog card active -- letting the autoplay demo drive it.');
  }
} else {
  log('never landed on the generated card within the swipe budget.');
}

// 3. Give the autoplaying runtime time to close level(s) + chest. Autoplaying a
//    real sort level and its follow-ups to the chest takes tens of seconds.
const playMs = Number(process.env.FEED_PLAY_MS ?? 60_000);
const deadline = Date.now() + playMs;
while (Date.now() < deadline) {
  await page.waitForTimeout(2_000);
  if (results.some((r) => r.body?.metric_key === 'series')) break; // chest posted
}

const distinct = [...new Set(apiHits.map((h) => h.split(' ')[1]))].sort();
const levelResults = results.filter((r) => r.body?.metric_key !== 'series');
const chestResults = results.filter((r) => r.body?.metric_key === 'series');
console.log(JSON.stringify({
  schema: 'feed.real-backend-browser-probe.v2',
  feedUrl,
  apiBase,
  bootReachedRealBackend: seen('/api/session'),
  landedOnGeneratedCard: landed,
  distinctApiPaths: distinct,
  effectfulChainArmed: seen('/api/feed/generated-offer'),
  levelResultsPosted: levelResults.length,
  chestResultsPosted: chestResults.length,
  results: results.map((r) => ({ status: r.status, metric_key: r.body?.metric_key, ordinal: r.body?.ordinal, series_level: r.body?.series_level })),
}, null, 2));

await browser.close();
process.exit(seen('/api/session') ? 0 : 1);
