import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'island-p2-browser-'));
const port = 5232;
const origin = `http://127.0.0.1:${port}`;
const source = readFileSync(path.join(root, 'src', 'feed.ts'), 'utf8');
const islandSource = readFileSync(path.join(root, 'src', 'island.ts'), 'utf8');

assert.match(
  source,
  /queueResultWithReceipt\(payload\).*requestIslandVisitAward/s,
  'visit award must wait for the exact chest result receipt',
);
assert.match(
  source,
  /award\?\.won && !award\.holdout && award\.target/,
  'holdout must never mount a card',
);
assert.match(
  source,
  /dismissChallengePill\(\).*mountIslandVisitAwardCard/s,
  'visit card must consume the single post-chest prompt slot',
);
assert.doesNotMatch(
  `${source}\n${islandSource}`,
  /island-sim|recordVisitor|simulate(?:d)?Visit|p4g-island-social-mode/i,
  'production Island source must not contain the retired local visit simulator',
);

const build = spawnSync(
  'npx',
  ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'],
  {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      VITE_API_BASE: origin,
      VITE_ISLAND_ENABLED: '1',
      VITE_ISLAND_VISIT_AWARDS_ENABLED: '1',
      VITE_ISLAND_NOTIFICATIONS_ENABLED: '1',
    },
    timeout: 180_000,
  },
);
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const cardHtml = `<!doctype html><html><body><main class="reward"></main><script type="module">
import { mountIslandVisitAwardCard } from '/island-p2-card.mjs';
const award = {
  run_id: 'run', roll_id: 'roll', won: true, holdout: false, state: 'offered',
  target: { owner_id: 42, first_name: 'Лея', username: null, photo_url: null, is_bot: false, deep_link: '' },
  gift_preview: { puzzles: 3 },
};
window.cardEvents = { shown: 0, accepted: 0, declined: 0, errors: 0 };
window.mountCard = () => mountIslandVisitAwardCard({
  parent: document.querySelector('.reward'),
  award,
  escapeHtml: (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
  onShown: () => { window.cardEvents.shown += 1; },
  onAccept: async () => { window.cardEvents.accepted += 1; },
  onDecline: async () => { window.cardEvents.declined += 1; },
  onError: () => { window.cardEvents.errors += 1; },
});
window.mountCard();
</script></body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin);
  if (url.pathname === '/versions.json') {
    response.setHeader('content-type', 'application/json');
    response.end('{}');
    return;
  }
  if (url.pathname === '/card.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(cardHtml);
    return;
  }
  if (url.pathname === '/island-p2-card.mjs') {
    response.setHeader('content-type', 'application/javascript; charset=utf-8');
    response.end(readFileSync(path.join(root, 'src', 'island-p2-card.mjs')));
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

const friends = [1, 2, 3, 4].map((id) => ({
  user_id: 80000 + id,
  first_name: `Друг ${id}`,
  username: null,
  photo_url: null,
  is_bot: id === 4,
  has_island: true,
  published_buildings: 1,
}));
const calls = {
  remove: [],
  block: [],
  consent: [],
  friendCode: 0,
};
let consentFailuresRemaining = 1;
const telegramSdk = `
window.Telegram={WebApp:{
  initData:'',initDataUnsafe:{},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},
  setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
  HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
  showConfirm(_message,callback){callback(true);},
  requestWriteAccess(callback){window.__writePromptCount=(window.__writePromptCount||0)+1;callback(true);},
  openTelegramLink(){},close(){}
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
        user: { id: 79999, ref_code: 'p2', first_name: 'P2' },
        ref_code: 'p2',
        balance: 0,
        puzzles: 0,
        is_new: false,
      });
    }
    if (url.pathname === '/api/island/friends' && method === 'GET') return json(friends);
    if (url.pathname === '/api/island/friends/code' && method === 'POST') {
      calls.friendCode += 1;
      return json({ code: 'P2FRIEND', link: 'https://t.me/test?startapp=f_P2FRIEND' });
    }
    if (url.pathname === '/api/island/notifications/write-access' && method === 'PUT') {
      calls.consent.push(request.postDataJSON());
      if (consentFailuresRemaining > 0) {
        consentFailuresRemaining -= 1;
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"detail":"temporary fixture failure"}',
        });
      }
      return json({ allows_write_pm: true });
    }
    const remove = url.pathname.match(/^\/api\/island\/friends\/(\d+)$/);
    if (remove && method === 'DELETE') {
      calls.remove.push(Number(remove[1]));
      return json({ removed: true });
    }
    const block = url.pathname.match(/^\/api\/island\/friends\/(\d+)\/block$/);
    if (block && method === 'PUT') {
      calls.block.push({ id: Number(block[1]), body: request.postDataJSON() });
      return json({ blocked: true, friendship_removed: true });
    }
    if (url.pathname === '/api/challenges' && method === 'GET') return json([]);
    if (url.pathname === '/api/events') return json({ accepted: 0 });
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: '{"detail":"fixture unavailable"}',
    });
  });

  const page = await context.newPage();
  await page.goto(`${origin}/?initData=p2-browser`, { waitUntil: 'domcontentloaded' });
  await page.locator('.isln-friends [data-friends-list]').waitFor({ state: 'visible' });

  const invite = page.locator('.isln-friends [data-friend-invite]').last();
  await invite.click();
  await page.waitForFunction(() => (window.__writePromptCount || 0) === 1);
  await page.waitForFunction(() => {
    return localStorage.getItem('island-write-access-pending-v1:79999') === 'true';
  });
  await invite.click();
  await page.waitForFunction(() => {
    return localStorage.getItem('island-write-access-pending-v1:79999') == null;
  });
  assert.equal(await page.evaluate(() => window.__writePromptCount || 0), 1);
  assert.deepEqual(calls.consent, [
    { allows_write_pm: true },
    { allows_write_pm: true },
  ]);
  assert.equal(calls.friendCode, 2, 'invite stays usable while native consent is asked once');

  await page.locator('.isln-friends [data-friends-list]').click();
  await page.locator(`[data-remove="${friends[0].user_id}"]`).click();
  await page.waitForFunction(() => !document.querySelector('.isln-flist'));
  assert.deepEqual(calls.remove, [friends[0].user_id]);
  assert.equal(
    await page.locator(`.isln-friends [data-friend-visit="${friends[0].user_id}"]`).count(),
    0,
    'removed friend stayed in the HUD',
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.isln-friends [data-friends-list]').waitFor({ state: 'visible' });
  await page.locator('.isln-friends [data-friends-list]').click();
  await page.locator(`[data-block="${friends[1].user_id}"]`).click();
  await page.waitForFunction(() => !document.querySelector('.isln-flist'));
  assert.deepEqual(calls.block, [{ id: friends[1].user_id, body: { blocked: true } }]);

  const cardPage = await context.newPage();
  await cardPage.goto(`${origin}/card.html`, { waitUntil: 'networkidle' });
  await cardPage.locator('.isln-award').waitFor();
  assert.match(await cardPage.locator('.isln-award').textContent(), /Лея/);
  assert.match(await cardPage.locator('.isln-award').textContent(), /\+3/);
  assert.equal(await cardPage.evaluate(() => window.mountCard()), null, 'duplicate card mounted');
  assert.equal(await cardPage.locator('.isln-award').count(), 1);
  await cardPage.locator('.isln-award__later').click();
  await cardPage.locator('.isln-award').waitFor({ state: 'detached' });
  assert.deepEqual(
    await cardPage.evaluate(() => window.cardEvents),
    { shown: 1, accepted: 0, declined: 1, errors: 0 },
  );
  await cardPage.evaluate(() => window.mountCard());
  await cardPage.locator('.isln-award__go').click();
  await cardPage.locator('.isln-award').waitFor({ state: 'detached' });
  assert.deepEqual(
    await cardPage.evaluate(() => window.cardEvents),
    { shown: 2, accepted: 1, declined: 1, errors: 0 },
  );

  console.log('island P2 browser: remove/block, consent-once, exact card renderer/actions verified');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
