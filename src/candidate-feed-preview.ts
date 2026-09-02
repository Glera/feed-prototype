import {
  candidateFeedStartParamRequested,
  decodeCandidateFeedStartParam,
} from './candidate-feed-start-param.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const STATIC_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_BINDING_BYTES = 32_768;
const MAX_ARTIFACT_MANIFEST_BYTES = 64_000;
const MAX_RUNTIME_ARTIFACT_BYTES = 32_768;

export const CANDIDATE_FEED_PARAMS = Object.freeze({
  releaseId: 'candidateFeedRelease',
  playableId: 'candidateFeedPlayable',
  artifactDigest: 'candidateFeedArtifact',
  bindingDigest: 'candidateFeedBinding',
});

export interface CandidateFeedPreviewIdentity {
  releaseId: string;
  playableId: string;
  candidatePath: string;
  candidateArtifactDigest: string;
  reviewBindingDigest: string;
}

export interface DeveloperFeedAdoptionIdentity extends CandidateFeedPreviewIdentity {
  schema: 'feed.playable-source-preview-adoption.v1';
  runtimeArtifactDigest: string;
  sourceCommit: string;
  receiptDigest: string;
  audience: 'exact-user';
  publicRollout: false;
}

interface CandidateReviewBinding {
  schema: 'feed.playable-release-review-binding.v1';
  releaseId: string;
  playableId: string;
  candidatePath: string;
  candidateArtifactDigest: string;
  review: {
    kind: 'rework' | 'source';
    reworkRequestId: string | null;
    sourceId: string | null;
    sourceCommit: string | null;
  };
}

interface CandidateArtifactManifest {
  schema: 'lab.playable-release-artifacts.v1';
  playableId: string;
  files: Array<{ bytes: number; path: string; sha256: string }>;
}

interface CandidateRuntimeArtifact {
  schema: 'runtime-artifact.v1';
  playableId: string;
  digest: string;
  digestCanonicalization: string;
  sourceCommit: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

function reviewBindingMatchesAdoption(
  review: CandidateReviewBinding['review'],
  sourceCommit: string,
): boolean {
  if (review.kind === 'source') {
    return review.reworkRequestId === null
      && review.sourceCommit === sourceCommit;
  }
  return typeof review.reworkRequestId === 'string'
    && UUID.test(review.reworkRequestId)
    && review.sourceId === null
    && review.sourceCommit === null;
}

async function fetchImmutableBytes(
  path: string,
  maximumBytes: number,
  origin: string,
  fetchResource: typeof fetch,
): Promise<Uint8Array> {
  const url = new URL(path, origin);
  if (url.origin !== origin || url.pathname !== path) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  const response = await fetchResource(url, { cache: 'no-store', credentials: 'same-origin' });
  const responseUrl = new URL(response.url);
  if (!response.ok || response.redirected || responseUrl.origin !== origin
    || responseUrl.pathname !== path) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > maximumBytes) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  return bytes;
}

function decodeJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
}

async function validateReworkRuntimeIdentity(
  binding: CandidateReviewBinding,
  identity: DeveloperFeedAdoptionIdentity,
  origin: string,
  fetchResource: typeof fetch,
): Promise<void> {
  // Rework bindings intentionally identify the originating request instead of
  // duplicating source provenance. Re-anchor that provenance through the
  // immutable artifact manifest and its hashed runtime-artifact sidecar.
  const root = `/playable-previews/${identity.releaseId.toLowerCase()}`;
  const manifest = decodeJson(await fetchImmutableBytes(
    `${root}/artifact-manifest.json`, MAX_ARTIFACT_MANIFEST_BYTES, origin, fetchResource,
  ));
  if (!exactKeys(manifest, ['schema', 'playableId', 'files'])) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  const artifactManifest = manifest as CandidateArtifactManifest;
  if (artifactManifest.schema !== 'lab.playable-release-artifacts.v1'
    || artifactManifest.playableId !== identity.playableId
    || !Array.isArray(artifactManifest.files)
    || artifactManifest.files.length < 2 || artifactManifest.files.length > 128) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  const entries = new Map<string, { bytes: number; sha256: string }>();
  for (const item of artifactManifest.files) {
    if (!exactKeys(item, ['bytes', 'path', 'sha256'])
      || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > 16_777_216
      || typeof item.path !== 'string' || !STATIC_FILE.test(item.path)
      || !DIGEST.test(item.sha256) || entries.has(item.path)) {
      throw new Error('developer_feed_adoption_runtime_mismatch');
    }
    entries.set(item.path, { bytes: item.bytes, sha256: item.sha256 });
  }
  const candidateName = `${identity.playableId}.html`;
  const runtimeName = `${identity.playableId}.runtime-artifact.json`;
  if (entries.get(candidateName)?.sha256 !== binding.candidateArtifactDigest) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  const runtimeEntry = entries.get(runtimeName);
  if (!runtimeEntry || runtimeEntry.bytes > MAX_RUNTIME_ARTIFACT_BYTES) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  const runtimeBytes = await fetchImmutableBytes(
    `${root}/${runtimeName}`, MAX_RUNTIME_ARTIFACT_BYTES, origin, fetchResource,
  );
  if (runtimeBytes.length !== runtimeEntry.bytes
    || await sha256Hex(runtimeBytes) !== runtimeEntry.sha256) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
  const runtime = decodeJson(runtimeBytes);
  if (!exactKeys(runtime, [
    'schema', 'playableId', 'digest', 'digestCanonicalization', 'sourceCommit', 'files',
  ])) throw new Error('developer_feed_adoption_runtime_mismatch');
  const artifact = runtime as CandidateRuntimeArtifact;
  if (artifact.schema !== 'runtime-artifact.v1'
    || artifact.playableId !== identity.playableId
    || artifact.digest !== identity.runtimeArtifactDigest
    || !PREFIXED_DIGEST.test(artifact.digest)
    || artifact.sourceCommit !== identity.sourceCommit
    || !/^[0-9a-f]{40}$/.test(artifact.sourceCommit)
    || typeof artifact.digestCanonicalization !== 'string'
    || artifact.digestCanonicalization.length < 1
    || !Array.isArray(artifact.files)) {
    throw new Error('developer_feed_adoption_runtime_mismatch');
  }
}

const exactKeys = (value: unknown, keys: string[]): boolean => Boolean(value)
  && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value as Record<string, unknown>).sort().join('\0') === [...keys].sort().join('\0');

function parseBinding(value: unknown): CandidateReviewBinding | null {
  if (!exactKeys(value, [
    'schema', 'releaseId', 'playableId', 'candidatePath', 'candidateArtifactDigest', 'review',
  ])) return null;
  const binding = value as CandidateReviewBinding;
  if (binding.schema !== 'feed.playable-release-review-binding.v1'
    || !exactKeys(binding.review, ['kind', 'reworkRequestId', 'sourceId', 'sourceCommit'])
    || !['rework', 'source'].includes(binding.review.kind)) return null;
  return binding;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** Any candidate-feed parameter selects the fail-closed read-only entry mode. */
export function candidateFeedPreviewRequested(search: string, startParam: string | null = null): boolean {
  const query = new URLSearchParams(search);
  return Object.values(CANDIDATE_FEED_PARAMS).some((name) => query.has(name))
    || candidateFeedStartParamRequested(startParam);
}

export function candidateFeedPreviewUrl(
  identity: Pick<CandidateFeedPreviewIdentity,
    'releaseId' | 'playableId' | 'candidateArtifactDigest' | 'reviewBindingDigest'>,
  href = location.href,
): URL {
  const url = new URL(href);
  url.searchParams.delete('candidateReview');
  url.searchParams.delete('tgWebAppStartParam');
  url.searchParams.delete('labAuth');
  url.searchParams.delete('c');
  url.searchParams.delete('base');
  url.hash = '';
  url.searchParams.set(CANDIDATE_FEED_PARAMS.releaseId, identity.releaseId.toLowerCase());
  url.searchParams.set(CANDIDATE_FEED_PARAMS.playableId, identity.playableId);
  url.searchParams.set(CANDIDATE_FEED_PARAMS.artifactDigest, identity.candidateArtifactDigest);
  url.searchParams.set(CANDIDATE_FEED_PARAMS.bindingDigest, identity.reviewBindingDigest);
  return url;
}

/**
 * Resolve one immutable same-origin candidate from its static review binding.
 * No caller-authored URL is accepted; invalid or partial identities throw.
 */
async function fetchCandidateBinding(
  releaseId: string,
  reviewBindingDigest: string,
  origin: string,
  fetchBinding: typeof fetch,
): Promise<CandidateReviewBinding> {
  const bindingPath = `/playable-previews/${releaseId}/review-binding.json`;
  const bindingUrl = new URL(bindingPath, origin);
  if (bindingUrl.origin !== origin || bindingUrl.pathname !== bindingPath) {
    throw new Error('candidate_feed_origin_invalid');
  }
  const response = await fetchBinding(bindingUrl, { cache: 'no-store', credentials: 'same-origin' });
  const responseUrl = new URL(response.url);
  if (!response.ok || response.redirected || responseUrl.origin !== origin
    || responseUrl.pathname !== bindingPath) throw new Error('candidate_feed_binding_unavailable');
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BINDING_BYTES) {
    throw new Error('candidate_feed_binding_too_large');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 2 || bytes.length > MAX_BINDING_BYTES
    || await sha256Hex(bytes) !== reviewBindingDigest) {
    throw new Error('candidate_feed_binding_digest_mismatch');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('candidate_feed_binding_invalid_json');
  }
  const binding = parseBinding(decoded);
  if (!binding || binding.releaseId.toLowerCase() !== releaseId
    || !UUID.test(binding.releaseId) || !PLAYABLE_ID.test(binding.playableId)
    || !DIGEST.test(binding.candidateArtifactDigest)
    || binding.candidatePath !== `/playable-previews/${releaseId}/${binding.playableId}.html`) {
    throw new Error('candidate_feed_binding_mismatch');
  }
  return binding;
}

/**
 * Resolve one immutable same-origin candidate from either the original query
 * identity or the compact Telegram start parameter. The compact token carries
 * the release id plus the full binding digest; the verified binding supplies
 * the playable and artifact identities it cryptographically commits.
 */
export async function resolveCandidateFeedPreview(
  search: string,
  origin = location.origin,
  fetchBinding: typeof fetch = fetch,
  startParam: string | null = null,
): Promise<CandidateFeedPreviewIdentity | null> {
  const query = new URLSearchParams(search);
  const queryRequested = Object.values(CANDIDATE_FEED_PARAMS).some((name) => query.has(name));
  if (!queryRequested && !candidateFeedStartParamRequested(startParam)) return null;
  if (query.has('base')) throw new Error('candidate_feed_base_override_forbidden');

  if (!queryRequested) {
    const compact = decodeCandidateFeedStartParam(startParam);
    if (!compact) throw new Error('candidate_feed_start_param_invalid');
    const binding = await fetchCandidateBinding(
      compact.releaseId,
      compact.reviewBindingDigest,
      origin,
      fetchBinding,
    );
    if (binding.review.kind !== 'source'
      || binding.review.reworkRequestId !== null
      || typeof binding.review.sourceId !== 'string'
      || !PLAYABLE_ID.test(binding.review.sourceId)
      || typeof binding.review.sourceCommit !== 'string'
      || !/^[0-9a-f]{40}$/.test(binding.review.sourceCommit)) {
      throw new Error('candidate_feed_start_source_binding_required');
    }
    return Object.freeze({
      releaseId: compact.releaseId,
      playableId: binding.playableId,
      candidatePath: binding.candidatePath,
      candidateArtifactDigest: binding.candidateArtifactDigest,
      reviewBindingDigest: compact.reviewBindingDigest,
    });
  }

  const readExact = (name: string): string => {
    const values = query.getAll(name);
    if (values.length !== 1 || values[0] !== values[0].trim()) {
      throw new Error('candidate_feed_identity_invalid');
    }
    return values[0];
  };
  const releaseId = readExact(CANDIDATE_FEED_PARAMS.releaseId).toLowerCase();
  const playableId = readExact(CANDIDATE_FEED_PARAMS.playableId);
  const candidateArtifactDigest = readExact(CANDIDATE_FEED_PARAMS.artifactDigest);
  const reviewBindingDigest = readExact(CANDIDATE_FEED_PARAMS.bindingDigest);
  if (!UUID.test(releaseId) || !PLAYABLE_ID.test(playableId)
    || !DIGEST.test(candidateArtifactDigest) || !DIGEST.test(reviewBindingDigest)) {
    throw new Error('candidate_feed_identity_invalid');
  }
  const binding = await fetchCandidateBinding(releaseId, reviewBindingDigest, origin, fetchBinding);
  const candidatePath = `/playable-previews/${releaseId}/${playableId}.html`;
  if (binding.playableId !== playableId || binding.candidatePath !== candidatePath
    || binding.candidateArtifactDigest !== candidateArtifactDigest) {
    throw new Error('candidate_feed_binding_mismatch');
  }
  return Object.freeze({
    releaseId,
    playableId,
    candidatePath,
    candidateArtifactDigest,
    reviewBindingDigest,
  });
}

/** Revalidate the actor-bound backend projection against the immutable static binding. */
export async function resolveDeveloperFeedAdoption(
  value: unknown,
  origin = location.origin,
  fetchBinding: typeof fetch = fetch,
): Promise<DeveloperFeedAdoptionIdentity> {
  if (!exactKeys(value, [
    'schema', 'releaseId', 'playableId', 'candidatePath', 'candidateArtifactDigest',
    'runtimeArtifactDigest', 'reviewBindingDigest', 'sourceCommit', 'receiptDigest',
    'audience', 'publicRollout',
  ])) throw new Error('developer_feed_adoption_invalid');
  const identity = value as DeveloperFeedAdoptionIdentity;
  if (identity.schema !== 'feed.playable-source-preview-adoption.v1'
    || !UUID.test(identity.releaseId) || !PLAYABLE_ID.test(identity.playableId)
    || !DIGEST.test(identity.candidateArtifactDigest)
    || !/^sha256:[0-9a-f]{64}$/.test(identity.runtimeArtifactDigest)
    || !DIGEST.test(identity.reviewBindingDigest)
    || !DIGEST.test(identity.receiptDigest)
    || !/^[0-9a-f]{40}$/.test(identity.sourceCommit)
    || identity.audience !== 'exact-user' || identity.publicRollout !== false
    || identity.candidatePath
      !== `/playable-previews/${identity.releaseId.toLowerCase()}/${identity.playableId}.html`) {
    throw new Error('developer_feed_adoption_invalid');
  }
  const binding = await fetchCandidateBinding(
    identity.releaseId.toLowerCase(),
    identity.reviewBindingDigest,
    origin,
    fetchBinding,
  );
  if (binding.playableId !== identity.playableId
    || binding.candidatePath !== identity.candidatePath
    || binding.candidateArtifactDigest !== identity.candidateArtifactDigest
    || !reviewBindingMatchesAdoption(binding.review, identity.sourceCommit)) {
    throw new Error('developer_feed_adoption_binding_mismatch');
  }
  if (binding.review.kind === 'rework') {
    await validateReworkRuntimeIdentity(binding, identity, origin, fetchBinding);
  }
  return Object.freeze({ ...identity, releaseId: identity.releaseId.toLowerCase() });
}
