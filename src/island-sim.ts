// ── "Other players played my mechanic" simulation (no real players yet) ───────
// LOCAL-ONLY presentation overlay (never synced to the server): per-slot extra
// plays/likes dealt by a simulation. It never grants spendable puzzle currency;
// that balance belongs exclusively to the backend puzzle ledger.
//
// This lives in its own module (not island.ts) because the FEED drives the local
// presentation loop. Production never starts it; real counters come from the
// backend visit API.

export interface IslandSim {
  plays: Record<number, number>;
  likes: Record<number, number>;
  reward: Record<number, number>;   // uncollected puzzles piled over a building
}

const ISLAND_SIM_KEY = 'p4g-island-sim-v1';
export const REWARD_CAP = 9;   // puzzles waiting over one building before it stops accruing

export function loadIslandSim(): IslandSim {
  try {
    const s = JSON.parse(localStorage.getItem(ISLAND_SIM_KEY) || 'null');
    if (s && typeof s === 'object') {
      return { plays: s.plays || {}, likes: s.likes || {}, reward: s.reward || {} };
    }
  } catch { /* noop */ }
  return { plays: {}, likes: {}, reward: {} };
}

export function saveIslandSim(sim: IslandSim): void {
  try { localStorage.setItem(ISLAND_SIM_KEY, JSON.stringify(sim)); } catch { /* noop */ }
}

export const SIM_NAMES = ['Артём', 'Лена', 'Кирилл', 'Соня', 'Максим', 'Дана', 'Игорь', 'Вика', 'Паша', 'Настя', 'Рома', 'Юля', 'Гоша', 'Мила'];

export interface SimBuildingRef { slot: number; name: string; }
export interface SimEvent { slot: number; name: string; who: string; visitors: number; gainedReward: number; }

// One simulated visit: pick a building, add plays (+ maybe likes), and accrue some
// uncollected puzzles over it. Mutates + persists the sim; returns a descriptor for
// the notifier, or null if the player has no buildings yet.
export function simulateActivity(buildings: SimBuildingRef[]): SimEvent | null {
  if (!buildings.length) return null;
  const sim = loadIslandSim();
  const b = buildings[Math.floor(Math.random() * buildings.length)];
  const visitors = 1 + Math.floor(Math.random() * 4);
  sim.plays[b.slot] = (sim.plays[b.slot] || 0) + visitors;
  if (Math.random() < 0.6) sim.likes[b.slot] = (sim.likes[b.slot] || 0) + 1 + Math.floor(Math.random() * 2);
  let gainedReward = 0;
  if (Math.random() < 0.72) {
    gainedReward = 1 + (visitors > 2 ? 1 : 0);
    sim.reward[b.slot] = Math.min(REWARD_CAP, (sim.reward[b.slot] || 0) + gainedReward);
  }
  saveIslandSim(sim);
  const who = SIM_NAMES[Math.floor(Math.random() * SIM_NAMES.length)];
  return { slot: b.slot, name: b.name, who, visitors, gainedReward };
}

// Dispatched on `window` after every simulated visit so an open island overlay can
// refresh its updated plays/likes without owning the loop.
export const ISLAND_SIM_EVENT = 'p4g-island-sim';
