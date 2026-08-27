import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { encodeCandidateFeedStartParam } from '../src/candidate-feed-start-param.mjs';
import {
  generatedInsertionBlockedIndices,
  generatedInsertionTarget,
} from '../src/catalog-feed-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SHA = 'b'.repeat(40);
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
const sourceReleaseId = '9c558cf1-239d-5aa5-9dc9-0cfdf6cd37fe';
const sourceCandidatePath = `/playable-previews/${sourceReleaseId}/${playableId}.html`;
const sourceCandidateArtifactDigest = '8'.repeat(64);
const sourceBinding = {
  schema: 'feed.playable-release-review-binding.v1',
  releaseId: sourceReleaseId,
  playableId,
  candidatePath: sourceCandidatePath,
  candidateArtifactDigest: sourceCandidateArtifactDigest,
  review: {
    kind: 'source',
    reworkRequestId: null,
    sourceId: 'solitaire-v1',
    sourceCommit: '7'.repeat(40),
  },
};
const sourceBindingBytes = Buffer.from(JSON.stringify(sourceBinding));
const sourceReviewBindingDigest = createHash('sha256').update(sourceBindingBytes).digest('hex');
const candidateStartParam = encodeCandidateFeedStartParam({
  releaseId: sourceReleaseId,
  reviewBindingDigest: sourceReviewBindingDigest,
});
const rosterEntries = [
  {
    builtinMappingId: '11111111-1111-4111-8111-111111111111',
    playableId: 'marble-sort-swipe',
    variantId: '11111111-1111-1111-1111-111111111111',
    catalogMechanic: 'marble-sort',
    mappingDigest: '1'.repeat(64),
    mappingState: 'active',
  },
  {
    builtinMappingId: '22222222-2222-4222-8222-222222222222',
    playableId,
    variantId: '22222222-2222-2222-2222-222222222222',
    catalogMechanic: 'solitaire/klondike',
    mappingDigest: '2'.repeat(64),
    mappingState: 'active',
  },
  {
    builtinMappingId: '33333333-3333-4333-8333-333333333333',
    playableId: 'merge-locked-v1-swipe',
    variantId: '33333333-3333-3333-3333-333333333333',
    catalogMechanic: 'merge/locked',
    mappingDigest: '3'.repeat(64),
    mappingState: 'active',
  },
  {
    builtinMappingId: '55555555-5555-4555-8555-555555555555',
    playableId: 'arrows-v1-swipe',
    variantId: '55555555-5555-1555-1555-555555555555',
    catalogMechanic: 'arrows/base',
    mappingDigest: '5'.repeat(64),
    mappingState: 'active',
  },
  {
    builtinMappingId: '66666666-6666-4666-8666-666666666666',
    playableId: 'minesweeper-v1-swipe',
    variantId: '66666666-6666-1666-1666-666666666666',
    catalogMechanic: 'minesweeper/base',
    mappingDigest: '6'.repeat(64),
    mappingState: 'active',
  },
  {
    builtinMappingId: '77777777-7777-4777-8777-777777777777',
    playableId: 'orthogonal-link-v1-swipe',
    variantId: '77777777-7777-1777-1777-777777777777',
    catalogMechanic: 'connect/orthogonal-link-v1',
    mappingDigest: '7'.repeat(64),
    mappingState: 'active',
  },
];
const roster = {
  schema: 'feed.roster-config.v1',
  activationId: '44444444-4444-4444-8444-444444444444',
  rosterHash: createHash('sha256').update(JSON.stringify({
    entries: rosterEntries.map((entry) => ({ builtinMappingId: entry.builtinMappingId })),
    schema: 'feed.roster-config.v1',
  })).digest('hex'),
  entries: rosterEntries,
};
const requests = [];
let adoptionPosts = 0;
const playableReworkPosts = [];
let adopted = false;
let origin = '';

const candidateOverlayPlayableIds = [
  playableId,
  ...rosterEntries.filter((entry) => entry.playableId !== playableId)
    .map((entry) => entry.playableId),
];
const candidateBlocked = generatedInsertionBlockedIndices(
  candidateOverlayPlayableIds,
  [],
  playableId,
);
assert.deepEqual(candidateBlocked, [0], 'exact candidate page was not reserved from generated insertion');
assert.equal(generatedInsertionTarget(0, candidateOverlayPlayableIds.length, candidateBlocked, 2), 2,
  'generated insertion did not remain available on a non-candidate page');

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
};

const playableHtml = (id, candidate = false) => `<!doctype html><html><head><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${candidate ? '#71491f' : '#17325a'}}
#marker{position:relative;display:grid;place-items:center;width:100%;height:100%;color:white;font:700 18px system-ui}
#candidate-hud{position:absolute;top:11.5%;left:50%;width:40px;height:10px;transform:translate(-50%,-50%)}
#candidate-board{position:absolute;top:50%;left:50%;width:10px;height:10px;transform:translate(-50%,-50%)}
</style></head><body><div id="marker">${candidate ? 'EXACT IMMUTABLE CANDIDATE' : `LIVE NEIGHBOR ${id}`}</div><script>
const id=${JSON.stringify(id)};
const candidate=${JSON.stringify(candidate)};
const record=(type)=>{const key='__candidate_feed_commands';const values=JSON.parse(parent.sessionStorage.getItem(key)||'[]');values.push({id,type});parent.sessionStorage.setItem(key,JSON.stringify(values));};
const send=(type,extra={})=>parent.postMessage({source:'playable',id,type,...extra},'*');
addEventListener('message',(event)=>{if(event.source!==parent||event.data?.target!=='playable-swipe')return;record(event.data.type);if(event.data.type==='prepareInteractive')send('interactive_ready');});
document.querySelector('#marker').addEventListener('click',()=>send('completed',{success:true}));
addEventListener('load',()=>send('static_ready'));
if(candidate){for(const id of ['candidate-hud','candidate-board']){const el=document.createElement('div');el.id=id;document.querySelector('#marker').appendChild(el);}}
</script></body></html>`;

const candidateSurfaceGeometry = async (page) => page.locator('.page--in-viewport .game').first().evaluate((game) => {
  const slot = game.querySelector('.game__slot');
  const frame = game.querySelector('.game__frame');
  if (!(slot instanceof HTMLElement) || !(frame instanceof HTMLIFrameElement)) return null;
  const gameRect = game.getBoundingClientRect();
  const slotRect = slot.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  const boardRect = frame.contentDocument?.querySelector('#candidate-board')?.getBoundingClientRect();
  const hudRect = frame.contentDocument?.querySelector('#candidate-hud')?.getBoundingClientRect();
  const slotStyle = getComputedStyle(slot);
  const matrix = new DOMMatrixReadOnly(slotStyle.transform);
  const scaleX = frameRect.width / frame.offsetWidth;
  const scaleY = frameRect.height / frame.offsetHeight;
  const layoutTop = gameRect.top + slot.offsetTop;
  const layoutLeft = gameRect.left + slot.offsetLeft;
  return {
    candidate: game.classList.contains('game--candidate-overlay'),
    sessionPresentation: game.classList.contains('game--candidate-feed-presentation'),
    autoplay: game.classList.contains('game--autoplay'),
    game: { left: gameRect.left, right: gameRect.right, top: gameRect.top, bottom: gameRect.bottom },
    slot: { left: slotRect.left, right: slotRect.right, top: slotRect.top, bottom: slotRect.bottom },
    frame: { left: frameRect.left, right: frameRect.right, top: frameRect.top, bottom: frameRect.bottom },
    layout: {
      left: layoutLeft,
      right: layoutLeft + slot.offsetWidth,
      top: layoutTop,
      bottom: layoutTop + slot.offsetHeight,
      width: slot.offsetWidth,
      height: slot.offsetHeight,
    },
    transform: { scaleX: matrix.a, scaleY: matrix.d },
    transition: { duration: slotStyle.transitionDuration, timing: slotStyle.transitionTimingFunction },
    board: boardRect ? {
      centerX: frameRect.left + (boardRect.left + boardRect.width / 2) * scaleX,
      centerY: frameRect.top + (boardRect.top + boardRect.height / 2) * scaleY,
    } : null,
    hud: hudRect ? {
      centerX: frameRect.left + (hudRect.left + hudRect.width / 2) * scaleX,
      centerY: frameRect.top + (hudRect.top + hudRect.height / 2) * scaleY,
    } : null,
  };
});

const assertUniformSessionAutoplayGeometry = (geometry, label) => {
  assert.ok(geometry?.sessionPresentation && geometry.autoplay,
    `${label}: exact candidate presentation is not in autoplay: ${JSON.stringify(geometry)}`);
  const margins = {
    left: geometry.slot.left - geometry.layout.left,
    right: geometry.layout.right - geometry.slot.right,
    top: geometry.slot.top - geometry.layout.top,
    bottom: geometry.layout.bottom - geometry.slot.bottom,
  };
  assert.ok(Math.abs(margins.left - margins.right) <= 2
    && Math.abs(margins.top - margins.bottom) <= 2,
  `${label}: autoplay framing is not centred on both axes: ${JSON.stringify({ geometry, margins })}`);
  assert.ok(margins.left > 0 && margins.top > 0,
    `${label}: candidate framing must inset the complete surface on both axes: ${JSON.stringify({ geometry, margins })}`);
  assert.ok(Math.abs(geometry.transform.scaleX - geometry.transform.scaleY) <= 0.001,
    `${label}: candidate surface uses non-uniform scale: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(geometry.transform.scaleX - 0.92) <= 0.005,
    `${label}: candidate surface uses the wrong bounded scale: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(geometry.frame.left - geometry.slot.left) <= 2
    && Math.abs(geometry.frame.right - geometry.slot.right) <= 2
    && Math.abs(geometry.frame.top - geometry.slot.top) <= 2
    && Math.abs(geometry.frame.bottom - geometry.slot.bottom) <= 2,
  `${label}: iframe drifted from the uniformly framed slot: ${JSON.stringify(geometry)}`);
};

const waitForCandidateAutoplayScale = async (page) => page.waitForFunction(() => {
  const slot = document.querySelector('.page--in-viewport .game--candidate-feed-presentation.game--autoplay .game__slot');
  if (!(slot instanceof HTMLElement)) return false;
  const matrix = new DOMMatrixReadOnly(getComputedStyle(slot).transform);
  return Math.abs(matrix.a - 0.92) <= 0.005 && Math.abs(matrix.d - 0.92) <= 0.005;
});

const advanceToPlayable = async (page, expected, maxSteps = 24) => {
  const seen = [];
  for (let step = 0; step <= maxSteps; step += 1) {
    const label = await page.locator('.page--in-viewport .game__label').first().textContent();
    seen.push(label);
    if (label === expected) return;
    const current = await page.evaluate(() => window.__feedWarm?.().current);
    await page.locator('[data-bar-tab="feed"]').click();
    await page.waitForFunction((prior) => window.__feedWarm?.().current !== prior, current);
    await page.waitForTimeout(520);
  }
  assert.fail(`did not reach ${expected}; seen ${seen.join(' -> ')}`);
};

const assertCandidateSurfaceGeometry = async (page, label) => {
  await waitForCandidateAutoplayScale(page);
  const geometry = await candidateSurfaceGeometry(page);
  assert.ok(geometry?.candidate, `${label}: exact candidate surface class is absent: ${JSON.stringify(geometry)}`);
  assertUniformSessionAutoplayGeometry(geometry, label);
  const expectedCenterX = (geometry.frame.left + geometry.frame.right) / 2;
  const expectedGameplayHeight = geometry.frame.bottom - geometry.frame.top;
  assert.ok(geometry.board
    && Math.abs(geometry.board.centerX - expectedCenterX) <= 0.5
    && Math.abs(geometry.board.centerY - (geometry.frame.top + expectedGameplayHeight / 2)) <= 0.5,
  `${label}: candidate board is not centred in the framed gameplay rectangle: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.hud
    && Math.abs(geometry.hud.centerX - expectedCenterX) <= 0.5
    && Math.abs(geometry.hud.centerY - (geometry.frame.top + expectedGameplayHeight * 0.115)) <= 0.5,
    `${label}: candidate HUD is not centred in the framed gameplay rectangle: ${JSON.stringify(geometry)}`);
};

const assertAdoptedAutoplayGeometry = async (page, label) => {
  await waitForCandidateAutoplayScale(page);
  const geometry = await candidateSurfaceGeometry(page);
  assert.ok(geometry?.candidate && geometry.autoplay,
    `${label}: adopted candidate is not in autoplay: ${JSON.stringify(geometry)}`);
  assertUniformSessionAutoplayGeometry(geometry, label);
  return geometry;
};

const pointerClick = async (page, locator) => {
  await locator.waitFor({ state: 'visible', timeout: 10_000 });
  const box = await locator.boundingBox();
  assert.ok(box, 'pointer target has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
};

const armTakeoverTransitionProbe = async (page) => page.evaluate(() => {
  const slot = document.querySelector('.page--in-viewport .game--candidate-feed-presentation.game--autoplay .game__slot');
  if (!(slot instanceof HTMLElement)) return false;
  window.__issue119TakeoverTransition = new Promise((resolve) => {
    const onRun = (event) => {
      if (event.target !== slot || event.propertyName !== 'transform') return;
      slot.removeEventListener('transitionrun', onRun);
      resolve({
        propertyName: event.propertyName,
        elapsedTime: event.elapsedTime,
        duration: getComputedStyle(slot).transitionDuration,
        timing: getComputedStyle(slot).transitionTimingFunction,
      });
    };
    slot.addEventListener('transitionrun', onRun);
  });
  return true;
});

const readTakeoverTransitionProbe = async (page) => page.evaluate(
  () => window.__issue119TakeoverTransition,
);

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  requests.push(`${request.method} ${url.pathname}${url.search}`);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(readFileSync(path.join(root, 'dist', 'index.html')));
  }
  if (url.pathname === '/versions.json') return json(response, {
    'solitaire-v1-swipe': {
      version: 'live-solitaire',
      sourceCommit: '5'.repeat(40),
      runtimeArtifactDigest: `sha256:${'5'.repeat(64)}`,
    },
    'merge-locked-v1-swipe': {
      version: 'live-merge',
      sourceCommit: '4'.repeat(40),
      runtimeArtifactDigest: `sha256:${'4'.repeat(64)}`,
    },
    'marble-sort-swipe': {
      version: 'live-marble',
      sourceCommit: '3'.repeat(40),
      runtimeArtifactDigest: `sha256:${'3'.repeat(64)}`,
    },
    'arrows-v1-swipe': {
      version: 'live-arrows',
      sourceCommit: 'a'.repeat(40),
      runtimeArtifactDigest: `sha256:${'a'.repeat(64)}`,
    },
    'minesweeper-v1-swipe': {
      version: 'live-minesweeper',
      sourceCommit: 'c'.repeat(40),
      runtimeArtifactDigest: `sha256:${'c'.repeat(64)}`,
    },
    'orthogonal-link-v1-swipe': {
      version: 'live-two-dots',
      sourceCommit: 'd'.repeat(40),
      runtimeArtifactDigest: `sha256:${'d'.repeat(64)}`,
    },
  });
  if (url.pathname === `/playable-previews/${releaseId}/review-binding.json`) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', String(bindingBytes.length));
    return response.end(bindingBytes);
  }
  if (url.pathname === `/playable-previews/${sourceReleaseId}/review-binding.json`) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('content-length', String(sourceBindingBytes.length));
    return response.end(sourceBindingBytes);
  }
  if (url.pathname === candidatePath) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    return response.end(playableHtml(playableId, true));
  }
  if (url.pathname === sourceCandidatePath) {
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
  if (url.pathname === '/api/session' && request.method === 'POST') {
    assert.match(String(request.headers.authorization || ''), /^tma query_id=candidate/);
    return json(response, {
      user: { id: 42, ref_code: null }, ref_code: null, balance: 0, is_new: false,
      catalog_lab_authorization_available: true,
      operator_level_flagging_available: true,
      development_intake_available: true,
      development_intake_context: { buildSha: BUILD_SHA },
      feedRoster: roster,
      ...(adopted ? { developerFeedAdoption: {
        schema: 'feed.playable-source-preview-adoption.v1',
        releaseId: sourceReleaseId,
        playableId,
        candidatePath: sourceCandidatePath,
        candidateArtifactDigest: sourceCandidateArtifactDigest,
        reviewBindingDigest: sourceReviewBindingDigest,
        sourceCommit: '7'.repeat(40),
        receiptDigest: '6'.repeat(64),
        audience: 'exact-user',
        publicRollout: false,
      } } : {}),
    });
  }
  if (url.pathname === `/api/operator/playable-releases/${sourceReleaseId}/developer-adoption`
    && request.method === 'POST') {
    assert.match(String(request.headers.authorization || ''), /^tma query_id=candidate/);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.deepEqual(Object.keys(body).sort(), ['mutationId', 'reviewBindingDigest', 'schema']);
    assert.equal(body.schema, 'feed.playable-source-preview-adoption.v1');
    assert.equal(body.reviewBindingDigest, sourceReviewBindingDigest);
    assert.match(body.mutationId, /^[0-9a-f-]{36}$/);
    adoptionPosts += 1;
    adopted = true;
    return json(response, {
      schema: 'feed.playable-release-decision.receipt.v1',
      decisionSchema: 'feed.playable-release-decision.v1',
      decisionId: '11111111-1111-4111-8111-111111111119',
      mutationId: body.mutationId,
      releaseId: sourceReleaseId,
      actorUserId: 42,
      reviewBindingDigest: sourceReviewBindingDigest,
      candidateArtifactDigest: sourceCandidateArtifactDigest,
      decision: 'accept', instruction: null,
      audience: 'exact-user', publicRollout: false,
      authorization: {
        schema: 'feed.playable-release-authorization-disposition.v1',
        state: 'awaiting_exact_authorization', itemCount: 0,
        itemsDigest: '5'.repeat(64), items: [],
      },
      successor: null,
      decidedAt: '2026-08-14T09:00:00.000Z',
      receiptDigest: '6'.repeat(64), replayed: false,
    }, 201);
  }
  if (url.pathname === '/api/operator-playable-reworks' && request.method === 'GET') {
    return json(response, { schema: 'feed.playable-rework-list.v1', items: [] });
  }
  if (url.pathname === '/api/operator-playable-reworks' && request.method === 'POST') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    playableReworkPosts.push(structuredClone(body));
    return json(response, {
      schema: 'feed.playable-rework.v1',
      requestId: body.mutationId,
      actorUserId: 42,
      requestHash: 'e'.repeat(64),
      request: body,
      state: 'open',
      releaseId: null,
      claimedAt: null,
      closedAt: null,
      closeReceiptDigest: null,
      execution: { state: 'accepted', code: null, summary: null, updatedAt: body.context.capturedAt },
      createdAt: body.context.capturedAt,
      replayed: false,
    }, 201);
  }
  if (url.pathname === '/api/development-intake' && request.method === 'GET') {
    return json(response, { schema: 'platform.development-intake.list.v1', items: [] });
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
  env: {
    ...process.env,
    VITE_API_BASE: origin,
    VITE_CONTROL_PLANE_ENABLED: 'true',
    VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
    VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
    PLATFORM_SOURCE_SHA: BUILD_SHA,
  },
  timeout: 180_000,
});
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);

const telegramSdkFor = (platform) => `(()=>{const launch=new URLSearchParams(location.search).get('tgWebAppStartParam');
if(launch)sessionStorage.setItem('__test_tg_start_param',launch);
const start=sessionStorage.getItem('__test_tg_start_param');
const initData=new URLSearchParams({query_id:'candidate',user:JSON.stringify({id:42}),...(start?{start_param:start}:{}),hash:'candidate'}).toString();
window.Telegram={WebApp:{
initData,
initDataUnsafe:{start_param:start,user:{id:42}},platform:${JSON.stringify(platform)},
ready(){},expand(){},requestFullscreen(){},disableVerticalSwipes(){},
setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){},
HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}
}}})();`;
const telegramSdk = telegramSdkFor('android');

const query = new URLSearchParams({
  candidateFeedRelease: releaseId,
  candidateFeedPlayable: playableId,
  candidateFeedArtifact: candidateArtifactDigest,
  candidateFeedBinding: reviewBindingDigest,
});
const validUrl = `${origin}/?${query}`;
const browser = await chromium.launch({ headless: true });
try {
  const ordinaryContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ordinaryContext.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));
  await ordinaryContext.addInitScript((snapshot) => {
    if (window === window.top) localStorage.setItem('swipe_feed_roster_next_session_v1:42', JSON.stringify(snapshot));
  }, roster);
  const ordinaryPage = await ordinaryContext.newPage();
  await ordinaryPage.goto(origin, { waitUntil: 'domcontentloaded' });
  await ordinaryPage.locator('.page--in-viewport .game--autoplay').waitFor({ state: 'visible' });
  await ordinaryPage.locator('.feed-bar__lab').waitFor({ state: 'visible' });
  assert.equal(await ordinaryPage.locator('.page--in-viewport .game__label').first().textContent(), 'marble-sort-swipe');
  const ordinaryControl = await ordinaryPage.locator('.page--in-viewport .game').first().evaluate((game) => {
    const slot = game.querySelector('.game__slot');
    if (!(slot instanceof HTMLElement)) return null;
    const gameRect = game.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    return {
      sessionPresentation: game.classList.contains('game--candidate-feed-presentation'),
      game: { left: gameRect.left, right: gameRect.right, top: gameRect.top, bottom: gameRect.bottom },
      slot: { left: slotRect.left, right: slotRect.right, top: slotRect.top, bottom: slotRect.bottom },
    };
  });
  assert.ok(ordinaryControl && !ordinaryControl.sessionPresentation
    && Math.abs(ordinaryControl.slot.left - ordinaryControl.game.left) <= 2
    && Math.abs(ordinaryControl.slot.right - ordinaryControl.game.right) <= 2
    && ordinaryControl.slot.top > ordinaryControl.game.top,
  `ordinary/public Marble control did not retain the shipped vertical-only composition: ${JSON.stringify(ordinaryControl)}`);
  await ordinaryContext.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  requests.length = 0;

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdk,
  }));
  await context.addInitScript((snapshot) => {
    if (window === window.top) localStorage.setItem('swipe_feed_roster_next_session_v1:42', JSON.stringify(snapshot));
  }, roster);
  const page = await context.newPage();
  await page.goto(validUrl, { waitUntil: 'domcontentloaded' });
  await page.getByText('Кандидат — не опубликовано', { exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.__feedWarm?.().current === 0);
  assert.equal(await page.locator('.page').first().locator('.game__label').textContent(), playableId);
  assert.equal(await page.locator('.page').nth(1).locator('.game__label').textContent(), 'marble-sort-swipe');
  assert.equal(await page.locator('.session-auth-banner').count(), 0,
    'read-only TMA candidate preview rendered a false authentication rejection');

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
  await page.locator('.page--in-viewport .game--candidate-overlay.game--autoplay').waitFor({ state: 'visible' });
  await assertCandidateSurfaceGeometry(page, 'query candidate preview');
  await page.waitForTimeout(5_100);
  assert.equal(requests.some((entry) => entry.includes('/api/session')), false,
    `candidate preview inherited Telegram session authority: ${requests.join(', ')}`);
  assert.equal(requests.some((entry) => entry.startsWith('POST /api/')), false,
    `candidate preview emitted a backend mutation: ${requests.join(', ')}`);

  const autoplaySurface = page.locator('.page--in-viewport .game__autoplay').first();
  const autoplayBox = await autoplaySurface.boundingBox();
  assert.ok(autoplayBox, 'candidate autoplay surface has no pointer box');
  await page.mouse.move(autoplayBox.x + autoplayBox.width / 2, autoplayBox.y + autoplayBox.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => {
    const targetGame = document.querySelectorAll('.page')[1]?.querySelector('.game');
    const image = document.querySelector('.incoming-poster[data-direction="1"] img');
    return targetGame?.classList.contains('game--autoplay')
      && image instanceof HTMLImageElement
      && Number.parseFloat(image.style.width) > 0;
  });
  const incomingTarget = await page.evaluate(() => {
    const targetGame = document.querySelectorAll('.page')[1]?.querySelector('.game');
    const slot = targetGame?.querySelector('.game__slot');
    const image = document.querySelector('.incoming-poster[data-direction="1"] img');
    if (!(targetGame instanceof HTMLElement)
      || !(slot instanceof HTMLElement)
      || !(image instanceof HTMLImageElement)) return null;
    const scale = Number.parseFloat(getComputedStyle(targetGame).getPropertyValue('--candidate-autoplay-scale'));
    return {
      actual: {
        top: Number.parseFloat(image.style.top),
        left: Number.parseFloat(image.style.left),
        width: Number.parseFloat(image.style.width),
        height: Number.parseFloat(image.style.height),
      },
      expected: {
        top: targetGame.offsetTop + slot.offsetTop + (slot.offsetHeight - slot.offsetHeight * scale) / 2,
        left: targetGame.offsetLeft + slot.offsetLeft + (slot.offsetWidth - slot.offsetWidth * scale) / 2,
        width: slot.offsetWidth * scale,
        height: slot.offsetHeight * scale,
      },
    };
  });
  assert.ok(incomingTarget && Object.keys(incomingTarget.actual).every((key) =>
    Math.abs(incomingTarget.actual[key] - incomingTarget.expected[key]) <= 0.5),
  `incoming poster did not use the settled candidate target box: ${JSON.stringify(incomingTarget)}`);
  await page.mouse.move(autoplayBox.x + autoplayBox.width / 2, autoplayBox.y + 40, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => window.__feedWarm?.().current === 1);
  await page.waitForTimeout(520);
  const neighbor = page.locator('.page--in-viewport iframe').first();
  const neighborUrl = new URL((await neighbor.getAttribute('src')) || '', origin);
  assert.equal(neighborUrl.pathname, '/marble-sort-swipe.html');
  await neighbor.contentFrame().getByText('LIVE NEIGHBOR marble-sort-swipe', { exact: true }).waitFor();
  const neighborGeometry = await page.locator('.page--in-viewport .game').first().evaluate((game) => {
    const slot = game.querySelector('.game__slot');
    if (!(slot instanceof HTMLElement)) return null;
    return {
      candidate: game.classList.contains('game--candidate-overlay'),
      sessionPresentation: game.classList.contains('game--candidate-feed-presentation'),
      gameTop: game.getBoundingClientRect().top,
      gameBottom: game.getBoundingClientRect().bottom,
      slotTop: slot.getBoundingClientRect().top,
      slotBottom: slot.getBoundingClientRect().bottom,
    };
  });
  assert.ok(neighborGeometry && !neighborGeometry.candidate && neighborGeometry.sessionPresentation,
    `live neighbour did not inherit the exact candidate-session presentation: ${JSON.stringify(neighborGeometry)}`);
  await waitForCandidateAutoplayScale(page);
  assertUniformSessionAutoplayGeometry(
    await candidateSurfaceGeometry(page),
    'candidate session/live marble control',
  );

  for (const expected of [
    'merge-locked-v1-swipe',
    'arrows-v1-swipe',
    'minesweeper-v1-swipe',
    'orthogonal-link-v1-swipe',
  ]) {
    await advanceToPlayable(page, expected);
    await page.locator('.page--in-viewport .game--autoplay').waitFor({ state: 'visible' });
    await waitForCandidateAutoplayScale(page);
    assertUniformSessionAutoplayGeometry(
      await candidateSurfaceGeometry(page),
      `candidate session/${expected}`,
    );
  }

  await page.goto(validUrl, { waitUntil: 'domcontentloaded' });
  await page.getByText('Кандидат — не опубликовано', { exact: true }).waitFor({ state: 'visible' });
  const takeover = page.locator('.page--in-viewport .game__autoplay').first();
  await takeover.click({ position: { x: 50, y: 80 } });
  await page.locator('.page--in-viewport .game--manual').waitFor({ state: 'visible' });
  const manualFrameUrl = new URL((await page.locator('.page--in-viewport iframe').getAttribute('src')) || '', origin);
  assert.equal(manualFrameUrl.pathname, candidatePath);
  assert.equal(manualFrameUrl.searchParams.get('auto'), '0');
  const storageBeforeWin = await page.evaluate(() => Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => key !== null)
      .map((key) => [key, localStorage.getItem(key)]),
  ));
  await page.locator('.page--in-viewport iframe').contentFrame()
    .getByText('EXACT IMMUTABLE CANDIDATE', { exact: true }).click();
  await page.waitForTimeout(600);
  const storageAfterWin = await page.evaluate(() => Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key) => key !== null)
      .map((key) => [key, localStorage.getItem(key)]),
  ));
  assert.deepEqual(storageAfterWin, storageBeforeWin,
    'candidate result mutated durable player storage for a later authenticated flush');

  const startAppUrl = new URL(origin);
  startAppUrl.searchParams.set('tgWebAppStartParam', candidateStartParam);
  startAppUrl.searchParams.set('tgWebAppPlatform', 'android');
  await page.goto(startAppUrl.toString(), { waitUntil: 'domcontentloaded' });
  await page.getByText('Кандидат — не опубликовано', { exact: true }).waitFor({ state: 'visible' });
  await page.getByText('Добавить в dev-ленту', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.feed-bar__lab:visible').count(), 0,
    'read-only source preview exposed LAB authority');
  assert.equal(await page.locator('.feed-bar__debug').count(), 0,
    'read-only source preview exposed operator debug authority');
  assert.equal(await page.locator('.game__operator-playable-rework').count(), 0,
    'read-only source preview exposed mechanic rework authority');
  assert.equal(await page.locator('.platform-development-intake').count(), 0,
    'read-only source preview exposed platform development intake');
  assert.equal(await page.locator('.game--candidate-read-only-preview').count(), 1,
    'source preview did not carry the explicit read-only candidate mode');
  assert.equal(await page.locator('.page').first().locator('.game__label').textContent(), playableId);
  const startFrameUrl = new URL((await page.locator('.page').first().locator('iframe').getAttribute('src')) || '', origin);
  assert.equal(startFrameUrl.pathname, sourceCandidatePath);
  assert.equal(startFrameUrl.searchParams.get('reviewBinding'), sourceReviewBindingDigest);
  assert.equal(startFrameUrl.searchParams.get('artifact'), sourceCandidateArtifactDigest);
  assert.equal(requests.filter((entry) => entry === 'POST /api/session').length, 1,
    `startapp candidate did not perform exactly one bounded identity bootstrap: ${requests.join(', ')}`);
  assert.deepEqual(
    [...new Set(requests.filter((entry) => entry.startsWith('POST /api/'))
      .map((entry) => entry.replace(/[?].*$/, '')))].sort(),
    ['POST /api/session'],
    `candidate preview exceeded its exact POST allow-list before adoption: ${requests.join(', ')}`,
  );
  await page.getByText('Добавить в dev-ленту', { exact: true }).click();
  await page.getByText('Добавлено в dev-ленту', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(adoptionPosts, 1);
  assert.deepEqual(
    [...new Set(requests.filter((entry) => entry.startsWith('POST /api/'))
      .map((entry) => entry.replace(/[?].*$/, '')))].sort(),
    [
      `POST /api/operator/playable-releases/${sourceReleaseId}/developer-adoption`,
      'POST /api/session',
    ].sort(),
    `candidate preview exceeded its exact POST allow-list after adoption: ${requests.join(', ')}`,
  );
  assert.equal(await page.getByText('Аудитория: Только мне', { exact: true }).count(), 1);
  await page.getByText('Открыть dev-ленту', { exact: true }).click();
  const developerBadge = page.locator('[data-testid="developer-feed-badge"]');
  await developerBadge.waitFor({ state: 'visible' });
  const developerBadgeLines = developerBadge.locator('.dev-diff__badge-label-line');
  await developerBadgeLines.nth(0).waitFor({ state: 'visible' });
  await developerBadgeLines.nth(1).waitFor({ state: 'visible' });
  assert.deepEqual(
    await developerBadgeLines.allTextContents(),
    ['Dev-лента', 'Только мне'],
    'adopted developer Feed lost the compact two-line badge label',
  );
  const adoptedFrame = page.locator('.page').first().locator('iframe');
  await adoptedFrame.waitFor({ state: 'attached' });
  assert.equal(new URL((await adoptedFrame.getAttribute('src')) || '', origin).pathname, sourceCandidatePath);
  await adoptedFrame.contentFrame().getByText('EXACT IMMUTABLE CANDIDATE', { exact: true }).waitFor();
  await page.locator('.page--in-viewport .game--candidate-overlay.game--autoplay').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.game--candidate-read-only-preview').count(), 0,
    'adopted developer Feed retained the source-preview read-only mode');
  const adoptedAutoplayGeometry = await assertAdoptedAutoplayGeometry(page, 'adopted developer feed');
  await page.locator('.feed-bar__lab').waitFor({ state: 'visible' });
  await page.locator('.feed-bar__debug').waitFor({ state: 'visible' });
  await page.locator('.platform-development-intake__open').waitFor({ state: 'visible' });
  const rework = page.locator('.feed-bar .game__operator-playable-rework');
  await rework.waitFor({ state: 'visible' });
  assert.equal(requests.filter((entry) => entry === 'POST /api/session').length, 2,
    `developer handoff did not consume exactly one new authenticated session: ${requests.join(', ')}`);
  const forbiddenAutomaticWrites = [
    '/api/cp/events', '/api/events', '/api/daily/sync', '/api/feed/generated-offer',
    '/api/results', '/api/runs/start',
  ];
  assert.deepEqual(
    requests.filter((entry) => entry.startsWith('POST ')
      && forbiddenAutomaticWrites.some((path) => entry.startsWith(`POST ${path}`))),
    [],
    `candidate dogfood wrote public gameplay state: ${requests.join(', ')}`,
  );
  await rework.locator('.game__operator-flag-open').click();
  await rework.locator('textarea[name="instruction"]').fill('Проверить exact adopted candidate runtime.');
  await rework.locator('button[type="submit"]').click();
  for (let attempt = 0; attempt < 40 && playableReworkPosts.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(playableReworkPosts.length, 1, 'adopted candidate rework did not reach the local contract fixture');
  assert.equal(playableReworkPosts[0].playableId, playableId);
  assert.equal(playableReworkPosts[0].mappingId, rosterEntries[1].builtinMappingId);
  assert.equal(playableReworkPosts[0].rosterActivationId, roster.activationId);
  assert.equal(playableReworkPosts[0].runtime.version, sourceCandidateArtifactDigest.slice(0, 12));
  assert.equal(playableReworkPosts[0].runtime.artifactDigest, `sha256:${sourceCandidateArtifactDigest}`);
  assert.equal(playableReworkPosts[0].runtime.sourceCommit, '7'.repeat(40));
  assert.notEqual(playableReworkPosts[0].runtime.artifactDigest, `sha256:${'5'.repeat(64)}`,
    'adopted mechanic rework fell back to the public manifest runtime');
  await rework.locator('form').waitFor({ state: 'hidden', timeout: 3_000 });
  assert.equal(await armTakeoverTransitionProbe(page), true,
    'candidate takeover transition could not be armed');
  await pointerClick(page, page.locator('.page--in-viewport .game--autoplay .game__autoplay').first());
  await page.locator('.page--in-viewport .game--manual').waitFor({ state: 'visible' });
  const takeoverTransition = await readTakeoverTransitionProbe(page);
  assert.deepEqual(takeoverTransition, {
    propertyName: 'transform',
    elapsedTime: 0,
    duration: '0.36s',
    timing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  }, `candidate takeover did not start the exact ease-out transform: ${JSON.stringify(takeoverTransition)}`);
  assert.equal(adoptedAutoplayGeometry.transition.duration, '0.36s');
  assert.equal(adoptedAutoplayGeometry.transition.timing, 'cubic-bezier(0.16, 1, 0.3, 1)');
  await page.waitForTimeout(360);
  const adoptedManualGeometry = await candidateSurfaceGeometry(page);
  assert.ok(adoptedManualGeometry && !adoptedManualGeometry.autoplay,
    `candidate did not enter manual mode: ${JSON.stringify(adoptedManualGeometry)}`);
  assert.ok(Math.abs(adoptedManualGeometry.slot.left - adoptedManualGeometry.game.left) <= 2
    && Math.abs(adoptedManualGeometry.slot.right - adoptedManualGeometry.game.right) <= 2
    && Math.abs(adoptedManualGeometry.slot.top - adoptedManualGeometry.game.top) <= 2,
  `manual candidate did not expand to the full available rectangle: ${JSON.stringify(adoptedManualGeometry)}`);
  assert.ok((adoptedManualGeometry.slot.bottom - adoptedManualGeometry.slot.top)
    > (adoptedAutoplayGeometry.slot.bottom - adoptedAutoplayGeometry.slot.top),
  'autoplay to manual did not visibly expand the adopted candidate');
  assert.ok((adoptedManualGeometry.slot.right - adoptedManualGeometry.slot.left)
    > (adoptedAutoplayGeometry.slot.right - adoptedAutoplayGeometry.slot.left),
  'autoplay to manual did not expand the candidate horizontally');
  await page.waitForTimeout(1_050);
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  await page.waitForTimeout(100);
  const restoredCandidateSurfaces = await page.locator('.game--candidate-overlay').evaluateAll((games) => games.map((game) => ({
    playableId: game.querySelector('.game__label')?.textContent ?? null,
    path: game.querySelector('iframe')?.getAttribute('src') ?? null,
  })));
  assert.deepEqual(restoredCandidateSurfaces.map((surface) => surface.playableId), [playableId],
    `BFCache restore leaked candidate geometry to another page: ${JSON.stringify(restoredCandidateSurfaces)}`);
  assert.equal(new URL(restoredCandidateSurfaces[0].path || '', origin).pathname, sourceCandidatePath,
    'BFCache restore replaced the exact candidate iframe');
  const restoredGeometry = await candidateSurfaceGeometry(page);
  assert.ok(restoredGeometry?.candidate && !restoredGeometry.autoplay,
    `BFCache restore lost the adopted manual candidate surface: ${JSON.stringify(restoredGeometry)}`);
  assert.ok(Math.abs(restoredGeometry.slot.left - restoredGeometry.game.left) <= 2
    && Math.abs(restoredGeometry.slot.right - restoredGeometry.game.right) <= 2
    && Math.abs(restoredGeometry.slot.top - restoredGeometry.game.top) <= 2
    && Math.abs(restoredGeometry.frame.left - restoredGeometry.slot.left) <= 2
    && Math.abs(restoredGeometry.frame.right - restoredGeometry.slot.right) <= 2
    && Math.abs(restoredGeometry.frame.top - restoredGeometry.slot.top) <= 2
    && Math.abs(restoredGeometry.frame.bottom - restoredGeometry.slot.bottom) <= 2
    && Math.abs((restoredGeometry.slot.bottom - restoredGeometry.slot.top)
      - (adoptedManualGeometry.slot.bottom - adoptedManualGeometry.slot.top)) <= 0.5,
  `BFCache restore changed the adopted manual geometry: ${JSON.stringify({ restoredGeometry, adoptedManualGeometry })}`);
  assert.equal(adoptionPosts, 1, 'normal dev feed replayed the adoption mutation');
  assert.equal(await page.getByText('Кандидат — не опубликовано', { exact: true }).count(), 0,
    'one-shot handoff restored the physical Telegram candidate start_param');

  for (const malformed of [
    candidateStartParam.slice(0, -1),
    `${candidateStartParam}A`,
    `${candidateStartParam.slice(0, -1)}${candidateStartParam.endsWith('A') ? 'B' : 'A'}`,
  ]) {
    const invalidStart = new URL(origin);
    invalidStart.searchParams.set('tgWebAppStartParam', malformed);
    invalidStart.searchParams.set('tgWebAppPlatform', 'android');
    await page.goto(invalidStart.toString(), { waitUntil: 'domcontentloaded' });
    await page.getByText('Candidate недоступен', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('iframe').count(), 0, 'malformed startapp token fell back to ordinary feed');
  }

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

  const unauthenticated = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await unauthenticated.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: `window.Telegram={WebApp:{initData:'',initDataUnsafe:{start_param:${JSON.stringify(candidateStartParam)}},platform:'unknown',ready(){},expand(){},disableVerticalSwipes(){},setHeaderColor(){},setBackgroundColor(){},lockOrientation(){},onEvent(){},offEvent(){}}};`,
  }));
  const unauthenticatedPage = await unauthenticated.newPage();
  await unauthenticatedPage.goto(startAppUrl.toString(), { waitUntil: 'domcontentloaded' });
  await unauthenticatedPage.getByText('Candidate недоступен', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await unauthenticatedPage.locator('iframe').count(), 0,
    'startapp candidate mounted without Telegram user identity');
  await unauthenticated.close();

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await desktop.route('https://telegram.org/js/telegram-web-app.js', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: telegramSdkFor('tdesktop'),
  }));
  await desktop.addInitScript((snapshot) => {
    if (window === window.top) localStorage.setItem('swipe_feed_roster_next_session_v1:42', JSON.stringify(snapshot));
  }, roster);
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(validUrl, { waitUntil: 'domcontentloaded' });
  await desktopPage.getByText('Кандидат — не опубликовано', { exact: true }).waitFor({ state: 'visible' });
  await desktopPage.locator('.page--in-viewport .game--candidate-overlay.game--autoplay').waitFor({ state: 'visible' });
  await assertCandidateSurfaceGeometry(desktopPage, 'desktop candidate preview');
  for (const expected of [
    'arrows-v1-swipe',
    'minesweeper-v1-swipe',
    'orthogonal-link-v1-swipe',
  ]) {
    await advanceToPlayable(desktopPage, expected);
    await desktopPage.locator('.page--in-viewport .game--autoplay').waitFor({ state: 'visible' });
    await waitForCandidateAutoplayScale(desktopPage);
    assertUniformSessionAutoplayGeometry(
      await candidateSurfaceGeometry(desktopPage),
      `desktop candidate session/${expected}`,
    );
  }
  await desktopPage.goto(validUrl, { waitUntil: 'domcontentloaded' });
  await desktopPage.getByText('Кандидат — не опубликовано', { exact: true }).waitFor({ state: 'visible' });
  await assertAdoptedAutoplayGeometry(desktopPage, 'desktop candidate takeover start');
  assert.equal(await desktopPage.evaluate(() => window.Telegram?.WebApp?.platform), 'tdesktop',
    'desktop proof did not exercise the Telegram Desktop host projection');
  assert.equal(await armTakeoverTransitionProbe(desktopPage), true,
    'desktop candidate takeover transition could not be armed');
  await pointerClick(desktopPage, desktopPage.locator('.page--in-viewport .game__autoplay').first());
  await desktopPage.locator('.page--in-viewport .game--manual').waitFor({ state: 'visible' });
  const desktopTransition = await readTakeoverTransitionProbe(desktopPage);
  assert.deepEqual(desktopTransition, {
    propertyName: 'transform',
    elapsedTime: 0,
    duration: '0.36s',
    timing: 'cubic-bezier(0.16, 1, 0.3, 1)',
  }, `desktop takeover did not start the exact ease-out transform: ${JSON.stringify(desktopTransition)}`);
  await desktopPage.waitForTimeout(360);
  const desktopManual = await candidateSurfaceGeometry(desktopPage);
  assert.ok(desktopManual && !desktopManual.autoplay
    && Math.abs(desktopManual.slot.left - desktopManual.game.left) <= 2
    && Math.abs(desktopManual.slot.right - desktopManual.game.right) <= 2
    && Math.abs(desktopManual.slot.top - desktopManual.game.top) <= 2,
  `desktop takeover did not finish at the full manual rectangle: ${JSON.stringify(desktopManual)}`);
  await desktop.close();

  await context.close();
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

console.log('candidate feed preview browser contract: PASS');
