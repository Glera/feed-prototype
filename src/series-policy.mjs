export function mechanicBaseId(mechanicId) {
  return mechanicId.endsWith('-swipe') ? mechanicId.slice(0, -6) : mechanicId;
}

export function seriesLength(mechanicId) {
  const base = mechanicBaseId(mechanicId);
  if (base === 'pins-l3' || base === 'pins' || base.startsWith('pins-')) return 2;
  if (base === 'merge-locked-v1') return 1;
  if (base === 'marble-sort') return 2;
  if (base === 'merge-timepress-v1') return 2;
  if (base === 'merge-timepress-v2') return 1;
  if (base === 'short-drama') return 6;
  if (base.includes('no-orders') || base.includes('second-board')) return 1;
  return 5;
}

/** Map a 1-based series step to a built-in playable level when the mechanic
 * owns level-shaped content. `pins-lN` is the first level of a two-level pair. */
export function seriesGameLevel(mechanicId, seriesLevel) {
  const base = mechanicBaseId(mechanicId || '');
  if (base === 'arrows-v1') {
    return [11, 12, 13, 14, 10][seriesLevel - 1] ?? null;
  }
  if (base === 'pins') return seriesLevel;
  const pinsPair = /^pins-l(\d+)$/.exec(base);
  if (pinsPair) return Number(pinsPair[1]) + seriesLevel - 1;
  if (base === 'short-drama') return seriesLevel;
  return null;
}
