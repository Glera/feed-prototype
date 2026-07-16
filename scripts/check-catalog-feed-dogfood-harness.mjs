import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_HASH,
  EXACT_THREE_LEVEL_SPEC_HASHES,
} from '../src/catalog-three-level-production-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, ['scripts/serve-catalog-feed-dogfood-harness.mjs'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });

const endpoints = await new Promise((resolve, reject) => {
  let stdout = '';
  const timeout = setTimeout(() => reject(new Error(`harness startup timed out\n${stderr}`)), 30_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.successUrl && parsed.recallUrl && parsed.replayConflictUrl && parsed.noInviteUrl
          && parsed.wrongAccountUrl && parsed.disabledUrl && parsed.stateUrl) {
          clearTimeout(timeout);
          resolve(parsed);
          return;
        }
      } catch { /* npm/build output is not the endpoint JSON */ }
    }
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    reject(new Error(`harness exited before startup (${String(code)})\n${stderr}\n${stdout}`));
  });
});

const controllerInstance = async (url) => {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  const match = html.match(/data-harness-instance="([0-9a-f-]+)"/);
  assert.ok(match, 'controller must embed its harness instance token');
  const feedMatch = html.match(/const feedSrc=("(?:[^"\\]|\\.)*");/);
  assert.ok(feedMatch, 'controller must defer one instance-bound Feed URL until origin reset');
  return { instanceToken: match[1], feedUrl: new URL(JSON.parse(feedMatch[1]), url).href, html };
};

const initDataFor = (instanceToken, scenario) => new URLSearchParams({
  query_id: 'dogfood',
  harness_instance: instanceToken,
  harness_scenario: scenario,
  user: JSON.stringify({ id: 424242 }),
  hash: 'dogfood',
}).toString();

try {
  const recall = await controllerInstance(endpoints.recallUrl);
  assert.equal(recall.html.includes('<iframe data-testid="feed"'), false,
    'controller must not create Feed before durable origin state is cleared');
  for (const resetContract of [
    'localStorage.clear()', 'sessionStorage.clear()', 'caches.keys()',
    'navigator.serviceWorker.getRegistrations()', 'indexedDB.databases()',
    'clearOriginState().then',
  ]) assert.ok(recall.html.includes(resetContract), `controller origin reset must include ${resetContract}`);
  const staleInstance = recall.instanceToken;
  const recallFeed = await fetch(recall.feedUrl).then((response) => response.text());
  const telegramSdkAt = recallFeed.indexOf('https://telegram.org/js/telegram-web-app.js');
  const harnessIdentityAt = recallFeed.indexOf(`const harnessInstance=${JSON.stringify(staleInstance)}`);
  assert.ok(telegramSdkAt >= 0 && harnessIdentityAt > telegramSdkAt,
    'harness identity must be installed after the Telegram SDK replaces window.Telegram');

  const legacyStart = await fetch(`${new URL(endpoints.stateUrl).origin}/api/runs/start`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(staleInstance, 'recall')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ticket_id: '20000000-0000-4000-8000-000000000001',
      run_id: 'legacy-recall-fallback',
      mechanic_id: 'merge-locked-v1-swipe',
      variant_id: '10000000-0000-4000-8000-000000000002',
      kind: 'single',
    }),
  });
  assert.equal(legacyStart.status, 200);
  const legacyTicket = await legacyStart.json();
  assert.equal(legacyTicket.schema, undefined, 'legacy fallback must not receive a v2 ticket view');
  assert.equal(legacyTicket.ticket_id, '20000000-0000-4000-8000-000000000001');
  assert.equal(legacyTicket.run_id, 'legacy-recall-fallback');
  assert.equal(legacyTicket.kind, 'single');
  assert.equal(legacyTicket.state, 'active');

  const success = await controllerInstance(endpoints.successUrl);
  const activeInstance = success.instanceToken;
  assert.notEqual(activeInstance, staleInstance, 'each harness navigation needs a fresh instance');

  const successCanary = await fetch(`${new URL(endpoints.stateUrl).origin}/api/catalog/canary-authority`, {
    headers: { authorization: `tma ${initDataFor(activeInstance, 'success')}` },
  });
  assert.equal(successCanary.status, 200);
  const successCanaryBody = await successCanary.json();
  assert.equal(successCanaryBody.schema, 'catalog.canary-authority-result.v1');
  assert.equal(successCanaryBody.authorizationId, '10000000-0000-4000-8000-000000000004');
  assert.equal(successCanaryBody.authorizationDigest, '8'.repeat(64));
  assert.match(successCanaryBody.expiresAt, /Z$/);
  assert.equal(successCanaryBody.replayed, false);

  const staleSnapshot = {
    harnessInstance: staleInstance,
    harnessScenario: 'recall',
    currentFrame: 'catalog',
    currentIframeCount: 1,
    catalogSeen: true,
    builtinSeen: false,
    chestSeen: true,
    rewardSeen: true,
    recoverySeen: false,
    preloaderVisible: false,
  };
  const staleClient = await fetch(
    `${new URL(endpoints.stateUrl).origin}/__harness/client?harness_instance=${staleInstance}&scenario=recall`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(staleSnapshot),
    },
  );
  assert.equal(staleClient.status, 202);
  assert.equal((await staleClient.json()).ignored, 'stale_harness_instance');

  const staleControlPlane = await fetch(`${new URL(endpoints.stateUrl).origin}/api/cp/events`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(staleInstance, 'recall')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ events: [{ event_id: 'stale-event' }] }),
  });
  assert.equal(staleControlPlane.status, 202);
  assert.equal((await staleControlPlane.json()).ignored, 'stale_harness_instance');

  const successAllocation = await fetch(`${new URL(endpoints.stateUrl).origin}/api/catalog/allocate-authorized`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(activeInstance, 'success')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      schema: 'catalog.allocate-authorized.v2',
      authorizationId: '10000000-0000-4000-8000-000000000004',
    }),
  });
  assert.equal(successAllocation.status, 200);
  const successAllocationBody = await successAllocation.json();
  assert.equal(successAllocationBody.allocation.catalog.entryState, 'canary');
  assert.equal(successAllocationBody.allocation.slotType, 'canary-dogfood');
  assert.equal(successAllocationBody.allocation.policyVersion, 'catalog-canary-dogfood.v1');

  const catalogStart = await fetch(`${new URL(endpoints.stateUrl).origin}/api/runs/start`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(activeInstance, 'success')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      schema: 'run.start.v2',
      ticket_id: '10000000-0000-4000-8000-000000000004',
      run_id: 'catalog-canary:10000000-0000-4000-8000-000000000004',
      mechanic_id: 'marble-sort-swipe',
      variant_id: '10000000-0000-4000-8000-000000000009',
      kind: 'series',
      decision_id: '10000000-0000-4000-8000-000000000005',
    }),
  });
  assert.equal(catalogStart.status, 200);
  const catalogTicket = await catalogStart.json();
  assert.equal(catalogTicket.schema, 'run.ticket.v3');
  assert.equal(catalogTicket.skin_hash, EXACT_THREE_LEVEL_SKIN_HASH);
  assert.equal(catalogTicket.skin_contract_digest, EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST);
  assert.equal(catalogTicket.ticket_id, '10000000-0000-4000-8000-000000000004');
  assert.equal(catalogTicket.run_id, 'catalog-canary:10000000-0000-4000-8000-000000000004');
  assert.equal(catalogTicket.decision_id, '10000000-0000-4000-8000-000000000005');

  let activeState = await fetch(endpoints.stateUrl).then((response) => response.json());
  assert.equal(activeState.instanceToken, activeInstance);
  assert.equal(activeState.scenario, 'success');
  assert.equal(activeState.status, 'running');
  assert.equal(activeState.client.chestSeen, false);
  assert.equal(activeState.client.rewardSeen, false);
  assert.equal(activeState.cpEvents.length, 0);
  assert.equal(activeState.ticketRequests.length, 1);
  assert.equal(activeState.ticketRequests[0].schema, 'run.start.v2');
  assert.equal(activeState.trace.some((item) => item.type === 'client_surface'), false);

  const activeSnapshot = {
    harnessInstance: activeInstance,
    harnessScenario: 'success',
    currentFrame: 'none',
    currentIframeCount: 0,
    catalogSeen: false,
    builtinSeen: false,
    chestSeen: false,
    rewardSeen: false,
    recoverySeen: false,
    preloaderVisible: true,
  };
  const activeClient = await fetch(
    `${new URL(endpoints.stateUrl).origin}/__harness/client?harness_instance=${activeInstance}&scenario=success`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(activeSnapshot),
    },
  );
  assert.equal(activeClient.status, 200);

  activeState = await fetch(endpoints.stateUrl).then((response) => response.json());
  assert.equal(activeState.instanceToken, activeInstance);
  assert.equal(activeState.client.currentFrame, 'none');
  assert.equal(activeState.trace.filter((item) => item.type === 'client_surface').length, 1);

  const replayConflict = await controllerInstance(endpoints.replayConflictUrl);
  assert.ok(replayConflict.html.includes('scenario=replay-conflict'));
  const replayCanary = await fetch(`${new URL(endpoints.stateUrl).origin}/api/catalog/canary-authority`, {
    headers: { authorization: `tma ${initDataFor(replayConflict.instanceToken, 'replay-conflict')}` },
  });
  assert.equal(replayCanary.status, 200);
  const replayCanaryBody = await replayCanary.json();
  assert.equal(replayCanaryBody.replayed, false,
    'the allocation-race regression starts from two tabs which both observed fresh authority');
  assert.equal(replayCanaryBody.authorizationId, '10000000-0000-4000-8000-000000000004');
  const replayAllocation = await fetch(`${new URL(endpoints.stateUrl).origin}/api/catalog/allocate-authorized`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(replayConflict.instanceToken, 'replay-conflict')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      schema: 'catalog.allocate-authorized.v2',
      authorizationId: replayCanaryBody.authorizationId,
    }),
  });
  assert.equal(replayAllocation.status, 200);
  assert.equal((await replayAllocation.json()).allocation.catalog.entryState, 'canary');
  const replayStart = await fetch(`${new URL(endpoints.stateUrl).origin}/api/runs/start`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(replayConflict.instanceToken, 'replay-conflict')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      schema: 'run.start.v2',
      ticket_id: replayCanaryBody.authorizationId,
      run_id: `catalog-canary:${replayCanaryBody.authorizationId}`,
      mechanic_id: 'marble-sort-swipe',
      variant_id: '10000000-0000-4000-8000-000000000009',
      kind: 'series',
      decision_id: '10000000-0000-4000-8000-000000000005',
    }),
  });
  assert.equal(replayStart.status, 200);
  const replayTicket = await replayStart.json();
  assert.equal(replayTicket.ticket_id, replayCanaryBody.authorizationId);
  assert.equal(replayTicket.run_id, `catalog-canary:${replayCanaryBody.authorizationId}`);
  assert.equal(replayTicket.state, 'active');
  assert.equal(replayTicket.completed_levels, 0);
  const replayCpRequest = () => fetch(`${new URL(endpoints.stateUrl).origin}/api/cp/events`, {
    method: 'POST',
    headers: {
      authorization: `tma ${initDataFor(replayConflict.instanceToken, 'replay-conflict')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ events: [{
      event_id: '30000000-0000-4000-8000-000000000001',
      event_name: 'catalog_level_impression_v2',
      payload: {
        ticket_id: '10000000-0000-4000-8000-000000000004',
        ordinal: 1,
        level_spec_hash: EXACT_THREE_LEVEL_SPEC_HASHES[0],
        applied_spec_hash: EXACT_THREE_LEVEL_SPEC_HASHES[0],
        skin_hash: EXACT_THREE_LEVEL_SKIN_HASH,
        applied_skin_hash: EXACT_THREE_LEVEL_SKIN_HASH,
        skin_contract_digest: EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
      },
    }] }),
  });
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const replayCpTransient = await replayCpRequest();
    assert.equal(replayCpTransient.status, 503,
      `the allocation-race harness must preserve the event through transport failure ${attempt}`);
  }
  const replayCp = await replayCpRequest();
  assert.equal(replayCp.status, 200);
  const replayCpBody = await replayCp.json();
  assert.equal(replayCpBody.events[0].status, 'rejected');
  assert.equal(replayCpBody.events[0].reject_reason, 'catalog_level_impression_conflict');

  const noInvite = await controllerInstance(endpoints.noInviteUrl);
  const noInviteProbe = await fetch(`${new URL(endpoints.stateUrl).origin}/api/catalog/canary-authority`, {
    headers: { authorization: `tma ${initDataFor(noInvite.instanceToken, 'no-invite')}` },
  });
  assert.equal(noInviteProbe.status, 404);
  assert.deepEqual(await noInviteProbe.json(), { code: 'catalog_canary_invitation_not_found' });
  const noInviteState = await fetch(endpoints.stateUrl).then((response) => response.json());
  assert.deepEqual(noInviteState.canaryRequests, [{
    method: 'GET', path: '/api/catalog/canary-authority', query: '', contentLength: null,
  }]);

  const wrongAccount = await controllerInstance(endpoints.wrongAccountUrl);
  const wrongAccountFeed = await fetch(wrongAccount.feedUrl).then((response) => response.text());
  assert.ok(wrongAccountFeed.includes('initDataUnsafe:{user:{id:7}'),
    'wrong-account build fixture must carry a real mismatched Telegram identity');
  const wrongAccountState = await fetch(endpoints.stateUrl).then((response) => response.json());
  assert.equal(wrongAccountState.userId, 7);
  assert.equal(wrongAccountState.canaryRequests.length, 0);
  assert.equal(wrongAccountState.authorityRequests.length, 0);

  const disabled = await controllerInstance(endpoints.disabledUrl);
  const disabledFeed = await fetch(disabled.feedUrl);
  assert.equal(disabledFeed.status, 200, 'the separately built canary-disabled production bundle must be served');
  const disabledState = await fetch(endpoints.stateUrl).then((response) => response.json());
  assert.equal(disabledState.canaryRequests.length, 0);
  assert.equal(disabledState.authorityRequests.length, 0);
  console.log('catalog feed dogfood harness: canary routes/builds and stale instances are isolated');
} finally {
  child.kill('SIGTERM');
}
