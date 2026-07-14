import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogDogfoodAccountEligible } from '../src/catalog-feed-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformRoot = path.resolve(root, '../swipe-platform');
const apiBaseRaw = process.env.VITE_API_BASE ?? '';
const dogfoodUserId = process.env.VITE_CATALOG_DOGFOOD_USER_ID ?? '';
const initData = process.env.CATALOG_REAL_E2E_INIT_DATA ?? '';
const timeoutMs = Number(process.env.CATALOG_REAL_E2E_TIMEOUT_MS ?? 45_000);

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
const scriptJson = (value) => JSON.stringify(value)
  .replaceAll('<', '\\u003c')
  .replaceAll('\u2028', '\\u2028')
  .replaceAll('\u2029', '\\u2029');

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
  const state={
    schema:'catalog.real-e2e-state.v1',status:'running',message:'waiting for real backend authority',
    startedAt:Date.now(),apiOrigin,requests:[],eventNames:[],closure:{
      session:false,authority:null,allocation:null,ticketV2:false,specBundle:false,
      runtimeLocator:null,runtimeArtifactDigest:null,specHash:null,runtimeAbsolute:false,
      catalogFrame:false,frameExact:false,catalogImpression:false
    },currentFrame:'none'
  };
  Object.defineProperty(window,'__catalogRealE2E',{value:state});
  const publish=()=>{try{parent.postMessage({source:'catalog-real-e2e',snapshot:structuredClone(state)},location.origin)}catch{}};
  const record=(route,status,detail={})=>{
    state.requests.push({atMs:Date.now()-state.startedAt,route,status,...detail});
    if(state.requests.length>80)state.requests.shift();publish();
  };
  const stop=(message)=>{if(state.status!=='running')return;state.status='fail';state.message=message;publish()};
  const requestUrl=(input)=>{try{return new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href)}catch{return null}};
  const requestJson=(init)=>{try{return typeof init?.body==='string'?JSON.parse(init.body):null}catch{return null}};
  const responseJson=async(response)=>{try{return await response.clone().json()}catch{return null}};
  const tracked=(url)=>url?.origin===apiOrigin&&(
    ['/api/session','/api/cp/events','/api/feed/catalog-authority','/api/catalog/allocate-authorized','/api/runs/start'].includes(url.pathname)
    || /^\\/api\\/catalog\\/tickets\\/[^/]+\\/specs$/.test(url.pathname)
  );
  const inspect=(url,response,data,body)=>{
    const route=url.pathname;
    const detail={};
    if(route==='/api/cp/events'){
      const names=Array.isArray(body?.events)?body.events.map(event=>event?.event_name).filter(Boolean):[];
      detail.events=names;
      for(const name of names)if(!state.eventNames.includes(name))state.eventNames.push(name);
      if(names.includes('unit_impression'))stop('effectful slot emitted a generic builtin impression');
      if(names.includes('catalog_configuration_failure'))stop('real runtime failed the catalog handshake');
      if(names.includes('catalog_level_impression'))state.closure.catalogImpression=true;
    }else if(route==='/api/session'){
      state.closure.session=Boolean(data?.builtin_feed_bindings?.available);
      if(!state.closure.session)stop('real session has no available reviewed builtin bindings');
    }else if(route==='/api/feed/catalog-authority'){
      state.closure.authority=data?.outcome??null;
      if(data?.outcome!=='catalog_authorized')stop('real backend did not authorize catalog content');
    }else if(route==='/api/catalog/allocate-authorized'){
      state.closure.allocation=data?.allocation?.outcome??null;
      if(data?.allocation?.outcome!=='allocated')stop('real catalog runway did not allocate a published series');
    }else if(route==='/api/runs/start'&&body?.schema==='run.start.v2'){
      state.closure.ticketV2=data?.schema==='run.ticket.v2'&&data?.state==='active';
      if(!state.closure.ticketV2)stop('real backend did not confirm the manifest-bound v2 ticket');
    }else if(/^\\/api\\/catalog\\/tickets\\/[^/]+\\/specs$/.test(route)){
      const runtime=data?.runtime;
      const level=data?.levels?.[0];
      state.closure.specBundle=data?.schema==='catalog.ticket-level-spec-bundle.v1'&&Boolean(runtime)&&Boolean(level);
      state.closure.runtimeLocator=runtime?.indexLocator??null;
      state.closure.runtimeArtifactDigest=runtime?.runtimeArtifactDigest??null;
      state.closure.specHash=level?.specHash??null;
      try{
        const locator=new URL(runtime.indexLocator);
        const hex=String(runtime.runtimeArtifactDigest||'').replace(/^sha256:/,'');
        const prefix='/runtime-releases/'+runtime.playableId+'/'+hex+'/';
        state.closure.runtimeAbsolute=locator.protocol==='https:'&&!locator.search&&!locator.hash
          &&locator.pathname.startsWith(prefix)&&locator.pathname.length>prefix.length;
      }catch{state.closure.runtimeAbsolute=false}
      if(!state.closure.runtimeAbsolute)stop('backend returned a non-absolute or non-content-addressed production runtime');
    }
    record(route,response.status,detail);
    if(!response.ok)stop(route+' returned HTTP '+response.status);
  };
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(input,init)=>{
    const url=requestUrl(input);const body=requestJson(init);
    try{
      const response=await nativeFetch(input,init);
      if(tracked(url))inspect(url,response,await responseJson(response),body);
      return response;
    }catch(error){if(tracked(url)){record(url.pathname,0,{error:String(error)});stop(url.pathname+' network failure')}throw error}
  };
  const evaluate=()=>{
    if(state.status!=='running')return;
    const current=document.querySelectorAll('.game')[0];
    const frame=current?.querySelector('iframe')||null;
    state.currentFrame=!frame?'none':frame.dataset.catalogPlayerV2==='1'?'catalog':'builtin';
    if(frame?.dataset.catalogPlayerV2==='1'){
      state.closure.catalogFrame=true;
      try{
        const actual=new URL(frame.src);const expected=new URL(state.closure.runtimeLocator);
        const params=[...actual.searchParams.keys()].sort().join(',');
        state.closure.frameExact=actual.origin===expected.origin&&actual.pathname===expected.pathname
          &&params==='expected_spec_hash,level_config'
          &&actual.searchParams.get('level_config')==='catalog_required'
          &&actual.searchParams.get('expected_spec_hash')===state.closure.specHash;
      }catch{state.closure.frameExact=false}
    }
    const c=state.closure;
    if(c.session&&c.authority==='catalog_authorized'&&c.allocation==='allocated'&&c.ticketV2
      &&c.specBundle&&c.runtimeAbsolute&&c.catalogFrame&&c.frameExact&&c.catalogImpression){
      state.status='pass';state.message='real backend + absolute content-addressed runtime configured and revealed';
    }else if(Date.now()-state.startedAt>timeoutMs){
      stop('timeout before the real catalog runtime produced its specialized impression');
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

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  response.setHeader('cache-control', 'no-store');
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
}));

const close = () => server.close(() => process.exit(0));
process.on('SIGINT', close);
process.on('SIGTERM', close);
