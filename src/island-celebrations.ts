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
import { userScopedStorageKey } from './user-scope';

/** Legacy, device-wide key. Never read again once a user scope exists: a
 *  watermark is one PLAYER's viewing history, so inheriting another account's
 *  value on a shared device would either swallow their ceremonies (foreign
 *  watermark higher) or replay ours (foreign watermark lower). */
export const CELEBRATED_STAGE_KEY = 'island-celebrated-stages-v1';

/** Scoped per Telegram user; falls back to the bare key outside Telegram. */
export function celebratedStageStorageKey(): string {
  return userScopedStorageKey(CELEBRATED_STAGE_KEY);
}

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

/**
 * Read this user's watermark. A missing scoped key is deliberately NOT filled
 * from the legacy device-wide one: an empty watermark is exactly the "first
 * entry" state, and `syncStageCeremonies` already initialises every unknown
 * building at its current stage WITHOUT a ceremony. So a second account on a
 * shared device gets an honest silent baseline instead of someone else's
 * history.
 */
export function loadCelebratedStages(): CelebratedStages {
  try {
    const parsed = JSON.parse(localStorage.getItem(celebratedStageStorageKey()) || '{}') as unknown;
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
  try {
    const key = celebratedStageStorageKey();
    localStorage.setItem(key, JSON.stringify(map));
    // The scoped watermark now exists, so the ownerless legacy value can never
    // be read again — drop it instead of leaving a foreign history on the device.
    if (key !== CELEBRATED_STAGE_KEY) localStorage.removeItem(CELEBRATED_STAGE_KEY);
  } catch { /* private mode */ }
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
