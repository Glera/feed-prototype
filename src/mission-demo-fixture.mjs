/**
 * Synthetic Mission fixture shared by the browser acceptance and the focused
 * operator preview. These bytes use the same closed production wire parsed by
 * mission-core; there is deliberately no separate "demo" schema.
 */

export const MISSION_DEMO_CONTRIBUTION = Object.freeze({
  schema: 'mission.contribution-receipt.v1',
  seq: 7,
  userId: 79123,
  source: 'daily',
  sourceRef: 'login',
  idempotencyKey: 'mcd:79123:2026-08-01:login',
  amount: 1,
  weightsVersion: 'mission-weights.v1',
  weightsDigest: 'a'.repeat(64),
  allocations: [{ caseId: 'case-2', contractVersion: 'v1', amount: 1 }],
  openedGiftSteps: [{
    caseId: 'case-2',
    contractVersion: 'v1',
    stepIndex: 1,
    thresholdTokens: 5,
    amountCents: 1_000,
    progressAtOpen: 5,
  }],
  unlocked: null,
  bar: {
    caseId: 'case-2',
    contractVersion: 'v1',
    progress: 5,
    tokenGoal: 50,
    nextStepThreshold: 50,
  },
});

export const MISSION_DEMO_HISTORY = Object.freeze([{
  seq: 7,
  source: 'daily',
  amount: 1,
  caseId: 'case-2',
  at: '2026-08-01T09:59:00+00:00',
}]);

const FUNDING_POLICY_DOCUMENT = Object.freeze({
  schema: 'mission.funding-policy.v2',
  currency: 'EUR',
  rounding: 'declared-cents',
  giftFormula: 'guaranteed-plus-opened-steps-v1',
  stepRule: 'prefunded-reserved-at-ready-open-once-v1',
  snapshotRule: 'ledger-seq-alloc-cutoff-v1',
  poolConsumption: 'eligible-ledger-fifo-by-seq-v1',
  eligiblePool: { sources: ['seed', 'revenue_share'] },
});

export function missionDemoCaseWire({
  progress = 4,
  caseTokens = 2,
  unlockedSeq = null,
  fulfilledSeq = null,
} = {}) {
  const nextStepThreshold = progress < 5 ? 5 : progress < 50 ? 50 : null;
  return {
    schema: 'mission.case-view.v1',
    activeCase: {
      caseId: 'case-2',
      contractVersion: 'v1',
      bar: { progress, tokenGoal: 50, nextStepThreshold },
      money: {
        currency: 'EUR',
        communityTokens: progress,
        guaranteedCents: 10_000,
        ladderTotalCents: 12_000,
        collectedCents: progress < 5 ? 10_000 : progress < 50 ? 11_000 : 12_000,
        deliveredCents: 0,
      },
      giftLadder: [
        { stepIndex: 0, thresholdTokens: 0, amountCents: 10_000, state: 'guaranteed', openingReceipt: null },
        {
          stepIndex: 1,
          thresholdTokens: 5,
          amountCents: 1_000,
          state: progress < 5 ? 'reserved' : 'opened',
          openingReceipt: progress < 5 ? null : { contributionSeq: 7 },
        },
        {
          stepIndex: 2,
          thresholdTokens: 50,
          amountCents: 1_000,
          state: progress < 50 ? 'reserved' : 'opened',
          openingReceipt: null,
        },
      ],
      contract: {
        caseId: 'case-2',
        contractVersion: 'v1',
        contractDigest: 'b'.repeat(64),
        document: {
          schema: 'mission.case-contract.v2',
          caseId: 'case-2',
          contractVersion: 'v1',
          recipient: 'Приют «Лапа»',
          needKind: 'scalable',
          guaranteedDeliverable: '10 кг корма',
          stretchDeliverables: [],
          rolloverRule: 'остаток переходит в следующий кейс',
          confirmationKind: 'photo_report',
          currency: 'EUR',
          guaranteedCents: 10_000,
          confirmedNeedCents: 50_000,
          stretchCapCents: 20_000,
          tokenGoal: 50,
          giftLadder: [
            { stepIndex: 0, thresholdTokens: 0, amountCents: 10_000 },
            { stepIndex: 1, thresholdTokens: 5, amountCents: 1_000 },
            { stepIndex: 2, thresholdTokens: 50, amountCents: 1_000 },
          ],
          ladderTotalCents: 12_000,
          unlockCutoffAt: '2026-09-01T00:00:00+00:00',
          latestFulfillmentAt: '2026-09-15T00:00:00+00:00',
          queuePosition: 1,
          fundingPolicy: { version: 'mission-funding.v2', digest: 'c'.repeat(64) },
        },
        fundingPolicy: {
          version: 'mission-funding.v2',
          digest: 'c'.repeat(64),
          document: FUNDING_POLICY_DOCUMENT,
        },
      },
    },
    myContribution: { caseTokens, totalTokens: caseTokens },
    lastUnlocked: unlockedSeq === null ? null : {
      eventSeq: unlockedSeq,
      caseId: 'case-1',
      contractVersion: 'v1',
      occurredAt: '2026-08-01T10:00:00+00:00',
      receiptDigest: 'd'.repeat(64),
      receipt: {
        guaranteedCents: 10_000,
        giftTotalCents: 12_000,
        releasedUnopenedCents: 0,
        progress: 50,
        tokenGoal: 50,
      },
      transferReceipt: null,
    },
    lastFulfilled: fulfilledSeq === null ? null : {
      eventSeq: fulfilledSeq,
      caseId: 'case-1',
      contractVersion: 'v1',
      occurredAt: '2026-08-02T10:00:00+00:00',
      receiptDigest: 'e'.repeat(64),
      receipt: { giftTotalCents: 12_000 },
      transferReceipt: {
        amountCents: 12_000,
        currency: 'EUR',
        transferDate: '2026-08-02',
        recipient: 'Приют «Лапа»',
        transferReference: 'internal-do-not-render',
      },
    },
  };
}
