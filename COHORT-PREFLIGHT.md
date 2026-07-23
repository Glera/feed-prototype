# Cohort preflight — friend cohort (3–10) launch checklist (DRAFT)

Purpose: a repeatable pre-launch gate before inviting a small friend cohort onto the
swipe feed. Owner runs the whole list top-to-bottom; every box must be checked (or
consciously waived with a note) before the first invite goes out.

Scope of this cohort: the consumer swipe feed + onboarding + recall-survival. The
unreleased Guided-UGC **island stays hidden**. The separate Creator District
(`openMetaWorld`) prototype is out of scope and untouched.

---

## 0. Zero friend = operator control pass (do this FIRST)

- [ ] **Operator runs the full flow themselves before any friend is invited.** The
      "zeroth friend" is a control pass: cold-launch the invite link on a real device,
      complete onboarding with zero coaching, play several feed slots, hit a chest,
      and confirm nothing operator-only leaks into the UI. If the operator pass is not
      clean, no friend is invited.

## 1. Island is hidden

- [ ] Build ships with **`VITE_ISLAND_ENABLED` unset / `0` / `false`** → the "Мета"
      tab does not render in the feed bar (default-off gate in `src/feed.ts`,
      `ISLAND_UI_ENABLED`).
- [ ] Confirm on a real cohort build: bottom bar shows **three** tabs
      (Ежедневные задания · Лента механик · Коллекции), **no** Meta/island tab.
- [ ] Confirm `?metaworld=1` is NOT part of any invite link (it would re-expose the
      Meta tab for Creator District testing).
- [ ] Island deep-link visits are intentionally still alive: an `?island=<ownerId>`
      link opens the island directly. Confirm no cohort invite carries an `island=`
      or island-owner `start_param` unless a visit is explicitly being tested.

## 2. Onboarding runs with zero operator hints

- [ ] A first-time user reaches "understands what to do" from a cold launch with
      **no operator narration, no side-channel coaching**. If a friend needs a verbal
      hint to proceed, that is a finding, not a pass.
- [ ] First mechanic warms and reveals within the expected budget (no white screen /
      stuck preloader on a cold device + cold cache).
- [ ] Chest / reward flow completes and reads correctly at least once end-to-end.

## 3. Recall-alive test (client survives content recall)

- [ ] Before the cohort, run a live recall drill: with a device mid-session on recalled
      content, **soft-recall then hard-recall** a piece of content via the Lab recall
      broker and confirm the client **survives** — no crash, no reward for invalidated
      content, graceful no-reward recovery, and committed results stay exact-replayable.
- [ ] Confirm late attempts against recalled content receive exactly one invalidation
      (no double-reward, no hang).
- [ ] Have the operator's rollback / recall runbook open and reachable during the cohort
      window (who pulls the lever, how, and how fast).

## 4. Flag state — must be verified, not assumed

Frontend (Vite `VITE_*`) — intended cohort state:

- [ ] `VITE_ISLAND_ENABLED` = **off** (unset/`0`) — island entry hidden (this change).
- [ ] `VITE_CONTROL_PLANE_ENABLED` = per cohort intent (see note).
- [ ] `VITE_CATALOG_PLAYER_V2_ENABLED` = per cohort intent (see note).
- [ ] `VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED` = per cohort intent (see note).

Backend (`ENABLE_*` + capabilities) — intended cohort state:

- [ ] `capabilities.levelSeries` = **false** (unchanged; hard gate until full
      manifest-bound E2E is green).
- [ ] `ENABLE_CATALOG_ALLOCATION`, `ENABLE_CATALOG_PLAYER_V2`,
      `ENABLE_FEED_EFFECTFUL_AUTHORITY`, `ENABLE_CATALOG_LEVEL_SERIES` — set
      consistently with the three frontend catalog gates above; do not enable a
      frontend catalog gate without its backend counterpart.
- [ ] `ENABLE_CATALOG_RECALL` = **on** if the recall-alive drill (§3) is exercised;
      recall broker reachable.
- [ ] Operator/Lab-only flags (`ENABLE_CATALOG_LAB_AUTH`, `ENABLE_DEV_ROUTES`,
      `ENABLE_CATALOG_OPERATOR_PROMOTION`, `ENABLE_FEED_SHADOW_OPS`, …) are **not**
      exposed to cohort accounts.

> **РЕШЕНО оператором 22.07.2026: посture (b) — catalog-served cohort.**
> Обоснование: «встроенная лента слишком скудная сейчас»; каталожная подача —
> это и есть смысл levelSeries-гейтов, и только она делает §3 recall-drill
> содержательным. Следствия: все три фронт-гейта + backend-контрпарты ON к
> старту; появляется supply-зависимость — до инвайтов в каталоге должно быть
> достаточно published-серий для «нашёл своё в разнообразии» (кормится целью
> codex Series Order + Night Factory; анти-голодание — guardrail North Star).
> `?diag=1` / `startapp=diag` остаются operator-only.

## 5. Invite link (what a friend's entry looks like)

- [ ] Confirm the exact invite artifact a friend receives (Telegram
      `t.me/<bot>?startapp=…` deep link and/or web URL). Document it verbatim here.
- [ ] The invite link carries **no** `island=`, no `metaworld`, no `diag`, no operator
      `start_param`.
- [ ] Tapping the link on a clean device lands directly in the feed (no auth wall the
      friend can't pass, no operator-only screen).
- [ ] Link tested on both platforms the cohort will actually use (Telegram Mini App and,
      if applicable, plain browser).

## 6. Qualitative feedback channel (exit-criteria questions)

- [ ] A named channel exists to collect each friend's reaction (DM / short form /
      call). Decide it before launch.
- [ ] Ask each participant, capturing first impression before prompting:
  - [ ] **First impression** — what did you think this was in the first 10 seconds?
  - [ ] **"Всё понятно?"** — was it clear what to do, without anyone telling you?
  - [ ] **"Хочется возвращаться?"** — would you want to come back? when / why / why not?
  - [ ] Where (if anywhere) did you get confused or stuck?
  - [ ] Anything feel broken, slow, or off?
- [ ] Responses are logged per-participant (not merged into a vibe) so the exit
      criteria can be judged against real answers.

---

_Draft for review. Adjust §4 posture and §5 link format to the concrete cohort before
first invite. This file lives on branch `island-cohort-gate`._
