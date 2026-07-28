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
    if (url.pathname === '/api/island/friends') return json([]);
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
  assert.match(await toast.textContent(), /👤 Анна — новое прохождение «Neon City»/);
  await reopened.waitForFunction(() =>
    document.querySelector('.activity-toast')?.textContent?.includes('🤖 Луна'));
  assert.match(await toast.textContent(), /🤖 Луна — новое прохождение «Neon City»/);
  assert.equal(
    await reopened.evaluate(() => localStorage.getItem('island-activity-cursor-v1:42')),
    '12',
  );
  assert.deepEqual(activityRequests, [null, '10']);
  await reopened.close();

  console.log('island real activity browser: baseline, cursor resume, human toast and bot toast verified');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
