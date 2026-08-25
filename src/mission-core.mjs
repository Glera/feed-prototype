/**
 * Mission slice v0 — the pure half (no DOM, no storage, no network).
 *
 * Everything the client shows about the mission is a projection of server
 * receipts, so this module is deliberately a *parser and a watermark*, never a
 * calculator:
 *
 *   • `parseMissionContributionReceipt` reads the optional `mission_contribution`
 *     block that rides `/api/results` and `/api/daily/claim`. The token bar it
 *     carries is the ONLY bar the contribution ceremony may render — there is no
 *     optimistic local estimate anywhere in the mission surface.
 *   • `parseMissionCaseView` reads `GET /api/mission/case`. The four money
 *     numbers are copied, never recombined: «really delivered» projects from
 *     fulfillment receipts alone and must not be blurred with reserved money.
 *   • `pendingMissionCeremonies` / `advanceMissionWatermark` are the client-owned
 *     «shown once» record, keyed by the immutable `eventSeq` of the UNLOCKED and
 *     FULFILLED events (the `island-celebrations` pattern).
 *
 * One deliberate difference from the island watermark: an UNKNOWN mission
 * watermark is NOT silently initialised at the current event. The ТЗ requires
 * that «a player who did not make the crossing contribution — or who simply came
 * back a day later — gets the ceremony from here», so a first entry owes the
 * latest ceremony exactly once. Islands suppress historical confetti because
 * growth is continuous; a mission case crosses twice in a slice, and the player
 * is entitled to both moments.
 *
 * Defensive by contract: a missing block means the feature is off for this
 * caller, never an error. Every parser returns `null` instead of throwing.
 */

export const MISSION_CONTRIBUTION_RECEIPT_SCHEMA = 'mission.contribution-receipt.v1';
export const MISSION_CASE_VIEW_SCHEMA = 'mission.case-view.v1';
/** Causal order: a case is unlocked before it can be fulfilled. */
export const MISSION_CEREMONY_KINDS = ['unlocked', 'fulfilled'];
export const MISSION_HISTORY_LIMIT = 6;

const CURRENCY_SYMBOLS = { EUR: '€', USD: '$', GBP: '£' };
const SOURCE_LABELS = { series: 'серия', daily: 'ежедневное задание' };

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A whole, finite, non-negative-by-default integer, or `null`. */
function intOf(value, minimum = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const whole = Math.trunc(value);
  return whole < minimum ? null : whole;
}

function textOf(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

// ── contribution receipt ────────────────────────────────────────────────────
/** `{caseId, contractVersion, progress, tokenGoal}` — the receipt's bar block. */
export function parseMissionBar(value) {
  if (!isObject(value)) return null;
  const caseId = textOf(value.caseId);
  const contractVersion = textOf(value.contractVersion);
  const progress = intOf(value.progress);
  const tokenGoal = intOf(value.tokenGoal, 1);
  const nextStepThreshold = value.nextStepThreshold === null
    ? null
    : intOf(value.nextStepThreshold, 1);
  if (!caseId || !contractVersion || progress === null || tokenGoal === null) return null;
  if (value.nextStepThreshold !== null && nextStepThreshold === null) return null;
  return { caseId, contractVersion, progress, tokenGoal, nextStepThreshold };
}

/** The UNLOCKED snapshot a crossing contribution carries, or `null`. */
export function parseMissionUnlockedSnapshot(value) {
  if (!isObject(value)) return null;
  const eventSeq = intOf(value.eventSeq);
  const caseId = textOf(value.caseId);
  if (eventSeq === null || !caseId) return null;
  return {
    eventSeq,
    caseId,
    contractVersion: textOf(value.contractVersion) ?? '',
    progress: intOf(value.progress) ?? 0,
    tokenGoal: intOf(value.tokenGoal, 1) ?? 0,
    guaranteedCents: intOf(value.guaranteedCents) ?? 0,
    giftTotalCents: intOf(value.giftTotalCents) ?? 0,
    releasedUnopenedCents: intOf(value.releasedUnopenedCents) ?? 0,
    nextCaseId: textOf(value.nextCaseId),
    nextContractVersion: textOf(value.nextContractVersion),
  };
}

function parseAllocations(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const caseId = textOf(item.caseId);
    const amount = intOf(item.amount);
    if (!caseId || amount === null) continue;
    out.push({ caseId, contractVersion: textOf(item.contractVersion) ?? '', amount });
  }
  return out;
}

function parseGiftSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const stepIndex = intOf(item.stepIndex, 1);
    const thresholdTokens = intOf(item.thresholdTokens, 1);
    const amountCents = intOf(item.amountCents, 1);
    if (stepIndex === null || thresholdTokens === null || amountCents === null) return [];
    return [{
      caseId: textOf(item.caseId) ?? '',
      contractVersion: textOf(item.contractVersion) ?? '',
      stepIndex,
      thresholdTokens,
      amountCents,
      progressAtOpen: intOf(item.progressAtOpen) ?? 0,
    }];
  });
}

/**
 * The optional `mission_contribution` block of a `/results` or `/daily/claim`
 * response. Absent, foreign-schema or structurally broken → `null`, which the
 * caller reads as «this build/account has no mission», not as a failure.
 */
export function parseMissionContributionReceipt(value) {
  if (!isObject(value) || value.schema !== MISSION_CONTRIBUTION_RECEIPT_SCHEMA) return null;
  const seq = intOf(value.seq);
  const amount = intOf(value.amount);
  const source = textOf(value.source);
  const bar = parseMissionBar(value.bar);
  if (seq === null || amount === null || !source || !bar) return null;
  return {
    schema: MISSION_CONTRIBUTION_RECEIPT_SCHEMA,
    seq,
    source,
    sourceRef: textOf(value.sourceRef) ?? '',
    idempotencyKey: textOf(value.idempotencyKey) ?? '',
    amount,
    allocations: parseAllocations(value.allocations),
    openedGiftSteps: parseGiftSteps(value.openedGiftSteps),
    unlocked: parseMissionUnlockedSnapshot(value.unlocked),
    bar,
  };
}

// ── read API ────────────────────────────────────────────────────────────────
function parseCaseEvent(value) {
  if (!isObject(value)) return null;
  const eventSeq = intOf(value.eventSeq);
  const caseId = textOf(value.caseId);
  if (eventSeq === null || !caseId) return null;
  const event = {
    eventSeq,
    caseId,
    contractVersion: textOf(value.contractVersion) ?? '',
    occurredAt: textOf(value.occurredAt) ?? '',
    receiptDigest: textOf(value.receiptDigest) ?? '',
    receipt: isObject(value.receipt) ? value.receipt : {},
    transferReceipt: isObject(value.transferReceipt) ? value.transferReceipt : null,
  };
  return event;
}

function parseMoney(value) {
  if (!isObject(value)) return null;
  return {
    currency: textOf(value.currency) ?? 'EUR',
    communityTokens: intOf(value.communityTokens) ?? 0,
    guaranteedCents: intOf(value.guaranteedCents) ?? 0,
    ladderTotalCents: intOf(value.ladderTotalCents) ?? 0,
    collectedCents: intOf(value.collectedCents) ?? 0,
    deliveredCents: intOf(value.deliveredCents) ?? 0,
  };
}

function parseGiftLadder(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item)) return [];
    const stepIndex = intOf(item.stepIndex);
    const thresholdTokens = intOf(item.thresholdTokens);
    const amountCents = intOf(item.amountCents, 1);
    const state = textOf(item.state);
    if (stepIndex === null || thresholdTokens === null || amountCents === null || !state) {
      return [];
    }
    return [{
      stepIndex,
      thresholdTokens,
      amountCents,
      state,
      openingReceipt: isObject(item.openingReceipt) ? item.openingReceipt : null,
    }];
  });
}

function parseContract(value) {
  if (!isObject(value)) return null;
  const policy = isObject(value.fundingPolicy) ? value.fundingPolicy : {};
  return {
    caseId: textOf(value.caseId) ?? '',
    contractVersion: textOf(value.contractVersion) ?? '',
    contractDigest: textOf(value.contractDigest) ?? '',
    document: isObject(value.document) ? value.document : {},
    fundingPolicy: {
      version: textOf(policy.version) ?? '',
      digest: textOf(policy.digest) ?? '',
      document: isObject(policy.document) ? policy.document : {},
    },
  };
}

function parseActiveCase(value) {
  if (!isObject(value)) return null;
  const caseId = textOf(value.caseId);
  const bar = isObject(value.bar) ? value.bar : null;
  const progress = bar ? intOf(bar.progress) : null;
  const tokenGoal = bar ? intOf(bar.tokenGoal, 1) : null;
  const nextStepThreshold = bar?.nextStepThreshold === null
    ? null
    : intOf(bar?.nextStepThreshold, 1);
  const money = parseMoney(value.money);
  if (!caseId || progress === null || tokenGoal === null || !money) return null;
  return {
    caseId,
    contractVersion: textOf(value.contractVersion) ?? '',
    bar: { progress, tokenGoal, nextStepThreshold },
    money,
    giftLadder: parseGiftLadder(value.giftLadder),
    contract: parseContract(value.contract),
  };
}

/** `GET /api/mission/case`. A 404 (not enrolled) never reaches here — it is a
 *  `null` at the call site, which is the same «no mission» answer. */
export function parseMissionCaseView(value) {
  if (!isObject(value) || value.schema !== MISSION_CASE_VIEW_SCHEMA) return null;
  const mine = isObject(value.myContribution) ? value.myContribution : {};
  return {
    schema: MISSION_CASE_VIEW_SCHEMA,
    activeCase: parseActiveCase(value.activeCase),
    myContribution: {
      caseTokens: intOf(mine.caseTokens) ?? 0,
      totalTokens: intOf(mine.totalTokens) ?? 0,
    },
    lastUnlocked: parseCaseEvent(value.lastUnlocked),
    lastFulfilled: parseCaseEvent(value.lastFulfilled),
  };
}

// ── ceremony watermark ──────────────────────────────────────────────────────
/** `{unlocked, fulfilled}` with `null` for «never shown». Never throws. */
export function normaliseMissionWatermark(value) {
  const out = { unlocked: null, fulfilled: null };
  if (!isObject(value)) return out;
  for (const kind of MISSION_CEREMONY_KINDS) {
    const seq = intOf(value[kind]);
    if (seq !== null) out[kind] = seq;
  }
  return out;
}

/**
 * Ceremonies this player is owed, oldest event first. A ceremony whose event is
 * at or below the watermark has already been shown and is silently dropped, so
 * the same entry cannot celebrate twice — and a later reload cannot replay it.
 */
export function pendingMissionCeremonies(view, watermark) {
  if (!isObject(view)) return [];
  const seen = normaliseMissionWatermark(watermark);
  const out = [];
  for (const kind of MISSION_CEREMONY_KINDS) {
    const event = kind === 'unlocked' ? view.lastUnlocked : view.lastFulfilled;
    if (!isObject(event)) continue;
    const eventSeq = intOf(event.eventSeq);
    if (eventSeq === null) continue;
    if (seen[kind] !== null && eventSeq <= seen[kind]) continue;
    out.push({ kind, event });
  }
  return out.sort((a, b) => a.event.eventSeq - b.event.eventSeq);
}

/** Monotone advance. A lower or unparseable seq can never walk the mark back. */
export function advanceMissionWatermark(watermark, kind, eventSeq) {
  const seen = normaliseMissionWatermark(watermark);
  if (!MISSION_CEREMONY_KINDS.includes(kind)) return seen;
  const seq = intOf(eventSeq);
  if (seq === null) return seen;
  const prior = seen[kind];
  return { ...seen, [kind]: prior === null ? seq : Math.max(prior, seq) };
}

// ── gating ──────────────────────────────────────────────────────────────────
/**
 * The single admission rule for the whole client mission surface: the build flag
 * AND the server capability. Either alone mounts nothing, issues no request and
 * leaves the pre-mission behaviour byte-identical.
 */
export function missionSurfaceEnabled(flagEnabled, capability) {
  return flagEnabled === true && capability === true;
}

// ── presentation-free derivations ───────────────────────────────────────────
export function missionBarPercent(progress, tokenGoal) {
  const goal = intOf(tokenGoal, 1);
  if (goal === null) return 0;
  const value = intOf(progress) ?? 0;
  return Math.max(0, Math.min(100, Math.round((value / goal) * 100)));
}

/** Integer cents → «€100» / «€99,50». Never a float, never a rounding of one. */
export function formatMissionMoney(cents, currency = 'EUR') {
  const amount = intOf(cents, Number.MIN_SAFE_INTEGER) ?? 0;
  const sign = amount < 0 ? '−' : '';
  const absolute = Math.abs(amount);
  const whole = Math.floor(absolute / 100);
  const rest = absolute % 100;
  const body = rest === 0 ? String(whole) : `${whole},${String(rest).padStart(2, '0')}`;
  const symbol = CURRENCY_SYMBOLS[currency];
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${currency}`;
}

/** The case's display name. `title` is honoured first for forward compatibility
 *  with a contract that grows one; today the deliverable is the honest name. */
export function missionCaseTitle(document) {
  if (!isObject(document)) return 'Кейс';
  return textOf(document.title)
    ?? textOf(document.guaranteedDeliverable)
    ?? textOf(document.caseId)
    ?? 'Кейс';
}

/** «получатель · место» under the name. */
export function missionCaseSubtitle(document) {
  if (!isObject(document)) return '';
  const parts = [textOf(document.recipient), textOf(document.place) ?? textOf(document.location)];
  return parts.filter(Boolean).join(' · ');
}

export function missionSourceLabel(source) {
  return SOURCE_LABELS[source] ?? (textOf(source) ?? '');
}

// ── my own contribution history (client-owned) ──────────────────────────────
/**
 * The read API projects money and totals, not a per-contribution list, so the
 * «last contributions» strip on the case screen is MY OWN receipts, kept locally
 * and labelled as such. Deduplicated by the immutable contribution `seq`, newest
 * first, bounded.
 */
export function appendMissionHistory(history, entry, limit = MISSION_HISTORY_LIMIT) {
  const existing = Array.isArray(history) ? history.filter(isObject) : [];
  const bounded = existing.slice(0, Math.max(0, limit));
  if (!isObject(entry)) return bounded;
  const seq = intOf(entry.seq);
  if (seq === null) return bounded;
  const row = {
    seq,
    source: textOf(entry.source) ?? '',
    amount: intOf(entry.amount) ?? 0,
    caseId: textOf(entry.caseId) ?? '',
    at: textOf(entry.at) ?? '',
  };
  return [row, ...bounded.filter((item) => intOf(item.seq) !== seq)]
    .sort((a, b) => (intOf(b.seq) ?? 0) - (intOf(a.seq) ?? 0))
    .slice(0, Math.max(0, limit));
}

export function parseMissionHistory(value) {
  if (!Array.isArray(value)) return [];
  let out = [];
  for (const item of [...value].reverse()) out = appendMissionHistory(out, item);
  return out;
}

// ── «exactly one ceremony per contribution» ─────────────────────────────────
/**
 * A contribution reaches the client through more than one door: the first
 * `/daily/claim` answer, the answer to a background retry after a lost response
 * or the mandatory retryable 503 of an empty case queue, and — on the series
 * path — an outbox replay that returns the same committed bytes. All of them
 * must run through the same presenter, and the player must still see exactly one
 * ceremony. The immutable contribution `seq` is what makes those the same fact.
 */
export function isContributionPresented(presented, seq) {
  const value = intOf(seq);
  if (value === null) return false;
  return Array.isArray(presented) && presented.some((item) => intOf(item) === value);
}

/** Append (oldest dropped first). Returns the same list when already present, so
 *  a caller can treat an unchanged length as «already shown». */
export function rememberPresentedContribution(presented, seq, limit = 32) {
  const list = Array.isArray(presented) ? presented.map((item) => intOf(item)).filter((item) => item !== null) : [];
  const value = intOf(seq);
  if (value === null || list.includes(value)) return list;
  return [...list, value].slice(-Math.max(1, limit));
}
