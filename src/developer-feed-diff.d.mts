import type {
  OperatorPlayableReworkQueueItemV1,
  PlatformDevelopmentIntakeResponseV1,
} from './api';

/**
 * Read-only inventory of "what is different in my dev feed right now".
 *
 * Slice 1 of the frozen selective-promotion v1 contract: it aggregates ONLY
 * state the feed client already holds. It owns no mutation authority, issues
 * no request of its own and never carries a promotion control.
 */

export type DeveloperFeedDiffTone = 'ok' | 'warn' | 'error' | 'neutral';

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
  intake: { status: string; tone: DeveloperFeedDiffTone; blocker: string | null } | null;
}

export interface DeveloperFeedDiffCatalogRow {
  status: string;
  detail: string;
  identity: DeveloperFeedDiffIdentityLine[];
}

export interface DeveloperFeedDiffInput {
  /** The gate the operator flag UI already uses (rework OR platform intake). */
  operatorSurfacesActive?: boolean;
  platform?: { sourceSha?: string | null; stamp?: string | null } | null;
  /** Entries of the feed's own `playableId → queue` map. No request is issued. */
  reworks?: Iterable<readonly [string, readonly OperatorPlayableReworkQueueItemV1[]]> | null;
  platformIntake?: PlatformDevelopmentIntakeResponseV1 | null;
  /** The exact candidate this operator adopted, if any. */
  adoption?: {
    playableId: string;
    releaseId: string;
    candidateArtifactDigest: string;
    sourceCommit?: string;
  } | null;
  /**
   * Slice 1 always passes `null`: no operator-readable endpoint exposes catalog
   * active-release/candidate identity to this client, so the row stays honest.
   */
  catalog?: { activeRelease: DeveloperFeedDiffIdentityLine[] } | null;
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

export function developerFeedDiffModel(
  input: DeveloperFeedDiffInput,
): Readonly<DeveloperFeedDiffModel>;

export function mountDeveloperFeedDiffSurface(
  host: HTMLElement,
  options: {
    input: DeveloperFeedDiffInput;
    /** Jump to the mechanic's card, where `Доработать механику` already lives. */
    onShowMechanic?(playableId: string): void;
  },
): DeveloperFeedDiffSurface;
