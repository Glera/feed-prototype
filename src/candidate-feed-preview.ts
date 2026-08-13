const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_BINDING_BYTES = 32_768;

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
export function candidateFeedPreviewRequested(search: string): boolean {
  const query = new URLSearchParams(search);
  return Object.values(CANDIDATE_FEED_PARAMS).some((name) => query.has(name));
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
export async function resolveCandidateFeedPreview(
  search: string,
  origin = location.origin,
  fetchBinding: typeof fetch = fetch,
): Promise<CandidateFeedPreviewIdentity | null> {
  const query = new URLSearchParams(search);
  if (!candidateFeedPreviewRequested(search)) return null;
  if (query.has('base')) throw new Error('candidate_feed_base_override_forbidden');

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

  const candidatePath = `/playable-previews/${releaseId}/${playableId}.html`;
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
    || binding.playableId !== playableId || binding.candidatePath !== candidatePath
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
