/**
 * Share / Challenge v1 client gate (VITE_CHALLENGE_V1_ENABLED).
 *
 * OFF (unset/anything but "true") → the client behaves byte-for-byte as today:
 * no spec in run.start, no content-addressed level delivery, no
 * applied_spec_digest, no wire header, no share_tap emission from the v1 path.
 * Legacy challenges keep playing through the existing legacy functions in BOTH
 * modes (the backend routes legacy vs spec-bound by the challenge row, never by
 * this flag — D10/P1-4).
 *
 * ON → the v1 spec-bound flow (wire header, run.start.challenge.v1 source spec,
 * challenge-scoped level bundle + sibling player, applied_spec_digest, share_tap)
 * is admitted. This flag only ENABLES new client behavior; it never changes how
 * an already spec-bound challenge is played.
 */
export function challengeV1Enabled(env?: { VITE_CHALLENGE_V1_ENABLED?: unknown }): boolean {
  const source = env ?? ((import.meta as unknown as { env?: Record<string, unknown> }).env ?? {});
  return source.VITE_CHALLENGE_V1_ENABLED === 'true' || source.VITE_CHALLENGE_V1_ENABLED === true;
}
