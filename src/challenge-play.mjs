/**
 * Share / Challenge v1 play orchestration (recipient + source), spec §4 + v1.4.2.
 *
 * DOM- and transport-agnostic glue: it sequences the exact wire the frozen
 * backend expects and enforces the client-side invariants, delegating the actual
 * iframe mount/win-detection to an injected `mountLevel`. Dependency-injected so
 * it is unit-checkable without api.ts / the DOM (check-challenge-play.mjs).
 *
 * The ONE non-negotiable invariant enforced here (P3-2 of the internal review):
 * `verifyBundleIdentity` — the client recomputes the per-level specHash and
 * proves it equals the server bundle's expectedSpecHash — is awaited BEFORE the
 * level is ever mounted. Skipping it would let a server bundle bypass the D8
 * identity closure, so a failure aborts with `challenge_identity_mismatch` and
 * nothing is mounted, played, or reported.
 */

export class ChallengePlayError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ChallengePlayError';
    this.code = code;
  }
}

/**
 * @typedef {Object} ChallengePlayDeps
 * @property {(id: string) => Promise<any>} getSpecBoundView   apiGetChallengeSpecBoundRequired
 * @property {(id: string) => Promise<any>} acceptChallenge    apiAcceptChallengeV1Required
 * @property {(req: any) => Promise<any>} startRecipientRun    apiStartChallengeRecipientRunRequired
 * @property {(req: any) => Promise<any>} startSourceRun       apiStartChallengeSourceRunRequired
 * @property {(ticketId: string) => Promise<any>} getLevelBundle  apiGetChallengeLevelBundleRequired
 * @property {(requestId: string) => Promise<any>} createSourceLevel  apiCreateSourceLevelRequired
 * @property {(payload: any) => Promise<any>} postResult       apiPostChallengeResultRequired
 * @property {(payload: any) => Promise<any>} complete         apiCompleteChallengeV1Required
 * @property {(payload: any) => Promise<any>} createChallenge  apiCreateChallengeV1Required
 * @property {(bundle: any) => Promise<boolean>} verifyBundleIdentity  verifyChallengeBundleIdentity
 * @property {(ctx: {bundle: any, kind: 'recipient'|'source'}) => Promise<{metricValue: number}>} mountLevel
 * @property {() => string} newUuid
 * @property {() => number=} tzOffsetMinutes
 */

async function loadAndVerifyBundle(deps, ticketId) {
  const bundle = await deps.getLevelBundle(ticketId);
  // P3-2: recompute the per-level content address on the client and require it to
  // match before the level is mounted. Never trust the server bundle blindly.
  let ok = false;
  try {
    ok = await deps.verifyBundleIdentity(bundle);
  } catch (error) {
    throw new ChallengePlayError('challenge_identity_error', `identity recompute failed: ${error?.message ?? error}`);
  }
  if (!ok) throw new ChallengePlayError('challenge_identity_mismatch', 'client-recomputed specHash != server expectedSpecHash');
  return bundle;
}

/**
 * Recipient plays a spec-bound challenge: view → accept → recipient run.start →
 * level-bundle (+identity gate) → mount → result → complete.
 * @param {ChallengePlayDeps} deps
 * @param {{challengeId: string, mechanicId: string, variantId: string}} input
 */
export async function playRecipientChallenge(deps, input) {
  const view = await deps.getSpecBoundView(input.challengeId);
  if (!view || !view.spec_digest) {
    // A legacy (non-spec-bound) challenge must not enter the v1 flow.
    throw new ChallengePlayError('challenge_not_spec_bound', 'challenge is not spec-bound; use the legacy path');
  }
  await deps.acceptChallenge(input.challengeId);

  const ticketId = deps.newUuid();
  const runId = `chr-${deps.newUuid()}`;
  await deps.startRecipientRun({
    ticket_id: ticketId,
    run_id: runId,
    mechanic_id: input.mechanicId,
    variant_id: input.variantId,
    kind: 'single',
    challenge_id: input.challengeId,
  });

  const bundle = await loadAndVerifyBundle(deps, ticketId);
  const { metricValue } = await deps.mountLevel({ bundle, kind: 'recipient' });

  await deps.postResult({
    mechanic_id: input.mechanicId,
    variant_id: input.variantId,
    run_id: runId,
    ticket_id: ticketId,
    metric_value: metricValue,
    applied_spec_digest: bundle.specDigest,
    tz_offset_minutes: deps.tzOffsetMinutes ? deps.tzOffsetMinutes() : 0,
  });

  const result = await deps.complete({
    id: input.challengeId,
    source_run_id: runId,
    applied_spec_digest: bundle.specDigest,
  });
  return { view, bundle, runId, ticketId, metricValue, result };
}

/**
 * Source flow ("Бросить вызов"): server-issued source level → source run.start →
 * level-bundle (+identity gate) → mount → result → create challenge.
 * @param {ChallengePlayDeps} deps
 * @param {{mechanicId: string, variantId: string, requestId: string}} input
 */
export async function playSourceChallenge(deps, input) {
  const offer = await deps.createSourceLevel(input.requestId);
  if (!offer || !offer.spec_digest || !offer.challengeSpec) {
    throw new ChallengePlayError('challenge_source_offer_invalid', 'source-level offer is malformed');
  }

  const ticketId = deps.newUuid();
  const runId = `chs-${deps.newUuid()}`;
  // run.start accepts ONLY the four authored fields; the runtime digests in the
  // offer are reference-only (the server re-derives them for the spec_digest and
  // enforces anti-substitution against the recorded offer).
  await deps.startSourceRun({
    schema: 'run.start.challenge.v1',
    purpose: 'challenge_source',
    ticket_id: ticketId,
    run_id: runId,
    mechanic_id: input.mechanicId,
    variant_id: input.variantId,
    kind: 'single',
    challengeSpec: {
      playableId: offer.challengeSpec.playableId,
      adapterVersion: offer.challengeSpec.adapterVersion,
      schemaVersion: offer.challengeSpec.schemaVersion,
      params: offer.challengeSpec.params,
    },
  });

  const bundle = await loadAndVerifyBundle(deps, ticketId);
  if (bundle.specDigest !== offer.spec_digest) {
    throw new ChallengePlayError('challenge_source_digest_drift', 'source bundle digest differs from the issued offer');
  }
  const { metricValue } = await deps.mountLevel({ bundle, kind: 'source' });

  await deps.postResult({
    mechanic_id: input.mechanicId,
    variant_id: input.variantId,
    run_id: runId,
    ticket_id: ticketId,
    metric_value: metricValue,
    applied_spec_digest: bundle.specDigest,
    tz_offset_minutes: deps.tzOffsetMinutes ? deps.tzOffsetMinutes() : 0,
  });

  const created = await deps.createChallenge({
    mechanic_id: input.mechanicId,
    variant_id: input.variantId,
    source_run_id: runId,
    request_id: input.requestId,
  });
  return { offer, bundle, runId, ticketId, metricValue, created };
}
