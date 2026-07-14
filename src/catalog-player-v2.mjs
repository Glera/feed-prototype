const HASH_RE = /^[0-9a-f]{64}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PLAYABLE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const FAILURE_REASONS = new Set(['timeout', 'digest', 'origin', 'runtime', 'contract', 'mount']);
const MAX_LEVELS = 6;

export const CATALOG_FRAME_REFERRER_POLICY = 'origin';

/**
 * This helper deliberately requires both flags. It owns no browser state and
 * cannot enable catalog delivery on its own; feed integration remains a
 * separate, explicitly gated slice.
 */
export function catalogPlayerV2Enabled(env, controlPlaneEnabled, accountEligible) {
  return controlPlaneEnabled === true
    && accountEligible === true
    && String(env?.VITE_CATALOG_PLAYER_V2_ENABLED ?? '').toLowerCase() === 'true';
}

export class CatalogPlayerV2ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogPlayerV2ContractError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CatalogPlayerV2ContractError(code, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function denseArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('invalid_uuid', `${label} must be a canonical UUID`);
  return value;
}

function hash(value, label) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) fail('invalid_hash', `${label} must be a lowercase SHA-256 hash`);
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail('invalid_digest', `${label} must be a sha256: digest`);
  return value;
}

function positiveOrdinal(value, label = 'ordinal') {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEVELS) {
    fail('invalid_ordinal', `${label} must be an integer from 1 to ${MAX_LEVELS}`);
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function frozenClone(value) {
  return deepFreeze(clone(value));
}

function validateSortLevelSpec(value) {
  if (!exactKeys(value, ['schema', 'specHash', 'runtimeContractDigest', 'seed', 'params'])) {
    fail('invalid_spec', 'LevelSpec envelope must exactly match sort.level-spec.v1');
  }
  if (value.schema !== 'sort.level-spec.v1') fail('invalid_spec', 'LevelSpec schema is unsupported');
  hash(value.specHash, 'LevelSpec.specHash');
  hash(value.runtimeContractDigest, 'LevelSpec.runtimeContractDigest');
  if (!Number.isInteger(value.seed) || value.seed < 0 || value.seed > 0xffffffff) {
    fail('invalid_spec', 'LevelSpec.seed must be uint32');
  }
  const params = value.params;
  if (!exactKeys(params, [
    'gridCols', 'gridRows', 'colorsUsed', 'cellColorMap', 'targetStacks', 'convSpeedMul', 'modifiers',
  ])) {
    fail('invalid_spec', 'LevelSpec.params has an unsupported shape');
  }
  if (!Number.isInteger(params.gridCols) || params.gridCols < 6 || params.gridCols > 8) {
    fail('invalid_spec', 'gridCols is out of range');
  }
  if (!Number.isInteger(params.gridRows) || params.gridRows < 5 || params.gridRows > 7) {
    fail('invalid_spec', 'gridRows is out of range');
  }
  if (!Number.isInteger(params.colorsUsed) || params.colorsUsed < 3 || params.colorsUsed > 6) {
    fail('invalid_spec', 'colorsUsed is out of range');
  }
  if (!denseArray(params.cellColorMap)
    || params.cellColorMap.length !== params.gridCols * params.gridRows
    || !params.cellColorMap.every((color) => Number.isInteger(color) && color >= 0 && color < params.colorsUsed)) {
    fail('invalid_spec', 'cellColorMap is incompatible with the grid');
  }
  if (!denseArray(params.targetStacks) || params.targetStacks.length !== 4
    || !params.targetStacks.every((stack) => denseArray(stack)
      && stack.length >= 1 && stack.length <= 6
      && stack.every((color) => Number.isInteger(color) && color >= 0 && color < params.colorsUsed))) {
    fail('invalid_spec', 'targetStacks is invalid');
  }
  const lengths = params.targetStacks.map((stack) => stack.length);
  if (Math.max(...lengths) - Math.min(...lengths) > 1) fail('invalid_spec', 'targetStacks is unbalanced');
  if (![0.8, 1, 1.25].includes(params.convSpeedMul)) fail('invalid_spec', 'convSpeedMul is unsupported');
  if (!denseArray(params.modifiers) || params.modifiers.length !== 0) fail('invalid_spec', 'modifiers must be empty');

  const available = Array(params.colorsUsed).fill(0);
  for (const color of params.cellColorMap) available[color] += 9;
  const demand = Array(params.colorsUsed).fill(0);
  for (const stack of params.targetStacks) for (const color of stack) demand[color] += 3;
  if (demand.some((needed, color) => needed > available[color])) {
    fail('invalid_spec', 'targetStacks exceeds available resources');
  }
  return value;
}

function validateSortSkinSpec(value) {
  if (!exactKeys(value, ['schema', 'skinHash', 'skinContractDigest', 'params'])
    || value.schema !== 'sort.skin-spec.v1') {
    fail('invalid_skin', 'SkinSpec envelope must exactly match sort.skin-spec.v1');
  }
  hash(value.skinHash, 'SkinSpec.skinHash');
  hash(value.skinContractDigest, 'SkinSpec.skinContractDigest');
  const params = value.params;
  if (!exactKeys(params, [
    'marbleStyle', 'markerStyle', 'targetShape', 'sourceShape',
    'backgroundPattern', 'sceneColors', 'roleDisplayColors',
  ]) || !exactKeys(params.sceneColors, [
    'ground', 'edge', 'sceneBg', 'boardBg', 'belt', 'outline',
  ])) {
    fail('invalid_skin', 'SkinSpec.params has an unsupported shape');
  }
  const colors = [...Object.values(params.sceneColors), ...(params.roleDisplayColors || [])];
  if (!denseArray(params.roleDisplayColors) || params.roleDisplayColors.length !== 6
    || !colors.every((color) => typeof color === 'string' && /^#[0-9A-F]{6}$/.test(color))) {
    fail('invalid_skin', 'SkinSpec colors are invalid');
  }
  return value;
}

function validateRuntime(value) {
  if (!exactKeys(value, [
    'releaseId', 'playableId', 'legacyVariantId', 'runtimeContractDigest',
    'runtimeArtifactDigest', 'indexLocator', 'sidecarLocator', 'capabilities',
  ])) {
    fail('invalid_runtime', 'runtime identity has an unsupported shape');
  }
  uuid(value.releaseId, 'runtime.releaseId');
  uuid(value.legacyVariantId, 'runtime.legacyVariantId');
  if (typeof value.playableId !== 'string' || !PLAYABLE_RE.test(value.playableId)) {
    fail('invalid_runtime', 'runtime.playableId is invalid');
  }
  hash(value.runtimeContractDigest, 'runtime.runtimeContractDigest');
  digest(value.runtimeArtifactDigest, 'runtime.runtimeArtifactDigest');
  if (typeof value.indexLocator !== 'string' || value.indexLocator.length > 1024) {
    fail('invalid_runtime', 'runtime.indexLocator is invalid');
  }
  if (typeof value.sidecarLocator !== 'string' || value.sidecarLocator.length > 1024) {
    fail('invalid_runtime', 'runtime.sidecarLocator is invalid');
  }
  if (!isPlainObject(value.capabilities) || Object.keys(value.capabilities).length === 0
    || !Object.entries(value.capabilities).every(([key, enabled]) => key.length > 0 && key.length <= 128 && typeof enabled === 'boolean')) {
    fail('invalid_runtime', 'runtime.capabilities must be a non-empty boolean map');
  }
  return value;
}

/** Strictly validate and freeze the server-owned ticket delivery bundle. */
export function validateCatalogTicketLevelSpecBundle(value) {
  const skinBearing = value?.schema === 'catalog.ticket-level-spec-bundle.v2';
  const keys = [
    'schema', 'ticketId', 'ticketState', 'decisionId', 'catalogEntryId',
    'seriesId', 'manifestContentHash', 'runtime', 'levels',
    ...(skinBearing ? ['skinHash', 'skinContractDigest', 'skin'] : []),
  ];
  if (!exactKeys(value, keys)) {
    fail('invalid_bundle', 'ticket LevelSpec bundle has an unsupported shape');
  }
  if (!['catalog.ticket-level-spec-bundle.v1', 'catalog.ticket-level-spec-bundle.v2'].includes(value.schema)
    || value.ticketState !== 'active') {
    fail('invalid_bundle', 'ticket LevelSpec bundle is not active and versioned');
  }
  uuid(value.ticketId, 'bundle.ticketId');
  uuid(value.decisionId, 'bundle.decisionId');
  uuid(value.catalogEntryId, 'bundle.catalogEntryId');
  uuid(value.seriesId, 'bundle.seriesId');
  hash(value.manifestContentHash, 'bundle.manifestContentHash');
  validateRuntime(value.runtime);
  if (skinBearing) {
    hash(value.skinHash, 'bundle.skinHash');
    hash(value.skinContractDigest, 'bundle.skinContractDigest');
    validateSortSkinSpec(value.skin);
    if (value.skinHash !== value.skin.skinHash
      || value.skinContractDigest !== value.skin.skinContractDigest
      || value.runtime.capabilities.sortSkinSpecV1 !== true) {
      fail('invalid_bundle', 'bundle SkinSpec differs from its runtime-bound identity');
    }
  }
  if (!denseArray(value.levels) || value.levels.length < 1 || value.levels.length > MAX_LEVELS) {
    fail('invalid_bundle', 'bundle.levels must contain 1..6 levels');
  }
  value.levels.forEach((level, index) => {
    if (!exactKeys(level, ['ordinal', 'specHash', 'spec'])) fail('invalid_bundle', 'bundle level has extra or missing fields');
    if (level.ordinal !== index + 1) fail('invalid_bundle', 'bundle levels must be contiguous and 1-based');
    hash(level.specHash, `bundle.levels[${index}].specHash`);
    validateSortLevelSpec(level.spec);
    if (level.specHash !== level.spec.specHash) fail('invalid_bundle', 'bundle level hash differs from embedded LevelSpec');
    if (level.spec.runtimeContractDigest !== value.runtime.runtimeContractDigest) {
      fail('invalid_bundle', 'LevelSpec runtime contract differs from the ticket runtime');
    }
  });
  return frozenClone(value);
}

/** Normalize one immutable ordinal into the transport state-machine input. */
export function buildCatalogPlayerLevelBinding(bundleInput, ordinal, frameEpoch) {
  const bundle = validateCatalogTicketLevelSpecBundle(bundleInput);
  positiveOrdinal(ordinal);
  if (!Number.isSafeInteger(frameEpoch) || frameEpoch < 1) fail('invalid_epoch', 'frameEpoch must be a positive safe integer');
  const level = bundle.levels[ordinal - 1];
  if (!level) fail('invalid_ordinal', 'ordinal is outside the immutable ticket manifest');
  return deepFreeze({
    frameEpoch,
    decisionId: bundle.decisionId,
    ticketId: bundle.ticketId,
    catalogEntryId: bundle.catalogEntryId,
    seriesId: bundle.seriesId,
    ordinal,
    runtimeReleaseId: bundle.runtime.releaseId,
    playableId: bundle.runtime.playableId,
    legacyVariantId: bundle.runtime.legacyVariantId,
    runtimeContractDigest: bundle.runtime.runtimeContractDigest,
    runtimeArtifactDigest: bundle.runtime.runtimeArtifactDigest,
    indexLocator: bundle.runtime.indexLocator,
    specHash: level.specHash,
    spec: level.spec,
    skinHash: bundle.schema === 'catalog.ticket-level-spec-bundle.v2' ? bundle.skinHash : null,
    skinContractDigest: bundle.schema === 'catalog.ticket-level-spec-bundle.v2'
      ? bundle.skinContractDigest : null,
    skin: bundle.schema === 'catalog.ticket-level-spec-bundle.v2' ? bundle.skin : null,
  });
}

/**
 * Resolve only the content-addressed runtime selected by the server. Relative
 * locators are deployment-root-relative by contract; mutable aliases and
 * pre-existing query/fragment data are rejected.
 */
export function buildCatalogFrameNavigation(binding, baseUrl) {
  const expectedRoot = `runtime-releases/${binding.playableId}/${binding.runtimeArtifactDigest.slice(7)}/`;
  const locator = binding.indexLocator;
  const validContentAddressedPath = (value) => {
    if (!value.startsWith(expectedRoot) || value.length <= expectedRoot.length
      || !/^[A-Za-z0-9._/-]+$/.test(value) || value.includes('//')) return false;
    const suffix = value.slice(expectedRoot.length);
    return !suffix.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0);
  };
  let target;
  if (validContentAddressedPath(locator)) {
    let base;
    try { base = new URL(baseUrl); } catch { fail('invalid_locator', 'baseUrl is invalid'); }
    target = new URL(`/${locator}`, base.origin);
  } else {
    let absolute;
    try { absolute = new URL(locator); } catch { absolute = null; }
    if (!absolute || absolute.protocol !== 'https:' || absolute.username || absolute.password
      || !validContentAddressedPath(absolute.pathname.slice(1))
      || absolute.search || absolute.hash) {
      fail('invalid_locator', 'indexLocator is not the exact content-addressed runtime path');
    }
    target = absolute;
  }
  if (!['https:', 'http:'].includes(target.protocol)
    || (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))) {
    fail('invalid_locator', 'catalog runtime must use HTTPS outside local development');
  }
  target.searchParams.set('level_config', 'catalog_required');
  target.searchParams.set('expected_spec_hash', binding.specHash);
  if (binding.skinHash) target.searchParams.set('expected_skin_hash', binding.skinHash);
  return deepFreeze({
    src: target.href,
    expectedOrigin: target.origin,
    referrerPolicy: CATALOG_FRAME_REFERRER_POLICY,
    frameEpoch: binding.frameEpoch,
  });
}

export function buildCatalogConfigurationFailure(binding, reason) {
  if (!FAILURE_REASONS.has(reason)) fail('invalid_failure', 'configuration failure reason is unsupported');
  const result = {
    decision_id: binding.decisionId,
    ticket_id: binding.ticketId,
    series_id: binding.seriesId,
    ordinal: binding.ordinal,
    expected_spec_hash: binding.specHash,
    runtime_release_id: binding.runtimeReleaseId,
    reason,
  };
  if (binding.skinHash) {
    result.expected_skin_hash = binding.skinHash;
    result.skin_contract_digest = binding.skinContractDigest;
  }
  return deepFreeze(result);
}

export function buildCatalogLevelImpression(binding, impressionId, levelImpressionId) {
  const result = {
    decision_id: binding.decisionId,
    impression_id: uuid(impressionId, 'impression_id'),
    level_impression_id: uuid(levelImpressionId, 'level_impression_id'),
    ticket_id: binding.ticketId,
    catalog_entry_id: binding.catalogEntryId,
    series_id: binding.seriesId,
    ordinal: binding.ordinal,
    level_spec_hash: binding.specHash,
    applied_spec_hash: binding.specHash,
    runtime_release_id: binding.runtimeReleaseId,
    runtime_contract_digest: binding.runtimeContractDigest,
    runtime_artifact_digest: binding.runtimeArtifactDigest,
  };
  if (binding.skinHash) {
    result.skin_hash = binding.skinHash;
    result.applied_skin_hash = binding.skinHash;
    result.skin_contract_digest = binding.skinContractDigest;
  }
  return deepFreeze(result);
}

function ignored(phase, reason) {
  return deepFreeze({ status: 'ignored', phase, reason, effects: [] });
}

/**
 * Pure host-side half of the catalog-required handshake. The caller owns DOM,
 * timers, IDs and telemetry delivery; this object only validates identities
 * and emits explicit effects.
 */
export class CatalogPlayerV2Session {
  constructor(options) {
    if (!options || !isPlainObject(options)) fail('invalid_session', 'session options are required');
    if (!options.frameSource || !['object', 'function'].includes(typeof options.frameSource)) {
      fail('invalid_session', 'frameSource identity is required');
    }
    const binding = buildCatalogPlayerLevelBinding(options.bundle, options.ordinal, options.frameEpoch);
    const navigation = buildCatalogFrameNavigation(binding, options.baseUrl);
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
    return deepFreeze({
      frameEpoch: this.binding.frameEpoch,
      phase: this._phase,
      visible: this._visible,
      revealClaimed: this._revealClaimed,
      failureReason: this._failureReason,
      ordinal: this.binding.ordinal,
      expectedSpecHash: this.binding.specHash,
      expectedSkinHash: this.binding.skinHash,
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
      return deepFreeze({
        status: 'accepted',
        phase: this._phase,
        reason: null,
        effects: [{
          type: 'post_configure_level',
          frameEpoch: this.binding.frameEpoch,
          targetOrigin: this.navigation.expectedOrigin,
          message: deepFreeze({
            type: 'configure_level',
            nonce: this._nonce,
            spec: this.binding.spec,
            ...(this.binding.skin ? { skin: this.binding.skin } : {}),
          }),
        }],
      });
    }

    const configuredKeys = this.binding.skinHash
      ? ['type', 'appliedSpecHash', 'appliedSkinHash', 'runtimeContractDigest', 'skinContractDigest', 'runtimeArtifactDigest']
      : ['type', 'appliedSpecHash', 'runtimeContractDigest', 'runtimeArtifactDigest'];
    if (!exactKeys(event.data, configuredKeys)) {
      return this._fail('contract');
    }
    if (event.data.appliedSpecHash !== this.binding.specHash) return this._fail('digest');
    if (this.binding.skinHash && event.data.appliedSkinHash !== this.binding.skinHash) return this._fail('digest');
    if (this.binding.skinContractDigest
      && event.data.skinContractDigest !== this.binding.skinContractDigest) return this._fail('contract');
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
      effects.push(deepFreeze({
        type: 'catalog_reveal_ready',
        frameEpoch: this.binding.frameEpoch,
        ordinal: this.binding.ordinal,
        appliedSpecHash: this.binding.specHash,
        appliedSkinHash: this.binding.skinHash,
      }));
    }
    return deepFreeze({ status: 'accepted', phase: this._phase, reason: null, effects });
  }

  _fail(reason) {
    this._phase = 'failed';
    this._failureReason = reason;
    this._visible = false;
    this._nonce = null;
    return deepFreeze({
      status: 'failed',
      phase: this._phase,
      reason,
      effects: [{
        type: 'catalog_configuration_failure',
        frameEpoch: this.binding.frameEpoch,
        payload: buildCatalogConfigurationFailure(this.binding, reason),
      }],
    });
  }
}
