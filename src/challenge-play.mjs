/**
 * Share / Challenge v1 play orchestration (recipient + source), spec §4 + v1.4.2.
 *
 * DOM- and transport-agnostic glue: it sequences the exact wire the frozen
 * backend expects and enforces the client-side invariants, delegating the actual
 * iframe mount/win-detection to an injected `mountLevel`. Dependency-injected so
 * it is unit-checkable without api.ts / the DOM (check-challenge-play.mjs).
 *
 * P1-4 invariant (identity closure): `verifyBundleIdentity` — the client recomputes
 * the per-level specHash and proves it equals the server bundle's expectedSpecHash
 * — is awaited BEFORE the level is ever mounted. A failure aborts with
 * `challenge_identity_mismatch` and nothing is mounted, played, or reported.
 *
 * P1-3 invariant (durable phase envelope): the operation's ids (requestId,
 * ticketId, runId) are minted ONCE by the caller into a persisted envelope BEFORE
 * the first POST and reused verbatim on every retry/reload; each committed step
 * checkpoints a phase and freezes its payload (specDigest, metricValue, result).
 * A retry/reload RESUMES from the last committed phase — it never re-mints ids,
 * never re-plays a frozen metric, and never re-issues a committed create — so a
 * lost response leaves at most one offer / run / challenge (backend idempotency by
 * request_id/ticket_id/run_id does the deduplication; this envelope guarantees the
 * ids handed to it are stable and the payload frozen).
 */

export class ChallengePlayError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ChallengePlayError';
    this.code = code;
  }
}

// Ordered lifecycle phases. Recipient skips 'offer' and ends at 'completed';
// source ends at 'created'. Both terminal phases sit at the end.
export const CHALLENGE_PHASES = ['init', 'offer', 'started', 'played', 'reported', 'completed', 'created'];

function phaseIndex(phase) {
  const i = CHALLENGE_PHASES.indexOf(phase);
  return i < 0 ? 0 : i;
}

/** True once the envelope has committed AT LEAST up to `phase`. */
function reached(env, phase) {
  return phaseIndex(env.getPhase()) >= phaseIndex(phase);
}

async function loadAndVerifyBundle(deps, ticketId) {
  const bundle = await deps.getLevelBundle(ticketId);
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
 * @typedef {Object} ChallengePlayEnvelope
 * @property {{requestId?: string, ticketId: string, runId: string}} ids  minted ONCE, durable
 * @property {() => string} getPhase   last committed phase
 * @property {() => Object} getData    frozen payload {specDigest, metricValue, result, created}
 * @property {(phase: string, extra?: Object) => void} checkpoint  persist phase (+merge data)
 */

/**
 * Recipient plays a spec-bound challenge: view → accept → recipient run.start →
 * level-bundle (+identity gate) → mount → result → complete. Resumable (P1-3).
 * @param {ChallengePlayEnvelope} env
 */
export async function playRecipientChallenge(deps, input, env) {
  const { ticketId, runId } = env.ids;
  if (!reached(env, 'completed')) {
    const view = await deps.getSpecBoundView(input.challengeId);
    if (!view || !view.spec_digest) {
      throw new ChallengePlayError('challenge_not_spec_bound', 'challenge is not spec-bound; use the legacy path');
    }
    await deps.acceptChallenge(input.challengeId); // idempotent (backend dedups by challenge+actor)
  }

  if (!reached(env, 'started')) {
    await deps.startRecipientRun({
      ticket_id: ticketId,
      run_id: runId,
      mechanic_id: input.mechanicId,
      variant_id: input.variantId,
      kind: 'single',
      challenge_id: input.challengeId,
    });
    env.checkpoint('started');
  }

  let { specDigest, metricValue } = env.getData();
  if (!reached(env, 'played')) {
    const bundle = await loadAndVerifyBundle(deps, ticketId);
    specDigest = bundle.specDigest;
    ({ metricValue } = await deps.mountLevel({ bundle, kind: 'recipient' }));
    env.checkpoint('played', { specDigest, metricValue });
  }

  if (!reached(env, 'reported')) {
    await deps.postResult({
      mechanic_id: input.mechanicId,
      variant_id: input.variantId,
      run_id: runId,
      ticket_id: ticketId,
      metric_value: metricValue,
      applied_spec_digest: specDigest,
      tz_offset_minutes: deps.tzOffsetMinutes ? deps.tzOffsetMinutes() : 0,
    });
    env.checkpoint('reported');
  }

  if (!reached(env, 'completed')) {
    const result = await deps.complete({
      id: input.challengeId,
      source_run_id: runId,
      applied_spec_digest: specDigest,
    });
    env.checkpoint('completed', { result });
  }
  return { runId, ticketId, metricValue: env.getData().metricValue, result: env.getData().result };
}

/**
 * Source flow ("Бросить вызов"): server-issued source level → source run.start →
 * level-bundle (+identity gate) → mount → result → create challenge. Resumable (P1-3).
 * @param {ChallengePlayEnvelope} env
 */
export async function playSourceChallenge(deps, input, env) {
  const requestId = env.ids.requestId ?? input.requestId;
  const { ticketId, runId } = env.ids;

  // createSourceLevel is idempotent by request_id: on retry it returns the SAME
  // frozen offer, so a durable request_id yields at most one offer/spec.
  const offer = await deps.createSourceLevel(requestId);
  if (!offer || !offer.spec_digest || !offer.challengeSpec) {
    throw new ChallengePlayError('challenge_source_offer_invalid', 'source-level offer is malformed');
  }
  if (!reached(env, 'offer')) env.checkpoint('offer', { offerSpecDigest: offer.spec_digest });

  if (!reached(env, 'started')) {
    // sourceOfferRequestId addresses the exact committed offer (v1.4.2 R2 P1-1) —
    // the server resolves the spec + its historical release from that offer row.
    // The four authored challengeSpec fields are echoed and MUST match the offered
    // spec exactly (server-verified); the runtime digests in the offer are not sent.
    await deps.startSourceRun({
      schema: 'run.start.challenge.v1',
      purpose: 'challenge_source',
      ticket_id: ticketId,
      run_id: runId,
      mechanic_id: input.mechanicId,
      variant_id: input.variantId,
      kind: 'single',
      sourceOfferRequestId: requestId,
      challengeSpec: {
        playableId: offer.challengeSpec.playableId,
        adapterVersion: offer.challengeSpec.adapterVersion,
        schemaVersion: offer.challengeSpec.schemaVersion,
        params: offer.challengeSpec.params,
      },
    });
    env.checkpoint('started');
  }

  let { specDigest, metricValue } = env.getData();
  if (!reached(env, 'played')) {
    const bundle = await loadAndVerifyBundle(deps, ticketId);
    if (bundle.specDigest !== offer.spec_digest) {
      throw new ChallengePlayError('challenge_source_digest_drift', 'source bundle digest differs from the issued offer');
    }
    specDigest = bundle.specDigest;
    ({ metricValue } = await deps.mountLevel({ bundle, kind: 'source' }));
    env.checkpoint('played', { specDigest, metricValue });
  }

  if (!reached(env, 'reported')) {
    await deps.postResult({
      mechanic_id: input.mechanicId,
      variant_id: input.variantId,
      run_id: runId,
      ticket_id: ticketId,
      metric_value: metricValue,
      applied_spec_digest: specDigest,
      tz_offset_minutes: deps.tzOffsetMinutes ? deps.tzOffsetMinutes() : 0,
    });
    env.checkpoint('reported');
  }

  if (!reached(env, 'created')) {
    const created = await deps.createChallenge({
      mechanic_id: input.mechanicId,
      variant_id: input.variantId,
      source_run_id: runId,
      request_id: requestId,
    });
    env.checkpoint('created', { created });
  }
  return { offer, runId, ticketId, metricValue: env.getData().metricValue, created: env.getData().created };
}
