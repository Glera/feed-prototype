import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const layoutProofDir = process.env.P4G_LAYOUT_PROOF_DIR || '';
const layoutProofPlayableUrl = process.env.P4G_LAYOUT_PROOF_PLAYABLE_URL || '';
let origin = '';

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
};

const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const playableHtml = (pathname) => `<!doctype html><html><head><style>
html,body{margin:0;width:100%;height:100%;background:#18233b}canvas{width:100%;height:100%;background:#2d4f7c}
</style></head><body><canvas></canvas><script>
const id=${JSON.stringify(pathname.replace(/^\//, '').replace(/\.html$/, ''))};
const lifecycle=window.__lifecycle={starts:0,stops:0,restarts:0,pauses:[],lastPaused:null};
let autoplayActive=false;
const send=(type,extra={})=>parent.postMessage({source:'playable',id,type,...extra},'*');
const setPaused=(paused)=>{lifecycle.lastPaused=Boolean(paused);lifecycle.pauses.push(Boolean(paused));};
const swipe={
  version:1,hasAutoPlay:true,hasEditor:false,hasRestart:true,
  startAutoPlay(){lifecycle.starts+=1;autoplayActive=true},stopAutoPlay(){lifecycle.stops+=1;autoplayActive=false},
  isAutoPlayActive(){return autoplayActive},
  openEditor(){},closeEditor(){},isEditorOpen(){return false},
  restart(){lifecycle.restarts+=1},prepareInteractive(){send('interactive_ready')}
};
window.__playable={swipe,setHostPaused:setPaused};
addEventListener('message',(event)=>{
  const data=event.data||{};if(data.target!=='playable-swipe')return;
  if(data.type==='prepareInteractive')send('interactive_ready');
  if(data.type==='setHostPaused')setPaused(data.paused);
  if(data.type==='startAutoPlay')swipe.startAutoPlay();
  if(data.type==='stopAutoPlay')swipe.stopAutoPlay();
});
addEventListener('load',()=>send('static_ready'));
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/api/session') {
    return json(response, {
      user: { id: 880088, ref_code: 'feed-navigation-browser' },
      ref_code: 'feed-navigation-browser',
      balance: 0,
      puzzles: 0,
      is_new: false,
      backend_version: 'feed-navigation-browser',
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/runs/start') {
    const ticket = await bodyOf(request);
    const now = Date.now();
    return json(response, {
      ticket_id: ticket.ticket_id,
      run_id: ticket.run_id,
      kind: ticket.kind,
      expected_levels: ticket.kind === 'series' ? 5 : 1,
      completed_levels: 0,
      next_result_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      state: 'active',
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/results') {
    return json(response, { is_best: true, stars_awarded: 0, balance: 0, puzzle_balance: 0 });
  }
  if (url.pathname === '/versions.json') return json(response, {});
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(readFileSync(path.join(root, 'dist', 'index.html')));
  }
  if (url.pathname.endsWith('.html')) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(playableHtml(url.pathname));
  }
  if (url.pathname.startsWith('/api/')) return json(response, {}, 404);
  response.statusCode = 404;
  response.end();
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;

const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, VITE_API_BASE: origin },
  timeout: 180_000,
});
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const telegramSdk = `window.Telegram={WebApp:{
initData:'query_id=nav&user=%7B%22id%22%3A880088%7D&hash=nav',
initDataUnsafe:{user:{id:880088},start_param:null},platform:'android',
ready(){},expand(){},requestFullscreen(){},disableVerticalSwipes(){},
setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
showConfirm(_message,callback){callback(true)},requestWriteAccess(callback){callback(true)}
}};`;

const currentIndex = (page) => page.evaluate(() => window.__feedWarm().current);
const waitForSettledIndex = async (page, expected) => {
  await page.waitForFunction((index) => window.__feedWarm?.().current === index, expected);
  await page.waitForTimeout(520);
  assert.equal(await currentIndex(page), expected);
  assert.equal(
    await page.locator('.incoming-poster').evaluateAll((items) =>
      items.some((item) => getComputedStyle(item).zIndex === '1010')),
    false,
    'no resident ride layer may remain raised after settle',
  );
};

const pointerClick = async (page, locator) => {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  const box = await locator.boundingBox();
  assert.ok(box, 'pointer target has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
};

const swipeCurrent = async (page, direction, { inspectRide = false, repeatDuringSettle = false } = {}) => {
  const surface = page.locator('.page--in-viewport .game--autoplay .game__autoplay').first();
  await surface.waitFor({ state: 'visible', timeout: 10_000 });
  const box = await surface.boundingBox();
  assert.ok(box, 'current autoplay swipe surface has no box');
  const x = box.x + box.width / 2;
  const startY = box.y + box.height * (direction < 0 ? 0.25 : 0.75);
  const middleY = box.y + box.height * (direction < 0 ? 0.55 : 0.45);
  const endY = box.y + box.height * (direction < 0 ? 0.78 : 0.22);
  await page.mouse.move(x, startY);
  await page.mouse.down();
  await page.mouse.move(x, middleY, { steps: 6 });
  if (inspectRide) {
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
    const ride = await page.locator(`.incoming-poster[data-direction="${direction}"]`).evaluate((element) => {
      const image = element.querySelector('img');
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      return {
        zIndex: getComputedStyle(element).zIndex,
        y: matrix.m42,
        complete: Boolean(image?.complete),
        naturalWidth: image?.naturalWidth ?? 0,
        mechanicIndex: Number(element.dataset.mechanicIndex),
      };
    });
    const dragDebug = await page.evaluate(() => ({
      current: window.__feedWarm?.().current,
      pages: [...document.querySelectorAll('.page--in-viewport')].map((page) => ({
        transform: getComputedStyle(page).transform,
        classes: page.querySelector('.game')?.className,
      })),
      layers: [...document.querySelectorAll('.incoming-poster')].map((layer) => ({
        direction: layer.dataset.direction,
        mechanicIndex: layer.dataset.mechanicIndex,
        zIndex: getComputedStyle(layer).zIndex,
        transform: getComputedStyle(layer).transform,
      })),
    }));
    assert.equal(
      ride.zIndex,
      '1010',
      `the direction-matched resident poster must ride above pages: ${JSON.stringify(dragDebug)}`,
    );
    assert.ok(direction < 0 ? ride.y < -1 : ride.y > 1, `unexpected ride transform ${ride.y}`);
    assert.equal(ride.complete && ride.naturalWidth > 0, true, 'the riding card must already be raster-ready');
  }
  await page.mouse.move(x, endY, { steps: 4 });
  await page.mouse.up();
  if (repeatDuringSettle) {
    await page.mouse.move(x, startY);
    await page.mouse.down();
    await page.mouse.move(x, endY, { steps: 2 });
    await page.mouse.up();
  }
};

const currentRuntime = (page) => page.evaluate(() => {
  const game = document.querySelector('.page--in-viewport .game');
  const frame = game?.querySelector('iframe');
  return {
    runId: frame?.dataset.runId ?? null,
    manual: Boolean(game?.classList.contains('game--manual')),
    lifecycle: frame?.contentWindow?.__lifecycle ?? null,
  };
});

const assertAutoplayFrameGeometry = async (page, label) => {
  const geometry = await page.locator('.page--in-viewport .game--autoplay').first().evaluate((game) => {
    const slot = game.querySelector('.game__slot');
    const frame = game.querySelector('.game__frame');
    if (!(slot instanceof HTMLElement) || !(frame instanceof HTMLElement)) return null;
    const gameRect = game.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    return {
      game: { left: gameRect.left, right: gameRect.right, top: gameRect.top, bottom: gameRect.bottom },
      slot: { left: slotRect.left, right: slotRect.right, top: slotRect.top, bottom: slotRect.bottom },
      frame: { left: frameRect.left, right: frameRect.right, top: frameRect.top, bottom: frameRect.bottom },
      overflowX: Math.max(game.scrollWidth - game.clientWidth, slot.scrollWidth - slot.clientWidth),
    };
  });
  assert.ok(geometry, `${label}: autoplay geometry is unavailable`);
  assert.ok(
    Math.abs(geometry.slot.left - geometry.game.left) < 0.5
      && Math.abs(geometry.slot.right - geometry.game.right) < 0.5,
    `${label}: autoplay must preserve the full feed width: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    Math.abs(geometry.frame.left - geometry.slot.left) < 0.5
      && Math.abs(geometry.frame.right - geometry.slot.right) < 0.5,
    `${label}: iframe must fill the full-width slot: ${JSON.stringify(geometry)}`,
  );
  assert.ok(
    geometry.slot.top > geometry.game.top && geometry.slot.bottom < geometry.game.bottom,
    `${label}: autoplay must retain a vertical footage frame: ${JSON.stringify(geometry)}`,
  );
  assert.equal(geometry.overflowX, 0, `${label}: autoplay introduced horizontal overflow`);
};

const runViewport = async (browser, viewport, label) => {
  const context = await browser.newContext({ viewport });
  await context.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));
  const page = await context.newPage();
  const initData = 'query_id=nav&user=%7B%22id%22%3A880088%7D&hash=nav';
  await page.goto(`${origin}/?initData=${encodeURIComponent(initData)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.__feedWarm === 'function');
  await page.locator('.page--in-viewport .game--autoplay').waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector('.preloader'), null, { timeout: 15_000 });
  const count = await page.locator('.page').count();
  assert.ok(count > 2, `${label}: fixture needs a real ring`);
  assert.equal(await currentIndex(page), 0, `${label}: feed must start at the first card`);
  await assertAutoplayFrameGeometry(page, `${label}/first-playable`);

  if (label === 'mobile/TMA' && layoutProofDir && layoutProofPlayableUrl) {
    mkdirSync(layoutProofDir, { recursive: true });
    const directPage = await context.newPage();
    await directPage.goto(layoutProofPlayableUrl, { waitUntil: 'networkidle' });
    await directPage.screenshot({ path: path.join(layoutProofDir, 'two-dots-direct-390x844.png') });
    await directPage.close();

    const frame = page.locator('.page--in-viewport .game__frame').first();
    await frame.evaluate((element, url) => {
      if (!(element instanceof HTMLIFrameElement)) throw new Error('feed frame is unavailable');
      element.src = url;
    }, layoutProofPlayableUrl);
    await frame.evaluate((element) => new Promise((resolve) => {
      element.addEventListener('load', resolve, { once: true });
      setTimeout(resolve, 3000);
    }));
    await assertAutoplayFrameGeometry(page, `${label}/exact-two-dots-source`);
    await page.screenshot({ path: path.join(layoutProofDir, 'two-dots-feed-390x844.png') });
  }

  await page.waitForFunction((expected) => {
    const layer = document.querySelector('.incoming-poster[data-direction="-1"]');
    const image = layer?.querySelector('img');
    return layer?.dataset.mechanicIndex === String(expected)
      && image?.complete && Number(image.naturalWidth) > 0;
  }, count - 1);
  await swipeCurrent(page, -1, { inspectRide: true, repeatDuringSettle: true });
  await waitForSettledIndex(page, count - 1);

  await swipeCurrent(page, 1, { inspectRide: true });
  await waitForSettledIndex(page, 0);
  await pointerClick(page, page.locator('[data-bar-tab="feed"]'));
  await waitForSettledIndex(page, 1);
  await assertAutoplayFrameGeometry(page, `${label}/unrelated-playable`);
  await swipeCurrent(page, -1);
  await waitForSettledIndex(page, 0);

  await pointerClick(page, page.locator('[data-bar-tab="collections"]'));
  await page.locator('.collections-view').waitFor({ state: 'visible' });
  const beforeReturn = await currentIndex(page);
  await pointerClick(page, page.locator('[data-bar-tab="feed"]'));
  await page.locator('.collections-view').waitFor({ state: 'detached' });
  assert.equal(await currentIndex(page), beforeReturn, `${label}: returning to feed advanced the mechanic`);

  const feedTab = page.locator('[data-bar-tab="feed"]');
  const feedTabBox = await feedTab.boundingBox();
  assert.ok(feedTabBox, `${label}: feed tab has no pointer box`);
  const feedTabX = feedTabBox.x + feedTabBox.width / 2;
  const feedTabY = feedTabBox.y + feedTabBox.height / 2;
  await page.mouse.move(feedTabX, feedTabY);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForFunction(() => [...document.querySelectorAll('.incoming-poster')]
    .some((item) => getComputedStyle(item).zIndex === '1010'), null, { timeout: 250 });
  await page.mouse.down();
  await page.mouse.up();
  await waitForSettledIndex(page, 1);

  await pointerClick(page, page.locator('.page--in-viewport .game--autoplay .game__autoplay').first());
  await page.locator('.page--in-viewport .game--manual').waitFor({ state: 'visible' });
  const manualSource = await currentRuntime(page);
  assert.equal(manualSource.manual, true);
  assert.ok(manualSource.lifecycle?.restarts >= 1, `${label}: manual takeover did not reset its playable`);
  await pointerClick(page, feedTab);
  await waitForSettledIndex(page, 2);
  const bottomArrival = await currentRuntime(page);
  assert.equal(bottomArrival.manual, false, `${label}: the next playable inherited manual mode`);
  assert.notEqual(bottomArrival.runId, manualSource.runId, `${label}: the next playable reused the source run`);
  assert.equal(bottomArrival.lifecycle?.lastPaused, false, `${label}: the next playable stayed host-paused`);
  assert.ok(bottomArrival.lifecycle?.starts > 0, `${label}: the next playable did not resume autoplay`);

  await pointerClick(page, page.locator('.page--in-viewport .game--autoplay .game__autoplay').first());
  await page.locator('.page--in-viewport .game--show-close').waitFor({ state: 'visible' });
  await pointerClick(page, page.locator('.page--in-viewport .game__close'));
  await waitForSettledIndex(page, 3);

  await context.close();
};

const browser = await chromium.launch();
try {
  await runViewport(browser, { width: 390, height: 844 }, 'mobile/TMA');
  await runViewport(browser, { width: 1280, height: 800 }, 'desktop');
  console.log('feed navigation browser checks passed for mobile/TMA and desktop');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
