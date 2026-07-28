# feed-prototype — Swipe platform

Telegram Mini App: вертикальная лента playable-механик (TikTok-style), где каждая
единица ленты — реальный плейбл из `playables/` в своём iframe. Вокруг ленты —
социальный слой (звёзды, серии, коллекции, дейлики, челленджи, друзья) и два
параллельных мета-эксперимента, включая генеративные UGC-механики. Стек:
Vanilla TS + Vite, single-file сборка.

Прод: `https://swipe-platform.onrender.com` (Render Static). Первый закрытый тест —
**13.10.2026**.

Этот файл описывает **что есть в репо и как это запустить/проверить**. Статус
готовности бэкенд-контуров — `swipe-backend/docs/specs/IMPLEMENTATION-STATUS.md`
и `swipe-backend/docs/PROGRESS.md`; продуктовые обещания — `VISION.md` в корне
воркспейса. Чеклист перед запуском дружеской когорты —
[COHORT-PREFLIGHT.md](./COHORT-PREFLIGHT.md).

## Карта репозиториев

| Репо / папка | Роль |
|---|---|
| `feed-prototype/` | ИСХОДНИК ленты (этот репо). Собирается в один `index.html`. |
| `Glera/swipe-platform` | Деплой-репо (Render Static): `index.html` ленты + swipe-сборки механик как same-origin соседи. |
| `playables/<id>-swipe/` | Форки механик под ленту; `npm run build:swipe <id>` → `dist-swipe/` (шелл + внешний `payload.js` + asset/video-файлы). |
| `Glera/swipe-backend` | FastAPI + Postgres: сессии, результаты, звёзды, дейлики, телеметрия, каталог, island-эндпоинты. `swipe-backend/docs/OVERVIEW.md`. |
| `Glera/swipe-ugc` | Приватный репо: замороженные базы генерации + bake/experiment-воркеры. Сами артефакты с 26.07.2026 лежат в приватном Cloudflare R2, публичный Render-сервис остановлен — см. [ISLAND.md](./ISLAND.md). |
| `swipe-generator/` | Локальная «лаборатория» wild-генерации (T3), супервизится dev-Vite. |
| `swipe-bot` | Телеграм-бот, владеет Mini App. |

## Состав ленты

Ростер — [src/playables.ts](src/playables.ts), сейчас **13 юнитов** в порядке
ленты: `merge-locked-v1`, `marble-sort`, `pins`, `merge-timepress-v1`,
`merge-timepress-v2`, `merge-timepress-no-orders-v1`, `pins-l3`, `short-drama`,
`pins-l5`, `merge-second-board-v1`, `pins-l7`, `merge-second-board-v2`, `pins-l9`.

**Пять Pins-серий разнесены по ленте** (`pins`, `pins-l3`, `pins-l5`, `pins-l7`,
`pins-l9` = уровни 1–2, 3–4, 5–6, 7–8, 9–10). Это не отдельные сборки: `HTML_ALIAS`
шлёт все четыре `pins-lN` на `pins-swipe.html`, различает их только `?level=`.
Обложка при этом резолвится по ID *записи ленты*, а не по aliased-HTML, — у каждой
пары своя запечённая `cover`.

Манифест `versions.json` генерится при экспорте и несёт версию, размеры и
`mountCost` каждой механики: лента по нему решает глубину префетча и cache-bust,
а отсутствие механики в манифесте означает, что маунтить её нельзя.

Поверх механик:

- **Серии.** Длина серии — **своя у каждой механики**, а не фиксированные 5:
  Pins-пары, `marble-sort` и `merge-timepress-v1` → 2 уровня, `short-drama` → 6,
  `merge-locked-v1` / `merge-timepress-v2` / `no-orders` / `second-board` → 1,
  неизвестная механика → 5. Та же таблица решает, кто умеет встроенные уровни
  (`?level=`): `pins`, `pins-lN` и `short-drama`, остальные варьируются
  параметрами. Источник истины — [src/series-policy.mjs](src/series-policy.mjs),
  защищено `npm run check:series`.
- **Награды.** Победа на уровне = 1–5⭐, сундук серии = 3–9⭐ **и 1–5 пазлов**;
  оба значения детерминированы от `run_id`
  ([src/rewards.mjs](src/rewards.mjs), `npm run check:rewards`). Баланс
  authoritative на бэке (`reward_ledger`), клиент сеедится из `/session`, победы
  уходят в `/results` с идемпотентным `run_id`.
- **Челленджи** (луп W2): победа вручную → CTA «⚡ Бросить вызов» → шэр в Telegram
  → deep-link (`start_param` = UUID или `?c=<id>`) → приёмник видит карточку
  «Пройди быстрее Ns» и играет ту же механику форсированным слотом; рейл входящих
  (`GET /challenges?box=in`) живёт в сторис-ленте сверху.
  Более крупный пакет **Share/Challenge V1** (`src/challenge-*`,
  `scripts/check-challenge-*.mjs`) лежит в ветке `challenge-v1` и **в master не
  влит** — на master работает описанный выше луп.
- **Коллекции** ([src/collections.ts](src/collections.ts)): одна коллекция
  `collection_1` «Золотые хиты», 10 карточек (9-slice рамка + картинка + лента с
  названием), награда за полный сбор — 150 пазлов. Прогресс —
  `localStorage['collections-progress-v1']`.
- **Друзья** (только под `VITE_ISLAND_ENABLED`): в HUD ряд из трёх друзей плюс
  «+» (инвайт). В ячейке либо реальное фото, либо инициал — никогда оба сразу;
  имя подписано под аватаркой; тап — визит на остров друга.

## Нижняя панель

Четыре фиксированные вкладки: **Ежедневные задания · Мета · Лента механик ·
Коллекции** (по умолчанию активна лента). «Мета» — единственный UI-вход в
неизданный остров, поэтому вкладка **выпиливается из бара**, если сборка не
включила `VITE_ISLAND_ENABLED` (или не передан `?metaworld`, который уводит ту же
вкладку в отдельный прототип Creator District). Deep-link визитов это не
касается — они идут мимо бара.

- «!»-бейдж висит на «Ежедневных заданиях» (есть что забрать) и на «Мете» —
  когда на своём острове ждут подарки **или** непоказанные апгрейды домиков.
  Бейдж привязан к самой кнопке: в сборке без вкладки «Мета» он не запрашивается.
- 🐞 — дебаг-панель; постоянная кнопка в правом нижнем углу бара (левее `LAB`).
  Раскрывается той же точной capability из `/session`, что и `LAB` — то есть
  сервер решает, кто оператор; у всех остальных кнопки нет вообще (не скрытая,
  а несозданная). Плюс прежние QA-маршруты: dev-сборка, `?diag=1`,
  `start_param=diag` — они работают без всякой capability.
- `LAB` — операторский вход в Catalog Lab; скрыт и раскрывается только точной
  capability из `/session`.
- Слева внизу — стамп сборки платформы.

### Церемония сундука

Сундук серии прилетает из иконки в ряду серии, оверлей подписан `Tap or hold!`:
**тап** роняет один приз, **зажатие ≥ 500 мс** — сундук раздувается, дрожит и
высыпает всё сразу. Призы разлетаются по счётчикам: звёзды влево-вверх, пазлы
вправо-вверх, 1–3 карточки коллекции — вниз в кнопку «Коллекции» (на время полёта
бар переносится над затемнением). Карточный дроп из сундука **презентационный** —
сохранённый прогресс коллекций он не меняет. Конфетти — общий модуль
[src/fx.ts](src/fx.ts), его же переиспользует церемония апгрейда на острове.

### Оптимистичные награды

Забор дейлика и сбор подарка на острове рисуются **в том же тике, что и тап**;
запрос идёт параллельно, ответ сервера — reconcile, а не триггер: успех — молча
принять серверный баланс, определённый отказ — откатить локальную дельту и
показать одну честную строку, потерянный ответ — оставить оптимистичное состояние
и повторить идемпотентный запрос (`1.5s / 4s / 9s`). Дейлик идемпотентен по
`quest_id`, островной сбор — по сохранённому claim-id.
Защищено `npm run check:optimistic-rewards-browser`.

### Живые уведомления «кто-то сыграл в моё»

Лёгкий фоновый поллинг `GET /api/island/activity` раз в **75 с** (только на
foreground) плюс по одной дочитке при возврате из паузы и на экране победы в
серии. Тост показывается **не чаще одного в минуту**, всё попавшее в окно
склеивается в одну строку, люди и боты в тексте различимы. Тост не садится поверх
запущенной вручную механики или открытого сундука — придержанное доезжает позже.
Курсор (`localStorage['island-activity-cursor-v1:<userId>']`) хранит
**показанное**, поэтому история не реиграется. Тост тапабельный — уводит на свой
остров. Защищено `npm run check:island-activity-browser`.

## Как устроена лента (ключевые механизмы)

- **Один живой юнит.** Текущая механика играет; следующая заранее греется
  СКРЫТО (idle-warm) и приезжает без лоадера. Соседи стоят на host-pause.
- **Staged-boot контракт** с плейблом: `static_ready` → хост шлёт
  `prepareInteractive` (тяжёлые декоды/GL внутри warm-фрейма) → `interactive_ready`.
  Прогрев не стартует под пальцем игрока (same-origin проба тачей в iframe) и
  ждёт «спокойных кадров» текущей механики. Стратегия — `?warm=` (см. таблицу).
- **Автоплей + перехват.** Приехавшая механика крутит демо под вуалью
  (`game__autoplay`, слот в scale 0.92); тап — перехват в ручную игру; свайпы
  ленты живут на вуали и жёлобах, тачи ручной игры — внутри iframe.
- **Постеры/обложки.** Едущая страница показывает постер из host-документа
  (off-screen iframe не растеризуется), обложки — `dist-swipe/cover.jpg`.
- **Завершение** механика сообщает postMessage-событием (`completed` и др.) —
  лента начисляет награду и рисует win-слой.
- **Активный dwell** считается только по реально интерактивному впечатлению:
  фон вычитается, ремаунт не теряет накопленное, скачущие часы не отнимают
  время (`npm run check:dwell`).

## Мета-эксперименты (два, параллельно)

Вкладка «Мета» ведёт в **остров**, а с `?metaworld` — в отдельный прототип
**Creator District** (`openMetaWorld` в feed.ts). Не смешивать: у острова всё
неймспейсится `island_*` / `isl-*`.

**Остров** — генеративные UGC-механики плюс соцядро (визиты, друзья, лайки,
подарки, боты, модерация, закрытая доставка артефактов, церемония роста домиков).
Полное описание, карта потоков, флаги, дебаг и TODO — **[ISLAND.md](./ISLAND.md)**.

## Файлы

| Файл | Роль |
|---|---|
| `src/main.ts` | Точка входа: TMA-инициализация, deep-link (челлендж / остров / friend-код), Catalog Lab, сборка `Feed`. |
| `src/feed.ts` | Ядро: пейджер, warm-пайплайн, автоплей/перехват, серии, награды, сундук, HUD, бар, коллекции, дейлики, друзья, тосты. |
| `src/playables.ts` | Ростер механик + резолв URL/уровней/обложек. |
| `src/series-policy.mjs`, `src/rewards.mjs` | Длина серии и её `?level=`; детерминированные награды. |
| `src/collections.ts`, `src/fx.ts` | Карточки коллекций; общий конфетти-бурст церемоний. |
| `src/island.ts`, `src/island-state.ts`, `src/island-celebrations.ts` | Мета «остров»: карта, генерация, стейт, watermark церемонии апгрейда. |
| `src/island-moderation-console.ts` | Операторская консоль модерации UGC (открывается из дебаг-панели). |
| `src/api.ts` | Клиент бэкенда (`Authorization: tma <initData>`, абсолютный URL + CORS). |
| `src/control-plane.ts`, `src/outbox.ts` | Durable-очереди событий control-plane и результатов. |
| `src/catalog-*.mjs`, `src/lab-auth.ts` | Каталожный путь: authority, player v2, превью, навигация и авторизация Lab. |
| `src/debug.ts`, `src/feed-sequencing-debug.mjs` | Дебаг-панель + read-only подэкран feed-sequencing (§12). |
| `src/telegram.ts` | TMA-интеграция: fullscreen, insets → `--safe-*`, disableVerticalSwipes, шэр. |
| `src/telemetry.ts` | Очередь событий → `/events` (fetch + sendBeacon). |
| `vite.config.ts` | Dev-сервер: раздаёт `dist-swipe` механик, `/versions.json`, `/ugc/*`, island-API (генерация в dev), супервизия локального генератора. |

## Дебаг

Дебаг-панель открывается `?diag=1`, `t.me/<bot>?startapp=diag` или постоянной
кнопкой 🐞 в углу бара (оператор по серверной capability, а также dev-сборка).
Монтирование идемпотентно — второй тап при открытой панели не плодит вторую:
initData/auth, статус `/session`, живой лог событий, сброс своего
состояния и дейликов, флаш очереди результатов, сид тестового челленджа,
🏝️ консоль модерации острова.

**Feed sequencing (§12)** — подэкран той же панели (кнопка `⌘ Feed sequencing`,
последняя из функциональных). Четыре read-only вкладки: `Profile`, `Why now`,
`History`, `Reset`. Клиент только GET-ит три `/api/feed/sequencing/debug/*`;
ответ обязан объявлять `readOnly:true` и `recomputed:false`, иначе fail-closed;
байты замораживаются и показываются как есть, рядом всегда доступен сырой ответ.
Сброс персонализации — операторский CLI, панель его не вызывает; `404` одинаков и
при выключенном флаге, и при неаллоулистнутом аккаунте. Защищено
`npm run check:feed-sequencing-debug` и `…-browser`.

Прочее: `?warm=1` + `window.__feedWarm()` — снимок пайплайна прогрева;
`?perf=1` — оверлей таймингов и длинных тасков; `window.__feedRefreshRail()` —
перечитать рейл челленджей.

## Флаги сборки (`VITE_*`)

Все булевы гейты — **default OFF** (принимают `true` / `1`).

| Флаг | Смысл |
|---|---|
| `VITE_API_BASE` | Origin бэкенда (иначе прод-URL по умолчанию). |
| `VITE_ISLAND_ENABLED` | Весь островной/социальный контур: вкладка «Мета», ряд друзей, поллинг активности и даже deep-link'и `i_<owner>` / `?island=` / `f_<code>`. |
| `VITE_ISLAND_VISIT_AWARDS_ENABLED` | Visit-card после сундука (И-с `VITE_ISLAND_ENABLED`). |
| `VITE_ISLAND_NOTIFICATIONS_ENABLED` | Запрос write-access и исходящие Telegram-уведомления (И-с `VITE_ISLAND_ENABLED`). |
| `VITE_CONTROL_PLANE_ENABLED` | Durable-outbox control-plane (плюс требует initData). |
| `VITE_CATALOG_PLAYER_V2_ENABLED` | Каталожный player v2. |
| `VITE_FEED_EFFECTFUL_AUTHORITY_ENABLED` | Effectful-authority путь ленты (И-с player v2). |
| `VITE_CATALOG_CANARY_DOGFOOD_ENABLED` | Canary-приглашения каталога. |
| `VITE_CATALOG_DOGFOOD_USER_ID` | Ровно один точный Telegram-id, которому доступен dogfood (fail-closed). |
| `VITE_LOCAL_GENERATOR_URL` | Endpoint локального генератора (по умолчанию `http://127.0.0.1:4317`). |
| `VITE_OUTBOX_REQUIRED_REQUEST_TIMEOUT_MS` | Таймаут обязательных POST'ов (валидный диапазон 100–60000, иначе 12000). |
| `VITE_API_DEV_DELAY_MS` | Искусственная задержка всех вызовов API, только dev-сборка. |

## Query-параметры

| Параметр | Эффект |
|---|---|
| `?base=<url>` | Откуда брать HTML/payload/обложки механик (по умолчанию `./`) — так лента с localhost играет задеплоенные сборки. |
| `?initData=<raw>` | Dev-подстановка Telegram initData (бэкенд из обычного браузера). |
| `?diag=1` | Дебаг-панель (то же — `start_param=diag`). |
| `?c=<id>` | Челлендж-deep-link из инбокс-карточки (эквивалент `start_param`=UUID). |
| `?island=<ownerId>` | Прямой вход на остров (игнорируется без `VITE_ISLAND_ENABLED`). |
| `?metaworld` | Вкладка «Мета» ведёт в Creator District и остаётся видимой при выключенном острове. |
| `?labAuth=1` | Экран одобрения устройства Catalog Lab вместо ленты. |
| `?warm=adaptive\|idle\|1\|intent\|off` | Стратегия прогрева (по умолчанию `adaptive`); `?warm=1` дополнительно льёт лог прогрева в консоль. |
| `?perf=1` | Оверлей перф-таймингов и длинных тасков. |
| `?takeover=continue` | Перехват автоплея продолжает прогон, а не рестартит (по умолчанию рестарт). |
| `?livein=1` | Эксперимент «живой iframe едет в кадре» (по умолчанию выключен, помечен как flaky). |
| `?holdcover=1` | Обложка держится до первого тапа — для сверки кадра обложки с живым стартом. |
| `?prefetch=off` | Выключить байтовый префетч. |
| `?apidelay=<ms>` | Dev-задержка API (≤ 30000). |

Telegram `start_param` дополнительно понимает: `diag`, голый UUID (челлендж),
`i_<userId>` (остров), `f_<code>` (инвайт в друзья).

## Запуск и проверки

```bash
cd feed-prototype
npm install
npm run dev     # vite; в dev сам сервит механики из ../playables/*/dist-swipe
npm run build   # tsc + vite build → dist/index.html (single file)
npm run lint    # tsc --noEmit + все check-скрипты ниже
```

`npm run lint` — это и есть перечень защищённого поведения; каждый скрипт
запускается отдельно (`node scripts/<file>.mjs`):

| Скрипт | Что защищает |
|---|---|
| `check:telegram-start-param` | Разбор `start_param` из search и hash. |
| `check:rewards` / `check:series` | Детерминированные награды и длина серии / резолв `?level=` (голден-векторы синхронны с бэкендом). |
| `check:dwell` | Активный dwell: фон, ремаунт, скачущие часы. |
| `check:cp-outbox` / `check:run-ticket-outbox` / `check:result-receipts` | Durable-очереди: persist-before-ack, ретраи, восстановление после reload. |
| `check:feed-roster` (+`-browser`) | Ростер-конфиг из `/session`, неизменность живого кольца, форсированный слот челленджа. |
| `check:catalog-player-v2` / `check:catalog-feed-authority` / `check:catalog-generated-preview` / `check:catalog-authority-timing-browser` | Каталожный путь: тикет/спека, эпохи и дедлайны authority, BFCache, generated-превью. |
| `check:catalog-lab-navigation` / `check:catalog-lab-entry-browser` | Вход в Catalog Lab раскрывается только точной серверной capability. |
| `check:operator-debug-entry` (+`-browser`) | Постоянная кнопка 🐞: та же серверная capability, ноль DOM-следов у не-оператора, идемпотентная панель, нетронутый `?diag`. |
| `check:catalog-feed-dogfood` (+`-browser`) | Полный effectful/canary-сценарий поверх реального `Feed` (см. ниже). |
| `check:operator-level-flags` (+`-browser`, +`-feed-browser`) | Операторские флаги уровня: форма, сохранение, неблокирующая навигация ленты. |
| `check:feed-sequencing-debug` (+`-browser`) | Read-only контракт §12-панели: только GET, fail-closed конверт, никаких пересчётов. |
| `check:optimistic-rewards-browser` | Оптимистичный дейлик и островной сбор: старт в тике тапа, reconcile, откат, идемпотентный ретрай. |
| `check:island-upgrade-ceremony-browser` | Церемония апгрейда домика, её watermark, лесенка `stageScale` и гостевой хром. |
| `check:island-p2-browser` / `check:island-p5-browser` / `check:island-activity-browser` / `check:island-moderation-pagination` | Visit-card и safety-UI, закрытая доставка артефактов, уведомления «кто-то сыграл», пагинация консоли модерации. |

Не входят в `lint` (нужен настоящий backend + PostgreSQL, детали — в
[ISLAND.md](./ISLAND.md)): `scripts/check-island-social-browser.mjs`,
`check-island-social-r2-binding-flagoff.mjs`,
`check-island-social-r3-accept-attempts.mjs`. Отдельно живёт и
`npm run check:cp-browser`.

## Каталожный dogfood и real-E2E

Effectful catalog path можно прогнать без живого backend/runtime:

```bash
npm run serve:catalog-feed-dogfood
```

Команда делает две production-сборки (canary включён/выключен) и печатает URL
шести сценариев: fresh invitation, hard recall, двухвкладочная allocation-гонка с
конфликтом уже принятого impression, точный no-invitation fallback, другой аккаунт
и выключенный canary. На странице поверх реального `Feed` есть воспроизводимый
trace и итоговый `PASS/FAIL`; проверяются poster-only без iframe до authority,
opaque allocation, exact ticket/spec/impression/result/chest и возврат к
проверенной встроенной механике без награды при terminal conflict/recall.
Продуктовые флаги по умолчанию выключены; `npm run lint` автоматически проверяет
wire/изоляцию всех URL.

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

Durable fixture-аудит exact трёхуровневого content
`2c0efd621a0acddeadc395b1f285bc9242043481a60264b001b70faf10601ccc` — алиас того
же browser-чека:

```bash
npm run check:catalog-three-level-audit
```

Он собирает content-addressed receipt по production-сборке клиента: exact
`series.manifest.v2 → run.ticket.v3 → ticket-level-spec-bundle.v2 →
catalog_level_impression_v2 → catalog.result.v2`, включая один и тот же
`skinHash + skinContractDigest` до configured-impression и exact ticket-bound
digest вместе с `applied_skin_hash` на result-v2 (его wire-схема намеренно не
дублирует contract digest), ordinal 1→3, три различных level `run_id` и ровно
один root-run chest. Отдельными browser-сценариями проверяются zero-progress
reload, результат до задержанного CP ACK и cross-origin spoof. Receipt намеренно
имеет `productionBackend:false`: fixture не заменяет настоящий backend/runtime.

Полный аудит с настоящими backend и content-addressed runtime запускается
отдельно:

```bash
VITE_API_BASE=https://backend.example \
VITE_CATALOG_DOGFOOD_USER_ID=<telegram-user-id> \
CATALOG_REAL_E2E_INIT_DATA='<signed Telegram initData>' \
npm run serve:catalog-feed-real-e2e
```

InitData читается только процессом локального E2E-сервера и инжектируется в
отдаваемую браузеру страницу — в bundle, URL и stdout секрет не записывается.
Harness не подменяет и не проксирует API/runtime: он требует от backend абсолютный
HTTPS locator вида `runtime-releases/<playable>/<artifact-digest>/…`, fresh
opaque canary invitation (normal authority в этом гейте запрещён), exact content
hash, canary allocation и deterministic ticket. `PASS` появляется только после
трёх projected specialized impressions, accepted result receipt для ordinal
1→3, одного accepted chest receipt и видимых chest+reward. В stdout печатается
ограниченный `catalog.three-level-production-operator-observation.v1` без
initData и без полного browser snapshot. Локальный audit-server выдаёт странице
одноразовый nonce, повторно проверяет exact content/skin/runtime closure и
канонически хэширует evidence. Это **не server-authoritative rollout receipt**:
`eligibleForLevelSeriesRollout:false` остаётся жёстким до отдельного backend
evidence-контура. `p95Ms` считается ровно по трём дельтам
`projected configured-impression ACK → accepted ordinal result`, а не по общим
HTTP latency. По умолчанию оператору даётся 180 секунд;
`CATALOG_REAL_E2E_TIMEOUT_MS` можно менять только в fail-closed диапазоне
5–180 секунд.

## Деплой

Из `playables/`: `bash scripts/deploy-swipe.sh [<id>…|--all]` — пересобирает ленту
со свежим стампом (виден в левом нижнем углу бара), экспортирует механики и пушит
`swipe-platform` (Render автодеплой).

## История

Репо начиналось как прототип свайпа (фаза 1 — жесты/жёлоб, фаза 2 — реальные
плейблы «одна живая игра»); обе фазы давно закрыты, описание выше — текущее
состояние платформы.
