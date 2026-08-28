import {
  apiAdoptSourcePreview,
  apiSourcePreviewSessionRequired,
  type DeveloperFeedAdoptionV1,
  type PlayableReleaseDecisionReceipt,
  type SessionResp,
} from './api';
import type { CandidateFeedPreviewIdentity } from './candidate-feed-preview';
import { candidateFeedStartParamRequested } from './candidate-feed-start-param.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const DEVELOPER_FEED_HANDOFF_KEY = 'candidate_feed_developer_handoff_once_v1';

export function consumeDeveloperFeedHandoff(startParam: string | null): boolean {
  let armed: string | null = null;
  try {
    armed = sessionStorage.getItem(DEVELOPER_FEED_HANDOFF_KEY);
    sessionStorage.removeItem(DEVELOPER_FEED_HANDOFF_KEY);
  } catch {
    return false;
  }
  return typeof startParam === 'string'
    && candidateFeedStartParamRequested(startParam)
    && armed === startParam;
}

function exactAdoption(
  value: DeveloperFeedAdoptionV1 | undefined,
  candidate: CandidateFeedPreviewIdentity,
): value is DeveloperFeedAdoptionV1 {
  return Boolean(value)
    && value?.schema === 'feed.playable-source-preview-adoption.v1'
    && value.releaseId.toLowerCase() === candidate.releaseId.toLowerCase()
    && value.playableId === candidate.playableId
    && value.candidatePath === candidate.candidatePath
    && value.candidateArtifactDigest === candidate.candidateArtifactDigest
    && value.reviewBindingDigest === candidate.reviewBindingDigest
    && /^[0-9a-f]{40}$/.test(value.sourceCommit)
    && DIGEST.test(value.receiptDigest)
    && value.audience === 'exact-user'
    && value.publicRollout === false;
}

function exactReceipt(
  value: PlayableReleaseDecisionReceipt,
  candidate: CandidateFeedPreviewIdentity,
  actorUserId: number,
): boolean {
  return value.schema === 'feed.playable-release-decision.receipt.v1'
    && value.decisionSchema === 'feed.playable-release-decision.v1'
    && UUID.test(value.decisionId) && UUID.test(value.mutationId)
    && value.releaseId.toLowerCase() === candidate.releaseId.toLowerCase()
    && value.actorUserId === actorUserId
    && value.reviewBindingDigest === candidate.reviewBindingDigest
    && value.candidateArtifactDigest === candidate.candidateArtifactDigest
    && value.decision === 'accept' && value.instruction === null
    && value.audience === 'exact-user' && value.publicRollout === false
    && ['approved', 'awaiting_exact_authorization'].includes(
      value.authorization?.state ?? '',
    )
    && value.successor === null && DIGEST.test(value.receiptDigest);
}

function openDeveloperFeed(startParam: string): void {
  if (!candidateFeedStartParamRequested(startParam)) return;
  try {
    sessionStorage.setItem(DEVELOPER_FEED_HANDOFF_KEY, startParam);
  } catch {
    return;
  }
  const url = new URL('/', location.origin);
  location.replace(url.toString());
}

export function mountCandidateFeedAdoption(
  candidate: CandidateFeedPreviewIdentity,
  session: SessionResp | null,
  startParam: string | null,
): HTMLElement | null {
  const actorUserId = session?.user?.id;
  if (!session?.operator_level_flagging_available
    || !session.catalog_lab_authorization_available
    || !Number.isSafeInteger(actorUserId) || Number(actorUserId) <= 0) return null;

  const panel = document.createElement('section');
  panel.className = 'candidate-feed-adoption';
  panel.dataset.testid = 'candidate-feed-adoption';
  const label = document.createElement('span');
  label.textContent = 'Аудитория: Только мне';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'candidate-feed-adoption__button';
  const status = document.createElement('span');
  status.className = 'candidate-feed-adoption__status';
  status.setAttribute('aria-live', 'polite');
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'candidate-feed-adoption__open';
  open.textContent = 'Открыть dev-ленту';
  open.hidden = true;
  open.addEventListener('click', () => {
    if (startParam !== null) openDeveloperFeed(startParam);
  });
  panel.append(label, button, status, open);

  let pending = false;
  let adopted = exactAdoption(session.developerFeedAdoption, candidate);
  const mutationId = crypto.randomUUID();
  const render = (): void => {
    button.disabled = pending || adopted;
    button.textContent = adopted ? 'Добавлено в dev-ленту' : 'Добавить в dev-ленту';
    status.textContent = pending
      ? 'Фиксируем exact-user receipt…'
      : adopted ? 'Exact candidate сохранён только для вашего Feed.' : 'Public-лента не изменится.';
    open.hidden = !adopted;
    panel.dataset.state = pending ? 'pending' : adopted ? 'adopted' : 'ready';
  };
  const reconcile = async (): Promise<boolean> => {
    try {
      const refreshed = await apiSourcePreviewSessionRequired();
      return exactAdoption(refreshed.developerFeedAdoption, candidate);
    } catch {
      return false;
    }
  };
  button.addEventListener('click', () => {
    if (pending || adopted) return;
    pending = true;
    render();
    void apiAdoptSourcePreview(candidate.releaseId, {
      schema: 'feed.playable-source-preview-adoption.v1',
      mutationId,
      reviewBindingDigest: candidate.reviewBindingDigest,
    }).then(async (receipt) => {
      if (!exactReceipt(receipt, candidate, Number(actorUserId))) {
        throw new Error('source preview adoption receipt mismatch');
      }
      adopted = true;
    }).catch(async () => {
      adopted = await reconcile();
      if (!adopted) status.textContent = 'Dev-adoption не подтверждён. Public-лента не изменена.';
    }).finally(() => {
      pending = false;
      render();
    });
  });
  render();
  return panel;
}
