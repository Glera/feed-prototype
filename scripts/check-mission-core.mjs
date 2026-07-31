// Mission slice v0 — client contract checks.
//
// Two halves:
//   1. behaviour of `src/mission-core.mjs` (receipt parsing, the ceremony
//      watermark, the admission predicate, money formatting, history);
//   2. a structural proof that EVERY exported entry point of `src/mission.ts`
//      opens with the admission gate, so a build without the flag or an account
//      without the `mission_dogfood` capability can never mount a node or issue
//      an `/api/mission/*` request.
//
// The fixtures are copied from the backend's own tests
// (`swipe-backend/tests/test_mission_api.py`), not invented here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  advanceMissionWatermark,
  appendMissionHistory,
  formatMissionMoney,
  isContributionPresented,
  rememberPresentedContribution,
  missionBarPercent,
  missionCaseSubtitle,
  missionCaseTitle,
  missionOpenedByPlayCents,
  missionSurfaceEnabled,
  normaliseMissionWatermark,
  parseMissionCaseView,
  parseMissionContributionReceipt,
  parseMissionHistory,
  pendingMissionCeremonies,
} from '../src/mission-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let assertions = 0;
const eq = (actual, expected, message) => { assertions += 1; assert.equal(actual, expected, message); };
const deep = (actual, expected, message) => { assertions += 1; assert.deepEqual(actual, expected, message); };

// ── receipt parser ──────────────────────────────────────────────────────────
const RECEIPT = {
  schema: 'mission.contribution-receipt.v1',
  seq: 1,
  userId: 4242424242,
  source: 'series',
  sourceRef: 'run-enrolled-1',
  idempotencyKey: 'mc:run-enrolled-1',
  amount: 2,
  weightsVersion: 'mission-weights.v1',
  weightsDigest: 'a'.repeat(64),
  allocations: [{ caseId: 'case-1', contractVersion: 'v1', amount: 2 }],
  unlocked: null,
  bar: { caseId: 'case-1', contractVersion: 'v1', progress: 2, tokenGoal: 50 },
};

const receipt = parseMissionContributionReceipt(RECEIPT);
eq(receipt?.amount, 2, 'the ceremony amount comes from the receipt, never from rewards.mjs');
eq(receipt?.bar.progress, 2, 'the bar is the receipt bar');
eq(receipt?.bar.tokenGoal, 50, 'the goal is the receipt goal');
deep(receipt?.allocations, [{ caseId: 'case-1', contractVersion: 'v1', amount: 2 }], 'allocations survive');
eq(receipt?.unlocked, null, 'a non-crossing contribution carries no UNLOCKED snapshot');

// Absent block = the feature is off for this caller. Never an error.
for (const missing of [undefined, null, {}, '', 0, [], 'mission.contribution-receipt.v1']) {
  eq(parseMissionContributionReceipt(missing), null, 'a missing/foreign block is silently no mission');
}
eq(
  parseMissionContributionReceipt({ ...RECEIPT, schema: 'mission.contribution-receipt.v2' }),
  null,
  'an unknown receipt schema is refused rather than half-read',
);
eq(parseMissionContributionReceipt({ ...RECEIPT, bar: undefined }), null, 'no bar → no ceremony');
eq(
  parseMissionContributionReceipt({ ...RECEIPT, bar: { ...RECEIPT.bar, tokenGoal: 0 } }),
  null,
  'a zero goal would render a division by zero bar; refuse it',
);
eq(parseMissionContributionReceipt({ ...RECEIPT, amount: '2' }), null, 'a stringly amount is refused');
deep(
  parseMissionContributionReceipt({ ...RECEIPT, allocations: [{ caseId: 'case-1' }, 7, null] })?.allocations,
  [],
  'structurally broken allocations are dropped, not rendered',
);

const CROSSED = {
  ...RECEIPT,
  seq: 2,
  unlocked: {
    eventSeq: 11,
    caseId: 'case-1',
    contractVersion: 'v1',
    progress: 2,
    tokenGoal: 2,
    guaranteedCents: 10_000,
    giftAdditionalCents: 12_000,
    giftTotalCents: 22_000,
    nextCaseId: 'case-successor',
    nextContractVersion: 'v1',
  },
  bar: { caseId: 'case-successor', contractVersion: 'v1', progress: 0, tokenGoal: 50 },
};
eq(parseMissionContributionReceipt(CROSSED)?.unlocked?.nextCaseId, 'case-successor', 'the successor travels');
eq(parseMissionContributionReceipt(CROSSED)?.bar.caseId, 'case-successor', 'the bar follows the new ACTIVE case');

// ── read API parser ─────────────────────────────────────────────────────────
const VIEW = {
  schema: 'mission.case-view.v1',
  activeCase: {
    caseId: 'case-2',
    contractVersion: 'v1',
    bar: { progress: 4, tokenGoal: 50 },
    money: {
      currency: 'EUR',
      communityTokens: 4,
      guaranteedCents: 10_000,
      reservedCents: 10_000,
      reservedAndOpenedCents: 10_000,
      deliveredCents: 0,
    },
    contract: {
      caseId: 'case-2',
      contractVersion: 'v1',
      contractDigest: 'b'.repeat(64),
      document: {
        schema: 'mission.case-contract.v1',
        caseId: 'case-2',
        recipient: 'Local shelter',
        guaranteedDeliverable: '10 kg of food',
        currency: 'EUR',
      },
      fundingPolicy: { version: 'mission-funding.v1', digest: 'c'.repeat(64), document: { rounding: 'floor_to_cent' } },
    },
  },
  myContribution: { caseTokens: 2, totalTokens: 6 },
  lastUnlocked: {
    eventSeq: 11,
    caseId: 'case-1',
    contractVersion: 'v1',
    occurredAt: '2026-08-01T10:00:00+00:00',
    receiptDigest: 'd'.repeat(64),
    receipt: { guaranteedCents: 10_000, giftAdditionalCents: 12_000, giftTotalCents: 22_000 },
  },
  lastFulfilled: {
    eventSeq: 9,
    caseId: 'case-0',
    contractVersion: 'v1',
    occurredAt: '2026-07-20T10:00:00+00:00',
    receiptDigest: 'e'.repeat(64),
    receipt: {},
    transferReceipt: {
      schema: 'mission.fulfillment-receipt.v1',
      amountCents: 21_000,
      currency: 'EUR',
      recipient: 'Local shelter',
      transferReference: 'SEPA-77',
      transferDate: '2026-08-09',
    },
  },
};

const view = parseMissionCaseView(VIEW);
eq(view?.activeCase?.caseId, 'case-2', 'the ACTIVE case is projected');
eq(view?.myContribution.caseTokens, 2, 'the paw badge value is my case tokens, not a puzzle balance');
eq(view?.lastFulfilled?.transferReceipt?.transferReference, 'SEPA-77', 'the transfer receipt travels');
eq(parseMissionCaseView(null), null, 'a 404 (not enrolled) is simply no mission');
eq(parseMissionCaseView({ schema: 'mission.case-view.v2' }), null, 'an unknown view schema is refused');
eq(
  parseMissionCaseView({ ...VIEW, activeCase: null })?.activeCase,
  null,
  'a runtime between cases still parses, with no ACTIVE case',
);
eq(
  parseMissionCaseView({ ...VIEW, activeCase: { ...VIEW.activeCase, money: undefined } })?.activeCase,
  null,
  'an unreadable money block drops the case rather than showing invented numbers',
);

// ── ceremony watermark: each ceremony exactly once ──────────────────────────
const first = pendingMissionCeremonies(view, null);
deep(first.map((item) => item.kind), ['fulfilled', 'unlocked'], 'owed ceremonies come in causal (seq) order');
eq(first.length, 2, 'a first entry is owed BOTH ceremonies — unlike the island watermark');

let mark = normaliseMissionWatermark(null);
deep(mark, { unlocked: null, fulfilled: null }, 'an absent watermark is two nulls, never a throw');
mark = advanceMissionWatermark(mark, 'fulfilled', 9);
deep(
  pendingMissionCeremonies(view, mark).map((item) => item.kind),
  ['unlocked'],
  'the two watermarks are independent: settling FULFILLED still owes UNLOCKED',
);
mark = advanceMissionWatermark(mark, 'unlocked', 11);
deep(pendingMissionCeremonies(view, mark), [], 'a shown ceremony is never shown again');
deep(
  pendingMissionCeremonies(view, advanceMissionWatermark(mark, 'unlocked', 3)),
  [],
  'a lower seq can never walk the watermark back and replay a ceremony',
);
eq(advanceMissionWatermark(mark, 'unlocked', 'eleven').unlocked, 11, 'an unparseable seq leaves the mark alone');
eq(advanceMissionWatermark(mark, 'ready', 99).unlocked, 11, 'an unknown ceremony kind changes nothing');
deep(
  normaliseMissionWatermark({ unlocked: 'x', fulfilled: 4, junk: 1 }),
  { unlocked: null, fulfilled: 4 },
  'a corrupted watermark degrades to «not yet shown», never to a crash',
);
deep(pendingMissionCeremonies(null, mark), [], 'no view → no ceremony');
deep(
  pendingMissionCeremonies({ ...view, lastUnlocked: null, lastFulfilled: null }, null),
  [],
  'a case that never crossed owes nothing',
);
// A NEWER event of the same kind is owed again — the slice has more than one case.
eq(
  pendingMissionCeremonies({ ...view, lastUnlocked: { ...view.lastUnlocked, eventSeq: 21 } }, mark).length,
  1,
  'the next case crossing is a new ceremony',
);

// ── admission ───────────────────────────────────────────────────────────────
eq(missionSurfaceEnabled(true, true), true, 'both gates open the surface');
for (const [flag, capability] of [[true, false], [false, true], [false, false]]) {
  eq(missionSurfaceEnabled(flag, capability), false, 'either gate closed keeps the surface off');
}
for (const truthy of [1, 'true', {}, [], 'yes']) {
  eq(missionSurfaceEnabled(true, truthy), false, 'the capability must be exactly true');
  eq(missionSurfaceEnabled(truthy, true), false, 'the build flag must be exactly true');
}
eq(missionSurfaceEnabled(undefined, undefined), false, 'the default is off');

// ── money and copy ──────────────────────────────────────────────────────────
eq(formatMissionMoney(10_000, 'EUR'), '€100', 'whole euros lose the cents');
eq(formatMissionMoney(9_950, 'EUR'), '€99,50', 'cents are shown with the locale comma');
eq(formatMissionMoney(5, 'EUR'), '€0,05', 'a five-cent gift is still five cents');
eq(formatMissionMoney(0, 'EUR'), '€0', 'nothing delivered yet reads as zero, not blank');
eq(formatMissionMoney(1_000, 'XYZ'), '10 XYZ', 'an unknown currency keeps its code');
eq(formatMissionMoney('10000', 'EUR'), '€0', 'a stringly amount is never coerced into money');
eq(missionOpenedByPlayCents(view.activeCase.money), 0, 'nothing is opened before a crossing');
eq(
  missionOpenedByPlayCents({ reservedCents: 10_000, reservedAndOpenedCents: 22_000 }),
  12_000,
  'opened-by-play is exactly what the crossing added over the reserve',
);
eq(missionOpenedByPlayCents(null), 0, 'no money block → nothing opened');

eq(missionCaseTitle(VIEW.activeCase.contract.document), '10 kg of food', 'the deliverable names the case');
eq(missionCaseTitle({ title: 'Корм для приюта', guaranteedDeliverable: 'x' }), 'Корм для приюта', 'an explicit title wins');
eq(missionCaseTitle({ caseId: 'case-9' }), 'case-9', 'the case id is the last resort');
eq(missionCaseTitle(null), 'Кейс', 'a missing contract still renders a name');
eq(missionCaseSubtitle(VIEW.activeCase.contract.document), 'Local shelter', 'the recipient is the subtitle');
eq(missionCaseSubtitle({ recipient: 'Приют', place: 'Тбилиси' }), 'Приют · Тбилиси', 'place joins the recipient');
eq(missionCaseSubtitle({}), '', 'an empty contract has no subtitle');

eq(missionBarPercent(2, 50), 4, 'the bar is progress over goal');
eq(missionBarPercent(80, 50), 100, 'progress past the goal clamps at full');
eq(missionBarPercent(-5, 50), 0, 'a negative progress clamps at empty');
eq(missionBarPercent(5, 0), 0, 'a zero goal cannot divide');

// ── my own contribution history ─────────────────────────────────────────────
let history = [];
history = appendMissionHistory(history, { seq: 1, source: 'series', amount: 2, caseId: 'case-1', at: 'a' });
history = appendMissionHistory(history, { seq: 2, source: 'daily', amount: 1, caseId: 'case-1', at: 'b' });
deep(history.map((row) => row.seq), [2, 1], 'history is newest first');
history = appendMissionHistory(history, { seq: 1, source: 'series', amount: 2, caseId: 'case-1', at: 'c' });
eq(history.length, 2, 'an outbox replay of the same contribution seq is not a second entry');
history = appendMissionHistory(history, { source: 'series', amount: 9 });
eq(history.length, 2, 'an entry without an immutable seq is dropped');
let bounded = [];
for (let seq = 1; seq <= 20; seq += 1) bounded = appendMissionHistory(bounded, { seq, source: 'series', amount: 1 }, 3);
deep(bounded.map((row) => row.seq), [20, 19, 18], 'history stays bounded, newest kept');
deep(parseMissionHistory('nope'), [], 'a corrupted stored history degrades to empty');
deep(parseMissionHistory([{ seq: 5, source: 'daily', amount: 1 }, null, 3]).length, 1, 'broken rows are dropped');

// ── exactly one ceremony per contribution, whichever door it arrives through ──
// The daily claim can succeed on the FIRST answer, or only on a background retry
// after a lost response / the mandatory retryable 503 of an empty case queue; a
// series result can additionally be replayed by the outbox. All three carry the
// same committed receipt, and the immutable seq is what makes them one fact.
const DAILY_RECEIPT = {
  ...RECEIPT,
  seq: 7,
  source: 'daily',
  sourceRef: 'login',
  idempotencyKey: 'mcd:4242424242:2026-08-01:login',
  amount: 1,
};
const replayed = parseMissionContributionReceipt(DAILY_RECEIPT);
const retried = parseMissionContributionReceipt({ ...DAILY_RECEIPT });
eq(replayed.seq, retried.seq, 'a retry answer replays the same committed contribution seq');

let shown = [];
eq(isContributionPresented(shown, replayed.seq), false, 'the first success owes a ceremony');
shown = rememberPresentedContribution(shown, replayed.seq);
eq(isContributionPresented(shown, retried.seq), true, 'the retry/replay of the same contribution owes nothing');
eq(shown.length, 1, 'the retry does not record a second presentation');
// …and the history row is deduplicated by exactly the same identity.
let dailyHistory = appendMissionHistory([], { seq: replayed.seq, source: 'daily', amount: 1 });
dailyHistory = appendMissionHistory(dailyHistory, { seq: retried.seq, source: 'daily', amount: 1 });
eq(dailyHistory.length, 1, '503 → replay must leave exactly one history row');

const NEXT_DAY = 8;
eq(isContributionPresented(shown, NEXT_DAY), false, 'a genuinely new contribution is a new ceremony');
eq(isContributionPresented(shown, undefined), false, 'an unparseable seq is never «already shown»');
eq(rememberPresentedContribution(shown, 'x').length, 1, 'an unparseable seq is not recorded');
eq(rememberPresentedContribution(null, 3)[0], 3, 'a missing list starts clean');
let ring = [];
for (let seq = 1; seq <= 40; seq += 1) ring = rememberPresentedContribution(ring, seq, 5);
deep(ring, [36, 37, 38, 39, 40], 'the presented ring stays bounded, newest kept');
eq(isContributionPresented(ring, 1), false, 'an evicted seq is forgotten (bounded memory, not a leak)');

// ── structural: nothing mounts without the gate ─────────────────────────────
const missionSource = readFileSync(path.join(root, 'src/mission.ts'), 'utf8');
const GATES = ['MISSION_FLAG_ENABLED', 'missionActive()'];

/** The first executable statements of `export function NAME(...)`, found by
 *  balancing the parameter parentheses (a TS parameter type is full of braces,
 *  so brace counting from the signature would not survive it). */
function firstStatements(source, name, count = 2) {
  const start = source.indexOf(`export function ${name}(`);
  if (start < 0) return null;
  let index = source.indexOf('(', start);
  for (let depth = 0; index < source.length; index += 1) {
    if (source[index] === '(') depth += 1;
    else if (source[index] === ')' && (depth -= 1) === 0) break;
  }
  const bodyStart = source.indexOf('{', index);
  if (bodyStart < 0) return null;
  return source.slice(bodyStart + 1)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'))
    .slice(0, count)
    .join('\n');
}

for (const name of [
  'applyMissionCapability',
  'mountMissionHud',
  'refreshMissionCase',
  'presentMissionContribution',
  'presentMissionDailyContribution',
]) {
  const head = firstStatements(missionSource, name);
  assertions += 1;
  assert.ok(head, `${name} must be an exported entry point of src/mission.ts`);
  assertions += 1;
  assert.ok(
    GATES.some((gate) => head.includes(gate)) && head.includes('return'),
    `${name} must open with the flag/capability gate so an ungated call mounts nothing`,
  );
}
assertions += 1;
assert.ok(
  /apiMissionCase\(\)/.test(missionSource)
    && /export function refreshMissionCase[\s\S]*?if \(!missionActive\(\)\) return/.test(missionSource),
  'the only /api/mission/* call must sit behind missionActive()',
);

// The single ceremony presenter must be reached from EVERY daily-claim success,
// not only the first answer (R1 finding 4).
assertions += 1;
assert.ok(
  /function showContributionCard[\s\S]*?isContributionPresented\(presented, receipt\.seq\)/.test(missionSource),
  'both contribution paths must share one presenter, deduplicated by the immutable seq',
);
// The revoked capability must restore the badge (R1 finding 6).
assertions += 1;
assert.ok(
  /function teardownMissionSurface[\s\S]*?restoreMissionBadge\(badgeEl\)/.test(missionSource),
  'teardown must restore the HUD badge, not only remove the bar/screen/ceremony',
);

const uiSource = readFileSync(path.join(root, 'src/mission-ui.ts'), 'utf8');
// The retheme must be additive, so the restore is exact by construction and the
// puzzle-value node feed.ts holds is never detached.
assertions += 1;
assert.ok(
  /export function applyMissionPawBadge[\s\S]*?badge\.appendChild\(paw\)/.test(uiSource)
    && !/export function applyMissionPawBadge[\s\S]*?badge\.replaceChildren\(\)/.test(uiSource),
  'the paw retheme must append, never replace, the badge children',
);
// The four obligatory money numbers (R1 finding 5): the community bar, the
// guarantee, what the pool actually holds, and what really left.
assertions += 1;
assert.ok(
  /tile\(\s*'Зарезервировано и открыто',\s*formatMissionMoney\(active\.money\.reservedAndOpenedCents/.test(uiSource),
  'the case screen must show the full reservedAndOpened amount, not only the delta',
);
for (const label of ['Гарантировано', 'Передано', 'Мои лапки', 'лапок сообщества', 'открыто игрой']) {
  assertions += 1;
  assert.ok(uiSource.includes(label), `the case screen must keep the «${label}» number`);
}

const feedSource = readFileSync(path.join(root, 'src/feed.ts'), 'utf8');
assertions += 1;
assert.ok(
  !/from '\.\/mission-ui'/.test(feedSource) && !/from '\.\/mission-core\.mjs'/.test(feedSource),
  'feed.ts must reach the mission only through src/mission.ts — no markup, no parsing',
);
const claimSuccesses = feedSource.match(/const state = await apiDailyClaimRequired\([\s\S]{0,600}?presentMissionDaily/g) ?? [];
assertions += 1;
assert.equal(
  claimSuccesses.length,
  (feedSource.match(/await apiDailyClaimRequired\(/g) ?? []).length,
  'every daily-claim success path — first answer AND background retry — must reach the presenter',
);
assertions += 1;
assert.ok(
  !/missionOwnsHudBadge/.test(feedSource),
  'the puzzle counter no longer needs a mission gate: the retheme hides, never replaces',
);

const islandDiff = readFileSync(path.join(root, 'src/island.ts'), 'utf8');
assertions += 1;
assert.ok(!/mission/i.test(islandDiff.split('\n').filter((line) => line.includes('import')).join('\n')),
  'island.ts must not learn about the mission');

console.log(`mission slice v0 client contract: ${assertions} assertions passed`);
