/** Focused operator Mission demo in the real production Feed build. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { missionDemoRequested } from '../src/mission-demo-route.mjs';

assert.equal(missionDemoRequested({ startParam: 'mission_demo' }), true);
assert.equal(missionDemoRequested({ search: '?missionDemo=1' }), true);
assert.equal(missionDemoRequested({ startParam: 'mission-demo' }), false);
assert.equal(missionDemoRequested({ search: '?missionDemo=true' }), false);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'mission-demo-browser-'));
const port = Number(process.env.MISSION_DEMO_BROWSER_PORT || 5279);
const origin = `http://127.0.0.1:${port}`;
const build = spawnSync(
  'npx',
  ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'],
  {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      VITE_API_BASE: origin,
      VITE_MISSION_ENABLED: 'false',
      VITE_ISLAND_ENABLED: 'false',
    },
    timeout: 240_000,
  },
);
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin);
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
  initData:'mission-demo-signed',initDataUnsafe:{user:{id:79123},start_param:'mission_demo'},platform:'ios',
  ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},
  setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
  HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
  close(){}
}};`;

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await context.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));

  const requests = [];
  let operator = true;
  await context.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    requests.push(`${route.request().method()} ${url.pathname}`);
    if (url.pathname !== '/api/session') {
      return route.fulfill({ status: 500, body: 'Mission demo issued an unexpected API call' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: { id: 79123, ref_code: 'demo' },
        ref_code: 'demo',
        balance: 0,
        is_new: false,
        ...(operator ? { operator_level_flagging_available: true } : {}),
      }),
    });
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const captures = process.env.MISSION_DEMO_CAPTURE_DIR;
  const capture = async (name) => {
    if (!captures) return;
    mkdirSync(captures, { recursive: true });
    await page.screenshot({ path: path.join(captures, name + '.png') });
  };
  const insideViewport = async (locator) => {
    const box = await locator.boundingBox();
    assert.ok(box, 'target must be rendered');
    const viewport = page.viewportSize();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
      `target must fit viewport, not just exist in DOM: ${JSON.stringify(box)}`);
  };
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  await page.goto(`${origin}/?missionDemo=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="mission-demo"]').waitFor();
  assert.equal(await page.locator('[data-testid="mission-demo-badge"]').textContent(), 'Демо · тестовые данные');
  assert.equal(await page.locator('.mission-screen__title').textContent(), 'Полные миски в приюте «Лапа»');
  assert.match(await page.locator('.mission-photo__hint').textContent(), /Иллюстрация · вымышленный/);
  assert.equal(await page.locator('.mission-ladder__step--next .mission-ladder__icon').textContent(), '🎁');
  assert.equal(await page.locator('.mission-ladder__step--reserved:not(.mission-ladder__step--next) .mission-ladder__icon').textContent(), '🔒');
  const purpleFill = await page.locator('.mission-meter__track i').evaluate((node) => getComputedStyle(node).backgroundImage);
  assert.match(purpleFill, /141, 111, 224/);
  assert.equal(await page.locator('.hud__mission-track i').evaluate((node) => getComputedStyle(node).backgroundImage), purpleFill);
  await noOverflow();
  await capture('01-active-390');
  assert.deepEqual(requests, ['POST /api/session'], 'demo must call only the authenticated session projection');
  assert.equal(await page.evaluate(() => [localStorage.length, sessionStorage.length].join(':')), '0:0');

  await page.locator('.mission-demo__hud .hud__mission-info').click();
  await page.locator('.mission-contract-sheet').waitFor();
  assert.match(await page.locator('.mission-contract__human').innerText(), /Приют «Лапа»/);
  assert.doesNotMatch(await page.locator('.mission-contract-sheet').innerText(), /prefunded-reserved/);
  await capture('02-info-human-390');
  await page.locator('.mission-contract__technical > summary').click();
  assert.match(await page.locator('.mission-policy').innerText(), /prefunded-reserved-at-ready-open-once-v1/);
  await page.locator('.mission-contract__raw > summary').click();
  assert.equal(JSON.parse(await page.locator('.mission-contract__json').textContent()).contract.caseId, 'case-2');
  await capture('03-info-technical-390');
  await page.locator('.mission-contract-sheet__close').click();

  await page.locator('[data-stage="contribution"]').click();
  assert.equal(await page.locator('.mission-history__row').count(), 0);
  assert.equal(await page.locator('.mission-paw-flight').count(), 0, 'stage tabs are navigation, never a reward origin');
  assert.equal(await page.locator('.hud__mission-count').textContent(), '4 / 5');
  await insideViewport(page.locator('.mission-demo__reward'));
  await capture('04-reward-ready-390');
  await page.locator('.mission-demo__reward').click();
  await page.locator('.mission-paw-flight').waitFor();
  assert.equal(await page.locator('.mission-demo__reward').isDisabled(), true, 'no double reward while flying');
  await page.locator('.mission-gift-opened').waitFor();
  assert.equal(await page.locator('.hud__mission-count').textContent(), '5 / 5', 'hold the opened milestone before changing the denominator');
  assert.match(await page.locator('.mission-meter__count').textContent(), /^5 \/ 5/);
  assert.match(await page.locator('.mission-gift-opened').textContent(), /Открыт подарок \+€10[\s\S]*Уже собрано €110/);
  assert.equal(await page.locator('.mission-history__row').count(), 1);
  assert.equal(await page.locator('.mission-card,.mission-toast').count(), 0, 'own paw gets a flight, not a contribution toast');
  await insideViewport(page.locator('.mission-gift-opened'));
  await capture('05-gift-opened-390');
  await page.locator('.mission-demo__next-gift').click();
  assert.equal(await page.locator('.hud__mission-count').textContent(), '5 / 50');
  assert.match(await page.locator('.mission-ladder__step--next').textContent(), /50 лапок/);
  await capture('06-next-gift-390');
  await page.locator('.mission-screen').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await capture('07-history-390');

  // Cancel a running flight by switching stages; its callback cannot overwrite
  // the new scene, bounce the new gift, or add delayed own feedback.
  await page.locator('[data-stage="contribution"]').click();
  await page.locator('.mission-demo__reward').click();
  await page.locator('[data-stage="active"]').click();
  await page.waitForTimeout(900);
  assert.equal(await page.locator('.hud__mission-count').textContent(), '4 / 5');
  assert.equal(await page.locator('.mission-paw-flight,.mission-gift-opened,.hud__mission-gift--bounce').count(), 0);

  await page.locator('[data-stage="contribution"]').click();
  await page.locator('.mission-demo__reward').click();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await page.waitForTimeout(900);
  assert.equal(await page.locator('.mission-paw-flight,.mission-gift-opened').count(), 0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  assert.equal(await page.locator('.mission-demo__reward').isEnabled(), true, 'BFCache return resets the cancelled preview reward');
  await page.locator('[data-stage="active"]').click();
  assert.equal(await page.locator('[data-stage="active"]').getAttribute('data-active'), 'true', 'BFCache return keeps stage navigation alive');

  await page.locator('[data-stage="unlocked"]').click();
  assert.match(await page.locator('.mission-ceremony__title').textContent(), /Приют получает/);
  assert.equal(await page.locator('.mission-ceremony .mission-demo-illustration').count(), 1);
  assert.equal(await page.locator('.mission-tile__value').last().textContent(), '3 лапки');
  await capture('08-unlocked-390');
  await page.locator('.mission-ceremony__btn').click();

  await page.locator('[data-stage="fulfilled"]').click();
  assert.equal(await page.locator('.mission-ceremony__title').textContent(), 'Помнишь, мы собрали €120 для «Лапы»?');
  assert.match(await page.locator('.mission-ceremony__story').textContent(), /Корм уже привезли/);
  assert.doesNotMatch(await page.locator('.mission-ceremony').textContent(), /internal-do-not-render/);
  await capture('09-fulfilled-390');
  await page.locator('.mission-ceremony__btn').click();
  await page.setViewportSize({ width: 320, height: 640 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('[data-stage="contribution"]').click();
  await insideViewport(page.locator('.mission-demo__reward'));
  await capture('10-reward-ready-320');
  await page.locator('.mission-demo__reward').click();
  await page.locator('.mission-gift-opened').waitFor();
  await insideViewport(page.locator('.mission-gift-opened'));
  assert.equal(await page.locator('.hud__mission-count').textContent(), '5 / 5');
  assert.equal(await page.locator('.mission-paw-flight,.hud__mission-gift--bounce').count(), 0, 'reduced motion has no lingering animation');
  await noOverflow();
  await capture('11-gift-opened-320');
  await page.locator('.mission-demo__hud .hud__mission-info').click();
  await page.locator('.mission-contract-sheet').waitFor();
  assert.equal(await page.locator('.hud__mission-count').textContent(), '5 / 5', 'info does not reset preview progress');
  await noOverflow();
  await capture('12-info-human-320');
  await page.locator('.mission-contract-sheet__close').click();
  await page.locator('.mission-demo__next-gift').click();
  await page.locator('.mission-screen').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await capture('13-history-320');
  for (const stage of ['unlocked', 'fulfilled']) {
    await page.locator(`[data-stage="${stage}"]`).click();
    await noOverflow();
    await page.locator('.mission-ceremony__btn').scrollIntoViewIfNeeded();
    await insideViewport(page.locator('.mission-ceremony__btn'));
    await capture(`14-${stage}-320`);
    await page.locator('.mission-ceremony__btn').click();
  }
  assert.deepEqual(requests, ['POST /api/session'], 'scenario switching must remain local and read-only');
  assert.equal(await page.evaluate(() => [localStorage.length, sessionStorage.length].join(':')), '0:0');
  // Disposal aborts the same callbacks without adding global state or storage.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('[data-stage="contribution"]').click();
  await page.locator('.mission-demo__reward').click();
  await page.locator('[data-testid="mission-demo"]').evaluate((node) => node.remove());
  await page.waitForTimeout(900);
  assert.equal(await page.locator('.mission-paw-flight,.mission-gift-opened').count(), 0);
  assert.deepEqual(errors, []);

  operator = false;
  requests.length = 0;
  const denied = await context.newPage();
  await denied.goto(`${origin}/?missionDemo=1`, { waitUntil: 'domcontentloaded' });
  await denied.locator('[data-testid="mission-demo-error"]').waitFor();
  assert.match(await denied.locator('[data-testid="mission-demo-error"]').textContent(), /операторский доступ/);
  assert.equal(await denied.locator('[data-testid="mission-demo"]').count(), 0);
  assert.deepEqual(requests, ['POST /api/session']);

  console.log('mission demo browser: PASS');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
