const QUERY_KEY = 'missionDemo';
const START_PARAM = 'mission_demo';

export function missionDemoRequested({ search = '', startParam = null } = {}) {
  if (startParam === START_PARAM) return true;
  return new URLSearchParams(String(search || '')).get(QUERY_KEY) === '1';
}
