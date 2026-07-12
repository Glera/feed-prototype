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
