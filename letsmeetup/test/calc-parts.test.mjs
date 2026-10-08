import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { centroid, geometricMedian, minimaxCentre, nearestAreas, haversineKm } from '../src/calc/geo.js';
import { DEFAULTS, withOverrides } from '../src/calc/config.js';
import { generateCandidateAreas } from '../src/calc/candidates.js';
import { typeMatches, filterVenues, filterWithRelaxation, isOpenLate, shortlistVenues } from '../src/calc/venues.js';
import { journeyStats, limitViolations, scoreVenue } from '../src/calc/score.js';
import { pickDiverse, labelPicks } from '../src/calc/select.js';
import { fakeVenuesAround } from '../testing/fake-providers.mjs';

const areas = JSON.parse(readFileSync(new URL('../public/areas.json', import.meta.url), 'utf8'));
const area = (id) => areas.find((a) => a.id === id);
const origin = (id, areaId, mode = 'transit', maxMinutes = null) => ({ id, lat: area(areaId).lat, lng: area(areaId).lng, mode, maxMinutes });
const km = (a, b) => haversineKm(a, b);

// ---------- geometry ----------

test('centroid and geometric median', () => {
  const a = { lat: 51.5, lng: -0.1 }, b = { lat: 51.5, lng: -0.2 };
  assert.ok(km(centroid([a, b]), { lat: 51.5, lng: -0.15 }) < 0.01);
  // Three points in a line: the median is the middle one (the centroid is not).
  const line = [{ lat: 51.5, lng: -0.30 }, { lat: 51.5, lng: -0.28 }, { lat: 51.5, lng: -0.10 }];
  assert.ok(km(geometricMedian(line), line[1]) < 0.05);
  assert.ok(km(centroid(line), line[1]) > 3);
  assert.deepEqual(geometricMedian([a]), a);
});

test('minimax centre: midpoint of two, and weights pull towards the heavier point', () => {
  const a = { lat: 51.50, lng: -0.30 }, b = { lat: 51.50, lng: -0.10 };
  const mid = minimaxCentre([a, b]);
  assert.ok(Math.abs(km(mid, a) - km(mid, b)) < 0.2);
  const w = minimaxCentre([a, b], [1, 3]); // b's distance counts 3x, so the centre sits nearer b
  assert.ok(km(w, b) < km(w, a));
  assert.ok(Math.abs(km(w, a) / km(w, b) - 3) < 0.15, `ratio ${km(w, a) / km(w, b)}`);
});

test('nearestAreas orders by distance', () => {
  const near = nearestAreas({ lat: 51.4613, lng: -0.1156 }, areas, 3);
  assert.equal(near[0].area.id, 'brixton');
  assert.ok(near[0].km <= near[1].km && near[1].km <= near[2].km);
});

// ---------- candidate areas ----------

test('candidate areas for a spread group: few, spaced, best first, explained', () => {
  const origins = [origin('a', 'stockwell'), origin('b', 'blackfriars', 'bike'), origin('c', 'hampstead')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS);
  assert.ok(c.length >= 3 && c.length <= DEFAULTS.maxCandidates);
  for (let i = 1; i < c.length; i++) assert.ok(c[i - 1].score <= c[i].score);
  for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) assert.ok(km(c[i].area, c[j].area) >= DEFAULTS.candidateSpacingKm);
  assert.ok(c.every((x) => x.heuristics.length >= 1));
  // Everything is between the extremes: nothing out in the suburbs.
  assert.ok(c.every((x) => x.estimate.max < 60));
});

test('time-weighting moves the centre towards the slower traveller', () => {
  const walker = { lat: 51.5, lng: -0.30, mode: 'walk' }, cyclist = { lat: 51.5, lng: -0.10, mode: 'bike' };
  const speed = DEFAULTS.estimate.speedKmh;
  const invSpeed = [1 / speed.walk, 1 / speed.bike];
  const t = minimaxCentre([walker, cyclist], invSpeed);
  assert.ok(km(t, walker) < km(t, cyclist), 'the walker should have the shorter trip');
});

test('everyone in one neighbourhood: that neighbourhood or a neighbour is chosen', () => {
  const origins = [origin('a', 'stockwell'), origin('b', 'stockwell', 'bike')];
  const c = generateCandidateAreas(origins, areas, DEFAULTS);
  assert.ok(c.some((x) => x.area.id === 'stockwell'));
  assert.ok(c.every((x) => x.estimate.max < 25));
});

test('a personal limit prunes unreachable candidates, but never to nothing', () => {
  const tight = [origin('a', 'stockwell', 'transit', 10), origin('b', 'hampstead')];
  const c = generateCandidateAreas(tight, areas, DEFAULTS);
  assert.ok(c.length > 0); // limit is impossible, so we fall back and let real journey times decide
  const loose = [origin('a', 'stockwell', 'transit', 40), origin('b', 'hampstead')];
  const c2 = generateCandidateAreas(loose, areas, DEFAULTS);
  assert.ok(c2.every((x) => x.estimate.times[0] <= 40 * DEFAULTS.candidateLimitSlack));
});

// ---------- venue filters ----------

test('place types per event type', () => {
  assert.ok(typeMatches('drinks', 'pub') && typeMatches('drinks', 'cocktail_bar'));
  assert.ok(!typeMatches('drinks', 'hotel') && !typeMatches('drinks', 'movie_theater') && !typeMatches('drinks', null));
  assert.ok(typeMatches('dinner', 'portuguese_restaurant') && typeMatches('dinner', 'steak_house'));
  assert.ok(!typeMatches('dinner', 'cafe') && typeMatches('lunch', 'cafe'));
  assert.ok(typeMatches('lunch', 'restaurant') && !typeMatches('lunch', 'pub'));
});

const START = '2026-10-08T18:30:00.000Z'; // Thu 19:30 London
const ctx = (over = {}) => ({ eventType: 'drinks', tags: [], startAt: START, config: DEFAULTS, ...over });
const venue = (over = {}) => ({ ...fakeVenuesAround({ lat: 51.5, lng: -0.1 }, { maxResults: 1 })[0], rating: 4.4, ratingCount: 500, ...over });
const hours = (open, close, day = 4) => ({ periods: [{ open: { day, minute: open * 60 }, close: { day: close < open ? day + 1 : day, minute: (close % 24) * 60 } }] });

test('filters: wrong type, closed, and quality are rejected with counts', () => {
  const vs = [venue({ providerPlaceId: 'ok' }), venue({ providerPlaceId: 'hotel', primaryType: 'hotel' }), venue({ providerPlaceId: 'closed', openingHours: hours(11, 18) }),
    venue({ providerPlaceId: 'low', rating: 3.2 }), venue({ providerPlaceId: 'few', ratingCount: 5 })];
  const { kept, rejected } = filterVenues(vs, ctx());
  assert.deepEqual(kept.map((v) => v.providerPlaceId), ['ok']);
  assert.deepEqual(rejected, { wrongType: 1, closed: 1, tag: 0, quality: 2 });
});

test('unknown opening hours are allowed (and penalised later), known-closed never', () => {
  assert.equal(filterVenues([venue({ openingHours: null })], ctx()).kept.length, 1);
  assert.equal(filterVenues([venue({ openingHours: hours(11, 18) })], ctx()).kept.length, 0);
});

test('open late and outdoor seating are hard filters first', () => {
  const late = venue({ providerPlaceId: 'late', openingHours: hours(11, 2) });
  const early = venue({ providerPlaceId: 'early', openingHours: hours(11, 22) });
  const always = venue({ providerPlaceId: 'always', openingHours: { periods: [{ open: { day: 0, minute: 0 }, close: null }] } });
  assert.equal(isOpenLate(late, START, DEFAULTS.openLate), true);
  assert.equal(isOpenLate(early, START, DEFAULTS.openLate), false);
  assert.equal(isOpenLate(always, START, DEFAULTS.openLate), true);
  assert.equal(isOpenLate(venue({ openingHours: null }), START, DEFAULTS.openLate), null);
  assert.deepEqual(filterVenues([late, early, always], ctx({ tags: ['open_late'] })).kept.map((v) => v.providerPlaceId), ['late', 'always']);

  const out = venue({ providerPlaceId: 'out', attributes: { ...venue().attributes, outdoorSeating: true } });
  const unknown = venue({ providerPlaceId: 'unk', attributes: { ...venue().attributes, outdoorSeating: null } });
  assert.deepEqual(filterVenues([out, unknown], ctx({ tags: ['outdoor_seating'] })).kept.map((v) => v.providerPlaceId), ['out']);
});

test('filters relax only when too few venues qualify, and say so', () => {
  const vs = Array.from({ length: 6 }, (_, i) => venue({ providerPlaceId: `v${i}`, attributes: { ...venue().attributes, outdoorSeating: i === 0 } }));
  const strict = filterWithRelaxation(vs, ctx({ tags: ['outdoor_seating'] }));
  assert.equal(strict.level, 1); // only 1 has outdoor seating (< minVenues 3), so tags became preferences
  assert.equal(strict.kept.length, 6);
  assert.match(strict.notes.join(' '), /outdoor seating/);

  const plenty = vs.map((v) => ({ ...v, attributes: { ...v.attributes, outdoorSeating: true } }));
  const ok = filterWithRelaxation(plenty, ctx({ tags: ['outdoor_seating'] }));
  assert.equal(ok.level, 0);
  assert.deepEqual(ok.notes, []);

  const meh = vs.map((v) => ({ ...v, rating: 3.6, ratingCount: 30 }));
  const relaxed = filterWithRelaxation(meh, ctx());
  assert.equal(relaxed.level, 2);
  assert.equal(relaxed.kept.length, 6);
  assert.match(relaxed.notes.join(' '), /review threshold/);
  // Closed venues are never let back in.
  assert.equal(filterWithRelaxation([venue({ openingHours: hours(11, 18) })], ctx()).kept.length, 0);
});

test('shortlist spreads across areas, dedupes and caps', () => {
  const mk = (area, n) => Array.from({ length: n }, (_, i) => venue({ providerPlaceId: `${area}${i}`, ratingCount: 1000 - i * 10 }));
  const groups = [mk('a', 10), mk('b', 2), mk('c', 10)];
  const s = shortlistVenues(groups, 7);
  assert.equal(s.length, 7);
  assert.deepEqual(s.slice(0, 3).map((v) => v.providerPlaceId[0]), ['a', 'b', 'c']); // one from each first
  assert.equal(new Set(s.map((v) => v.providerPlaceId)).size, 7);
  assert.equal(shortlistVenues([[venue({ providerPlaceId: 'x' })], [venue({ providerPlaceId: 'x' })]], 5).length, 1); // duplicate across areas
  assert.deepEqual(shortlistVenues([], 5), []);
});

// ---------- journeys and scoring ----------

const cell = (min, dist = 1000) => ({ status: 'ok', durationS: min * 60, distanceM: dist });
const trio = [origin('a', 'stockwell'), origin('b', 'blackfriars', 'bike'), origin('c', 'hampstead', 'walk', 30)];

test('journey stats: totals, spread and who travels furthest', () => {
  const s = journeyStats(trio, [cell(20), cell(10), cell(45)]);
  assert.equal(s.totalMinutes, 75);
  assert.equal(s.meanMinutes, 25);
  assert.equal(s.maxMinutes, 45);
  assert.equal(s.spreadMinutes, 35);
  assert.deepEqual(s.furthest, { participantId: 'c', minutes: 45, aboveMeanMinutes: 20 });
  assert.deepEqual(s.perPerson.map((p) => [p.participantId, p.mode, p.minutes]), [['a', 'transit', 20], ['b', 'bike', 10], ['c', 'walk', 45]]);
  assert.equal(journeyStats(trio, [cell(20), { status: 'no_route', durationS: null, distanceM: null }, cell(5)]), null);
});

test('limits: personal limits and hard caps per mode', () => {
  assert.deepEqual(limitViolations(trio, [cell(20), cell(10), cell(25)], DEFAULTS), []);
  const v = limitViolations(trio, [cell(20), cell(10), cell(35)], DEFAULTS); // c asked for 30
  assert.deepEqual(v, [{ participantId: 'c', minutes: 35, limit: 30, kind: 'personal' }]);
  const walkers = [origin('w', 'stockwell', 'walk')];
  assert.equal(limitViolations(walkers, [cell(50)], DEFAULTS)[0].kind, 'mode_cap'); // walking over 45 min is never suggested
  assert.equal(limitViolations([origin('t', 'stockwell')], [cell(119)], DEFAULTS).length, 0);
  assert.equal(limitViolations([origin('t', 'stockwell')], [cell(121)], DEFAULTS).length, 1);
});

test('scoring prefers fair journeys and trusted reviews', () => {
  const sctx = { config: DEFAULTS, tags: [], groupSize: 3, startAt: START };
  const even = journeyStats(trio, [cell(25), cell(25), cell(25)]);
  const uneven = journeyStats(trio, [cell(5), cell(5), cell(65)]); // same mean, one person has a long trip
  const v = venue();
  assert.ok(scoreVenue(v, even, sctx).score < scoreVenue(v, uneven, sctx).score);

  const trusted = scoreVenue(venue({ rating: 4.7, ratingCount: 3000 }), even, sctx).score;
  const unproven = scoreVenue(venue({ rating: 4.7, ratingCount: 30 }), even, sctx).score;
  const poor = scoreVenue(venue({ rating: 3.9, ratingCount: 3000 }), even, sctx).score;
  assert.ok(trusted < unproven && unproven < poor + 0.0001 || trusted < poor);
  assert.ok(trusted < unproven);
  assert.ok(poor > scoreVenue(venue({ rating: 4.0, ratingCount: 3000 }), even, sctx).score);

  assert.ok(scoreVenue(venue({ openingHours: null }), even, sctx).score > scoreVenue(venue(), even, sctx).score); // unverified hours cost something
});

test('tags and large groups adjust the score', () => {
  const stats = journeyStats(trio, [cell(25), cell(25), cell(25)]);
  const out = venue({ attributes: { ...venue().attributes, outdoorSeating: true } });
  const noOut = venue({ attributes: { ...venue().attributes, outdoorSeating: false } });
  const sctx = { config: DEFAULTS, tags: ['outdoor_seating'], groupSize: 3, startAt: START };
  assert.ok(scoreVenue(out, stats, sctx).score < scoreVenue(noOut, stats, sctx).score);
  assert.deepEqual(scoreVenue(out, stats, sctx).reasons, ['outdoor_seating']);

  const grp = venue({ attributes: { ...venue().attributes, goodForGroups: true, reservable: true } });
  const small = scoreVenue(grp, stats, { ...sctx, tags: [], groupSize: 3 });
  const big = scoreVenue(grp, stats, { ...sctx, tags: [], groupSize: 8 });
  assert.ok(big.score < small.score);
  assert.deepEqual(big.reasons, ['good_for_groups', 'reservable']);
});

// ---------- picking ----------

const ranked = (list) => list.map(([id, areaId, score, lat = 51.5, lng = -0.1, rating = 4.4, mean = 25, spread = 10, max = 30]) => ({
  venue: venue({ providerPlaceId: id, lat, lng, rating, ratingCount: 1000 }), areaId, score, stats: { meanMinutes: mean, spreadMinutes: spread, maxMinutes: max },
}));

test('picks come from different areas first, then fill up if needed', () => {
  const r = ranked([['a1', 'A', 40, 51.50, -0.10], ['a2', 'A', 41, 51.52, -0.10], ['b1', 'B', 45, 51.54, -0.10], ['c1', 'C', 50, 51.56, -0.10], ['a3', 'A', 51, 51.58, -0.10]]);
  const p = pickDiverse(r, { min: 3, max: 5, minSeparationMeters: 150 });
  assert.deepEqual(p.map((x) => x.venue.providerPlaceId), ['a1', 'b1', 'c1']); // a2 and a3 skipped: area A already has one

  const small = pickDiverse(ranked([['a1', 'A', 40, 51.50, -0.10], ['a2', 'A', 41, 51.52, -0.10], ['a3', 'A', 42, 51.54, -0.10]]), { min: 3, max: 5, minSeparationMeters: 150 });
  assert.equal(small.length, 3); // only one area exists, so variety gives way to having enough options
});

test('venues on top of each other are not both suggested', () => {
  const r = ranked([['x', 'A', 40, 51.5000, -0.1000], ['y', 'B', 41, 51.5003, -0.1000], ['z', 'C', 42, 51.52, -0.1]]);
  const p = pickDiverse(r, { min: 2, max: 5, minSeparationMeters: 150 });
  assert.deepEqual(p.map((x) => x.venue.providerPlaceId), ['x', 'z']);
});

test('labels name what each pick is best at, and only when it distinguishes', () => {
  const r = ranked([['a', 'A', 40, 51.50, -0.10, 4.2, 20, 30, 50], ['b', 'B', 41, 51.52, -0.10, 4.8, 30, 5, 32], ['c', 'C', 42, 51.54, -0.10, 4.4, 28, 12, 33]]);
  const labels = labelPicks(r);
  assert.deepEqual(labels[0].sort(), ['Quickest overall']);
  assert.ok(labels[1].includes('Fairest') && labels[1].includes('Shortest longest journey') && labels[1].includes('Best rated'));
  assert.deepEqual(labels[2], []);
  const same = ranked([['a', 'A', 40, 51.50, -0.10], ['b', 'B', 41, 51.52, -0.10]]);
  assert.deepEqual(labelPicks(same), [[], []]); // identical stats: nothing to award
  assert.deepEqual(labelPicks(ranked([['a', 'A', 40]])), [[]]);
});

test('config overrides merge deeply without touching the defaults', () => {
  const c = withOverrides(DEFAULTS, { weights: { spread: 5 }, maxSuggestions: 4 });
  assert.equal(c.weights.spread, 5);
  assert.equal(c.weights.mean, DEFAULTS.weights.mean);
  assert.equal(c.maxSuggestions, 4);
  assert.equal(DEFAULTS.weights.spread, 0.3);
});
