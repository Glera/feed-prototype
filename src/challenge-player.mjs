/**
 * Share / Challenge v1 sibling level-player (spec v1.4.1 §Reconciliation, D4).
 *
 * The catalog player-v2 bundle refuses a challenge ticket by construction
 * (backend `catalog_run_ticket_service` rejects it; the catalog validator
 * requires non-null decision/entry/series identity). A Sort challenge reuses the
 * SAME `configure_level` / `catalog_required` runtime handshake, but over a thin
 * challenge-scoped bundle WITHOUT any allocation identity, produced by the
 * backend from `challenge_specs` + its composite-FK release
 * (`GET /api/challenges/tickets/{ticket_id}/level-bundle`).
 *
 * This module is the client sibling to `buildCatalogPlayerLevelBinding` /
 * `CatalogPlayerV2Session`: it validates that bundle, builds a challenge binding,
 * and reuses the UNMODIFIED, identity-agnostic `buildCatalogFrameNavigation` for
 * the content-addressed runtime URL. The catalog path is not touched. Authored as
 * .mjs (like catalog-player-v2.mjs) so the pure core is node-checkable.
 *
 * Two distinct hashes travel together and must never be confused:
 *   - `specDigest`       — the challenge WRAPPER digest (level AND runtime),
 *                          echoed as `applied_spec_digest` to /results & /complete.
 *   - `expectedSpecHash` — the per-level `sort.level-spec.v1` specHash, the
 *                          content address the runtime handshake checks the mounted
 *                          level against (== level.specHash).
 */
import { buildCatalogFrameNavigation } from './catalog-player-v2.mjs';
import { levelSpecHash } from './challenge-identity.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
export const CHALLENGE_LEVEL_BUNDLE_SCHEMA = 'challenge.ticket-level-spec-bundle.v1';
const FAILURE_REASONS = new Set(['timeout', 'digest', 'origin', 'runtime', 'contract', 'mount']);

export class ChallengePlayerContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChallengePlayerContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ChallengePlayerContractError(code, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length
    && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
}

/**
 * Strictly validate a `challenge.ticket-level-spec-bundle.v1` (mirrors the
 * backend `ChallengeLevelSpecBundleV1` model_validator), including the two
 * cross-field identity invariants.
 */
export function validateChallengeLevelBundle(input) {
  if (!isPlainObject(input)) fail('invalid_bundle', 'bundle must be an object');
  if (!exactKeys(input, [
    'schema', 'ticketId', 'ticketState', 'challengeId', 'specDigest', 'expectedSpecHash', 'runtime', 'level',
  ])) {
    fail('invalid_bundle', 'bundle has extra or missing top-level fields');
  }
  if (input.schema !== CHALLENGE_LEVEL_BUNDLE_SCHEMA) fail('invalid_bundle', 'unsupported bundle schema');
  if (typeof input.ticketId !== 'string' || !UUID.test(input.ticketId)) fail('invalid_bundle', 'ticketId must be a UUID');
  if (typeof input.ticketState !== 'string' || input.ticketState.length === 0) fail('invalid_bundle', 'ticketState is required');
  if (input.challengeId !== null && (typeof input.challengeId !== 'string' || !UUID.test(input.challengeId))) {
    fail('invalid_bundle', 'challengeId must be a UUID or null');
  }
  if (typeof input.specDigest !== 'string' || !HEX64.test(input.specDigest)) fail('invalid_bundle', 'specDigest must be 64 hex');
  if (typeof input.expectedSpecHash !== 'string' || !HEX64.test(input.expectedSpecHash)) fail('invalid_bundle', 'expectedSpecHash must be 64 hex');

  const runtime = input.runtime;
  if (!isPlainObject(runtime)) fail('invalid_bundle', 'runtime must be an object');
  if (!exactKeys(runtime, [
    'playableId', 'releaseId', 'runtimeContractDigest', 'runtimeArtifactDigest', 'indexLocator', 'sidecarLocator', 'capabilities',
  ])) {
    fail('invalid_bundle', 'runtime has extra or missing fields');
  }
  if (typeof runtime.playableId !== 'string' || runtime.playableId.length === 0) fail('invalid_bundle', 'runtime.playableId is required');
  if (typeof runtime.releaseId !== 'string' || !UUID.test(runtime.releaseId)) fail('invalid_bundle', 'runtime.releaseId must be a UUID');
  if (typeof runtime.runtimeContractDigest !== 'string' || !HEX64.test(runtime.runtimeContractDigest)) fail('invalid_bundle', 'runtime.runtimeContractDigest must be 64 hex');
  if (typeof runtime.runtimeArtifactDigest !== 'string' || !ARTIFACT_DIGEST.test(runtime.runtimeArtifactDigest)) fail('invalid_bundle', 'runtime.runtimeArtifactDigest must be a sha256: digest');
  if (typeof runtime.indexLocator !== 'string' || runtime.indexLocator.length === 0) fail('invalid_bundle', 'runtime.indexLocator is required');
  if (typeof runtime.sidecarLocator !== 'string' || runtime.sidecarLocator.length === 0) fail('invalid_bundle', 'runtime.sidecarLocator is required');
  if (!isPlainObject(runtime.capabilities)) fail('invalid_bundle', 'runtime.capabilities must be an object');
  for (const cap of Object.values(runtime.capabilities)) {
    if (typeof cap !== 'boolean') fail('invalid_bundle', 'runtime.capabilities values must be booleans');
  }

  const level = input.level;
  if (!isPlainObject(level)) fail('invalid_bundle', 'level must be an object');
  if (!exactKeys(level, ['schema', 'specHash', 'runtimeContractDigest', 'seed', 'params'])) {
    fail('invalid_bundle', 'level has extra or missing fields');
  }
  if (typeof level.schema !== 'string' || level.schema.length === 0) fail('invalid_bundle', 'level.schema is required');
  if (typeof level.specHash !== 'string' || !HEX64.test(level.specHash)) fail('invalid_bundle', 'level.specHash must be 64 hex');
  if (typeof level.runtimeContractDigest !== 'string' || !HEX64.test(level.runtimeContractDigest)) fail('invalid_bundle', 'level.runtimeContractDigest must be 64 hex');
  if (typeof level.seed !== 'number' || !Number.isInteger(level.seed)) fail('invalid_bundle', 'level.seed must be an integer');
  if (!isPlainObject(level.params)) fail('invalid_bundle', 'level.params must be an object');

  // Cross-field identity (matches the backend model_validator).
  if (input.expectedSpecHash !== level.specHash) fail('invalid_bundle', 'expectedSpecHash must equal level.specHash');
  if (level.runtimeContractDigest !== runtime.runtimeContractDigest) fail('invalid_bundle', 'level runtimeContractDigest must equal runtime.runtimeContractDigest');
  if (input.expectedSpecHash === input.specDigest) fail('invalid_bundle', 'expectedSpecHash (per-level) must differ from specDigest (wrapper)');

  return input;
}

/**
 * Build the challenge level binding from a validated bundle. Sibling to
 * `buildCatalogPlayerLevelBinding` — a challenge bundle carries exactly one
 * level, so there is no ordinal.
 */
export function buildChallengePlayerLevelBinding(bundleInput, frameEpoch) {
  const bundle = validateChallengeLevelBundle(bundleInput);
  if (!Number.isSafeInteger(frameEpoch) || frameEpoch < 1) fail('invalid_epoch', 'frameEpoch must be a positive safe integer');
  return Object.freeze({
    frameEpoch,
    ticketId: bundle.ticketId,
    challengeId: bundle.challengeId,
    ticketState: bundle.ticketState,
    playableId: bundle.runtime.playableId,
    releaseId: bundle.runtime.releaseId,
    runtimeContractDigest: bundle.runtime.runtimeContractDigest,
    runtimeArtifactDigest: bundle.runtime.runtimeArtifactDigest,
    indexLocator: bundle.runtime.indexLocator,
    specHash: bundle.expectedSpecHash,
    specDigest: bundle.specDigest,
    spec: bundle.level,
    // Challenges are skinless in v1; kept so buildCatalogFrameNavigation, which
    // reads only the identity-agnostic subset, sees a falsy skinHash.
    skinHash: null,
  });
}

/**
 * Resolve the content-addressed runtime frame URL. Reuses the UNMODIFIED,
 * identity-agnostic `buildCatalogFrameNavigation` (it reads only playableId,
 * runtimeArtifactDigest, indexLocator, specHash, skinHash, frameEpoch — none of
 * the catalog allocation fields). No catalog identity is ever fabricated.
 */
export function buildChallengeFrameNavigation(binding, baseUrl) {
  return buildCatalogFrameNavigation(binding, baseUrl);
}

/**
 * Recompute the per-level content address on the client and prove it equals the
 * hash the server put in the bundle (D8 identity closure). Independent of the
 * runtime handshake — a mismatch means the server bundle is inconsistent and the
 * level must not be mounted.
 */
export async function verifyChallengeBundleIdentity(bundle) {
  const recomputed = await levelSpecHash({
    schema: bundle.level.schema,
    runtimeContractDigest: bundle.level.runtimeContractDigest,
    seed: bundle.level.seed,
    params: bundle.level.params,
  });
  return recomputed === bundle.expectedSpecHash;
}

function ignored(phase, reason) {
  return Object.freeze({ status: 'ignored', phase, reason, effects: [] });
}

/**
 * Pure host-side half of the SAME runtime handshake the catalog path speaks
 * (configure_ready → configure_level → configured → reveal). The caller owns DOM,
 * timers, IDs and telemetry; this object only validates identities and emits
 * explicit effects. Skinless (challenges have no skin in v1).
 */
export class ChallengePlayerSession {
  constructor(options) {
    if (!isPlainObject(options)) fail('invalid_session', 'session options are required');
    if (!options.frameSource || !['object', 'function'].includes(typeof options.frameSource)) {
      fail('invalid_session', 'frameSource identity is required');
    }
    const binding = buildChallengePlayerLevelBinding(options.bundle, options.frameEpoch);
    const navigation = buildChallengeFrameNavigation(binding, options.baseUrl);
    Object.defineProperties(this, {
      binding: { value: binding, enumerable: true },
      navigation: { value: navigation, enumerable: true },
      _frameSource: { value: options.frameSource },
    });
    this._phase = 'awaiting_ready';
    this._nonce = null;
    this._visible = false;
    this._revealClaimed = false;
    this._failureReason = null;
  }

  snapshot() {
    return Object.freeze({
      frameEpoch: this.binding.frameEpoch,
      phase: this._phase,
      visible: this._visible,
      revealClaimed: this._revealClaimed,
      failureReason: this._failureReason,
      expectedSpecHash: this.binding.specHash,
    });
  }

  handleMessage(event, frameEpoch) {
    if (frameEpoch !== this.binding.frameEpoch) return ignored(this._phase, 'stale_epoch');
    if (!event || event.source !== this._frameSource) return ignored(this._phase, 'source');
    if (event.origin !== this.navigation.expectedOrigin) return ignored(this._phase, 'origin');
    if (!isPlainObject(event.data)) return ignored(this._phase, 'shape');
    const type = event.data.type;
    if (!['configure_ready', 'configured', 'configure_failed'].includes(type)) {
      return ignored(this._phase, 'unrelated');
    }
    if (this._phase === 'disposed' || this._phase === 'failed') return ignored(this._phase, 'terminal');

    if (type === 'configure_failed') {
      if (!exactKeys(event.data, ['type', 'reason']) || !FAILURE_REASONS.has(event.data.reason)) {
        return this._fail('contract');
      }
      if (this._phase === 'configured') return ignored(this._phase, 'late_failure');
      return this._fail(event.data.reason);
    }

    if (type === 'configure_ready') {
      if (!exactKeys(event.data, ['type', 'nonce', 'runtimeContractDigest', 'runtimeArtifactDigest'])
        || typeof event.data.nonce !== 'string' || !NONCE_RE.test(event.data.nonce)) {
        return this._fail('contract');
      }
      if (event.data.runtimeContractDigest !== this.binding.runtimeContractDigest) return this._fail('contract');
      if (event.data.runtimeArtifactDigest !== this.binding.runtimeArtifactDigest) return this._fail('runtime');
      if (this._phase !== 'awaiting_ready') return ignored(this._phase, 'duplicate_ready');
      this._nonce = event.data.nonce;
      this._phase = 'awaiting_configured';
      return Object.freeze({
        status: 'accepted',
        phase: this._phase,
        reason: null,
        effects: [Object.freeze({
          type: 'post_configure_level',
          frameEpoch: this.binding.frameEpoch,
          targetOrigin: this.navigation.expectedOrigin,
          message: Object.freeze({ type: 'configure_level', nonce: this._nonce, spec: this.binding.spec }),
        })],
      });
    }

    // type === 'configured'
    if (!exactKeys(event.data, ['type', 'appliedSpecHash', 'runtimeContractDigest', 'runtimeArtifactDigest'])) {
      return this._fail('contract');
    }
    if (event.data.appliedSpecHash !== this.binding.specHash) return this._fail('digest');
    if (event.data.runtimeContractDigest !== this.binding.runtimeContractDigest) return this._fail('contract');
    if (event.data.runtimeArtifactDigest !== this.binding.runtimeArtifactDigest) return this._fail('runtime');
    if (this._phase === 'configured') return ignored(this._phase, 'duplicate_configured');
    if (this._phase !== 'awaiting_configured' || this._nonce === null) return this._fail('contract');
    this._phase = 'configured';
    return this._acceptedWithReveal();
  }

  setVisible(visible, frameEpoch) {
    if (frameEpoch !== this.binding.frameEpoch) return ignored(this._phase, 'stale_epoch');
    if (this._phase === 'disposed' || this._phase === 'failed') return ignored(this._phase, 'terminal');
    this._visible = visible === true;
    return this._acceptedWithReveal();
  }

  fail(reason, frameEpoch) {
    if (frameEpoch !== this.binding.frameEpoch) return ignored(this._phase, 'stale_epoch');
    if (!FAILURE_REASONS.has(reason)) fail('invalid_failure', 'configuration failure reason is unsupported');
    if (this._phase === 'disposed' || this._phase === 'failed' || this._phase === 'configured') {
      return ignored(this._phase, 'terminal');
    }
    return this._fail(reason);
  }

  dispose(frameEpoch) {
    if (frameEpoch !== this.binding.frameEpoch) return false;
    this._phase = 'disposed';
    this._visible = false;
    this._nonce = null;
    return true;
  }

  _acceptedWithReveal() {
    const effects = [];
    if (this._phase === 'configured' && this._visible && !this._revealClaimed) {
      this._revealClaimed = true;
      effects.push(Object.freeze({
        type: 'challenge_reveal_ready',
        frameEpoch: this.binding.frameEpoch,
        appliedSpecHash: this.binding.specHash,
      }));
    }
    return Object.freeze({ status: 'accepted', phase: this._phase, reason: null, effects });
  }

  _fail(reason) {
    this._phase = 'failed';
    this._failureReason = reason;
    this._visible = false;
    this._nonce = null;
    return Object.freeze({
      status: 'failed',
      phase: this._phase,
      reason,
      effects: [Object.freeze({
        type: 'challenge_configuration_failure',
        frameEpoch: this.binding.frameEpoch,
        payload: Object.freeze({
          ticket_id: this.binding.ticketId,
          challenge_id: this.binding.challengeId,
          expected_spec_hash: this.binding.specHash,
          runtime_release_id: this.binding.releaseId,
          reason,
        }),
      })],
    });
  }
}
