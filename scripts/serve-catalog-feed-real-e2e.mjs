import { spawnSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogDogfoodAccountEligible } from '../src/catalog-feed-authority.mjs';
import { buildThreeLevelLiveOperatorObservation } from '../src/catalog-three-level-production-audit.mjs';
import {
  EXACT_THREE_LEVEL_CONTENT_HASH,
  EXACT_THREE_LEVEL_PRODUCTION_FIXTURE,
  EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST,
  EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST,
  EXACT_THREE_LEVEL_SKIN_HASH,
  EXACT_THREE_LEVEL_SPEC_HASHES,
} from '../src/catalog-three-level-production-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformRoot = path.resolve(root, '../swipe-platform');
const apiBaseRaw = process.env.VITE_API_BASE ?? '';
const dogfoodUserId = process.env.VITE_CATALOG_DOGFOOD_USER_ID ?? '';
const initData = process.env.CATALOG_REAL_E2E_INIT_DATA ?? '';
const timeoutMs = Number(process.env.CATALOG_REAL_E2E_TIMEOUT_MS ?? 180_000);
const expectedContentHash = process.env.CATALOG_REAL_E2E_CONTENT_HASH
  ?? EXACT_THREE_LEVEL_CONTENT_HASH;
const auditNonce = randomBytes(32).toString('hex');

const fail = (message) => {
  process.stderr.write(`catalog real E2E: ${message}\n`);
  process.exit(1);
};

let apiUrl;
try { apiUrl = new URL(apiBaseRaw); } catch { fail('VITE_API_BASE must be a canonical origin'); }
const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(apiUrl.hostname);
if (apiUrl.origin !== apiBaseRaw || apiUrl.pathname !== '/' || apiUrl.search || apiUrl.hash
  || !['https:', ...(loopback ? ['http:'] : [])].includes(apiUrl.protocol)) {
  fail('VITE_API_BASE must be an origin-only HTTPS URL (HTTP is allowed only on loopback)');
}
if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 180_000) {
  fail('CATALOG_REAL_E2E_TIMEOUT_MS must be an integer from 5000 to 180000');
}
if (!initData) fail('CATALOG_REAL_E2E_INIT_DATA is required and is never written to the build');
if (!catalogDogfoodAccountEligible({ VITE_CATALOG_DOGFOOD_USER_ID: dogfoodUserId }, initData)) {
  fail('signed initData user must exactly match canonical VITE_CATALOG_DOGFOOD_USER_ID');
}
const initParams = new URLSearchParams(initData);
if (!initParams.get('hash') && !initParams.get('signature')) {
  fail('CATALOG_REAL_E2E_INIT_DATA must carry a Telegram hash or signature');
}
const initUser = { id: Number(dogfoodUserId) };
if (!/^[0-9a-f]{64}$/.test(expectedContentHash)) {
  fail('CATALOG_REAL_E2E_CONTENT_HASH must be a lowercase sha256 hex digest');
}
if (expectedContentHash !== EXACT_THREE_LEVEL_CONTENT_HASH) {
  fail('CATALOG_REAL_E2E_CONTENT_HASH must name the shared exact production fixture');
}
const scriptJson = (value) => JSON.stringify(value)
  .replaceAll('<', '\\u003c')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');
const bodyOf = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
};

const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120_000,
  env: {
    ...process.env,
    VITE_API_BASE: apiBaseRaw,
    VITE_CONTROL_PLANE_ENABLED: 'true',
    VITE_CATALOG_PLAYER_V2_ENABLED: 'true',
    VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED: 'true',
    VITE_CATALOG_CANARY_DOGFOOD_ENABLED: 'true',
    VITE_CATALOG_DOGFOOD_USER_ID: dogfoodUserId,
  },
});
if (build.status !== 0) {
  process.stderr.write(`${build.stdout}\n${build.stderr}\n`);
  process.exit(build.status ?? 1);
}

const observerBootstrap = () => `<script>
window.Telegram={WebApp:{
  initData:${scriptJson(initData)},
  initDataUnsafe:{user:${scriptJson(initUser)},start_param:null},platform:'web',
  ready(){},expand(){},disableVerticalSwipes(){},setHeaderColor(){},
  setBackgroundColor(){},lockOrientation(){},onEvent(){}
}};
(()=>{
  const apiOrigin=${scriptJson(apiUrl.origin)};
  const timeoutMs=${timeoutMs};
  const auditNonce=${scriptJson(auditNonce)};
  const expectedContentHash=${scriptJson(expectedContentHash)};
  const expectedSpecHashes=${scriptJson(EXACT_THREE_LEVEL_SPEC_HASHES)};
  const expectedSkinHash=${scriptJson(EXACT_THREE_LEVEL_SKIN_HASH)};
  const expectedSkinContractDigest=${scriptJson(EXACT_THREE_LEVEL_SKIN_CONTRACT_DIGEST)};
  const expectedRuntimeContractDigest=${scriptJson(EXACT_THREE_LEVEL_RUNTIME_CONTRACT_DIGEST)};
  const expectedRuntimeArtifactDigest=${scriptJson(EXACT_THREE_LEVEL_RUNTIME_ARTIFACT_DIGEST)};
  const expectedSeriesFingerprint=${scriptJson(EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.seriesFingerprint)};
  const expectedFingerprintVersion=${scriptJson(EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.fingerprintVersion)};
  const expectedManifest=${scriptJson(EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.manifest)};
  const expectedSpecs=${scriptJson(EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.specs)};
  const expectedSkin=${scriptJson(EXACT_THREE_LEVEL_PRODUCTION_FIXTURE.skin)};
  const canonical=(value)=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)
    ?'['+value.map(canonical).join(',')+']'
    :'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
  const state={
    schema:'catalog.real-three-level-audit-state.v1',status:'running',message:'waiting for exact three-level canary',
    startedAt:Date.now(),apiOrigin,expectedContentHash,requests:[],eventNames:[],
    projectedImpressions:[],acceptedLevelResults:[],acceptedChestResults:[],ordinalLatenciesMs:[],closure:{
      session:false,canaryFresh:false,canaryAuthorizationId:null,canaryAuthorizationDigest:null,
      normalAuthorityRequests:0,allocation:null,allocationCanary:false,ticketV2:false,specBundle:false,
      decisionId:null,entryId:null,seriesId:null,ticketId:null,runId:null,
      ticketSchema:null,bundleSchema:null,runtimeLocator:null,runtimeContractDigest:null,runtimeArtifactDigest:null,
      manifestContentHash:null,skinHash:null,skinContractDigest:null,specHashes:[],specHash:null,runtimeAbsolute:false,
      catalogFrame:false,frameExact:false,catalogImpression:false,chestSeen:false,rewardSeen:false
    },currentFrame:'none',p95Ms:null
  };
  Object.defineProperty(window,'__catalogRealE2E',{value:state});
  const publish=()=>{try{const snapshot=structuredClone(state);parent.postMessage({source:'catalog-real-e2e',snapshot},location.origin);nativeFetch('/__audit/snapshot',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({auditNonce,snapshot})}).catch(()=>{})}catch{}};
  const record=(route,status,detail={})=>{
    state.requests.push({atMs:Date.now()-state.startedAt,route,status,...detail});
    if(state.requests.length>80)state.requests.shift();publish();
  };
  const stop=(message)=>{if(state.status!=='running')return;state.status='fail';state.message=message;publish()};
  const requestUrl=(input)=>{try{return new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href)}catch{return null}};
  const requestJson=(init)=>{try{return typeof init?.body==='string'?JSON.parse(init.body):null}catch{return null}};
  const responseJson=async(response)=>{try{return await response.clone().json()}catch{return null}};
  const tracked=(url)=>url?.origin===apiOrigin&&(
    ['/api/session','/api/cp/events','/api/catalog/canary-authority','/api/feed/catalog-authority','/api/catalog/allocate-authorized','/api/runs/start','/api/results'].includes(url.pathname)
    || /^\\/api\\/catalog\\/tickets\\/[^/]+\\/specs$/.test(url.pathname)
  );
  const inspect=(url,response,data,body,durationMs)=>{
    const route=url.pathname;
    const detail={durationMs};
    if(route==='/api/cp/events'){
      const events=Array.isArray(body?.events)?body.events:[];
      const names=events.map(event=>event?.event_name).filter(Boolean);
      detail.events=names;
      for(const name of names)if(!state.eventNames.includes(name))state.eventNames.push(name);
      if(names.includes('unit_impression'))stop('effectful slot emitted a generic builtin impression');
      if(names.includes('catalog_configuration_failure'))stop('real runtime failed the catalog handshake');
      if(names.includes('catalog_level_impression'))stop('skinned canary emitted the legacy catalog impression');
      for(const event of events.filter(item=>item?.event_name==='catalog_level_impression_v2')){
        const ack=Array.isArray(data?.events)?data.events.find(item=>item?.event_id===event.event_id):null;
        if(ack?.status==='projected'){
          state.closure.catalogImpression=true;
          if(!state.projectedImpressions.some(item=>item.eventId===event.event_id))state.projectedImpressions.push({
            eventId:event.event_id,eventName:event.event_name,ordinal:event.payload?.ordinal,
            specHash:event.payload?.level_spec_hash,appliedSpecHash:event.payload?.applied_spec_hash,
            skinHash:event.payload?.skin_hash,appliedSkinHash:event.payload?.applied_skin_hash,
            skinContractDigest:event.payload?.skin_contract_digest,
            runtimeContractDigest:event.payload?.runtime_contract_digest,
            runtimeArtifactDigest:event.payload?.runtime_artifact_digest,
            ticketId:event.payload?.ticket_id,decisionId:event.payload?.decision_id,
            entryId:event.payload?.catalog_entry_id,seriesId:event.payload?.series_id,
            atMs:Date.now()-state.startedAt
          });
        }
        else stop('specialized impression did not receive its exact projected ACK');
      }
    }else if(route==='/api/session'){
      state.closure.session=Boolean(data?.builtin_feed_bindings?.available);
      if(!state.closure.session)stop('real session has no available reviewed builtin bindings');
    }else if(route==='/api/catalog/canary-authority'){
      const keys=data&&typeof data==='object'?Object.keys(data).sort().join(','):'';
      const exactKeys='authorizationDigest,authorizationId,expiresAt,replayed,schema';
      state.closure.canaryFresh=response.ok&&keys===exactKeys
        &&data?.schema==='catalog.canary-authority-result.v1'&&data?.replayed===false;
      state.closure.canaryAuthorizationId=data?.authorizationId??null;
      state.closure.canaryAuthorizationDigest=data?.authorizationDigest??null;
      if(!state.closure.canaryFresh)stop('real backend did not return one fresh opaque canary invitation');
    }else if(route==='/api/feed/catalog-authority'){
      state.closure.normalAuthorityRequests+=1;
      stop('normal effectful authority ran despite a fresh canary invitation');
    }else if(route==='/api/catalog/allocate-authorized'){
      state.closure.allocation=data?.allocation?.outcome??null;
      const allocation=data?.allocation;
      state.closure.allocationCanary=allocation?.schema==='catalog.allocate-decision-result.v2'
        &&allocation?.outcome==='allocated'
        &&allocation?.catalog?.entryState==='canary'
        &&allocation?.slotType==='canary-dogfood'
        &&allocation?.policyVersion==='catalog-canary-dogfood.v1'
        &&allocation?.allocationId===state.closure.canaryAuthorizationId
        &&data?.authorizationId===state.closure.canaryAuthorizationId
        &&data?.authorizationDigest===state.closure.canaryAuthorizationDigest
        &&body?.authorizationId===state.closure.canaryAuthorizationId;
      state.closure.decisionId=allocation?.decisionId??null;
      state.closure.entryId=allocation?.catalog?.entryId??null;
      state.closure.seriesId=allocation?.catalog?.seriesId??null;
      state.closure.manifestContentHash=allocation?.manifest?.contentHash??null;
      state.closure.skinHash=allocation?.manifest?.skinHash??null;
      state.closure.skinContractDigest=allocation?.manifest?.skinContractDigest??null;
      state.closure.specHashes=Array.isArray(allocation?.manifest?.levels)?allocation.manifest.levels.map(level=>level?.specHash):[];
      const exactManifest=allocation?.manifest?.schema==='series.manifest.v2'
        &&state.closure.manifestContentHash===expectedContentHash
        &&canonical(state.closure.specHashes)===canonical(expectedSpecHashes)
        &&state.closure.skinHash===expectedSkinHash
        &&state.closure.skinContractDigest===expectedSkinContractDigest
        &&allocation.manifest.seriesFingerprint===expectedSeriesFingerprint
        &&allocation.manifest.fingerprintVersion===expectedFingerprintVersion
        &&allocation.manifest.gameplayFingerprint===expectedManifest.gameplayFingerprint
        &&allocation.manifest.presentationFingerprint===expectedManifest.presentationFingerprint
        &&allocation.runtime?.runtimeContractDigest===expectedRuntimeContractDigest
        &&allocation.runtime?.runtimeArtifactDigest===expectedRuntimeArtifactDigest
        &&allocation.runtime?.capabilities?.catalogRequiredHandshake===true
        &&allocation.runtime?.capabilities?.sortLevelSpecV1===true
        &&allocation.runtime?.capabilities?.sortSkinSpecV1===true;
      if(!exactManifest)stop('canary allocation is not the exact reviewed skinned three-level content');
      if(!state.closure.allocationCanary)stop('real canary authority did not resolve to its exact canary allocation');
    }else if(route==='/api/runs/start'&&body?.schema==='run.start.v2'){
      const expectedId=state.closure.canaryAuthorizationId;
      const firstTicket=state.closure.ticketId===null;
      const exactTicket=data?.schema==='run.ticket.v3'&&data?.state==='active'
        &&Number.isInteger(data?.completed_levels)&&data.completed_levels>=0&&data.completed_levels<3
        &&body?.ticket_id===expectedId&&data?.ticket_id===body?.ticket_id
        &&data?.run_id===body?.run_id
        &&(!firstTicket||body?.run_id==='catalog-canary:'+expectedId)
        &&(!firstTicket||data?.completed_levels===0)
        &&(firstTicket||data?.run_id===state.closure.runId)
        &&data?.decision_id===state.closure.decisionId
        &&data?.catalog_entry_id===state.closure.entryId&&data?.series_id===state.closure.seriesId
        &&data?.manifest_content_hash===expectedContentHash&&data?.expected_levels===3
        &&data?.skin_hash===expectedSkinHash&&data?.skin_contract_digest===expectedSkinContractDigest
        &&data?.runtime_contract_digest===expectedRuntimeContractDigest
        &&data?.runtime_artifact_digest===expectedRuntimeArtifactDigest
        &&Array.isArray(data?.levels)&&data.levels.length===3
        &&data.levels.every((level,index)=>level?.ordinal===index+1&&level?.spec_hash===expectedSpecHashes[index]);
      if(exactTicket)state.closure.ticketSchema=data.schema;
      if(firstTicket&&exactTicket){state.closure.ticketId=data.ticket_id;state.closure.runId=data.run_id;state.closure.ticketV2=true}
      if(!exactTicket)stop('real backend did not confirm the exact manifest-bound v3 skin ticket');
    }else if(/^\\/api\\/catalog\\/tickets\\/[^/]+\\/specs$/.test(route)){
      const runtime=data?.runtime;
      const level=data?.levels?.[0];
      state.closure.specBundle=data?.schema==='catalog.ticket-level-spec-bundle.v2'&&Boolean(runtime)&&Boolean(level);
      state.closure.specBundle&&=data?.ticketId===state.closure.ticketId
        &&data?.decisionId===state.closure.decisionId&&data?.catalogEntryId===state.closure.entryId
        &&data?.seriesId===state.closure.seriesId&&data?.manifestContentHash===expectedContentHash
        &&data?.skinHash===expectedSkinHash&&data?.skinContractDigest===expectedSkinContractDigest
        &&canonical(data?.skin)===canonical(expectedSkin)
        &&Array.isArray(data?.levels)&&data.levels.length===3
        &&data.levels.every((candidate,index)=>candidate?.ordinal===index+1
          &&candidate?.specHash===expectedSpecHashes[index]
          &&canonical(candidate?.spec)===canonical(expectedSpecs[index]));
      state.closure.bundleSchema=data?.schema??null;
      state.closure.runtimeLocator=runtime?.indexLocator??null;
      state.closure.runtimeContractDigest=runtime?.runtimeContractDigest??null;
      state.closure.runtimeArtifactDigest=runtime?.runtimeArtifactDigest??null;
      state.closure.specHash=level?.specHash??null;
      state.closure.specBundle&&=state.closure.runtimeContractDigest===expectedRuntimeContractDigest
        &&state.closure.runtimeArtifactDigest===expectedRuntimeArtifactDigest;
      try{
        const locator=new URL(runtime.indexLocator);
        const hex=String(runtime.runtimeArtifactDigest||'').replace(/^sha256:/,'');
        const prefix='/runtime-releases/'+runtime.playableId+'/'+hex+'/';
        state.closure.runtimeAbsolute=locator.protocol==='https:'&&!locator.search&&!locator.hash
          &&locator.pathname.startsWith(prefix)&&locator.pathname.length>prefix.length;
      }catch{state.closure.runtimeAbsolute=false}
      if(!state.closure.runtimeAbsolute)stop('backend returned a non-absolute or non-content-addressed production runtime');
    }else if(route==='/api/results'){
      if(!response.ok)stop('production backend rejected a catalog result receipt');
      const baseExact=body?.ticket_id===state.closure.ticketId&&body?.series_id===state.closure.seriesId;
      if(body?.metric_key==='series'){
        if(!baseExact||body?.metric_value!==3||body?.run_id!==state.closure.runId
          ||body?.schema!=='catalog.result.v2')stop('chest receipt does not match the exact series ticket');
        else if(!state.acceptedChestResults.some(item=>item.body?.run_id===body.run_id))state.acceptedChestResults.push({atMs:Date.now()-state.startedAt,body,durationMs,boundSkinContractDigest:state.closure.skinContractDigest});
      }else{
        const index=Number(body?.ordinal)-1;
        if(!baseExact||index<0||index>=3||body?.series_level!==index+1||body?.applied_spec_hash!==state.closure.specHashes[index]
          ||body?.schema!=='catalog.result.v2'||body?.applied_skin_hash!==expectedSkinHash)stop('level receipt does not match the exact skin-bound manifest ordinal');
        else if(!state.acceptedLevelResults.some(item=>item.body?.run_id===body.run_id))state.acceptedLevelResults.push({atMs:Date.now()-state.startedAt,body,durationMs,boundSkinContractDigest:state.closure.skinContractDigest});
      }
    }
    record(route,response.status,detail);
    if(!response.ok)stop(route+' returned HTTP '+response.status);
  };
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
    const url=requestUrl(input);const body=requestJson(init);
    const started=performance.now();
    try{
      const response=await nativeFetch(input,init);
      if(tracked(url))inspect(url,response,await responseJson(response),body,Math.round(performance.now()-started));
      return response;
    }catch(error){if(tracked(url)){record(url.pathname,0,{error:String(error)});stop(url.pathname+' network failure')}throw error}
  };
  const evaluate=()=>{
    if(state.status!=='running')return;
    const current=document.querySelector('.page--in-viewport .game')||document.querySelectorAll('.game')[0];
    const frame=current?.querySelector('iframe')||null;
    state.currentFrame=!frame?'none':frame.dataset.catalogPlayerV2==='1'?'catalog':'builtin';
    state.closure.chestSeen ||= Boolean(document.querySelector('.chest-ov__chest'));
    state.closure.rewardSeen ||= Boolean(document.querySelector('.game__state--earned .reward'));
    if(frame?.dataset.catalogPlayerV2==='1'){
      state.closure.catalogFrame=true;
      try{
        const actual=new URL(frame.src);const expected=new URL(state.closure.runtimeLocator);
        const params=[...actual.searchParams.keys()].sort().join(',');
        const ordinal=Math.min(state.acceptedLevelResults.length,2);
        const currentSpecHash=state.closure.specHashes[ordinal]??state.closure.specHash;
        const expectedParams='expected_skin_hash,expected_spec_hash,level_config';
        state.closure.frameExact=actual.origin===expected.origin&&actual.pathname===expected.pathname
          &&params===expectedParams
          &&actual.searchParams.get('level_config')==='catalog_required'
          &&actual.searchParams.get('expected_spec_hash')===currentSpecHash
          &&actual.searchParams.get('expected_skin_hash')===expectedSkinHash;
      }catch{state.closure.frameExact=false}
    }
    const c=state.closure;
    const impressions=[...state.projectedImpressions].sort((a,b)=>a.ordinal-b.ordinal);
    const levelResults=[...state.acceptedLevelResults].sort((a,b)=>a.body.ordinal-b.body.ordinal);
    const exactImpressions=impressions.length===3
      &&new Set(impressions.map(item=>item.eventId)).size===3
      &&impressions.every((item,index)=>item.eventName==='catalog_level_impression_v2'
        &&item.ordinal===index+1&&item.specHash===expectedSpecHashes[index]
        &&item.appliedSpecHash===expectedSpecHashes[index]
        &&item.skinHash===expectedSkinHash&&item.appliedSkinHash===expectedSkinHash
        &&item.skinContractDigest===expectedSkinContractDigest
        &&item.runtimeContractDigest===expectedRuntimeContractDigest
        &&item.runtimeArtifactDigest===expectedRuntimeArtifactDigest
        &&item.ticketId===c.ticketId&&item.decisionId===c.decisionId
        &&item.entryId===c.entryId&&item.seriesId===c.seriesId);
    const levelRunIds=levelResults.map(item=>item.body?.run_id);
    const exactLevels=levelResults.length===3&&new Set(levelRunIds).size===3
      &&!levelRunIds.includes(c.runId)
      &&levelResults.every((item,index)=>item.body?.schema==='catalog.result.v2'
        &&item.body?.ordinal===index+1&&item.body?.series_level===index+1
        &&item.body?.applied_spec_hash===expectedSpecHashes[index]
        &&item.body?.applied_skin_hash===expectedSkinHash
        &&item.boundSkinContractDigest===expectedSkinContractDigest
        &&item.body?.ticket_id===c.ticketId&&item.body?.series_id===c.seriesId);
    const exactChest=state.acceptedChestResults.length===1
      &&state.acceptedChestResults[0].body?.schema==='catalog.result.v2'
      &&state.acceptedChestResults[0].body?.metric_key==='series'
      &&state.acceptedChestResults[0].body?.metric_value===3
      &&state.acceptedChestResults[0].body?.ticket_id===c.ticketId
      &&state.acceptedChestResults[0].body?.series_id===c.seriesId
      &&state.acceptedChestResults[0].body?.run_id===c.runId
      &&state.acceptedChestResults[0].boundSkinContractDigest===expectedSkinContractDigest;
    const causalOrder=exactImpressions&&exactLevels
      &&levelResults.every((item,index)=>item.atMs>=impressions[index].atMs)
      &&exactChest&&state.acceptedChestResults[0].atMs>=levelResults[2].atMs;
    state.ordinalLatenciesMs=causalOrder
      ?levelResults.map((item,index)=>item.atMs-impressions[index].atMs):[];
    state.p95Ms=state.ordinalLatenciesMs.length===3
      ?[...state.ordinalLatenciesMs].sort((a,b)=>a-b)[2]:null;
    if(c.session&&c.canaryFresh&&c.normalAuthorityRequests===0&&c.allocation==='allocated'
      &&c.allocationCanary&&c.ticketV2
      &&c.specBundle&&c.runtimeAbsolute&&c.catalogFrame&&c.frameExact&&c.catalogImpression
      &&c.ticketSchema==='run.ticket.v3'&&c.bundleSchema==='catalog.ticket-level-spec-bundle.v2'
      &&c.skinHash===expectedSkinHash&&c.skinContractDigest===expectedSkinContractDigest
      &&c.runtimeContractDigest===expectedRuntimeContractDigest
      &&c.runtimeArtifactDigest===expectedRuntimeArtifactDigest
      &&exactImpressions&&exactLevels&&exactChest&&causalOrder
      &&state.ordinalLatenciesMs.length===3&&c.chestSeen&&c.rewardSeen){
      state.status='pass';state.message='exact production canary completed ordinals 1..3, three accepted receipts, and one chest';
    }else if(Date.now()-state.startedAt>timeoutMs){
      stop('timeout before exact ordinals 1..3, three accepted receipts, and one chest completed');
    }
    publish();
  };
  addEventListener('DOMContentLoaded',()=>{setInterval(evaluate,100);evaluate()});
})();
</script>`;

const controllerHtml = () => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Real catalog runtime E2E</title>
<style>html,body{margin:0;height:100%;background:#07090f;color:#eef;font:13px/1.35 ui-monospace,monospace}iframe{position:fixed;inset:0;width:100%;height:100%;border:0}.panel{position:fixed;z-index:99999;top:8px;right:8px;width:min(460px,calc(100% - 16px));max-height:46vh;overflow:auto;background:rgba(4,8,16,.95);border:1px solid #526071;border-radius:10px;padding:10px;box-sizing:border-box}output{display:block;padding:6px;border-radius:6px;background:#26313f;font-weight:700}output[data-state=pass]{background:#0b5c35}output[data-state=fail]{background:#7a2020}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head><body>
<iframe data-testid="feed" src="/feed"></iframe><aside class="panel"><output data-testid="status" data-state="running">RUNNING</output><pre data-testid="trace">Waiting for Feed…</pre></aside>
<script>const frame=document.querySelector('[data-testid=feed]'),status=document.querySelector('[data-testid=status]'),trace=document.querySelector('[data-testid=trace]');addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==frame.contentWindow||event.data?.source!=='catalog-real-e2e')return;const state=event.data.snapshot;window.__catalogRealE2E=state;status.dataset.state=state.status;status.textContent=state.status.toUpperCase()+': '+state.message;trace.textContent=JSON.stringify(state,null,2)});</script>
</body></html>`;

const contentType = (file) => ({
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
}[path.extname(file).toLowerCase()] ?? 'application/octet-stream');

let auditReceiptPrinted = false;
let auditNonceConsumed = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  response.setHeader('cache-control', 'no-store');
  if (request.method === 'POST' && url.pathname === '/__audit/snapshot') {
    let body;
    try { body = await bodyOf(request); } catch {
      response.statusCode = 400; response.end('invalid JSON'); return;
    }
    const supplied = Buffer.from(String(body?.auditNonce ?? ''), 'utf8');
    const expected = Buffer.from(auditNonce, 'utf8');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.statusCode = 403; response.end('invalid audit nonce'); return;
    }
    if (body?.snapshot?.status !== 'pass') {
      response.statusCode = 202; response.end('observation pending'); return;
    }
    if (auditNonceConsumed) {
      response.statusCode = 409; response.end('audit nonce already consumed'); return;
    }
    let receipt;
    try {
      receipt = buildThreeLevelLiveOperatorObservation(body.snapshot, { auditNonce });
    } catch (error) {
      response.statusCode = 422; response.end(error instanceof Error ? error.message : 'invalid observation'); return;
    }
    auditNonceConsumed = true;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(receipt));
    if (!auditReceiptPrinted) {
      auditReceiptPrinted = true;
      console.log(JSON.stringify(receipt));
    }
    return;
  }
  if (request.method !== 'GET') { response.statusCode = 405; response.end('method not allowed'); return; }
  if (url.pathname === '/' || url.pathname === '/e2e.html') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(controllerHtml());
    return;
  }
  if (url.pathname === '/feed') {
    const source = readFileSync(path.join(root, 'dist/index.html'), 'utf8');
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(source.replace('</head>', `${observerBootstrap()}</head>`));
    return;
  }
  // Reviewed built-ins are served from the real deploy checkout. Catalog
  // runtime-releases are intentionally never served/proxied here: production
  // E2E must consume the absolute HTTPS locator supplied by the backend.
  if (url.pathname.startsWith('/runtime-releases/')) {
    response.statusCode = 404; response.end('production runtime must use its absolute locator'); return;
  }
  let relative;
  try { relative = decodeURIComponent(url.pathname.slice(1)); } catch { relative = ''; }
  if (!relative || relative.includes('/') || relative === '.' || relative === '..') {
    response.statusCode = 404; response.end('not found'); return;
  }
  const file = path.join(platformRoot, relative);
  if (!file.startsWith(`${platformRoot}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
    response.statusCode = 404; response.end('not found'); return;
  }
  response.setHeader('content-type', contentType(file));
  response.end(readFileSync(file));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(JSON.stringify({
  url: `${origin}/e2e.html`,
  apiBase: apiBaseRaw,
  dogfoodUserId,
  runtimePolicy: 'backend-absolute-https-only',
  expectedContentHash,
  auditReceiptAuthority: 'local-non-authoritative',
}));

const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
