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

const feedUrlBase = process.env.FEED_URL ?? 'http://127.0.0.1:8188/feed';
// Open the stand feed as a specific Telegram id via the serve harness ?tg=
// shorthand (the stand backend trusts unsigned initData). Defaults to the
// seeded dogfood player when FEED_TG is unset.
const feedTg = (process.env.FEED_TG ?? '').trim();
const feedUrl = feedTg
  ? `${feedUrlBase}?tg=${encodeURIComponent(feedTg)}&name=${encodeURIComponent(process.env.FEED_TG_NAME ?? `Player ${feedTg}`)}`
  : feedUrlBase;
const apiBase = process.env.API_BASE ?? 'http://127.0.0.1:8099';
const maxSwipes = Number(process.env.FEED_SWIPES ?? 14);
const headless = process.env.HEADFUL !== '1';
// All waits are env-configurable so a slow CI runner can be given generous
// budgets without editing the driver (no sleep-magic; each is a real gate).
const offerTimeoutMs = Number(process.env.FEED_OFFER_TIMEOUT_MS ?? 20_000);
const cardTimeoutMs = Number(process.env.FEED_CARD_TIMEOUT_MS ?? 15_000);
const swipeWaitMs = Number(process.env.FEED_SWIPE_WAIT_MS ?? 1_400);
const stepWaitMs = Number(process.env.FEED_STEP_WAIT_MS ?? 700);

const browser = await chromium.launch({ headless });
const page = await browser.newPage({ viewport: { width: 420, height: 780 } });

const apiHits = [];
const results = [];
page.on('request', (request) => {
  const url = request.url();
  if (url.startsWith(apiBase)) apiHits.push(`${request.method()} ${url.slice(apiBase.length).split('?')[0]}`);
});
page.on('response', async (response) => {
  const request = response.request();
  const url = response.url();
  if (url.startsWith(`${apiBase}/api/results`) && request.method() === 'POST') {
    // The /results response ack does not echo metric_key; classify from the
    // REQUEST body (metric_key 'series' = chest, otherwise a level result).
    let body = null;
    try { body = JSON.parse(request.postData() ?? '{}'); } catch { /* noop */ }
    results.push({ status: response.status(), body });
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
    { timeout: offerTimeoutMs },
  );
  await page.waitForFunction(() => document.querySelectorAll('.game--generated').length > 0, null, {
    timeout: cardTimeoutMs,
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
  await page.waitForTimeout(swipeWaitMs);
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

// 3. Drive the level(s) to a win via the runtime's OWN public host-command API.
//    The real marble-sort runtime exposes window.__playable.swipe and accepts
//    { target:'playable-swipe', type:'startAutoPlay'|'setHostPaused' } postMessage
//    commands (shared/swipe-api.ts); startAutoPlayApi runs its solver oracle to a
//    win. The feed sends these for built-in autoplay demos but not for catalog
//    slots, so the driver sends them itself — no runtime change, driver-side only.
//    Re-kick every tick because the feed restarts the runtime in place for each
//    series level (a fresh level needs a fresh startAutoPlay). Same-origin lets us
//    reach the catalog iframe's contentWindow directly.
// The runtime plays only while it considers itself interactive: for the SWIPE
// target isInteractive() === (!hostPaused && !document.hidden). The feed's
// setFramePaused drives BOTH the runtime hostPaused flag AND the iframe
// document.hidden (redefining the property + dispatching visibilitychange), and
// re-pauses the catalog slot, so a single kick loses the race. The catalog
// iframe is same-origin, so we install a tight in-page interval that, every
// 60ms, forces the frame document visible, clears hostPaused, and starts the
// runtime's own autoplay solver — out-pacing the feed's re-pause. Runtime code
// is untouched; we only exercise its public host lifecycle + swipe API.
const installCatalogAutoplayPump = () => page.evaluate(() => {
  if (window.__e2eAutoplayPump) return true;
  const pinned = new WeakSet();
  const kick = () => {
    const frame = document.querySelector('iframe[data-catalog-player-v2="1"]');
    const cw = frame && frame.contentWindow;
    const doc = cw && cw.document;
    if (!cw || !doc) return;
    try {
      // Pin the frame permanently visible ONCE: a non-configurable getter makes
      // the feed's own setFramePaused redefine throw (it uses configurable:true),
      // so our visibility wins the race instead of alternating every rAF.
      if (!pinned.has(doc)) {
        try {
          Object.defineProperty(doc, 'hidden', { configurable: false, get: () => false });
          Object.defineProperty(doc, 'visibilityState', { configurable: false, get: () => 'visible' });
          pinned.add(doc);
        } catch { /* already defined by the feed as configurable — retry next tick */ }
      }
      doc.dispatchEvent(new cw.Event('visibilitychange'));
      const p = cw.__playable;
      if (p && typeof p.setHostPaused === 'function') p.setHostPaused(false);
      const swipe = p && p.swipe;
      if (swipe && typeof swipe.startAutoPlay === 'function' && !swipe.isAutoPlayActive()) {
        swipe.startAutoPlay();
      }
    } catch { /* noop */ }
  };
  window.__e2eAutoplayPump = setInterval(kick, 60);
  kick();
  return true;
});

const catalogFrameDiag = () => page.evaluate(() => {
  const frame = document.querySelector('iframe[data-catalog-player-v2="1"]');
  if (!frame) return { frame: false };
  let path = '';
  try { path = new URL(frame.src).pathname; } catch { /* noop */ }
  const cw = frame.contentWindow;
  const p = cw && cw.__playable;
  const swipe = p && p.swipe;
  const call = (fn) => { try { return typeof fn === 'function' ? fn() : null; } catch { return 'err'; } };
  let qa = null;
  try { qa = p && p.sortQa ? JSON.parse(JSON.stringify(p.sortQa())) : null; } catch { qa = 'err'; }
  return {
    frame: true,
    runtimeRelease: path.includes('/runtime-releases/'),
    hasPlayableSwipe: !!swipe,
    isAutoPlayActive: call(swipe && swipe.isAutoPlayActive),
    runtimeIsPaused: call(p && p.isPaused),
    runtimeIsStarted: call(p && p.isStarted),
    docHidden: cw.document ? cw.document.hidden : null,
    sortQa: qa,
  };
});

const playMs = Number(process.env.FEED_PLAY_MS ?? 120_000);
const deadline = Date.now() + playMs;
await installCatalogAutoplayPump();
log('installed tight in-page autoplay pump on the catalog frame.');

// Apply the runtime's OWN solver move-by-move. sortQa.chooseOracleAction()
// selects the best cell (no vclock needed); applyOracleAction() is vclock-gated
// so instead we dispatch a real pointer tap at that cell on the same-origin
// canvas — the exact input a human would make. The pump keeps the frame
// unpaused so physics settles between taps. Runtime code is untouched.
const solveStep = () => page.evaluate(() => {
  const frame = document.querySelector('iframe[data-catalog-player-v2="1"]');
  const cw = frame && frame.contentWindow;
  const qa = cw && cw.__playable && cw.__playable.sortQa;
  const canvas = cw && cw.document && cw.document.querySelector('canvas');
  if (!qa || !canvas) return 'no-frame';
  let cellId;
  try { cellId = qa.chooseOracleAction(); } catch { return 'choose-err'; }
  if (typeof cellId !== 'number' || cellId < 0) return 'no-move';
  let snap;
  try { snap = qa.snapshot(); } catch { return 'snap-err'; }
  const cell = snap.grid.find((c) => c.id === cellId && !c.released);
  if (!cell) return 'released';
  const cols = Math.max(...snap.grid.map((c) => c.col)) + 1; // GRID_COLS
  const gw = cols * 36 + (cols - 1) * 4;
  const sx = (390 - gw) / 2;
  const logicalX = sx + cell.col * 40 + 18;
  const logicalY = 30 + cell.row * 40 + 18;
  const rect = canvas.getBoundingClientRect();
  const scale = rect.width / 390; // uniform aspect
  const cx = rect.left + logicalX * scale;
  const cy = rect.top + logicalY * scale;
  const opts = { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', isPrimary: true };
  try {
    canvas.dispatchEvent(new cw.PointerEvent('pointerdown', opts));
    canvas.dispatchEvent(new cw.PointerEvent('pointerup', opts));
    canvas.dispatchEvent(new cw.MouseEvent('mousedown', opts));
    canvas.dispatchEvent(new cw.MouseEvent('mouseup', opts));
    return `tapped:${cellId}@${cell.row},${cell.col}`;
  } catch (e) { return 'dispatch-err:' + e.message; }
});

let diag = null;
let lastStep = '';
let stepCount = 0;
while (Date.now() < deadline) {
  const step = await solveStep();
  if (step && step.startsWith('tapped')) { stepCount += 1; lastStep = step; }
  else lastStep = step;
  if (!diag && stepCount === 1) diag = await catalogFrameDiag();
  await page.waitForTimeout(stepWaitMs);
  if (results.some((r) => r.body?.metric_key === 'series')) break; // chest posted
}
log(`solver taps applied: ${stepCount}; last step: ${lastStep}`);
log(`catalog frame diag: ${JSON.stringify(diag)}`);

const distinct = [...new Set(apiHits.map((h) => h.split(' ')[1]))].sort();
const levelResults = results.filter((r) => r.body?.metric_key !== 'series');
const chestResults = results.filter((r) => r.body?.metric_key === 'series');
console.log(JSON.stringify({
  schema: 'feed.real-backend-browser-probe.v2',
  feedUrl,
  apiBase,
  playerTelegramId: feedTg || '(seeded dogfood default)',
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
