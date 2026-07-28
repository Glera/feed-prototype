/**
 * Upgrade-ceremony watermark (v1) — CLIENT-OWNED presentation state.
 *
 * The server projection is untouched: a house stage grows the instant a guest's
 * completion claim lands, and `/island/state` is always the authority. This
 * watermark records only what the OWNER has already been SHOWN, so a growth the
 * owner never saw can be celebrated once, later, on their island.
 *
 * Constitution (mirrors the "кто-то сыграл" cursor):
 *   • an unknown building is INITIALISED at its current stage with NO ceremony —
 *     historical guest activity never produces confetti on a first entry;
 *   • the watermark advances per BUILDING (with its own scene), never per queue,
 *     so one level can never be celebrated twice;
 *   • buildings the server no longer returns are dropped silently.
 *
 * Kept in its own module (not island.ts) so the feed can read it for the "!"
 * nav badge without statically importing the whole island chunk.
 */
import type { IslandBuildingState } from './api';

export const CELEBRATED_STAGE_KEY = 'island-celebrated-stages-v1';

/** Server-owned stage 0..10 = min(foreign_claims, 10). If the backend has not
 *  yet attached `stage` we derive it from `foreign_claims`, else 0 — always
 *  defensive. This is the single stage read shared by the island renderer, the
 *  ceremony watermark and the feed nav badge. */
export function houseStage(b: IslandBuildingState): number {
  const raw = typeof b.stage === 'number'
    ? b.stage
    : typeof b.foreign_claims === 'number' ? b.foreign_claims : 0;
  return Math.max(0, Math.min(10, Math.floor(raw)));
}

export type CelebratedStages = Record<string, number>;

export function loadCelebratedStages(): CelebratedStages {
  try {
    const parsed = JSON.parse(localStorage.getItem(CELEBRATED_STAGE_KEY) || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CelebratedStages = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[id] = Math.max(0, Math.min(10, Math.floor(value)));
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCelebratedStages(map: CelebratedStages): void {
  try { localStorage.setItem(CELEBRATED_STAGE_KEY, JSON.stringify(map)); } catch { /* private mode */ }
}

export interface StageUpgrade {
  buildingId: string;
  slot: number;
  from: number;
  to: number;
}

/** Growth the owner has NOT been shown yet, ordered by slot. A building that is
 *  not in the watermark yet is deliberately absent: it is initialised without a
 *  ceremony the next time the island (or this function's caller) commits one. */
export function pendingStageUpgrades(
  buildings: readonly IslandBuildingState[],
  celebrated: CelebratedStages = loadCelebratedStages(),
): StageUpgrade[] {
  const out: StageUpgrade[] = [];
  for (const b of buildings) {
    const id = b.buildingId;
    if (!id || !(id in celebrated)) continue;
    const stage = houseStage(b);
    if (stage > celebrated[id]) out.push({ buildingId: id, slot: b.slot, from: celebrated[id], to: stage });
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/** Feed nav badge input: is there growth waiting to be celebrated? */
export function hasPendingStageUpgrade(buildings: readonly IslandBuildingState[]): boolean {
  return pendingStageUpgrades(buildings).length > 0;
}
