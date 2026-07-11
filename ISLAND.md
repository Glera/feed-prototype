# Island — мета-эксперимент «остров» (AI UGC-механики)

Параллельный мета-эксперимент свайп-платформы: игрок **генерирует собственные
варианты механик** по текстовому промпту и выставляет их на своём острове.
Живёт за иконкой-**треугольником** на нижней панели фида. (Вторая, независимая
мета — «Creator District» за ромбом — здесь не описывается; это разные
эксперименты, у каждого свой неймспейс.)

## Концепт: остров-лоскут

Остров — витрина творчества игрока, а не декорация из каталога:

- Каждая созданная механика — **здание**, и оно **красит свой сектор** острова:
  земля, пропсы и палитра берутся из сгенерированной темы. Биом не выбирается —
  он складывается из того, что игрок создал.
- **4 фиксированных слота = кап.** Новая механика на занятом слоте перезатирает
  старую (Rebuild с предупреждением — плеи и лайки сгорают). Слот — дефицит.
- **Гости** играют механики хозяина (повышенная награда) и могут **лайкнуть
  только после победы** — лайк по построению завязан на реальное вовлечение.
- Механика игрока — отдельный артефакт из **нерелизной замороженной базы**.
  Guided-рецепт инъецирует versioned config; локальная лаборатория патчит только
  одноразовый форк закреплённого commit+tree и обязана доказать победу автоплеем.
- Релизный `marble-sort-swipe` — эталон. Build-guard сверяет его с разрешённым
  git tree и блокирует сборку при незапланированном изменении.

## Карта системы (5 репозиториев)

| Репо | Роль | Ключевые файлы |
|---|---|---|
| `feed-prototype` | UI острова и подключение к сервисам | `src/island.ts`, `src/feed.ts`, `src/api.ts`; в dev раздаёт `/ugc/*`, но не запускает agent jobs |
| `swipe-generator` | Отдельная локальная персистентная очередь | `.data/jobs`, Claude/Codex adapters, detached runners; Vite запускает/перезапускает сервис на `127.0.0.1:4317` |
| `swipe-backend` | Продакшн-эндпоинты + bake-runtime | `/api/island/theme`, durable `/api/island/bake` jobs, Node + Playwright runtime; клонирует только `swipe-ugc` |
| `swipe-ugc` | Нерелизные базы, воркеры и hosting артефактов | `bases/sort-v2`, `generator/baselines.json`, `worker/bake.mjs`, `worker/experiment.mjs`, `render.yaml` |
| `playables` | Только first-party SWIPE-механики | `canonical/swipe-locks.json` + `scripts/check-swipe-canonical.mjs` защищают эталонный sort при каждой SWIPE-сборке |

## Поток: создание механики

```
шаблон → промпт → ГЕНЕРАЦИЯ ТЕМЫ → превью (реролл: 1 бесплатный, дальше 30 🧩)
   → Build → BAKE-ON-CONFIRM → hosted URL → бот-пуш игроку
```

### Генерация темы (тема-пак)

Тема-пак v2 содержит островные цвета плюс `sceneBg/boardBg/belt/outline`, seed,
сложность, motion, материал/маркер шариков, формы target/source, путь конвейера
и паттерн фона. Конфиг детерминирован seed и одинаков в preview/fork/bake.

Клиент (`aiTheme` в island.ts) идёт по лесенке фоллбэков — генерация **никогда
не блокирует игру**:

1. **Бэкенд** `POST /api/island/theme` (TMA-auth): Anthropic API
   (`island_theme_model`, по умолчанию `claude-opus-4-8`), pydantic-валидация —
   hex-поля, prop из белого списка и **попарная RGB-дистанция шариков ≥ 90**
   (различимость = геймплейное требование). Невалидный пак → 1 корректирующий
   ретрай с текстом ошибки, второй провал → 422.
2. **Dev-vite** `POST /island-api/theme` (localhost): та же схема; при отсутствии
   `ANTHROPIC_API_KEY` зовёт локальный Claude Code (`claude -p`) — покрывается
   подпиской разработчика (только dev-машина).
3. **Keyword-пресеты** (5 захардкоженных паков) — если оба API недоступны;
   в превью честная метка `preset theme (AI offline)`.

Асинхронный UX: из шита генерации можно уйти («Keep browsing») — слот
показывает стройку 🏗️, по готовности механика строится сама + тост. Гонки
двойной генерации на слот отсекает `generationBySlot`.

### Bake-on-confirm (публикация)

Печём только по подтверждению постройки (превью/рероллы артефактов не
порождают). `POST /api/island/bake` создаёт durable job и сразу возвращает 202;
клиент поллит job, а runner запускает `worker/bake.mjs`. `--user` и `--chat` =
`caller.id` из TMA — клиент не может назваться чужим:

1. **bake** — сверяет SHA-256 нерелизной базы `swipe-ugc/bases/sort-v2` и
   инъецирует versioned visual/gameplay config,
   пишет `u/<user>/<slug>-<hash8>.*` (hash содержимого = иммутабельность,
   кэш навсегда, «новая версия» = новый файл);
2. **тест** — headless chromium (playwright), всегда полная победа автоплеем;
   провал → ничего не коммитится, артефакты удаляются;
3. **publish** — `git commit` + `push` в swipe-ugc (Render автодеплоит ~1 мин);
4. **notify** — `sendMessage` игроку от бота («сгенерирована, протестирована,
   опубликована» + ссылка);
5. бэкенд ждёт доступности URL (до `island_deploy_wait_sec`=90 с), сохраняет
   `ready/published`, а клиент восстанавливает поллинг после перезагрузки.

URL выдаётся игроку **строго после push** — любая аварийная ветка оставляет
здание на эталонной механике, битых ссылок не бывает. Bake-runtime на Render
готовится фоном при старте API: клонирует только `swipe-ugc`, ставит его
зависимости и валидирует замороженную базу. Доступа к `playables` у runtime нет;
статус — `bake_runtime` в `/health`.

### Играние (лесенка приоритетов)

`playSeries` выбирает источник: **HOSTED** (артефакт из swipe-ugc; прошёл
автоплей-гейт, watchdog не нужен) → **LOCAL LAB** (только dev, игнорируемый
артефакт эксперимента) → **STOCK** (неизменённый first-party билд платформы).
Клиентского патча или инъекции в эталон больше нет. Победа ловится по `postMessage
{source:'playable', type:'completed', success}` — тем же сигналом, что у фида.

## Локальная лаборатория свободных экспериментов

В dev рядом с guided-режимом есть `Free experiment`. Платформа отправляет job в
отдельный `swipe-generator`; provider выбирается как Auto, Claude или Codex.
Очередь атомарно хранится в `.data/jobs`, runner отделён от HTTP-процесса:
перезагрузка страницы/Vite не прерывает генерацию, после возврата UI находит job
по стабильному client id и продолжает поллинг. После рестарта самого сервиса
живой PID подхватывается, а оборванная задача возвращается в очередь.

Сначала локальная подписка выдаёт три непохожие концепции. Выбранная концепция
запускает `worker/experiment.mjs`: exact commit+tree из
`generator/baselines.json` → disposable clone со своими refs → агент меняет только
`marble-sort-swipe/src/*.ts` → static sandbox → build → полный autoplay WIN.
Ни branch, ни `playables/HEAD` не читаются; в `playables` ничего не коммитится и
не пушится. Ошибка возвращается агенту, максимум три попытки. Успех сохраняется
только в игнорируемых `u/local-experiments/` и `.local-experiments/`; можно дать
feedback и получить дочерний lineage-патч. Provider API env удаляются, поэтому
CLI используют только локальные subscription login. Размещённое здание хранится
отдельным local overlay и не попадает в backend snapshot острова.

Явный `Publish tested artifact` повторяет sandbox autoplay, создаёт отдельный
worktree `swipe-ugc` от `origin`, коммитит по allowlist только автономный HTML и
его public meta, пушит и ждёт URL Render. Source patch остаётся локальным;
`playables` в publish-коммит попасть не может. После push overlay заменяется в
острове на абсолютный hosted URL и только тогда синхронизируется с backend.

## Рецепт: источники истины

| Что | Где живёт | Копии |
|---|---|---|
| Recipe enums/prompt/adherence | `swipe-ugc/recipes/sort/` | backend читает канон |
| Guided generator build | `swipe-ugc/bases/sort-v2` + manifest hashes | только worker; `releasePlayable:false` |
| Free generator source | `swipe-ugc/generator/baselines.json` | exact commit+tree, не branch/HEAD |
| Эталонный SWIPE sort | `playables` approved tree lock | используется платформой, не генераторами |
| Persistent jobs | `swipe-generator/.data/jobs` | UI только создаёт, поллит и переподключается |

## Дебаг

- Чип в шапке экрана игры: `HOSTED · <тема>` / `FORK · <тема>` / `STOCK ·
  <причина>`; тап — полный лог запуска (fetch, форма артефакта, замены палитры,
  watchdog, сообщения фрейма, исход).
- Консоль браузера: префикс `[island]`; терминал dev-сервера: `[bake]`,
  `[ugc-worker]`; бэкенд: `/health` → `bake_runtime.state`.

## Стейт

Обычный остров authoritative в `swipe-backend` и синхронизируется по revision;
`localStorage["island-proto-v1[:telegram-user-id]"]` — только scoped cache для
мгновенной отрисовки/offline merge. Лабораторные здания и их паки лежат отдельно
в `island-local-experiments-v1[:telegram-user-id]`, локально перекрывают слот и
никогда не участвуют в server read/write.

## Конфиг

| Где | Переменная | Смысл |
|---|---|---|
| клиент | `VITE_API_BASE` | база swipe-backend (иначе прод-URL по умолчанию) |
| vite dev | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | API-путь генерации; без них — `claude -p` под подпиской |
| клиент dev | `VITE_LOCAL_GENERATOR_URL`, `SWIPE_GENERATOR_AUTOSTART=0` | endpoint генератора; опционально отключить запуск вместе с Vite |
| backend | `ISLAND_THEME_MODEL` | модель генерации (default `claude-opus-4-8`) |
| backend | `UGC_REPO_PATH`, `UGC_BASE_URL`, `BOT_TOKEN` | worker repo, публичная база, бот |
| backend | `ISLAND_BAKE_TIMEOUT_SEC` (300), `ISLAND_DEPLOY_WAIT_SEC` (90), `ISLAND_DEPLOY_POLL_SEC` (3) | таймауты bake/деплой-ожидания |
| local generator | `SWIPE_GENERATOR_PORT`, `SWIPE_GENERATOR_CONCURRENCY`, `SWIPE_GENERATOR_DATA` | порт, параллелизм, durable storage |
| worker | `PLAYABLES_ROOT` (только free lab), `UGC_NO_PUSH`, `BOT_TOKEN`, `UGC_NOTIFY_CHAT_ID`, `UGC_BASE_URL` | см. README swipe-ugc |

## Хостинг и приватность

Сейчас UGC хостится в **публичном** репо `github.com/Glera/swipe-ugc` +
бесплатный Render static. Для прототипа это ок (статик-хостинг всё равно
публичен, а public-репо даёт запасной CDN через jsDelivr).

**Решение на будущее: сгенерированные механики прятать.** Целевая схема —
закрытый CDN: приватный bucket (S3/R2) + отдача через CDN с непубличными /
подписанными URL, без листинга; репозиторий приватизировать или заменить
объектным хранилищем (воркер меняет только шаг publish). Причины: механики
игроков — контент продукта, не для скрейпинга и разглядывания вне платформы.
Порог, за которым переезд нужен и по нагрузке: сотни генераций в день
(git-as-storage распухает, деплой-очередь Render).

## TODO (оставшиеся швы после разделения 10.07.2026)

1. **Dev-vite theme fallback пометить временным.** Вне Telegram клиент после null от
   бэкенда делает лишний fetch на `/island-api/*` (404-шум на прод-статике).
   Спрятать за dev-флагом или выпилить, когда бэкенд стабилен.
2. `checkout -B` в `start-bake-runtime.sh` при рестарте молча отбрасывает
   незапушенный коммит (безопасно — URL не выдан, но артефакт исчезает);
   логировать факт отбрасывания.
3. **Закрытый CDN для UGC** — см. «Хостинг и приватность» выше.
4. **Диплинк `startapp=island`** в main.ts + `requestWriteAccess()` при первой
   генерации (право бота писать игроку).
5. Относительный hosted-URL из dev (`ugc/...`) не переключается на
   `UGC_BASE_URL` задним числом — мигрировать или хранить `rel` вместо URL.
6. **Level-series jobs.** Очередь и provider adapters уже общие, но отдельные
   baseline/schema/gate для генерации уровней pins/merge ещё не заведены.
7. **Рецепты для merge/pins** — арт в атласах, не в константах; это шаг к
    настоящим арт-пакам (image-gen: фон + спрайт-лист).
8. Себестоимость генерации: `island_theme_model` конфигурируем — замерить
    haiku на качество палитр для экономии.
