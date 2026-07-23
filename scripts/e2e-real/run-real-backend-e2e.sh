#!/usr/bin/env bash
#
# One-command orchestration for the real-backend feed E2E:
#   local PostgreSQL  ->  alembic upgrade head  ->  seed published series
#   ->  uvicorn full app  ->  build Feed (3 gates)  ->  serve Feed + runtime
#   ->  (proof) close the effectful chain over real HTTP + PostgreSQL.
#
# Every stage prints its own explicit exit code. Nothing here touches a system
# service: PostgreSQL runs in a disposable data dir under $PG_ROOT.
#
# Requires: Homebrew postgresql@15, the swipe-backend .venv (deps only), node.
#
# Usage:
#   bash scripts/e2e-real/run-real-backend-e2e.sh            # full run, leaves servers up
#   STOP_AFTER=driver bash scripts/e2e-real/run-real-backend-e2e.sh   # stop after chain proof
#
set -uo pipefail

# ---- paths (override via env) ----------------------------------------------
WORKSPACE="${WORKSPACE:-/Users/gleb/My projects/p4g-platform-workspace}"
BACKEND="${BACKEND:-$WORKSPACE/swipe-backend-e2e-real}"
FEED="${FEED:-$WORKSPACE/feed-prototype-e2e-real}"
VENV="${VENV:-$WORKSPACE/swipe-backend/.venv/bin}"
PG_BIN="${PG_BIN:-/usr/local/opt/postgresql@15/bin}"
PG_ROOT="${PG_ROOT:-$WORKSPACE/scratchpad/pg-e2e-real}"
PG_SOCK="${PG_SOCK:-/tmp/pge2e}"        # short path — the datadir path is too long for a unix socket
PG_PORT="${PG_PORT:-54329}"
DB_NAME="${DB_NAME:-swipe_e2e}"
API_PORT="${API_PORT:-8099}"
SERVE_PORT="${SERVE_PORT:-8188}"
DOGFOOD_USER_ID="${DOGFOOD_USER_ID:-9018100101}"
STOP_AFTER="${STOP_AFTER:-}"           # '', 'migrate', 'seed', 'driver', 'serve'

export DATABASE_URL="postgresql+psycopg://postgres@127.0.0.1:${PG_PORT}/${DB_NAME}"
export PYTHONUTF8=1 LANG=en_US.UTF-8
SEED_MANIFEST="${SEED_MANIFEST:-$PG_ROOT/seed_manifest.json}"

step() { printf '\n=== %s ===\n' "$1"; }
die()  { printf '!! %s (exit=%s)\n' "$1" "${2:-1}"; exit "${2:-1}"; }

# ---- 1. PostgreSQL ---------------------------------------------------------
step "1. PostgreSQL (disposable datadir: $PG_ROOT/data)"
mkdir -p "$PG_ROOT" "$PG_SOCK"
if [ ! -f "$PG_ROOT/data/PG_VERSION" ]; then
  LC_ALL=C "$PG_BIN/initdb" -D "$PG_ROOT/data" -U postgres --auth=trust --no-locale -E UTF8 \
    >"$PG_ROOT/initdb.log" 2>&1 || die "initdb failed (see $PG_ROOT/initdb.log)" $?
fi
if ! "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
  LC_ALL=C "$PG_BIN/pg_ctl" -D "$PG_ROOT/data" \
    -o "-p $PG_PORT -k $PG_SOCK -c listen_addresses=127.0.0.1" \
    -l "$PG_ROOT/server.log" -w start || die "pg_ctl start failed (see $PG_ROOT/server.log)" $?
fi
"$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PG_PORT"; echo "pg_isready exit=$?"
"$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U postgres "$DB_NAME" 2>/dev/null \
  && echo "createdb: created $DB_NAME" || echo "createdb: $DB_NAME already exists"

# ---- 2. alembic upgrade head ----------------------------------------------
step "2. alembic upgrade head"
( cd "$BACKEND" && "$VENV/alembic" upgrade head ) || die "alembic upgrade failed" $?
( cd "$BACKEND" && "$VENV/alembic" current ); echo "alembic current exit=$?"
[ "$STOP_AFTER" = "migrate" ] && exit 0

# ---- 3. seed published series ---------------------------------------------
step "3. seed published series (reuses exact PostgreSQL test fixtures)"
( cd "$BACKEND" && RUN_CONTROL_PLANE_POSTGRES_TESTS=1 PYTHONPATH="$BACKEND" \
    "$VENV/python" scripts/e2e_real/seed_published_series.py ) >"$SEED_MANIFEST" \
  || die "seed failed" $?
echo "seed manifest -> $SEED_MANIFEST"; cat "$SEED_MANIFEST"; echo
[ "$STOP_AFTER" = "seed" ] && exit 0

# ---- 4. uvicorn (full production app + dogfood auth override) --------------
step "4. uvicorn full app on :$API_PORT"
pkill -f "e2e_real_full_app:app" 2>/dev/null; sleep 1
( cd "$BACKEND"
  export ENABLE_CATALOG_PLAYER_V2=true ENABLE_FEED_EFFECTFUL_AUTHORITY=true ENABLE_CATALOG_ALLOCATION=false
  export FEED_EFFECTFUL_DOGFOOD_USER_IDS="$DOGFOOD_USER_ID"
  export FEED_EFFECTFUL_AFFINITY_CONFIG_VERSION="$("$VENV/python" -c "import json;print(json.load(open('$SEED_MANIFEST'))['affinityConfigVersion'])")"
  export FEED_EFFECTFUL_SLOT_CONFIG_VERSION="$("$VENV/python" -c "import json;print(json.load(open('$SEED_MANIFEST'))['slotConfigVersion'])")"
  export FEED_EFFECTFUL_RUNWAY_CONFIG_VERSION="$("$VENV/python" -c "import json;print(json.load(open('$SEED_MANIFEST'))['runwayConfigVersion'])")"
  export RUN_TICKET_MIN_RESULT_MS=0
  export RUN_START_HOURLY_LIMIT=100000 RUN_START_DAILY_LIMIT=100000 RESULTS_HOURLY_LIMIT=100000 RESULTS_DAILY_LIMIT=100000
  export E2E_DOGFOOD_USER_ID="$DOGFOOD_USER_ID" PYTHONPATH="$BACKEND"
  nohup "$VENV/uvicorn" scripts.e2e_real.e2e_real_full_app:app --host 127.0.0.1 --port "$API_PORT" \
    >"$PG_ROOT/uvicorn.log" 2>&1 &
  echo "uvicorn pid=$!" )
sleep 4
curl -s -o /dev/null -w "session http=%{http_code}\n" -X POST "http://127.0.0.1:$API_PORT/api/session" \
  -H "Authorization: tma x" || die "uvicorn not reachable" $?

# ---- 5. prove the effectful chain over real HTTP + PostgreSQL --------------
step "5. drive backend chain (builtin opportunity -> ... -> chest)"
( cd "$BACKEND" && E2E_API_BASE="http://127.0.0.1:$API_PORT" E2E_SEED_MANIFEST="$SEED_MANIFEST" \
    PYTHONPATH="$BACKEND" "$VENV/python" scripts/e2e_real/drive_backend_chain.py )
echo "driver exit=$?"
[ "$STOP_AFTER" = "driver" ] && exit 0

# ---- 6. build Feed with the three gates against the real backend -----------
step "6. build Feed (VITE_CONTROL_PLANE / CATALOG_PLAYER_V2 / FEED_EFFECTFUL_AUTHORITY)"
( cd "$FEED"
  [ -e node_modules ] || ln -s "$WORKSPACE/feed-prototype/node_modules" node_modules
  export VITE_API_BASE="http://127.0.0.1:$API_PORT"
  export VITE_CONTROL_PLANE_ENABLED=true VITE_CATALOG_PLAYER_V2_ENABLED=true
  export VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED=true VITE_CATALOG_DOGFOOD_USER_ID="$DOGFOOD_USER_ID"
  npm run build ) || die "feed build failed" $?

# ---- 7. serve Feed + real content-addressed runtime (same origin) ----------
step "7. serve Feed on :$SERVE_PORT"
pkill -f "serve-feed-real-published-e2e" 2>/dev/null; sleep 1
( cd "$FEED"
  export E2E_DOGFOOD_USER_ID="$DOGFOOD_USER_ID" VITE_API_BASE="http://127.0.0.1:$API_PORT" SERVE_PORT="$SERVE_PORT"
  nohup node scripts/serve-feed-real-published-e2e.mjs >"$PG_ROOT/serve.log" 2>&1 &
  echo "serve pid=$!" )
sleep 2
cat "$PG_ROOT/serve.log"
echo
echo "Feed:  http://127.0.0.1:$SERVE_PORT/feed"
echo "API:   http://127.0.0.1:$API_PORT"
echo "Logs:  $PG_ROOT/{uvicorn,serve,server}.log"
