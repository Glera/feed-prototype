/**
 * Focused founder/operator Mission preview.
 *
 * This surface renders production Mission components from the shared closed
 * fixture, but never calls a Mission endpoint and never touches storage. The
 * only network request is the normal authenticated `/api/session` read used to
 * prove the caller has the server-owned operator capability.
 */
import { apiSessionRequired, type SessionResp } from './api';
import {
  MISSION_DEMO_CONTRIBUTION,
  MISSION_DEMO_HISTORY,
  missionDemoCaseWire,
} from './mission-demo-fixture.mjs';
import { parseMissionCaseView, type MissionCaseView } from './mission-core.mjs';
import { missionDemoPresentation } from './mission-demo-presentation';
import {
  buildMissionCaseScreen,
  buildMissionFulfilledCeremony,
  buildMissionHudBar,
  buildMissionUnlockedCeremony,
  launchMissionPawFlight,
  updateMissionHudBar,
} from './mission-ui';

type DemoStage = 'active' | 'contribution' | 'unlocked' | 'fulfilled';
type DemoReward = 'ready' | 'opened' | 'next';

function operatorPreviewAvailable(session: SessionResp): boolean {
  return session.operator_level_flagging_available === true;
}

function demoView(stage: DemoStage, rewarded: boolean): MissionCaseView {
  const options = stage === 'active' || (stage === 'contribution' && !rewarded)
    ? { progress: 4, caseTokens: 2 }
    : stage === 'contribution'
      ? { progress: 5, caseTokens: 3 }
      : stage === 'unlocked'
        ? { progress: 50, caseTokens: 3, unlockedSeq: 8 }
        : { progress: 50, caseTokens: 3, unlockedSeq: 8, fulfilledSeq: 9 };
  const parsed = parseMissionCaseView(missionDemoCaseWire(options));
  if (!parsed) throw new Error('mission_demo_fixture_invalid');
  return parsed;
}

function button(label: string, stage: DemoStage): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'mission-demo__tab';
  node.dataset.stage = stage;
  node.textContent = label;
  return node;
}

function mountError(viewport: HTMLElement, detail: string): void {
  const root = document.createElement('section');
  root.className = 'mission-demo mission-demo--error';
  root.dataset.testid = 'mission-demo-error';
  const badge = document.createElement('div');
  badge.className = 'mission-demo__badge';
  badge.textContent = 'Демо · тестовые данные';
  const title = document.createElement('strong');
  title.textContent = 'Mission demo недоступно';
  const copy = document.createElement('span');
  copy.textContent = detail;
  root.append(badge, title, copy);
  viewport.replaceChildren(root);
}

export async function mountMissionDemo(): Promise<void> {
  document.body.classList.add('mission-demo-open');
  const viewport = document.getElementById('viewport');
  if (!viewport) return;

  const loading = document.createElement('section');
  loading.className = 'mission-demo mission-demo--loading';
  loading.textContent = 'Проверяю операторский доступ…';
  viewport.replaceChildren(loading);

  let session: SessionResp;
  try {
    session = await apiSessionRequired();
  } catch {
    mountError(viewport, 'Открой ссылку заново внутри Telegram под операторским аккаунтом.');
    return;
  }
  if (!operatorPreviewAvailable(session)) {
    mountError(viewport, 'Сервер не подтвердил операторский доступ.');
    return;
  }

  const root = document.createElement('section');
  root.className = 'mission-demo';
  root.dataset.testid = 'mission-demo';

  const badge = document.createElement('div');
  badge.className = 'mission-demo__badge';
  badge.dataset.testid = 'mission-demo-badge';
  badge.textContent = 'Демо · тестовые данные';

  const chrome = document.createElement('header');
  chrome.className = 'mission-demo__chrome';
  const heading = document.createElement('div');
  heading.className = 'mission-demo__heading';
  heading.innerHTML = '<strong>Mission · шаблоны</strong><span>Никаких реальных кейсов, денег или вкладов</span>';

  const scene = document.createElement('div');
  scene.className = 'mission-demo__scene';
  const hud = buildMissionHudBar(
    () => render('active'),
    () => {
      // Keep the selected scenario and its progress; ⓘ is not a reset control.
      scene.querySelector<HTMLButtonElement>('.mission-contract__summary')?.click();
    },
  );
  hud.classList.add('mission-demo__hud');

  const tabs = document.createElement('nav');
  tabs.className = 'mission-demo__tabs';
  tabs.setAttribute('aria-label', 'Сценарии Mission demo');
  const choices = [
    button('Кейс', 'active'),
    button('Вклад', 'contribution'),
    button('Открыт', 'unlocked'),
    button('Передан', 'fulfilled'),
  ];
  tabs.append(...choices);
  chrome.append(heading, hud, tabs);
  root.append(badge, chrome, scene);
  viewport.replaceChildren(root);

  let stage: DemoStage = 'active';
  let currentReward: DemoReward = 'ready';
  let stageAbort = new AbortController();
  let disposed = false;
  let suspended = false;
  const pause = (): void => { suspended = true; stageAbort.abort(); };
  const resume = (): void => {
    if (!suspended || disposed) return;
    suspended = false;
    render(stage, currentReward);
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    stageAbort.abort();
    removalObserver.disconnect();
    window.removeEventListener('pagehide', pause);
    window.removeEventListener('pageshow', resume);
  };
  const removalObserver = new MutationObserver(() => {
    if (!root.isConnected) dispose();
  });
  removalObserver.observe(viewport, { childList: true });
  window.addEventListener('pagehide', pause);
  window.addEventListener('pageshow', resume);

  function render(next: DemoStage, rewardPhase: DemoReward = 'ready'): void {
    if (disposed) return;
    stageAbort.abort();
    stageAbort = new AbortController();
    stage = next;
    currentReward = rewardPhase;
    const rewarded = rewardPhase !== 'ready';
    const view = demoView(stage, rewarded);
    const active = view.activeCase;
    if (!active) return;
    updateMissionHudBar(hud, stage === 'contribution' && rewardPhase === 'opened'
      ? { ...active.bar, nextStepThreshold: MISSION_DEMO_CONTRIBUTION.openedGiftSteps[0].thresholdTokens }
      : active.bar);
    for (const choice of choices) choice.dataset.active = String(choice.dataset.stage === stage);

    scene.replaceChildren();
    const history = stage === 'active' || (stage === 'contribution' && !rewarded) ? [] : MISSION_DEMO_HISTORY;
    const screen = buildMissionCaseScreen({
      view,
      history,
      preview: missionDemoPresentation(active.caseId),
      ...(stage === 'contribution' && rewarded ? {
        openedGift: {
          amountCents: MISSION_DEMO_CONTRIBUTION.openedGiftSteps[0].amountCents,
          nextStepThreshold: active.bar.nextStepThreshold,
          ...(rewardPhase === 'opened' ? { justOpenedThreshold: MISSION_DEMO_CONTRIBUTION.openedGiftSteps[0].thresholdTokens } : {}),
        },
      } : {}),
      onClose: () => render('active'),
    });
    screen.classList.add('mission-demo__case');
    scene.appendChild(screen);

    if (stage === 'contribution' && !rewarded) {
      const reward = document.createElement('button');
      reward.type = 'button';
      reward.className = 'mission-demo__reward';
      reward.textContent = 'Получить тестовую лапку';
      screen.querySelector('.mission-meter')?.after(reward);
      const signal = stageAbort.signal;
      reward.addEventListener('click', () => {
        if (reward.disabled || signal.aborted) return;
        reward.disabled = true;
        reward.textContent = 'Лапка летит к подарку…';
        launchMissionPawFlight(MISSION_DEMO_CONTRIBUTION, reward, hud, root, {
          signal,
          onSettled: () => { if (!signal.aborted) render('contribution', 'opened'); },
        });
      });
    } else if (stage === 'contribution' && rewardPhase === 'opened') {
      const nextGift = document.createElement('button');
      nextGift.type = 'button';
      nextGift.className = 'mission-demo__next-gift';
      nextGift.textContent = 'К следующему подарку';
      nextGift.addEventListener('click', () => render('contribution', 'next'));
      screen.querySelector('.mission-gift-opened')?.append(nextGift);
    } else if (stage === 'unlocked' && view.lastUnlocked) {
      scene.appendChild(buildMissionUnlockedCeremony({
        event: view.lastUnlocked,
        currency: active.money.currency,
        preview: missionDemoPresentation(view.lastUnlocked.caseId),
        onClose: () => render('active'),
      }));
    } else if (stage === 'fulfilled' && view.lastFulfilled) {
      scene.appendChild(buildMissionFulfilledCeremony({
        event: view.lastFulfilled,
        currency: active.money.currency,
        preview: missionDemoPresentation(view.lastFulfilled.caseId),
        onClose: () => render('active'),
      }));
    }
  }

  for (const choice of choices) {
    choice.addEventListener('click', () => render(choice.dataset.stage as DemoStage));
  }
  render('active');
}
