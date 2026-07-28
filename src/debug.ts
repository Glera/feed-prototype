/**
 * On-device debug panel (open with ?diag=1 or t.me/<bot>?startapp=diag).
 * Shows initData/auth + /session status + live event log, and lets you flush the
 * pending-results outbox or reset your own server state. QA tool; no-op unless
 * explicitly opened.
 *
 * The feed-sequencing projections (§12) live in their own sub-screen below, so
 * the QA flow of this panel is unchanged by them.
 */
import {
  apiDiagnose,
  apiReset,
  apiResetDaily,
  apiSeedChallenge,
  apiSequencingDebugHistory,
  apiSequencingDebugProfile,
  apiSequencingDebugShadowVsActual,
  apiSequencingDebugWhyNow,
} from './api';
import { getEventLog } from './telemetry';
import { mountIslandModerationConsole } from './island-moderation-console';
import { pendingCount, pendingStars, starsEverQueued, flushResults, clearOutbox } from './outbox';
import {
  SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT,
  SEQUENCING_DEBUG_HISTORY_LIMIT_MAX,
  SEQUENCING_DEBUG_HISTORY_LIMIT_MIN,
  buildSequencingDebugView,
  formatSequencingJson,
  formatSequencingShadowAbsence,
  formatSequencingSnapshotAge,
  formatSequencingTimestamp,
  normalizeSequencingHistoryLimit,
  normalizeSequencingSubject,
  sequencingSubjectEchoWarning,
} from './feed-sequencing-debug.mjs';
import type {
  SequencingDebugHistoryViewV1,
  SequencingDebugKind,
  SequencingDebugPanelStateV1,
  SequencingDebugProfileViewV1,
  SequencingDebugShadowVerdict,
  SequencingDebugShadowVsActualViewV1,
  SequencingDebugWhyNowViewV1,
} from './feed-sequencing-debug.mjs';

export async function mountDebugPanel(): Promise<void> {
  // Idempotent mount: the panel now has a permanent operator button, so a second
  // tap while it is open must not stack a second copy over the first.
  if (document.querySelector('[data-panel="swipe-debug"]')) return;
  const wrap = document.createElement('div');
  wrap.dataset.panel = 'swipe-debug';
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.93);color:#4f8;' +
    'font:12px/1.5 ui-monospace,monospace;padding:12px;display:flex;flex-direction:column;gap:8px;';

  const head = document.createElement('pre');
  head.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all;color:#8cf;';

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

  const logEl = document.createElement('pre');
  logEl.style.cssText = 'margin:0;white-space:pre-wrap;flex:1;overflow:auto;border-top:1px solid #333;padding-top:8px;';

  const mkBtn = (label: string, fn: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:9px 13px;background:#1b2230;color:#cfe;border:1px solid #345;border-radius:6px;font:600 12px ui-monospace,monospace;';
    b.onclick = () => fn(b);
    return b;
  };

  async function refreshHead(): Promise<void> {
    const d = await apiDiagnose();
    // stars_ever_queued (local lifetime) vs server balance vs pending tells us
    // where stars go: ever==server → all delivered; ever>server+pending → lost
    // (localStorage cleared); pending>0 → not yet flushed.
    let serverBalance: unknown = '?';
    try { serverBalance = JSON.parse(String(d.sessionBody)).balance; } catch { /* not json */ }
    head.textContent = 'SWIPE DIAG\n' + JSON.stringify({
      ...d,
      server_balance: serverBalance,
      stars_ever_queued: starsEverQueued(),
      pending_results: pendingCount(),
      pending_stars: pendingStars(),
    }, null, 1);
  }
  function refreshLog(): void {
    const l = getEventLog();
    logEl.textContent = l.slice().reverse()
      .map((e) => `${e.t}  ${e.name}${e.props ? '  ' + JSON.stringify(e.props) : ''}`)
      .join('\n') || '(no events yet)';
  }

  let armed = false;
  const resetBtn = mkBtn('⟲ Reset my state', async (b) => {
    if (!armed) { armed = true; b.textContent = 'Tap again to RESET'; setTimeout(() => { armed = false; b.textContent = '⟲ Reset my state'; }, 3000); return; }
    b.textContent = 'resetting…';
    await apiReset();
    clearOutbox();
    location.reload();
  });

  let dailyArmed = false;
  const resetDailyBtn = mkBtn('Reset dailies (next day)', async (b) => {
    if (!dailyArmed) {
      dailyArmed = true;
      b.textContent = 'Tap again to reset dailies';
      setTimeout(() => {
        dailyArmed = false;
        b.textContent = 'Reset dailies (next day)';
      }, 3000);
      return;
    }
    b.textContent = 'resetting dailies…';
    const state = await apiResetDaily();
    if (!state) {
      dailyArmed = false;
      b.textContent = 'daily reset failed';
      setTimeout(() => { b.textContent = 'Reset dailies (next day)'; }, 1800);
      return;
    }
    location.reload();
  });

  const copyBtn = mkBtn('📋 Copy log', async (b) => {
    const text = `${head.textContent}\n\n--- events ---\n${logEl.textContent}`;
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* blocked */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;top:-9999px;opacity:0;';
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        ok = document.execCommand('copy'); document.body.removeChild(ta);
      } catch { ok = false; }
    }
    b.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { b.textContent = '📋 Copy log'; }, 1500);
  });

  const seqPanelBtn = mkBtn('⌘ Feed sequencing', () => { mountSequencingDebugPanel(); });
  seqPanelBtn.dataset.qa = 'feed-sequencing-open';

  const seedBtn = mkBtn('⚡ Seed test challenge', async (b) => {
    b.textContent = 'seeding…';
    const r = await apiSeedChallenge();
    (window as unknown as { __feedRefreshRail?: () => void }).__feedRefreshRail?.();
    b.textContent = r ? `от ${r.from} · ${(r.beat_ms / 1000).toFixed(1)}s ✓` : 'seed failed';
    setTimeout(() => { b.textContent = '⚡ Seed test challenge'; }, 2000);
  });

  // Island Moderation (P3): navigation to the operator console. NOT an auth
  // boundary — the server gates every moderation call by island_moderator_ids
  // (F015), so a non-moderator here just gets 403 toasts.
  const moderationBtn = mkBtn('🏝️ Island Moderation', () => { void mountIslandModerationConsole(); });

  btns.append(
    mkBtn('↻ Refresh', () => { void refreshHead(); refreshLog(); }),
    moderationBtn,
    copyBtn,
    seedBtn,
    mkBtn('Flush pending', async () => { await flushResults(); await refreshHead(); }),
    resetDailyBtn,
    resetBtn,
    // Last of the functional controls, so no existing QA control changes
    // position; Close stays the terminal button of the row.
    seqPanelBtn,
    mkBtn('✕ Close', () => { clearInterval(iv); wrap.remove(); }),
  );

  wrap.append(head, btns, logEl);
  document.body.appendChild(wrap);
  await refreshHead();
  refreshLog();
  const iv = window.setInterval(refreshLog, 1000);
}

// ── BEGIN feed sequencing debug sub-screen (§12) ───────────────────────────
// Five read-only projections over stored snapshot/receipt bytes. Nothing here
// recomputes a decision, and nothing here writes: the reset tab only displays
// the receipts the history projection returns, because personalization reset is
// an operator CLI act with its own double confirmation on the server side.
// `?diag=1` opens this screen; the server allowlist is the only authorization.

type SequencingTab = SequencingDebugKind | 'reset';

const SEQUENCING_TABS: ReadonlyArray<{ id: SequencingTab; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'why-now', label: 'Why now' },
  { id: 'history', label: 'History' },
  // Slice 11 lives in its own tab on purpose: History answers "what did the feed
  // issue and was it seen", and folding a second, differently-sourced verdict
  // into those rows would make one line read as one fact.
  { id: 'shadow-vs-actual', label: 'Vs' },
  { id: 'reset', label: 'Reset' },
];

function seqField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function seqText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return formatSequencingJson(value);
}

function seqRow(label: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:baseline;';
  const key = document.createElement('span');
  key.textContent = label;
  key.style.cssText = 'color:#7a8;min-width:150px;flex:0 0 auto;';
  const val = document.createElement('span');
  val.textContent = value;
  val.style.cssText = 'color:#cfe;word-break:break-all;';
  row.append(key, val);
  return row;
}

function seqBlock(title: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = 'border-top:1px solid #253;padding-top:6px;margin-top:6px;';
  const h = document.createElement('div');
  h.textContent = title;
  h.style.cssText = 'color:#8cf;font-weight:600;margin-bottom:4px;';
  el.append(h);
  return el;
}

/** Verbatim JSON, collapsed. Stored bytes are evidence, so they are always
 *  reachable even when a structured render above them is available. */
function seqRaw(title: string, value: unknown, open = false): HTMLElement {
  const details = document.createElement('details');
  details.open = open;
  details.style.cssText = 'margin-top:6px;';
  const summary = document.createElement('summary');
  summary.textContent = title;
  summary.style.cssText = 'color:#8cf;cursor:pointer;';
  const pre = document.createElement('pre');
  pre.textContent = formatSequencingJson(value);
  pre.style.cssText =
    'margin:4px 0 0;white-space:pre-wrap;word-break:break-all;color:#adf;'
    + 'max-height:46vh;overflow:auto;background:#0a0f16;padding:6px;border-radius:4px;';
  details.append(summary, pre);
  return details;
}

function seqSources(sources: ReadonlyArray<{
  kind: string | null; id: string | null; digest: string | null; asOf: string | null;
}>): HTMLElement {
  const block = seqBlock(`sources (${sources.length})`);
  if (sources.length === 0) {
    block.append(seqRow('', 'no stored source for this projection'));
    return block;
  }
  for (const source of sources) {
    block.append(seqRow(
      seqText(source.kind),
      `${seqText(source.id)} · ${seqText(source.digest)} · ${formatSequencingTimestamp(source.asOf)}`,
    ));
  }
  return block;
}

function seqWarnings(warnings: ReadonlyArray<string>): HTMLElement | null {
  if (warnings.length === 0) return null;
  const block = seqBlock(`contract drift (${warnings.length})`);
  for (const warning of warnings) block.append(seqRow('', warning));
  return block;
}

function renderSequencingProfile(view: SequencingDebugProfileViewV1): HTMLElement[] {
  const out: HTMLElement[] = [];
  const head = seqBlock('snapshot');
  head.append(
    seqRow('subjectUserId', view.subjectUserId),
    seqRow('snapshotAsOf', formatSequencingTimestamp(view.snapshotAsOf)),
    seqRow('snapshotAge', formatSequencingSnapshotAge(view.snapshotAgeSeconds)),
    seqRow('projection', seqText(view.profileSchema)),
    seqRow('projectionAsOf', formatSequencingTimestamp(view.profileAsOf)),
    seqRow('favoriteSet', view.favoriteSet.length ? view.favoriteSet.map(seqText).join(', ') : '—'),
  );
  out.push(head);
  const families = seqBlock(`families (${view.families.length})`);
  for (const family of view.families) {
    families.append(seqRow(
      seqText(seqField(family, 'familyId')),
      [
        `state=${seqText(seqField(family, 'state'))}`,
        `score=${seqText(seqField(family, 'score'))}`,
        `confidencePpm=${seqText(seqField(family, 'confidencePpm'))}`,
        `satiation=${seqText(seqField(family, 'satiation'))}`,
        `independentEpisodes=${seqText(seqField(family, 'independentEpisodeCount'))}`,
        `favoriteEligible=${seqText(seqField(family, 'favoriteEligible'))}`,
        `inFavoriteSet=${seqText(seqField(family, 'inFavoriteSet'))}`,
        `lastStrongTerminalAt=${formatSequencingTimestamp(seqField(family, 'lastStrongTerminalAt'))}`,
      ].join('  '),
    ));
  }
  out.push(families);
  out.push(seqRaw('epoch', view.epoch, true));
  out.push(seqRaw('configs', view.configs));
  out.push(seqSources(view.sources));
  out.push(seqRaw('raw response', view.raw));
  return out;
}

function renderSequencingWhyNow(view: SequencingDebugWhyNowViewV1): HTMLElement[] {
  const out: HTMLElement[] = [];
  const head = seqBlock('decision');
  head.append(
    seqRow('subjectUserId', view.subjectUserId),
    seqRow('planId', seqText(view.planId)),
    seqRow('chosenSlotType', seqText(view.chosenSlotType)),
    seqRow('chosenFamilyId', seqText(view.chosenFamilyId)),
    seqRow('constraintConflict', seqText(view.constraintConflict)),
    seqRow('coldStartPhase', seqText(view.coldStartPhase)),
    seqRow('snapshotDigest', seqText(view.snapshotDigest)),
  );
  out.push(head);
  const sections = seqBlock(`stored snapshot sections (${view.sections.length})`);
  for (const section of view.sections) {
    sections.append(seqRaw(section.key, section.value));
  }
  out.push(sections);
  out.push(seqSources(view.sources));
  // Mandatory verbatim view: the structured sections above are a reading aid.
  out.push(seqRaw('raw snapshot', view.snapshot));
  out.push(seqRaw('raw response', view.raw));
  return out;
}

function renderSequencingHistory(view: SequencingDebugHistoryViewV1): HTMLElement[] {
  const out: HTMLElement[] = [];
  const head = seqBlock('window');
  head.append(
    seqRow('subjectUserId', view.subjectUserId),
    seqRow('limit (server echo)', seqText(view.limit)),
  );
  out.push(head);
  const units = seqBlock(`issued → seen (${view.units.length})`);
  for (const unit of view.units) {
    units.append(seqRow(
      formatSequencingTimestamp(unit.issuedAt),
      [
        `slot=${seqText(unit.slotType)}`,
        `mechanic=${seqText(unit.mechanicId)}`,
        `policy=${seqText(unit.policyVersion)}`,
        `arm=${seqText(unit.arm)}`,
        unit.seen === true
          ? `seen ✓ ${formatSequencingTimestamp(unit.revealedAt)} · impression=${seqText(unit.impressionId)}`
          // A non-boolean `seen` is drift, not a negative fact: claiming
          // "issued, not seen" there would invent a measurement.
          : unit.seen === false ? 'issued, not seen' : 'seen: unknown (drift)',
        `decision=${seqText(unit.decisionId)}`,
        `mapping=${seqText(unit.builtinMappingId)}`,
        `rosterActivation=${seqText(unit.rosterActivationId)}`,
      ].join('  '),
    ));
  }
  out.push(units);
  const generated = seqBlock(`generatedOfferMisses (${view.generatedOfferMisses.length})`);
  view.generatedOfferMisses.forEach((miss, index) => {
    generated.append(seqRaw(`miss[${index}]`, miss));
  });
  out.push(generated);
  const favorite = seqBlock(`favoriteDeliveryMisses (${view.favoriteDeliveryMisses.length})`);
  view.favoriteDeliveryMisses.forEach((miss, index) => {
    favorite.append(seqRaw(`miss[${index}]`, miss));
  });
  out.push(favorite);
  out.push(seqRow('resets', `${view.resets.length} (see the Reset tab)`));
  out.push(seqSources(view.sources));
  out.push(seqRaw('raw response', view.raw));
  return out;
}

/** match / mismatch / no-verdict, straight off the parsed unit. */
function seqVsBadge(verdict: SequencingDebugShadowVerdict): HTMLElement {
  const badge = document.createElement('span');
  badge.dataset.seqVsBadge = verdict;
  badge.textContent = verdict === 'match' ? 'match ✓'
    : verdict === 'mismatch' ? 'mismatch ✗'
      : verdict === 'absent' ? 'no verdict' : 'verdict unknown (drift)';
  const color = verdict === 'match' ? '#4f8' : verdict === 'mismatch' ? '#f97' : '#9ab';
  badge.style.cssText = `color:${color};border:1px solid currentColor;border-radius:4px;`
    + 'padding:0 5px;flex:0 0 auto;';
  return badge;
}

/**
 * Slice 11 — the fact next to the shadow verdict for the same decision.
 *
 * Every line is stored bytes: the fact from the decision/impression, the
 * verdict from the committed plan snapshot. A unit without a plan is rendered
 * as an explicit reason, never as silence and never as agreement — and
 * out-of-scope decisions are listed rather than filtered, so the tab cannot
 * imply the shadow covered the whole feed.
 */
function renderSequencingShadowVsActual(
  view: SequencingDebugShadowVsActualViewV1,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  const head = seqBlock('window');
  head.append(
    seqRow('subjectUserId', view.subjectUserId),
    seqRow('limit (server echo)', seqText(view.limit)),
    // Kept short on purpose: the rows below are what the operator came for.
    seqRow('coverage', 'unplanned decisions are listed, each with its reason'),
    seqRow('verdict', "matchesActual is the server's stored comparison"),
  );
  out.push(head);

  const units = seqBlock(`fact vs shadow (${view.units.length})`);
  for (const unit of view.units) {
    const row = document.createElement('div');
    row.dataset.seqVs = 'unit';
    row.dataset.seqVsVerdict = unit.verdict;
    row.style.cssText = 'border-left:2px solid #253;padding:2px 0 4px 8px;margin-bottom:5px;';

    const headline = document.createElement('div');
    headline.style.cssText = 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;';
    const when = document.createElement('span');
    when.textContent = formatSequencingTimestamp(unit.issuedAt);
    when.style.cssText = 'color:#7a8;flex:0 0 auto;';
    // Fall back down the identity chain the server actually sent; never invent a
    // label for a family the stored plan did not name.
    const shown = unit.actual.familyId ?? unit.actual.catalogMechanic ?? unit.mechanicId ?? '—';
    const plan = unit.shadowPlan;
    const summary = document.createElement('span');
    summary.dataset.seqVsSummary = 'true';
    summary.textContent = plan === null
      ? `shown ${shown} · ${formatSequencingShadowAbsence(unit.absence)}`
      : `shown ${shown} · shadow would pick ${plan.chosenFamilyId ?? plan.chosenSlotType ?? '—'}`
        + `${plan.reason ? ` (${plan.reason})` : ''}`;
    summary.style.cssText = 'color:#cfe;word-break:break-all;';
    headline.append(when, seqVsBadge(unit.verdict), summary);
    row.append(headline);

    row.append(seqRow('shown', [
      `mechanic=${seqText(unit.mechanicId)}`,
      `catalog=${seqText(unit.actual.catalogMechanic)}`,
      `family=${seqText(unit.actual.familyId)}`,
      `slot=${seqText(unit.slotType)}`,
      `feedPosition=${seqText(unit.feedPosition)}`,
      unit.seen === true
        ? `seen ✓ ${formatSequencingTimestamp(unit.revealedAt)} · impression=${seqText(unit.impressionId)}`
        // A non-boolean `seen` is drift, not a negative fact.
        : unit.seen === false ? 'issued, not seen' : 'seen: unknown (drift)',
      `arm=${seqText(unit.armId)}`,
      `decision=${seqText(unit.decisionId)}`,
      `mapping=${seqText(unit.builtinMappingId)}`,
    ].join('  ')));

    if (plan === null) {
      const absence = seqRow('shadow', formatSequencingShadowAbsence(unit.absence));
      absence.dataset.seqVsAbsence = unit.absence?.reason ?? '';
      row.append(absence);
    } else {
      row.append(seqRow('shadow', [
        `slot=${seqText(plan.chosenSlotType)}`,
        `family=${seqText(plan.chosenFamilyId)}`,
        `reason=${seqText(plan.reason)}`,
        `matchesActual=${seqText(plan.matchesActual)}`,
        `conflicts=${plan.constraintConflicts.length
          ? plan.constraintConflicts.map(seqText).join(',') : '—'}`,
        `coldStart=${seqText(plan.coldStart.active)}`
        + ` probes=${seqText(plan.coldStart.probesSeen)}`
        + ` exit=${seqText(plan.coldStart.exitReason)}`,
      ].join('  ')));
      row.append(seqRow('shadow plan', [
        `plan=${seqText(plan.planId)}`,
        `digest=${seqText(plan.planDigest)}`,
        `asOf=${formatSequencingTimestamp(plan.asOf)}`,
      ].join('  ')));
    }
    units.append(row);
  }
  out.push(units);
  out.push(seqSources(view.sources));
  // Mandatory verbatim view: the rows above are a reading aid, not the evidence.
  out.push(seqRaw('raw response', view.raw));
  return out;
}

function renderSequencingResets(
  view: SequencingDebugHistoryViewV1,
  epoch: unknown,
): HTMLElement[] {
  const out: HTMLElement[] = [];
  const note = seqBlock('read-only');
  note.append(seqRow(
    '',
    'Reset receipts only. Personalization reset is an operator CLI act on the server'
    + ' (its double confirmation lives there); this panel issues no request that changes state.',
  ));
  out.push(note);
  // §12.4 names three epoch scopes; the current watermarks come from the profile
  // response already fetched for this subject — no extra endpoint is called.
  const scopes = seqBlock('current epoch scopes');
  if (epoch === undefined) {
    scopes.append(seqRow('', 'not loaded (open the Profile tab)'));
  } else {
    scopes.append(
      seqRow('personalization', `epoch=${seqText(seqField(epoch, 'personalizationEpoch'))}`
        + `  watermark=${formatSequencingTimestamp(seqField(epoch, 'personalizationWatermark'))}`),
      seqRow('exposures', `epoch=${seqText(seqField(epoch, 'exposuresEpoch'))}`
        + `  watermark=${formatSequencingTimestamp(seqField(epoch, 'exposuresWatermark'))}`),
      seqRow('onboarding', `epoch=${seqText(seqField(epoch, 'onboardingEpoch'))}`),
    );
  }
  out.push(scopes);
  const resets = seqBlock(`reset receipts (${view.resets.length})`);
  if (view.resets.length === 0) resets.append(seqRow('', 'no reset receipt for this subject'));
  for (const reset of view.resets) {
    resets.append(seqRow(
      seqText(reset.scope),
      [
        `effectiveAt=${formatSequencingTimestamp(reset.effectiveAt)}`,
        `newEpoch=${seqText(reset.newEpoch)}`,
        `receiptDigest=${seqText(reset.receiptDigest)}`,
        `resetId=${seqText(reset.resetId)}`,
      ].join('  '),
    ));
  }
  out.push(resets);
  out.push(seqRaw('raw resets', view.resets));
  return out;
}

// One sub-screen at a time: a second open replaces the first instead of
// stacking another full-screen overlay over a live one.
let closeMountedSequencingPanel: (() => void) | null = null;

export function mountSequencingDebugPanel(): void {
  closeMountedSequencingPanel?.();
  const wrap = document.createElement('div');
  wrap.dataset.panel = 'feed-sequencing-debug';
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;background:rgba(2,6,12,0.97);color:#cfe;'
    + 'font:12px/1.5 ui-monospace,monospace;padding:12px;display:flex;flex-direction:column;gap:8px;';

  const mkBtn = (label: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'padding:8px 12px;background:#1b2230;color:#cfe;border:1px solid #345;'
      + 'border-radius:6px;font:600 12px ui-monospace,monospace;';
    b.onclick = fn;
    return b;
  };

  const title = document.createElement('div');
  title.textContent = 'FEED SEQUENCING DEBUG (read-only, §12)';
  title.style.cssText = 'color:#8cf;font-weight:600;';

  const controls = document.createElement('div');
  controls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;';
  const subjectInput = document.createElement('input');
  subjectInput.placeholder = 'user_id (blank = me)';
  subjectInput.inputMode = 'numeric';
  subjectInput.dataset.seqInput = 'subject';
  subjectInput.style.cssText = 'width:150px;padding:6px 8px;background:#0a0f16;color:#cfe;'
    + 'border:1px solid #345;border-radius:6px;font:12px ui-monospace,monospace;';
  const limitInput = document.createElement('input');
  limitInput.dataset.seqInput = 'limit';
  limitInput.type = 'number';
  limitInput.min = String(SEQUENCING_DEBUG_HISTORY_LIMIT_MIN);
  limitInput.max = String(SEQUENCING_DEBUG_HISTORY_LIMIT_MAX);
  limitInput.value = String(SEQUENCING_DEBUG_HISTORY_LIMIT_DEFAULT);
  limitInput.style.cssText = 'width:72px;padding:6px 8px;background:#0a0f16;color:#cfe;'
    + 'border:1px solid #345;border-radius:6px;font:12px ui-monospace,monospace;';
  const limitLabel = document.createElement('span');
  limitLabel.textContent = 'history limit';
  limitLabel.style.cssText = 'color:#7a8;';

  const tabsRow = document.createElement('div');
  tabsRow.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
  const body = document.createElement('div');
  body.dataset.seqBody = 'true';
  body.style.cssText = 'flex:1;overflow:auto;border-top:1px solid #253;padding-top:8px;';

  const states: Partial<Record<SequencingDebugKind, SequencingDebugPanelStateV1 | 'loading'>> = {};
  // The subject each state was actually requested with, so a server echo can be
  // compared against the request that produced it rather than the live input.
  const requestedSubjects: Partial<Record<SequencingDebugKind, string>> = {};
  let active: SequencingTab = 'profile';
  // A subject/limit change invalidates every in-flight read: a late response
  // from the previous subject must never be painted under the new one.
  let generation = 0;

  const projectionOf = (tab: SequencingTab): SequencingDebugKind =>
    (tab === 'reset' ? 'history' : tab);

  function invalidate(): void {
    generation += 1;
    delete states.profile;
    delete states['why-now'];
    delete states.history;
    delete states['shadow-vs-actual'];
  }

  async function load(kind: SequencingDebugKind, force: boolean): Promise<void> {
    if (!force && states[kind] !== undefined) return;
    const subject = subjectInput.value;
    if (normalizeSequencingSubject(subject).status === 'invalid') {
      states[kind] = {
        kind,
        state: 'error',
        message: 'user_id must be a positive integer (leave it blank to read yourself)',
        retryable: false,
        view: null,
      };
      render();
      return;
    }
    const mine = generation;
    states[kind] = 'loading';
    requestedSubjects[kind] = subject;
    render();
    const result = kind === 'profile'
      ? await apiSequencingDebugProfile(subject)
      : kind === 'why-now'
        ? await apiSequencingDebugWhyNow(subject)
        : kind === 'shadow-vs-actual'
          ? await apiSequencingDebugShadowVsActual({ subject, limit: limitInput.value })
          : await apiSequencingDebugHistory({ subject, limit: limitInput.value });
    if (mine !== generation) return;
    states[kind] = buildSequencingDebugView(kind, result);
    render();
  }

  function renderState(tab: SequencingTab, state: SequencingDebugPanelStateV1): HTMLElement[] {
    const out: HTMLElement[] = [];
    if (state.state === 'unavailable' || state.state === 'error') {
      const line = document.createElement('div');
      line.dataset.seqState = state.state;
      line.textContent = state.message ?? '';
      line.style.cssText = `color:${state.state === 'unavailable' ? '#9ab' : '#f97'};`;
      out.push(line);
      // Only a transport failure offers a retry: the server's single 404 is a
      // final answer and re-asking it would just be noise.
      if (state.retryable) {
        const retry = mkBtn('↻ Retry', () => { void load(projectionOf(tab), true); });
        retry.dataset.seqAction = 'retry';
        out.push(retry);
      }
      return out;
    }
    if (state.state === 'empty' && state.message) {
      const line = document.createElement('div');
      line.dataset.seqState = 'empty';
      line.textContent = state.message;
      line.style.cssText = 'color:#9ab;';
      out.push(line);
    }
    const view = state.view;
    if (view === null) return out;
    const echoWarning = sequencingSubjectEchoWarning(
      requestedSubjects[projectionOf(tab)] ?? null,
      view.subjectUserId,
    );
    const warnings = seqWarnings(
      echoWarning === null ? view.warnings : [echoWarning, ...view.warnings],
    );
    if (warnings !== null) out.push(warnings);
    if (view.kind === 'profile') out.push(...renderSequencingProfile(view));
    else if (view.kind === 'why-now') out.push(...renderSequencingWhyNow(view));
    else if (view.kind === 'shadow-vs-actual') out.push(...renderSequencingShadowVsActual(view));
    else if (tab === 'reset') out.push(...renderSequencingResets(view, profileEpoch()));
    else out.push(...renderSequencingHistory(view));
    return out;
  }

  /** The epoch of the profile response already fetched for this subject. */
  function profileEpoch(): unknown {
    const profileState = states.profile;
    if (profileState === undefined || profileState === 'loading') return undefined;
    const view = profileState.view;
    return view !== null && view.kind === 'profile' ? view.epoch : undefined;
  }

  function render(): void {
    tabsRow.replaceChildren(...SEQUENCING_TABS.map((tab) => {
      const b = mkBtn(tab.label, () => {
        active = tab.id;
        void load(projectionOf(tab.id), false);
        // The reset tab reads the epoch scopes out of the profile projection, so
        // it makes sure that one exists for the current subject — the same
        // request the panel already issues, never a new endpoint.
        if (tab.id === 'reset') void load('profile', false);
        render();
      });
      b.dataset.seqTab = tab.id;
      if (tab.id === active) b.style.background = '#25405c';
      return b;
    }));
    limitInput.style.opacity = active === 'history' || active === 'reset'
      || active === 'shadow-vs-actual' ? '1' : '0.45';
    const state = states[projectionOf(active)];
    if (state === undefined) {
      const idle = document.createElement('div');
      idle.textContent = '(not loaded)';
      idle.style.cssText = 'color:#9ab;';
      body.replaceChildren(idle);
      return;
    }
    if (state === 'loading') {
      const loading = document.createElement('div');
      loading.textContent = 'loading…';
      loading.style.cssText = 'color:#9ab;';
      body.replaceChildren(loading);
      return;
    }
    const container = document.createElement('div');
    container.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    container.append(...renderState(active, state));
    body.replaceChildren(container);
  }

  subjectInput.onchange = () => { invalidate(); void load(projectionOf(active), true); };
  limitInput.onchange = () => {
    limitInput.value = String(normalizeSequencingHistoryLimit(limitInput.value));
    invalidate();
    // Only history reads the limit, but the invalidated tab must never be left
    // showing a stale or empty screen.
    void load(projectionOf(active), true);
  };

  function close(): void {
    // Bumping the generation first makes every in-flight read inert, so a late
    // response cannot resurrect a removed screen.
    generation += 1;
    wrap.remove();
    if (closeMountedSequencingPanel === close) closeMountedSequencingPanel = null;
  }

  const reloadBtn = mkBtn('↻ Reload tab', () => { void load(projectionOf(active), true); });
  reloadBtn.dataset.seqAction = 'reload';
  const closeBtn = mkBtn('✕ Close', close);
  closeBtn.dataset.seqAction = 'close';
  controls.append(subjectInput, limitLabel, limitInput, reloadBtn, closeBtn);

  wrap.append(title, controls, tabsRow, body);
  document.body.appendChild(wrap);
  closeMountedSequencingPanel = close;
  render();
  void load('profile', false);
}
// ── END feed sequencing debug sub-screen (§12) ─────────────────────────────
