import {
  ApiRequestError,
  apiCatalogLabDecision,
  apiCatalogLabLookup,
  apiCatalogLabTokens,
  apiRevokeCatalogLabToken,
  type CatalogLabDeviceAuthorization,
  type CatalogLabGrantView,
  type CatalogLabSubmitterMachine,
  type CatalogPromotionSummary,
} from './api';
import { showConfirm } from './telegram';
import {
  catalogFeedUrl,
  catalogLabOpenedFromFeed,
} from './catalog-lab-navigation.mjs';
import {
  mountPlayableCandidateReview,
  type CandidateReviewState,
  type MountedCandidateReview,
} from './candidate-review';

const USER_CODE_ALPHABET = new Set('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
const REVOKE_REASON = 'revoked from Telegram Catalog Lab panel';
const DESKTOP_INTAKE_SCOPE = 'operator:flags:write';

type Decision = 'approve' | 'deny';

function requiresSubmitterMachine(authorization: CatalogLabDeviceAuthorization): boolean {
  // Treat any occurrence of the privileged desktop-intake scope as requiring
  // an explicit binding. The backend still owns the exact single-scope
  // contract and rejects mixed/invalid scope sets; the client must never make
  // a server contract expansion silently disable the operator control.
  return authorization.scopes.includes(DESKTOP_INTAKE_SCOPE);
}

function submitterMachineLabel(machine: unknown): string {
  if (machine === 'mac-a') return 'Mac A — Platform';
  if (machine === 'mac-b') return 'Mac B — Content / Labs';
  return `Unknown workspace binding (${String(machine)})`;
}

function normalizeUserCode(value: string): string | null {
  const compact = value.trim().toUpperCase().replace(/[\s-]/g, '');
  if (compact.length !== 10 || [...compact].some((char) => !USER_CODE_ALPHABET.has(char))) {
    return null;
  }
  return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}

function formatCodeInput(value: string): string {
  const compact = [...value.toUpperCase()]
    .filter((char) => USER_CODE_ALPHABET.has(char))
    .slice(0, 10)
    .join('');
  return compact.length > 5 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function scopeLabel(scopes: string[]): string {
  return scopes.length ? scopes.join(', ') : 'No scopes requested';
}

function button(label: string, className = ''): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `lab-auth__button ${className}`.trim();
  element.textContent = label;
  return element;
}

function detail(label: string, value: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'lab-auth__detail';
  const key = document.createElement('span');
  key.className = 'lab-auth__detail-label';
  key.textContent = label;
  const content = document.createElement('span');
  content.className = 'lab-auth__detail-value';
  content.textContent = value;
  row.append(key, content);
  return row;
}

function promotionSummaryView(
  summary: CatalogPromotionSummary,
  candidateReview: HTMLElement | null = null,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'lab-auth__promotion';
  section.dataset.testid = 'catalog-promotion-summary';

  const header = document.createElement('div');
  header.className = 'lab-auth__promotion-header';
  const heading = document.createElement('h3');
  const batch = summary.schema === 'catalog.promotion-summary-batch.v1';
  const artifact = summary.schema === 'catalog.artifact-promotion-summary.v1';
  const playableRelease = summary.schema === 'feed.playable-release-summary.v1';
  heading.textContent = batch
    ? 'Exact publication batch'
    : artifact ? 'Exact raster-art world'
      : playableRelease ? 'Exact playable release' : 'Exact series to publish';
  const count = document.createElement('span');
  count.className = 'lab-auth__promotion-count';
  count.textContent = batch
    ? `${summary.items.length} visual variants`
    : artifact
      ? summary.title
      : playableRelease
        ? `${summary.mode} · ${summary.playableId}`
      : `${summary.levels.length} ${summary.levels.length === 1 ? 'level' : 'levels'}`;
  header.append(heading, count);

  const identity = document.createElement('div');
  identity.className = 'lab-auth__promotion-identity';
  identity.append(detail(batch ? 'Batch ID' : 'Publish ID', summary.publishId));
  if (playableRelease) {
    identity.append(
      detail('Playable', summary.playableId),
      detail('Mode', summary.mode),
      detail('Source commit', summary.sourceCommit),
      detail('Previous runtime', summary.previousRuntimeArtifactDigest ?? 'new'),
      detail('Runtime artifact', summary.runtimeArtifactDigest),
      ...(summary.manifestEntryDigest
        ? [detail('Approved manifest entry', summary.manifestEntryDigest)] : []),
      detail(
        summary.mode === 'add' ? 'Production manifest CAS' : 'Candidate-time manifest base',
        summary.productionManifestDigest ?? summary.candidateManifestDigest ?? 'legacy unavailable',
      ),
      detail('Tall cover', summary.coverDigests.tall),
      detail('Compact cover', summary.coverDigests.compact),
      detail('Series length', String(summary.seriesLength)),
    );
    if (summary.mode === 'add' && summary.rosterDiff) {
      identity.append(
        detail('Catalog mechanic', summary.catalogMechanic ?? 'invalid'),
        detail(
          'Roster change',
          `Добавить ${summary.rosterDiff.addedPlayableId} после ${summary.rosterDiff.afterPlayableId}`,
        ),
        detail(
          'Existing roster',
          summary.rosterDiff.removedPlayableIds.length === 0
            && !summary.rosterDiff.reorderedExisting
            ? 'Без удалений и перестановок'
            : 'Изменение старых механик — отклонить',
        ),
      );
    }
  } else if (artifact) {
    identity.append(
      detail('Title', summary.title),
      detail('Review target', summary.reviewTargetId),
      detail('Art pack', summary.artPackHash),
      detail('Runtime artifact', summary.runtimeArtifactDigest),
      detail('Gameplay fingerprint', summary.gameplayFingerprint),
      detail('Presentation fingerprint', summary.presentationFingerprint),
    );
  } else if (!batch) {
    identity.append(
      detail('Mechanic', summary.mechanic),
      detail('Variant', summary.variant),
      detail('Runtime artifact', summary.runtimeArtifactDigest),
    );
  }
  identity.append(
    detail('Request hash', summary.requestHash),
    detail('Content hash', summary.contentHash),
    ...(playableRelease ? [] : [detail('Reason', summary.reason)]),
  );

  const levels = document.createElement('ol');
  levels.className = 'lab-auth__promotion-levels';
  levels.setAttribute('aria-label', batch ? 'Ordered publication batch' : 'Ordered series levels');
  if (playableRelease) {
    const item = document.createElement('li');
    item.className = 'lab-auth__promotion-level';
    const itemHeading = document.createElement('strong');
    itemHeading.textContent = 'In-platform exact candidate review';
    item.appendChild(itemHeading);
    if (candidateReview) item.appendChild(candidateReview);
    levels.appendChild(item);
  } else if (artifact) {
    const item = document.createElement('li');
    item.className = 'lab-auth__promotion-level';
    const itemHeading = document.createElement('strong');
    itemHeading.textContent = summary.title;
    const itemDetails = document.createElement('div');
    itemDetails.className = 'lab-auth__promotion-level-details';
    itemDetails.append(
      detail('Description', summary.description),
      detail('Review target', summary.reviewTargetId),
    );
    item.append(itemHeading, itemDetails);
    levels.appendChild(item);
  } else if (batch) {
    for (const entry of summary.items) {
      const item = document.createElement('li');
      item.className = 'lab-auth__promotion-level';
      const levelHeading = document.createElement('strong');
      levelHeading.textContent = `${entry.ordinal}. ${entry.summary.skin ? 'Sort skin' : 'Sort series'}`;
      const levelDetails = document.createElement('div');
      levelDetails.className = 'lab-auth__promotion-level-details';
      levelDetails.append(
        detail('Publish ID', entry.publishId),
        detail('Content hash', entry.contentHash),
        detail('Skin hash', entry.summary.skin?.skinHash ?? 'default'),
        detail('Skin review', entry.summary.skin?.reviewTargetId ?? 'n/a'),
      );
      item.append(levelHeading, levelDetails);
      levels.appendChild(item);
    }
  } else {
    for (const level of summary.levels) {
      const item = document.createElement('li');
      item.className = 'lab-auth__promotion-level';
      const levelHeading = document.createElement('strong');
      levelHeading.textContent = `Level ${level.ordinal}`;
      const levelDetails = document.createElement('div');
      levelDetails.className = 'lab-auth__promotion-level-details';
      levelDetails.append(
        detail('Spec hash', level.specHash),
        detail('Evaluation', level.evaluationId),
        detail('Review target', level.reviewTargetId),
      );
      item.append(levelHeading, levelDetails);
      levels.appendChild(item);
    }
  }

  section.append(header, identity, levels);
  return section;
}

function isAccountUnavailable(error: unknown): boolean {
  return error instanceof ApiRequestError && [401, 403].includes(error.status);
}

function isFeatureUnavailable(error: unknown): boolean {
  return isAccountUnavailable(error)
    || (error instanceof ApiRequestError && error.status === 404);
}

function lookupErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Could not check this code. Try again.';
  switch (error.status) {
    case 0: return 'Cannot reach the server. Check your connection and try again.';
    case 404: return 'Code not found. Check it and try again.';
    case 410: return 'This code has expired. Request a new one on the Lab computer.';
    case 422: return 'The code format is invalid.';
    case 429: return 'Too many checks. Wait a few minutes and try again.';
    default: return 'Could not check this code. Try again.';
  }
}

function decisionErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'Could not save the decision. Try again.';
  if (error.code === 'device_authorization_machine_binding_unconfirmed') {
    return 'The server did not confirm this Mac binding. No desktop access is considered ready.';
  }
  switch (error.status) {
    case 0: return 'Cannot reach the server. Your decision was not confirmed.';
    case 404: return 'This request is no longer available.';
    case 409: return 'This request changed on the server. Check the code again.';
    case 410: return 'This request expired before the decision was saved.';
    default: return 'Could not save the decision. Try again.';
  }
}

function closeMiniApp(): void {
  // Feed navigation is an in-app round trip. Preserve Telegram's signed launch
  // fragment and every unrelated feed query while removing only our route.
  if (catalogLabOpenedFromFeed(location.search)) {
    location.replace(catalogFeedUrl(location.href));
    return;
  }
  const telegram = (window as any).Telegram?.WebApp;
  try {
    if (typeof telegram?.close === 'function') {
      telegram.close();
      return;
    }
  } catch { /* browser fallback below */ }
  location.replace(catalogFeedUrl(location.href));
}

export async function mountCatalogLabAuth(): Promise<void> {
  document.body.classList.add('lab-auth-open');

  const root = document.createElement('main');
  root.className = 'lab-auth';
  root.setAttribute('aria-label', 'Catalog Lab authorization');

  const shell = document.createElement('div');
  shell.className = 'lab-auth__shell';

  const header = document.createElement('header');
  header.className = 'lab-auth__header';
  const brand = document.createElement('div');
  brand.className = 'lab-auth__brand';
  const brandMark = document.createElement('span');
  brandMark.className = 'lab-auth__brand-mark';
  brandMark.textContent = 'LAB';
  const brandText = document.createElement('span');
  brandText.textContent = 'Catalog access';
  brand.append(brandMark, brandText);
  const close = button('Close', 'lab-auth__button--quiet lab-auth__close');
  close.addEventListener('click', closeMiniApp);
  header.append(brand, close);

  const intro = document.createElement('section');
  intro.className = 'lab-auth__intro';
  const title = document.createElement('h1');
  title.textContent = 'Authorize a Lab computer';
  const copy = document.createElement('p');
  copy.textContent = 'Enter the one-time code shown by Mechanic Lab. Review the device and permission before you approve it.';
  intro.append(title, copy);

  const unavailable = document.createElement('section');
  unavailable.className = 'lab-auth__notice lab-auth__notice--unavailable';
  unavailable.hidden = true;
  const unavailableTitle = document.createElement('strong');
  unavailableTitle.textContent = 'Catalog Lab access is unavailable';
  const unavailableCopy = document.createElement('span');
  unavailableCopy.textContent = 'This account or backend build cannot authorize Lab devices.';
  unavailable.append(unavailableTitle, unavailableCopy);

  const codeSection = document.createElement('section');
  codeSection.className = 'lab-auth__card';
  const form = document.createElement('form');
  form.className = 'lab-auth__form';
  form.noValidate = true;
  const label = document.createElement('label');
  label.className = 'lab-auth__label';
  label.htmlFor = 'catalog-lab-user-code';
  label.textContent = 'One-time code';
  const input = document.createElement('input');
  input.id = 'catalog-lab-user-code';
  input.className = 'lab-auth__input';
  input.type = 'text';
  input.inputMode = 'text';
  input.placeholder = 'ABCDE-FG234';
  input.maxLength = 11;
  input.autocomplete = 'off';
  input.autocapitalize = 'characters';
  input.spellcheck = false;
  input.setAttribute('autocorrect', 'off');
  input.setAttribute('data-lpignore', 'true');
  input.setAttribute('aria-describedby', 'catalog-lab-code-help');
  const help = document.createElement('p');
  help.id = 'catalog-lab-code-help';
  help.className = 'lab-auth__help';
  help.textContent = '10 characters. Never approve a request you did not start yourself.';
  const lookup = button('Review request', 'lab-auth__button--primary');
  lookup.type = 'submit';
  const formStatus = document.createElement('p');
  formStatus.className = 'lab-auth__status';
  formStatus.setAttribute('aria-live', 'polite');
  form.append(label, input, help, lookup, formStatus);
  codeSection.appendChild(form);

  const requestSection = document.createElement('section');
  requestSection.className = 'lab-auth__card lab-auth__request';
  requestSection.hidden = true;
  const requestEyebrow = document.createElement('div');
  requestEyebrow.className = 'lab-auth__eyebrow';
  requestEyebrow.textContent = 'Permission request';
  const requestTitle = document.createElement('h2');
  const requestDetails = document.createElement('div');
  requestDetails.className = 'lab-auth__details';
  const requestWarning = document.createElement('p');
  requestWarning.className = 'lab-auth__notice';
  requestWarning.textContent = 'Approval lets this computer submit validated evaluation results. It does not grant feed, reset, or model API access.';
  const submitterMachine = document.createElement('fieldset');
  submitterMachine.className = 'lab-auth__machine';
  submitterMachine.hidden = true;
  submitterMachine.dataset.testid = 'catalog-lab-submitter-machine';
  const submitterMachineLegend = document.createElement('legend');
  submitterMachineLegend.textContent = 'Which trusted workspace started this request?';
  const submitterMachineHelp = document.createElement('p');
  submitterMachineHelp.id = 'catalog-lab-submitter-machine-help';
  submitterMachineHelp.textContent = 'Choose explicitly. The computer name and one-time code never decide this binding.';
  submitterMachine.setAttribute('aria-describedby', submitterMachineHelp.id);
  const submitterMachineChoices = document.createElement('div');
  submitterMachineChoices.className = 'lab-auth__machine-choices';
  const machineInputs = new Map<CatalogLabSubmitterMachine, HTMLInputElement>();
  for (const [value, labelText] of [
    ['mac-a', 'Mac A — Platform'],
    ['mac-b', 'Mac B — Content / Labs'],
  ] as const) {
    const label = document.createElement('label');
    label.className = 'lab-auth__machine-choice';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'catalog-lab-submitter-machine';
    radio.value = value;
    radio.disabled = true;
    const labelCopy = document.createElement('span');
    labelCopy.textContent = labelText;
    label.append(radio, labelCopy);
    submitterMachineChoices.appendChild(label);
    machineInputs.set(value, radio);
  }
  submitterMachine.append(submitterMachineLegend, submitterMachineHelp, submitterMachineChoices);
  const decisionButtons = document.createElement('div');
  decisionButtons.className = 'lab-auth__actions';
  const deny = button('Deny', 'lab-auth__button--danger');
  const approve = button('Approve', 'lab-auth__button--approve');
  decisionButtons.append(deny, approve);
  const decisionStatus = document.createElement('p');
  decisionStatus.className = 'lab-auth__status';
  decisionStatus.setAttribute('aria-live', 'polite');
  const requestReset = button('Use another code', 'lab-auth__button--quiet lab-auth__button--small');
  requestSection.append(
    requestEyebrow,
    requestTitle,
    requestDetails,
    requestWarning,
    submitterMachine,
    decisionButtons,
    decisionStatus,
    requestReset,
  );

  const successSection = document.createElement('section');
  successSection.className = 'lab-auth__card lab-auth__success';
  successSection.hidden = true;
  const successMark = document.createElement('div');
  successMark.className = 'lab-auth__success-mark';
  successMark.textContent = '✓';
  const successTitle = document.createElement('h2');
  const successCopy = document.createElement('p');
  const another = button('Check another code', 'lab-auth__button--quiet');
  successSection.append(successMark, successTitle, successCopy, another);

  const grantsSection = document.createElement('section');
  grantsSection.className = 'lab-auth__grants';
  const grantsHeader = document.createElement('div');
  grantsHeader.className = 'lab-auth__section-header';
  const grantsHeading = document.createElement('h2');
  grantsHeading.textContent = 'Active Lab access';
  const refreshGrants = button('Refresh', 'lab-auth__button--quiet lab-auth__button--small');
  grantsHeader.append(grantsHeading, refreshGrants);
  const grantsStatus = document.createElement('p');
  grantsStatus.className = 'lab-auth__status';
  grantsStatus.setAttribute('aria-live', 'polite');
  const grantsList = document.createElement('div');
  grantsList.className = 'lab-auth__grant-list';
  grantsSection.append(grantsHeader, grantsStatus, grantsList);

  const privacy = document.createElement('p');
  privacy.className = 'lab-auth__privacy';
  privacy.textContent = 'The one-time code is kept only until your decision and is never saved on this device.';

  shell.append(
    header,
    intro,
    unavailable,
    codeSection,
    requestSection,
    successSection,
    grantsSection,
    privacy,
  );
  root.appendChild(shell);
  document.body.appendChild(root);

  let activeCode = '';
  let activeAuthorization: CatalogLabDeviceAuthorization | null = null;
  let activeSubmitterMachine: CatalogLabSubmitterMachine | null = null;
  let decisionPending = false;
  let activeCandidateSafe = true;
  let activeCandidateReview: MountedCandidateReview | null = null;
  let grantsPending = false;

  const clearSensitiveCode = (): void => {
    activeCode = '';
    input.value = '';
  };

  const resetSubmitterMachine = (): void => {
    activeSubmitterMachine = null;
    for (const radio of machineInputs.values()) radio.checked = false;
  };

  const updateApprovalDisabled = (): void => {
    const machineRequired = activeAuthorization != null
      && requiresSubmitterMachine(activeAuthorization);
    approve.disabled = decisionPending
      || !activeCandidateSafe
      || (machineRequired && activeSubmitterMachine == null);
  };

  const showUnavailable = (): void => {
    activeCandidateReview?.destroy();
    activeCandidateReview = null;
    clearSensitiveCode();
    resetSubmitterMachine();
    activeAuthorization = null;
    activeCandidateSafe = true;
    codeSection.hidden = true;
    requestSection.hidden = true;
    successSection.hidden = true;
    grantsSection.hidden = true;
    unavailable.hidden = false;
  };

  const resetLookup = (): void => {
    activeCandidateReview?.destroy();
    activeCandidateReview = null;
    clearSensitiveCode();
    resetSubmitterMachine();
    activeAuthorization = null;
    title.textContent = 'Authorize a Lab computer';
    copy.textContent = 'Enter the one-time code shown by Mechanic Lab. Review the device and permission before you approve it.';
    requestSection.hidden = true;
    successSection.hidden = true;
    codeSection.hidden = false;
    formStatus.textContent = '';
    decisionStatus.textContent = '';
    input.disabled = false;
    lookup.disabled = false;
    input.focus();
  };

  const renderRequest = (authorization: CatalogLabDeviceAuthorization): void => {
    activeCandidateReview?.destroy();
    activeCandidateReview = null;
    resetSubmitterMachine();
    const promotion = authorization.promotionSummary;
    const promotionBatch = promotion?.schema === 'catalog.promotion-summary-batch.v1';
    const promotionArtifact = promotion?.schema === 'catalog.artifact-promotion-summary.v1';
    const playableRelease = promotion?.schema === 'feed.playable-release-summary.v1';
    const machineRequired = requiresSubmitterMachine(authorization);
    activeCandidateSafe = !playableRelease;
    title.textContent = promotion
      ? promotionBatch
        ? 'Approve an exact batch'
        : promotionArtifact ? 'Approve an exact raster world'
          : playableRelease ? 'Подтвердить релиз механики' : 'Approve an exact series'
      : 'Authorize a Lab computer';
    copy.textContent = promotion
      ? playableRelease
        ? 'Сначала проверьте exact candidate в реальном responsive platform slot: autoplay/tutorial, ручной takeover, restart и завершение.'
        : promotionArtifact
        ? 'This is a one-time publication decision, not general access. Compare the immutable art, runtime, and gameplay identities below with the reviewed candidate.'
        : 'This is a one-time publication decision, not general access. Compare the immutable series identity below with the reviewed morning candidate.'
      : 'Review the device and permission before you approve it.';
    requestEyebrow.textContent = promotion
      ? promotionBatch
        ? 'Exact batch publication'
        : promotionArtifact ? 'Exact raster-world publication'
          : playableRelease ? 'Exact playable release' : 'Exact series publication'
      : 'Permission request';
    requestTitle.textContent = promotion
      ? promotionBatch
        ? `${promotion.items.length} approved visual variants`
        : promotionArtifact ? promotion.title
          : playableRelease ? promotion.playableId : `${promotion.mechanic} · ${promotion.variant}`
      : authorization.clientName;
    requestDetails.replaceChildren(
      detail('Computer', authorization.clientName),
      detail('Instance ID', authorization.clientInstanceId),
      detail('Permission', scopeLabel(authorization.scopes)),
      detail('Request expires', formatDate(authorization.expiresAt)),
      ...(authorization.submitterMachine
        ? [detail('Bound workspace', submitterMachineLabel(authorization.submitterMachine))]
        : []),
    );
    const pending = authorization.state === 'pending';
    submitterMachine.hidden = !machineRequired || !pending;
    if (machineRequired && pending) approve.setAttribute('aria-describedby', submitterMachineHelp.id);
    else approve.removeAttribute('aria-describedby');
    for (const radio of machineInputs.values()) {
      radio.disabled = !machineRequired || !pending;
    }
    let candidateReviewElement: HTMLElement | null = null;
    if (playableRelease) {
      const updateCandidateState = (state: CandidateReviewState): void => {
        activeCandidateSafe = state.approvalReady;
        updateApprovalDisabled();
        if (authorization.state !== 'pending' || decisionPending) return;
        decisionStatus.textContent = state.error ?? (state.approvalReady
          ? 'In-platform review session готова к exact approval.'
          : state.manualTakeover
            ? 'Ждём interactive_ready после перехода в ручной режим.'
            : state.interactiveReady
              ? 'Коснитесь candidate и проверьте ручной режим перед публикацией.'
              : 'Ждём verified binding и interactive_ready exact candidate.');
      };
      activeCandidateReview = mountPlayableCandidateReview(promotion, updateCandidateState);
      candidateReviewElement = activeCandidateReview.element;
    }
    if (promotion) requestDetails.appendChild(promotionSummaryView(promotion, candidateReviewElement));
    requestWarning.textContent = promotion
      ? playableRelease
        ? 'Подтверждение связано только с exact candidate и сгорает после этого релиза. Оно не даёт Labs постоянного права публикации.'
        : promotionBatch
        ? 'Approval authorizes only this immutable ordered batch. Each item keeps its own idempotent publish receipt; no item outside the batch can use this authorization.'
        : promotionArtifact
          ? 'Approval authorizes this exact immutable raster world once. Verify the art pack, runtime, and gameplay fingerprints before approving; no other world can use this authorization.'
          : 'Approval authorizes this exact immutable series once. Verify the content identity and every ordered level before approving; no other series can use this authorization.'
      : 'Approval lets this computer submit validated evaluation results. It does not grant feed, reset, or model API access.';
    approve.textContent = promotion
      ? promotionBatch
        ? 'Approve exact batch'
        : promotionArtifact ? 'Approve exact raster world'
          : playableRelease ? 'Принять и опубликовать' : 'Approve exact publication'
      : 'Approve';
    decisionButtons.hidden = !pending;
    updateApprovalDisabled();
    if (!pending) {
      clearSensitiveCode();
      decisionStatus.textContent = authorization.state === 'consumed'
        ? 'This request has already been used.'
        : `This request is already ${authorization.state}.`;
    } else {
      decisionStatus.textContent = activeCandidateSafe
        ? machineRequired
          ? 'Choose Mac A or Mac B before approving this desktop intake identity.'
          : ''
        : playableRelease
          ? 'Публикация заблокирована до valid in-platform review и ручного takeover.'
          : '';
    }
    codeSection.hidden = true;
    successSection.hidden = true;
    requestSection.hidden = false;
  };

  const renderGrants = (grants: CatalogLabGrantView[]): void => {
    const active = grants.filter((grant) => grant.active);
    grantsList.replaceChildren();
    if (!active.length) {
      const empty = document.createElement('p');
      empty.className = 'lab-auth__empty';
      empty.textContent = 'No active Lab computers.';
      grantsList.appendChild(empty);
      return;
    }
    for (const grant of active) {
      const card = document.createElement('article');
      card.className = 'lab-auth__grant';
      const grantTitle = document.createElement('h3');
      grantTitle.textContent = grant.clientName;
      const grantDetails = document.createElement('div');
      grantDetails.className = 'lab-auth__grant-details';
      grantDetails.append(
        detail('Instance ID', grant.clientInstanceId),
        detail('Permission', scopeLabel(grant.scopes)),
        detail('Expires', formatDate(grant.expiresAt)),
      );
      const revoke = button('Revoke access', 'lab-auth__button--danger lab-auth__button--small');
      revoke.addEventListener('click', async () => {
        const confirmed = await showConfirm(`Revoke Catalog Lab access for “${grant.clientName}”?`);
        if (!confirmed) return;
        revoke.disabled = true;
        revoke.textContent = 'Revoking…';
        try {
          await apiRevokeCatalogLabToken(grant.jti, grant.revocationEpoch, REVOKE_REASON);
          await refreshTokenList();
        } catch (error) {
          if (isAccountUnavailable(error)) {
            showUnavailable();
            return;
          }
          grantsStatus.textContent = error instanceof ApiRequestError && error.status === 409
            ? 'Access changed on the server. Refresh the list and try again.'
            : 'Could not revoke this access. Try again.';
          revoke.disabled = false;
          revoke.textContent = 'Revoke access';
        }
      });
      card.append(grantTitle, grantDetails, revoke);
      grantsList.appendChild(card);
    }
  };

  async function refreshTokenList(): Promise<void> {
    if (grantsPending) return;
    grantsPending = true;
    refreshGrants.disabled = true;
    grantsStatus.textContent = 'Checking…';
    try {
      const grants = await apiCatalogLabTokens();
      renderGrants(grants);
      grantsStatus.textContent = '';
    } catch (error) {
      if (isFeatureUnavailable(error)) {
        showUnavailable();
        return;
      }
      grantsStatus.textContent = 'Active access could not be loaded. You can retry.';
    } finally {
      grantsPending = false;
      refreshGrants.disabled = false;
    }
  }

  input.addEventListener('input', () => {
    const cursorAtEnd = input.selectionStart === input.value.length;
    input.value = formatCodeInput(input.value);
    if (cursorAtEnd) input.setSelectionRange(input.value.length, input.value.length);
    formStatus.textContent = '';
  });

  for (const [machine, radio] of machineInputs) {
    radio.addEventListener('change', () => {
      if (!radio.checked || !activeAuthorization || !requiresSubmitterMachine(activeAuthorization)) return;
      activeSubmitterMachine = machine;
      decisionStatus.textContent = '';
      updateApprovalDisabled();
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const normalized = normalizeUserCode(input.value);
    if (!normalized) {
      formStatus.textContent = 'Enter the complete 10-character code.';
      input.focus();
      return;
    }
    lookup.disabled = true;
    input.disabled = true;
    formStatus.textContent = 'Checking…';
    try {
      const authorization = await apiCatalogLabLookup(normalized);
      activeCode = normalized;
      activeAuthorization = authorization;
      input.value = '';
      renderRequest(authorization);
    } catch (error) {
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) {
        showUnavailable();
        return;
      }
      formStatus.textContent = lookupErrorMessage(error);
      input.disabled = false;
      lookup.disabled = false;
      input.focus();
    }
  });

  const decide = async (decision: Decision): Promise<void> => {
    if (decisionPending || !activeAuthorization || !activeCode) return;
    const authorization = activeAuthorization;
    const code = activeCode;
    if (decision === 'approve' && !activeCandidateSafe) {
      decisionStatus.textContent = 'Публикация заблокирована: in-platform candidate review не завершён.';
      return;
    }
    const machineRequired = requiresSubmitterMachine(activeAuthorization);
    if (decision === 'approve' && machineRequired && activeSubmitterMachine == null) {
      decisionStatus.textContent = 'Choose Mac A or Mac B before approving this desktop intake identity.';
      return;
    }
    const confirmedMachine = decision === 'approve' && machineRequired
      ? activeSubmitterMachine
      : null;
    const verb = decision === 'approve' ? 'Approve' : 'Deny';
    const promotion = authorization.promotionSummary;
    decisionPending = true;
    approve.disabled = true;
    deny.disabled = true;
    requestReset.disabled = true;
    for (const radio of machineInputs.values()) radio.disabled = true;
    const confirmed = await showConfirm(
      decision === 'approve'
        ? promotion
        ? `${verb} exact publication ${promotion.publishId} with content hash ${promotion.contentHash}?`
          : machineRequired && confirmedMachine
            ? `${verb} “${authorization.clientName}” as ${submitterMachineLabel(confirmedMachine)} for ${scopeLabel(authorization.scopes)}?`
            : `${verb} “${authorization.clientName}” for ${scopeLabel(authorization.scopes)}?`
        : `${verb} the access request from “${authorization.clientName}”?`,
    );
    if (!confirmed) {
      decisionPending = false;
      requestReset.disabled = false;
      deny.disabled = false;
      for (const radio of machineInputs.values()) radio.disabled = !machineRequired;
      updateApprovalDisabled();
      return;
    }

    decisionStatus.textContent = decision === 'approve' ? 'Approving…' : 'Denying…';
    try {
      const result = await apiCatalogLabDecision({
        authorizationId: authorization.authorizationId,
        userCode: code,
        expectedDecisionVersion: authorization.decisionVersion,
        decision,
        ...(confirmedMachine
          ? { submitterMachine: confirmedMachine }
          : {}),
      });
      if (confirmedMachine && result.submitterMachine !== confirmedMachine) {
        throw new ApiRequestError(
          409,
          'Backend did not confirm the selected desktop submitter binding',
          'device_authorization_machine_binding_unconfirmed',
        );
      }
      clearSensitiveCode();
      activeAuthorization = null;
      activeCandidateReview?.destroy();
      activeCandidateReview = null;
      requestSection.hidden = true;
      successTitle.textContent = decision === 'approve'
        ? promotion ? 'Publication approved' : 'Access approved'
        : 'Request denied';
      successCopy.textContent = decision === 'approve'
        ? promotion
          ? promotion.schema === 'feed.playable-release-summary.v1'
            ? `“${result.clientName}” теперь может опубликовать только этот exact playable release.`
            : `“${result.clientName}” can now complete the short-lived exchange for this exact series only.`
          : result.submitterMachine
            ? `“${result.clientName}” is bound to ${submitterMachineLabel(result.submitterMachine)} and can submit only through that server-owned desktop identity.`
            : `“${result.clientName}” can now complete the short-lived token exchange. You can revoke it below at any time.`
        : `“${result.clientName}” was not granted access.`;
      successSection.hidden = false;
      if (decision === 'approve') void refreshTokenList();
    } catch (error) {
      if (isAccountUnavailable(error)) {
        showUnavailable();
        return;
      }
      decisionStatus.textContent = decisionErrorMessage(error);
    } finally {
      decisionPending = false;
      requestReset.disabled = false;
      const requestStillPending = activeAuthorization?.state === 'pending';
      for (const radio of machineInputs.values()) {
        radio.disabled = !requestStillPending || !activeAuthorization
          || !requiresSubmitterMachine(activeAuthorization);
      }
      updateApprovalDisabled();
      deny.disabled = false;
    }
  };

  approve.addEventListener('click', () => { void decide('approve'); });
  deny.addEventListener('click', () => { void decide('deny'); });
  requestReset.addEventListener('click', resetLookup);
  another.addEventListener('click', resetLookup);
  refreshGrants.addEventListener('click', () => { void refreshTokenList(); });

  await refreshTokenList();
  if (!unavailable.hidden) return;
  input.focus();
}
