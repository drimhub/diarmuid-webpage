// TfL-specific parsing for the transit table build. Lives in scripts/, never in src/: the Worker only
// reads the finished table (src/calc/network.js).

import { WALK_ONLY, UNREACHABLE, MAX_MINUTES } from '../../src/calc/network.js';

const epochMinute = (iso) => Math.round(Date.parse(iso.endsWith('Z') ? iso : `${iso}Z`) / 60000); // only differences matter

// Reduces a TfL JourneyResults body to what the rule needs, so the cache stays small and the rule can
// change without re-fetching: one entry per journey, each a list of [mode, departMinute, arriveMinute].
export function compactJourneys(body) {
  return (body?.journeys || []).map((j) => (j.legs || []).map((l) => [l.mode?.id || '', epochMinute(l.departureTime), epochMinute(l.arrivalTime)]));
}

// Minutes of time on the network for one journey: drop the first and last legs when they are walking
// (the walk to and from the neighbourhood anchor is an artefact or a per-person constant), keep walks
// between transit legs, and measure from the first kept departure to the last kept arrival so waiting
// at interchanges counts. null if nothing but walking is left.
export function strippedMinutes(legs) {
  const kept = [...legs];
  if (kept.length && kept[0][0] === 'walking') kept.shift();
  if (kept.length && kept[kept.length - 1][0] === 'walking') kept.pop();
  if (!kept.some((l) => l[0] !== 'walking')) return null;
  return kept[kept.length - 1][2] - kept[0][1];
}

// A table value from a pair's compact journeys: shortest stripped journey, WALK_ONLY if every journey
// is walking only, UNREACHABLE if there are none.
export function tableValue(journeys) {
  if (!journeys || !journeys.length) return UNREACHABLE;
  const times = journeys.map(strippedMinutes).filter((m) => m !== null && m >= 0);
  if (!times.length) return WALK_ONLY;
  return Math.max(1, Math.min(MAX_MINUTES, Math.min(...times)));
}
