import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractDigest = 'c'.repeat(64);
const artifactHex = 'd'.repeat(64);
const artifactDigest = `sha256:${artifactHex}`;
let origin = '';
let currentScenario = 'success';

const jsonScript = (value) => JSON.stringify(value).replaceAll('<', '\\u003c');

const harnessHtml = () => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Catalog player v2 browser harness</title>
  <style>
    body { font: 15px/1.45 system-ui, sans-serif; margin: 24px; color: #15202b; }
    main { max-width: 860px; margin: auto; }
    output { display: inline-block; padding: 6px 10px; border-radius: 7px; background: #eef2f6; }
    output[data-state="pass"] { background: #d9f7e6; color: #075b2c; }
    output[data-state="fail"] { background: #ffe0e0; color: #8c1111; }
    iframe { width: 320px; height: 180px; border: 1px solid #ccd4dd; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f6f8fa; padding: 12px; }
  </style>
</head>
<body>
<main>
  <h1>Catalog player v2 browser harness</h1>
  <p>Scenario: <strong data-testid="scenario"></strong></p>
  <p>Status: <output data-testid="status" data-state="running">RUNNING</output></p>
  <section data-testid="frames"></section>
  <pre data-testid="trace">[]</pre>
</main>
<script type="module">
import {
  CatalogPlayerV2Session,
  buildCatalogLevelImpression,
  catalogPlayerV2Enabled,
} from '/src/catalog-player-v2.mjs';

const scenario = new URL(location.href).searchParams.get('scenario') || 'success';
const contractDigest = ${jsonScript(contractDigest)};
const artifactDigest = ${jsonScript(artifactDigest)};
const trace = [];
const seriesImpressionId = crypto.randomUUID();
const frames = document.querySelector('[data-testid="frames"]');
const status = document.querySelector('[data-testid="status"]');
document.querySelector('[data-testid="scenario"]').textContent = scenario;

const record = (type, detail = {}) => {
  trace.push({ type, ...detail });
  document.querySelector('[data-testid="trace"]').textContent = JSON.stringify(trace, null, 2);
};
const finish = (state, message) => {
  status.dataset.state = state;
  status.textContent = state.toUpperCase() + ': ' + message;
  window.__catalogPlayerV2Harness = { state, scenario, trace };
};
const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};
const makeSpec = (specHash, seed) => ({
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
const hashes = ['1'.repeat(64), '2'.repeat(64)];
const bundle = {
  schema: 'catalog.ticket-level-spec-bundle.v1',
  ticketId: '00000000-0000-4000-8000-000000000001',
  ticketState: 'active',
  decisionId: '00000000-0000-4000-8000-000000000002',
  catalogEntryId: '00000000-0000-4000-8000-000000000003',
  seriesId: '00000000-0000-4000-8000-000000000004',
  manifestContentHash: 'e'.repeat(64),
  runtime: {
    releaseId: '00000000-0000-4000-8000-000000000005',
    playableId: 'marble-sort-swipe',
    legacyVariantId: '00000000-0000-4000-8000-000000000006',
    runtimeContractDigest: contractDigest,
    runtimeArtifactDigest: artifactDigest,
    indexLocator: 'runtime-releases/marble-sort-swipe/${artifactHex}/index.html',
    sidecarLocator: 'runtime-releases/marble-sort-swipe/${artifactHex}/runtime-artifact.json',
    capabilities: { catalogRequiredHandshake: true, sortLevelSpecV1: true },
  },
  levels: hashes.map((specHash, index) => ({
    ordinal: index + 1,
    specHash,
    spec: makeSpec(specHash, 137 + index),
  })),
};

async function runLevel(ordinal, frameEpoch) {
  const iframe = document.createElement('iframe');
  iframe.title = 'catalog-level-' + ordinal;
  iframe.dataset.testid = 'runtime-' + ordinal;
  frames.append(iframe);
  const session = new CatalogPlayerV2Session({
    bundle,
    ordinal,
    frameEpoch,
    frameSource: iframe.contentWindow,
    baseUrl: location.href,
  });
  iframe.referrerPolicy = session.navigation.referrerPolicy;
  session.setVisible(true, frameEpoch);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const result = session.fail('timeout', frameEpoch);
      processEffects(result.effects);
      reject(new Error('level ' + ordinal + ' timed out'));
    }, 3000);
    const done = (kind) => {
      clearTimeout(timeout);
      removeEventListener('message', onMessage);
      resolve(kind);
    };
    const processEffects = (effects) => {
      for (const effect of effects) {
        if (effect.type === 'post_configure_level') {
          record('configure_level', { ordinal });
          iframe.contentWindow.postMessage(effect.message, effect.targetOrigin);
        } else if (effect.type === 'catalog_reveal_ready') {
          const payload = buildCatalogLevelImpression(
            session.binding,
            seriesImpressionId,
            crypto.randomUUID(),
          );
          record('catalog_level_impression', { ordinal, payload });
          record('attempt_start', {
            ordinal,
            ticket_id: payload.ticket_id,
            level_impression_id: payload.level_impression_id,
          });
          done('revealed');
        } else if (effect.type === 'catalog_configuration_failure') {
          record('catalog_configuration_failure', { ordinal, payload: effect.payload });
          done('failed');
        }
      }
    };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      record(event.data?.type || 'unknown_runtime_message', { ordinal });
      processEffects(session.handleMessage(event, frameEpoch).effects);
    };
    addEventListener('message', onMessage);
    iframe.src = session.navigation.src;
  });
}

try {
  const enabled = catalogPlayerV2Enabled(
    { VITE_CATALOG_PLAYER_V2_ENABLED: scenario === 'disabled' ? 'false' : 'true' },
    true,
    true,
  );
  if (!enabled) {
    invariant(frames.querySelectorAll('iframe').length === 0, 'disabled path mounted an iframe');
    record('disabled_without_mount');
    finish('pass', 'both gates are required and no runtime mounted');
  } else if (scenario === 'success') {
    invariant(await runLevel(1, 1) === 'revealed', 'level 1 was not revealed');
    invariant(await runLevel(2, 2) === 'revealed', 'level 2 was not revealed');
    const impressions = trace.filter((item) => item.type === 'catalog_level_impression');
    const attempts = trace.filter((item) => item.type === 'attempt_start');
    invariant(impressions.length === 2 && attempts.length === 2, 'two configured levels did not start exactly once');
    invariant(new Set(impressions.map((item) => item.payload.impression_id)).size === 1, 'series did not reuse its parent impression id');
    invariant(new Set(impressions.map((item) => item.payload.level_impression_id)).size === 2, 'levels reused a level impression id');
    invariant(!trace.some((item) => item.type === 'unit_impression'), 'generic seen event was emitted');
    finish('pass', 'two levels configured before reveal and attempt start');
  } else {
    invariant(await runLevel(1, 1) === 'failed', 'negative runtime was not fenced');
    invariant(trace.filter((item) => item.type === 'catalog_configuration_failure').length === 1, 'failure evidence missing');
    invariant(!trace.some((item) => item.type === 'catalog_level_impression'), 'failure created false seen');
    invariant(!trace.some((item) => item.type === 'attempt_start'), 'failure created an attempt');
    finish('pass', 'pre-ACK failure emitted no impression or attempt');
  }
} catch (error) {
  record('harness_error', { message: String(error?.stack || error) });
  finish('fail', String(error?.message || error));
}
</script>
</body>
</html>`;

const runtimeHtml = (scenario) => `<!doctype html>
<html><body><p>Fake content-addressed Sort runtime</p><script>
const contractDigest = ${jsonScript(contractDigest)};
const artifactDigest = ${jsonScript(artifactDigest)};
const scenario = ${jsonScript(scenario)};
const send = (value) => parent.postMessage(value, location.origin);
addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== parent) return;
  const data = event.data || {};
  if (data.type !== 'configure_level') return;
  if (scenario === 'mount') {
    send({ type: 'configure_failed', reason: 'mount' });
    return;
  }
  send({
    type: 'configured',
    appliedSpecHash: data.spec.specHash,
    runtimeContractDigest: contractDigest,
    runtimeArtifactDigest: artifactDigest,
  });
});
addEventListener('load', () => send({
  type: 'configure_ready',
  nonce: 'a'.repeat(32),
  runtimeContractDigest: contractDigest,
  runtimeArtifactDigest: scenario === 'digest' ? 'sha256:' + 'f'.repeat(64) : artifactDigest,
}));
</script></body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', origin || 'http://127.0.0.1');
  if (url.pathname === '/' || url.pathname === '/harness.html') {
    currentScenario = url.searchParams.get('scenario') || 'success';
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(harnessHtml());
    return;
  }
  if (url.pathname === '/src/catalog-player-v2.mjs') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(readFileSync(path.join(root, 'src', 'catalog-player-v2.mjs')));
    return;
  }
  if (url.pathname === `/runtime-releases/marble-sort-swipe/${artifactHex}/index.html`) {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(runtimeHtml(currentScenario));
    return;
  }
  response.statusCode = 404;
  response.end('not found');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
origin = `http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({ url: `${origin}/harness.html` }));
