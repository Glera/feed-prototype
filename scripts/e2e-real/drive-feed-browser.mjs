/**
 * Playwright browser driver for the real-backend feed E2E.
 *
 * Boots the served Feed (built with the three gates, pointed at the real
 * uvicorn) in a headless Chromium, swipes the vertical feed to reveal the
 * marble-sort card, and records every backend endpoint the *browser* hits so
 * you can see exactly how far the effectful catalog closure gets.
 *
 * It is a diagnostic driver, not yet a green assertion: the effectful catalog
 * lane only arms once the frontend's generated-offer discovery selects the
 * sort exposure and issues POST /api/feed/generated-offer (see RUNBOOK
 * "Known remaining gap"). This driver makes that gap observable and is the
 * harness to iterate against once the discovery trigger is satisfied.
 *
 * Prereq: run-real-backend-e2e.sh through step 7 (uvicorn + serve up), then:
 *   FEED_URL=http://127.0.0.1:8188/feed API_BASE=http://127.0.0.1:8099 \
 *     node scripts/e2e-real/drive-feed-browser.mjs
 */
import { chromium } from 'playwright';

const feedUrl = process.env.FEED_URL ?? 'http://127.0.0.1:8188/feed';
const apiBase = process.env.API_BASE ?? 'http://127.0.0.1:8099';
const swipes = Number(process.env.FEED_SWIPES ?? 4);

const EFFECTFUL = [
  '/api/feed/generated-offer',
  '/api/feed/catalog-authority',
  '/api/catalog/allocate-authorized',
  '/api/runs/start',
  '/api/catalog/tickets/',
  '/api/results',
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 780 } });

const apiHits = [];
page.on('request', (request) => {
  const url = request.url();
  if (url.startsWith(apiBase)) apiHits.push(`${request.method()} ${url.slice(apiBase.length)}`);
});

await page.goto(feedUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Swipe the vertical feed upward to walk the runway toward the sort exposure.
for (let i = 0; i < swipes; i += 1) {
  await page.mouse.move(210, 560);
  await page.mouse.down();
  await page.mouse.move(210, 180, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
}
await page.waitForTimeout(2000);

const seen = new Set(apiHits.map((h) => h.split(' ')[1].split('?')[0]));
const effectfulFired = EFFECTFUL.filter((e) =>
  [...seen].some((s) => s === e || s.startsWith(e)));

const bootOk = [...seen].some((s) => s === '/api/session');
console.log(JSON.stringify({
  schema: 'feed.real-backend-browser-probe.v1',
  feedUrl,
  apiBase,
  bootReachedRealBackend: bootOk,
  distinctApiPaths: [...seen].sort(),
  effectfulEndpointsFired: effectfulFired,
  effectfulChainArmed: effectfulFired.includes('/api/feed/catalog-authority'),
}, null, 2));

await browser.close();
process.exit(bootOk ? 0 : 1);
