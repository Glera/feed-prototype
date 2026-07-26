import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'island-p5-client-'));
const port = 5247;
const origin = `http://127.0.0.1:${port}`;
const buildingId = 'b0000000-0000-4000-8000-000000000000';
const rel = 'u/42/neon-abcd1234.html';
const digest = `sha256:${'a'.repeat(64)}`;
const signedUrl = 'https://private.invalid/island/artifacts/object.html?X-Amz-Expires=600&X-Amz-Signature=device-secret';

const build = spawnSync('npx', ['--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir'], {
  cwd: root,
  encoding: 'utf8',
  env: {
    ...process.env,
    VITE_ISLAND_ENABLED: '1',
    VITE_UGC_BASE_URL: 'https://legacy-public.invalid',
  },
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
  initData:'',initDataUnsafe:{},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},enableClosingConfirmation(){},
  setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
  HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}},
  openTelegramLink(){},close(){}
}};`;
const playable = `<!doctype html><html><body><canvas></canvas><script>
setTimeout(()=>parent.postMessage({source:'playable',type:'completed',success:true},'*'),50);
</script></body></html>`;

const publicView = {
  owner: { id: 42, first_name: 'Owner', username: null, photo_url: null, is_bot: false },
  buildings: [{
    buildingId,
    slot: 0,
    tpl: 'sort',
    pack: 'neon',
    name: 'Closed mechanic',
    plays: 0,
    likes: 0,
    liked: false,
    rel,
    contentDigest: digest,
    stage: 0,
    foreign_claims: 0,
    bot_claims: 0,
    gift_available_today: true,
  }],
  aiPacks: null,
  deep_link: '',
  share_url: '',
};

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const calls = [];
  let mismatched = false;
  let privateLoads = 0;
  const consoleLines = [];
  await context.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));
  await context.route('https://private.invalid/**', (route) => {
    privateLoads += 1;
    calls.push(`iframe:${route.request().url()}`);
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: playable });
  });
  await context.route('**/api/**', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const json = (value, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    });
    if (url.pathname === '/api/session') {
      return json({
        user: { id: 77, ref_code: 'p5', first_name: 'Guest' },
        ref_code: 'p5',
        balance: 0,
        puzzles: 0,
        is_new: false,
      });
    }
    if (url.pathname === '/api/island/public/42') return json(publicView);
    if (url.pathname === '/api/island/artifact-url') {
      calls.push('resolve');
      assert.equal(url.searchParams.get('building_id'), buildingId);
      return json({
        building_id: buildingId,
        rel,
        contentDigest: mismatched ? `sha256:${'b'.repeat(64)}` : digest,
        url: signedUrl,
        expires_at: '2099-01-01T00:00:00+00:00',
      });
    }
    if (url.pathname === '/api/island/visits/start' && method === 'POST') {
      calls.push('visit');
      return json({
        visit_id: request.postDataJSON().visit_id,
        building_id: buildingId,
        owner_id: 42,
        state: 'active',
        expires_at: '2099-01-01T00:00:00+00:00',
        social: { building_id: buildingId, plays: 0, likes: 0, liked: false },
      });
    }
    if (/^\/api\/island\/visits\/[^/]+\/complete$/.test(url.pathname)) {
      return json({
        social: { building_id: buildingId, plays: 1, likes: 0, liked: false },
      });
    }
    if (/^\/api\/island\/visits\/[^/]+\/result$/.test(url.pathname)) {
      return json({
        disposition: 'zero_policy',
        stage: 0,
        foreign_claims: 0,
        gift: null,
      });
    }
    if (url.pathname === '/api/challenges' && method === 'GET') return json([]);
    if (url.pathname === '/api/events') return json({ accepted: 0 });
    return json({ detail: 'fixture unavailable' }, 404);
  });

  const open = async () => {
    const page = await context.newPage();
    page.on('console', (message) => consoleLines.push(message.text()));
    await page.goto(`${origin}/?initData=p5-browser&island=42`, { waitUntil: 'domcontentloaded' });
    await page.locator('g.isl-sector[data-b="0"]').waitFor({ state: 'attached' });
    return page;
  };

  const page = await open();
  await page.locator('g.isl-sector[data-b="0"]').dispatchEvent('click');
  await page.locator('.isl-win').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(calls[0], 'resolve', 'artifact resolver must run before any visit');
  assert.equal(calls[1], 'visit', 'visit must start only after exact identity resolution');
  assert.equal(calls[2], `iframe:${signedUrl}`, 'iframe did not receive the exact unmodified bearer');
  assert.equal(new URL(calls[2].slice('iframe:'.length)).searchParams.has('auto'), false);
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  assert.doesNotMatch(stored, /device-secret|X-Amz-Signature/);
  assert.doesNotMatch(consoleLines.join('\n'), /device-secret|X-Amz-Signature/);
  assert.equal(
    calls.some((call) => call.includes('legacy-public.invalid')),
    false,
    'client attempted the removed public UGC origin',
  );
  await page.close();

  calls.length = 0;
  mismatched = true;
  const mismatchPage = await open();
  await mismatchPage.locator('g.isl-sector[data-b="0"]').dispatchEvent('click');
  await mismatchPage.locator('.isl-win__t').waitFor({ state: 'visible' });
  assert.match(await mismatchPage.locator('.isl-win__t').textContent(), /недоступна/i);
  assert.deepEqual(calls, ['resolve'], 'identity mismatch started a visit or loaded private bytes');
  assert.equal(privateLoads, 1, 'identity mismatch loaded a second private object');
  await mismatchPage.close();

  console.log('island P5 browser: exact resolver identity, bearer containment and fail-closed mismatch verified');
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}
