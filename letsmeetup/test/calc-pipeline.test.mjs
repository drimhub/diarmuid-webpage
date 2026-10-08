import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeSuggestions } from '../src/calc/index.js';
import { createProviders } from '../src/providers/index.js';
import { MemoryStore, recordingFetch, replayFetch } from '../src/providers/http.js';
import { createFakePlaces, createFakeRouting, fakeTravel } from '../testing/fake-providers.mjs';
import { createGoogleStub } from '../testing/google-stub.mjs';

const areas = JSON.parse(readFileSync(new URL('../public/areas.json', import.meta.url), 'utf8'));
const area = (id) => areas.find((a) => a.id === id);
const fakes = () => ({ places: createFakePlaces(), routing: createFakeRouting() });

const START = '2026-10-10T18:30:00.000Z'; // Sat 19:30 London
const event = (over = {}) => ({ eventType: 'drinks', startAt: START, tags: [], ...over });
const trio = () => [
  { id: 'diarmuid', areaId: 'stockwell', mode: 'transit', maxMinutes: null },
  { id: 'cian', areaId: 'blackfriars', mode: 'bike', maxMinutes: null },
  { id: 'friend', areaId: 'hampstead', mode: 'transit', maxMinutes: null },
];
const run = (over = {}) => computeSuggestions({ event: event(), participants: trio(), areas, providers: fakes(), ...over });

test('a realistic group gets 3-5 varied, well-explained suggestions', async () => {
  const r = await run();
  assert.equal(r.status, 'ok');
  assert.ok(r.suggestions.length >= 3 && r.suggestions.length <= 5);
  assert.deepEqual(r.suggestions.map((s) => s.rank), r.suggestions.map((_, i) => i + 1));
  for (let i = 1; i < r.suggestions.length; i++) assert.ok(r.suggestions[i - 1].score <= r.suggestions[i].score);
  assert.ok(new Set(r.suggestions.map((s) => s.area.id)).size >= 3, 'picks should come from different areas');
  assert.ok(r.suggestions.some((s) => s.labels.length > 0));

  for (const s of r.suggestions) {
    assert.equal(s.travel.perPerson.length, 3);
    assert.deepEqual(s.travel.perPerson.map((p) => p.participantId), ['diarmuid', 'cian', 'friend']);
    assert.ok(s.sourceHeuristics.length >= 1);
    assert.equal(typeof s.scoreBreakdown.travel, 'number');
    assert.equal(s.travel.furthest.minutes, s.travel.maxMinutes);
  }
  assert.ok(r.candidates.length >= 3);
  assert.equal(r.heuristicsVersion, '1');
});

test('the reported journeys are the provider\'s journeys, summarised correctly', async () => {
  const r = await run();
  const modes = { diarmuid: 'transit', cian: 'bike', friend: 'transit' };
  const home = { diarmuid: area('stockwell'), cian: area('blackfriars'), friend: area('hampstead') };
  for (const s of r.suggestions) {
    for (const p of s.travel.perPerson) {
      const expected = fakeTravel(home[p.participantId], s.venue, modes[p.participantId]).durationS / 60;
      assert.ok(Math.abs(p.minutes - expected) < 0.06, `${p.participantId}: ${p.minutes} vs ${expected}`);
    }
    const mins = s.travel.perPerson.map((p) => p.minutes);
    assert.ok(Math.abs(s.travel.totalMinutes - mins.reduce((a, b) => a + b, 0)) < 0.2);
    assert.equal(s.travel.maxMinutes, Math.max(...mins));
    assert.ok(Math.abs(s.travel.spreadMinutes - (Math.max(...mins) - Math.min(...mins))) < 0.2);
    assert.equal(s.travel.furthest.participantId, s.travel.perPerson.find((p) => p.minutes === s.travel.maxMinutes).participantId);
  }
});

test('the far-out friend is the one flagged as travelling furthest in most suggestions', async () => {
  const r = await run();
  const flagged = r.suggestions.filter((s) => s.travel.furthest.participantId === 'friend').length;
  assert.ok(flagged >= Math.ceil(r.suggestions.length / 2));
});

test('personal limits are always respected', async () => {
  const p = trio();
  p[2].maxMinutes = 40;
  const r = await run({ participants: p });
  assert.equal(r.status, 'ok');
  for (const s of r.suggestions) assert.ok(s.travel.perPerson.find((x) => x.participantId === 'friend').minutes <= 40);
});

test('impossible limits give an honest answer and the closest misses', async () => {
  const p = trio();
  p[0].maxMinutes = 10; p[2].maxMinutes = 10;
  const r = await run({ participants: p });
  assert.equal(r.status, 'no_results');
  assert.equal(r.reason, 'no_venue_within_limits');
  assert.equal(r.suggestions.length, 0);
  assert.ok(r.closestMisses.length > 0);
  assert.ok(r.closestMisses.every((m) => m.exceeds.length > 0 && m.exceeds.every((x) => x.minutes > x.limit)));
});

test('walkers are never sent on a long walk', async () => {
  const p = [{ id: 'a', areaId: 'stockwell', mode: 'walk', maxMinutes: null }, { id: 'b', areaId: 'hampstead', mode: 'transit', maxMinutes: null }];
  const r = await run({ participants: p });
  if (r.status === 'ok') for (const s of r.suggestions) assert.ok(s.travel.perPerson[0].minutes <= 45);
  else assert.equal(r.reason, 'no_venue_within_limits');
});

test('fewer than two located people: nothing to compromise on', async () => {
  const one = await run({ participants: [trio()[0]] });
  assert.equal(one.status, 'not_enough_people');
  const unlocated = await run({ participants: [trio()[0], { id: 'x', areaId: null, mode: 'transit', maxMinutes: null }] });
  assert.equal(unlocated.status, 'not_enough_people');
  assert.deepEqual(unlocated.excluded.participantsWithoutLocation, ['x']);
});

test('someone without a location is left out and the rest are planned for', async () => {
  const r = await run({ participants: [...trio(), { id: 'late', areaId: null, mode: 'transit', maxMinutes: null }] });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.excluded.participantsWithoutLocation, ['late']);
  assert.equal(r.suggestions[0].travel.perPerson.length, 3);
});

test('two people in the same neighbourhood still work', async () => {
  const r = await run({ participants: [{ id: 'a', areaId: 'blackfriars', mode: 'transit', maxMinutes: null }, { id: 'b', areaId: 'blackfriars', mode: 'bike', maxMinutes: null }] });
  assert.equal(r.status, 'ok');
  assert.ok(r.suggestions.every((s) => s.travel.maxMinutes < 25));
});

test('outdoor seating is honoured when enough places have it', async () => {
  const r = await run({ event: event({ tags: ['outdoor_seating'] }) });
  assert.equal(r.status, 'ok');
  assert.ok(r.suggestions.every((s) => s.venue.attributes.outdoorSeating === true));
  assert.deepEqual(r.notes, []);
  assert.ok(r.suggestions.every((s) => s.reasons.includes('outdoor_seating')));
});

test('open late: strict when possible, a note and a fallback when not', async () => {
  const ok = await run({ event: event({ tags: ['open_late'] }) }); // fake venues close at 23:00: 3.5h after 19:30
  assert.equal(ok.status, 'ok');
  assert.deepEqual(ok.notes, []);

  const tooLate = await run({ event: event({ startAt: '2026-10-10T21:30:00.000Z', tags: ['open_late'] }) }); // 22:30 start, they shut at 23:00
  assert.equal(tooLate.status, 'ok');
  assert.match(tooLate.notes.join(' '), /late opening/);
});

// Fake venues, but with opening hours known for all of them (some fakes deliberately have none).
function knownHoursPlaces() {
  const real = createFakePlaces();
  const week = { periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, minute: 660 }, close: { day, minute: 1380 } })) };
  return { name: 'known-hours', findVenues: async (a) => { const o = await real.findVenues(a); return { ...o, venues: o.venues.map((v) => ({ ...v, openingHours: v.openingHours || week })) }; } };
}

test('places with unknown opening hours are allowed but flagged to the user', async () => {
  const r = await run();
  assert.ok(r.suggestions.some((s) => s.venue.openingHours === null) || r.notes.length === 0);
  const unknownOnly = await run({ providers: { places: { name: 'unknown-hours', findVenues: async (a) => { const o = await createFakePlaces().findVenues(a); return { ...o, venues: o.venues.map((v) => ({ ...v, openingHours: null })) }; } }, routing: createFakeRouting() } });
  assert.equal(unknownOnly.status, 'ok');
  assert.match(unknownOnly.notes.join(' '), /Opening hours weren't available/);
  assert.ok(unknownOnly.suggestions.every((s) => s.scoreBreakdown.unknownHoursPenalty > 0));
});

test('nothing open at that time: a clear reason, and no paid routing call', async () => {
  const providers = { places: knownHoursPlaces(), routing: createFakeRouting() };
  let routed = 0;
  const routing = { ...providers.routing, getTravelTimes: async (a) => { routed++; return providers.routing.getTravelTimes(a); } };
  const r = await run({ providers: { places: providers.places, routing }, event: event({ startAt: '2026-10-10T03:00:00.000Z' }) }); // 04:00
  assert.equal(r.status, 'no_results');
  assert.equal(r.reason, 'no_venues_matched');
  assert.ok(r.excluded.venuesRejected.closed > 0);
  assert.equal(routed, 0);
});

test('lunch and dinner search for restaurants', async () => {
  for (const eventType of ['lunch', 'dinner']) {
    const r = await run({ event: event({ eventType }) });
    assert.equal(r.status, 'ok', eventType);
    assert.ok(r.suggestions.every((s) => s.venue.primaryType === 'restaurant'));
  }
});

test('the search widens once when too few venues are found, and costs are reported', async () => {
  const real = createFakePlaces();
  const radii = [];
  const places = { name: 'sparse', findVenues: async (a) => {
    radii.push(a.radiusMeters);
    const out = await real.findVenues(a);
    return a.radiusMeters < 800 ? { ...out, venues: out.venues.slice(0, 1) } : out; // sparse at 500m, plentiful at 900m
  } };
  const r = await run({ providers: { places, routing: createFakeRouting() } });
  assert.equal(r.status, 'ok');
  assert.deepEqual([...new Set(radii)], [500, 900]);
  assert.equal(r.cost.places.requests, radii.length);
  assert.equal(radii.length, 2 * r.candidates.length);
});

test('cost stays bounded: one routing call, at most people x shortlist elements', async () => {
  const r = await run();
  assert.equal(r.cost.routing.requests, 1);
  assert.ok(r.cost.routing.elements <= 3 * 15);
  assert.ok(r.cost.places.requests <= 6 * 2);
  assert.equal(r.meta.venuesCosted, r.cost.routing.elements / 3);
});

test('the result is plain JSON and deterministic', async () => {
  const a = await run();
  const b = await run();
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), a);
});

test('tuning: weighting fairness more changes which venue wins', async () => {
  const base = await run();
  const fair = await run({ config: { weights: { mean: 0.2, max: 0.2, spread: 5 } } });
  const spread = (r) => r.suggestions[0].travel.spreadMinutes;
  assert.ok(spread(fair) <= spread(base));
  assert.ok(fair.suggestions.every((s) => s.travel.spreadMinutes >= fair.suggestions[0].travel.spreadMinutes - 0.001 || s.rank > 1));
});

test('a provider failure surfaces instead of returning a half-answer', async () => {
  const routing = { name: 'broken', getTravelTimes: async () => { throw new Error('routing down'); } };
  await assert.rejects(run({ providers: { places: createFakePlaces(), routing } }), /routing down/);
});

test('journeys that cannot be calculated drop that venue, not the whole run', async () => {
  const real = createFakeRouting();
  const routing = { name: 'flaky', getTravelTimes: async (a) => {
    const out = await real.getTravelTimes(a);
    out.times[0][0] = { status: 'error', durationS: null, distanceM: null }; // first person, first venue
    return out;
  } };
  const r = await run({ providers: { places: createFakePlaces(), routing } });
  assert.equal(r.status, 'ok');
  assert.ok(r.excluded.journeysUnavailable >= 1);
});

test('the real Google providers, recorded and then replayed, give the identical result', async () => {
  const env = { GOOGLE_MAPS_API_KEY: 'k' };
  const noSleep = async () => {};
  const stub = createGoogleStub();
  const store = new MemoryStore();
  const live = await computeSuggestions({ event: event(), participants: trio(), areas, providers: createProviders(env, { fetch: recordingFetch(stub.fetch, store), sleep: noSleep }) });
  assert.equal(live.status, 'ok');
  const recorded = stub.calls.length;
  assert.ok(recorded >= 3);

  const replayed = await computeSuggestions({ event: event(), participants: trio(), areas, providers: createProviders({ GOOGLE_MAPS_API_KEY: 'other' }, { fetch: replayFetch(store), sleep: noSleep }) });
  assert.deepEqual(replayed, live);
  assert.equal(stub.calls.length, recorded); // the replay made no new calls
  assert.equal(live.cost.routing.requests, 2); // transit and bike are separate matrices
});
