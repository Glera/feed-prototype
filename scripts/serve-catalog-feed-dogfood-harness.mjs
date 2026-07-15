import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractDigest = 'c'.repeat(64);
const artifactHex = 'd'.repeat(64);
const artifactDigest = `sha256:${artifactHex}`;
const previewJpeg = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=', 'base64');
const previewDigest = `sha256:${createHash('sha256').update(previewJpeg).digest('hex')}`;
const configuredLevelCount = Number(process.env.CATALOG_DOGFOOD_LEVEL_COUNT ?? '2');
if (!Number.isInteger(configuredLevelCount) || configuredLevelCount < 1 || configuredLevelCount > 6) {
  throw new Error('CATALOG_DOGFOOD_LEVEL_COUNT must be an integer from 1 to 6');
}
const specHashes = Array.from(
  { length: configuredLevelCount },
  (_, index) => String(index + 1).repeat(64),
);
const harnessTimeoutMs = Number(process.env.CATALOG_DOGFOOD_TIMEOUT_MS ?? '45000');
if (!Number.isInteger(harnessTimeoutMs) || harnessTimeoutMs < 5_000 || harnessTimeoutMs > 60_000) {
  throw new Error('CATALOG_DOGFOOD_TIMEOUT_MS must be an integer from 5000 to 60000');
}
const ids = {
  mapping: '10000000-0000-4000-8000-000000000001',
  builtinVariant: '10000000-0000-4000-8000-000000000002',
  plan: '10000000-0000-4000-8000-000000000003',
  authorization: '10000000-0000-4000-8000-000000000004',
  allocationDecision: '10000000-0000-4000-8000-000000000005',
  entry: '10000000-0000-4000-8000-000000000006',
  series: '10000000-0000-4000-8000-000000000007',
  release: '10000000-0000-4000-8000-000000000008',
  runtimeVariant: '10000000-0000-4000-8000-000000000009',
};
let origin = '';
let state = null;
let canaryBuildHtml = '';
let canaryDisabledBuildHtml = '';

const scenarios = new Set([
  'success', 'result-transient', 'result-timeout', 'recall', 'replay-conflict',
  'no-invite', 'replayed-canary', 'wrong-account', 'disabled',
]);
const canaryScenarios = new Set([
  'success', 'result-transient', 'result-timeout', 'recall', 'replay-conflict',
]);
const successfulCatalogScenarios = new Set([
  'success', 'result-transient', 'result-timeout', 'replayed-canary', 'disabled',
]);
const normalizedScenario = (scenario) => scenarios.has(scenario) ? scenario : 'success';
const dogfoodUserId = 424242;
const userIdForScenario = (scenario) => scenario === 'wrong-account' ? 7 : dogfoodUserId;

const initDataFor = (instanceToken, scenario) => new URLSearchParams({
  query_id: 'dogfood',
  harness_instance: instanceToken,
  harness_scenario: normalizedScenario(scenario),
  user: JSON.stringify({ id: userIdForScenario(normalizedScenario(scenario)) }),
  hash: 'dogfood',
}).toString();

const freshState = (scenario, instanceToken) => ({
  instanceToken,
  userId: userIdForScenario(normalizedScenario(scenario)),
  scenario: normalizedScenario(scenario),
  startedAt: Date.now(),
  status: 'running',
  message: 'waiting for real Feed',
  trace: [],
  cpEvents: [],
  canaryRequests: [],
  authorityRequests: [],
  allocationRequests: [],
  allocationResponses: [],
  ticketRequests: [],
  specRequests: 0,
  results: [],
  resultAttempts: [],
  resultTransientInjected: false,
  resultTimeoutInjected: false,
  diagnostics: [],
  runtimeEvents: [],
  replayConflictTransportAttempts: 0,
  authorityPending: false,
  pendingSamples: 0,
  pendingViolation: false,
  checkpoints: {
    pendingSurface: null,
    configuredImpressions: [],
    levelReceipts: [],
    chestAfterExactReceipts: null,
    rewardAfterChestReceipt: null,
    recallResult: null,
    recallRecovery: null,
    replayConflict: null,
  },
  client: {
    currentFrame: 'none',
    currentIframeCount: 0,
    catalogSeen: false,
    builtinSeen: false,
    chestSeen: false,
    rewardSeen: false,
    recoverySeen: false,
    generatedBadgeVisible: false,
    preloaderVisible: true,
  },
  lastClientSignature: '',
});

const record = (type, detail = {}) => {
  if (!state) return;
  state.trace.push({ atMs: Date.now() - state.startedAt, type, ...detail });
  if (state.trace.length > 160) state.trace.shift();
};

const json = (response, value, status = 200) => {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(value));
};

const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const activeInstance = (instanceToken, scenario) => Boolean(state
  && typeof instanceToken === 'string'
  && instanceToken === state.instanceToken
  && scenario === state.scenario);

const authorizationIdentity = (request) => {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('tma ')) return null;
  const params = new URLSearchParams(authorization.slice(4));
  return {
    instanceToken: params.get('harness_instance'),
    scenario: params.get('harness_scenario'),
  };
};

const authorizedForActiveInstance = (request) => {
  const identity = authorizationIdentity(request);
  return identity !== null && activeInstance(identity.instanceToken, identity.scenario);
};

const ignoreStaleInstance = (response) => json(response, {
  ok: true,
  ignored: 'stale_harness_instance',
}, 202);

const spec = (specHash, seed) => ({
  schema: 'sort.level-spec.v1',
  specHash,
  runtimeContractDigest: contractDigest,
  seed,
  params: {
    gridCols: 6,
    gridRows: 5,
    colorsUsed: 3,
    cellColorMap: Array.from({ length: 30 }, (_, index) => index % 3),
    targetStacks: [[0], [1], [2], [0]],
    convSpeedMul: 1,
    modifiers: [],
  },
});

const runtime = {
  releaseId: ids.release,
  playableId: 'marble-sort-swipe',
  legacyVariantId: ids.runtimeVariant,
  runtimeContractDigest: contractDigest,
  runtimeArtifactDigest: artifactDigest,
  indexLocator: `runtime-releases/marble-sort-swipe/${artifactHex}/index.html`,
  sidecarLocator: `runtime-releases/marble-sort-swipe/${artifactHex}/runtime-artifact.json`,
  capabilities: { catalogRequiredHandshake: true, sortLevelSpecV1: true },
};

const manifest = {
  schema: 'series.manifest.v1',
  contentHash: 'e'.repeat(64),
  seriesFingerprint: 'f'.repeat(64),
  fingerprintVersion: 'fixture.v1',
  levels: specHashes.map((specHash, index) => ({ ordinal: index + 1, specHash })),
};

const allocation = {
  schema: 'catalog.allocate-decision-result.v1',
  decisionId: ids.allocationDecision,
  allocationId: ids.authorization,
  requestHash: 'a'.repeat(64),
  requestedCatalogMechanic: 'sort/marble',
  slotType: 'anchor',
  policyVersion: 'dogfood.fixture.v1',
  outcome: 'allocated',
  holdExpiresAt: '2030-01-01T00:00:00.000Z',
  catalog: {
    entryId: ids.entry,
    entryState: 'published',
    entryStateVersion: 1,
    mechanic: 'sort/marble',
    variant: 'fixture',
    seriesId: ids.series,
  },
  runtime,
  manifest,
};

const allocationForScenario = (scenario) => {
  const canary = canaryScenarios.has(scenario);
  return {
    ...allocation,
    slotType: canary ? 'canary-dogfood' : allocation.slotType,
    policyVersion: canary ? 'catalog-canary-dogfood.v1' : allocation.policyVersion,
    catalog: {
      ...allocation.catalog,
      entryState: canary ? 'canary' : allocation.catalog.entryState,
    },
  };
};

const bundle = (ticketId) => ({
  schema: 'catalog.ticket-level-spec-bundle.v1',
  ticketId,
  ticketState: 'active',
  decisionId: ids.allocationDecision,
  catalogEntryId: ids.entry,
  seriesId: ids.series,
  manifestContentHash: manifest.contentHash,
  runtime,
  levels: specHashes.map((specHash, index) => ({
    ordinal: index + 1,
    specHash,
    spec: spec(specHash, 137 + index),
  })),
});

const ticketView = (request) => {
  const common = {
    ticket_id: request.ticket_id,
    run_id: request.run_id,
    kind: request.kind,
    expected_levels: request.kind === 'series' ? specHashes.length : 1,
    completed_levels: 0,
    next_result_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    state: 'active',
  };
  if (request.schema !== 'run.start.v2') return common;
  return {
    schema: 'run.ticket.v2',
    ...common,
    kind: 'series',
    mechanic_id: runtime.playableId,
    variant_id: runtime.legacyVariantId,
    decision_id: ids.allocationDecision,
    catalog_entry_id: ids.entry,
    series_id: ids.series,
    runtime_release_id: ids.release,
    runtime_contract_digest: contractDigest,
    runtime_artifact_digest: artifactDigest,
    manifest_content_hash: manifest.contentHash,
    levels: specHashes.map((specHash, index) => ({ ordinal: index + 1, spec_hash: specHash })),
    expected_levels: specHashes.length,
    completed_levels: state?.results.filter((item) => item.kind === 'level'
      && item.outcome === 'confirmed').length ?? 0,
  };
};

const uniqueEvents = (name) => {
  const byId = new Map();
  for (const event of state?.cpEvents ?? []) {
    if (event.event_name === name) byId.set(event.event_id, event);
  }
  return [...byId.values()];
};

const evaluate = () => {
  if (!state || state.status !== 'running') return;
  const source = uniqueEvents('builtin_feed_decision');
  const catalogImpressions = uniqueEvents('catalog_level_impression');
  const builtinImpressions = uniqueEvents('unit_impression');
  const levelResults = state.results.filter((item) => item.kind === 'level');
  const chestResults = state.results.filter((item) => item.kind === 'chest');
  const v2Ticket = state.ticketRequests.find((item) => item.schema === 'run.start.v2');

  if (state.pendingViolation) {
    state.status = 'fail';
    state.message = 'background generated discovery withheld or replaced the current built-in';
    return;
  }
  if (['recall', 'replay-conflict', 'no-invite', 'wrong-account'].includes(state.scenario)
    && (state.client.chestSeen || state.client.rewardSeen || chestResults.length > 0)) {
    state.status = 'fail';
    state.message = `${state.scenario} leaked a chest or reward`;
    return;
  }

  const exactCanaryGet = state.canaryRequests.every((item) => item.method === 'GET'
    && item.path === '/api/catalog/canary-authority'
    && item.query === '' && item.contentLength === null);
  const canaryPath = exactCanaryGet
    && state.canaryRequests.length === 1
    && state.authorityRequests.length === 0;
  const catalogAuthorityPath = canaryScenarios.has(state.scenario)
    ? canaryPath
    : ['disabled', 'replayed-canary'].includes(state.scenario)
      && state.canaryRequests.length === (state.scenario === 'replayed-canary' ? 1 : 0)
      && state.authorityRequests.length === 1;
  const allocationResponse = state.allocationResponses[0];
  const exactAllocationClass = canaryScenarios.has(state.scenario)
    ? allocationResponse?.catalog?.entryState === 'canary'
      && allocationResponse?.slotType === 'canary-dogfood'
      && allocationResponse?.policyVersion === 'catalog-canary-dogfood.v1'
    : ['disabled', 'replayed-canary'].includes(state.scenario)
      && allocationResponse?.catalog?.entryState === 'published'
      && allocationResponse?.slotType === 'anchor'
      && allocationResponse?.policyVersion === 'dogfood.fixture.v1';
  const exactTransport = source.length >= 1
    && catalogAuthorityPath
    && exactAllocationClass
    && state.allocationRequests[0]?.authorizationId === ids.authorization
    && v2Ticket?.decision_id === ids.allocationDecision
    && catalogImpressions.every((event) => event.payload.ticket_id === v2Ticket?.ticket_id
      && event.payload.decision_id === ids.allocationDecision
      && event.payload.series_id === ids.series);
  const exactCanaryTicketIdentity = !canaryScenarios.has(state.scenario)
    || (v2Ticket?.ticket_id === ids.authorization
      && v2Ticket?.run_id === `catalog-canary:${ids.authorization}`);
  const common = exactTransport
    && exactCanaryTicketIdentity
    && state.allocationRequests.length === 1
    && state.allocationResponses.length === 1
    && Boolean(v2Ticket)
    && state.specRequests >= 1
    && state.pendingSamples > 0
    && state.checkpoints.pendingSurface?.pass === true
    && state.client.catalogSeen;
  if (successfulCatalogScenarios.has(state.scenario)) {
    const impressionIdentity = catalogImpressions.length === specHashes.length
      && new Set(catalogImpressions.map((event) => event.payload.impression_id)).size === 1
      && new Set(catalogImpressions.map((event) => event.payload.level_impression_id)).size === specHashes.length
      && catalogImpressions.every((event, index) => event.payload.ordinal === index + 1);
    const exactLevels = levelResults.length === specHashes.length
      && levelResults.every((item, index) => item.outcome === 'confirmed'
        && item.body.ordinal === index + 1
        && item.body.applied_spec_hash === specHashes[index]
        && item.body.series_id === ids.series);
    const exactChest = chestResults.length === 1
      && chestResults[0].outcome === 'confirmed'
      && chestResults[0].body.series_id === ids.series;
    if (common && impressionIdentity && exactLevels && exactChest
      && state.checkpoints.configuredImpressions.length === specHashes.length
      && state.checkpoints.configuredImpressions.every((checkpoint) => checkpoint.pass)
      && state.checkpoints.levelReceipts.length === specHashes.length
      && state.checkpoints.levelReceipts.every((checkpoint) => checkpoint.pass)
      && state.checkpoints.chestAfterExactReceipts?.pass === true
      && state.checkpoints.rewardAfterChestReceipt?.pass === true
      && builtinImpressions.length >= 1 && state.client.builtinSeen
      && state.client.generatedBadgeVisible
      && state.client.chestSeen && state.client.rewardSeen) {
      state.status = 'pass';
      state.message = state.scenario === 'disabled'
        ? 'disabled canary left the normal effectful catalog path unchanged'
        : state.scenario === 'replayed-canary'
          ? 'completed canary fell through to the published generated feed path'
        : `canary invitation completed the exact ${specHashes.length}-level catalog series and confirmed chest`;
      record('assertions_passed', { scenario: state.scenario });
      return;
    }
  } else if (state.scenario === 'recall') {
    const revoked = levelResults.length === 1 && levelResults[0].outcome === 'revoked';
    if (common && catalogImpressions.length === 1 && revoked
      && state.checkpoints.configuredImpressions.length === 1
      && state.checkpoints.configuredImpressions[0]?.pass === true
      && state.checkpoints.recallResult?.pass === true
      && state.checkpoints.recallRecovery?.pass === true
      && builtinImpressions.length >= 1 && state.client.recoverySeen
      && state.client.currentFrame === 'builtin' && chestResults.length === 0) {
      state.status = 'pass';
      state.message = 'hard recall restored reviewed builtin without chest or reward';
      record('assertions_passed', { scenario: state.scenario });
      return;
    }
  } else if (state.scenario === 'replay-conflict') {
    const deterministicTicket = v2Ticket?.ticket_id === ids.authorization
      && v2Ticket?.run_id === `catalog-canary:${ids.authorization}`;
    const conflict = state.checkpoints.replayConflict?.pass === true;
    const gatedGameplayEvents = ['attempt_start', 'manual_action', 'attempt_result']
      .flatMap((name) => uniqueEvents(name));
    const inertUntilReject = state.replayConflictTransportAttempts === 3
      && state.client.catalogSeen && gatedGameplayEvents.length === 0
      && state.results.length === 0 && !state.client.chestSeen && !state.client.rewardSeen;
    if (common && deterministicTicket && conflict && inertUntilReject
      && catalogImpressions.length === 1 && levelResults.length === 0
      && chestResults.length === 0 && builtinImpressions.length >= 1
      && state.client.recoverySeen && state.client.currentFrame === 'builtin') {
      state.status = 'pass';
      state.message = 'fresh-looking allocation race stayed inert through delayed conflict and restored reviewed builtin';
      record('assertions_passed', { scenario: state.scenario });
      return;
    }
  } else if (state.scenario === 'no-invite') {
    const exactFallback = exactCanaryGet
      && state.canaryRequests.length === 1
      && state.authorityRequests.length === 1
      && state.authorityRequests[0]?.sourceDecisionId === source[0]?.payload.decision_id
      && state.allocationRequests.length === 0 && state.ticketRequests.length === 0
      && state.specRequests === 0 && catalogImpressions.length === 0
      && builtinImpressions.length >= 1 && state.pendingSamples > 0
      && state.checkpoints.pendingSurface?.pass === true
      && state.client.currentFrame === 'builtin' && state.client.builtinSeen;
    if (source.length === 1 && exactFallback) {
      state.status = 'pass';
      state.message = 'no invitation fell through to the exact normal reviewed-builtin fallback';
      record('assertions_passed', { scenario: state.scenario });
      return;
    }
  } else if (state.scenario === 'wrong-account') {
    const isolated = source.length === 1
      && state.canaryRequests.length === 0 && state.authorityRequests.length === 0
      && state.allocationRequests.length === 0 && state.ticketRequests.length === 0
      && state.specRequests === 0 && catalogImpressions.length === 0
      && builtinImpressions.length >= 1
      && state.client.currentFrame === 'builtin' && state.client.builtinSeen;
    if (isolated) {
      state.status = 'pass';
      state.message = 'wrong account stayed on the reviewed builtin without any catalog request';
      record('assertions_passed', { scenario: state.scenario });
      return;
    }
  }
  if (Date.now() - state.startedAt > harnessTimeoutMs) {
    state.status = 'fail';
    state.message = `timeout: source=${source.length}, catalogImpressions=${catalogImpressions.length}, levels=${levelResults.length}, chest=${chestResults.length}`;
  }
};

const injectedBootstrap = (instanceToken, scenario) => `<script>
const harnessInstance=${JSON.stringify(instanceToken)};
const harnessScenario=${JSON.stringify(scenario)};
const reportHarnessDiagnostic=(kind,args)=>fetch('/__harness/diagnostic?harness_instance='+encodeURIComponent(harnessInstance)+'&scenario='+encodeURIComponent(harnessScenario),{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({harnessInstance,harnessScenario,kind,args:args.map(value=>value instanceof Error?{name:value.name,message:value.message,stack:value.stack}:String(value))})
}).catch(()=>{});
const originalWarn=console.warn.bind(console);
console.warn=(...args)=>{if(String(args[0]||'').includes('[catalog-player-v2]'))reportHarnessDiagnostic('console.warn',args);originalWarn(...args)};
addEventListener('unhandledrejection',(event)=>reportHarnessDiagnostic('unhandledrejection',[event.reason]));
window.Telegram={WebApp:{
  initData:${JSON.stringify(initDataFor(instanceToken, scenario))},
  initDataUnsafe:{user:{id:${userIdForScenario(scenario)}},start_param:null},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},setHeaderColor(){},
  setBackgroundColor(){},lockOrientation(){},onEvent(){}
}};
addEventListener('DOMContentLoaded',()=>{
  let chestHandled=false;
  let advancing=false;
  let catalogSeen=false,builtinSeen=false,chestSeen=false,rewardSeen=false,recoverySeen=false;
  const tick=()=>{
    const current=document.querySelector('.page--in-viewport .game')||document.querySelectorAll('.game')[0];
    const frame=current?.querySelector('iframe')||null;
    const currentIframeCount=current?.querySelectorAll('iframe').length||0;
    const currentFrame=!frame?'none':frame.dataset.catalogPlayerV2==='1'?'catalog':'builtin';
    const currentGameClasses=current?.className||'';
    const frameNavigated=frame?.dataset.catalogNavigated||null;
    let frameVisibility=null;try{frameVisibility=frame?.contentDocument?.visibilityState||null}catch{}
    catalogSeen ||= currentFrame==='catalog';
    builtinSeen ||= currentFrame==='builtin';
    const chest=document.querySelector('.chest-ov__chest');
    chestSeen ||= Boolean(chest);
    rewardSeen ||= Boolean(document.querySelector('.game__state--earned .reward'));
    recoverySeen ||= (document.body.textContent||'').includes('Серия обновилась');
    const generatedBadgeVisible=Boolean(current?.classList.contains('game--generated')&&current?.querySelector('.game__generated-badge'));
    const preparedGenerated=document.querySelector('.game--generated');
    if(preparedGenerated&&!generatedBadgeVisible&&!advancing){
      // The production contract reserves a future page. Move through the same
      // built-in pages a user would swipe past; no network completion drives
      // this navigation and the generated page is never substituted in place.
      advancing=true;
      current?.querySelector('.game__close')?.click();
      setTimeout(()=>{advancing=false},520);
    }
    if(chest&&!chestHandled){
      chestHandled=true;
      chest.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:7}));
      setTimeout(()=>chest.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7})),650);
    }
    fetch('/__harness/client?harness_instance='+encodeURIComponent(harnessInstance)+'&scenario='+encodeURIComponent(harnessScenario),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      harnessInstance,harnessScenario,currentFrame,currentIframeCount,currentGameClasses,frameNavigated,frameVisibility,catalogSeen,builtinSeen,chestSeen,rewardSeen,recoverySeen,generatedBadgeVisible,
      preloaderVisible:Boolean(document.querySelector('.preloader:not(.preloader--hidden)'))
    })}).catch(()=>{});
  };
  setInterval(tick,80);tick();
});
</script>`;

const controllerHtml = (scenario, instanceToken) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Real Feed catalog dogfood · ${scenario}</title>
<style>
html,body{margin:0;height:100%;background:#07090f;color:#eef;font:13px/1.35 ui-monospace,monospace}
iframe{position:fixed;inset:0;width:100%;height:100%;border:0}
.panel{position:fixed;z-index:99999;top:8px;right:8px;width:min(430px,calc(100% - 16px));max-height:42vh;overflow:auto;background:rgba(4,8,16,.94);border:1px solid #526071;border-radius:10px;padding:10px;box-sizing:border-box}
output{display:block;padding:6px;border-radius:6px;background:#26313f;font-weight:700}output[data-state=pass]{background:#0b5c35}output[data-state=fail]{background:#7a2020}
pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0}a{color:#8ecbff}
</style></head><body>
<div data-testid="feed-root" data-harness-instance="${instanceToken}"></div>
<aside class="panel"><div><a href="/harness.html?scenario=success">canary success</a> · <a href="/harness.html?scenario=result-transient">transient result recovery</a> · <a href="/harness.html?scenario=result-timeout">hung result recovery</a> · <a href="/harness.html?scenario=recall">hard recall</a> · <a href="/harness.html?scenario=replay-conflict">replay conflict</a> · <a href="/harness.html?scenario=no-invite">no invite</a> · <a href="/harness.html?scenario=replayed-canary">replayed canary</a> · <a href="/harness.html?scenario=wrong-account">wrong account</a> · <a href="/harness.html?scenario=disabled">canary disabled</a></div>
<output data-testid="status" data-state="running">RUNNING</output><pre data-testid="trace">[]</pre></aside>
<script>
const status=document.querySelector('[data-testid=status]');const trace=document.querySelector('[data-testid=trace]');
const feedSrc=${JSON.stringify(`/feed?scenario=${scenario}&harness_instance=${encodeURIComponent(instanceToken)}&initData=${encodeURIComponent(initDataFor(instanceToken, scenario))}`)};
const poll=async()=>{try{const s=await fetch('/__harness/state?harness_instance=${encodeURIComponent(instanceToken)}&scenario=${scenario}',{cache:'no-store'}).then(r=>r.json());status.dataset.state=s.status;status.textContent=s.status.toUpperCase()+': '+s.message;trace.textContent=JSON.stringify(s,null,2);window.__catalogFeedDogfoodHarness=s;}catch(e){status.dataset.state='fail';status.textContent='FAIL: '+e}};
setInterval(poll,120);poll();
const clearOriginState=async()=>{
  localStorage.clear();sessionStorage.clear();
  if('caches'in window){for(const key of await caches.keys())await caches.delete(key)}
  if(navigator.serviceWorker){for(const registration of await navigator.serviceWorker.getRegistrations())await registration.unregister()}
  if(indexedDB.databases){
    const databases=await indexedDB.databases();
    await Promise.all(databases.filter(item=>item.name).map(item=>new Promise((resolve,reject)=>{
      const request=indexedDB.deleteDatabase(item.name);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('indexedDB delete blocked'));
    })));
  }
};
clearOriginState().then(()=>{
  const frame=document.createElement('iframe');frame.dataset.testid='feed';frame.dataset.harnessInstance=${JSON.stringify(instanceToken)};frame.src=feedSrc;
  document.querySelector('[data-testid=feed-root]').appendChild(frame);
}).catch(error=>{status.dataset.state='fail';status.textContent='FAIL: origin reset: '+error});
</script></body></html>`;

const catalogRuntimeHtml = (instanceToken, scenario) => `<!doctype html><html><body><p>Catalog Sort fixture</p><script>
const send=(value)=>parent.postMessage(value,location.origin);
const report=(stage,detail={})=>fetch('/__harness/runtime',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({harnessInstance:${JSON.stringify(instanceToken)},harnessScenario:${JSON.stringify(scenario)},stage,detail})}).catch(()=>{});
report('script_evaluated',{visibility:document.visibilityState});
addEventListener('message',(event)=>{
  if(event.origin!==location.origin||event.source!==parent)return;
  const data=event.data||{};
  if(data.type!=='configure_level')return;
  report('configure_level_received',{visibility:document.visibilityState,specHash:data.spec?.specHash||null});
  send({type:'configured',appliedSpecHash:data.spec.specHash,runtimeContractDigest:${JSON.stringify(contractDigest)},runtimeArtifactDigest:${JSON.stringify(artifactDigest)}});
  report('configured_sent',{visibility:document.visibilityState});
  setTimeout(()=>{report('host_gesture_sent',{visibility:document.visibilityState});send({source:'playable',type:'host_gesture'})},900);
  setTimeout(()=>{report('manual_action_sent',{visibility:document.visibilityState});send({source:'playable',type:'manual_action',actionType:'fixture.sort',actionSeq:1,accepted:true,changedState:true})},1050);
  setTimeout(()=>{report('completed_sent',{visibility:document.visibilityState});send({source:'playable',type:'completed',outcome:'won'})},1350);
});
addEventListener('load',()=>{report('load',{visibility:document.visibilityState});send({type:'configure_ready',nonce:'a'.repeat(32),runtimeContractDigest:${JSON.stringify(contractDigest)},runtimeArtifactDigest:${JSON.stringify(artifactDigest)}})});
</script></body></html>`;

const builtinRuntimeHtml = (playableId) => `<!doctype html><html><body><p>Reviewed builtin ${playableId}</p><script>
const send=(type)=>parent.postMessage({source:'playable',id:${JSON.stringify(playableId)},type},'*');
addEventListener('message',(event)=>{if((event.data||{}).type==='prepareInteractive')setTimeout(()=>send('interactive_ready'),0)});
addEventListener('load',()=>send('static_ready'));
</script></body></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/harness.html')) {
    const scenario = normalizedScenario(url.searchParams.get('scenario'));
    const instanceToken = randomUUID();
    state = freshState(scenario, instanceToken);
    record('harness_started', { scenario, instanceToken });
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(controllerHtml(scenario, instanceToken));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/feed') {
    const instanceToken = url.searchParams.get('harness_instance');
    const scenario = url.searchParams.get('scenario');
    if (!activeInstance(instanceToken, scenario)) return ignoreStaleInstance(response);
    const source = scenario === 'disabled' ? canaryDisabledBuildHtml : canaryBuildHtml;
    if (!source) return json(response, { code: 'harness_build_unavailable' }, 503);
    response.setHeader('content-type', 'text/html; charset=utf-8');
    // The external Telegram SDK is a blocking head script and replaces
    // `window.Telegram` in a plain browser. Install the harness identity after
    // it, but still before the bundled module, so user-scoped durable queues do
    // not silently fall back to a shared anonymous localStorage key.
    response.end(source.replace('</head>', `${injectedBootstrap(instanceToken, scenario)}</head>`));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/__harness/state') {
    const requestedInstance = url.searchParams.get('harness_instance');
    const requestedScenario = url.searchParams.get('scenario');
    if (requestedInstance && !activeInstance(requestedInstance, requestedScenario)) {
      return json(response, { status: 'stale', message: 'harness instance is no longer active' }, 409);
    }
    evaluate();
    return json(response, state ?? { status: 'fail', message: 'open /harness.html first' });
  }
  if (request.method === 'POST' && url.pathname === '/__harness/client') {
    const report = await bodyOf(request);
    const instanceToken = url.searchParams.get('harness_instance');
    const scenario = url.searchParams.get('scenario');
    if (!activeInstance(instanceToken, scenario)
      || report.harnessInstance !== instanceToken || report.harnessScenario !== scenario) {
      return ignoreStaleInstance(response);
    }
    const { harnessInstance: _instance, harnessScenario: _scenario, ...snapshot } = report;
    if (state) {
      if (state.authorityPending) {
        state.pendingSamples += 1;
        const iframeCount = Number(snapshot.currentIframeCount ?? -1);
        const pass = snapshot.currentFrame === 'builtin' && iframeCount === 1
          && snapshot.generatedBadgeVisible !== true;
        if (!state.checkpoints.pendingSurface) {
          state.checkpoints.pendingSurface = { iframeCount, currentFrame: snapshot.currentFrame, pass };
          record('checkpoint_pending_iframe_count', state.checkpoints.pendingSurface);
        }
        if (!pass) state.pendingViolation = true;
      }
      const previous = state.client;
      const signature = JSON.stringify(snapshot);
      if (signature !== state.lastClientSignature) {
        state.lastClientSignature = signature;
        record('client_surface', snapshot);
      }
      state.client = snapshot;
      if (snapshot.chestSeen && !previous.chestSeen && !state.checkpoints.chestAfterExactReceipts) {
        const receipts = state.checkpoints.levelReceipts.filter((checkpoint) => checkpoint.pass);
        const confirmedChestReceipts = state.results.filter((item) => item.kind === 'chest'
          && item.outcome === 'confirmed' && item.body.series_id === ids.series).length;
        const pass = receipts.length === specHashes.length
          && new Set(receipts.map((checkpoint) => checkpoint.ordinal)).size === specHashes.length
          && confirmedChestReceipts === 1;
        state.checkpoints.chestAfterExactReceipts = {
          confirmedExactLevelReceipts: receipts.length,
          expectedLevelReceipts: specHashes.length,
          confirmedExactChestReceipts: confirmedChestReceipts,
          pass,
        };
        record('checkpoint_chest_after_exact_receipts', state.checkpoints.chestAfterExactReceipts);
        if (!pass) {
          state.status = 'fail';
          state.message = 'chest appeared before every exact level and chest result receipt was confirmed';
        }
      }
      if (snapshot.rewardSeen && !previous.rewardSeen && !state.checkpoints.rewardAfterChestReceipt) {
        const confirmedChestReceipts = state.results.filter((item) => item.kind === 'chest'
          && item.outcome === 'confirmed' && item.body.series_id === ids.series).length;
        const pass = confirmedChestReceipts === 1;
        state.checkpoints.rewardAfterChestReceipt = { confirmedExactChestReceipts: confirmedChestReceipts, pass };
        record('checkpoint_reward_after_exact_chest_receipt', state.checkpoints.rewardAfterChestReceipt);
        if (!pass) {
          state.status = 'fail';
          state.message = 'reward appeared before the exact chest receipt was confirmed';
        }
      }
      if (state.scenario === 'recall' && snapshot.recoverySeen && snapshot.currentFrame === 'builtin'
        && !state.checkpoints.recallRecovery) {
        const pass = state.checkpoints.recallResult?.pass === true
          && snapshot.chestSeen === false && snapshot.rewardSeen === false
          && state.results.every((item) => item.kind !== 'chest');
        state.checkpoints.recallRecovery = {
          recallCode: state.checkpoints.recallResult?.code ?? null,
          builtinRestored: snapshot.currentFrame === 'builtin',
          recoveryNotice: snapshot.recoverySeen === true,
          chestSeen: snapshot.chestSeen === true,
          rewardSeen: snapshot.rewardSeen === true,
          pass,
        };
        record('checkpoint_recall_no_reward_builtin_restored', state.checkpoints.recallRecovery);
        if (!pass) {
          state.status = 'fail';
          state.message = 'hard recall recovery was not fail-closed';
        }
      }
      evaluate();
    }
    return json(response, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/__harness/diagnostic') {
    const diagnostic = await bodyOf(request);
    const instanceToken = url.searchParams.get('harness_instance');
    const scenario = url.searchParams.get('scenario');
    if (!activeInstance(instanceToken, scenario)
      || diagnostic.harnessInstance !== instanceToken || diagnostic.harnessScenario !== scenario) {
      return ignoreStaleInstance(response);
    }
    const exact = { kind: diagnostic.kind ?? 'unknown', args: diagnostic.args ?? [] };
    state.diagnostics.push(exact);
    record('diagnostic', exact);
    return json(response, { ok: true });
  }
  if (request.method === 'POST' && url.pathname === '/__harness/runtime') {
    const runtimeEvent = await bodyOf(request);
    if (!activeInstance(runtimeEvent.harnessInstance, runtimeEvent.harnessScenario)) {
      return ignoreStaleInstance(response);
    }
    const exact = { stage: runtimeEvent.stage ?? 'unknown', detail: runtimeEvent.detail ?? {} };
    state.runtimeEvents.push(exact);
    record('runtime', exact);
    return json(response, { ok: true });
  }
  const statefulHarnessApi = (request.method === 'POST' && [
    '/api/session',
    '/api/cp/events',
    '/api/feed/catalog-authority',
    '/api/catalog/allocate-authorized',
    '/api/runs/start',
    '/api/results',
  ].includes(url.pathname)) || (request.method === 'GET'
    && (url.pathname === '/api/catalog/canary-authority'
      || /^\/api\/catalog\/tickets\/[^/]+\/specs$/.test(url.pathname)));
  if (statefulHarnessApi && !authorizedForActiveInstance(request)) {
    return ignoreStaleInstance(response);
  }
  if (request.method === 'POST' && url.pathname === '/api/session') {
    record('session');
    return json(response, {
      user: { id: state.userId, ref_code: 'dogfood' }, ref_code: 'dogfood',
      balance: 0, puzzles: 0, is_new: false, backend_version: 'dogfood-harness',
      builtin_feed_bindings: {
        schema: 'feed.builtin-bindings.v1', available: true, unavailable_reason: null,
        by_playable_id: {
          'merge-locked-v1-swipe': {
            mapping_id: ids.mapping,
            playable_id: 'merge-locked-v1-swipe',
            variant_id: ids.builtinVariant,
            catalog_mechanic: 'merge/locked',
            mechanic_family: 'merge',
            mapping_version: 'dogfood.fixture.v1',
            mapping_digest: 'b'.repeat(64),
          },
        },
      },
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/cp/events') {
    const body = await bodyOf(request);
    const replayConflictBatch = state?.scenario === 'replay-conflict'
      && body.events.some((event) => event.event_name === 'catalog_level_impression');
    if (replayConflictBatch && state.replayConflictTransportAttempts < 2) {
      state.replayConflictTransportAttempts += 1;
      record('replay_conflict_cp_transport_failure', {
        attempt: state.replayConflictTransportAttempts,
      });
      return json(response, { code: 'fixture_transient_cp_failure' }, 503);
    }
    if (replayConflictBatch && state) {
      state.replayConflictTransportAttempts += 1;
      // Keep the canary inert beyond every fixture gameplay timer
      // (900/1050/1350ms), then reject before the 2500ms safety deadline.
      await new Promise((resolve) => setTimeout(resolve, 1450));
    }
    const previousIds = new Set(state?.cpEvents.map((event) => event.event_id) ?? []);
    state?.cpEvents.push(...body.events);
    for (const event of body.events) {
      record('cp', { name: event.event_name, eventId: event.event_id });
      if (state && event.event_name === 'catalog_level_impression' && !previousIds.has(event.event_id)) {
        const ordinal = event.payload?.ordinal;
        const ordinalCount = uniqueEvents('catalog_level_impression')
          .filter((candidate) => candidate.payload?.ordinal === ordinal).length;
        const checkpoint = {
          ordinal,
          impressionId: event.payload?.impression_id ?? null,
          levelImpressionId: event.payload?.level_impression_id ?? null,
          uniqueConfiguredImpressionsForOrdinal: ordinalCount,
          pass: Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= specHashes.length
            && ordinalCount === 1,
        };
        state.checkpoints.configuredImpressions.push(checkpoint);
        record('checkpoint_configured_specialized_impression_once', checkpoint);
        if (!checkpoint.pass) {
          state.status = 'fail';
          state.message = `configured specialized impression was not unique for ordinal ${String(ordinal)}`;
        }
      }
    }
    return json(response, { events: body.events.map((event, item_index) => {
      const replayConflict = state?.scenario === 'replay-conflict'
        && event.event_name === 'catalog_level_impression';
      if (replayConflict && state) {
        state.checkpoints.replayConflict = {
          eventId: event.event_id,
          ticketId: event.payload?.ticket_id ?? null,
          ordinal: event.payload?.ordinal ?? null,
          pass: event.payload?.ticket_id === ids.authorization && event.payload?.ordinal === 1,
        };
        record('checkpoint_allocation_race_configured_impression_conflict', state.checkpoints.replayConflict);
      }
      return {
        event_id: event.event_id,
        item_index,
        status: replayConflict ? 'rejected' : 'projected',
        reject_reason: replayConflict ? 'catalog_level_impression_conflict' : null,
      };
    }) });
  }
  if (request.method === 'GET' && url.pathname === '/api/catalog/canary-authority') {
    const requestEvidence = {
      method: request.method,
      path: url.pathname,
      query: url.search,
      contentLength: request.headers['content-length'] ?? null,
    };
    state?.canaryRequests.push(requestEvidence);
    if (state) state.authorityPending = true;
    record('canary_authority_pending', requestEvidence);
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (state) state.authorityPending = false;
    if (state?.scenario === 'no-invite') {
      record('canary_authority_missing');
      return json(response, { code: 'catalog_canary_invitation_not_found' }, 404);
    }
    if (!canaryScenarios.has(state?.scenario ?? '') && state?.scenario !== 'replayed-canary') {
      if (state) {
        state.status = 'fail';
        state.message = `canary endpoint was called in ${state.scenario}`;
      }
      return json(response, { code: 'catalog_canary_not_available' }, 404);
    }
    record('canary_authority', { authorizationId: ids.authorization });
    return json(response, {
      schema: 'catalog.canary-authority-result.v1',
      authorizationId: ids.authorization,
      authorizationDigest: '8'.repeat(64),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      // replay-conflict models two tabs which both observed fresh authority;
      // only the allocation/closure reveals that one tab committed first.
      replayed: state?.scenario === 'replayed-canary',
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/feed/catalog-authority') {
    const body = await bodyOf(request);
    state?.authorityRequests.push(body);
    if (state) state.authorityPending = true;
    record('authority_pending', { sourceDecisionId: body.sourceDecisionId });
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (state) state.authorityPending = false;
    if (state?.scenario === 'no-invite') {
      record('authority_builtin_fallback');
      return json(response, {
        schema: 'feed.catalog-authority-result.v1', requestId: body.requestId,
        sourceDecisionId: body.sourceDecisionId, planId: ids.plan,
        planDigest: '9'.repeat(64), outcome: 'builtin_fallback',
        authorizationId: null, authorizationDigest: null, expiresAt: null,
        fallback: {
          mappingId: ids.mapping,
          playableId: 'merge-locked-v1-swipe',
          variantId: ids.builtinVariant,
          catalogMechanic: 'merge/locked',
        },
      });
    }
    if (!['disabled', 'replayed-canary'].includes(state?.scenario ?? '')) {
      if (state) {
        state.status = 'fail';
        state.message = `normal authority was called after a canary invitation in ${state.scenario}`;
      }
      return json(response, { code: 'unexpected_normal_authority' }, 500);
    }
    record('authority_catalog');
    return json(response, {
      schema: 'feed.catalog-authority-result.v1', requestId: body.requestId,
      sourceDecisionId: body.sourceDecisionId, planId: ids.plan,
      planDigest: '9'.repeat(64), outcome: 'catalog_authorized',
      authorizationId: ids.authorization, authorizationDigest: '8'.repeat(64),
      expiresAt: new Date(Date.now() + 30_000).toISOString(), fallback: null,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/catalog/allocate-authorized') {
    const body = await bodyOf(request);
    state?.allocationRequests.push(body);
    record('allocated', { authorizationId: body.authorizationId });
    const exactAllocation = allocationForScenario(state?.scenario ?? 'disabled');
    state?.allocationResponses.push(exactAllocation);
    return json(response, {
      schema: 'catalog.allocate-authorized-result.v2',
      authorizationId: ids.authorization, authorizationDigest: '8'.repeat(64), allocation: exactAllocation,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/runs/start') {
    const body = await bodyOf(request);
    state?.ticketRequests.push(body);
    record('ticket', { ticketId: body.ticket_id, runId: body.run_id });
    return json(response, ticketView(body));
  }
  const specsMatch = url.pathname.match(/^\/api\/catalog\/tickets\/([^/]+)\/specs$/);
  if (request.method === 'GET' && specsMatch) {
    if (state) state.specRequests += 1;
    record('spec_bundle', { ticketId: specsMatch[1] });
    return json(response, bundle(specsMatch[1]));
  }
  if (request.method === 'POST' && url.pathname === '/api/results') {
    const body = await bodyOf(request);
    const kind = body.metric_key === 'series' ? 'chest' : 'level';
    if (state?.scenario === 'result-transient' && kind === 'level' && !state.resultTransientInjected) {
      state.resultTransientInjected = true;
      state.resultAttempts.push({ kind, outcome: 'transient', status: 503, body });
      record('result_transient_failure', { kind, runId: body.run_id });
      return json(response, { code: 'fixture_transient_result' }, 503);
    }
    if (state?.scenario === 'result-timeout' && kind === 'level' && !state.resultTimeoutInjected) {
      state.resultTimeoutInjected = true;
      state.resultAttempts.push({ kind, outcome: 'hung', status: 0, body });
      record('result_hung_until_client_abort', { kind, runId: body.run_id });
      // Deliberately leave the HTTP response open. The production timeout must
      // abort this socket, release the global drain promise, and retry the exact
      // durable body without a visibility or foreground event.
      return;
    }
    if (state?.scenario === 'recall' && kind === 'level') {
      state.results.push({ kind, outcome: 'revoked', body });
      state.checkpoints.recallResult = {
        code: 'catalog_ticket_revoked',
        runId: body.run_id,
        ordinal: body.ordinal,
        specHash: body.applied_spec_hash,
        pass: body.ordinal === 1 && body.applied_spec_hash === specHashes[0]
          && body.series_id === ids.series,
      };
      record('checkpoint_recall_result_code', state.checkpoints.recallResult);
      return json(response, { code: 'catalog_ticket_revoked' }, 410);
    }
    state?.resultAttempts.push({ kind, outcome: 'confirmed', status: 200, body });
    state?.results.push({ kind, outcome: 'confirmed', body });
    if (state && kind === 'level') {
      const expectedHash = specHashes[Number(body.ordinal) - 1];
      const checkpoint = {
        ordinal: body.ordinal,
        runId: body.run_id,
        specHash: body.applied_spec_hash,
        seriesId: body.series_id,
        pass: Number.isInteger(body.ordinal) && expectedHash !== undefined
          && body.applied_spec_hash === expectedHash && body.series_id === ids.series,
      };
      state.checkpoints.levelReceipts.push(checkpoint);
      record('checkpoint_exact_level_result_confirmed', checkpoint);
      if (!checkpoint.pass) {
        state.status = 'fail';
        state.message = `level ${String(body.ordinal)} result receipt did not match the exact catalog binding`;
      }
    } else {
      const checkpoint = {
        runId: body.run_id,
        seriesId: body.series_id,
        pass: body.series_id === ids.series,
      };
      record('checkpoint_exact_chest_result_confirmed', checkpoint);
      if (!checkpoint.pass && state) {
        state.status = 'fail';
        state.message = 'chest result receipt did not match the exact catalog series';
      }
    }
    return json(response, {
      is_best: true, stars_awarded: body.stars ?? 0,
      balance: kind === 'chest' ? body.stars ?? 0 : 0,
      puzzles_awarded: kind === 'chest' ? 1 : 0, puzzle_balance: kind === 'chest' ? 1 : 0,
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/daily/sync') {
    return json(response, { code: 'daily_not_configured' }, 404);
  }
  if (url.pathname === '/versions.json') return json(response, {});
  if (url.pathname === `/catalog-previews/${manifest.contentHash}.preview.json`) {
    return json(response, {
      schema: 'catalog.generated-preview.v1',
      captureContract: 'sort.generated-preview.v1',
      contentHash: manifest.contentHash,
      runtimeArtifactDigest: artifactDigest,
      covers: {
        mobile: { file: `${manifest.contentHash}.cover.jpg`, sha256: previewDigest, width: 390, height: 600 },
        compact: { file: `${manifest.contentHash}.cover.c.jpg`, sha256: previewDigest, width: 390, height: 488 },
      },
    });
  }
  if (url.pathname === `/catalog-previews/${manifest.contentHash}.cover.jpg`
    || url.pathname === `/catalog-previews/${manifest.contentHash}.cover.c.jpg`) {
    response.setHeader('content-type', 'image/jpeg');
    response.setHeader('content-length', String(previewJpeg.byteLength));
    response.end(previewJpeg);
    return;
  }
  if (url.pathname === `/runtime-releases/marble-sort-swipe/${artifactHex}/index.html`) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(catalogRuntimeHtml(state?.instanceToken ?? '', state?.scenario ?? ''));
    return;
  }
  if (url.pathname.endsWith('.html')) {
    const playableId = path.basename(url.pathname, '.html');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(builtinRuntimeHtml(playableId));
    return;
  }
  if (url.pathname.startsWith('/api/')) return json(response, { code: 'fixture_not_configured' }, 404);
  response.statusCode = 404;
  response.end('not found');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;

const buildFeed = (canaryEnabled) => {
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      VITE_API_BASE: origin,
      VITE_CONTROL_PLANE_ENABLED: 'true',
      VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
      VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
      VITE_CATALOG_CANARY_DOGFOOD_ENABLED: canaryEnabled ? 'true' : 'false',
      VITE_CATALOG_DOGFOOD_USER_ID: String(dogfoodUserId),
    },
  });
  if (build.status !== 0) {
    process.stderr.write(`${build.stdout}\n${build.stderr}\n`);
    return { ok: false, html: '', status: build.status ?? 1 };
  }
  return {
    ok: true,
    html: readFileSync(path.join(root, 'dist', 'index.html'), 'utf8'),
    status: 0,
  };
};

const enabledBuild = buildFeed(true);
if (!enabledBuild.ok) {
  await new Promise((resolve) => server.close(resolve));
  process.exit(enabledBuild.status);
}
canaryBuildHtml = enabledBuild.html;
const disabledBuild = buildFeed(false);
if (!disabledBuild.ok) {
  await new Promise((resolve) => server.close(resolve));
  process.exit(disabledBuild.status);
}
canaryDisabledBuildHtml = disabledBuild.html;

console.log(JSON.stringify({
  successUrl: `${origin}/harness.html?scenario=success`,
  transientResultUrl: `${origin}/harness.html?scenario=result-transient`,
  timeoutResultUrl: `${origin}/harness.html?scenario=result-timeout`,
  recallUrl: `${origin}/harness.html?scenario=recall`,
  replayConflictUrl: `${origin}/harness.html?scenario=replay-conflict`,
  noInviteUrl: `${origin}/harness.html?scenario=no-invite`,
  replayedCanaryUrl: `${origin}/harness.html?scenario=replayed-canary`,
  wrongAccountUrl: `${origin}/harness.html?scenario=wrong-account`,
  disabledUrl: `${origin}/harness.html?scenario=disabled`,
  stateUrl: `${origin}/__harness/state`,
}));

const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
