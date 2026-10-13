// Step 1 of the calculation: which neighbourhoods are worth searching for venues?
//
// A "fair" meeting spot depends on what you optimise, so we compute several centres and look
// around all of them:
//   centroid     the average position (the obvious "midpoint")
//   median       minimises the total distance everyone travels
//   minimax      minimises the longest straight-line trip (protects whoever is furthest)
//   median_time / minimax_time   the same, but in travel time: a cyclist covers more ground than a
//                walker, so they are weighted by speed
// Each centre snaps to its nearest area anchors. Candidates are then pruned using a free
// straight-line time estimate, so only the promising few cost a Places request.
//
// Geometry can't see the rail network (two people on one tube line are better served by an
// interchange on that line than by the midpoint), so when there are transit travellers and a
// precomputed table (network.js) the best areas by network time take the first slots. They are only
// areas to SEARCH: real journey times still come from the routing call.

import { centroid, geometricMedian, minimaxCentre, haversineKm, nearestAreas } from './geo.js';
import { WALK_ONLY, UNREACHABLE } from './network.js';

export function estimateMinutes(origin, point, config) {
  const { speedKmh, transitWaitMinutes, detour } = config.estimate;
  const km = haversineKm(origin, point) * detour;
  return (km / speedKmh[origin.mode]) * 60 + (origin.mode === 'transit' ? transitWaitMinutes : 0);
}

function statsOf(t) {
  const mean = t.reduce((s, x) => s + x, 0) / t.length;
  const max = Math.max(...t);
  const spread = max - Math.min(...t);
  return { times: t, mean, max, spread };
}

export function estimateStats(origins, point, config) {
  return statsOf(origins.map((o) => estimateMinutes(o, point, config)));
}

// One person's time to an area using the table: null if the table says there is no journey.
// Non-transit people, people already in the area and areas the table doesn't know use the straight-line
// estimate; a walk-only pair uses it at walking speed (never 0, which would make neighbours look free).
function networkMinutes(origin, area, config, network) {
  if (origin.mode !== 'transit' || !origin.areaId || origin.areaId === area.id) return estimateMinutes(origin, area, config);
  const v = network.minutes(origin.areaId, area.id);
  if (v === null || v === undefined) return estimateMinutes(origin, area, config);
  if (v === UNREACHABLE) return null;
  if (v === WALK_ONLY) return estimateMinutes({ ...origin, mode: 'walk' }, area, config);
  return config.network.scale * v + config.network.offset;
}

// Every area scored by network time (all of them: it is a table lookup), best first, spaced, limited.
function networkCandidates(origins, areas, config, network) {
  const w = config.weights;
  const n = config.network;
  const scored = [];
  for (const area of areas) {
    const t = origins.map((o) => networkMinutes(o, area, config, network));
    if (t.some((x) => x === null)) continue;
    if (!origins.every((o, i) => o.maxMinutes == null || t[i] <= o.maxMinutes * n.slack)) continue;
    const estimate = statsOf(t);
    scored.push({ area, heuristics: ['network'], estimate, score: w.mean * estimate.mean + w.max * estimate.max + w.spread * estimate.spread });
  }
  scored.sort((a, b) => a.score - b.score || a.area.id.localeCompare(b.area.id));
  const kept = [];
  for (const c of scored) {
    if (kept.length >= n.candidates) break;
    if (kept.some((k) => haversineKm(k.area, c.area) < config.candidateSpacingKm)) continue;
    kept.push(c);
  }
  return kept;
}

// origins: [{ id, areaId, lat, lng, mode, maxMinutes }]; areas: areas.json entries;
// network: optional table from network.js (without it, or without transit people, geometry alone).
// Returns candidates best-first: [{ area, heuristics: string[], estimate: {mean, max, spread}, score }].
export function generateCandidateAreas(origins, areas, config, network = null) {
  const points = origins.map((o) => ({ lat: o.lat, lng: o.lng }));
  const invSpeed = origins.map((o) => 1 / config.estimate.speedKmh[o.mode]);

  const centres = {
    centroid: centroid(points),
    median: geometricMedian(points),
    minimax: minimaxCentre(points),
    median_time: geometricMedian(points, invSpeed),
    minimax_time: minimaxCentre(points, invSpeed),
  };

  // Snap every centre to its nearest anchors, remembering which heuristics proposed each area.
  const byArea = new Map();
  for (const [name, point] of Object.entries(centres)) {
    for (const { area } of nearestAreas(point, areas, config.nearestAreasPerPoint)) {
      if (!byArea.has(area.id)) byArea.set(area.id, { area, heuristics: new Set() });
      byArea.get(area.id).heuristics.add(name);
    }
  }

  const w = config.weights;
  const scored = [...byArea.values()].map(({ area, heuristics }) => {
    const estimate = estimateStats(origins, area, config);
    return { area, heuristics: [...heuristics], estimate, score: w.mean * estimate.mean + w.max * estimate.max + w.spread * estimate.spread };
  });

  // Drop candidates nobody could reach within their own limit (with slack: it is only an estimate).
  const reachable = scored.filter((c) => origins.every((o, i) => o.maxMinutes == null || c.estimate.times[i] <= o.maxMinutes * config.candidateLimitSlack));
  const pool = reachable.length ? reachable : scored; // never prune to nothing; real times decide later

  pool.sort((a, b) => a.score - b.score || a.area.id.localeCompare(b.area.id));

  // Network candidates take the first slots; geometry fills the rest, best first, skipping
  // near-duplicates (two anchors a few hundred metres apart). An area both propose keeps both tags.
  const useNetwork = network && config.network.enabled && origins.some((o) => o.mode === 'transit');
  const kept = useNetwork ? networkCandidates(origins, areas, config, network).slice(0, config.maxCandidates) : [];
  for (const c of pool) {
    if (kept.length >= config.maxCandidates) break;
    const same = kept.find((k) => k.area.id === c.area.id);
    if (same) { same.heuristics.push(...c.heuristics); continue; }
    if (kept.some((k) => haversineKm(k.area, c.area) < config.candidateSpacingKm)) continue;
    kept.push(c);
  }
  return kept.sort((a, b) => a.score - b.score || a.area.id.localeCompare(b.area.id));
}
