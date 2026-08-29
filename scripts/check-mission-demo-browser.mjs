/** Focused operator Mission demo in the real production Feed build. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const context = await browser.newContext({ viewport: { width: 390, height: 760 } });
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
  await page.goto(`${origin}/?missionDemo=1`, { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="mission-demo"]').waitFor();
  assert.equal(await page.locator('[data-testid="mission-demo-badge"]').textContent(), 'Демо · тестовые данные');
  assert.equal(await page.locator('.mission-screen__title').textContent(), '10 кг корма');
  assert.deepEqual(requests, ['POST /api/session'], 'demo must call only the authenticated session projection');
  assert.equal(await page.evaluate(() => [localStorage.length, sessionStorage.length].join(':')), '0:0');

  await page.locator('.mission-demo__hud .hud__mission-info').click();
  await page.locator('.mission-contract-sheet').waitFor();
  assert.match(await page.locator('.mission-contract-sheet').textContent(), /Приют «Лапа»/);
  await page.locator('.mission-contract-sheet__close').click();

  await page.locator('[data-stage="contribution"]').click();
  assert.equal(await page.locator('.mission-history__row').count(), 1);
  assert.equal(await page.locator('.hud__mission-count').textContent(), '5 / 50');

  await page.locator('[data-stage="unlocked"]').click();
  assert.match(await page.locator('.mission-ceremony__title').textContent(), /Приют получает/);
  await page.locator('.mission-ceremony__btn').click();

  await page.locator('[data-stage="fulfilled"]').click();
  assert.equal(await page.locator('.mission-ceremony__title').textContent(), 'Корм передан');
  assert.doesNotMatch(await page.locator('.mission-ceremony').textContent(), /internal-do-not-render/);
  assert.deepEqual(requests, ['POST /api/session'], 'scenario switching must remain local and read-only');

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
