// Гейт превью «карты помощи».
//
// Две половины, как у check-mission-core.mjs:
//   1. поведение чистого модуля src/helpmap-preview.mjs;
//   2. СТРУКТУРНОЕ доказательство, что без параметра превью не стоит ничего:
//      вкладка не появляется, ./helpmap не импортируется статически, тяжёлые
//      артефакты не попадают в бандл, и ни один чужой модуль о карте не знает.
//
// Запуск:  node scripts/check-helpmap-preview.mjs

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helpMapPreviewRequested } from '../src/helpmap-preview.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const ok = (actual, expected, message) => { n += 1; assert.equal(actual, expected, message); };
const has = (source, needle, message) => { n += 1; assert.ok(source.includes(needle), message); };
const hasnt = (source, needle, message) => { n += 1; assert.ok(!source.includes(needle), message); };
const matches = (source, re, message) => { n += 1; assert.match(source, re, message); };

// ------------------------------------------------------------- 1. поведение

// Решение оператора 01.08.2026: DEFAULT_ON=true — превью включено всем
// (единственный пользователь прод — оператор). Проверяем ИМЕННО дефолт-он;
// при возврате гейта эти три assertion возвращаются к false.
ok(helpMapPreviewRequested(), true, 'DEFAULT_ON: превью открыто без источников');
ok(helpMapPreviewRequested({}), true, 'DEFAULT_ON: пустой объект — открыто');
ok(helpMapPreviewRequested({ search: '', startParam: null }), true, 'DEFAULT_ON: пустые значения — открыто');

ok(helpMapPreviewRequested({ startParam: 'helpmap' }), true, 'startapp=helpmap открывает превью');
ok(helpMapPreviewRequested({ search: '?helpmap=1' }), true, '?helpmap=1 открывает превью');
ok(helpMapPreviewRequested({ search: '?a=b&helpmap=1&c=d' }), true, '?helpmap=1 среди прочих параметров');

// fail-closed: ничего похожего не считается
for (const startParam of ['helpmapper', 'HELPMAP', 'Helpmap', ' helpmap', 'helpmap ', 'diag', 'lab_auth', '']) {
  ok(helpMapPreviewRequested({ startParam }), true, `DEFAULT_ON: startParam ${JSON.stringify(startParam)} тоже даёт открытое превью`);
}
for (const search of ['?helpmap', '?helpmap=', '?helpmap=0', '?helpmap=2', '?helpmap=true',
  '?helpmapper=1', '?nothelpmap=1', '?diag=1', '?metaworld=1']) {
  ok(helpMapPreviewRequested({ search }), true, `DEFAULT_ON: search ${JSON.stringify(search)} тоже даёт открытое превью`);
}
// мусор не должен ронять загрузку ленты
ok(helpMapPreviewRequested({ search: '%%%' }), true, 'DEFAULT_ON: битая строка запроса не бросает');
ok(helpMapPreviewRequested({ search: null, startParam: undefined }), true, 'DEFAULT_ON: null/undefined безопасны');

// -------------------------------------------------- 2. структура: feed.ts

const feed = readFileSync(path.join(root, 'src/feed.ts'), 'utf8');

has(feed, "import { helpMapPreviewRequested } from './helpmap-preview.mjs';",
  'feed.ts берёт гейт из отдельного модуля, а не переизобретает его');
matches(feed, /const helpMapPreview = helpMapPreviewRequested\(\{\s*search: location\.search,\s*startParam: getStartParam\(\)/,
  'гейт считается из location.search и Telegram start_param');
// вкладка «Мета» видна, только если её открыл какой-то из гейтов
matches(feed, /tab\.name !== 'meta'\s*\|\|\s*ISLAND_UI_ENABLED\s*\|\|\s*helpMapPreview\s*\|\|/,
  'вкладка «Мета» остаётся скрытой, пока превью не запрошено');
matches(feed, /onTap: \(\) => \{ if \(helpMapPreview\) this\.openHelpMapPreview\(\);/,
  'по тапу «Мета» ведёт в карту только под гейтом, иначе прежнее поведение');
// ленивость: единственный путь к карте — динамический import
has(feed, "void import('./helpmap').then((m) => m.renderHelpMap(ov, { close: () => this.closeOverlay() }));",
  'карта подтягивается динамическим import()');
hasnt(feed, "from './helpmap'",
  'feed.ts не должен импортировать ./helpmap статически — иначе карта уедет в основной бандл');
matches(feed, /private openHelpMapPreview\(\) \{\s*if \(this\.overlayOpen\) return;/,
  'открытие карты защищено тем же overlayOpen, что и остальные оверлеи');

// ------------------------------------------------- 2. структура: helpmap.ts

const map = readFileSync(path.join(root, 'src/helpmap.ts'), 'utf8');

hasnt(map, "from './helpmap-data", 'данные карты не импортируются статически');
hasnt(map, "from './helpmap-runtime", 'рантайм карты не импортируется статически');
has(map, "fetch(assetUrl('data.json'))", 'география грузится соседним файлом по требованию');
has(map, "import(/* @vite-ignore */ assetUrl('runtime.mjs'))", 'рантайм грузится соседним модулем по требованию');
hasnt(map, "'/api/", 'превью не ходит в API — данные демонстрационные');
has(map, 'attachShadow', 'карта живёт в Shadow DOM, чтобы стили не текли в обе стороны');
has(map, 'BackButton', 'закрытие по системной кнопке «назад» в Telegram');
matches(map, /back\?\.offClick\?\.\(close\)/, 'BackButton за собой прибирается');
matches(map, /new MutationObserver/,
  'оверлей могут снять мимо нас (тап по вкладке) — подписки карты обязаны сняться и тогда');

// ------------------------------------------- 2. структура: чужие модули

const island = readFileSync(path.join(root, 'src/island.ts'), 'utf8');
ok(/helpmap/i.test(island), false, 'island.ts ничего не знает о карте помощи');
for (const rel of ['src/main.ts', 'src/api.ts', 'src/telegram.ts']) {
  const src = readFileSync(path.join(root, rel), 'utf8');
  ok(/helpmap/i.test(src), false, `${rel} ничего не знает о карте помощи`);
}

// --------------------------------------- 2. структура: сгенерированные файлы

const dataPath = path.join(root, 'public/helpmap/data.json');
const runtimePath = path.join(root, 'public/helpmap/runtime.mjs');
ok(existsSync(dataPath), true, 'public/helpmap/data.json на месте (пересборка: help-map-prototype/build-client.mjs)');
ok(existsSync(runtimePath), true, 'public/helpmap/runtime.mjs на месте');

const data = JSON.parse(readFileSync(dataPath, 'utf8'));
ok(typeof data.proj.scale === 'number', true, 'в данных есть параметры проекции');
ok(Array.isArray(data.lod.detail.fill), true, 'детальный слой нарезан на ячейки');
ok(data.lod.detail.fill.length, data.grid.gx * data.grid.gy, 'ячеек ровно столько, сколько в сетке');
ok(data.lod.detail.fill.some((d) => d.length > 0), true, 'детальные ячейки не пустые');
// Клиент по умолчанию везёт тот же мир, что и прототип. Разрежённая сборка
// (build-client.mjs --focus=...) остаётся возможной — тогда появляется `fine`,
// и тогда всё, что вне списка, обязано быть пустым, иначе экономия мнимая.
if (data.lod.detail.fine) {
  const fine = new Set(data.lod.detail.fine);
  ok(fine.size > 0, true, 'в разрежённой сборке детальные ячейки есть');
  ok(data.lod.detail.fill.every((d, i) => (fine.has(i) ? true : d === '')), true,
    'вне окна фокуса детальных ячеек нет');
} else {
  ok(data.lod.detail.fill.filter(Boolean).length > 100, true,
    'полная сборка: детализация по всему миру, как в принятом прототипе');
}

const runtime = readFileSync(runtimePath, 'utf8');
hasnt(runtime, 'env(safe-area-inset-',
  'в Telegram fullscreen env(safe-area-inset-*) пуст — карта обязана читать --safe-*');
has(runtime, 'var(--safe-top', 'верхний отступ берётся из --safe-top');
has(runtime, 'var(--safe-bottom', 'нижний отступ берётся из --safe-bottom');
has(runtime, 'прототип · демо-данные', 'бейдж честности превью остаётся на экране');
has(runtime, 'export function mountHelpMap', 'рантайм отдаёт точку монтирования');
hasnt(runtime, 'document.getElementById',
  'рантайм адресуется только к своему теневому корню');

console.log(`helpmap preview: ${n} assertions passed`);
