import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGooglePlaces, normalisePlace, normaliseHours } from '../src/providers/places/google.js';
import { ProviderError } from '../src/providers/types.js';
import { createGoogleStub } from '../testing/google-stub.mjs';

const env = { GOOGLE_MAPS_API_KEY: 'SECRET-KEY-123' };
const noSleep = async () => {};
const center = { lat: 51.5045, lng: -0.0865 };

function make(stubOpts) {
  const stub = createGoogleStub(stubOpts);
  return { stub, places: createGooglePlaces({ env, fetch: stub.fetch, sleep: noSleep }) };
}

test('sends the right request: key header, minimal field mask, types and circle', async () => {
  const { stub, places } = make();
  await places.findVenues({ center, radiusMeters: 400, eventType: 'drinks', maxResults: 10 });
  const [call] = stub.calls;
  assert.equal(call.headers['x-goog-api-key'], 'SECRET-KEY-123');
  assert.match(call.headers['x-goog-fieldmask'], /places\.regularOpeningHours/);
  assert.doesNotMatch(call.headers['x-goog-fieldmask'], /reviews|photos|editorialSummary/); // fields we don't need cost more
  assert.deepEqual(call.body.includedTypes, ['bar', 'pub']);
  assert.equal(call.body.maxResultCount, 10);
  assert.deepEqual(call.body.locationRestriction.circle, { center: { latitude: 51.5045, longitude: -0.0865 }, radius: 400 });
});

test('event types map to place types', async () => {
  const { stub, places } = make();
  await places.findVenues({ center, eventType: 'lunch' });
  await places.findVenues({ center, eventType: 'dinner' });
  assert.deepEqual(stub.calls[0].body.includedTypes, ['restaurant', 'cafe']);
  assert.deepEqual(stub.calls[1].body.includedTypes, ['restaurant']);
});

test('returns normalised venues and a cost', async () => {
  const { places } = make();
  const { venues, cost } = await places.findVenues({ center, eventType: 'drinks', maxResults: 5 });
  assert.equal(venues.length, 5);
  assert.deepEqual(cost, { provider: 'google', requests: 1, elements: 0 });
  const v = venues[0];
  assert.equal(v.provider, 'google');
  assert.equal(typeof v.providerPlaceId, 'string');
  assert.equal(typeof v.rating, 'number');
  assert.ok(v.openingHours.periods.length > 0);
});

test('normalisePlace maps prices, unknown attributes and unusable records', () => {
  const base = { id: 'x', location: { latitude: 51.5, longitude: -0.1 }, displayName: { text: 'The Pub' } };
  assert.equal(normalisePlace({ ...base, priceLevel: 'PRICE_LEVEL_MODERATE' }).priceLevel, 2);
  assert.equal(normalisePlace({ ...base, priceLevel: 'PRICE_LEVEL_FREE' }).priceLevel, 0);
  assert.equal(normalisePlace(base).priceLevel, null);
  assert.equal(normalisePlace({ ...base, priceLevel: 'SOMETHING_NEW' }).priceLevel, null);

  const v = normalisePlace({ ...base, outdoorSeating: true, servesBeer: false });
  assert.deepEqual(v.attributes, { outdoorSeating: true, servesBeer: false, servesWine: null, goodForGroups: null, reservable: null });
  assert.equal(v.rating, null);
  assert.equal(v.openingHours, null);

  assert.equal(normalisePlace({ ...base, location: undefined }), null);
  assert.equal(normalisePlace({ displayName: { text: 'No id' }, location: base.location }), null);
  assert.equal(normalisePlace(null), null);
  assert.equal(normalisePlace({ id: 'y', location: base.location }).name, 'Unnamed place');
});

test('normaliseHours converts to minutes and handles 24 hour venues', () => {
  const h = normaliseHours({ periods: [{ open: { day: 4, hour: 11, minute: 30 }, close: { day: 5, hour: 0, minute: 0 } }] });
  assert.deepEqual(h, { periods: [{ open: { day: 4, minute: 690 }, close: { day: 5, minute: 0 } }] });
  assert.deepEqual(normaliseHours({ periods: [{ open: { day: 0, hour: 0, minute: 0 } }] }), { periods: [{ open: { day: 0, minute: 0 }, close: null }] });
  assert.equal(normaliseHours({ periods: [] }), null);
  assert.equal(normaliseHours(undefined), null);
});

test('retries transient failures and counts every attempt', async () => {
  const { stub, places } = make({ fail: [429, 503] });
  const { venues, cost } = await places.findVenues({ center, eventType: 'drinks', maxResults: 3 });
  assert.equal(venues.length, 3);
  assert.equal(cost.requests, 3);
  assert.equal(stub.calls.length, 3);
});

test('gives up after repeated failures, and errors never contain the key', async () => {
  const { places } = make({ fail: [500, 500, 500, 500] });
  await assert.rejects(places.findVenues({ center, eventType: 'drinks' }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.status, 500);
    assert.doesNotMatch(e.message, /SECRET-KEY-123/);
    return true;
  });
});

test('client errors are not retried', async () => {
  const { stub, places } = make({ fail: [400, 200] });
  await assert.rejects(places.findVenues({ center, eventType: 'drinks' }), ProviderError);
  assert.equal(stub.calls.length, 1);
});

test('validates arguments and requires a key', async () => {
  const { places } = make();
  await assert.rejects(places.findVenues({ center: { lat: NaN, lng: 0 }, eventType: 'drinks' }), TypeError);
  await assert.rejects(places.findVenues({ center, eventType: 'brunch' }), TypeError);
  await assert.rejects(places.findVenues({ center, eventType: 'drinks', radiusMeters: 0 }), RangeError);
  await assert.rejects(places.findVenues({ center, eventType: 'drinks', maxResults: 21 }), RangeError);
  assert.throws(() => createGooglePlaces({ env: {}, fetch: async () => {} }), (e) => e instanceof ProviderError && !/undefined/.test(e.message));
});
