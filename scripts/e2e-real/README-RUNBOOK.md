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
| **Effectful catalog lane arms in browser** | ❌ | see "Known remaining gap" |

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

8. **Browser** — `http://127.0.0.1:8188/feed`, or headless:

   ```bash
   FEED_URL=http://127.0.0.1:8188/feed API_BASE=http://127.0.0.1:8099 \
     node scripts/e2e-real/drive-feed-browser.mjs
   ```

## Known remaining gap (the single next step)

The Feed boots against the real backend and reveals the marble-sort card, but
the browser never issues `POST /api/feed/generated-offer` (probe:
`effectfulChainArmed: false`; distinct API paths are only `session`,
`daily/sync`, `events`). Consequence: the catalog lane never arms, so
`reveal → intercept → level → results → chest` does not run through the browser.

Root cause (traced): the catalog slot only arms in `attachPreparedGeneratedOffer`
(`src/feed.ts`), which requires `generatedOfferState === 'ready'`. That state is
produced by `prefetchGeneratedOffer` (`src/feed.ts` ~1042–1270), which
`POST`s `/api/feed/generated-offer` only after its **target-index discovery**
selects the sort exposure. The three gates satisfy `catalogFeedDogfoodEnabled`,
and the seed provides the server-side continuity trigger + affinity snapshot,
but the client's personal-catalog runway discovery is not selecting a
near-viewport sort target in this session, so prefetch never starts.

**Next step:** trace `prefetchGeneratedOffer` / `generatedTargetIndex` discovery
in `src/feed.ts` (~1042–1270) and satisfy its target-selection condition — the
personal-catalog runway must resolve the seeded continuity/affinity to a concrete
near-viewport sort target — or add a deterministic dogfood hook to force the
target index. Once `POST /api/feed/generated-offer` fires, the already-proven
backend closure (authority → allocate → ticket/spec → results → chest) delivers
the exact spec bundle and the iframe runs the real content-addressed
`marble-sort-swipe` runtime through the chest. Watch for a second-order risk: the
seeded spec is the synthetic QA fixture (`make_ingested_dependencies(seed=71337)`)
— confirm the real runtime can play it to completion, or seed real sort content.
```
