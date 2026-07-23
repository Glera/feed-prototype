# Real-backend feed E2E — runbook

Goal: the real Feed (three gates on) driving a **real uvicorn backend on real
local PostgreSQL** through `reveal → intercept → level → /results → next level
→ chest`. This is one of the hard gates before `capabilities.levelSeries=true`.

Two worktrees hold the scaffolding (never touch the main checkouts):

- `swipe-backend-e2e-real` (branch `e2e-real-backend`) — seed, ASGI apps, chain driver.
- `feed-prototype-e2e-real` (branch `e2e-real-backend`) — Feed build, serve harness, browser driver, this runbook.

## Status

| Stage | Proven | Command → exit |
| --- | --- | --- |
| PostgreSQL up (disposable datadir) | ✅ | `pg_ctl … start` → 0 |
| `alembic upgrade head` (0048, 94 tables) | ✅ | `alembic upgrade head` → 0; `alembic current` → 0 |
| Seed published series (exact test fixtures) | ✅ | `seed_published_series.py` → 0 |
| uvicorn full app boots on real PG | ✅ | `POST /api/session` → 200 |
| **Backend chain over real HTTP+PostgreSQL** | ✅ | `drive_backend_chain.py` → 0 (7/7 steps HTTP 200) |
| Feed builds with 3 gates vs real backend | ✅ | `npm run build` → 0 |
| Feed boots in browser vs real backend | ✅ | `drive-feed-browser.mjs` → 0 (`bootReachedRealBackend: true`) |
| **Effectful catalog lane arms in browser** | ✅ | `drive-feed-browser.mjs` → `effectfulChainArmed: true` (generated-offer + runs/start + specs 200) |
| Generated catalog card inserted + opened | ✅ | `landedOnGeneratedCard: true` |
| Real runtime configures seeded spec + starts attempt | ✅ | PG: `catalog_level_impression` + `attempt_start` projected |
| **Level WIN → /api/results → chest (hands-free)** | ✅ | `drive-feed-browser.mjs` → `chestResultsPosted: 1`; PG: `attempt_outcome_facts=win`, level `verified_run` (ordinal 1), chest receipt (ordinal NULL, series-bound) |
| **Multi-id generative feed** (operator question) | ✅ | `E2E_SEED_USER_ID` + `FEED_TG`; each of `9018100101` and `111222333` gets a `generated-offer` `feed_decision` bound to its own `user_id`, and closes level+chest |

## One-command run

```bash
bash scripts/e2e-real/run-real-backend-e2e.sh          # full run; leaves uvicorn + serve up
STOP_AFTER=driver bash scripts/e2e-real/run-real-backend-e2e.sh   # stop after the proven chain
```

Each stage prints its own explicit exit code. PostgreSQL runs in a disposable
datadir under `$PG_ROOT` (default `scratchpad/pg-e2e-real`) — no system service
is touched. Reuses the `swipe-backend/.venv` (packages only; app code loads from
the worktree).

## Manual steps (what the launcher automates)

Environment (macOS, Homebrew `postgresql@15`):

```bash
export PGBIN=/usr/local/opt/postgresql@15/bin
export PGROOT="$WORKSPACE/scratchpad/pg-e2e-real"
export VENV="$WORKSPACE/swipe-backend/.venv/bin"
export DATABASE_URL="postgresql+psycopg://postgres@127.0.0.1:54329/swipe_e2e"
export PYTHONUTF8=1 LANG=en_US.UTF-8     # alembic.ini/migrations contain non-ASCII
```

1. **PostgreSQL** (the datadir path is too long for a unix socket → short `-k` dir,
   and macOS needs `LC_ALL=C` at init/start to avoid "postmaster became multithreaded"):

   ```bash
   LC_ALL=C "$PGBIN/initdb" -D "$PGROOT/data" -U postgres --auth=trust --no-locale -E UTF8
   mkdir -p /tmp/pge2e
   LC_ALL=C "$PGBIN/pg_ctl" -D "$PGROOT/data" \
     -o "-p 54329 -k /tmp/pge2e -c listen_addresses=127.0.0.1" -l "$PGROOT/server.log" -w start
   "$PGBIN/createdb" -h 127.0.0.1 -p 54329 -U postgres swipe_e2e
   ```

2. **Migrate** (from `swipe-backend-e2e-real`): `"$VENV/alembic" upgrade head`

3. **Seed** (from `swipe-backend-e2e-real`) — reuses the exact opt-in PostgreSQL
   fixtures behind `tests/test_feed_effectful_player_e2e_postgres.py`; invents no
   INSERTs:

   ```bash
   RUN_CONTROL_PLANE_POSTGRES_TESTS=1 PYTHONPATH="$PWD" \
     "$VENV/python" scripts/e2e_real/seed_published_series.py > /tmp/seed_manifest.json
   ```

   Manifest carries `dogfoodUserId`, the three config versions, `sourceMappingId`,
   and the published `entryId`/`runtimeReleaseId`/`specHash`.

4. **uvicorn** — the full production `app.main:app` wrapped with a fixed dogfood
   `require_tma_user` override (the only transport shim: a local run has no
   Telegram signing oracle). Env config versions come from the seed manifest:

   ```bash
   ENABLE_CATALOG_PLAYER_V2=true ENABLE_FEED_EFFECTFUL_AUTHORITY=true \
   FEED_EFFECTFUL_DOGFOOD_USER_IDS=9018100101 \
   FEED_EFFECTFUL_AFFINITY_CONFIG_VERSION=affinity.pilot.v1 \
   FEED_EFFECTFUL_SLOT_CONFIG_VERSION=slot.effectful-authority-postgres.v2 \
   FEED_EFFECTFUL_RUNWAY_CONFIG_VERSION=runway.pilot.v1 \
   RUN_TICKET_MIN_RESULT_MS=0 E2E_DOGFOOD_USER_ID=9018100101 PYTHONPATH="$PWD" \
     "$VENV/uvicorn" scripts.e2e_real.e2e_real_full_app:app --host 127.0.0.1 --port 8099
   ```

   (For the pure backend chain proof there is also a minimal 5-router app,
   `scripts.e2e_real.e2e_real_app:app`.)

5. **Prove the chain** (backend half, real HTTP + PostgreSQL — no `_db_now`
   monkeypatch; the real microsecond clock is floored by production code):

   ```bash
   E2E_API_BASE=http://127.0.0.1:8099 E2E_SEED_MANIFEST=/tmp/seed_manifest.json \
     "$VENV/python" scripts/e2e_real/drive_backend_chain.py    # → exit 0, 7/7 HTTP 200
   ```

6. **Build Feed** (from `feed-prototype-e2e-real`; symlink node_modules from the
   main checkout — worktrees don't share them):

   ```bash
   ln -s "$WORKSPACE/feed-prototype/node_modules" node_modules
   VITE_API_BASE=http://127.0.0.1:8099 VITE_CONTROL_PLANE_ENABLED=true \
   VITE_CATALOG_PLAYER_V2_ENABLED=true VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED=true \
   VITE_CATALOG_DOGFOOD_USER_ID=9018100101 npm run build
   ```

7. **Serve** Feed + the real content-addressed runtime, same origin (the Feed
   resolves the server-selected locator against `location.href`):

   ```bash
   E2E_DOGFOOD_USER_ID=9018100101 VITE_API_BASE=http://127.0.0.1:8099 SERVE_PORT=8188 \
     node scripts/serve-feed-real-published-e2e.mjs
   ```

8. **Browser** — `http://127.0.0.1:8188/feed` (re-seed a fresh continuity trigger
   first; do NOT pre-run `drive_backend_chain.py`, it consumes the one-shot
   trigger), or headless:

   ```bash
   FEED_URL=http://127.0.0.1:8188/feed API_BASE=http://127.0.0.1:8099 \
   FEED_PLAY_MS=90000 node scripts/e2e-real/drive-feed-browser.mjs
   ```

## What the browser closure now proves (and the two harness fixes)

Against the real backend + real PostgreSQL + real content-addressed runtime the
browser now closes:

  boot → `POST /api/feed/generated-offer` (200) → `allocate-authorized` →
  `runs/start` (200) → `tickets/<id>/specs` (200) → generated catalog card
  inserted at its ring index → landed & opened → runtime `configure_ready` /
  `configured` → **`catalog_level_impression` + `attempt_start` projected in PG**.

Two harness bugs had to be fixed to get here (both in
`scripts/serve-feed-real-published-e2e.mjs`, neither touches frontend logic):

1. **Telegram initData clobber.** The app loads
   `telegram.org/js/telegram-web-app.js`, which reassigns
   `window.Telegram.WebApp` with an empty `initData` (`platform:"unknown"`) in a
   plain browser — *before* the Feed class constructs. `catalogDogfoodEnabled`
   is a readonly field evaluated at construction (`controlPlaneEnabled()` needs
   `getInitData() !== null`), so it latched **false** and the whole dogfood
   prefetch was disabled. Fix: the harness redirects the Feed URL to carry
   `?initData=` — `getInitData()`'s sanctioned dev fallback, read from
   `location.search`, is clobber-proof and available at construction.
2. **Missing generated preview.** The seeded content has no
   `catalog-previews/<contentHash>.cover.jpg`, so `loadGeneratedPreview()` 404'd
   and the offer never became `ready`. The preview is only the feed card
   thumbnail (not part of the spec/runtime gameplay closure), so the harness
   synthesizes a self-consistent `catalog.generated-preview.v1` manifest + cover
   bytes for the seeded content hash (gated by `E2E_SYNTH_PREVIEW`, default on).

Also note: the one-shot continuity trigger is consumed per generated-offer, so
each browser run needs a fresh `seed_published_series.py` and no interleaved
backend chain-driver run.

## Hands-free completion — how the driver wins the real level

The real `marble-sort-swipe` runtime does not self-play on its own: it plays only
while it considers itself *interactive* (SWIPE target:
`isInteractive() === (!hostPaused && !document.hidden)`), and the feed
host-pauses catalog slots. The driver therefore:

1. **Keeps the frame live** — a tight same-origin in-page pump (60 ms) forces the
   catalog iframe's `document.hidden=false` and calls `__playable.setHostPaused(
   false)`, out-pacing the feed's re-pause (the runtime's `paused` gate blocks the
   physics/scheduler advance otherwise).
2. **Uses the runtime's own solver** — `__playable.sortQa.chooseOracleAction()`
   returns the best cell to release (no `?vclock=1` needed; `applyOracleAction`
   is vclock-gated so it is not usable in the normal catalog frame). The driver
   reads `sortQa.snapshot()` for that cell's `row/col`, computes its canvas
   position (`x=95+col*40, y=48+row*40` for the seeded 6-wide grid, uniform
   scale), and dispatches a **real pointer tap** on the same-origin canvas — the
   exact input a human makes. Runtime code is never modified.

The runtime then emits its genuine win outcome → the Feed forwards
`/api/results` (level) then the chest. Proven in PG for both the default and the
second player:

```
attempt_outcome_facts : win
verified_runs         : ordinal=1, series=<sid>, applied_spec_hash=<seeded spec>   (level result)
verified_runs         : ordinal=NULL, series=<sid>, run=series-…                    (chest receipt)
```

Notes: the seeded series is **single-level** (`series_levels = 1`) + chest; the
driver's `chestResultsPosted` classifies from the `/api/results` **request** body
(the ack does not echo `metric_key`). `LOGICAL_ORACLE`/`VIRTUAL_CLOCK` both need
extra query params (`?oracle=1`, `?vclock=1`) the catalog frame cannot carry, so
the tap-solver is the driver-side path.
```
