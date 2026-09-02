import type {
  DeveloperFeedCatalogDiffV1,
  CatalogDirectPromotionPreparedV1,
  CatalogDirectPromotionResultV1,
  PlayablePublicationPreparedV1,
  PlayablePublicationRequestedV1,
  OperatorPlayableReworkQueueItemV1,
} from './api';

/**
 * Inventory of "what is different in my dev feed right now".  A publication
 * control exists only for an exact server-prepared candidate closure.
 */

export type DeveloperFeedDiffTone =
  | 'ok' | 'warn' | 'error' | 'neutral'
  | 'amber' | 'cyan' | 'red';

/** One mechanic whose dev state is not the public state. */
export interface DeveloperFeedDiffMechanicRow {
  playableId: string;
  /** Human name used by the founder-facing diff. */
  title: string;
  /** Human audience label for the private adopted candidate. */
  status: string;
  state: string;
  tone: DeveloperFeedDiffTone;
  /** Original founder requests included in this private candidate. */
  instructions: readonly string[];
  /** Requests still in progress or blocked and therefore excluded from publication. */
  pendingRequests: readonly Readonly<{
    instruction: string;
    status: string;
    detail: string;
  }>[];
  /** True when this row exists because the operator adopted an exact candidate. */
  adopted: boolean;
  publication: Readonly<PlayablePublicationPreparedV1> | null;
}

export interface DeveloperFeedDiffCatalogRow {
  changed: boolean;
  /** The server projection is absent or failed strict validation. */
  unknown: boolean;
  status: string;
  detail: string;
  promotion: Readonly<CatalogDirectPromotionPreparedV1> | null;
  promotionPreparing: boolean;
}

export interface DeveloperFeedDiffInput {
  /** The gate the operator flag UI already uses (rework OR platform intake). */
  operatorSurfacesActive?: boolean;
  /** Entries of the feed's own `playableId → queue` map. No request is issued. */
  reworks?: Iterable<readonly [string, readonly OperatorPlayableReworkQueueItemV1[]]> | null;
  vocabulary?: import('./operator-presentation-vocabulary.mjs').OperatorPresentationVocabularyV1;
  /** Current exact candidate heads, at most one per playable. */
  adoptions?: readonly {
    playableId: string;
    releaseId: string;
    candidateArtifactDigest: string;
    bindingDigest?: string;
    sourceCommit?: string;
  }[];
  /** Exact optional server-owned catalog dev/public projection from `/session`. */
  catalog?: DeveloperFeedCatalogDiffV1 | null;
  /** Exact server-prepared closure; mismatched identities fail closed. */
  catalogPromotion?: CatalogDirectPromotionPreparedV1 | null;
  /** A prepare request for the current exact candidate is in flight. */
  catalogPromotionPreparing?: boolean;
  /** Exact server-prepared private mechanic → public publication closure. */
  mechanicPublication?: PlayablePublicationPreparedV1 | null;
  mechanicPublicationPreparing?: boolean;
}

export interface DeveloperFeedDiffModel {
  /** The badge (and therefore the sheet) exists at all. */
  visible: boolean;
  /** Objects whose dev identity differs from public. */
  changed: number;
  /** Trusted projection contains no private object. */
  empty: boolean;
  audience: Readonly<import('./operator-presentation-vocabulary.mjs').OperatorPresentationEntryV1>;
  mechanics: DeveloperFeedDiffMechanicRow[];
  mechanicPublicationPreparing: boolean;
  catalog: DeveloperFeedDiffCatalogRow;
}

export interface DeveloperFeedDiffSurface {
  readonly open: boolean;
  update(input: DeveloperFeedDiffInput): void;
  close(): void;
  /** Drop every listener, timer and node. Idempotent. */
  destroy(): void;
}

export interface CatalogDirectPromotionClientOutcome {
  status: 'committed_refreshed' | 'committed_refresh_pending';
}

export interface PlayablePublicationClientOutcome {
  status: 'queued_refreshed' | 'queued_refresh_pending' | 'published_refreshed';
}

export function developerFeedDiffModel(
  input: DeveloperFeedDiffInput,
): Readonly<DeveloperFeedDiffModel>;

export function validateDeveloperFeedCatalogDiff(
  value: unknown,
): Readonly<DeveloperFeedCatalogDiffV1> | null;

export function validateCatalogDirectPromotionPrepared(
  value: unknown,
): Readonly<CatalogDirectPromotionPreparedV1> | null;

export function validateCatalogDirectPromotionResult(
  value: unknown,
): Readonly<CatalogDirectPromotionResultV1> | null;

export function validatePlayablePublicationPrepared(
  value: unknown,
): Readonly<PlayablePublicationPreparedV1> | null;

export function validatePlayablePublicationRequested(
  value: unknown,
): Readonly<PlayablePublicationRequestedV1> | null;

export function mountDeveloperFeedDiffSurface(
  host: HTMLElement,
  options: {
    input: DeveloperFeedDiffInput;
    /** Jump to the mechanic's card, where `Доработать механику` already lives. */
    onShowMechanic?(playableId: string): void;
    onPromoteCatalog?(
      prepared: Readonly<CatalogDirectPromotionPreparedV1>,
      confirmationCode: string,
    ): Promise<CatalogDirectPromotionClientOutcome>;
    onPublishMechanic?(
      prepared: Readonly<PlayablePublicationPreparedV1>,
      confirmationCode: string,
    ): Promise<PlayablePublicationClientOutcome>;
    onPrepareMechanics?(
      playableIds: readonly string[],
    ): Promise<Readonly<PlayablePublicationPreparedV1>>;
  },
): DeveloperFeedDiffSurface;
