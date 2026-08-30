import type {
  DeveloperFeedCatalogDiffV1,
  CatalogDirectPromotionPreparedV1,
  CatalogDirectPromotionResultV1,
  OperatorPlayableReworkQueueItemV1,
  PlatformDevelopmentIntakeResponseV1,
} from './api';

/**
 * Inventory of "what is different in my dev feed right now".  A publication
 * control exists only for an exact server-prepared candidate closure.
 */

export type DeveloperFeedDiffTone =
  | 'ok' | 'warn' | 'error' | 'neutral'
  | 'amber' | 'cyan' | 'red';

export interface DeveloperFeedDiffIdentityLine {
  label: string;
  value: string;
  /** Digest/sha-like values render in the monospace idiom used by receipts. */
  mono: boolean;
}

/** One mechanic whose dev state is not the public state. */
export interface DeveloperFeedDiffMechanicRow {
  playableId: string;
  /** Reused verbatim from `operatorPlayableReworkPresentation`. */
  status: string;
  state: string;
  tone: DeveloperFeedDiffTone;
  /** Reused verbatim from the rework details counts strip. */
  counts: string;
  blocker: string | null;
  identity: DeveloperFeedDiffIdentityLine[];
  /** True when this row exists because the operator adopted an exact candidate. */
  adopted: boolean;
}

export interface DeveloperFeedDiffPlatformRow {
  /** Always `что живёт сейчас` — the baked identity is what the operator runs. */
  status: string;
  identity: DeveloperFeedDiffIdentityLine[];
  /** Present only while a platform rework is in flight. */
  intake: {
    status: string;
    label: string;
    icon: string;
    tone: DeveloperFeedDiffTone;
    blocker: string | null;
  } | null;
}

export interface DeveloperFeedDiffCatalogRow {
  status: string;
  detail: string;
  identity: DeveloperFeedDiffIdentityLine[];
  promotion: Readonly<CatalogDirectPromotionPreparedV1> | null;
}

export interface DeveloperFeedDiffInput {
  /** The gate the operator flag UI already uses (rework OR platform intake). */
  operatorSurfacesActive?: boolean;
  platform?: { sourceSha?: string | null; stamp?: string | null } | null;
  /** Entries of the feed's own `playableId → queue` map. No request is issued. */
  reworks?: Iterable<readonly [string, readonly OperatorPlayableReworkQueueItemV1[]]> | null;
  platformIntake?: PlatformDevelopmentIntakeResponseV1 | null;
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
}

export interface DeveloperFeedDiffModel {
  /** The badge (and therefore the sheet) exists at all. */
  visible: boolean;
  /** Objects whose dev identity differs from public. */
  changed: number;
  /** No object is in flight → `Dev не отличается от публичного`. */
  empty: boolean;
  platform: DeveloperFeedDiffPlatformRow;
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
