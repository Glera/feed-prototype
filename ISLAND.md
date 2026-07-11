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
  одноразовый форк закреплённого commit+tree. Локально достаточно исправной
  сборки/runtime; публикация по-прежнему требует доказанную победу автоплеем.
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
слот → Sorting → пакет генерации
  FREE: safe (1 кандидат, без модели)
  LOW COST: safe + guided API (2 кандидата)
  HIGH COST / LOCAL LAB: safe + guided API + wild subscription job (3 кандидата)
→ сыграть каждого кандидата → Keep → при необходимости уточнить комментарием
→ Build/Publish выбранного → hosted URL → бот-пуш игроку
```

До `Keep` и `Build` кандидаты ничего не коммитят и не меняют остров. Safe/guided
запускаются через `swipe-ugc/preview/sort-v2.html` поверх hash-locked
generator-base; wild играет свой автономный локальный HTML. У карточек разные
кнопки `Play` и `Keep`, поэтому выбор можно сделать после реального геймплея.

### Три режима

**Safe / FREE.** Чистая параметризация на клиенте: ближайший preset или random,
seed, сложность, motion/physics, материал и маркеры шариков, формы target/source,
геометрия конвейера, фон. Ни backend, ни Claude/Codex не вызываются. Повторная
настройка остаётся бесплатной и также не вызывает модель.

**Guided / LOW COST.** Только `POST /api/island/theme` на backend: ограниченная
схема v2, explicit prompt/preferences, pydantic/recipe validation, adherence для
`dark/black/...`, различимость цветов и один корректирующий retry. Локальный
subscription fallback из клиента удалён: это именно API-режим, доступный в TMA.
Комментарий `Ask AI to revise` создаёт новый валидированный guided pack, не
патчит исходную механику.

**Wild / HIGH COST.** Только dev/local subscription runner. Claude или Codex
может изменить правила, interaction, physics, pacing, layout и rendering в
disposable fork. Результат без доказанной победы разрешено играть/докручивать и
ставить только как local overlay; гостям он скрыт. `Tune` создаёт дочерний
lineage job с комментарием игрока. Publish повторяет строгий WIN-гейт.

Safe доступен сразу, guided обычно занимает секунды, wild является фоновой
«мастерской» с общим бюджетом до 24 часов. Detached runner переживает reload и
рестарт Vite. Слот меняет подпись `queued → concepts → coding → checking →
playtesting → finalizing`; тап открывает 9 стадий, elapsed/ETA, repair attempt,
PID heartbeat и последние реальные worker logs. Молчание модели помечается, но
не убивает живой PID: UI различает `agent alive`, `quiet but alive`, `runner`,
`recovering` и terminal failure; исчезнувший runner переочередяется. При `BOT_TOKEN` плюс
TMA chat id/`UGC_NOTIFY_CHAT_ID` готовность или финальная ошибка приходят в
Telegram. Гарантируется terminal outcome job, а не успешная/проходимая wild-механика.

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

В dev пакет `Creative trio` добавляет к safe/guided кандидату `Code experiment`.
Платформа отправляет job в отдельный `swipe-generator`; provider выбирается как
Auto, Claude или Codex.
Очередь атомарно хранится в `.data/jobs`, runner отделён от HTTP-процесса:
перезагрузка страницы/Vite не прерывает генерацию, после возврата UI находит job
по стабильному client id и продолжает поллинг. После рестарта самого сервиса
живой PID подхватывается, а оборванная задача возвращается в очередь.

Сначала локальная подписка выдаёт три непохожие концепции; пакет автоматически
берёт high-risk (или первый доступный) вариант. `worker/experiment.mjs`: exact commit+tree из
`generator/baselines.json` → disposable clone со своими refs → агент меняет только
`marble-sort-swipe/src/*.ts` → allowlist/capability scan → `tsc` только по новым
диагностическим ошибкам изменённых файлов → build → hardened self-contained HTML.
Ни branch, ни `playables/HEAD` не читаются; в `playables` ничего не коммитится и
не пушится.

Browser gate проверяет `static_ready → prepareInteractive → interactive_ready`,
реальную остановку canvas при host pause, synthetic manual tap, 30 секунд idle
без ошибок, CSP/network isolation, fixed-seed autoplay, валидный completed event,
minimum win time, визуальное изменение canvas и живой rAF. Первый inconclusive
autoplay повторяется на той же сборке без нового model call. Hard build/runtime/
security failure возвращается агенту (до трёх repair pass). Если runtime исправен,
но autoplay не доказал win, кандидат сохраняется локально с `autoplayPassed:false`.

Артефакт получает CSP `default-src 'none'`/`connect-src 'none'`; Playwright
дополнительно abort-ит и логирует любой non-local request. Regex scanner остаётся
ранним дешёвым сигналом, но больше не является security boundary. Provider API
env удаляются, поэтому CLI используют только subscription login. Manifest пишет
wall time, agent/playtest attempts, model, effort, fixed seed и conformance metrics.
Размещённое здание хранится local overlay и не попадает в backend snapshot.

Явный `Publish tested artifact` доступен только после локального WIN и повторяет
sandbox autoplay, создаёт отдельный
worktree `swipe-ugc` от `origin`, коммитит по allowlist только автономный HTML и
его public meta, пушит и ждёт URL Render. Source patch остаётся локальным;
`playables` в publish-коммит попасть не может. После push overlay заменяется в
острове на абсолютный hosted URL и только тогда синхронизируется с backend.

## Матрица гейтов

| Режим | До показа кандидата | Перед Build/Publish |
|---|---|---|
| Safe | recipe/schema unit tests, hash-locked preview boot | полный bake autoplay WIN |
| Guided | backend schema + prompt adherence + preview boot | полный bake autoplay WIN |
| Wild local | path/capability scan, new-error `tsc`, build, CSP/network + lifecycle/manual/idle conformance; autoplay WIN мягкий | повторный sandbox autoplay WIN жёсткий |

Локальная команда `npm run verify` в `swipe-ugc` запускает syntax lint, unit
tests рецепта/hardening, hash generator-base и Chromium preview autoplay.

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
| клиент dev | `VITE_LOCAL_GENERATOR_URL`, `SWIPE_GENERATOR_AUTOSTART=0` | endpoint генератора; опционально отключить запуск вместе с Vite |
| backend | `ISLAND_THEME_MODEL` | модель генерации (default `claude-opus-4-8`) |
| backend | `UGC_REPO_PATH`, `UGC_BASE_URL`, `BOT_TOKEN` | worker repo, публичная база, бот |
| backend | `ISLAND_BAKE_TIMEOUT_SEC` (300), `ISLAND_DEPLOY_WAIT_SEC` (90), `ISLAND_DEPLOY_POLL_SEC` (3) | таймауты bake/деплой-ожидания |
| local generator | `SWIPE_GENERATOR_PORT`, `SWIPE_GENERATOR_CONCURRENCY`, `SWIPE_GENERATOR_DATA`, `SWIPE_GENERATOR_CONCEPT_TIMEOUT_SEC` (86400) | порт, параллелизм, durable storage и deadline concept-agent |
| local generator | `SWIPE_GENERATOR_DAILY_PACKAGE_LIMIT` (12), `SWIPE_GENERATOR_DAILY_EXPERIMENT_LIMIT` (24) | дневные локальные лимиты на client id |
| worker | `UGC_EXPERIMENT_TOTAL_TIMEOUT_SEC` (86400), `UGC_EXPERIMENT_AGENT_TIMEOUT_SEC` (86400) | общий deadline и максимум одного subscription pass |
| worker | `UGC_EXPERIMENT_AGENT_SILENCE_WARN_SEC` (7200), `UGC_EXPERIMENT_HEARTBEAT_SEC` (300) | только диагностика молчания; живой PID не убивается |
| worker | `PLAYABLES_ROOT`, `BOT_TOKEN`, `UGC_NOTIFY_CHAT_ID`, `UGC_BASE_URL` | local baseline, уведомления и hosting |

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

## TODO

1. **Экономика package order.** Реального списания пока нет: FREE/LOW/HIGH —
   продуктовые категории. При подключении billing списывать на order и делать
   auto-refund/downgrade за недоставленный guided/wild кандидат.
2. **Baseline bump tool.** Новый immutable baseline + прогон сохранённых lineage
   patches через текущий gate с отчётом совместимости.
3. **TTL local lab.** Чистить старые `.local-experiments`/`u/local-experiments`,
   сохраняя ancestors живых lineage.
4. `checkout -B` в `start-bake-runtime.sh` при рестарте молча отбрасывает
   незапушенный коммит (безопасно — URL не выдан, но артефакт исчезает);
   логировать факт отбрасывания.
5. **Закрытый CDN для UGC** — см. «Хостинг и приватность» выше.
6. **Диплинк `startapp=island`** в main.ts + `requestWriteAccess()` при первой
   генерации (право бота писать игроку).
7. Относительный hosted-URL из dev (`ugc/...`) не переключается на
   `UGC_BASE_URL` задним числом — мигрировать или хранить `rel` вместо URL.
8. **Level-series jobs.** Очередь и provider adapters уже общие, но отдельные
   baseline/schema/gate для генерации уровней pins/merge ещё не заведены.
9. **Рецепты для merge/pins** — арт в атласах, не в константах; это шаг к
    настоящим арт-пакам (image-gen: фон + спрайт-лист).
10. **Разница Safe/Guided.** Следующий слой — externalized image-gen art packs,
    иначе средний tier всё ещё в основном продаёт палитру + enum-комбинацию.
11. После стабилизации распилить `island.ts` на map/create/experiment/api.
