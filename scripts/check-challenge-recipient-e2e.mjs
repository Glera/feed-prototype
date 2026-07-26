// Share/Challenge V1 — RECIPIENT HTTP E2E against the real backend.
//
// NOTE (stop-the-line): the V1 spec-bound recipient flow is NOT wired into the
// client UI in branch challenge-v1 (@ba7607b) — feed.ts/main.ts use the LEGACY
// challenge path and VITE_CHALLENGE_V1_ENABLED only gates the ⚡ friend badge. So
// this harness drives the recipient V1 CONTRACT the way a wired client would:
// real HTTP with signed initData + the X-P4G-Challenge-Wire-Version header, and
// the ACTUAL client sibling-binder module (src/challenge-player.mjs) fed the REAL
// backend level-bundle. It asserts DB facts after each mutating step.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateChallengeLevelBundle,
  buildChallengePlayerLevelBinding,
  buildChallengeFrameNavigation,
  ChallengePlayerSession,
} from '../src/challenge-player.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:5221';
const BOT_TOKEN = process.env.BOT_TOKEN || 'dev-challenge-token';
const VENV_PY = process.env.VENV_PY;
const BACKEND_ROOT = process.env.BACKEND_ROOT;
const DATABASE_URL = process.env.DATABASE_URL;
const WIRE = { 'X-P4G-Challenge-Wire-Version': '1' };
const UGC_BASE = 'https://swipe-ugc.onrender.com';

function sign(uid, startParam) {
  const user = { id: uid, first_name: `U${uid}`, photo_url: `https://t.me/i/userpic/320/${uid}.jpg` };
  const fields = { user: JSON.stringify(user), auth_date: String(Math.floor(Date.now() / 1000)), query_id: `AAE${uid}` };
  if (startParam) fields.start_param = startParam;
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  fields.hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(fields).toString();
}
const authH = (uid) => ({ Authorization: 'tma ' + sign(uid), 'Content-Type': 'application/json' });
function dbq(sql) {
  const r = spawnSync(VENV_PY, ['-c',
    `import json,sys;from sqlalchemy import text;from app.db import SessionLocal
with SessionLocal() as db: print(json.dumps([list(x) for x in db.execute(text(sys.argv[1])).fetchall()],default=str))`, sql],
    { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL } });
  if (r.status !== 0) throw new Error(`dbq failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}
const j = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return t; } };

// setup source challenge via the python server-side script
function setupSource() {
  const r = spawnSync(VENV_PY, [path.join(HERE, 'challenge-e2e-support', 'challenge_source_setup.py')],
    { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL } });
  if (r.status !== 0) throw new Error(`source setup failed: ${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
}

// Deterministic reset (append-only journals guarded by triggers → replica role).
function resetDb() {
  const tables = ['challenge_spec_bindings', 'challenge_ticket_bindings', 'challenge_events',
    'challenge_friendship_receipts', 'challenge_attempts', 'verified_runs', 'run_tickets',
    'reward_ledger', 'puzzle_ledger', 'level_results', 'attempt_outcome_facts', 'attempts',
    'challenges', 'challenge_specs', 'island_friendships', 'island_friend_blocks', 'friend_edges',
    'runtime_releases', 'variants', 'usage_counters'];
  const r = spawnSync(VENV_PY, ['-c',
    `from sqlalchemy import text;from app.db import SessionLocal
with SessionLocal() as db:
    db.execute(text("SET session_replication_role=replica"))
    db.execute(text("TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE"))
    db.commit()`],
    { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL } });
  if (r.status !== 0) throw new Error(`reset failed: ${r.stderr}`);
}
resetDb();
const src = setupSource();
const { challenge_id: CID, spec_digest: SPEC, recipient: R, challenger: C } = src;
console.log(`source: challenge=${CID.slice(0, 8)} spec=${SPEC.slice(0, 10)} challenger=${C} recipient=${R}`);
const runId = `rcp-${crypto.randomUUID()}`;
const ticketId = crypto.randomUUID();
const results = {};

// ── 1. GET /challenges/{id} (spec-bound, wire header) ──────────────────────
let res = await fetch(`${API}/api/challenges/${CID}`, { headers: { ...authH(R), ...WIRE } });
assert.equal(res.status, 200, `GET challenge: ${res.status}`);
const view = await j(res);
assert.equal(view.spec_digest, SPEC, 'view carries spec_digest');
assert.equal(view.playable_id, 'marble-sort-swipe');
assert.ok(view.runtime_url && view.runtime_url.includes('runtime-releases/marble-sort-swipe/'), 'content-addressed runtime_url');
results.get_view = { spec_digest: view.spec_digest, playable_id: view.playable_id, runtime_url: view.runtime_url };

// ── 2. recipient run.start (wire header) — binds ticket + friendship helper ─
res = await fetch(`${API}/api/runs/start`, { method: 'POST', headers: { ...authH(R), ...WIRE },
  body: JSON.stringify({ ticket_id: ticketId, run_id: runId, mechanic_id: view.mechanic_id, variant_id: view.variant_id, kind: 'single', challenge_id: CID }) });
assert.equal(res.status, 200, `recipient run.start: ${res.status} ${await res.clone().text()}`);
results.run_start = await j(res);
let tb = dbq(`SELECT ticket_id::text, spec_digest FROM challenge_ticket_bindings WHERE ticket_id='${ticketId}'`);
assert.equal(tb.length, 1, 'recipient ticket-binding written before play');
assert.equal(tb[0][1], SPEC, 'recipient bound to the same spec_digest (server-derived)');

// ── 3. GET level-bundle (wire header) ──────────────────────────────────────
res = await fetch(`${API}/api/challenges/tickets/${ticketId}/level-bundle`, { headers: { ...authH(R), ...WIRE } });
assert.equal(res.status, 200, `level-bundle: ${res.status} ${await res.clone().text()}`);
const bundle = await j(res);
assert.equal(bundle.schema, 'challenge.ticket-level-spec-bundle.v1');
assert.equal(bundle.specDigest, SPEC, 'bundle.specDigest == challenge spec_digest');
results.bundle = { specDigest: bundle.specDigest, expectedSpecHash: bundle.expectedSpecHash, runtimeArtifactDigest: bundle.runtime.runtimeArtifactDigest };

// ── 4. sibling-binder handshake with the REAL bundle (client module) ───────
validateChallengeLevelBundle(bundle);
const binding = buildChallengePlayerLevelBinding(bundle, 1);
const nav = buildChallengeFrameNavigation(binding, UGC_BASE);
assert.match(nav.src, /\/runtime-releases\/marble-sort-swipe\/[0-9a-f]{64}\/index\.html/, 'content-addressed frame src');
assert.ok(nav.src.includes('level_config=catalog_required'), 'catalog_required handshake');
assert.ok(nav.src.includes(`expected_spec_hash=${binding.specHash}`), 'expected_spec_hash on frame');
const frameSource = {};
const contract = bundle.runtime.runtimeContractDigest, artifact = bundle.runtime.runtimeArtifactDigest;
const session = new ChallengePlayerSession({ bundle, baseUrl: UGC_BASE, frameEpoch: 1, frameSource });
const ready = session.handleMessage({ source: frameSource, origin: nav.expectedOrigin,
  data: { type: 'configure_ready', nonce: 'nonce-recipient-0123456789', runtimeContractDigest: contract, runtimeArtifactDigest: artifact } }, 1);
assert.equal(ready.status, 'accepted', 'configure_ready accepted');
assert.equal(ready.effects[0].type, 'post_configure_level', 'emits configure_level to the frame');
const configured = session.handleMessage({ source: frameSource, origin: nav.expectedOrigin,
  data: { type: 'configured', appliedSpecHash: binding.specHash, runtimeContractDigest: contract, runtimeArtifactDigest: artifact } }, 1);
assert.equal(configured.phase, 'configured', 'frame configured with matching per-level specHash');
const revealed = session.setVisible(true, 1);
assert.equal(revealed.effects[0].type, 'challenge_reveal_ready', 'reveal fires');
results.sibling_binder = { frame_src: nav.src, applied_per_level_hash: revealed.effects[0].appliedSpecHash, applied_spec_digest: binding.specDigest };
assert.equal(binding.specDigest, SPEC, 'applied_spec_digest (wrapper) == spec_digest');

// ── 5. POST /results with applied_spec_digest ──────────────────────────────
res = await fetch(`${API}/api/results`, { method: 'POST', headers: authH(R),
  body: JSON.stringify({ mechanic_id: view.mechanic_id, variant_id: view.variant_id, run_id: runId, ticket_id: ticketId, metric_key: 'time_ms', metric_value: 4200, applied_spec_digest: SPEC }) });
assert.equal(res.status, 200, `results: ${res.status} ${await res.clone().text()}`);
results.result = await j(res);
let sb = dbq(`SELECT run_id, ticket_id::text, spec_digest FROM challenge_spec_bindings WHERE run_id='${runId}'`);
assert.equal(sb.length, 1, 'server wrote challenge_spec_bindings for the recipient run');
assert.equal(sb[0][2], SPEC, 'spec_binding digest matches');

// ── 6. POST /challenges/{id}/accept (wire header) ──────────────────────────
res = await fetch(`${API}/api/challenges/${CID}/accept`, { method: 'POST', headers: { ...authH(R), ...WIRE }, body: '{}' });
assert.equal(res.status, 200, `accept: ${res.status} ${await res.clone().text()}`);
results.accept = await j(res);

// ── 7. POST /challenges/{id}/complete (applied_spec_digest; no wire header) ─
res = await fetch(`${API}/api/challenges/${CID}/complete`, { method: 'POST', headers: authH(R),
  body: JSON.stringify({ source_run_id: runId, applied_spec_digest: SPEC, tz_offset_minutes: 0 }) });
assert.equal(res.status, 200, `complete: ${res.status} ${await res.clone().text()}`);
results.complete = await j(res);

// ── DB facts ───────────────────────────────────────────────────────────────
const events = dbq(`SELECT kind, count(*) FROM challenge_events WHERE challenge_id='${CID}' GROUP BY kind ORDER BY kind`);
const eventMap = Object.fromEntries(events.map((e) => [e[0], Number(e[1])]));
const bindings = dbq(`SELECT count(*) FROM challenge_ticket_bindings WHERE spec_digest='${SPEC}'`)[0][0];
const receipts = dbq(`SELECT friendship_outcome, count(*) FROM challenge_friendship_receipts GROUP BY friendship_outcome`);
const friendship = dbq(`SELECT user_lo, user_hi, source FROM island_friendships WHERE source='challenge'`);
const edges = dbq(`SELECT count(*) FROM friend_edges WHERE source='challenge'`)[0][0];
const attempts = dbq(`SELECT count(*) FROM challenge_attempts WHERE challenge_id='${CID}'`)[0][0];
const rewards = dbq(`SELECT count(*) FROM reward_ledger WHERE idempotency_key LIKE 'ch:%'`)[0][0];

assert.ok(eventMap.create === 1 && eventMap.accept >= 1 && eventMap.complete === 1, `events: ${JSON.stringify(eventMap)}`);
assert.equal(Number(bindings), 2, `expected 2 ticket-bindings (source+recipient), got ${bindings}`);
assert.equal(friendship.length, 1, `expected 1 island_friendship source=challenge, got ${friendship.length}`);
const lo = Math.min(C, R), hi = Math.max(C, R);
assert.deepEqual([friendship[0][0], friendship[0][1], friendship[0][2]], [lo, hi, 'challenge'], 'friendship pair + source');
assert.ok(receipts.length >= 1 && receipts.some((r) => r[0] === 'created'), `friendship receipt created: ${JSON.stringify(receipts)}`);
assert.equal(Number(edges), 2, `friend_edges challenge (both directions) = 2, got ${edges}`);
assert.ok(Number(attempts) >= 1, 'challenge attempt recorded');

console.log('\nRECIPIENT V1 HTTP E2E — passed:');
console.log('  • GET challenge (wire) → content-addressed runtime + spec_digest');
console.log('  • recipient run.start (wire) → ticket-binding BEFORE play (same server-derived spec_digest)');
console.log('  • level-bundle (wire) → sibling-binder configure_level handshake → reveal (real client module)');
console.log(`  • /results applied_spec_digest=${SPEC.slice(0, 10)} → challenge_spec_bindings written`);
console.log('  • accept + complete → rewards/DM path');
console.log(`  • DB: events=${JSON.stringify(eventMap)} ticket_bindings=${bindings} spec_bindings=1 attempts=${attempts} rewards(ch:)=${rewards}`);
console.log(`  • island_friendship source='challenge' (${lo}↔${hi}) + friend_edges=${edges} + receipt=created`);
