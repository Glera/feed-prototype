# Island Social Core — browser E2E support

`../check-island-social-browser.mjs` drives the real production Feed build
(`VITE_ISLAND_ENABLED=1`) against a **running** swipe-backend uvicorn stand backed
by a disposable migrated PostgreSQL. Auth uses genuine HMAC-signed Telegram
`initData` via the client's `?initData=` dev override, so every island API call is
authenticated end-to-end; after each UI action the harness asserts the resulting
PostgreSQL facts.

These Python helpers run against the stand DB with the backend venv (they
`import app.*`, so `PYTHONPATH` must point at the swipe-backend checkout):

- `seed_e2e.py` — owner island fixture (B0 collectible, B1 MAX, empty foundation slots).
- `reset_e2e.py` — deterministic per-run rewind (append-only journals via
  `session_replication_role=replica`; disposable DB only).
- `dogfood_setup.py` — fresh user → island → auto-friend bot → bot tick grows house.
- `dbq.py` — one-off SQL → JSON, used for DB-fact assertions.

## Prereqs (set by the P1-D runner, not by this harness)

Backend on `API_ORIGIN` with `ENABLE_ISLAND_SOCIAL=1`, `ENABLE_ISLAND_BOTS=1`,
a known `BOT_TOKEN`, `INITDATA_MAX_AGE=0`, a small `ISLAND_PLAY_MIN_WIN_MS`
(e.g. 1000), `ISLAND_BOT_TICK_SEC` large (manual ticks), and `ALLOWED_ORIGINS`
including the harness static origin. Bots seeded (`python -m app.island_bots seed
--apply`) and `seed_e2e.py` applied.

## Run

```
BOT_TOKEN=<token> \
API_ORIGIN=http://127.0.0.1:5211 \
VENV_PY=<swipe-backend>/.venv/bin/python \
BACKEND_ROOT=<swipe-backend> \
DATABASE_URL=postgresql+psycopg://.../island_e2e \
STATIC_PORT=5213 \
node scripts/check-island-social-browser.mjs
```

Screenshots land in `e2e-artifacts/island-social/`.
