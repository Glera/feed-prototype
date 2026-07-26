// Share/Challenge V1 — 426 case: a LEGACY client (no X-P4G-Challenge-Wire-Version
// header — exactly what the wired feed.ts apiGetChallenge/apiAcceptChallenge send)
// hitting a spec-bound challenge → 426 challenge_client_upgrade_required, with ZERO
// mutations. This is the flag/wire compatibility fence (D10/§4).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = process.env.API_ORIGIN || 'http://127.0.0.1:5221';
const BOT_TOKEN = process.env.BOT_TOKEN || 'dev-challenge-token';
const VENV_PY = process.env.VENV_PY;
const BACKEND_ROOT = process.env.BACKEND_ROOT;
const DATABASE_URL = process.env.DATABASE_URL;

function sign(uid) {
  const user = { id: uid, first_name: `U${uid}` };
  const fields = { user: JSON.stringify(user), auth_date: String(Math.floor(Date.now() / 1000)), query_id: `AAE${uid}` };
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  fields.hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(fields).toString();
}
const auth = (uid) => ({ Authorization: 'tma ' + sign(uid), 'Content-Type': 'application/json' });
function pyrun(code, ...args) {
  const r = spawnSync(VENV_PY, ['-c', code, ...args], { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
const dbq = (sql) => JSON.parse(pyrun(`import json,sys;from sqlalchemy import text;from app.db import SessionLocal
with SessionLocal() as db: print(json.dumps([list(x) for x in db.execute(text(sys.argv[1])).fetchall()],default=str))`, sql));

// reset + fresh source challenge
const tables = ['challenge_spec_bindings', 'challenge_ticket_bindings', 'challenge_events', 'challenge_friendship_receipts', 'challenge_attempts', 'verified_runs', 'run_tickets', 'reward_ledger', 'puzzle_ledger', 'level_results', 'attempt_outcome_facts', 'attempts', 'challenges', 'challenge_specs', 'island_friendships', 'island_friend_blocks', 'friend_edges', 'runtime_releases', 'variants', 'usage_counters'];
pyrun(`from sqlalchemy import text;from app.db import SessionLocal
with SessionLocal() as db:
    db.execute(text("SET session_replication_role=replica"));db.execute(text("TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE"));db.commit()`);
const setup = spawnSync(VENV_PY, [path.join(HERE, 'challenge-e2e-support', 'challenge_source_setup.py')], { cwd: BACKEND_ROOT, encoding: 'utf8', env: { ...process.env, PYTHONPATH: BACKEND_ROOT, DATABASE_URL } });
if (setup.status !== 0) throw new Error(setup.stdout + setup.stderr);
const src = JSON.parse(setup.stdout.slice(setup.stdout.indexOf('{')));
const CID = src.challenge_id, R = src.recipient;

// baseline mutation counts (only the source create-event/bindings exist)
const before = {
  ticket_bindings: Number(dbq(`SELECT count(*) FROM challenge_ticket_bindings`)[0][0]),
  events: Number(dbq(`SELECT count(*) FROM challenge_events`)[0][0]),
  attempts: Number(dbq(`SELECT count(*) FROM challenge_attempts`)[0][0]),
  friendships: Number(dbq(`SELECT count(*) FROM island_friendships`)[0][0]),
  edges: Number(dbq(`SELECT count(*) FROM friend_edges`)[0][0]),
  receipts: Number(dbq(`SELECT count(*) FROM challenge_friendship_receipts`)[0][0]),
};

// LEGACY client: NO wire header
let res = await fetch(`${API}/api/challenges/${CID}`, { headers: auth(R) });
assert.equal(res.status, 426, `GET without wire header must be 426, got ${res.status}`);
const getBody = await res.json();
assert.equal(getBody.detail?.code || getBody.code, 'challenge_client_upgrade_required', `typed code: ${JSON.stringify(getBody)}`);

res = await fetch(`${API}/api/challenges/${CID}/accept`, { method: 'POST', headers: auth(R), body: '{}' });
assert.equal(res.status, 426, `accept without wire header must be 426, got ${res.status}`);
const accBody = await res.json();
assert.equal(accBody.detail?.code || accBody.code, 'challenge_client_upgrade_required', `typed code: ${JSON.stringify(accBody)}`);

// recipient run.start without wire header → 426 too (spec-bound)
res = await fetch(`${API}/api/runs/start`, { method: 'POST', headers: auth(R), body: JSON.stringify({ ticket_id: crypto.randomUUID(), run_id: `x-${crypto.randomUUID()}`, mechanic_id: 'marble-sort-swipe', variant_id: src.variant_id, kind: 'single', challenge_id: CID }) });
assert.equal(res.status, 426, `recipient run.start without wire must be 426, got ${res.status}`);

const after = {
  ticket_bindings: Number(dbq(`SELECT count(*) FROM challenge_ticket_bindings`)[0][0]),
  events: Number(dbq(`SELECT count(*) FROM challenge_events`)[0][0]),
  attempts: Number(dbq(`SELECT count(*) FROM challenge_attempts`)[0][0]),
  friendships: Number(dbq(`SELECT count(*) FROM island_friendships`)[0][0]),
  edges: Number(dbq(`SELECT count(*) FROM friend_edges`)[0][0]),
  receipts: Number(dbq(`SELECT count(*) FROM challenge_friendship_receipts`)[0][0]),
};
assert.deepEqual(after, before, `426 must be ZERO mutations. before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);

console.log('\nCHALLENGE 426 CASE — passed:');
console.log('  • GET /challenges/{id} without wire header → 426 challenge_client_upgrade_required');
console.log('  • POST /challenges/{id}/accept without wire header → 426');
console.log('  • POST /runs/start (recipient) without wire header → 426');
console.log(`  • ZERO mutations: ${JSON.stringify(after)} (unchanged from source baseline)`);
