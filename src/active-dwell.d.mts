export interface ActiveDwellGates {
  visible?: boolean;
  foreground?: boolean;
  interactiveReady?: boolean;
}

export interface ActiveDwellSnapshot {
  dwellActiveMs: number;
  dwellCensored: boolean;
}

export class ActiveDwellAccumulator {
  constructor(now?: number);
  reset(now?: number, gates?: ActiveDwellGates): void;
  update(gates: ActiveDwellGates, now: number): void;
  snapshot(now: number, dwellCensored?: boolean): ActiveDwellSnapshot;
  finish(now: number, dwellCensored?: boolean): ActiveDwellSnapshot;
}
