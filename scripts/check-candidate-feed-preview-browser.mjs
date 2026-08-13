import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseId = '8b447be0-f961-482e-aa03-b419d5f1492d';
const playableId = 'solitaire-v1-swipe';
const candidatePath = `/playable-previews/${releaseId}/${playableId}.html`;
const candidateArtifactDigest = '9'.repeat(64);
const binding = {
  schema: 'feed.playable-release-review-binding.v1',
  releaseId,
  playableId,
  candidatePath,
  candidateArtifactDigest,
  review: {
    kind: 'rework',
    reworkRequestId: '9b447be0-f961-482e-aa03-b419d5f1492d',
    sourceId: null,
    sourceCommit: null,
  },
};
const bindingBytes = Buffer.from(JSON.stringify(binding));
const reviewBindingDigest = createHash('sha256').update(bindingBytes).digest('hex');
const requests = [];
let origin = '';

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
};

const playableHtml = (id, candidate = false) => `<!doctype html><html><head><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${candidate ? '#71491f' : '#17325a'}}
#marker{display:grid;place-items:center;width:100%;height:100%;color:white;font:700 18px system-ui}
</style></head><body><div id="marker">${candidate ? 'EXACT IMMUTABLE CANDIDATE' : `LIVE NEIGHBOR ${id}`}</div><script>
const id=${JSON.stringify(id)};
const candidate=${JSON.stringify(candidate)};
const record=(type)=>{const key='__candidate_feed_commands';const values=JSON.parse(parent.sessionStorage.getItem(key)||'[]');values.push({id,type});parent.sessionStorage.setItem(key,JSON.stringify(values));};
const send=(type)=>parent.postMessage({source:'playable',id,type},'*');
addEventListener('message',(event)=>{if(event.source!==parent||event.data?.target!=='playable-swipe')return;record(event.data.type);if(event.data.type==='prepareInteractive')send('interactive_ready');});
addEventListener('load',()=>send('static_ready'));
</script></body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  requests.push(`${request.method} ${url.pathname}${url.search}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(readFileSync(path.join(root, 'dist', 'index.html')));
  }
  if (url.pathname === '/versions.json') return json(response, {
    'solitaire-v1-swipe': 'live-solitaire',
    'merge-locked-v1-swipe': 'live-merge',
    'marble-sort-swipe': 'live-marble',
  });
  if (url.pathname === `/playable-previews/${releaseId}/review-binding.json`) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', String(bindingBytes.length));
    return response.end(bindingBytes);
  }
  if (url.pathname === candidatePath) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(playableHtml(playableId, true));
  }
  if (url.pathname === candidatePath.replace(/\.html$/, '.payload.js')) {
    response.setHeader('content-type', 'application/javascript; charset=utf-8');
    return response.end('/* immutable candidate payload */');
  }
  if (/^\/[A-Za-z0-9._-]+\.html$/.test(url.pathname)) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(playableHtml(url.pathname.slice(1, -5), false));
  }
  if (/^\/[A-Za-z0-9._-]+\.payload\.js$/.test(url.pathname)) {
    response.setHeader('content-type', 'application/javascript; charset=utf-8');
    return response.end('/* live neighbor payload */');
  }
  if (url.pathname.startsWith('/api/')) return json(response, { code: 'unexpected_api_call' }, 500);
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
initData:'query_id=candidate&user=%7B%22id%22%3A42%7D&hash=candidate',
initDataUnsafe:{user:{id:42},start_param:null},platform:'android',
ready(){},expand(){},requestFullscreen(){},disableVerticalSwipes(){},
setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}
}};`;

const query = new URLSearchParams({
  candidateFeedRelease: releaseId,
  candidateFeedPlayable: playableId,
  candidateFeedArtifact: candidateArtifactDigest,
  candidateFeedBinding: reviewBindingDigest,
});
const validUrl = `${origin}/?${query}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));
  const page = await context.newPage();
  await page.goto(validUrl, { waitUntil: 'domcontentloaded' });
  await page.getByText('Кандидат — не опубликовано', { exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.__feedWarm?.().current === 0);
  assert.equal(await page.locator('.page').first().locator('.game__label').textContent(), playableId);
  assert.equal(await page.locator('.page').nth(1).locator('.game__label').textContent(), 'merge-locked-v1-swipe');

  const frame = page.locator('.page').first().locator('iframe');
  await frame.waitFor({ state: 'attached' });
  const frameUrl = new URL((await frame.getAttribute('src')) || '', origin);
  assert.equal(frameUrl.origin, origin);
  assert.equal(frameUrl.pathname, candidatePath);
  assert.equal(frameUrl.searchParams.get('reviewBinding'), reviewBindingDigest);
  assert.equal(frameUrl.searchParams.get('artifact'), candidateArtifactDigest);
  await frame.contentFrame().getByText('EXACT IMMUTABLE CANDIDATE', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const commands = JSON.parse(sessionStorage.getItem('__candidate_feed_commands') || '[]');
    return ['setHostPaused', 'prepareInteractive', 'startAutoPlay']
      .every((type) => commands.some((entry) => entry.id === 'solitaire-v1-swipe' && entry.type === type));
  });
  await page.waitForTimeout(5_100);
  assert.equal(requests.some((entry) => entry.includes('/api/session')), false,
    `candidate preview inherited Telegram session authority: ${requests.join(', ')}`);
  assert.equal(requests.some((entry) => entry.startsWith('POST /api/')), false,
    `candidate preview emitted a backend mutation: ${requests.join(', ')}`);

  await page.locator('[data-bar-tab="feed"]').click();
  await page.waitForFunction(() => window.__feedWarm?.().current === 1);
  await page.waitForTimeout(520);
  const neighbor = page.locator('.page--in-viewport iframe').first();
  const neighborUrl = new URL((await neighbor.getAttribute('src')) || '', origin);
  assert.equal(neighborUrl.pathname, '/merge-locked-v1-swipe.html');
  await neighbor.contentFrame().getByText('LIVE NEIGHBOR merge-locked-v1-swipe', { exact: true }).waitFor();

  await page.goto(validUrl, { waitUntil: 'domcontentloaded' });
  await page.getByText('Кандидат — не опубликовано', { exact: true }).waitFor({ state: 'visible' });
  const takeover = page.locator('.page--in-viewport .game__autoplay').first();
  await takeover.click({ position: { x: 50, y: 80 } });
  await page.locator('.page--in-viewport .game--manual').waitFor({ state: 'visible' });
  const manualFrameUrl = new URL((await page.locator('.page--in-viewport iframe').getAttribute('src')) || '', origin);
  assert.equal(manualFrameUrl.pathname, candidatePath);
  assert.equal(manualFrameUrl.searchParams.get('auto'), '0');

  const badDigest = new URL(validUrl);
  badDigest.searchParams.set('candidateFeedBinding', '0'.repeat(64));
  await page.goto(badDigest.toString(), { waitUntil: 'domcontentloaded' });
  await page.getByText('Candidate недоступен', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('iframe').count(), 0, 'invalid binding fell back to the ordinary feed');

  const arbitraryBase = new URL(validUrl);
  arbitraryBase.searchParams.set('base', 'https://attacker.invalid/');
  await page.goto(arbitraryBase.toString(), { waitUntil: 'domcontentloaded' });
  await page.getByText('Candidate недоступен', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('iframe').count(), 0, 'external base override reached a playable frame');

  const partial = new URL(origin);
  partial.searchParams.set('candidateFeedRelease', releaseId);
  await page.goto(partial.toString(), { waitUntil: 'domcontentloaded' });
  await page.getByText('Candidate недоступен', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('iframe').count(), 0, 'partial identity fell back to the ordinary feed');

  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('candidate feed preview browser contract: PASS');
