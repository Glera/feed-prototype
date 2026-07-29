import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const prototypeBundleId = '55555555-5555-4555-8555-555555555555';
const maliciousPrototypeBundleId = '99999999-9999-4999-8999-999999999999';
const expiredPrototypeBundleId = '12121212-1212-4121-8121-121212121212';
const redirectedPrototypeBundleId = '13131313-1313-4131-8131-131313131313';
const cspMissingPrototypeBundleId = '14141414-1414-4141-8141-141414141414';
const factoryBundleId = '66666666-6666-4666-8666-666666666666';
const publicationPrepareBundleId = '77777777-7777-4777-8777-777777777777';
const publicationApproveBundleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let origin = '';
let sessionRequests = 0;
let decisionBody = null;
const levelDecisionBodies = [];
let exactDecisionSaved = false;
let inboxRequests = 0;
const decisionDelayMs = 500;
let escapeRequests = 0;
const catalogLabDecisions = [];
const previewRequests = new Map();
let cspCorpusRequests = 0;
const previewCsp = [
  'sandbox allow-scripts allow-pointer-lock',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  'frame-ancestors *',
].join('; ');
const artifactCsp = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const mobileReviewBridge = [
  `<meta http-equiv="Content-Security-Policy" content="${artifactCsp}">`,
  '<script data-p4g-mobile-review-bridge="v1">',
  "(()=>{addEventListener('message',event=>{",
  "const value=event.data;if(event.source!==parent||!value||typeof value!=='object'",
  "||Array.isArray(value)||value.schema!=='p4g.mobile-review-preview-challenge.v1'",
  "||typeof value.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(value.nonce))return;",
  "parent.postMessage({schema:'p4g.mobile-review-preview-receipt.v1',nonce:value.nonce},'*');",
  '});})();',
  '</script>',
].join('');
const mobileArtifact = (html) => Buffer.from(
  html.replace(/^(?:\uFEFF)?<!doctype[^>]*>/i, (doctype) => `${doctype}${mobileReviewBridge}`),
);
const escapeServer = createServer((_request, response) => {
  escapeRequests += 1;
  response.end('escaped');
});
await new Promise((resolve, reject) => {
  escapeServer.once('error', reject);
  escapeServer.listen(0, '127.0.0.1', resolve);
});
const escapeOrigin = `http://127.0.0.1:${escapeServer.address().port}`;
const cspCorpusDocuments = Array.from({ length: 45 }, (_unused, index) => (
  `<!doctype html><html data-vector="${index}"><head>`
  + `<script src="${escapeOrigin}/corpus-script-${index}.js"></script>`
  + `</head><body><img src="${escapeOrigin}/corpus-image-${index}.png">`
  + `<script>document.body.dataset.inline='${index}'</script></body></html>`
));

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
      technicalDetails: {
        hidden: 'until-expanded',
        provider: 'must-never-enter-the-dom',
        model: 'must-never-enter-the-dom',
      },
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
  rework: { mode: 'server_recommended' },
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

const prototypeHtml = mobileArtifact(`<!doctype html><html><head></head><body>
<button id="play">Prototype ready</button>
<script>document.querySelector('#play').onclick=()=>document.body.dataset.played='1'</script>
</body></html>`);
const prototypeDigest = `sha256:${createHash('sha256').update(prototypeHtml).digest('hex')}`;
const maliciousPrototypeHtml = mobileArtifact(`<!doctype html><!-- <head> -->
<html><head><script src="${escapeOrigin}/remote.js"></script></head>
<body><img src="${escapeOrigin}/pixel.png">
<script>setTimeout(()=>{location.href='/csp-corpus-host'},1500)</script>
</body></html>`);
const maliciousPrototypeDigest = `sha256:${createHash('sha256').update(maliciousPrototypeHtml).digest('hex')}`;
const prototypeView = structuredClone(view);
prototypeView.bundle.bundleId = prototypeBundleId;
prototypeView.bundle.bundleDigest = `sha256:${'5'.repeat(64)}`;
prototypeView.bundle.action = {
  kind: 'prototype_review',
  identity: 'wild-sort-mobile',
  label: 'Оценить экспериментальный прототип',
  sequence: { completed: 0, total: 1 },
};
prototypeView.bundle.presentation = {
  subject: 'prototype',
  title: 'Wild Sort prototype',
  summary: 'Play freely and dictate the insight.',
  technicalDetails: { source: 'lab_backlog' },
};
prototypeView.bundle.review = {
  schema: 'operator.mobile-prototype-output.v1',
  output: { prototypeId: 'wild-sort-mobile' },
  choices: ['promising', 'insight_only', 'no_signal', 'retired'],
};
prototypeView.bundle.runtime = {
  schema: 'operator.mobile-html-runtime.v1',
  previews: [{
    reviewTargetId: 'wild-sort-mobile',
    label: 'Wild Sort',
    artifactDigest: prototypeDigest,
    byteLength: prototypeHtml.length,
    contentType: 'text/html',
  }],
};
const maliciousPrototypeView = structuredClone(prototypeView);
maliciousPrototypeView.bundle.bundleId = maliciousPrototypeBundleId;
maliciousPrototypeView.bundle.bundleDigest = `sha256:${'9'.repeat(64)}`;
maliciousPrototypeView.bundle.runtime.previews[0].artifactDigest = maliciousPrototypeDigest;
maliciousPrototypeView.bundle.runtime.previews[0].byteLength = maliciousPrototypeHtml.length;
const faultPrototypeViews = new Map([
  [expiredPrototypeBundleId, 'expired'],
  [redirectedPrototypeBundleId, 'redirected'],
  [cspMissingPrototypeBundleId, 'missing-csp'],
].map(([bundle, reason]) => {
  const value = structuredClone(prototypeView);
  value.bundle.bundleId = bundle;
  value.bundle.bundleDigest = `sha256:${reason.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`;
  return [bundle, value];
}));

const factoryView = structuredClone(view);
factoryView.bundle.bundleId = factoryBundleId;
factoryView.bundle.bundleDigest = `sha256:${'6'.repeat(64)}`;
factoryView.bundle.action = {
  kind: 'factory_review',
  identity: 'f'.repeat(64),
  label: 'Отсмотреть proof фабрики',
  sequence: { completed: 0, total: 1 },
};
factoryView.bundle.presentation = {
  subject: 'level_factory',
  title: 'Factory proof',
  summary: 'Check the exact factory sample.',
  technicalDetails: {},
};
factoryView.bundle.review = {
  schema: 'operator.mobile-factory-proof.v1',
  factoryHash: 'f'.repeat(64),
  lane: 'level_design',
  proof: {
    projection: { metrics: { successes: 2, attemptsTotal: 2 } },
  },
};
factoryView.bundle.runtime = null;

const publicationPrepareView = structuredClone(view);
publicationPrepareView.bundle.bundleId = publicationPrepareBundleId;
publicationPrepareView.bundle.bundleDigest = `sha256:${'7'.repeat(64)}`;
publicationPrepareView.bundle.action = {
  kind: 'publication_prepare',
  identity: 'a'.repeat(64),
  label: 'Подготовить exact-публикацию',
  sequence: { completed: 0, total: 1 },
};
publicationPrepareView.bundle.presentation = {
  subject: 'publication',
  title: 'Подготовить публикацию',
  summary: 'Create the exact content-bound Telegram confirmation.',
  technicalDetails: {},
};
publicationPrepareView.bundle.review = {
  schema: 'operator.mobile-publication-preparation.v1',
  publication: {
    draftId: '88888888-8888-4888-8888-888888888888',
    revision: 1,
    bindingHash: 'a'.repeat(64),
  },
  choices: ['prepare'],
};
publicationPrepareView.bundle.runtime = null;

const publicationApproveView = structuredClone(view);
publicationApproveView.bundle.bundleId = publicationApproveBundleId;
publicationApproveView.bundle.bundleDigest = `sha256:${'8'.repeat(64)}`;
publicationApproveView.bundle.action = {
  kind: 'telegram_approve',
  identity: 'b'.repeat(64),
  label: 'Подтвердить exact-публикацию',
  sequence: { completed: 0, total: 1 },
};
publicationApproveView.bundle.presentation = {
  subject: 'publication',
  title: 'Exact publication',
  summary: 'Approve only these exact bytes.',
  technicalDetails: {},
};
publicationApproveView.bundle.review = {
  schema: 'operator.mobile-publication-approval.v1',
  publication: {
    flow: {
      state: 'pending',
      auth: { userCode: 'ABCD-EFGH' },
    },
  },
};
publicationApproveView.bundle.runtime = null;

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
  const corpus = /^\/csp-corpus\/([0-9]+)$/.exec(url.pathname);
  if (request.method === 'GET' && corpus) {
    const document = cspCorpusDocuments[Number(corpus[1])];
    if (document == null) {
      response.statusCode = 404;
      response.end();
      return;
    }
    cspCorpusRequests += 1;
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy', previewCsp);
    response.end(document);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/csp-corpus-host') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<!doctype html><html><body></body></html>');
    return;
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${bundleId}`) {
    return json(response, view);
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${levelBundleId}`) {
    return json(response, levelView);
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${prototypeBundleId}`) {
    return json(response, prototypeView);
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${maliciousPrototypeBundleId}`) {
    return json(response, maliciousPrototypeView);
  }
  for (const [faultBundleId, faultView] of faultPrototypeViews) {
    if (request.method === 'GET'
      && url.pathname === `/api/operator/mobile-reviews/${faultBundleId}`) {
      return json(response, faultView);
    }
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${factoryBundleId}`) {
    return json(response, factoryView);
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${publicationPrepareBundleId}`) {
    return json(response, publicationPrepareView);
  }
  if (request.method === 'GET' && url.pathname === `/api/operator/mobile-reviews/${publicationApproveBundleId}`) {
    return json(response, publicationApproveView);
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/device-auth/lookup') {
    return json(response, {
      authorizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      userCode: 'ABCD-EFGH',
      decisionVersion: 1,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/admin/device-auth/decision') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      catalogLabDecisions.push(JSON.parse(body));
      json(response, { state: 'denied', decisionVersion: 2 });
    });
    return;
  }
  const ticket = /^\/api\/operator\/mobile-reviews\/([a-f0-9-]{36})\/artifacts\/([a-f0-9]{64})\/preview-tickets$/.exec(url.pathname);
  if (request.method === 'POST' && ticket) {
    const artifact = ticket[2] === prototypeDigest.slice(7)
      ? prototypeDigest
      : ticket[2] === maliciousPrototypeDigest.slice(7)
        ? maliciousPrototypeDigest
        : null;
    if (!artifact) return json(response, { code: 'mobile_review_not_found' }, 404);
    return json(response, {
      schema: 'operator.mobile-review-preview-ticket.v1',
      bundleId: ticket[1],
      artifactDigest: artifact,
      expiresAtEpoch: 2_000_000_000,
      signature: 'a'.repeat(64),
      previewPath: `/api/operator/mobile-reviews/artifacts/${ticket[2]}/preview`
        + `?bundleId=${ticket[1]}&expires=2000000000&signature=${'a'.repeat(64)}`,
    });
  }
  if (request.method === 'GET'
    && url.pathname === `/api/operator/mobile-reviews/artifacts/${prototypeDigest.slice(7)}/preview`) {
    previewRequests.set(prototypeDigest, (previewRequests.get(prototypeDigest) || 0) + 1);
    const ticketBundleId = url.searchParams.get('bundleId');
    if (ticketBundleId === expiredPrototypeBundleId) {
      return json(response, { code: 'mobile_review_preview_ticket_expired' }, 403);
    }
    if (ticketBundleId === redirectedPrototypeBundleId) {
      response.statusCode = 302;
      response.setHeader('location', `${escapeOrigin}/redirected-preview`);
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html');
    response.setHeader('X-Content-SHA256', prototypeDigest);
    if (ticketBundleId !== cspMissingPrototypeBundleId) {
      response.setHeader('Content-Security-Policy', previewCsp);
    }
    response.end(prototypeHtml);
    return;
  }
  if (request.method === 'GET'
    && url.pathname === `/api/operator/mobile-reviews/artifacts/${maliciousPrototypeDigest.slice(7)}/preview`) {
    previewRequests.set(
      maliciousPrototypeDigest,
      (previewRequests.get(maliciousPrototypeDigest) || 0) + 1,
    );
    response.statusCode = 200;
    response.setHeader('content-type', 'text/html');
    response.setHeader('X-Content-SHA256', maliciousPrototypeDigest);
    response.setHeader('Content-Security-Policy', previewCsp);
    response.end(maliciousPrototypeHtml);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/operator/mobile-reviews') {
    inboxRequests += 1;
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
      const source = url.pathname.includes(levelBundleId)
        ? levelView
        : url.pathname.includes(prototypeBundleId)
          ? prototypeView
          : url.pathname.includes(publicationPrepareBundleId)
            ? publicationPrepareView
            : view;
      if (source === view) exactDecisionSaved = true;
      if (source === levelView) {
        levelDecisionBodies.push(decisionBody);
        if (levelDecisionBodies.length === 1) {
          return json(response, { code: 'response_lost_after_commit' }, 503);
        }
      }
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
  await new Promise((resolve) => escapeServer.close(resolve));
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
  assert.equal((await page.locator('body').evaluate((body) => body.innerHTML)).includes('provider'), false);
  assert.equal((await page.locator('body').evaluate((body) => body.innerHTML)).includes('must-never-enter-the-dom'), false);
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
  await page.waitForTimeout(2_500);
  await page.getByRole('heading', { name: 'Решение сохранено' }).waitFor();
  assert.match(page.url(), new RegExp(bundleId), 'saved decision must not auto-follow');
  assert.equal(inboxRequests, 0, 'saved decision must not poll/follow the inbox');
  assert.equal(decisionBody?.decision?.schema, 'operator.mobile-order-approval-decision.v1');
  assert.equal(decisionBody?.decision?.choice, 'approve');
  assert.match(decisionBody?.mutationId || '', /^[a-f0-9-]{36}$/);
  await page.getByRole('button', { name: 'Проверить следующие шаги' }).click();
  assert.equal(inboxRequests, 1, 'only the explicit next button may follow the inbox');
  await page.getByRole('button', { name: /Отсмотреть уровень/ }).click();
  await page.getByRole('heading', { name: 'Exact level' }).waitFor({ timeout: 4_000 });

  decisionBody = null;
  const levelContext = await browser.newContext({ viewport: { width: 390, height: 760 } });
  const levelPage = await levelContext.newPage();
  await levelPage.goto(`${origin}/?mobileReview=${levelBundleId}`, { waitUntil: 'networkidle' });
  await levelPage.getByText('Exact preview подтверждён для всех уровней.').waitFor();
  assert.equal((await levelPage.locator('body').evaluate((body) => body.innerHTML)).includes('provider'), false);
  await levelPage.getByRole('button', { name: 'Подходит' }).click();
  await levelPage.getByText(/HTTP 503/).waitFor();
  await levelPage.reload({ waitUntil: 'networkidle' });
  await levelPage.getByText('Exact preview подтверждён для всех уровней.').waitFor();
  await levelPage.getByRole('button', { name: 'Подходит' }).click();
  await levelPage.getByRole('heading', { name: 'Решение сохранено' }).waitFor();
  assert.equal(decisionBody?.decision?.schema, 'operator.mobile-taste-review-decision.v1');
  assert.equal(decisionBody?.decision?.preview?.configured, true);
  assert.equal(decisionBody?.decision?.preview?.reviewTargetId, levelView.bundle.action.identity);
  assert.equal(levelDecisionBodies.length, 2);
  assert.equal(levelDecisionBodies[1].mutationId, levelDecisionBodies[0].mutationId);
  assert.deepEqual(levelDecisionBodies[1].decision, levelDecisionBodies[0].decision);
  const originalLevelBundleDigest = levelView.bundle.bundleDigest;
  const originalLevelMutationId = levelDecisionBodies[0].mutationId;
  levelView.bundle.bundleDigest = `sha256:${'c'.repeat(64)}`;
  await levelPage.reload({ waitUntil: 'networkidle' });
  await levelPage.getByText('Exact preview подтверждён для всех уровней.').waitFor();
  await levelPage.getByRole('button', { name: 'Подходит' }).click();
  await levelPage.getByRole('heading', { name: 'Решение сохранено' }).waitFor();
  assert.notEqual(
    levelDecisionBodies[2].mutationId,
    levelDecisionBodies[1].mutationId,
    'a new exact bundle digest must receive a new mutation identity',
  );
  levelView.bundle.bundleDigest = originalLevelBundleDigest;
  await levelPage.close();
  const levelReplayPage = await levelContext.newPage();
  await levelReplayPage.goto(
    `${origin}/?mobileReview=${levelBundleId}`,
    { waitUntil: 'networkidle' },
  );
  await levelReplayPage.getByText('Exact preview подтверждён для всех уровней.').waitFor();
  await levelReplayPage.getByRole('button', { name: 'Подходит' }).click();
  await levelReplayPage.getByRole('heading', { name: 'Решение сохранено' }).waitFor();
  assert.equal(
    levelDecisionBodies[3].mutationId,
    originalLevelMutationId,
    'A → B → A in a new page must replay A’s original mutation identity',
  );
  await levelReplayPage.close();
  await levelContext.close();

  decisionBody = null;
  const prototypeContext = await browser.newContext({
    viewport: { width: 390, height: 760 },
  });
  let prototypePage = await prototypeContext.newPage();
  const observedPrototypeCsp = [];
  prototypePage.on('response', async (response) => {
    if (response.url().includes(`/artifacts/${prototypeDigest.slice(7)}/preview?`)) {
      observedPrototypeCsp.push(
        await response.headerValue('content-security-policy'),
      );
    }
  });
  await prototypePage.addInitScript(() => {
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      value: undefined,
    });
  });
  await prototypePage.goto(`${origin}/?mobileReview=${prototypeBundleId}`, { waitUntil: 'networkidle' });
  await prototypePage.getByText('Exact-прототип загружен.').waitFor();
  const prototypeFrame = prototypePage.frames().find(
    (frame) => frame !== prototypePage.mainFrame()
      && frame.url() === 'about:srcdoc',
  );
  assert.ok(prototypeFrame, 'sandbox prototype frame must use the verified srcdoc bytes');
  assert.equal(await prototypeFrame.evaluate(() => document.compatMode), 'CSS1Compat');
  assert.equal(previewRequests.get(prototypeDigest), 1, 'verified bytes must be fetched exactly once');
  assert.deepEqual(
    observedPrototypeCsp,
    [previewCsp],
    'the one backend verification response must carry the real HTTP CSP',
  );
  await prototypeFrame.evaluate(() => location.reload());
  await prototypePage.waitForTimeout(1_000);
  await prototypePage.getByText('Exact-прототип загружен.').waitFor();
  assert.equal(await prototypePage.locator('iframe').count(), 1);
  assert.equal(
    previewRequests.get(prototypeDigest),
    1,
    'an engine reload must replay the same staged exact bytes, not fetch the backend again',
  );
  await prototypePage.getByRole('button', { name: /Надиктовать/ }).click();
  await prototypePage.getByText(/микрофон на клавиатуре Telegram/).waitFor();
  const feedback = 'Оставить идею reveal, упростить первый жест';
  await prototypePage.getByLabel('Комментарий').fill(feedback);
  await prototypePage.close();
  prototypePage = await prototypeContext.newPage();
  await prototypePage.goto(
    `${origin}/?mobileReview=${prototypeBundleId}`,
    { waitUntil: 'networkidle' },
  );
  await prototypePage.getByText('Exact-прототип загружен.').waitFor();
  assert.equal(
    await prototypePage.getByLabel('Комментарий').inputValue(),
    feedback,
    'draft must survive a new WebView/tab, not only a reload in sessionStorage',
  );
  await prototypePage.waitForTimeout(1_250);
  assert.equal(escapeRequests, 0, 'parent frame-src must block meta-refresh navigation');
  assert.equal(await prototypePage.locator('iframe').count(), 1);
  await prototypePage.getByRole('button', { name: 'Перспективно' }).click();
  await prototypePage.getByRole('heading', { name: 'Решение сохранено' }).waitFor();
  await prototypeContext.close();

  const maliciousPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await maliciousPage.goto(
    `${origin}/?mobileReview=${maliciousPrototypeBundleId}`,
    { waitUntil: 'domcontentloaded' },
  );
  await maliciousPage.getByText('Exact-прототип загружен.').waitFor();
  assert.equal(await maliciousPage.locator('iframe').count(), 1);
  assert.equal(previewRequests.get(maliciousPrototypeDigest), 1);
  assert.equal(escapeRequests, 0, 'real response CSP must block remote scripts and images');
  await maliciousPage.getByText(/попытался покинуть exact sandbox/).waitFor();
  assert.equal(
    await maliciousPage.locator('iframe').count(),
    0,
    'a same-origin second navigation must invalidate exact prototype evidence',
  );

  for (const [faultBundleId] of faultPrototypeViews) {
    decisionBody = null;
    const faultPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
    await faultPage.goto(
      `${origin}/?mobileReview=${faultBundleId}`,
      { waitUntil: 'networkidle' },
    );
    await faultPage.getByText(/Нет связи с сервером|HTTP 403/).waitFor();
    assert.equal(
      await faultPage.getByText('Exact-прототип загружен.').count(),
      0,
      'an invalid delivery must never surface configured evidence',
    );
    await faultPage.getByRole('button', { name: 'Перспективно' }).click();
    await faultPage.getByText(/нарушил sandbox/).waitFor();
    assert.equal(decisionBody, null, 'an invalid preview delivery must block the decision POST');
    await faultPage.close();
  }

  const escapeRequestsBeforeCorpus = escapeRequests;
  const corpusPage = await browser.newPage();
  await corpusPage.goto(`${origin}/csp-corpus-host`, { waitUntil: 'networkidle' });
  await corpusPage.evaluate((count) => {
    for (let index = 0; index < count; index += 1) {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
      frame.src = `/csp-corpus/${index}`;
      document.body.append(frame);
    }
  }, cspCorpusDocuments.length);
  await corpusPage.locator('iframe').nth(cspCorpusDocuments.length - 1).waitFor();
  await corpusPage.waitForTimeout(500);
  assert.equal(cspCorpusRequests, 45);
  assert.equal(
    escapeRequests,
    escapeRequestsBeforeCorpus,
    'all 45 valid attack documents must be inert under response-header CSP',
  );

  const factoryPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await factoryPage.goto(`${origin}/?mobileReview=${factoryBundleId}`, { waitUntil: 'networkidle' });
  const factoryChecks = factoryPage.locator('input[type="checkbox"]');
  for (let index = 0; index < 5; index += 1) {
    await factoryChecks.nth(index).click();
  }
  await factoryPage.reload({ waitUntil: 'networkidle' });
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      await factoryPage.locator('input[type="checkbox"]').nth(index).isChecked(),
      true,
    );
  }

  decisionBody = null;
  const preparePage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await preparePage.goto(`${origin}/?mobileReview=${publicationPrepareBundleId}`, { waitUntil: 'networkidle' });
  await preparePage.getByText(/Это ещё не публикует серию/).waitFor();
  await preparePage.getByRole('button', { name: 'Подготовить exact-публикацию' }).click();
  await preparePage.getByRole('heading', { name: 'Решение сохранено' }).waitFor();
  assert.deepEqual(decisionBody?.decision, {
    schema: 'operator.mobile-publication-preparation-decision.v1',
    choice: 'prepare',
  });

  const cancelPage = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await cancelPage.goto(`${origin}/?mobileReview=${publicationApproveBundleId}`, { waitUntil: 'networkidle' });
  await cancelPage.getByRole('button', { name: 'Отменить публикацию' }).click();
  await cancelPage.getByText('Публикация отменена. Серия не будет опубликована.').waitFor();
  assert.deepEqual(catalogLabDecisions, [{
    authorizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    userCode: 'ABCD-EFGH',
    expectedDecisionVersion: 1,
    decision: 'deny',
  }]);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => escapeServer.close(resolve));
  rmSync(buildRoot, { recursive: true, force: true });
}

console.log('mobile review browser: queue, exact sort + sandbox HTML, editable voice fallback and decisions verified');
