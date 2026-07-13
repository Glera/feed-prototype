import {
  ApiRequestError,
  apiCatalogLabDecision,
  apiCatalogLabLookup,
  apiCatalogLabTokens,
  apiRevokeCatalogLabToken,
  type CatalogLabDeviceAuthorization,
  type CatalogLabGrantView,
  type CatalogPromotionSummary,
} from './api';
import { showConfirm } from './telegram';

const USER_CODE_ALPHABET = new Set('23456789ABCDEFGHJKMNPQRSTUVWXYZ');
const REVOKE_REASON = 'revoked from Telegram Catalog Lab panel';

type Decision = 'approve' | 'deny';

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

function promotionSummaryView(summary: CatalogPromotionSummary): HTMLElement {
  const section = document.createElement('section');
  section.className = 'lab-auth__promotion';
  section.dataset.testid = 'catalog-promotion-summary';

  const header = document.createElement('div');
  header.className = 'lab-auth__promotion-header';
  const heading = document.createElement('h3');
  heading.textContent = 'Exact series to publish';
  const count = document.createElement('span');
  count.className = 'lab-auth__promotion-count';
  count.textContent = `${summary.levels.length} ${summary.levels.length === 1 ? 'level' : 'levels'}`;
  header.append(heading, count);

  const identity = document.createElement('div');
  identity.className = 'lab-auth__promotion-identity';
  identity.append(
    detail('Mechanic', summary.mechanic),
    detail('Variant', summary.variant),
    detail('Publish ID', summary.publishId),
    detail('Request hash', summary.requestHash),
    detail('Content hash', summary.contentHash),
    detail('Runtime artifact', summary.runtimeArtifactDigest),
    detail('Reason', summary.reason),
  );

  const levels = document.createElement('ol');
  levels.className = 'lab-auth__promotion-levels';
  levels.setAttribute('aria-label', 'Ordered series levels');
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
  switch (error.status) {
    case 0: return 'Cannot reach the server. Your decision was not confirmed.';
    case 404: return 'This request is no longer available.';
    case 409: return 'This request changed on the server. Check the code again.';
    case 410: return 'This request expired before the decision was saved.';
    default: return 'Could not save the decision. Try again.';
  }
}

function closeMiniApp(): void {
  const telegram = (window as any).Telegram?.WebApp;
  try {
    if (typeof telegram?.close === 'function') {
      telegram.close();
      return;
    }
  } catch { /* browser fallback below */ }
  const url = new URL(location.href);
  url.searchParams.delete('labAuth');
  location.assign(`${url.pathname}${url.search}${url.hash}`);
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
  let decisionPending = false;
  let grantsPending = false;

  const clearSensitiveCode = (): void => {
    activeCode = '';
    input.value = '';
  };

  const showUnavailable = (): void => {
    clearSensitiveCode();
    activeAuthorization = null;
    codeSection.hidden = true;
    requestSection.hidden = true;
    successSection.hidden = true;
    grantsSection.hidden = true;
    unavailable.hidden = false;
  };

  const resetLookup = (): void => {
    clearSensitiveCode();
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
    const promotion = authorization.promotionSummary;
    title.textContent = promotion ? 'Approve an exact series' : 'Authorize a Lab computer';
    copy.textContent = promotion
      ? 'This is a one-time publication decision, not general access. Compare the immutable series identity below with the reviewed morning candidate.'
      : 'Review the device and permission before you approve it.';
    requestEyebrow.textContent = promotion ? 'Exact series publication' : 'Permission request';
    requestTitle.textContent = promotion
      ? `${promotion.mechanic} · ${promotion.variant}`
      : authorization.clientName;
    requestDetails.replaceChildren(
      detail('Computer', authorization.clientName),
      detail('Instance ID', authorization.clientInstanceId),
      detail('Permission', scopeLabel(authorization.scopes)),
      detail('Request expires', formatDate(authorization.expiresAt)),
    );
    if (promotion) requestDetails.appendChild(promotionSummaryView(promotion));
    requestWarning.textContent = promotion
      ? 'Approval authorizes this exact immutable series once. Verify the content identity and every ordered level before approving; no other series can use this authorization.'
      : 'Approval lets this computer submit validated evaluation results. It does not grant feed, reset, or model API access.';
    approve.textContent = promotion ? 'Approve exact publication' : 'Approve';
    const pending = authorization.state === 'pending';
    decisionButtons.hidden = !pending;
    if (!pending) {
      clearSensitiveCode();
      decisionStatus.textContent = authorization.state === 'consumed'
        ? 'This request has already been used.'
        : `This request is already ${authorization.state}.`;
    } else {
      decisionStatus.textContent = '';
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
    const verb = decision === 'approve' ? 'Approve' : 'Deny';
    const promotion = activeAuthorization.promotionSummary;
    const confirmed = await showConfirm(
      decision === 'approve'
        ? promotion
          ? `${verb} exact publication ${promotion.publishId} with content hash ${promotion.contentHash}?`
          : `${verb} “${activeAuthorization.clientName}” for ${scopeLabel(activeAuthorization.scopes)}?`
        : `${verb} the access request from “${activeAuthorization.clientName}”?`,
    );
    if (!confirmed) return;

    decisionPending = true;
    approve.disabled = true;
    deny.disabled = true;
    decisionStatus.textContent = decision === 'approve' ? 'Approving…' : 'Denying…';
    try {
      const result = await apiCatalogLabDecision({
        authorizationId: activeAuthorization.authorizationId,
        userCode: activeCode,
        expectedDecisionVersion: activeAuthorization.decisionVersion,
        decision,
      });
      clearSensitiveCode();
      activeAuthorization = null;
      requestSection.hidden = true;
      successTitle.textContent = decision === 'approve'
        ? promotion ? 'Publication approved' : 'Access approved'
        : 'Request denied';
      successCopy.textContent = decision === 'approve'
        ? promotion
          ? `“${result.clientName}” can now complete the short-lived exchange for this exact series only.`
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
      approve.disabled = false;
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
