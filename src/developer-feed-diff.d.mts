import type {
  DeveloperFeedCatalogDiffV1,
  CatalogDirectPromotionPreparedV1,
  CatalogDirectPromotionResultV1,
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
  /** True when this row exists because the operator adopted an exact candidate. */
  adopted: boolean;
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
  /** The exact candidate this operator adopted, if any. */
  adoption?: {
    playableId: string;
    releaseId: string;
    candidateArtifactDigest: string;
    sourceCommit?: string;
  } | null;
  /** Exact optional server-owned catalog dev/public projection from `/session`. */
  catalog?: DeveloperFeedCatalogDiffV1 | null;
  /** Exact server-prepared closure; mismatched identities fail closed. */
  catalogPromotion?: CatalogDirectPromotionPreparedV1 | null;
  /** A prepare request for the current exact candidate is in flight. */
  catalogPromotionPreparing?: boolean;
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
  },
): DeveloperFeedDiffSurface;
