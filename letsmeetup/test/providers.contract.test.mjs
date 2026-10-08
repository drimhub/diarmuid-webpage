// The provider contract: every implementation of the places and routing interfaces must pass
// these same tests. To add a provider (TravelTime, Foursquare, OSM, ...), add it to IMPLEMENTATIONS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, REGISTRY } from '../src/providers/index.js';
import { MemoryStore, recordingFetch, replayFetch } from '../src/providers/http.js';
import { ProviderError } from '../src/providers/types.js';
import { createGoogleStub } from '../testing/google-stub.mjs';
import { createFakePlaces, createFakeRouting } from '../testing/fake-providers.mjs';

const noSleep = async () => {};
const env = { GOOGLE_MAPS_API_KEY: 'k' };
const ARRIVE = '2026-10-08T18:30:00.000Z';

const IMPLEMENTATIONS = {
  'google (stubbed network)': () => createProviders(env, { fetch: createGoogleStub().fetch, sleep: noSleep }),
  'fake (offline)': () => ({ places: createFakePlaces(), routing: createFakeRouting() }),
  // Record a google run, then serve it back: the provider must behave the same from recordings.
  'google (replayed)': () => {
    const store = new MemoryStore();
    const recorder = createProviders(env, { fetch: recordingFetch(createGoogleStub().fetch, store), sleep: noSleep });
    const replayer = createProviders(env, { fetch: replayFetch(store), sleep: noSleep });
    return { warm: () => allContractCalls(recorder), ...replayer };
  },
};

const CENTER = { lat: 51.5045, lng: -0.0865 };
const ORIGINS = [
  { lat: 51.4613, lng: -0.1156, mode: 'transit' },
  { lat: 51.5565, lng: -0.1784, mode: 'transit' },
  { lat: 51.4699, lng: -0.0694, mode: 'bike' },
];

async function contractCalls(p) {
  const { venues } = await p.places.findVenues({ center: CENTER, radiusMeters: 500, eventType: 'drinks', maxResults: 6 });
  const destinations = venues.map((v) => ({ lat: v.lat, lng: v.lng }));
  const travel = await p.routing.getTravelTimes({ origins: ORIGINS, destinations, arriveBy: ARRIVE });
  return { venues, destinations, travel };
}

const DUP_ORIGIN = { lat: 51.46, lng: -0.12, mode: 'transit' };
const DUP_DESTS = [{ lat: 51.51, lng: -0.1 }, { lat: 51.52, lng: -0.09 }];

// Every provider call the contract makes, so a replay store can be warmed with exactly these.
async function allContractCalls(p) {
  await contractCalls(p);
  await p.routing.getTravelTimes({ origins: [DUP_ORIGIN, { ...DUP_ORIGIN }], destinations: DUP_DESTS, arriveBy: ARRIVE });
}

function assertVenue(v) {
  for (const k of ['provider', 'providerPlaceId', 'name']) assert.equal(typeof v[k], 'string', k);
  assert.ok(v.provider && v.providerPlaceId && v.name);
  assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lng));
  for (const k of ['rating', 'ratingCount', 'priceLevel']) assert.ok(v[k] === null || Number.isFinite(v[k]), k);
  if (v.rating !== null) assert.ok(v.rating >= 0 && v.rating <= 5);
  if (v.priceLevel !== null) assert.ok(Number.isInteger(v.priceLevel) && v.priceLevel >= 0 && v.priceLevel <= 4);
  for (const k of ['address', 'primaryType', 'mapsUrl']) assert.ok(v[k] === null || typeof v[k] === 'string', k);
  assert.deepEqual(Object.keys(v.attributes).sort(), ['goodForGroups', 'outdoorSeating', 'reservable', 'servesBeer', 'servesWine']);
  for (const val of Object.values(v.attributes)) assert.ok(val === null || typeof val === 'boolean');
  if (v.openingHours !== null) {
    assert.ok(Array.isArray(v.openingHours.periods) && v.openingHours.periods.length > 0);
    for (const p of v.openingHours.periods) {
      assert.ok(p.open.day >= 0 && p.open.day <= 6 && p.open.minute >= 0 && p.open.minute < 1440);
      assert.ok(p.close === null || (p.close.day >= 0 && p.close.day <= 6 && p.close.minute >= 0 && p.close.minute < 1440));
    }
  }
}

for (const [name, make] of Object.entries(IMPLEMENTATIONS)) {
  test(`contract: ${name}`, async (t) => {
    const impl = make();
    if (impl.warm) await impl.warm();
    const { places, routing } = impl;

    await t.test('findVenues returns normalised venues, capped at maxResults, with a cost', async () => {
      const { venues, cost } = await places.findVenues({ center: CENTER, radiusMeters: 500, eventType: 'drinks', maxResults: 6 });
      assert.ok(venues.length > 0 && venues.length <= 6);
      venues.forEach(assertVenue);
      assert.equal(typeof cost.provider, 'string');
      assert.ok(Number.isInteger(cost.requests) && cost.requests >= 1);
      assert.equal(new Set(venues.map((v) => v.providerPlaceId)).size, venues.length); // unique ids
    });

    await t.test('getTravelTimes returns an origins x destinations grid of travel times', async () => {
      const { destinations, travel } = await contractCalls({ places, routing });
      assert.equal(travel.times.length, ORIGINS.length);
      for (const row of travel.times) {
        assert.equal(row.length, destinations.length);
        for (const cell of row) {
          assert.ok(['ok', 'no_route', 'error'].includes(cell.status));
          if (cell.status === 'ok') {
            assert.ok(Number.isInteger(cell.durationS) && cell.durationS > 0);
            assert.ok(cell.distanceM === null || cell.distanceM >= 0);
          } else {
            assert.equal(cell.durationS, null);
          }
        }
      }
      assert.ok(Array.isArray(travel.warnings));
      assert.ok(travel.cost.requests >= 1 && travel.cost.elements >= 0);
    });

    await t.test('the same question gives the same answer', async () => {
      const a = await contractCalls({ places, routing });
      const b = await contractCalls({ places, routing });
      assert.deepEqual(a.venues, b.venues);
      assert.deepEqual(a.travel.times, b.travel.times);
    });

    await t.test('duplicate origins get identical rows', async () => {
      const { times } = await routing.getTravelTimes({ origins: [DUP_ORIGIN, { ...DUP_ORIGIN }], destinations: DUP_DESTS, arriveBy: ARRIVE });
      assert.deepEqual(times[0], times[1]);
    });

    await t.test('empty and invalid input', async () => {
      assert.deepEqual((await routing.getTravelTimes({ origins: [], destinations: [{ lat: 51.5, lng: -0.1 }] })).times, []);
      await assert.rejects(routing.getTravelTimes({ origins: [{ lat: 51.5, lng: -0.1, mode: 'teleport' }], destinations: [{ lat: 51.5, lng: -0.1 }] }), TypeError);
    });
  });
}

test('the registry rejects unknown providers and the default is google', () => {
  assert.throws(() => createProviders({ PLACES_PROVIDER: 'nope', GOOGLE_MAPS_API_KEY: 'k' }, { fetch: async () => {} }), (e) => e instanceof ProviderError && /nope/.test(e.message));
  const p = createProviders({ GOOGLE_MAPS_API_KEY: 'k' }, { fetch: async () => {} });
  assert.equal(p.places.name, 'google');
  assert.equal(p.routing.name, 'google');
  assert.deepEqual(Object.keys(REGISTRY).sort(), ['places', 'routing']);
});

test('a custom provider can be registered without touching business code', async () => {
  const registry = { places: { fake: () => createFakePlaces() }, routing: { fake: () => createFakeRouting() } };
  const p = createProviders({ PLACES_PROVIDER: 'fake', ROUTING_PROVIDER: 'fake' }, { registry });
  const { venues } = await p.places.findVenues({ center: CENTER, eventType: 'drinks', maxResults: 3 });
  assert.equal(venues[0].provider, 'fake');
});
