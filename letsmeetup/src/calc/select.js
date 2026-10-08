// Step 4: choose the final few and say what each one is good at.

import { haversineKm } from './geo.js';

// Greedy pick by score with variety: first the best venue from each candidate area, then (only if
// that gives fewer than `min`) the best of the rest. Venues almost on top of each other are skipped.
export function pickDiverse(ranked, { min, max, minSeparationMeters }) {
  const picked = [];
  const tooClose = (v) => picked.some((p) => haversineKm(p.venue, v.venue) * 1000 < minSeparationMeters);

  const seenAreas = new Set();
  for (const r of ranked) {
    if (picked.length >= max) break;
    if (seenAreas.has(r.areaId) || tooClose(r)) continue;
    seenAreas.add(r.areaId);
    picked.push(r);
  }
  for (const r of ranked) {
    if (picked.length >= min) break;
    if (picked.includes(r) || tooClose(r)) continue;
    picked.push(r);
  }
  return picked.sort((a, b) => a.score - b.score || a.venue.providerPlaceId.localeCompare(b.venue.providerPlaceId));
}

// Each label goes to the picked venue that wins that measure (ties: the better overall rank).
// Only labels that actually distinguish a venue are given: if every pick has the same value, nobody wins.
export function labelPicks(picks) {
  if (picks.length < 2) return picks.map(() => []);
  const labels = picks.map(() => []);
  const award = (label, key, lowerIsBetter = true) => {
    const vals = picks.map(key);
    const best = lowerIsBetter ? Math.min(...vals) : Math.max(...vals);
    if (vals.every((v) => v === best)) return;
    labels[vals.indexOf(best)].push(label);
  };
  award('Quickest overall', (p) => p.stats.meanMinutes);
  award('Fairest', (p) => p.stats.spreadMinutes);
  award('Shortest longest journey', (p) => p.stats.maxMinutes);
  award('Best rated', (p) => (p.venue.rating == null ? -1 : p.venue.rating * Math.min(1, (p.venue.ratingCount ?? 0) / 200)), false);
  return labels;
}
