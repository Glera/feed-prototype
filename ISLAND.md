# Island — мета-эксперимент «остров» (AI UGC-механики + соцядро)

Параллельный мета-эксперимент свайп-платформы: игрок **генерирует собственные
варианты механик** по текстовому промпту, выставляет их на своём острове, ходит в
гости к друзьям и ботам, а его домики растут от чужих плеев. Живёт за вкладкой
**«Мета»** на нижней панели фида. (Вторая, независимая мета — «Creator District»
за `?metaworld` — здесь не описывается; это разные эксперименты, у каждого свой
неймспейс.)

Весь контур **по умолчанию выключен**: без `VITE_ISLAND_ENABLED` нет ни вкладки,
ни ряда друзей, ни поллинга активности, и даже deep-link'и `i_<owner>` /
`?island=<id>` / `f_<code>` молча игнорируются в `main.ts`.

## Концепт: остров-лоскут

Остров — витрина творчества игрока, а не декорация из каталога:

- Каждая созданная механика — **здание**, и оно **красит свой сектор** острова:
  земля, пропсы и палитра берутся из сгенерированной темы. Биом не выбирается —
  он складывается из того, что игрок создал.
- **4 фиксированных слота = кап.** Новая механика на занятом слоте перезатирает
  старую (Rebuild с предупреждением — плеи и лайки сгорают). Слот — дефицит.
- **Гости** играют механики хозяина (повышенная награда) и могут **лайкнуть
  только после победы** — лайк по построению завязан на реальное вовлечение.
- **Домик растёт** вместе со своей серверной стадией (`stage = min(чужие
  завершения, 10)`) — см. «Церемония апгрейда».
- Механика игрока — отдельный артефакт из **нерелизной замороженной базы**.
  Guided-рецепт инъецирует versioned config; локальная лаборатория патчит только
  одноразовый форк закреплённого commit+tree. Локально достаточно исправной
  сборки/runtime; публикация по-прежнему требует доказанную победу автоплеем.
- Релизный `marble-sort-swipe` — эталон. Build-guard сверяет его с разрешённым
  git tree и блокирует сборку при незапланированном изменении.

## Карта системы (5 репозиториев)

| Репо | Роль | Ключевые файлы |
|---|---|---|
| `feed-prototype` | UI острова и подключение к сервисам | `src/island.ts`, `src/island-state.ts`, `src/island-celebrations.ts`, `src/island-moderation-console.ts`, `src/feed.ts`, `src/api.ts`; в dev раздаёт `/ugc/*`, но не запускает agent jobs |
| `swipe-generator` | Отдельная локальная персистентная очередь | `.data/jobs`, Claude/Codex adapters, detached runners; Vite запускает/перезапускает сервис на `127.0.0.1:4317` |
| `swipe-backend` | Продакшн-эндпоинты + bake-runtime | `/api/island/theme`, durable `/api/island/bake` jobs, Node + Playwright runtime; клонирует только `swipe-ugc` |
| `swipe-ugc` | Приватные нерелизные базы и воркеры; артефакты публикуются в private R2 | `bases/sort-v2`, `generator/baselines.json`, `worker/bake.mjs`, `worker/experiment.mjs` |
| `playables` | Только first-party SWIPE-механики | `canonical/swipe-locks.json` + `scripts/check-swipe-canonical.mjs` защищают эталонный sort при каждой SWIPE-сборке |

## Поток: создание механики

```
слот → Sorting → пакет генерации
  FREE: safe (1 кандидат, без модели)
  LOW COST: safe + guided API (2 кандидата)
  HIGH COST / LOCAL LAB: safe + guided API + wild subscription job (3 кандидата)
→ сыграть каждого кандидата → Keep → при необходимости уточнить комментарием
→ Build/Publish выбранного → hosted артефакт → бот-пуш игроку
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

**Guided / LOW COST.** `POST /api/island/theme` **всегда** создаёт durable job и
отвечает `202 {job_id}`; клиент поллит его (2 с, ≤180 попыток, дедлайн 6 минут,
до 4 прощённых транзиентных ошибок) до validated pack: ограниченная схема v2,
explicit prompt/preferences, pydantic/recipe validation, adherence для
`dark/black/...`, различимость цветов и один корректирующий retry. Model I/O не
выполняется внутри пользовательского HTTP-запроса; двухрежимной ветки
«200 pack | 202 job» в клиенте больше нет. Незавершённый job переживает reload:
его handle лежит в `island-theme-jobs-v1`, а исчезнувший (404) job просто
перезапускается свежим POST. Комментарий `Ask AI to revise` создаёт новый
валидированный guided pack, не патчит исходную механику.

**Wild / HIGH COST.** Только dev/local subscription runner. Claude или Codex
может изменить правила, interaction, physics, pacing, layout и rendering в
disposable fork. Результат без доказанной победы разрешено играть/докручивать и
ставить только как local overlay; гостям он скрыт. `Tune` создаёт дочерний
lineage job с сообщением игрока. Диалог хранит до 24 последних сообщений,
переживает reload и доступен как у кандидата, так и у уже поставленного local-lab
здания; каждое следующее сообщение патчит последнюю дочернюю версию. Publish
повторяет строгий WIN-гейт.

Safe доступен сразу, guided обычно занимает секунды, wild является фоновой
«мастерской» с общим бюджетом до 24 часов. Detached runner переживает reload и
рестарт Vite. Слот меняет подпись `queued → concepts → coding → checking →
playtesting → finalizing`; тап открывает 9 стадий, elapsed/ETA, repair attempt,
PID heartbeat и последние реальные worker logs. Молчание модели помечается, но
не убивает живой PID: UI различает `agent alive`, `quiet but alive`, `runner`,
`recovering` и terminal failure; исчезнувший runner переочередяется. При `BOT_TOKEN`
плюс TMA chat id/`UGC_NOTIFY_CHAT_ID` готовность или финальная ошибка приходят в
Telegram. Гарантируется terminal outcome job, а не успешная/проходимая
wild-механика.

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
3. **publish** — idempotent upload single-file content-addressed HTML в
   private R2 + immutable HeadObject-проверка;
4. **notify** — `sendMessage` игроку от бота («сгенерирована, протестирована,
   опубликована» + deep-link на остров);
5. backend сохраняет только `rel + contentDigest`; клиент восстанавливает
   поллинг после перезагрузки и получает 600-second bearer только через
   authenticated `/island/artifact-url`.

Hosted identity становится доступна **строго после проверочного HEAD** — любая
аварийная ветка оставляет здание на эталонной механике, битых ссылок не бывает.
Bake-runtime на Render готовится фоном при старте API: клонирует приватный
`swipe-ugc` по read-only deploy key, ставит зависимости и валидирует
замороженную базу. Доступа к `playables` у runtime нет; статус —
`bake_runtime` в `/health`.

### Играние (лесенка приоритетов)

`resolveBuildingRuntime` выбирает источник: **HOSTED** (артефакт по закрытой
доставке, см. ниже; прошёл автоплей-гейт, watchdog не нужен) → **LOCAL LAB**
(только dev, игнорируемый артефакт эксперимента) → **BUILTIN** (встроенная
механика платформы по `mechanicId`; неизвестный `mechanicId` фейлится закрыто) →
**STOCK** (неизменённый first-party билд платформы). Неполная hosted-идентичность
даёт `UNAVAILABLE` («Механика недоступна»), а не подмену. Клиентского патча или
инъекции в эталон нет. Победа ловится по `postMessage
{source:'playable', type:'completed', success}` — тем же сигналом, что у фида.

## Соцядро

- **Визиты и лайки.** Гость играет домик хозяина и может лайкнуть только после
  завершённого визита. Люди и боты везде различимы (`is_bot`, отдельный
  `bot_likes`), боты живут в зарезервированном диапазоне id.
- **Друзья.** Ряд друзей и «+»-инвайт живут в HUD фида (не на острове);
  полный список открывается отдельным оверлеем, там же построчные действия
  «в гости» / «удалить» / «блок». Инвайт-код приходит deep-link'ом `f_<code>`;
  незавершённый accept переживает перезапуск (`island-pending-friend-accept-v1`,
  максимум 5 попыток).
- **Подарки** на своём острове собираются оптимистично: пак пропадает и пазлы
  летят в счётчик в тике тапа, серверная сумма молча выигрывает при reconcile;
  claim идемпотентен по сохранённому id (`island-collect-claims-v1`).
- **Жалоба гостя** — `⚑` в шапке экрана игры и кнопка в модалке победы; причины
  `inappropriate` / `broken` / `other`, 429 = «Слишком много жалоб сегодня»,
  повтор в той же сессии подавляется. Недоступна на ботовых домиках.
- Локального симулятора визитов и demo-счётчиков в клиенте нет: карта рисует
  только server-owned факты реальных игроков и зарегистрированных ботов.

### Церемония апгрейда (владельцу)

Сервер поднимает стадию домика в тот момент, когда прилетает завершение гостя;
церемония — это **доставка уже случившегося факта владельцу**, а не отдельная
правда. Watermark `island-celebrated-stages-v1` (`buildingId → показанная
стадия`) — чисто клиентское презентационное состояние.

- Сцена: камера подъезжает к слоту → морф-рост домика → конфетти (общий
  `src/fx.ts`) → табличка «Уровень N → M» + «за плеи гостей», при скачке больше
  чем на 1 добавляется `×K`. Тап в любом месте — перемотка.
- Незнакомый `buildingId` **инициализируется на текущей стадии без церемонии** —
  исторический трафик не даёт конфетти при первом входе.
- Watermark двигается **в конце сцены каждого домика**, поэтому прерванная сцена
  повторится при следующем входе, а один уровень не празднуется дважды.
- Церемония никогда не накрывает открытую карточку здания или запущенный
  плейбл — очередь ждёт (опрос раз в 400 мс).
- Гость церемоний не видит. Определяются они только по серверным снапшотам,
  не по локальному кэшу; исчезнувшее здание вычищается из watermark молча;
  откат стадии на сервере тихо ре-базлайнится.
- **Размер домика** — чистая функция `stageScale(stage) = 1 + 0.28·(1−(1−s)²)`,
  `s = stage/10`, то есть 1.0 → 1.28 с ease-out; она одна и та же для карты
  владельца, карты гостя и морфа церемонии. Домик растёт вверх от основания,
  вместе с ним растёт хитбокс и поднимаются висящие над ним токены подарка/визита.
- Наличие непоказанного роста поднимается в фид (`onPendingUpgrades`) и вместе с
  ожидающими подарками зажигает «!» на вкладке «Мета».

Защищено `npm run check:island-upgrade-ceremony-browser` (сценарии церемонии,
лесенка `stageScale`, гостевой хром).

### Гостевой режим

- Небо перекрашивается, в шапке — аватарка хозяина, его имя, значок `🤖 бот` для
  ботового острова и `✕` вместо `↗`-шэра владельца.
- Аватарка друга **физически перелетает** из ряда друзей в шапку острова, а
  освободившийся слот в ряду (аватар + имя) прячется целиком, сохраняя раскладку;
  при выходе аватарка возвращается. У deep-link-визита источника нет — шапка
  просто заполняется статично.
- Нижний бар остаётся живым и работает как выход: любая кнопка (включая «Мету»,
  которая здесь значит «вернуться к себе») закрывает гостевой остров и уходит в
  свою вкладку.
- CTA серии на гостевом острове нет — гость играет тапом по домику или его
  токену. Гостевые iframes получают `sandbox="allow-scripts allow-same-origin"`.
- Гостевая сцена перечитывает `apiPublicIsland` раз в 10 с; local-lab здания
  гостю не показываются, пока не доказан автоплей-WIN.

### Visit-card (P2)

После **подтверждённого** ticket-bound сундука серии (нужен именно `confirmed`
receipt от `/results`, не сам факт победы) клиент может получить одну visit-card
«Зайди на остров — в домике может ждать +N пазла» с кнопками «Позже» / «Пойти».
Карточка не конкурирует с другим post-chest CTA, а любая ошибка не меняет
chest/feed-флоу. Holdout прячет карточку (тогда показывается обычный
challenge-pill). Гейты: `VITE_ISLAND_VISIT_AWARDS_ENABLED` (клиент) +
`ENABLE_ISLAND_VISIT_AWARDS` (сервер). Защищено `npm run check:island-p2-browser`.

### Уведомления «кто-то сыграл в моё»

Владеет фид (см. README): `GET /api/island/activity` читает только append-only
completion claims, первый read ставит cursor без исторического replay, поллинг —
раз в **75 с** на foreground плюс дочитка при возврате из паузы и на экране
победы серии, тост — **не чаще одного в минуту** со склейкой всего окна в одну
строку. Курсор хранит показанное. Защищено
`npm run check:island-activity-browser`.

Исходящие Telegram-уведомления — отдельный контур:
`requestWriteAccess()` вызывается однократно на осмысленном friend-действии,
результат хранится на backend; без `allows_write_pm=true` outbox не создаётся и
не доставляется. Гейты: `VITE_ISLAND_NOTIFICATIONS_ENABLED` +
`ENABLE_ISLAND_NOTIFICATIONS`.

## Модерация (операторская консоль)

Открывается из дебаг-панели (`?diag=1` / `startapp=diag` / 🐞 в dev) кнопкой
**«🏝️ Island Moderation»**. Клиентского allowlist нет и быть не должно: навигация
— не граница авторизации, серверный `island_moderator_ids` проверяется на каждом
запросе, `403` показывается как «нет прав модератора».

- Действия: **Takedown** (передаёт точный `artifact_rel`; без него отказ),
  **Restore**, резолюция жалоб в `reviewed` / `dismissed` / `escalated`, фильтр
  статуса, «↻ Обновить», внешняя ссылка «↗ превью».
- Разрушающие кнопки — **двойной тап с 3-секундным взводом** (в Telegram WebView
  `confirm()` заблокирован).
- Пагинация keyset-курсорами с накоплением («▾ Показать ещё»): курсор двигается
  только после успешного запроса, поэтому ретрай повторяет ту же страницу, а не
  перепрыгивает её; устаревшие ответы отбрасываются по номеру поколения, мутации
  фехтуются по ключу (`building_id` / `report_id`). Защищено
  `npm run check:island-moderation-pagination`.

## Локальная лаборатория свободных экспериментов

В dev пакет `Creative trio` добавляет к safe/guided кандидату `Code experiment`.
Платформа отправляет job в отдельный `swipe-generator`; provider выбирается как
Auto, Claude или Codex.
Очередь атомарно хранится в `.data/jobs`, runner отделён от HTTP-процесса:
перезагрузка страницы/Vite не прерывает генерацию, после возврата UI находит job
по стабильному client id и продолжает поллинг. После рестарта самого сервиса
живой PID подхватывается, а оборванная задача возвращается в очередь.

Сначала локальная подписка выдаёт три непохожие концепции; пакет автоматически
берёт high-risk (или первый доступный) вариант. `worker/experiment.mjs`: exact
commit+tree из `generator/baselines.json` → disposable clone со своими refs →
агент меняет только `marble-sort-swipe/src/*.ts` → allowlist/capability scan →
`tsc` только по новым диагностическим ошибкам изменённых файлов → build →
hardened self-contained HTML. Ни branch, ни `playables/HEAD` не читаются; в
`playables` ничего не коммитится и не пушится.

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
sandbox autoplay, создаёт отдельный worktree `swipe-ugc` от `origin`, коммитит по
allowlist только автономный HTML и реальный gameplay cover PNG вместе с public
meta, пушит и ждёт оба URL Render. Source patch остаётся локальным; `playables` в
publish-коммит попасть не может. После push overlay заменяется в острове на
абсолютный hosted URL и только тогда синхронизируется с backend.

## Матрица гейтов

| Режим | До показа кандидата | Перед Build/Publish |
|---|---|---|
| Safe | recipe/schema unit tests, hash-locked preview boot | полный bake autoplay WIN |
| Guided | backend schema + prompt adherence + preview boot | network-deny CSP + полный bake autoplay WIN |
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

## Хостинг и приватность (P5)

P5 закрыт 26.07.2026. UGC хранится в private Cloudflare R2 как single-file
content-addressed HTML; публичный Render `swipe-ugc` остановлен, репозиторий
приватный.

Клиент никогда не строит URL артефакта сам: он зовёт
`GET /api/island/artifact-url?building_id=…` и **фейлится закрыто**, если хоть
что-то не сошлось — `building_id`/`rel`/`contentDigest` обязаны совпасть с тем,
что лежит в стейте, схема должна быть `https:`, в query обязана быть
`X-Amz-Signature`, а `expires_at` — валидным и хотя бы на 5 секунд впереди.
Подписанный URL уходит в iframe **дословно**: даже безобидный `?auto=0` после
подписи не дописывается.

В стейте хранится только `rel + contentDigest` (v5), никогда bearer; bearer живёт
в памяти DOM и не попадает ни в localStorage, ни в консоль. Кэш до-P5 с неполной
идентичностью отбрасывается при нормализации стейта (незавершённые bake-джобы при
этом выживают).

Честный residual: уже загруженные в iframe байты нельзя отозвать из памяти.
Block/takedown сразу запрещает новый resolve; уже выданная ссылка живёт не
дольше 600 секунд (TTL — серверный). Device-матрица iOS/Android/macOS прошла
fresh, resume, expiry, re-resolve и revoke. Защищено
`npm run check:island-p5-browser`.

## Дебаг

- Чип в шапке экрана игры: `HOSTED · <тема>` / `LOCAL LAB · <тема>` /
  `BUILTIN · <mechanicId>` / `STOCK · <причина>` / `UNAVAILABLE`; тап — полный
  лог запуска (resolve артефакта, форма идентичности, замены палитры, сообщения
  фрейма, исход).
- Легенда статусов на карте владельца: `hosted` / `local lab` (dev) /
  `publishing` / `error`.
- Консоль браузера: префикс `[island]`; терминал dev-сервера: `[bake]`,
  `[ugc-worker]`; бэкенд: `/health` → `bake_runtime.state`.
  Отдельных `window.__island*` хуков нет.

## Стейт (localStorage)

| Ключ | Что хранит |
|---|---|
| `island-proto-v1[:<userId>]` | Кэш острова для мгновенной отрисовки/offline-merge; authoritative — backend, синхронизация по revision. Неscoped ключ — легаси, копируется в scoped при первом чтении. |
| `island-proto-v1-sync[:<userId>]` | `{revision, base, dirty}` — мета синхронизации. |
| `island-celebrated-stages-v1` | Watermark показанных стадий апгрейда (не scoped по пользователю). |
| `island-theme-jobs-v1` | Хэндлы durable theme-джобов по слотам (переживают reload). |
| `island-collect-claims-v1` | Идемпотентные id сбора подарков. |
| `island-local-experiments-v1[:<userId>]` | Только dev: лабораторные здания и их паки; локально перекрывают слот и никогда не участвуют в server read/write. |
| `swipe-generator-client-v1` | Client id локального генератора. |
| `island-pending-friend-accept-v1` | Незавершённый accept инвайта (`{code, attempts}`, кап 5). |
| `island-write-access-asked-v1:<userId>` / `island-write-access-pending-v1:<userId>` | Однократный запрос write-access. |
| `island-activity-cursor-v1:<userId>` | Курсор показанных уведомлений «кто-то сыграл». |

## Конфиг

Здесь — только смысл переменных и их дефолты в коде. **В каком состоянии гейты
стоят в проде — не тут**: авторитет — `swipe-backend/docs/specs/IMPLEMENTATION-STATUS.md`
и операторские решения в `VISION.md` корня воркспейса.

| Где | Переменная | Смысл |
|---|---|---|
| клиент | `VITE_ISLAND_ENABLED` | Гейт всего контура (вкладка, друзья, поллинг, deep-link'и). Default off. |
| клиент | `VITE_ISLAND_VISIT_AWARDS_ENABLED` | Visit-card после сундука (И-с гейтом выше). Default off. |
| клиент | `VITE_ISLAND_NOTIFICATIONS_ENABLED` | Write-access и исходящие уведомления (И-с гейтом выше). Default off. |
| клиент | `VITE_API_BASE` | база swipe-backend (иначе прод-URL по умолчанию) |
| клиент dev | `VITE_LOCAL_GENERATOR_URL`, `SWIPE_GENERATOR_AUTOSTART=0` | endpoint генератора; опционально отключить запуск вместе с Vite |
| backend | `ENABLE_ISLAND_SOCIAL`, `ENABLE_ISLAND_BOTS`, `ENABLE_ISLAND_VISIT_AWARDS`, `ENABLE_ISLAND_NOTIFICATIONS` | серверные контрпарты клиентских гейтов |
| backend | `ISLAND_THEME_MODEL` | модель генерации (default `claude-opus-4-8`) |
| backend | `UGC_REPO_PATH`, `UGC_BASE_URL`, `BOT_TOKEN` | worker repo, публичная база, бот |
| backend | `ISLAND_BAKE_TIMEOUT_SEC` (300), `ISLAND_DEPLOY_WAIT_SEC` (90), `ISLAND_DEPLOY_POLL_SEC` (3) | таймауты bake/деплой-ожидания |
| local generator | `SWIPE_GENERATOR_PORT`, `SWIPE_GENERATOR_CONCURRENCY`, `SWIPE_GENERATOR_DATA`, `SWIPE_GENERATOR_CONCEPT_TIMEOUT_SEC` (86400) | порт, параллелизм, durable storage и deadline concept-agent |
| local generator | `SWIPE_GENERATOR_DAILY_PACKAGE_LIMIT` (12), `SWIPE_GENERATOR_DAILY_EXPERIMENT_LIMIT` (24) | дневные локальные лимиты на client id |
| worker | `UGC_EXPERIMENT_TOTAL_TIMEOUT_SEC` (86400), `UGC_EXPERIMENT_AGENT_TIMEOUT_SEC` (86400) | общий deadline и максимум одного subscription pass |
| worker | `UGC_EXPERIMENT_AGENT_SILENCE_WARN_SEC` (7200), `UGC_EXPERIMENT_HEARTBEAT_SEC` (300) | только диагностика молчания; живой PID не убивается |
| worker | `PLAYABLES_ROOT`, `BOT_TOKEN`, `UGC_NOTIFY_CHAT_ID`, `UGC_BASE_URL` | local baseline, уведомления и hosting |

## Проверки

Входят в `npm run lint`:

| Скрипт | Что защищает |
|---|---|
| `check:island-upgrade-ceremony-browser` | Сценарии церемонии апгрейда, watermark, лесенка `stageScale`, гостевой хром. |
| `check:island-p2-browser` | Visit-card: ждёт точный chest-receipt, holdout не монтирует карточку, decline/accept. |
| `check:island-p5-browser` | Закрытая доставка: resolve до визита, дословный bearer, bearer не утекает в storage/консоль, несовпадение идентичности не грузит ничего, до-P5 кэш отбрасывается. |
| `check:island-activity-browser` | Уведомления: baseline-первый-read, возобновление с курсора, 75-секундный поллинг, минутная склейка, блокировка поверх механики, люди vs боты. |
| `check:island-moderation-pagination` | Курсор/поколения/фехтование мутаций в консоли модерации. |
| `check:optimistic-rewards-browser` | В том числе островной сбор подарка: бейдж и пазлы в тике тапа, reconcile вниз. |

Требуют настоящий backend + PostgreSQL и **в `lint` не входят** (env:
`BOT_TOKEN`, `API_ORIGIN`, `VENV_PY`, `BACKEND_ROOT`, `DATABASE_URL`; python-хелперы
в `scripts/island-e2e-support/`):

| Скрипт | Что доказывает |
|---|---|
| `scripts/check-island-social-browser.mjs` | P1-D E2E: реальная production-сборка фида против uvicorn + одноразовой PostgreSQL, подписанная initData, проверка фактов в БД после каждого UI-действия. |
| `scripts/check-island-social-r2-binding-flagoff.mjs` | Builtin-binding как авторитет и fail-closed; инертность поверхности при выключенном флаге; ротация байтов деплоя под неизменным binding. |
| `scripts/check-island-social-r3-accept-attempts.mjs` | Кап попыток friend-accept переживает переоткрытия приложения при транзиентном 5xx. |

`npm run verify:island` = `lint` + `vite build` + `check` в `swipe-generator` +
`verify` в `swipe-ugc`.

## TODO

1. **Экономика package order.** Реального списания пока нет: FREE/LOW/HIGH —
   продуктовые категории. При подключении billing списывать на order и делать
   auto-refund/downgrade за недоставленный guided/wild кандидат.
2. **Baseline bump tool.** Новый immutable baseline + прогон сохранённых lineage
   patches через текущий gate с отчётом совместимости.
3. **TTL local lab.** Чистить старые `.local-experiments`/`u/local-experiments`,
   сохраняя ancestors живых lineage.
4. **Renderer-aware conformance.** Canvas screenshot/rAF probes корректны для
   текущего sort baseline; до добавления DOM/WebGL шаблона завести его собственные
   visual/activity probes вместо требования `canvas`.
5. `checkout -B` в `start-bake-runtime.sh` при рестарте молча отбрасывает
   незапушенный коммит (безопасно — URL не выдан, но артефакт исчезает);
   логировать факт отбрасывания.
6. **Level-series jobs.** Очередь и provider adapters уже общие, но отдельные
   baseline/schema/gate для генерации уровней pins/merge ещё не заведены.
7. **Рецепты для merge/pins** — арт в атласах, не в константах; это шаг к
   настоящим арт-пакам (image-gen: фон + спрайт-лист).
8. **Разница Safe/Guided.** Следующий слой — externalized image-gen art packs,
   иначе средний tier всё ещё в основном продаёт палитру + enum-комбинацию.
9. После стабилизации распилить `island.ts` на map/create/experiment/api.
