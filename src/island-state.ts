import {
  ApiRequestError,
  apiIslandState,
  apiSaveIslandState,
  type IslandBuildingState,
  type IslandPersistedState,
  type IslandStateResponse,
  type IslandStoredPack,
} from './api';
import { getInitData } from './telegram';

const LEGACY_STATE_KEY = 'island-proto-v1';
const SYNC_KEY = 'island-proto-v1-sync';

interface SyncMeta {
  revision: number;
  base: IslandPersistedState | null;
  dirty: boolean;
}

interface IslandStateHooks {
  read(): IslandPersistedState;
  apply(state: IslandPersistedState): void;
  onHydrated?(): void;
}

function telegramUserId(): string | null {
  const id = (window as unknown as {
    Telegram?: { WebApp?: { initDataUnsafe?: { user?: { id?: number } } } };
  }).Telegram?.WebApp?.initDataUnsafe?.user?.id;
  return Number.isSafeInteger(id) ? String(id) : null;
}

function storageKeys(): { state: string; sync: string; scoped: boolean } {
  const userId = telegramUserId();
  return userId
    ? { state: `${LEGACY_STATE_KEY}:${userId}`, sync: `${SYNC_KEY}:${userId}`, scoped: true }
    : { state: LEGACY_STATE_KEY, sync: SYNC_KEY, scoped: false };
}

function clone<T>(value: T): T {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => same(value, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>).sort();
    const bk = Object.keys(b as Record<string, unknown>).sort();
    if (!same(ak, bk)) return false;
    return ak.every((key) => same(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
    ));
  }
  return false;
}

export function defaultIslandState(): IslandPersistedState {
  return {
    tokens: 120,
    buildings: [
      { slot: 1, tpl: 'sort', pack: 'neon', name: 'Neon sort', plays: 2431, likes: 128, liked: false },
    ],
  };
}

function normaliseState(value: IslandPersistedState): IslandPersistedState {
  const state = clone(value);
  if (!Number.isFinite(state.tokens) || state.tokens < 0) state.tokens = 120;
  if (!Array.isArray(state.buildings)) state.buildings = [];
  state.buildings = state.buildings
    .filter((building) => building && Number.isInteger(building.slot) && building.slot >= 0 && building.slot <= 3)
    .slice(0, 4);
  state.buildings.forEach((building) => {
    if (building.publishing && !building.jobId) {
      building.publishing = false;
      building.publishError = 'Publish status was interrupted; retry to confirm hosting';
    }
  });
  return state;
}

export function loadIslandState(): IslandPersistedState {
  try {
    const keys = storageKeys();
    let raw = localStorage.getItem(keys.state);
    // One-time bridge from the prototype's unscoped key. New writes are scoped
    // by Telegram user so switching accounts in one client cannot mix islands.
    if (!raw && keys.scoped) {
      raw = localStorage.getItem(LEGACY_STATE_KEY);
      if (raw) localStorage.setItem(keys.state, raw);
    }
    if (raw) return normaliseState(JSON.parse(raw) as IslandPersistedState);
  } catch { /* first run / blocked storage */ }
  return defaultIslandState();
}

export function cacheIslandState(state: IslandPersistedState): void {
  try { localStorage.setItem(storageKeys().state, JSON.stringify(state)); } catch { /* private mode */ }
}

export function replaceIslandState(target: IslandPersistedState, source: IslandPersistedState): void {
  const next = normaliseState(source);
  target.tokens = next.tokens;
  target.buildings = next.buildings;
  if (next.aiPacks) target.aiPacks = next.aiPacks;
  else delete target.aiPacks;
  if (next.aiSeq != null) target.aiSeq = next.aiSeq;
  else delete target.aiSeq;
}

function buildingIdentity(building: IslandBuildingState): string {
  return building.jobId || [building.tpl, building.pack, building.name, building.prompt || ''].join('\u0000');
}

function mergeBuilding(
  base: IslandBuildingState | undefined,
  local: IslandBuildingState | undefined,
  remote: IslandBuildingState | undefined,
): IslandBuildingState | undefined {
  if (same(local, base)) return clone(remote);
  if (same(remote, base)) return clone(local);
  if (!local) return undefined;
  if (!remote) {
    // A remote deletion beats edits to the old building, but not a local slot
    // replacement that represents a distinct newly-created mechanic.
    if (base && buildingIdentity(local) === buildingIdentity(base)) return undefined;
    return clone(local);
  }
  if (!base) return clone(local);

  const baseId = buildingIdentity(base);
  const localId = buildingIdentity(local);
  const remoteId = buildingIdentity(remote);
  if (localId !== baseId) return clone(local);
  if (remoteId !== baseId) return clone(remote);

  // Same mechanic changed on both devices. Preserve remote publish completion
  // while applying this client's field edits and additive counters.
  const out = clone(remote) as unknown as Record<string, unknown>;
  const baseRecord = base as unknown as Record<string, unknown>;
  const localRecord = local as unknown as Record<string, unknown>;
  for (const key of Object.keys(localRecord)) {
    if (key === 'plays' || key === 'likes') continue;
    if (!same(localRecord[key], baseRecord[key])) out[key] = clone(localRecord[key]);
  }
  out.plays = Math.max(0, remote.plays + (local.plays - base.plays));
  out.likes = Math.max(0, remote.likes + (local.likes - base.likes));
  return out as unknown as IslandBuildingState;
}

/** Three-way merge used only after a revision conflict or offline reconnect. */
export function mergeIslandStates(
  base: IslandPersistedState,
  local: IslandPersistedState,
  remote: IslandPersistedState,
): IslandPersistedState {
  const baseBySlot = new Map(base.buildings.map((building) => [building.slot, building]));
  const localBySlot = new Map(local.buildings.map((building) => [building.slot, building]));
  const remoteBySlot = new Map(remote.buildings.map((building) => [building.slot, building]));
  const slots = new Set([...baseBySlot.keys(), ...localBySlot.keys(), ...remoteBySlot.keys()]);
  const buildings = [...slots]
    .map((slot) => mergeBuilding(baseBySlot.get(slot), localBySlot.get(slot), remoteBySlot.get(slot)))
    .filter((building): building is IslandBuildingState => Boolean(building))
    .sort((a, b) => a.slot - b.slot);

  const basePacks = base.aiPacks || {};
  const localPacks = local.aiPacks || {};
  const remotePacks = remote.aiPacks || {};
  const packIds = new Set([...Object.keys(basePacks), ...Object.keys(localPacks), ...Object.keys(remotePacks)]);
  const aiPacks: Record<string, IslandStoredPack> = {};
  packIds.forEach((id) => {
    const value = same(localPacks[id], basePacks[id]) ? remotePacks[id] : localPacks[id];
    if (value) aiPacks[id] = clone(value);
  });

  const tokenDelta = local.tokens - base.tokens;
  const aiSeq = Math.max(base.aiSeq || 0, local.aiSeq || 0, remote.aiSeq || 0);
  const merged: IslandPersistedState = {
    tokens: Math.max(0, remote.tokens + tokenDelta),
    buildings,
  };
  if (Object.keys(aiPacks).length) merged.aiPacks = aiPacks;
  if (aiSeq > 0) merged.aiSeq = aiSeq;
  return normaliseState(merged);
}

function loadSyncMeta(): SyncMeta {
  try {
    const raw = localStorage.getItem(storageKeys().sync);
    if (!raw) return { revision: 0, base: null, dirty: false };
    const parsed = JSON.parse(raw) as Partial<SyncMeta>;
    return {
      revision: Number.isInteger(parsed.revision) && Number(parsed.revision) >= 0 ? Number(parsed.revision) : 0,
      base: parsed.base ? normaliseState(parsed.base) : null,
      dirty: parsed.dirty === true,
    };
  } catch {
    return { revision: 0, base: null, dirty: false };
  }
}

export class IslandStateSync {
  private revision: number;
  private base: IslandPersistedState | null;
  private dirty: boolean;
  private hydrated = false;
  private hydratedNotified = false;
  private hydrating: Promise<void> | null = null;
  private pumping = false;
  private localVersion = 0;
  private readonly enabled = Boolean(getInitData());

  constructor(private readonly hooks: IslandStateHooks) {
    const meta = loadSyncMeta();
    this.revision = meta.revision;
    this.base = meta.base;
    this.dirty = meta.dirty;
  }

  private writeMeta(): void {
    try {
      localStorage.setItem(storageKeys().sync, JSON.stringify({
        revision: this.revision,
        base: this.base,
        dirty: this.dirty,
      } satisfies SyncMeta));
    } catch { /* private mode */ }
  }

  private applyRemote(state: IslandPersistedState): void {
    this.hooks.apply(normaliseState(state));
    cacheIslandState(this.hooks.read());
  }

  private notifyHydrated(): void {
    if (this.hydratedNotified) return;
    this.hydratedNotified = true;
    this.hooks.onHydrated?.();
  }

  changed(): void {
    cacheIslandState(this.hooks.read());
    this.localVersion++;
    this.dirty = true;
    this.writeMeta();
    if (this.enabled) {
      if (this.hydrated) void this.pump();
      else void this.hydrate();
    }
  }

  hydrate(): Promise<void> {
    if (!this.enabled || this.hydrated) return Promise.resolve();
    if (this.hydrating) return this.hydrating;
    this.hydrating = this.hydrateInner().finally(() => { this.hydrating = null; });
    return this.hydrating;
  }

  private async hydrateInner(): Promise<void> {
    const localAtStart = clone(this.hooks.read());
    const versionAtStart = this.localVersion;
    try {
      let remote = await apiIslandState();
      if (!remote.state) {
        const snapshot = clone(this.hooks.read());
        const versionAtCreate = this.localVersion;
        let createdHere = true;
        try {
          remote = await apiSaveIslandState(snapshot, 0);
        } catch (error) {
          if (!(error instanceof ApiRequestError) || error.status !== 409) throw error;
          createdHere = false;
          remote = await apiIslandState();
        }
        if (!remote.state) throw new Error('Backend returned no island after create');
        this.revision = remote.revision;
        this.base = normaliseState(remote.state);
        this.hydrated = true;
        if (this.localVersion === versionAtCreate) {
          this.dirty = false;
          this.applyRemote(this.base);
        } else if (!createdHere) {
          const merged = mergeIslandStates(snapshot, this.hooks.read(), this.base);
          this.applyRemote(merged);
          this.dirty = !same(merged, this.base);
        } else {
          this.dirty = true;
        }
        this.writeMeta();
        this.notifyHydrated();
        if (this.dirty) void this.pump();
        console.log(`[island] state synced at revision ${this.revision}`);
        return;
      }

      const remoteState = normaliseState(remote.state);
      const changedDuringHydrate = this.localVersion !== versionAtStart;
      const mergeBase = this.dirty && this.base ? this.base : changedDuringHydrate ? localAtStart : null;
      this.revision = remote.revision;
      this.base = clone(remoteState);
      this.hydrated = true;
      if (mergeBase) {
        const merged = mergeIslandStates(mergeBase, this.hooks.read(), remoteState);
        this.applyRemote(merged);
        this.dirty = !same(merged, remoteState);
      } else {
        this.applyRemote(remoteState);
        this.dirty = false;
      }
      this.writeMeta();
      this.notifyHydrated();
      if (this.dirty) void this.pump();
      console.log(`[island] state synced at revision ${this.revision}`);
    } catch (error) {
      console.warn('[island] state sync unavailable; using local cache:', error);
    }
  }

  private async refreshAfterConflict(): Promise<boolean> {
    const remote = await apiIslandState();
    if (!remote.state) return false;
    const remoteState = normaliseState(remote.state);
    const merged = mergeIslandStates(this.base || remoteState, this.hooks.read(), remoteState);
    this.revision = remote.revision;
    this.base = clone(remoteState);
    this.applyRemote(merged);
    this.hooks.onHydrated?.();
    this.dirty = true;
    this.writeMeta();
    return true;
  }

  private async pump(): Promise<void> {
    if (!this.enabled || !this.hydrated || this.pumping || !this.dirty) return;
    this.pumping = true;
    try {
      while (this.dirty) {
        const snapshot = clone(this.hooks.read());
        const sentVersion = this.localVersion;
        // Keep metadata dirty until the server acknowledges this exact snapshot.
        this.writeMeta();
        let response: IslandStateResponse;
        try {
          response = await apiSaveIslandState(snapshot, this.revision);
        } catch (error) {
          if (error instanceof ApiRequestError && error.status === 409) {
            if (await this.refreshAfterConflict()) continue;
          }
          this.dirty = true;
          this.writeMeta();
          console.warn('[island] state write deferred:', error);
          break;
        }
        if (!response.state) throw new Error('Backend acknowledged island without state');
        this.revision = response.revision;
        this.base = normaliseState(response.state);
        const changedSinceSend = this.localVersion !== sentVersion || !same(this.hooks.read(), snapshot);
        this.dirty = changedSinceSend;
        if (!changedSinceSend) this.applyRemote(this.base);
        this.writeMeta();
        console.log(`[island] state saved at revision ${this.revision}`);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Pull another device's newer revision; also retries deferred offline writes. */
  async refresh(): Promise<void> {
    if (!this.enabled) return;
    if (!this.hydrated) {
      await this.hydrate();
      return;
    }
    if (this.dirty) {
      await this.pump();
      return;
    }
    if (this.pumping) return;
    try {
      const remote = await apiIslandState();
      if (!remote.state || remote.revision <= this.revision) return;
      this.revision = remote.revision;
      this.base = normaliseState(remote.state);
      this.applyRemote(this.base);
      this.hooks.onHydrated?.();
      this.writeMeta();
      console.log(`[island] state pulled at revision ${this.revision}`);
    } catch (error) {
      console.warn('[island] state refresh deferred:', error);
    }
  }
}
