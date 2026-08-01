// Гейт превью «карты помощи». Ровно один вопрос: просили ли нас показать карту.
//
// Два входа, оба явные:
//   startapp=helpmap  — боевой путь в Telegram (start_param приходит как есть,
//                       без нормализации, поэтому сравнение строгое);
//   ?helpmap=1        — путь для разработки в браузере.
//
// Fail-closed: любое другое значение — false. Префиксы не считаются
// (`helpmapper`, `?helpmap=2`), иначе гейт можно случайно открыть опечаткой.
export function helpMapPreviewRequested({ search = '', startParam = null } = {}) {
  if (startParam === 'helpmap') return true;
  try {
    return new URLSearchParams(String(search || '')).get('helpmap') === '1';
  } catch {
    return false;
  }
}
