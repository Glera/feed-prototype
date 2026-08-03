// Гейт превью «карты помощи». Ровно один вопрос: просили ли нас показать карту.
//
// Два входа, оба явные:
//   startapp=helpmap  — боевой путь в Telegram (start_param приходит как есть,
//                       без нормализации, поэтому сравнение строгое);
//   ?helpmap=1        — путь для разработки в браузере.
//
// Fail-closed: любое другое значение — false. Префиксы не считаются
// (`helpmapper`, `?helpmap=2`), иначе гейт можно случайно открыть опечаткой.
// Решение оператора 01.08.2026: превью включено ПО УМОЛЧАНИЮ — на платформе
// один пользователь (сам оператор), карта явно помечена «прототип ·
// демо-данные», риска для чужих сессий нет. Параметрный механизм сохранён:
// когда появятся реальные пользователи, вернуть гейт = заменить
// DEFAULT_ON на false (и обновить check-helpmap-preview).
// Явный выключатель нужен и при DEFAULT_ON: вкладка «Мета» — единственный
// вход в остров, поэтому сценарии, которым нужен именно остров (браузерные
// чеки островных путей), обязаны уметь отказаться от карты. `?helpmap=0`
// проверяется ПЕРВЫМ и перебивает всё остальное.
const DEFAULT_ON = true;

function param(search, name) {
  try {
    return new URLSearchParams(String(search || '')).get(name);
  } catch {
    return null;
  }
}

export function helpMapPreviewRequested({ search = '', startParam = null } = {}) {
  if (param(search, 'helpmap') === '0') return false;
  if (DEFAULT_ON) return true;
  if (startParam === 'helpmap') return true;
  return param(search, 'helpmap') === '1';
}
