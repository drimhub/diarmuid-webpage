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

import { centroid, geometricMedian, minimaxCentre, haversineKm, nearestAreas } from './geo.js';

export function estimateMinutes(origin, point, config) {
  const { speedKmh, transitWaitMinutes, detour } = config.estimate;
  const km = haversineKm(origin, point) * detour;
  return (km / speedKmh[origin.mode]) * 60 + (origin.mode === 'transit' ? transitWaitMinutes : 0);
}

export function estimateStats(origins, point, config) {
  const t = origins.map((o) => estimateMinutes(o, point, config));
  const mean = t.reduce((s, x) => s + x, 0) / t.length;
  const max = Math.max(...t);
  const spread = max - Math.min(...t);
  return { times: t, mean, max, spread };
}

// origins: [{ id, lat, lng, mode, maxMinutes }]; areas: areas.json entries.
// Returns candidates best-first: [{ area, heuristics: string[], estimate: {mean, max, spread}, score }].
export function generateCandidateAreas(origins, areas, config) {
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

  // Keep the best, skipping near-duplicates (two anchors a few hundred metres apart).
  const kept = [];
  for (const c of pool) {
    if (kept.length >= config.maxCandidates) break;
    if (kept.some((k) => haversineKm(k.area, c.area) < config.candidateSpacingKm)) continue;
    kept.push(c);
  }
  return kept;
}
