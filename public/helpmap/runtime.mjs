// ВНИМАНИЕ: сгенерировано help-map-prototype/build-client.mjs — не править руками.
// Пересборка:  cd help-map-prototype && node build-client.mjs --out=<репо>/public/helpmap
//
// Разметка, стили и логика карты, перенесённые из template.html подстановками
// (см. build-client.mjs). Карта монтируется в Shadow DOM.

export const HELPMAP_THEME = "paper";

const CSS = "/* ============================================================== themes ==== */\n:host{\n  --ff: -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif;\n  --r: 16px;\n  --ease: cubic-bezier(.22,.68,.16,1);\n}\n\n/* «тёплая бумага» — светлый пергамент: суша цвета слоновой кости, вода глуше.\n   Тема по умолчанию (решение оператора 31.07.2026). */\n:host([data-theme=\"paper\"]){\n  --bg:#c0b8a1; --sea:#ccc6af; --sea-edge:rgba(96,78,52,.36); --grat:rgba(96,78,52,.16);\n  --land:#f4ecd8; --coast:rgba(92,70,40,.55); --border:rgba(102,80,50,.18);\n  --shelf:rgba(92,76,50,.10);            /* тень воды у берега, а не белый ореол */\n  --ink:#453829; --ink-dim:rgba(69,56,41,.66); --ink-faint:rgba(69,56,41,.36);\n  --panel:rgba(252,248,238,.95); --panel-edge:rgba(118,94,60,.22); --panel-ink:#403426;\n  --chip:rgba(118,94,60,.09);\n  --closed:#2c7a51; --closed-ink:#f6f1e4; --active:#b0620c;\n  --label-sea:rgba(74,84,80,.62); --label-land:rgba(104,82,52,.42);\n  --halo:rgba(255,253,247,.92); --ring-op:.45;\n  --shadow:0 14px 34px rgba(74,56,30,.18);\n}\n/* «глубокое море» — ночной атлас: густая синь и тёплый песок суши */\n:host([data-theme=\"deep\"]){\n  --bg:#05121d; --sea:#0a2637; --sea-edge:rgba(151,199,226,.20); --grat:rgba(140,190,220,.085);\n  --land:#bda57c; --coast:rgba(45,32,16,.34); --border:rgba(52,38,20,.20); --shelf:rgba(150,201,229,.055);\n  --ink:#ece2cd; --ink-dim:rgba(236,226,205,.52); --ink-faint:rgba(236,226,205,.26);\n  --panel:rgba(6,26,39,.90); --panel-edge:rgba(151,199,226,.16); --panel-ink:#ece2cd;\n  --chip:rgba(151,199,226,.10);\n  --closed:#4ec18d; --closed-ink:#0a2536; --active:#f2a83c;\n  --label-sea:rgba(163,204,229,.40); --label-land:rgba(56,40,20,.40);\n  --halo:#05121d; --ring-op:.42;\n  --shadow:0 18px 44px rgba(0,0,0,.5);\n}\n/* «ночь» — графит и приглушённая олива, почти монохром */\n:host([data-theme=\"night\"]){\n  --bg:#070806; --sea:#181d19; --sea-edge:rgba(196,206,180,.16); --grat:rgba(196,206,180,.06);\n  --land:#454e3c; --coast:rgba(206,219,183,.30); --border:rgba(206,219,183,.12); --shelf:rgba(206,219,183,.05);\n  --ink:#e3e7da; --ink-dim:rgba(227,231,218,.50); --ink-faint:rgba(227,231,218,.24);\n  --panel:rgba(15,17,15,.92); --panel-edge:rgba(196,206,180,.13); --panel-ink:#e3e7da;\n  --chip:rgba(196,206,180,.09);\n  --closed:#83d7a0; --closed-ink:#12180f; --active:#eeab47;\n  --label-sea:rgba(196,206,180,.30); --label-land:rgba(24,30,18,.50);\n  --halo:#070806; --ring-op:.42;\n  --shadow:0 18px 44px rgba(0,0,0,.62);\n}\n\n/* =============================================================== shell ==== */\n*{box-sizing:border-box; -webkit-tap-highlight-color:transparent}\n:host{\n  display:block; position:absolute; inset:0; overflow:hidden;\n  font-family:var(--ff); background:var(--bg); color:var(--ink);\n  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;\n  transition:background .45s var(--ease), color .45s var(--ease);\n}\n#stage{position:absolute; inset:0; touch-action:none; cursor:grab; overflow:hidden}\n#stage.dragging{cursor:grabbing}\n/* Единственный «едущий» слой. Во время жеста двигается ТОЛЬКО его CSS-transform\n   (композитинг, без перерисовки SVG). Поля со всех сторон — запас, чтобы при\n   панораме из-за края не выезжала незакрашенная пустота. */\n#world{position:absolute; transform-origin:0 0; will-change:transform;\n  backface-visibility:hidden; contain:layout paint}\n#map{position:absolute; inset:0; width:100%; height:100%; display:block; shape-rendering:geometricPrecision}\n#map path{transition:fill .45s var(--ease), stroke .45s var(--ease)}\n/* ВАЖНО: на жесте не переключается НИ ОДНО правило, касающееся карты.\n   Замер показал, что сам тоггл класса (отмель через display, backdrop-filter\n   вкл/выкл) заставляет браузер перерисовать весь SVG — по разу в начале и в\n   конце каждого жеста. Именно это давало «залип» на телефоне, а не commit.\n   Поэтому `gesturing` теперь живёт только как переменная в JS. */\n\n.sea{fill:var(--sea); stroke:var(--sea-edge); stroke-width:1.1px}\n.grat{fill:none; stroke:var(--grat); stroke-width:.8px}\n/* мягкая «отмель» вокруг берега — та же геометрия широким полупрозрачным штрихом */\n/* linecap:butt обязателен: берег нарезан на полилинии, и круглые «шапки» на\n   срезах двух соседних ячеек накладывались бы друг на друга — у полупрозрачного\n   штриха это тёмная точка на каждом шве. Встык — стык невидим. */\n.shelf{fill:none; stroke:var(--shelf); stroke-width:8px; stroke-linejoin:round; stroke-linecap:butt}\n/* заливка и берег разделены: заливка нарезана по ячейкам с нахлёстом (швов не\n   видно), берег — открытыми полилиниями без искусственных рёбер по швам */\n.land{fill:var(--land); stroke:none}\n.coast{fill:none; stroke:var(--coast); stroke-width:.75px; stroke-linejoin:round; stroke-linecap:butt}\n.bord{fill:none; stroke:var(--border); stroke-width:.7px; stroke-linejoin:round}\n#lod-world,#lod-detail{transition:opacity .28s linear}\n\n/* ============================================================ топонимы ==== */\n#places{position:absolute; inset:0; pointer-events:none}\n.place{position:absolute; left:0; top:0; will-change:transform,opacity;\n  transition:opacity .4s linear}\n.place b{display:block; white-space:nowrap; font-weight:400; font-size:11.5px}\n.place.sea b{font-style:italic; letter-spacing:.34em; color:var(--label-sea)}\n.place.land b{text-transform:uppercase; letter-spacing:.46em; font-weight:500; color:var(--label-land)}\n\n/* ============================================================= markers ==== */\n#markers{position:absolute; inset:0; pointer-events:none}\n/* «паутинка» — ножки от центра зоны к разложённым веером флажкам */\n#legs{position:absolute; inset:0; width:100%; height:100%; pointer-events:none; overflow:visible}\n#legs line{stroke:var(--closed); stroke-width:1; opacity:.5; stroke-dasharray:2.5 3.5}\n.hub{position:absolute; left:0; top:0; width:9px; height:9px; margin:-4.5px 0 0 -4.5px;\n  border-radius:50%; background:var(--closed); opacity:.7; pointer-events:none}\n/* без will-change: маркеры двигаются только на коммите, лишние слои на телефоне\n   стоят памяти; пульсирующие кольца композитор поднимет сам — у них анимация */\n.marker{position:absolute; left:0; top:0; width:0; height:0; pointer-events:auto}\n.marker.anim{transition:transform .42s var(--ease), opacity .3s var(--ease)}\n.marker.hidden{opacity:0; pointer-events:none}\n.marker.gone{display:none}\n.marker.live{z-index:3}  /* активный кейс всегда поверх зон */\n\n/* --- флажок --- */\n.flag{position:absolute; transform:translate(-4px,-25px); width:19px; height:25px}\n.flag svg{display:block; overflow:visible; filter:drop-shadow(0 3px 4px rgba(0,0,0,.34))}\n:host([data-theme=\"paper\"]) .flag svg{filter:drop-shadow(0 2px 3px rgba(80,60,30,.28))}\n/* на светлой теме края теряются — берегу даём чуть больше веса, границам меньше */\n:host([data-theme=\"paper\"]) .coast{stroke-width:.9px}\n.flag .pole{stroke:var(--closed); stroke-width:1.7; stroke-linecap:round; opacity:.85}\n.flag .cloth{fill:var(--closed)}\n.flag .foot{fill:var(--closed)}\n.flag.act .pole,.flag.act .foot{stroke:var(--active); fill:var(--active)}\n.flag.act .cloth{fill:var(--active)}\n\n/* лапка «здесь мой вклад» */\n.paw{position:absolute; left:11px; top:-3px; width:15px; height:15px; border-radius:50%;\n  background:var(--panel); border:1px solid var(--panel-edge); display:grid; place-items:center;\n  box-shadow:0 2px 5px rgba(0,0,0,.3)}\n.paw svg{width:9px; height:9px; fill:var(--closed); display:block}\n:host([data-theme=\"paper\"]) .paw{box-shadow:0 2px 4px rgba(80,60,30,.2)}\n\n/* пульс активного кейса */\n.halo{position:absolute; left:4px; top:24px; width:16px; height:16px; margin:-8px 0 0 -8px;\n  border-radius:50%; border:1.5px solid var(--active); opacity:0;\n  animation:halo 2.9s var(--ease) infinite}\n.halo.d2{animation-delay:1.45s}\n@keyframes halo{\n  0%{transform:scale(.5); opacity:0}\n  14%{opacity:.5}\n  100%{transform:scale(3.4); opacity:0}\n}\n\n/* --- зона (кластер) --- */\n.zone{position:absolute; transform:translate(-50%,-50%); display:grid; place-items:center}\n/* появление зоны — короткий «сбор» вместо мгновенного возникновения */\n.marker.fresh .zone{animation:zonein .34s var(--ease)}\n@keyframes zonein{\n  from{opacity:0; transform:translate(-50%,-50%) scale(.55)}\n  to{opacity:1; transform:translate(-50%,-50%) scale(1)}\n}\n.zone .ring{position:absolute; border-radius:50%; border:1.5px solid var(--closed); opacity:0;\n  width:100%; height:100%; animation:ring 3.9s var(--ease) infinite; will-change:transform,opacity}\n.zone .ring.d2{animation-delay:1.95s}\n@keyframes ring{\n  0%{transform:scale(.66); opacity:0}\n  16%{opacity:var(--ring-op)}\n  100%{transform:scale(2.05); opacity:0}\n}\n/* зона полупрозрачная — география под ней читается, а не закрашивается */\n.zone .core{position:relative; width:100%; height:100%; border-radius:50%;\n  background:color-mix(in srgb, var(--closed) 20%, transparent);\n  backdrop-filter:blur(1.5px) saturate(1.15); -webkit-backdrop-filter:blur(1.5px) saturate(1.15);\n  border:1.5px solid color-mix(in srgb, var(--closed) 78%, transparent);\n  box-shadow:0 0 26px -6px color-mix(in srgb, var(--closed) 60%, transparent),\n             inset 0 0 18px -6px color-mix(in srgb, var(--closed) 45%, transparent), var(--shadow);\n  display:grid; place-items:center; font-variant-numeric:tabular-nums;\n  font-weight:600; letter-spacing:.01em; color:#fff;\n  text-shadow:0 1px 3px rgba(0,0,0,.55), 0 0 10px rgba(0,0,0,.4)}\n/* на светлом фоне свечение превращается в грязное пятно — гасим его,\n   контраст держим на обводке и на плотности заливки */\n:host([data-theme=\"paper\"]) .zone .core{\n  color:#1c452f; text-shadow:0 1px 2px rgba(255,252,244,.9);\n  background:color-mix(in srgb, var(--closed) 26%, transparent);\n  border-width:2px;\n  box-shadow:0 2px 10px -2px rgba(74,56,30,.28)}\n:host([data-theme=\"paper\"]) .zone.has-act .core{\n  border-width:2.5px;\n  box-shadow:0 0 0 3px color-mix(in srgb, var(--active) 18%, transparent),\n             0 2px 10px -2px rgba(74,56,30,.28)}\n:host([data-theme=\"paper\"]) .zone .ring{border-width:1.5px}\n/* в зоне есть активный кейс — янтарная обводка поверх зелёного пульса */\n.zone.has-act .core{border-color:color-mix(in srgb, var(--active) 80%, transparent);\n  box-shadow:0 0 0 3.5px color-mix(in srgb, var(--active) 26%, transparent),\n             0 0 26px -4px color-mix(in srgb, var(--active) 55%, transparent), var(--shadow)}\n.zone.has-act .ring{border-color:var(--active)}\n.zone .cap{position:absolute; top:calc(100% + 9px); white-space:nowrap; font-size:11.5px;\n  letter-spacing:.055em; color:var(--ink-dim); text-transform:uppercase; font-weight:500;\n  text-shadow:0 1px 6px var(--halo)}\n\n/* ================================================================ chrome == */\n.badge{position:absolute; left:14px; top:calc(14px + var(--safe-top, 0px)); z-index:5;\n  padding:6px 11px; border-radius:99px; background:var(--panel); border:1px solid var(--panel-edge);\n  color:var(--ink-dim); font-size:10.5px; letter-spacing:.1em; text-transform:uppercase;\n  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);\n  cursor:default; user-select:none; -webkit-user-select:none}\n\n/* счётчик кадров: тройной тап по бейджу — чтобы следующий разбор на телефоне\n   был измеримым, а не «на глаз» */\n#fps{position:absolute; left:14px; top:calc(48px + var(--safe-top, 0px)); z-index:7;\n  padding:8px 11px; border-radius:10px; background:var(--panel); border:1px solid var(--panel-edge);\n  color:var(--ink); font-size:11px; line-height:1.5; font-variant-numeric:tabular-nums;\n  white-space:pre; pointer-events:none; backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px)}\n#fps b{font-weight:600}\n#fps .bad{color:var(--active)}\n\n#themes{position:absolute; right:14px; top:calc(14px + var(--safe-top, 0px)); z-index:6;\n  display:flex; flex-direction:column; gap:9px; align-items:flex-end}\n.sw{width:30px; height:30px; border-radius:50%; padding:0; cursor:pointer; position:relative;\n  border:1px solid var(--panel-edge); overflow:hidden; background:none;\n  transition:transform .2s var(--ease), box-shadow .25s var(--ease)}\n.sw i{position:absolute; inset:0; display:block}\n.sw i:after{content:\"\"; position:absolute; inset:0; background:var(--sw-land);\n  clip-path:polygon(0 100%, 100% 0, 100% 100%)}\n.sw[aria-pressed=\"true\"]{box-shadow:0 0 0 2px var(--bg), 0 0 0 3.5px var(--closed)}\n.sw:active{transform:scale(.94)}\n.sw-name{position:absolute; right:38px; top:6px; font-size:10.5px; letter-spacing:.09em;\n  text-transform:uppercase; color:var(--ink-dim); white-space:nowrap; pointer-events:none;\n  opacity:0; transition:opacity .3s var(--ease); text-shadow:0 1px 6px var(--halo)}\n.sw-name.on{opacity:1}\n\n#zoomctl{position:absolute; right:14px; bottom:calc(20px + var(--safe-bottom, 0px)); z-index:6;\n  display:flex; flex-direction:column; gap:7px}\n.zb{width:36px; height:36px; border-radius:12px; background:var(--panel); border:1px solid var(--panel-edge);\n  color:var(--ink); font-size:17px; line-height:1; display:grid; place-items:center; cursor:pointer;\n  backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);\n  transition:transform .16s var(--ease), background .3s var(--ease)}\n.zb:active{transform:scale(.92)}\n.zb svg{width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round}\n\n#hint{position:absolute; left:50%; bottom:calc(76px + var(--safe-bottom, 0px)); transform:translateX(-50%);\n  z-index:5; font-size:11.5px; letter-spacing:.06em; color:var(--ink-faint); white-space:nowrap;\n  pointer-events:none; transition:opacity .6s var(--ease); text-shadow:0 1px 8px var(--halo)}\n#readout{position:absolute; left:14px; bottom:calc(18px + var(--safe-bottom, 0px)); z-index:5;\n  font-size:10px; letter-spacing:.07em; color:var(--ink-faint); pointer-events:none;\n  font-variant-numeric:tabular-nums; text-shadow:0 1px 8px var(--halo)}\n\n/* ================================================================ sheet === */\n#scrim{position:absolute; inset:0; z-index:8; background:rgba(0,0,0,.34); opacity:0;\n  pointer-events:none; transition:opacity .35s var(--ease)}\n#scrim.on{opacity:1; pointer-events:auto}\n#sheet{position:absolute; left:0; right:0; bottom:0; z-index:9; max-width:520px; margin:0 auto;\n  background:var(--panel); color:var(--panel-ink);\n  border:1px solid var(--panel-edge); border-bottom:none;\n  border-radius:22px 22px 0 0; box-shadow:var(--shadow);\n  backdrop-filter:blur(22px) saturate(1.2); -webkit-backdrop-filter:blur(22px) saturate(1.2);\n  padding:10px 20px calc(20px + var(--safe-bottom, 0px));\n  transform:translateY(115%); transition:transform .42s var(--ease); will-change:transform}\n#sheet.on{transform:translateY(0)}\n.grab{width:36px; height:4px; border-radius:99px; background:var(--ink-faint); margin:0 auto 14px}\n.st{display:inline-flex; align-items:center; gap:6px; font-size:10.5px; letter-spacing:.11em;\n  text-transform:uppercase; padding:4px 9px; border-radius:99px; background:var(--chip); color:var(--ink-dim)}\n.st b{width:6px; height:6px; border-radius:50%; background:var(--closed); display:block}\n.st.act b{background:var(--active)}\n.st.act{color:var(--active)}\n#s-name{margin:11px 0 3px; font-size:20px; line-height:1.22; font-weight:600; letter-spacing:-.01em}\n#s-sub{font-size:12.5px; color:var(--ink-dim); letter-spacing:.01em}\n.photo{margin:15px 0 14px; height:112px; border-radius:14px; background:var(--chip);\n  border:1px dashed var(--panel-edge); display:grid; place-items:center; gap:7px; align-content:center}\n.photo svg{width:22px; height:22px; fill:none; stroke:var(--ink-faint); stroke-width:1.4; stroke-linecap:round; stroke-linejoin:round}\n.photo span{font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-faint)}\n.sums{display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--panel-edge);\n  border:1px solid var(--panel-edge); border-radius:13px; overflow:hidden}\n.sums div{background:var(--panel); padding:11px 10px}\n.sums dt{font-size:9.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--ink-faint); margin:0 0 5px}\n.sums dd{margin:0; font-size:14.5px; font-weight:600; font-variant-numeric:tabular-nums; letter-spacing:-.01em}\n.sums .hl dd{color:var(--closed)}\n.sums .hl.act dd{color:var(--active)}\n.foot{margin-top:13px; display:flex; align-items:center; justify-content:space-between; gap:12px;\n  font-size:11.5px; color:var(--ink-dim)}\n.mine{display:inline-flex; align-items:center; gap:6px; color:var(--closed); font-weight:500}\n.mine svg{width:12px; height:12px; fill:currentColor}\n\n@media (min-width:600px){\n  #scrim{background:none}\n  #scrim.on{pointer-events:none}\n  #sheet{left:auto; right:20px; bottom:20px; width:380px; border-radius:20px; border-bottom:1px solid var(--panel-edge);\n    transform:translateY(calc(100% + 30px))}\n  #sheet.on{transform:translateY(0)}\n  #zoomctl{bottom:20px; right:auto; left:20px}\n  #readout{left:20px; bottom:156px}\n  #hint{left:20px; bottom:180px; transform:none}\n}";
const HTML = "<div id=\"stage\">\n  <div id=\"world\">\n    <svg id=\"map\" xmlns=\"http://www.w3.org/2000/svg\"></svg>\n    <div id=\"places\"></div>\n    <div id=\"markers\">\n      <svg id=\"legs\" xmlns=\"http://www.w3.org/2000/svg\"></svg>\n    </div>\n  </div>\n</div>\n\n<div class=\"badge\" id=\"badge\">прототип · демо-данные</div>\n<div id=\"fps\" hidden></div>\n\n<div id=\"themes\">\n  <span class=\"sw-name\" id=\"swname\"></span>\n</div>\n\n<div id=\"zoomctl\">\n  <button class=\"zb\" id=\"zin\" aria-label=\"приблизить\"><svg viewBox=\"0 0 24 24\"><path d=\"M12 5v14M5 12h14\"/></svg></button>\n  <button class=\"zb\" id=\"zout\" aria-label=\"отдалить\"><svg viewBox=\"0 0 24 24\"><path d=\"M5 12h14\"/></svg></button>\n  <button class=\"zb\" id=\"zhome\" aria-label=\"вернуться\"><svg viewBox=\"0 0 24 24\"><path d=\"M4 11.5 12 4l8 7.5M6.5 10v9h11v-9\"/></svg></button>\n</div>\n\n<div id=\"hint\">колесо или щипок — зум · перетащите карту</div>\n<div id=\"readout\"></div>\n\n<div id=\"scrim\"></div>\n<div id=\"sheet\" role=\"dialog\" aria-modal=\"false\">\n  <div class=\"grab\"></div>\n  <span class=\"st\" id=\"s-st\"><b></b><em id=\"s-st-t\" style=\"font-style:normal\"></em></span>\n  <h2 id=\"s-name\"></h2>\n  <div id=\"s-sub\"></div>\n  <div class=\"photo\">\n    <svg viewBox=\"0 0 24 24\"><path d=\"M3 8.5h3.2L8 6h8l1.8 2.5H21v11H3z\"/><circle cx=\"12\" cy=\"13.6\" r=\"3.4\"/></svg>\n    <span id=\"s-photo\">фото-отчёт</span>\n  </div>\n  <dl class=\"sums\">\n    <div><dt>Гарантировано</dt><dd id=\"s-g\"></dd></div>\n    <div class=\"hl\" id=\"s-open-cell\"><dt>Открыто</dt><dd id=\"s-o\"></dd></div>\n    <div class=\"hl\" id=\"s-tr-cell\"><dt>Передано</dt><dd id=\"s-t\"></dd></div>\n  </dl>\n  <div class=\"foot\"><span id=\"s-season\"></span><span id=\"s-mine\"></span></div>\n</div>";

/**
 * Монтирует карту в теневой корень. Возвращает функцию размонтирования:
 * она снимает глобальные подписки и таймер, всё остальное уходит вместе с host.
 *
 * @param {HTMLElement} HOST   элемент-хозяин (несёт data-theme)
 * @param {ShadowRoot}  ROOT   его теневой корень
 * @param {object}      MAP    данные из helpmap-data.mjs
 * @returns {() => void}
 */
export function mountHelpMap(HOST, ROOT, MAP) {
  const style = document.createElement("style");
  style.textContent = CSS;
  ROOT.appendChild(style);
  const holder = document.createElement("div");
  holder.innerHTML = HTML;
  while (holder.firstChild) ROOT.appendChild(holder.firstChild);

  const CLEAN = [];
  const ON = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    CLEAN.push(() => target.removeEventListener(type, fn, opts));
  };
  const EVERY = (fn, ms) => {
    const id = setInterval(fn, ms);
    CLEAN.push(() => clearInterval(id));
    return id;
  };

  /* ------------------------------------------------------------- baked map -- */
  /* MAP приходит параметром */

  /* lon/lat -> map units (ported geoNaturalEarth1, verified against d3 at build) */
  const PS = MAP.proj.scale, PTX = MAP.proj.tx, PTY = MAP.proj.ty, RAD = Math.PI / 180;
  function project(lon, lat){
    const l = lon * RAD, p = lat * RAD, p2 = p * p, p4 = p2 * p2;
    const x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
    const y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
    return [PS * x + PTX, PTY - PS * y];
  }

  /* ------------------------------------------------------------ demo cases -- */
  /* координаты — реальные города; кейсы вымышленные */
  const CASES = [
    // ——— Кипр, Лимасол и окрестности (плотное ядро) ———
    c(1,  "Приют «Тёплые лапы»",        "Лимасол",     "Кипр", 34.6841, 33.0379, "Корм и лечение",        4800, 4800, 4800, "Сезон 1", 6, true),
    c(2,  "Кошачий дом на Ипсонасе",     "Ипсонас",     "Кипр", 34.6889, 32.9464, "Стерилизация",          3200, 3200, 3200, "Сезон 1", 4),
    c(3,  "Передержка «Гермасогия»",     "Гермасогия",  "Кипр", 34.7106, 33.0864, "Передержка",            2100, 2100, 2100, "Сезон 1", 3),
    c(4,  "Вольеры в Колосси",           "Колосси",     "Кипр", 34.6667, 32.9333, "Вольеры и зимовка",     6400, 6400, 6400, "Сезон 2", 8),
    c(5,  "Писсури: выездная ветбригада","Писсури",     "Кипр", 34.6667, 32.7000, "Ветпомощь после травмы",1750, 1750, 1750, "Сезон 2", 5),
    c(6,  "Кормовая станция Мутаяка",    "Мутаяка",     "Кипр", 34.7167, 33.1167, "Корм и лечение",        1400, 1400, 1400, "Сезон 2", 3),
    // ——— Кипр, остальной остров ———
    c(7,  "Хвостики Пафоса",             "Пафос",       "Кипр", 34.7754, 32.4245, "Стерилизация",          3900, 3900, 3900, "Сезон 1", 7),
    c(8,  "Кошки Ларнаки",               "Ларнака",     "Кипр", 34.9182, 33.6201, "Прививки",              2600, 2600, 2600, "Сезон 2", 4),
    c(9,  "Никосийский собачий дом",     "Никосия",     "Кипр", 35.1856, 33.3823, "Корм и лечение",        5200, 5200, 5200, "Сезон 2", 9),
    c(10, "Айя-Напа: 40 хвостов",        "Айя-Напа",    "Кипр", 34.9880, 34.0090, "Вольеры и зимовка",     4100, 4100, 4100, "Сезон 3", 6),
    c(11, "Полис: зимняя передержка",    "Полис",       "Кипр", 35.0361, 32.4260, "Передержка",            1900, 1900, 1900, "Сезон 3", 3),
    c(12, "Паралимни: ветбригада",       "Паралимни",   "Кипр", 35.0389, 33.9833, "Ветпомощь после травмы",2300, 2300, 2300, "Сезон 3", 5),
    // ——— одиночные флажки в Европе ———
    c(13, "Афинский кошачий приют",      "Афины",       "Греция",     37.9838, 23.7275, "Стерилизация",    4400, 4400, 4400, "Сезон 3", 6, true),
    c(14, "Приют «Шапа» в Белграде",     "Белград",     "Сербия",     44.7866, 20.4489, "Корм и лечение",  3100, 3100, 3100, "Сезон 3", 4),
    c(15, "Лиссабон: дом для щенков",    "Лиссабон",    "Португалия", 38.7400, -9.1600, "Прививки",        2750, 2750, 2750, "Сезон 3", 5),
    c(16, "Краковская передержка",       "Краков",      "Польша",     50.0647, 19.9450, "Передержка",      2200, 2200, 2200, "Сезон 3", 3),
  ];
  // активный кейс — живой янтарный флажок
  CASES.push(Object.assign(
    c(17, "Приют «Морской бриз»", "Лимасол", "Кипр", 34.6960, 33.0620, "Вольеры и зимовка", 5000, 3150, 0, "Сезон 4", 0),
    { active: true, photos: 0 }
  ));

  function c(id, name, city, region, lat, lon, type, g, o, t, season, photos, mine){
    return { id, name, city, region, lat, lon, type, g, o, t, season, photos: photos || 0,
             mine: !!mine, active: false };
  }
  /* район — чтобы вложенная зона подписывалась «Лимасол», а не «Кипр» */
  const DISTRICT = { 1:"Лимасол", 2:"Лимасол", 3:"Лимасол", 4:"Лимасол", 5:"Лимасол", 6:"Лимасол", 17:"Лимасол",
                     7:"Пафос", 11:"Пафос", 8:"Ларнака", 9:"Никосия", 10:"Фамагуста", 12:"Фамагуста" };
  for (const k of CASES){ k.p = project(k.lon, k.lat); k.district = DISTRICT[k.id] || k.city; }

  /* ------------------------------------------------------------- топонимы -- */
  /* Немного, и каждый живёт в своём окне зума: карта перестаёт быть немой,
     но подписи никогда не спорят с флажками. z — [появиться, исчезнуть]. */
  const PLACES = [
    { t:"Европа",           lon:20.5, lat:50.5, kind:"land", z:[1.6, 13],   rot:0,    size:13 },
    { t:"Средиземное море", lon:22.3, lat:33.9, kind:"sea",  z:[3.5, 34],   rot:-4,   size:12 },
    { t:"Чёрное море",      lon:34.0, lat:43.4, kind:"sea",  z:[6, 60],     rot:0,    size:11 },
    { t:"Эгейское море",    lon:25.2, lat:37.6, kind:"sea",  z:[14, 120],   rot:-62,  size:10 },
  ];
  for (const p of PLACES) p.p = project(p.lon, p.lat);

  /* ---------------------------------------------------------------- themes -- */
  const THEMES = [
    { id:"paper", name:"тёплая бумага", sea:"#ccc6af", land:"#f4ecd8" },
    { id:"deep",  name:"глубокое море", sea:"#0a2637", land:"#bda57c" },
    { id:"night", name:"ночь",          sea:"#181d19", land:"#454e3c" },
  ];
  const themeBox = ROOT.getElementById("themes");
  const swName = ROOT.getElementById("swname");
  let nameTimer = 0;
  THEMES.forEach(t => {
    const b = document.createElement("button");
    b.className = "sw"; b.type = "button"; b.title = t.name;
    b.setAttribute("aria-pressed", String(t.id === HOST.dataset.theme));
    b.style.background = t.sea; b.style.setProperty("--sw-land", t.land);
    b.innerHTML = "<i></i>";
    b.onclick = () => setTheme(t.id);
    b.dataset.id = t.id;
    themeBox.appendChild(b);
  });
  function setTheme(id){
    HOST.dataset.theme = id;
    themeBox.querySelectorAll(".sw").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.id === id)));
    const t = THEMES.find(x => x.id === id);
    swName.textContent = t.name; swName.classList.add("on");
    clearTimeout(nameTimer); nameTimer = setTimeout(() => swName.classList.remove("on"), 1900);
    try { localStorage.setItem("p4g-map-theme", id); } catch (e) {}
  }
  try { const s = localStorage.getItem("p4g-map-theme"); if (s && THEMES.some(t => t.id === s)) setTheme(s); } catch (e) {}

  /* ------------------------------------------------------------------ svg --- */
  const NS = "http://www.w3.org/2000/svg";
  const svg = ROOT.getElementById("map");
  const root = document.createElementNS(NS, "g");
  svg.appendChild(root);
  function path(cls, d, parent){
    const p = document.createElementNS(NS, "path");
    p.setAttribute("class", cls); p.setAttribute("d", d);
    p.setAttribute("vector-effect", "non-scaling-stroke");
    (parent || root).appendChild(p); return p;
  }
  path("sea", MAP.sphere);
  const gratEl = path("grat", MAP.graticule);
  const gWorld = document.createElementNS(NS, "g"); gWorld.id = "lod-world"; root.appendChild(gWorld);
  const gDetail = document.createElementNS(NS, "g"); gDetail.id = "lod-detail"; root.appendChild(gDetail);

  /* Порядок слоёв держим глобальным (все отмели под всеми заливками), поэтому
     ячейки живут внутри слоёв, а не наоборот. */
  function buildLod(L, g){
    const order = [["shelf", "coast"], ["land", "fill"], ["coast", "coast"], ["bord", "bord"]];
    const cells = [];
    for (const [cls, src] of order){
      const layer = document.createElementNS(NS, "g");
      g.appendChild(layer);
      if (!L.grid){ path(cls, L[src], layer); continue; }
      const arr = [];
      L[src].forEach((d, idx) => { if (d) arr[idx] = path(cls, d, layer); });
      cells.push(arr);
    }
    return L.grid ? cells : null;   // [shelf[], land[], coast[], bord[]] по индексу ячейки
  }
  const worldCells = buildLod(MAP.lod.world, gWorld);
  const detailCells = buildLod(MAP.lod.detail, gDetail);
  gDetail.style.display = "none"; gDetail.style.opacity = "0";

  /* --------------------------------------------------------- отсечение ячеек */
  const GX = MAP.grid.gx, GY = MAP.grid.gy;
  const CW = MAP.view.w / GX, CH = MAP.view.h / GY;
  let shownCells = new Set(), lastVisibleCount = 0;
  /* Рисуем только ячейки, пересекающие вьюпорт. Это и есть главная экономия:
     на рабочем зуме в кадр попадает единицы ячеек из 288. */
  function cullCells(){
    if (!detailCells) return;
    const pad = BUF + 12;                                  // запас слоя + широкий штрих отмели
    const mx0 = (-pad - view.ox) / view.k, mx1 = (vw + pad - view.ox) / view.k;
    const my0 = (-pad - view.oy) / view.k, my1 = (vh + pad - view.oy) / view.k;
    const i0 = Math.max(0, Math.floor((mx0 - MAP.view.x) / CW));
    const i1 = Math.min(GX - 1, Math.floor((mx1 - MAP.view.x) / CW));
    const j0 = Math.max(0, Math.floor((my0 - MAP.view.y) / CH));
    const j1 = Math.min(GY - 1, Math.floor((my1 - MAP.view.y) / CH));
    const next = new Set();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) next.add(j * GX + i);
    lastVisibleCount = next.size;
    if (next.size === shownCells.size){
      let same = true;
      for (const k of next) if (!shownCells.has(k)){ same = false; break; }
      if (same) return;
    }
    for (const k of shownCells) if (!next.has(k)) for (const arr of detailCells){ const p = arr[k]; if (p) p.style.display = "none"; }
    for (const k of next) if (!shownCells.has(k)) for (const arr of detailCells){ const p = arr[k]; if (p) p.style.display = ""; }
    shownCells = next;
  }
  /* Ячейки, где детальный слой действительно детальный. Если список не задан
     (полная сборка прототипа) — детальны все. Клиентская сборка кладёт сюда
     только окно с кейсами, а вне его карта остаётся на обзорном слое: так в
     бандл не едет вся планета в 50m. */
  const FINE = MAP.lod.detail.fine ? new Set(MAP.lod.detail.fine) : null;
  /* сколько ячеек попало бы в кадр и все ли они детальные — нужно ещё до
     показа детального слоя */
  function surveyCells(){
    const pad = BUF + 12;
    const mx0 = (-pad - view.ox) / view.k, mx1 = (vw + pad - view.ox) / view.k;
    const my0 = (-pad - view.oy) / view.k, my1 = (vh + pad - view.oy) / view.k;
    const i0 = Math.max(0, Math.floor((mx0 - MAP.view.x) / CW));
    const i1 = Math.min(GX - 1, Math.floor((mx1 - MAP.view.x) / CW));
    const j0 = Math.max(0, Math.floor((my0 - MAP.view.y) / CH));
    const j1 = Math.min(GY - 1, Math.floor((my1 - MAP.view.y) / CH));
    let covered = true;
    if (FINE){
      for (let j = j0; j <= j1 && covered; j++)
        for (let i = i0; i <= i1; i++) if (!FINE.has(j * GX + i)){ covered = false; break; }
    }
    return { n: (i1 - i0 + 1) * (j1 - j0 + 1), covered };
  }
  if (detailCells) for (const arr of detailCells) arr.forEach(p => { if (p) p.style.display = "none"; });

  /* ---------------------------------------------------------- view / zoom --- */
  const stage = ROOT.getElementById("stage");
  const V = MAP.view;
  let vw = 1, vh = 1, kFit = 1;
  const view = { k: 1, ox: 0, oy: 0 };
  /* Потолок зума опущен с 900 до 420: глубже 50m-данные пусты (ни городов, ни
     рек — просто поле), а дотянуться до слипшихся кейсов теперь можно веером. */
  const Z_MIN = 0.92, Z_MAX = 420;
  const LOD_IN = 2.4, LOD_OUT = 2.1;
  let detailOn = false, lodTimer = 0;

  const world = ROOT.getElementById("world");
  /* Запас по краям «едущего» слоя. Больше запас — реже перерисовка при панораме,
     но дороже растр (на 3x-экране каждый лишний пиксель стоит втрое). */
  let BUF = 96;
  function measure(){
    vw = stage.clientWidth || 1; vh = stage.clientHeight || 1;
    kFit = Math.min(vw / V.w, vh / V.h);
    BUF = Math.round(Math.max(72, Math.min(140, Math.min(vw, vh) * 0.26)));
    world.style.left = world.style.top = -BUF + "px";
    world.style.width = (vw + 2 * BUF) + "px";
    world.style.height = (vh + 2 * BUF) + "px";
  }
  function zoom(){ return view.k / kFit; }

  function clampView(){
    view.k = Math.max(kFit * Z_MIN, Math.min(kFit * Z_MAX, view.k));
    const w = V.w * view.k, h = V.h * view.k;
    let l = V.x * view.k + view.ox, t = V.y * view.k + view.oy;
    l = w <= vw ? (vw - w) / 2 : Math.max(vw - w, Math.min(0, l));
    const slack = Math.min(vh * 0.12, 80);
    t = h <= vh ? (vh - h) / 2 : Math.max(vh - h - slack, Math.min(slack, t));
    view.ox = l - V.x * view.k; view.oy = t - V.y * view.k;
  }

  /* ============================ два режима отрисовки ========================
     base — вид, под который СВГ реально растеризован.
     view — вид, который хочет пользователь прямо сейчас.

     Пока они расходятся, разницу отыгрывает один CSS-transform на #world:
     это работа композитора, SVG не перерисовывается вообще. commit() сводит
     base к view — вот он и есть единственная дорогая операция.          */
  const base = { k: 1, ox: 0, oy: 0 };
  let repaints = 0;

  function applyWorld(){
    const s = view.k / base.k;
    const tx = (view.ox - s * base.ox) + BUF * (1 - s);
    const ty = (view.oy - s * base.oy) + BUF * (1 - s);
    world.style.transform = (s === 1 && !tx && !ty)
      ? "none"
      : "translate3d(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px,0) scale(" + s + ")";
    return { s, tx, ty };
  }
  /* Перерисовываемся ровно тогда, когда это правда нужно:
     (а) отрисованный слой перестал накрывать вьюпорт — оголился край;
     (б) текстуру растянули так, что это уже видно.
     Считать именно покрытие, а не |tx|, принципиально для щипка: зум вокруг
     точки даёт большой сдвиг, но при s>1 слой только надёжнее накрывает экран.
     Порог проверяется в том же синхронном блоке, где пишется transform, поэтому
     промежуточное состояние на экран не попадает. */
  function needsCommit(g){
    const m = 2;                                   // запас на округление
    const left = -BUF + g.tx, right = left + g.s * (vw + 2 * BUF);
    const top  = -BUF + g.ty, bottom = top + g.s * (vh + 2 * BUF);
    if (left > -m || right < vw + m || top > -m || bottom < vh + m) return "край";
    if (g.s > 1.9 || g.s < 0.55) return "масштаб"; // «дыхание» штрихов — как у всех карт
    return null;
  }

  /* Дешёвый путь: только пересчёт чисел и один transform. Вызывается прямо из
     обработчика жеста, синхронно — движение не ждёт пробуждения rAF. */
  function nudge(){
    clampView();
    const g = applyWorld();
    const why = needsCommit(g);
    if (why) commit(why);
  }

  let dirty = true, raf = 0;
  function invalidate(){ if (!raf) raf = requestAnimationFrame(render); dirty = true; }
  function render(){ raf = 0; if (!dirty) return; dirty = false; commit("кадр"); }

  /* Самокалибровка: если коммиты на этом устройстве дорогие, дольше держим
     грубый слой. Порог по факту, а не по UA — телефоны слишком разные. */
  let commitMs = 0, commitReason = "старт", lodBias = 1, slowCommits = 0;
  const CELL_BUDGET = 56;          // потолок числа детальных ячеек в кадре

  /* Дорогой путь: перерисовка SVG в новой проекции + пересборка маркеров. */
  function commit(reason){
    const t0 = performance.now();
    dirty = false; repaints++;
    commitReason = reason || commitReason;
    clampView();
    base.k = view.k; base.ox = view.ox; base.oy = view.oy;
    root.setAttribute("transform",
      "translate(" + (base.ox + BUF).toFixed(2) + "," + (base.oy + BUF).toFixed(2) + ") scale(" + base.k + ")");
    world.style.transform = "none";
    const z = zoom();
    // сетка меридианов тает при приближении
    gratEl.style.opacity = String(Math.max(0, Math.min(1, 1.35 - (z - 1) / 5)));
    // LOD: зум с гистерезисом И бюджет ячеек — детальный слой не включаем, пока
    // в кадр лезет пол-мира (это как раз самый дорогой случай)
    const survey = surveyCells();
    const cells = survey.n;
    const want = (detailOn ? z > LOD_OUT * lodBias : z > LOD_IN * lodBias)
              && cells <= (detailOn ? CELL_BUDGET * 1.4 : CELL_BUDGET)
              && survey.covered;
    if (want !== detailOn){
      detailOn = want;
      clearTimeout(lodTimer);
      const show = detailOn ? gDetail : gWorld, hide = detailOn ? gWorld : gDetail;
      if (detailOn) cullCells();
      show.style.display = ""; void show.offsetWidth;
      requestAnimationFrame(() => { show.style.opacity = "1"; hide.style.opacity = "0"; });
      lodTimer = setTimeout(() => { hide.style.display = "none"; }, 320);
    }
    if (detailOn) cullCells();
    layoutPlaces(z);
    layoutMarkers(z);
    readout.textContent = (detailOn ? "50m" : "110m") + " · z" + (z < 10 ? z.toFixed(1) : Math.round(z));
    // Настоящую стоимость видно только после того, как кадр отрисован: rAF —
    // это ещё до отрисовки, поэтому мерим через следующий таймер.
    const mark = t0;
    requestAnimationFrame(() => setTimeout(() => {
      commitMs = performance.now() - mark;
      if (commitMs > 100){ if (++slowCommits >= 2 && lodBias < 6){ lodBias *= 1.6; slowCommits = 0; } }
      else if (commitMs < 40){ slowCommits = 0; if (lodBias > 1) lodBias = Math.max(1, lodBias / 1.15); }
    }, 0));
  }

  /* жест начался/кончился: на время движения гасим самый дорогой слой */
  let gesturing = false, idleCommit = 0;
  function beginGesture(){
    if (gesturing) return;
    gesturing = true;
    clearTimeout(idleCommit);
  }
  function endGesture(){
    clearTimeout(idleCommit);
    idleCommit = setTimeout(() => {
      if (!pointers.size) gesturing = false;
      commit("конец жеста");
    }, 140);
  }

  function zoomAt(sx, sy, factor){
    const k0 = view.k;
    let k1 = Math.max(kFit * Z_MIN, Math.min(kFit * Z_MAX, k0 * factor));
    if (k1 === k0) return;
    view.ox = sx - (sx - view.ox) * (k1 / k0);
    view.oy = sy - (sy - view.oy) * (k1 / k0);
    view.k = k1;
    nudge();
  }

  /* плавный перелёт */
  let tween = null;
  function flyTo(k, ox, oy, dur){
    const a = { k: view.k, ox: view.ox, oy: view.oy }, t0 = performance.now();
    dur = dur || 620;
    let started = false;
    const self = tween = (now) => {
      if (tween !== self) return;
      started = true;
      let u = Math.min(1, (now - t0) / dur);
      const e = u < .5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      // интерполяция масштаба в лог-пространстве — движение читается ровнее
      view.k = a.k * Math.pow(k / a.k, e);
      view.ox = a.ox + (ox - a.ox) * e; view.oy = a.oy + (oy - a.oy) * e;
      // перелёт едет тем же дешёвым путём, что и жест
      if (u >= 1){ tween = null; gesturing = false; commit("конец перелёта"); }
      else { nudge(); requestAnimationFrame(self); }
    };
    beginGesture();
    requestAnimationFrame(self);
    // Если кадры не идут (фоновая вкладка, троттлящий WebView, автоматизация) —
    // не оставляем тап без последствий, а просто встаём в конечную точку.
    setTimeout(() => {
      if (started || tween !== self) return;
      tween = null;
      view.k = k; view.ox = ox; view.oy = oy;
      gesturing = false;
      commit("перелёт без кадров");
    }, 280);
  }
  function stopTween(){ tween = null; }

  /* Стартовый кадр собирается ИЗ ДАННЫХ, а не из константы: центр — центроид
     флажков, масштаб — чтобы все они поместились. Границы обязательны:
     HOME_Z_MIN держит обещание backlog («карта мира с одним флажком запрещена
     как первый экран»), HOME_Z_MAX не даёт вырожденному одиночному флажку
     утащить нас в пустое поле. Масштаб зажимается ДО расчёта смещения —
     иначе на пределе прицел уезжает мимо. */
  const HOME_PAD = 0.80, HOME_Z_MIN = 13, HOME_Z_MAX = 90;
  function homeView(animate){
    let cx = 0, cy = 0;
    for (const k of CASES){ cx += k.p[0]; cy += k.p[1]; }
    cx /= CASES.length; cy /= CASES.length;
    let hx = 1e-6, hy = 1e-6;
    for (const k of CASES){
      hx = Math.max(hx, Math.abs(k.p[0] - cx));
      hy = Math.max(hy, Math.abs(k.p[1] - cy));
    }
    let k = Math.min(vw * HOME_PAD / (2 * hx), vh * HOME_PAD / (2 * hy));
    k = Math.max(kFit * HOME_Z_MIN, Math.min(kFit * HOME_Z_MAX, k));
    const ox = vw / 2 - cx * k, oy = vh / 2 - cy * k;
    if (animate) flyTo(k, ox, oy); else { view.k = k; view.ox = ox; view.oy = oy; commit("стартовый кадр"); }
  }

  /* -------------------------------------------------------------- gestures -- */
  const pointers = new Map();
  let panning = false, moved = 0, downTarget = null, pinch0 = 0, pinchK = 0, pinchMid = null;
  let touched = false;

  stage.addEventListener("pointerdown", (e) => {
    stopTween(); touched = true; beginGesture();
    // capture может бросить на синтетических/чужих pointerId — тогда жест просто
    // работает без захвата, но обработчик не должен падать до регистрации точки
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1){ panning = true; moved = 0; downTarget = e.target; }
    else if (pointers.size === 2){ panning = false; startPinch(); }
  }, { passive: true });
  function pts(){ return [...pointers.values()]; }
  function startPinch(){
    const [a, b] = pts();
    pinch0 = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    pinchK = view.k;
    pinchMid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
  }
  stage.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pointers.size === 1 && panning){
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 5 && !stage.classList.contains("dragging")) stage.classList.add("dragging");
      view.ox += dx; view.oy += dy;
      nudge();                       // синхронно: палец не ждёт кадра
    } else if (pointers.size === 2){
      const [a, b] = pts();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      // пан от смещения середины + зум от изменения расстояния
      view.ox += mid[0] - pinchMid[0]; view.oy += mid[1] - pinchMid[1];
      pinchMid = mid;
      const k1 = pinchK * (d / pinch0);
      if (Math.abs(d - pinch0) > 8) clearSpider();   // щипок = смена масштаба, веер закрываем
      zoomAt(mid[0], mid[1], k1 / view.k);
      moved = 99;
    }
  }, { passive: true });
  let pointerSeqAt = -1e9;
  function endPointer(e){
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    stage.classList.remove("dragging");
    if (pointers.size === 1) startPinch(), panning = true, moved = 99;
    if (pointers.size === 0){
      pointerSeqAt = performance.now();
      if (panning && moved <= 5 && downTarget) tap(downTarget);
      panning = false; downTarget = null;
      endGesture();                  // жест кончился — честная перерисовка
    }
  }
  stage.addEventListener("pointerup", endPointer, { passive: true });
  stage.addEventListener("pointercancel", endPointer, { passive: true });

  /* Запасной путь для обычного click. Живой браузер всегда шлёт pointerup перед
     click, поэтому основная pointer-логика выигрывает по времени; но синтетический
     click (CDP-автоматизация, часть WebView) приходит без pointer-последовательности
     — и тогда тап всё равно должен сработать. */
  stage.addEventListener("click", (e) => {
    if (performance.now() - pointerSeqAt < 700) return;
    tap(e.target);
  });

  stage.addEventListener("wheel", (e) => {
    e.preventDefault(); stopTween(); touched = true; clearSpider(); beginGesture();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= vh;
    zoomAt(e.clientX, e.clientY, Math.pow(2, -d / 380));
    endGesture(); // перерисуемся, когда колесо затихнет
  }, { passive: false });

  stage.addEventListener("dblclick", (e) => { stopTween(); clearSpider(); beginGesture(); zoomAt(e.clientX, e.clientY, 2.2); endGesture(); });

  ROOT.getElementById("zin").onclick = () => { stopTween(); touched = true; clearSpider(); beginGesture(); zoomAt(vw / 2, vh / 2, 1.8); endGesture(); };
  ROOT.getElementById("zout").onclick = () => { stopTween(); touched = true; clearSpider(); beginGesture(); zoomAt(vw / 2, vh / 2, 1 / 1.8); endGesture(); };
  ROOT.getElementById("zhome").onclick = () => { stopTween(); closeSheet(); clearSpider(); homeView(true); };

  /* ------------------------------------------------------------- топонимы -- */
  const placeLayer = ROOT.getElementById("places");
  for (const p of PLACES){
    const el = document.createElement("div");
    el.className = "place " + p.kind;
    el.innerHTML = "<b></b>";
    const b = el.firstChild;
    b.textContent = p.t;
    b.style.fontSize = p.size + "px";
    b.style.transform = "translate(-50%,-50%)" + (p.rot ? " rotate(" + p.rot + "deg)" : "");
    el.style.opacity = "0";
    placeLayer.appendChild(el);
    p.el = el;
  }
  /* трапеция прозрачности в лог-шкале зума: ровный въезд и выезд */
  function placeFade(z, range){
    const l = Math.log(z), a = Math.log(range[0]), b = Math.log(range[1]);
    if (l <= a || l >= b) return 0;
    const w = (b - a) * 0.24;
    return Math.max(0, Math.min(1, (l - a) / w, (b - l) / w));
  }
  function layoutPlaces(z){
    for (const p of PLACES){
      const o = placeFade(z, p.z);
      p.el.style.opacity = o.toFixed(3);
      if (o <= 0){ p.el.style.visibility = "hidden"; continue; }
      p.el.style.visibility = "";
      p.el.style.transform = "translate3d(" + (p.p[0] * view.k + view.ox + BUF).toFixed(1) + "px," +
                                              (p.p[1] * view.k + view.oy + BUF).toFixed(1) + "px,0)";
    }
  }

  /* ------------------------------------------------------------- маркеры ---- */
  const layer = ROOT.getElementById("markers");
  const readout = ROOT.getElementById("readout");
  const flagNodes = new Map(), zoneNodes = new Map();

  const PAW = '<svg viewBox="0 0 24 24"><ellipse cx="12" cy="16.4" rx="5.1" ry="4.2"/><ellipse cx="5.6" cy="10.4" rx="2.5" ry="3.1"/><ellipse cx="18.4" cy="10.4" rx="2.5" ry="3.1"/><ellipse cx="9.4" cy="5.6" rx="2.3" ry="2.9"/><ellipse cx="14.6" cy="5.6" rx="2.3" ry="2.9"/></svg>';

  function flagNode(k){
    let n = flagNodes.get(k.id);
    if (n) return n;
    n = document.createElement("div");
    n.className = "marker" + (k.active ? " live" : "");
    n.dataset.case = k.id;
    n.innerHTML =
      '<div class="flag' + (k.active ? " act" : "") + '">' +
        (k.active ? '<span class="halo"></span><span class="halo d2"></span>' : '') +
        '<svg viewBox="0 0 19 25" width="19" height="25">' +
          '<path class="pole" d="M4 24.2V2.2"/>' +
          '<path class="cloth" d="M4.9 2.1 15.3 6.1 4.9 10.1Z"/>' +
          '<circle class="foot" cx="4" cy="24.2" r="1.9"/>' +
        '</svg>' +
        (k.mine ? '<span class="paw">' + PAW + '</span>' : '') +
      '</div>';
    layer.appendChild(n); flagNodes.set(k.id, n); return n;
  }
  function zoneNode(key){
    let n = zoneNodes.get(key);
    if (n) return n;
    n = document.createElement("div");
    n.className = "marker";
    n.innerHTML = '<div class="zone"><span class="ring"></span><span class="ring d2"></span>' +
                  '<span class="core"></span><span class="cap"></span></div>';
    layer.appendChild(n); zoneNodes.set(key, n); return n;
  }
  /* x,y — координаты сцены; внутри #world всё сдвинуто на запас BUF */
  function place(n, x, y, s, animate){
    const tr = "translate3d(" + (x + BUF).toFixed(1) + "px," + (y + BUF).toFixed(1) + "px,0)" + (s !== 1 ? " scale(" + s + ")" : "");
    if (animate && !n.classList.contains("anim")){
      n.classList.add("anim");
      clearTimeout(n._t); n._t = setTimeout(() => n.classList.remove("anim"), 460);
    }
    n.style.transform = tr;
  }

  /* Чем ближе к пределу зума, тем охотнее кластер распадается: у предела
     слипшимися остаются только по-настоящему совпадающие точки — их и раскрывает
     веер. Иначе большой радиус держал бы гроздь вместе там, где места полно. */
  function clusterRadius(){
    const base = vw < 480 ? 36 : 56;
    const t = Math.min(1, (view.k / kFit) / Z_MAX);
    return base * (1 - 0.38 * t);
  }
  /* диаметр зоны растёт от числа закрытых кейсов; одиночный флажок ~ 24px */
  function zoneDiameter(n){ return n < 2 ? 24 : Math.round(42 + Math.min(n, 30) * 1.1); }

  /* --------------------------------------------------------------- паутинка -- */
  /* Якорь веера хранится в единицах карты, поэтому веер честно едет вместе
     с картой при панорамировании и не «отклеивается» от места. */
  let spider = null;                       // { ids:Set<index>, mx, my }
  const legsEl = ROOT.getElementById("legs");
  const hub = document.createElement("div");
  hub.className = "hub"; hub.style.display = "none";
  ROOT.getElementById("markers").appendChild(hub);

  function spiderfy(n){
    if (!n._members || n._members.length < 2) return;
    spider = { ids: new Set(n._members), mx: n._cm[0], my: n._cm[1] };
    commit("веер");
  }
  function clearSpider(){ if (spider){ spider = null; invalidate(); } }

  function drawLegs(list){
    while (legsEl.childNodes.length > list.length) legsEl.removeChild(legsEl.lastChild);
    while (legsEl.childNodes.length < list.length) legsEl.appendChild(document.createElementNS(NS, "line"));
    list.forEach((L, i) => {
      const el = legsEl.childNodes[i];
      el.setAttribute("x1", (L[0] + BUF).toFixed(1)); el.setAttribute("y1", (L[1] + BUF).toFixed(1));
      el.setAttribute("x2", (L[2] + BUF).toFixed(1)); el.setAttribute("y2", (L[3] + BUF).toFixed(1));
    });
  }

  function layoutSpider(){
    if (!spider){ hub.style.display = "none"; drawLegs([]); return; }
    const hx = spider.mx * view.k + view.ox, hy = spider.my * view.k + view.oy;
    // порядок по настоящему азимуту — флажок уезжает примерно в свою сторону,
    // а не в случайную позицию списка
    const ids = [...spider.ids].sort((a, b) =>
      Math.atan2(CASES[a].p[1] - spider.my, CASES[a].p[0] - spider.mx) -
      Math.atan2(CASES[b].p[1] - spider.my, CASES[b].p[0] - spider.mx));
    const n = ids.length, legs = [];
    ids.forEach((idx, i) => {
      let a, r;
      if (n <= 10){ a = -Math.PI / 2 + i * 2 * Math.PI / n; r = 46 + n * 4.5; }
      else { a = -Math.PI / 2 + i * 0.62; r = 40 + i * 8; }    // спираль для плотных гнёзд
      const x = hx + Math.cos(a) * r, y = hy + Math.sin(a) * r;
      const node = flagNode(CASES[idx]);
      const was = node.dataset.st;
      node.dataset.st = "fan";
      node.classList.remove("hidden", "gone");
      place(node, x, y, 1, was !== "fan");
      legs.push([hx, hy, x, y]);
    });
    hub.style.display = "";
    hub.style.transform = "translate3d(" + (hx + BUF).toFixed(1) + "px," + (hy + BUF).toFixed(1) + "px,0)";
    drawLegs(legs);
  }

  function layoutMarkers(z){
    const R = clusterRadius(), R2 = R * R;
    const scr = CASES.map(k => [k.p[0] * view.k + view.ox, k.p[1] * view.k + view.oy]);
    // кластеризуются ТОЛЬКО закрытые кейсы (receipts). Активный кейс — живой
    // флажок, он никогда не прячется внутрь зоны.
    const groups = [];
    for (let i = 0; i < CASES.length; i++){
      if (CASES[i].active) continue;
      if (spider && spider.ids.has(i)) continue;   // разложенные веером живут отдельно
      let best = -1, bd = R2;
      for (let g = 0; g < groups.length; g++){
        const dx = scr[i][0] - groups[g].cx, dy = scr[i][1] - groups[g].cy;
        const d = dx * dx + dy * dy;
        if (d < bd){ bd = d; best = g; }
      }
      if (best < 0) groups.push({ m: [i], sx: scr[i][0], sy: scr[i][1], cx: scr[i][0], cy: scr[i][1] });
      else { const g = groups[best]; g.m.push(i); g.sx += scr[i][0]; g.sy += scr[i][1]; g.cx = g.sx / g.m.length; g.cy = g.sy / g.m.length; }
    }

    // Вторая проходка: жадная кластеризация иногда оставляет зоны, которые
    // визуально налезают друг на друга. Склеиваем всё, что пересекается по
    // нарисованному радиусу — карта перестаёт выглядеть сломанной.
    for (let again = true; again; ){
      again = false;
      search:
      for (let a = 0; a < groups.length; a++)
        for (let b = a + 1; b < groups.length; b++){
          const ra = zoneDiameter(groups[a].m.length) / 2, rb = zoneDiameter(groups[b].m.length) / 2;
          const dx = groups[a].cx - groups[b].cx, dy = groups[a].cy - groups[b].cy;
          if (Math.hypot(dx, dy) < (ra + rb) * 0.92){
            const A = groups[a], B = groups[b];
            A.m = A.m.concat(B.m); A.sx += B.sx; A.sy += B.sy;
            A.cx = A.sx / A.m.length; A.cy = A.sy / A.m.length;
            groups.splice(b, 1); again = true; break search;
          }
        }
    }

    const liveZones = new Set(), placed = [];
    const pad = 90;
    for (const g of groups){
      const solo = g.m.length === 1;
      const onScreen = g.cx > -pad && g.cx < vw + pad && g.cy > -pad && g.cy < vh + pad;
      if (solo){
        const k = CASES[g.m[0]], n = flagNode(k);
        const was = n.dataset.st;
        n.dataset.st = "solo";
        n.classList.remove("hidden", "gone");
        place(n, scr[g.m[0]][0], scr[g.m[0]][1], 1, was === "grp");
        if (!onScreen && was === n.dataset.st) n.classList.add("gone");
      } else {
        // флажки схлопываются в центр зоны
        for (const i of g.m){
          const n = flagNode(CASES[i]);
          const was = n.dataset.st;
          n.dataset.st = "grp";
          n.classList.remove("gone");
          n.classList.add("hidden");
          place(n, g.cx, g.cy, .45, was === "solo");
        }
        if (!onScreen) continue;
        const key = "z" + Math.min.apply(null, g.m);
        liveZones.add(key);
        const n = zoneNode(key), zone = n.firstChild;
        // и размер, и число зоны — это закрытые кейсы (FULFILLED-receipts)
        const closed = g.m.length;
        const d = zoneDiameter(closed);
        zone.style.width = zone.style.height = d + "px";
        zone.classList.remove("has-act");
        placed.push({ cx: g.cx, cy: g.cy, r: d / 2, el: zone });
        const core = zone.querySelector(".core");
        core.textContent = String(closed);
        core.style.fontSize = (d < 50 ? 14 : 15.5) + "px";
        const cap = zone.querySelector(".cap");
        cap.textContent = closed >= 3 ? regionOf(g) + " · " + closed + " " + plural(closed) : "";
        const reborn = !n._live;
        // возвращаясь в жизнь, зона не должна «доезжать» со старого места
        if (reborn) n.classList.remove("anim");
        n.classList.remove("gone", "hidden");
        n.dataset.zone = key;
        // bbox содержимого в единицах карты — для перелёта по тапу
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const i of g.m){
          const p = CASES[i].p;
          x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
          y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
        }
        n._box = [x0, y0, x1, y1];
        n._members = g.m.slice();
        n._cm = [(x0 + x1) / 2, (y0 + y1) / 2];
        n._live = true; clearTimeout(n._h);
        place(n, g.cx, g.cy, 1, false);
        if (reborn){
          n.classList.remove("fresh"); void n.offsetWidth; n.classList.add("fresh");
          clearTimeout(n._f); n._f = setTimeout(() => n.classList.remove("fresh"), 400);
        }
      }
    }
    // активные кейсы — поверх всего; попав в зону, «прикалываются» к её краю,
    // чтобы не закрывать число и не теряться под ним
    for (let i = 0; i < CASES.length; i++){
      if (!CASES[i].active) continue;
      const n = flagNode(CASES[i]);
      n.dataset.st = "solo";
      n.classList.remove("hidden", "gone");
      let x = scr[i][0], y = scr[i][1];
      for (const pz of placed){
        const dx = x - pz.cx, dy = y - pz.cy, dist = Math.hypot(dx, dy);
        if (dist < pz.r + 10){
          pz.el.classList.add("has-act");
          // фиксированный верхне-правый сектор: флажок «стоит» на ободе зоны,
          // не закрывая ни число внутри, ни подпись под ней
          const a = -0.72, off = pz.r + 13;
          x = pz.cx + Math.cos(a) * off;
          y = pz.cy + Math.sin(a) * off;
          break;
        }
      }
      place(n, x, y, 1, false);
      if (!(x > -pad && x < vw + pad && y > -pad && y < vh + pad)) n.classList.add("gone");
    }

    for (const [key, n] of zoneNodes) if (!liveZones.has(key) && n._live){
      n._live = false;
      n.classList.add("anim", "hidden");
      clearTimeout(n._h); n._h = setTimeout(() => n.classList.add("gone"), 300);
    }

    layoutSpider();
  }
  /* подпись зоны идёт по самому узкому общему уровню: район → страна → материк */
  function regionOf(g){
    const d = new Set(), r = new Set();
    for (const i of g.m){ d.add(CASES[i].district); r.add(CASES[i].region); }
    if (d.size === 1) return [...d][0];
    if (r.size === 1) return [...r][0];
    return "Европа";
  }
  function plural(n){
    const a = n % 10, b = n % 100;
    if (a === 1 && b !== 11) return "кейс";
    if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return "кейса";
    return "кейсов";
  }

  /* --------------------------------------------------------------- карточка -- */
  const sheet = ROOT.getElementById("sheet"), scrim = ROOT.getElementById("scrim");
  const money = new Intl.NumberFormat("ru-RU");
  function eur(v){ return money.format(v) + " €"; }

  function tap(target){
    const zn = target.closest && target.closest("[data-zone]");
    if (zn){ zoomToZone(zn); return; }
    const fn = target.closest && target.closest("[data-case]");
    if (fn){ openSheet(CASES.find(k => k.id === +fn.dataset.case)); return; }
    closeSheet(); clearSpider();
  }
  /* Тап по зоне: сначала пробуем приблизиться. Если приближать уже некуда
     (упёрлись в предел зума или точки физически слишком близко) — раскрываем
     зону веером, чтобы до каждого кейса всё-таки можно было дотянуться. */
  function zoomToZone(n){
    const b = n._box; if (!b) return;
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6);
    const fit = Math.min(vw * 0.55 / w, vh * 0.5 / h);
    let k1 = Math.min(view.k * 7, fit);
    k1 = Math.max(k1, view.k * 2);
    k1 = Math.min(k1, kFit * Z_MAX);          // предел зума сильнее «заметного шага»
    if (k1 <= view.k * 1.12){ spiderfy(n); return; }
    clearSpider();
    flyTo(k1, vw / 2 - cx * k1, vh / 2 - cy * k1, 620);
  }
  function openSheet(k){
    if (!k) return;
    ROOT.getElementById("s-name").textContent = k.name;
    ROOT.getElementById("s-sub").textContent = k.city + " · " + k.region + " · " + k.type;
    const st = ROOT.getElementById("s-st");
    st.classList.toggle("act", k.active);
    ROOT.getElementById("s-st-t").textContent = k.active ? "идёт сейчас" : "кейс закрыт";
    ROOT.getElementById("s-g").textContent = eur(k.g);
    ROOT.getElementById("s-o").textContent = eur(k.o);
    ROOT.getElementById("s-t").textContent = k.t ? eur(k.t) : "—";
    ROOT.getElementById("s-open-cell").classList.toggle("act", k.active);
    ROOT.getElementById("s-tr-cell").classList.toggle("act", k.active);
    ROOT.getElementById("s-photo").textContent = k.active
      ? "фото-отчёт появится после закрытия"
      : "фото-отчёт · " + k.photos + " " + (k.photos === 1 ? "фото" : "фото");
    ROOT.getElementById("s-season").textContent = k.season;
    ROOT.getElementById("s-mine").innerHTML = k.mine
      ? '<span class="mine">' + PAW + "здесь мой вклад</span>" : "";
    sheet.classList.add("on"); scrim.classList.add("on");
  }
  function closeSheet(){ sheet.classList.remove("on"); scrim.classList.remove("on"); }
  scrim.addEventListener("pointerdown", (e) => { e.stopPropagation(); closeSheet(); });
  scrim.addEventListener("click", (e) => { e.stopPropagation(); closeSheet(); });
  ON(document, "keydown", (e) => { if (e.key === "Escape") closeSheet(); });

  /* ------------------------------------------------ счётчик кадров (тройной тап) */
  /* Включается тройным тапом по бейджу «прототип · демо-данные». Меряет то, что
     важно на телефоне: не среднее, а хвост — сколько кадров ушло за 32мс. */
  const fpsBox = ROOT.getElementById("fps"), badge = ROOT.getElementById("badge");
  let fpsOn = false, fTimes = [], fLast = 0, fRaf = 0, fPaint = 0, fShown = 0;
  function fpsTick(now){
    if (!fpsOn){ fRaf = 0; return; }
    // разрыв больше полусекунды — это не «рывок», а пауза: не портим статистику
    if (fLast && now - fLast < 500){ fTimes.push(now - fLast); if (fTimes.length > 150) fTimes.shift(); }
    fLast = now;
    if (now - fShown > 260 && fTimes.length > 8){
      fShown = now;
      const s = fTimes.slice().sort((a, b) => a - b);
      const med = s[s.length >> 1], p95 = s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
      const long = fTimes.filter(x => x > 32).length;
      fpsBox.innerHTML =
        "<b>" + Math.round(1000 / med) + " fps</b>  медиана " + med.toFixed(1) + "мс\n" +
        "p95 " + p95.toFixed(1) + "мс   " +
        (long ? "<span class='bad'>рывков " + long + "</span>" : "рывков 0") + " / " + fTimes.length + "\n" +
        "commit " + (commitMs > 100 ? "<span class='bad'>" + commitMs.toFixed(0) + "мс</span>" : commitMs.toFixed(0) + "мс") +
        " (" + commitReason + ")  " + fPaint + "/с\n" +
        (detailOn ? "50m" : "110m") + " z" + Math.round(zoom()) +
        "  ячеек " + lastVisibleCount + "  биас " + lodBias.toFixed(1);
    }
    fRaf = requestAnimationFrame(fpsTick);
  }
  function toggleFps(){
    fpsOn = !fpsOn;
    fpsBox.hidden = !fpsOn;
    fTimes = []; fLast = 0; fPaint = 0; fShown = 0;
    if (fpsOn){ fpsBox.textContent = "замер…\nподвигайте карту"; if (!fRaf) fRaf = requestAnimationFrame(fpsTick); }
    else fpsBox.textContent = "";
  }
  let taps = 0, tapTimer = 0;
  badge.addEventListener("pointerup", () => {
    taps++; clearTimeout(tapTimer);
    if (taps >= 3){ taps = 0; toggleFps(); return; }
    tapTimer = setTimeout(() => { taps = 0; }, 600);
  });
  /* перерисовки считаем отдельно — это то, что мы и хотели свести к минимуму */
  EVERY(() => {
    if (!fpsOn) return;
    fPaint = repaints; repaints = 0;
    // пустая панель выглядела бы поломкой: честно говорим, что кадров нет
    if (performance.now() - fLast > 900){
      fpsBox.textContent = "кадры не идут\n(вкладка усыплена)";
      fTimes = []; fShown = 0;
      if (!fRaf) fRaf = requestAnimationFrame(fpsTick);
    }
  }, 1000);

  /* ------------------------------------------------------------------ boot -- */
  const hint = ROOT.getElementById("hint");
  function boot(){
    hint.textContent = matchMedia("(pointer: coarse)").matches
      ? "щипок — зум · перетащите карту"
      : "колесо — зум · перетащите карту";
    measure();
    homeView(false);
    setTimeout(() => { hint.style.opacity = "0"; }, 5200);
  }
  ON(window, "resize", () => {
    // до первого жеста вид ещё «свой» — пересобираем стартовый кадр заново
    // (важно и для Telegram WebApp: вьюпорт меняется при разворачивании)
    if (!touched){ measure(); homeView(false); return; }
    const mx = (vw / 2 - view.ox) / view.k, my = (vh / 2 - view.oy) / view.k;
    measure();
    view.ox = vw / 2 - mx * view.k; view.oy = vh / 2 - my * view.k;
    commit("ресайз");
  });
  boot();

  return () => { for (const off of CLEAN) off(); };
}
