// The calculation: given an event, who is coming (neighbourhood + mode) and the providers, suggest
// 3-5 venues that are a fair compromise, with each person's journey. Pure orchestration over
// normalised types: it knows nothing about Google (providers are passed in).
//
//   candidates (free) -> venue search (Places) -> filters -> shortlist -> travel times (Routes, once)
//   -> limits and scoring -> diverse picks, labels, journey summaries
//
// The result is plain JSON, so it can be stored as it is (step 7) or compared in tests.

import { DEFAULTS, HEURISTICS_VERSION, withOverrides } from './config.js';
import { generateCandidateAreas } from './candidates.js';
import { filterWithRelaxation, shortlistVenues } from './venues.js';
import { journeyStats, limitViolations, scoreVenue } from './score.js';
import { labelPicks, pickDiverse } from './select.js';
import { haversineKm } from './geo.js';

const sumCost = (list) => ({
  requests: list.reduce((s, c) => s + c.requests, 0),
  elements: list.reduce((s, c) => s + (c.elements || 0), 0),
});

function empty(status, extra = {}) {
  return { heuristicsVersion: HEURISTICS_VERSION, status, notes: [], suggestions: [], candidates: [], excluded: {}, cost: { places: sumCost([]), routing: sumCost([]) }, ...extra };
}

// event: { eventType, startAt (ISO), tags[] }
// participants: [{ id, areaId|null, mode, maxMinutes|null }]
// areas: areas.json entries { id, name, lat, lng }
// providers: { places, routing }   config: optional overrides of DEFAULTS
export async function computeSuggestions({ event, participants, areas, providers, config: overrides }) {
  const config = withOverrides(DEFAULTS, overrides);
  const areaById = new Map(areas.map((a) => [a.id, a]));
  const tags = event.tags || [];

  // 1. Who can we plan for?
  const located = participants.filter((p) => p.areaId && areaById.has(p.areaId));
  const excluded = { participantsWithoutLocation: participants.filter((p) => !located.includes(p)).map((p) => p.id) };
  if (located.length < 2) return empty('not_enough_people', { excluded });
  const origins = located.map((p) => ({ id: p.id, lat: areaById.get(p.areaId).lat, lng: areaById.get(p.areaId).lng, mode: p.mode, maxMinutes: p.maxMinutes ?? null }));

  // 2. Where to look.
  const candidates = generateCandidateAreas(origins, areas, config);
  const candidateSummary = candidates.map((c) => ({ areaId: c.area.id, name: c.area.name, heuristics: c.heuristics, estimatedMeanMinutes: Math.round(c.estimate.mean * 10) / 10 }));

  // 3. Find and filter venues, widening the search once if too few qualify.
  const placesCosts = [];
  const notes = [];
  let pool = [];
  let filtered = null;
  for (const radiusMeters of config.radiusStepsMeters) {
    const searches = await Promise.all(candidates.map((c) => providers.places.findVenues({
      center: { lat: c.area.lat, lng: c.area.lng }, radiusMeters, eventType: event.eventType, maxResults: config.maxResultsPerSearch,
    })));
    placesCosts.push(...searches.map((s) => s.cost));

    const unique = new Map();
    for (const s of searches) for (const v of s.venues) if (!unique.has(v.providerPlaceId)) unique.set(v.providerPlaceId, v);
    pool = [...unique.values()];
    filtered = filterWithRelaxation(pool, { eventType: event.eventType, tags, startAt: event.startAt, config });
    if (filtered.kept.length >= config.minVenues) break;
  }
  notes.push(...filtered.notes);
  const costs = () => ({ places: sumCost(placesCosts), routing: sumCost(routingCosts) });
  const routingCosts = [];

  if (pool.length === 0) return empty('no_results', { reason: 'no_venues_found', candidates: candidateSummary, excluded, notes, cost: costs() });
  if (filtered.kept.length === 0) {
    return empty('no_results', { reason: 'no_venues_matched', candidates: candidateSummary, excluded: { ...excluded, venuesRejected: filtered.rejected }, notes, cost: costs() });
  }

  // Each kept venue belongs to its nearest candidate area, which drives variety later.
  const candidateOf = new Map();
  for (const v of filtered.kept) {
    let best = candidates[0];
    for (const c of candidates) if (haversineKm(v, c.area) < haversineKm(v, best.area)) best = c;
    candidateOf.set(v.providerPlaceId, best);
  }
  const groups = candidates.map((c) => filtered.kept.filter((v) => candidateOf.get(v.providerPlaceId) === c));
  const shortlist = shortlistVenues(groups, config.maxShortlist);

  // 4. Everyone's journey to every shortlisted venue, in one routing call.
  const travel = await providers.routing.getTravelTimes({
    origins: origins.map((o) => ({ lat: o.lat, lng: o.lng, mode: o.mode })),
    destinations: shortlist.map((v) => ({ lat: v.lat, lng: v.lng })),
    arriveBy: event.startAt,
  });
  routingCosts.push(travel.cost);
  notes.push(...travel.warnings);

  // 5. Limits and scores.
  const ctx = { config, tags, groupSize: origins.length, startAt: event.startAt };
  const feasible = [];
  const overLimit = [];
  let unavailable = 0;
  shortlist.forEach((venue, j) => {
    const column = travel.times.map((row) => row[j]);
    const stats = journeyStats(origins, column);
    if (!stats) { unavailable++; return; }
    const violations = limitViolations(origins, column, config);
    const cand = candidateOf.get(venue.providerPlaceId);
    const scored = scoreVenue(venue, stats, ctx);
    const entry = { venue, stats, violations, areaId: cand.area.id, area: cand.area, heuristics: cand.heuristics, ...scored };
    (violations.length ? overLimit : feasible).push(entry);
  });
  const byScore = (a, b) => a.score - b.score || a.venue.providerPlaceId.localeCompare(b.venue.providerPlaceId);
  feasible.sort(byScore);

  const toSuggestion = (e, rank, labels = []) => ({
    rank,
    venue: e.venue,
    area: { id: e.area.id, name: e.area.name },
    score: e.score,
    scoreBreakdown: e.breakdown,
    reasons: e.reasons,
    labels,
    travel: e.stats,
    sourceHeuristics: e.heuristics,
  });

  const common = { candidates: candidateSummary, excluded: { ...excluded, venuesRejected: filtered.rejected, journeysUnavailable: unavailable }, notes, cost: costs() };

  if (feasible.length === 0) {
    if (overLimit.length === 0) return empty('no_results', { reason: 'journeys_unavailable', ...common });
    const closest = overLimit.sort((a, b) => a.violations.length - b.violations.length || byScore(a, b)).slice(0, 3);
    return empty('no_results', {
      reason: 'no_venue_within_limits',
      closestMisses: closest.map((e, i) => ({ ...toSuggestion(e, i + 1), exceeds: e.violations })),
      ...common,
    });
  }

  // 6. Pick a varied few and label them.
  const picks = pickDiverse(feasible, { min: config.minSuggestions, max: config.maxSuggestions, minSeparationMeters: config.minPickSeparationMeters });
  const labels = labelPicks(picks);
  if (picks.some((e) => e.venue.openingHours === null)) notes.push("Opening hours weren't available for some suggestions, so check they are open before you go.");
  if (picks.length < config.minSuggestions) notes.push('Only a few good options fit everyone\'s limits.');

  return {
    heuristicsVersion: HEURISTICS_VERSION,
    status: 'ok',
    notes,
    suggestions: picks.map((e, i) => toSuggestion(e, i + 1, labels[i])),
    ...common,
    cost: costs(),
    meta: { eventType: event.eventType, startAt: event.startAt, participants: origins.length, candidateAreas: candidates.length, venuesFound: pool.length, venuesQualifying: filtered.kept.length, venuesCosted: shortlist.length },
  };
}
