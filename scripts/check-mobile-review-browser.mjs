import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { mobileReviewNavigation } from '../src/mobile-review-navigation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = mkdtempSync(path.join(tmpdir(), 'mobile-review-browser-'));
const bundleId = '11111111-1111-4111-8111-111111111111';
const levelBundleId = '44444444-4444-4444-8444-444444444444';
let origin = '';
let sessionRequests = 0;
let decisionBody = null;
let exactDecisionSaved = false;
const decisionDelayMs = 500;

assert.deepEqual(mobileReviewNavigation({ startParam: `review_${bundleId.replaceAll('-', '')}` }), {
  requested: true,
  bundleId,
});
assert.deepEqual(mobileReviewNavigation({ startParam: 'review' }), {
  requested: true,
  bundleId: null,
});
assert.equal(mobileReviewNavigation({ startParam: 'review_bad' }).requested, false);

const view = {
  schema: 'operator.mobile-review-view.v1',
  bundle: {
    schema: 'operator.mobile-review-bundle.v1',
    bundleId,
    bundleDigest: `sha256:${'1'.repeat(64)}`,
    order: {
      orderId: '22222222-2222-4222-8222-222222222222',
      orderHash: '2'.repeat(64),
      eventId: '33333333-3333-4333-8333-333333333333',
      packetDigest: `sha256:${'3'.repeat(64)}`,
      title: 'Phone-native order',
      brief: 'Three short levels in a calm neon world.',
    },
    action: {
      kind: 'exact_approval',
      identity: 'order-approval',
      label: 'Подтвердить запуск заказа',
      sequence: { completed: 0, total: 1 },
    },
    presentation: {
      subject: 'order',
      title: 'Проверка заказа',
      summary: 'Проверьте название, brief и точные параметры.',
      technicalDetails: { hidden: 'until-expanded' },
    },
    review: {
      schema: 'operator.mobile-order-approval.v1',
      summary: {},
      expected: {},
      choices: ['approve'],
    },
    runtime: null,
    createdAt: '2026-07-29T08:00:00.000Z',
  },
  state: 'current',
  decision: null,
  telegramUrl: 'https://t.me/example?startapp=review',
};
const levelView = structuredClone(view);
levelView.bundle.bundleId = levelBundleId;
levelView.bundle.bundleDigest = `sha256:${'4'.repeat(64)}`;
levelView.bundle.action = {
  kind: 'level_review',
  identity: `level-${'6'.repeat(64)}`,
  label: 'Отсмотреть уровень',
  sequence: { completed: 0, total: 1 },
};
levelView.bundle.presentation = {
  subject: 'level',
  title: 'Exact level',
  summary: 'Play this exact level on your phone.',
  technicalDetails: {},
};
levelView.bundle.review = {
  schema: 'operator.mobile-level-output.v1',
  output: { reviewTargetId: levelView.bundle.action.identity },
  choices: ['good', 'problem', 'rework', 'retired'],
};
levelView.bundle.runtime = {
  schema: 'operator.mobile-review-runtime.v1',
  previews: [{
    reviewTargetId: levelView.bundle.action.identity,
    label: 'Level one',
    playableId: 'marble-sort-swipe',
    runtimeContractDigest: `sha256:${'7'.repeat(64)}`,
    runtimeArtifactDigest: `sha256:${'8'.repeat(64)}`,
    levels: [{
      ordinal: 1,
      spec: { schema: 'sort.level-spec.v1', specHash: '9'.repeat(64) },
      specHash: '9'.repeat(64),
    }],
    skin: null,
  }],
};

const fakeRuntime = `<!doctype html><html><body><canvas></canvas><script>
const contract = '${'7'.repeat(64)}';
const artifact = 'sha256:${'8'.repeat(64)}';
addEventListener('message', (event) => {
  if (event.data?.type !== 'configure_level') return;
  parent.postMessage({
    type: 'configured',
    appliedSpecHash: event.data.spec.specHash,
    runtimeContractDigest: contract,
    runtimeArtifactDigest: artifact,
  }, location.origin);
});
addEventListener('load', () => parent.postMessage({
  type: 'configure_ready',
  nonce: 'mobile-review-nonce-1234',
  runtimeContractDigest: contract,
  runtimeArtifactDigest: artifact,
}, location.origin));
</script></body></html>`;

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
};

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  if (request.method === 'POST' && url.pathname === '/api/session') {
    sessionRequests += 1;
    return json(response, {});
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${bundleId}`) {
    return json(response, view);
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${levelBundleId}`) {
    return json(response, levelView);
  }
  if (request.method === 'GET' && url.pathname === '/api/operator/mobile-reviews') {
    return json(response, {
      schema: 'operator.mobile-review-inbox.v1',
      reviews: exactDecisionSaved ? [levelView] : [view],
    });
  }
  if (request.method === 'POST' && /^\/api\/operator\/mobile-reviews\/[a-f0-9-]{36}\/decisions$/.test(url.pathname)) {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      decisionBody = JSON.parse(body);
      const source = url.pathname.includes(levelBundleId) ? levelView : view;
      if (source === view) exactDecisionSaved = true;
      setTimeout(() => {
        json(response, { ...source, state: 'decided', decision: { document: decisionBody } });
      }, decisionDelayMs);
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(readFileSync(path.join(buildRoot, 'index.html')));
    return;
  }
  if (url.pathname === '/marble-sort-swipe.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fakeRuntime);
    return;
  }
  response.statusCode = 404;
  response.end();
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;

const build = spawnSync('npx', [
  '--no-install', 'vite', 'build', '--outDir', buildRoot, '--emptyOutDir',
], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, VITE_API_BASE: origin },
  timeout: 120_000,
});
if (build.status !== 0) {
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
  assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
}

let browser = null;
try {
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await page.goto(`${origin}/?mobileReview=${bundleId}`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Phone-native order' }).waitFor();
  await assert.doesNotReject(() => page.getByText('Three short levels in a calm neon world.').waitFor());
  assert.equal(await page.getByText('hidden: until-expanded').count(), 0);
  assert.equal(sessionRequests, 0, 'mobile review route must not boot the playable feed');
  const clickAck = await page.evaluate(() => {
    const action = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('Подтвердить exact шаг'));
    const started = performance.now();
    action.click();
    return {
      durationMs: performance.now() - started,
      disabled: action.disabled,
      notice: document.querySelector('[data-mobile-review-notice]')?.textContent || '',
    };
  });
  assert.equal(clickAck.disabled, true, 'effectful action must disable synchronously');
  assert.match(clickAck.notice, /Сохраняем решение/, 'effectful action must acknowledge synchronously');
  assert.ok(clickAck.durationMs <= 100, `click acknowledgement exceeded 100 ms: ${clickAck.durationMs}`);
  await page.getByRole('heading', { name: 'Решение сохранено' }).waitFor();
  assert.equal(decisionBody?.decision?.schema, 'operator.mobile-order-approval-decision.v1');
  assert.equal(decisionBody?.decision?.choice, 'approve');
  assert.match(decisionBody?.mutationId || '', /^[a-f0-9-]{36}$/);
  await page.getByRole('heading', { name: 'Exact level' }).waitFor({ timeout: 4_000 });

  decisionBody = null;
  const levelPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await levelPage.goto(`${origin}/?mobileReview=${levelBundleId}`, { waitUntil: 'networkidle' });
  await levelPage.getByText('Exact preview подтверждён для всех уровней.').waitFor();
  await levelPage.getByRole('button', { name: 'Подходит' }).click();
  await levelPage.getByRole('heading', { name: 'Решение сохранено' }).waitFor();
  assert.equal(decisionBody?.decision?.schema, 'operator.mobile-taste-review-decision.v1');
  assert.equal(decisionBody?.decision?.preview?.configured, true);
  assert.equal(decisionBody?.decision?.preview?.reviewTargetId, levelView.bundle.action.identity);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}

console.log('mobile review browser: isolated TMA route, human copy, hidden technical identity and exact decision verified');
