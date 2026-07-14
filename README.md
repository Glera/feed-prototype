# feed-prototype — Swipe platform

Telegram Mini App: вертикальная лента playable-механик (TikTok-style), где каждая
единица ленты — реальный плейбл из `playables/` в своём iframe. Вокруг ленты —
социальный слой (звёзды, уровни, челленджи) и два параллельных мета-эксперимента,
включая генеративные UGC-механики. Стек: Vanilla TS + Vite, single-file сборка.

Прод: `https://swipe-platform.onrender.com` (Render Static). Первый закрытый тест —
**13.10.2026** (план: `SWIPE_W5_BACKLOG_WEEKS1-3_V1.html` в корне воркспейса,
статус — `swipe-backend/docs/PROGRESS.md`).

## Карта репозиториев

| Репо / папка | Роль |
|---|---|
| `feed-prototype/` | ИСХОДНИК ленты (этот репо). Собирается в один `index.html`. |
| `Glera/swipe-platform` | Деплой-репо (Render Static): `index.html` ленты + swipe-сборки механик как same-origin соседи. |
| `playables/<id>-swipe/` | Форки механик под ленту; `npm run build:swipe <id>` → `dist-swipe/` (шелл + внешний `payload.js` + asset/video-файлы). |
| `Glera/swipe-backend` | FastAPI + Postgres: сессии, результаты, звёзды, телеметрия, island-эндпоинты. `swipe-backend/docs/OVERVIEW.md`. |
| `Glera/swipe-ugc` | Хостинг сгенерированных UGC-механик (артефакты с контент-хэшем в имени) + bake/experiment-воркеры. |
| `swipe-generator/` | Локальная «лаборатория» wild-генерации (T3), супервизится dev-Vite. |
| `swipe-bot` | Телеграм-бот, владеет Mini App. |

## Состав ленты

Ростер задаётся в [src/playables.ts](src/playables.ts) (сейчас 10 юнитов: семейство
merge — locked/timepress/second-board, marble-sort, pins + pins-l3, short-drama).
Манифест `versions.json` генерится при экспорте и несёт версию, размеры и
`mountCost` каждой механики — лента по нему решает глубину префетча.

Поверх механик:
- **Серии** — 5 уровней на механику, сундук 3–9⭐ в конце; ряд серии рисует лента,
  уровень пробрасывается в механику параметром при маунте.
- **Звёзды / уровни игрока** — баланс на бэке (`reward_ledger`), клиент сеедится
  из `/session`, победы идут в `/results` с идемпотентным `run_id`.
- **Челленджи** — полный луп построен (W2): победа вручную → «⚡ Бросить вызов»
  → deep-link `startapp=<id>` → приёмник играет ту же механику на время; рейл
  входящих в HUD (`GET /challenges?box=in`). On-device DoD — в процессе.

## Как устроена лента (ключевые механизмы)

- **Один живой юнит.** Текущая механика играет; следующая заранее греется
  СКРЫТО (idle-warm) и приезжает без лоадера. Соседи стоят на host-pause.
- **Staged-boot контракт** с плейблом: `static_ready` → хост шлёт
  `prepareInteractive` (тяжёлые декоды/GL внутри warm-фрейма) → `interactive_ready`.
  Прогрев не стартует под пальцем игрока (same-origin проба тачей в iframe) и
  ждёт «спокойных кадров» текущей механики.
- **Автоплей + перехват.** Приехавшая механика крутит демо под вуалью
  (`game__autoplay`, слот в scale 0.92); тап — перехват в ручную игру; свайпы
  ленты живут на вуали и жёлобах, тачи ручной игры — внутри iframe.
- **Постеры/обложки.** Едущая страница показывает постер из host-документа
  (off-screen iframe не растеризуется), обложки — `dist-swipe/cover.jpg`.
- **Завершение** механика сообщает postMessage-событием (`completed` и др.) —
  лента начисляет награду и рисует win-слой.
- Диагностика пайплайна прогрева: `?warm=1` + `window.__feedWarm()` в консоли,
  длинные таски и тайминги бута — `?perf=1` (оверлей с копированием).

## Мета-эксперименты (два, параллельно)

Нижняя панель: **ромб** — мета «Creator District» (`openMetaWorld` в feed.ts),
**треугольник** — мета «остров». Не смешивать: у острова всё неймспейсится
`island_*` / `isl-*`.

**Остров** — генеративные UGC-механики: игрок промптом создаёт вариацию механики,
она печётся в артефакт, хостится на swipe-ugc и живёт зданием на его острове;
гости играют и лайкают. Три тира генерации (safe-параметризация без модели /
guided через API-модель с гейтом проходимости / wild — локальный агент правит код
форка в одноразовом клоне с автоплей-гейтом). Полное описание, карта потоков,
дебаг и TODO — **[ISLAND.md](./ISLAND.md)**.

## Файлы

| Файл | Роль |
|---|---|
| `src/main.ts` | Точка входа, собирает `Feed`. |
| `src/feed.ts` | Ядро: пейджер, warm-пайплайн, автоплей/перехват, серии, награды, HUD, постеры. |
| `src/playables.ts` | Ростер механик + резолв URL/уровней. |
| `src/island.ts`, `src/island-state.ts` | Мета «остров»: карта, генерация (3 тира), стейт. |
| `src/api.ts` | Клиент бэкенда (`Authorization: tma <initData>`, абсолютный URL + CORS). |
| `src/telegram.ts` | TMA-интеграция: fullscreen, insets → `--safe-*`, disableVerticalSwipes. |
| `src/telemetry.ts` | Очередь событий → `/events` (fetch + sendBeacon). |
| `src/outbox.ts`, `src/debug.ts` | Надёжная отправка результатов; дебаг-панель. |
| `vite.config.ts` | Dev-сервер: раздаёт `dist-swipe` механик, `/versions.json`, `/ugc/*`, island-API (генерация в dev), супервизия локального генератора. |

## Запуск и деплой

```bash
cd feed-prototype
npm install
npm run dev     # vite; в dev сам сервит механики из ../playables/*/dist-swipe
npm run build   # tsc + vite build → dist/index.html (single file)
```

Effectful catalog path можно прогнать без живого backend/runtime:

```bash
npm run serve:catalog-feed-dogfood
```

Команда делает две production-сборки (canary включён/выключен) и печатает URL
шести сценариев: fresh invitation, hard recall, двухвкладочная allocation-гонка с конфликтом уже принятого
impression, точный no-invitation fallback, другой аккаунт и выключенный canary.
На странице поверх реального `Feed` есть воспроизводимый trace и итоговый
`PASS/FAIL`; проверяются poster-only без iframe до authority, opaque allocation,
exact ticket/spec/impression/result/chest и возврат к проверенной встроенной
механике без награды при terminal conflict/recall. Продуктовые флаги по умолчанию
выключены; `npm run lint` автоматически проверяет wire/изоляцию всех URL.

Canary-путь в production требует ровно четыре additive frontend-флага и один
точный аккаунт (canary-флаг никогда не расширяет базовый effectful scope):

```bash
VITE_CONTROL_PLANE_ENABLED=true
VITE_CATALOG_PLAYER_V2_ENABLED=true
VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED=true
VITE_CATALOG_CANARY_DOGFOOD_ENABLED=true
VITE_CATALOG_DOGFOOD_USER_ID=<telegram-user-id>
```

Отсутствующий, неканонический или несовпадающий `VITE_CATALOG_DOGFOOD_USER_ID`
fail-closed оставляет пользователя на проверенной встроенной механике. Generic
control-plane shadow при этом остаётся независимым и может собираться шире.
`GET /api/catalog/canary-authority` выполняется до normal effectful authority;
только точный `404 catalog_canary_invitation_not_found` продолжает обычную
политику. При invitation клиент передаёт дальше только opaque
`authorizationId`, а pending-слот остаётся poster-only.

Reload закрыт пока только для потерянного transport response: canary повторяет
`ticket_id = authorizationId` и `run_id = catalog-canary:<authorizationId>`, а
mount разрешён лишь для active ticket с `completed_levels=0`. Это не
mid-series resume: частично сыгранный/terminal ticket и любой поздний
configured-impression CP conflict или terminal result conflict немедленно
возвращает reviewed builtin без chest/reward.
Новая попытка требует новой операторской invitation; доставленная запись не
блокирует её создание.
Каждый canary (включая fresh GET) до exact `projected` ACK специализированного
impression остаётся paused/non-interactive: это закрывает гонку двух вкладок,
которые обе могли увидеть `replayed=false` до первого allocation commit.

Smoke с настоящими backend и content-addressed runtime запускается отдельно:

```bash
VITE_API_BASE=https://backend.example \
VITE_CATALOG_DOGFOOD_USER_ID=<telegram-user-id> \
CATALOG_REAL_E2E_INIT_DATA='<signed Telegram initData>' \
npm run serve:catalog-feed-real-e2e
```

InitData читается только процессом локального E2E-сервера и инжектируется в
отдаваемую браузеру страницу — в bundle, URL и stdout секрет не записывается.
Harness не подменяет и не проксирует API/runtime: он требует от backend абсолютный
HTTPS locator вида `runtime-releases/<playable>/<artifact-digest>/…`, требует
fresh opaque canary invitation (normal authority в этом гейте запрещён),
проверяет canary allocation и deterministic zero-progress ticket и ставит
`PASS` только после specialized impression от сконфигурированного runtime.

Деплой — из `playables/`: `bash scripts/deploy-swipe.sh [<id>…|--all]` —
пересобирает ленту со свежим стампом (виден в левом нижнем углу бара),
экспортирует механики и пушит `swipe-platform` (Render автодеплой).

Полезные флаги: `?initData=<raw>` (бэкенд из обычного браузера),
`?settings=1` (шестерёнка), `?warm=…`/`?warmpaint=…` (A/B прогрева),
`?tier=` (форс quality-тира механик).

## История

Репо начиналось как прототип свайпа (фаза 1 — жесты/жёлоб, фаза 2 — реальные
плейблы «одна живая игра»); обе фазы давно закрыты, описание выше — текущее
состояние платформы.
