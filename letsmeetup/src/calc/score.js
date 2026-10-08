// Step 3: turn journey times into a score, and a human summary of the journeys.
// All scores are in "minutes" (lower is better): journey cost minus small quality bonuses.

import { isOpenLate } from './venues.js';

const minutes = (cell) => cell.durationS / 60;

// People's journeys to one venue. `row` is that venue's column of the routing grid (one cell per
// participant, same order as `origins`). Returns null if any journey is unavailable.
export function journeyStats(origins, row) {
  if (row.some((c) => c.status !== 'ok')) return null;
  const mins = row.map(minutes);
  const total = mins.reduce((s, m) => s + m, 0);
  const max = Math.max(...mins);
  const min = Math.min(...mins);
  const mean = total / mins.length;
  const furthestIdx = mins.indexOf(max);
  return {
    perPerson: origins.map((o, i) => ({ participantId: o.id, mode: o.mode, minutes: round1(mins[i]), distanceM: row[i].distanceM })),
    totalMinutes: round1(total),
    meanMinutes: round1(mean),
    maxMinutes: round1(max),
    spreadMinutes: round1(max - min),
    furthest: { participantId: origins[furthestIdx].id, minutes: round1(max), aboveMeanMinutes: round1(max - mean) },
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

// Which people would be pushed past their own limit or the hard cap for their mode?
export function limitViolations(origins, row, config) {
  const out = [];
  origins.forEach((o, i) => {
    const m = minutes(row[i]);
    const cap = Math.min(o.maxMinutes ?? Infinity, config.maxJourneyMinutes[o.mode]);
    if (m > cap) out.push({ participantId: o.id, minutes: round1(m), limit: cap, kind: o.maxMinutes != null && o.maxMinutes <= config.maxJourneyMinutes[o.mode] ? 'personal' : 'mode_cap' });
  });
  return out;
}

export function scoreVenue(venue, stats, ctx) {
  const { config, tags, groupSize, startAt } = ctx;
  const w = config.weights;
  const travel = w.mean * stats.meanMinutes + w.max * stats.maxMinutes + w.spread * stats.spreadMinutes;

  // Reviews: a 4.7 with thousands of reviews beats a 4.7 with fifty; below the baseline it costs.
  const q = config.quality_bonus;
  const trust = Math.min(1, (venue.ratingCount ?? 0) / q.fullTrustReviews);
  const quality = (venue.rating == null ? 0 : (venue.rating - q.baselineRating) * q.minutesPerStar * trust);

  let bonuses = 0;
  const reasons = [];
  if (tags.includes('outdoor_seating')) {
    if (venue.attributes.outdoorSeating === true) { bonuses += config.bonuses.outdoorSeating; reasons.push('outdoor_seating'); }
    else bonuses -= config.penalties.tagUnmet;
  }
  if (tags.includes('open_late')) {
    if (isOpenLate(venue, startAt, config.openLate) === true) reasons.push('open_late');
    else bonuses -= config.penalties.tagUnmet;
  }
  if (groupSize >= config.largeGroupSize) {
    if (venue.attributes.goodForGroups === true) { bonuses += config.bonuses.goodForGroups; reasons.push('good_for_groups'); }
    if (venue.attributes.reservable === true) { bonuses += config.bonuses.reservable; reasons.push('reservable'); }
  }

  const unknownHours = venue.openingHours === null ? config.penalties.unknownHours : 0;
  const score = travel - quality - bonuses + unknownHours;
  return {
    score: round1(score),
    breakdown: { travel: round1(travel), quality: round1(quality), bonuses: round1(bonuses), unknownHoursPenalty: unknownHours },
    reasons,
  };
}
