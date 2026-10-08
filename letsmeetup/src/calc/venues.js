// Step 2: which venues are acceptable, and which few go forward to the (paid) routing matrix.

import { isOpenAt, minutesOpenFrom, londonWeekMinute } from '../hours.js';

// Providers return anything with a matching category (a "bar" search also returns hotels and
// cinemas), so we decide ourselves what counts as the right kind of place for the event.
const DRINK_TYPES = new Set(['pub', 'bar', 'cocktail_bar', 'wine_bar', 'gastropub', 'irish_pub', 'sports_bar', 'beer_garden', 'brewery', 'brewpub', 'lounge_bar', 'bar_and_grill']);
const LUNCH_EXTRA = new Set(['cafe', 'coffee_shop', 'bistro', 'sandwich_shop', 'bakery', 'brunch_restaurant', 'diner', 'gastropub', 'bar_and_grill']);
const DINNER_EXTRA = new Set(['bistro', 'steak_house', 'gastropub', 'bar_and_grill', 'diner']);

export function typeMatches(eventType, primaryType) {
  if (!primaryType) return false;
  const isRestaurant = primaryType === 'restaurant' || primaryType.endsWith('_restaurant');
  if (eventType === 'drinks') return DRINK_TYPES.has(primaryType);
  if (eventType === 'lunch') return isRestaurant || LUNCH_EXTRA.has(primaryType);
  if (eventType === 'dinner') return isRestaurant || DINNER_EXTRA.has(primaryType);
  return false;
}

// Closing time as minutes past local midnight of the start day: 01:30 the next morning is 1530,
// so "closes by 23:00 or later" is a plain comparison.
function closeMinuteOfDay(startAt, minutesOpen) {
  return (londonWeekMinute(startAt) % 1440) + minutesOpen;
}

export function isOpenLate(venue, startAt, openLate) {
  const open = minutesOpenFrom(venue.openingHours, startAt);
  if (open === null) return null;
  if (open === Infinity) return true;
  return open >= openLate.minMinutesAfterStart && closeMinuteOfDay(startAt, open) >= openLate.minCloseMinuteOfDay;
}

export function qualityScore(v) {
  return (v.rating ?? 0) * Math.log10((v.ratingCount ?? 0) + 10);
}

// Applies the hard filters and counts why venues were rejected.
// level 0: everything; level 1: tag filters become preferences; level 2: lower quality bar too.
export function filterVenues(venues, { eventType, tags, startAt, config }, level = 0) {
  const quality = level >= 2 ? config.relaxedQuality : config.quality;
  const rejected = { wrongType: 0, closed: 0, tag: 0, quality: 0 };
  const kept = [];
  for (const v of venues) {
    if (!typeMatches(eventType, v.primaryType)) { rejected.wrongType++; continue; }
    if (isOpenAt(v.openingHours, startAt) === false) { rejected.closed++; continue; } // never relaxed
    if ((v.rating ?? 0) < quality.minRating || (v.ratingCount ?? 0) < quality.minRatingCount) { rejected.quality++; continue; }
    if (level < 1) {
      if (tags.includes('outdoor_seating') && v.attributes.outdoorSeating !== true) { rejected.tag++; continue; }
      if (tags.includes('open_late') && isOpenLate(v, startAt, config.openLate) !== true) { rejected.tag++; continue; }
    }
    kept.push(v);
  }
  return { kept, rejected };
}

// Tries the strictest filters first and only relaxes when too few venues qualify.
export function filterWithRelaxation(venues, ctx) {
  const notes = [];
  let level = 0;
  let result = filterVenues(venues, ctx, 0);
  const hasTags = ctx.tags.includes('outdoor_seating') || ctx.tags.includes('open_late');
  while (result.kept.length < ctx.config.minVenues && level < 2) {
    level++;
    if (level === 1 && !hasTags) continue; // nothing to relax at this step
    result = filterVenues(venues, ctx, level);
    if (level === 1) notes.push('Few places matched every requirement, so some suggestions may not have ' + describeTags(ctx.tags) + '.');
    if (level === 2) notes.push('Few well-reviewed places were available nearby, so the review threshold was lowered.');
  }
  return { ...result, level, notes };
}

function describeTags(tags) {
  const names = tags.map((t) => ({ outdoor_seating: 'outdoor seating', open_late: 'late opening' }[t])).filter(Boolean);
  return names.join(' or ') || 'the requested extras';
}

// Picks up to `max` venues to cost routing for: spread across candidate areas (round robin, best
// first within each) so one busy area can't crowd out the others.
export function shortlistVenues(venuesByCandidate, max) {
  const queues = venuesByCandidate.map((list) => [...list].sort((a, b) => qualityScore(b) - qualityScore(a) || a.providerPlaceId.localeCompare(b.providerPlaceId)));
  const chosen = [];
  const seen = new Set();
  let progressed = true;
  while (chosen.length < max && progressed) {
    progressed = false;
    for (const q of queues) {
      while (q.length && seen.has(q[0].providerPlaceId)) q.shift();
      if (!q.length || chosen.length >= max) continue;
      const v = q.shift();
      seen.add(v.providerPlaceId);
      chosen.push(v);
      progressed = true;
    }
  }
  return chosen;
}
