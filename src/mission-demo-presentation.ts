import type { MissionPreviewPresentation } from './mission-ui';

/** Local illustration and explicitly fictional story, never Backend wire/media.
 * Each renderer receives the matching case ID explicitly, including old events. */
export function missionDemoPresentation(caseId: string): MissionPreviewPresentation {
  return {
    fictional: true,
    caseId,
    title: 'Полные миски в приюте «Лапа»',
    summary: 'Мурка и её соседи ждут обед в приюте «Лапа». Первый подарок — 10 кг корма; лапки сообщества помогают открыть ещё два подарка.',
    outcome: 'Корм уже привезли в «Лапу». Мурка пообедала, миски её соседей полны, а у приюта появился запас на ближайшие дни.',
    reportRecipient: 'для «Лапы»',
    caption: 'Иллюстрация · вымышленный приют «Лапа»',
    illustration: () => {
      const drawing = document.createElement('div');
      drawing.className = 'mission-demo-illustration';
      drawing.setAttribute('aria-hidden', 'true');
      drawing.innerHTML = '<svg viewBox="0 0 360 180" xmlns="http://www.w3.org/2000/svg" focusable="false">'
        + '<circle cx="283" cy="39" r="22" fill="#ffe08a" opacity=".7"/>'
        + '<path d="M18 154Q97 115 180 141T346 145" fill="none" stroke="#554476" stroke-width="20" stroke-linecap="round"/>'
        + '<path d="M190 86l48-42 48 42v62h-96z" fill="#554476"/><path d="M180 87l58-52 58 52" fill="none" stroke="#b9a0f5" stroke-width="9" stroke-linecap="round"/>'
        + '<path d="M224 148v-28a14 14 0 0 1 28 0v28" fill="#21192f"/>'
        + '<path d="M71 82L67 53l24 16q16-7 30 0l24-16-4 29q16 35-35 39Q56 118 71 82" fill="#e5c79a"/>'
        + '<ellipse cx="106" cy="139" rx="27" ry="32" fill="#d8b384"/><circle cx="88" cy="87" r="3" fill="#21192f"/><circle cx="123" cy="87" r="3" fill="#21192f"/>'
        + '<path d="M101 98l5 4 5-4M106 102v7" fill="none" stroke="#72546a" stroke-width="3" stroke-linecap="round"/>'
        + '<path d="M135 150h47l-7 20h-33z" fill="#b9a0f5"/><ellipse cx="158" cy="150" rx="24" ry="6" fill="#ffe08a"/>'
        + '<path d="M40 132q-18 18 26 24" fill="none" stroke="#d8b384" stroke-width="10" stroke-linecap="round"/>'
        + '</svg>';
      return drawing;
    },
  };
}
