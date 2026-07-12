export function stableRewardHash(value) {
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(value)) hash = Math.imul(hash ^ byte, 16777619);
  return hash >>> 0;
}

export function levelStarReward(runId) {
  return 1 + stableRewardHash(`level:${runId}`) % 5;
}

export function seriesRewards(runId) {
  return {
    stars: 3 + stableRewardHash(`series-stars:${runId}`) % 7,
    puzzles: 1 + stableRewardHash(`series-puzzles:${runId}`) % 5,
  };
}
