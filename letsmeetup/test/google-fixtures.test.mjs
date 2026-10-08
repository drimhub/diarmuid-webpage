// Runs the real Google responses recorded by `npm run spike` through our normalisers. The recordings
// are git-ignored (Google content), so these tests skip on a fresh clone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGooglePlaces } from '../src/providers/places/google.js';
import { createGoogleRouting } from '../src/providers/routing/google.js';
import { isOpenAt } from '../src/hours.js';

const dir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const load = (name) => JSON.parse(readFileSync(dir + name, 'utf8'));
const has = ['nearby-full-fields.json', 'matrix-transit.json', 'matrix-bicycle.json'].every((f) => existsSync(dir + f));
const skip = has ? false : 'no spike fixtures (run `npm run spike` to record them)';

const env = { GOOGLE_MAPS_API_KEY: 'k' };
const serve = (data) => async () => new Response(JSON.stringify(data), { status: 200 });

test('real Places response normalises into usable venues', { skip }, async () => {
  const fx = load('nearby-full-fields.json');
  const places = createGooglePlaces({ env, fetch: serve(fx.response) });
  const { venues } = await places.findVenues({ center: { lat: 51.5045, lng: -0.0865 }, eventType: 'drinks' });

  assert.equal(venues.length, fx.response.places.length); // nothing silently dropped
  for (const v of venues) {
    assert.ok(v.providerPlaceId && v.name && Number.isFinite(v.lat));
    assert.ok(v.rating === null || (v.rating >= 0 && v.rating <= 5));
    assert.ok(v.openingHours === null || v.openingHours.periods.length > 0);
  }
  assert.ok(venues.some((v) => v.attributes.outdoorSeating === true));
  assert.ok(venues.some((v) => v.priceLevel !== null));
  // 24 hour venues have a period with no close; make sure that survived normalisation.
  assert.equal(venues.some((v) => v.openingHours && v.openingHours.periods.some((p) => p.close === null)), fx.response.places.some((p) => p.regularOpeningHours && p.regularOpeningHours.periods.some((x) => !x.close)));
  // Thursday 19:30 London: most places that serve drinks should be open.
  const open = venues.filter((v) => isOpenAt(v.openingHours, '2026-10-08T18:30:00Z'));
  assert.ok(open.length >= venues.length / 2, `only ${open.length}/${venues.length} open on a Thursday evening`);
});

for (const [file, mode] of [['matrix-transit.json', 'transit'], ['matrix-bicycle.json', 'bike']]) {
  test(`real ${mode} matrix response normalises into a complete grid`, { skip }, async () => {
    const fx = load(file);
    const routing = createGoogleRouting({ env, fetch: serve(fx.response) });
    const origins = fx.request.origins.map((o) => ({ lat: o.waypoint.location.latLng.latitude, lng: o.waypoint.location.latLng.longitude, mode }));
    const destinations = fx.request.destinations.map((d) => ({ lat: d.waypoint.location.latLng.latitude, lng: d.waypoint.location.latLng.longitude }));
    const { times } = await routing.getTravelTimes({ origins, destinations });
    assert.equal(times.length, origins.length);
    for (const row of times) {
      assert.equal(row.length, destinations.length);
      for (const cell of row) {
        assert.equal(cell.status, 'ok');
        assert.ok(cell.durationS > 60 && cell.durationS < 3 * 3600);
      }
    }
  });
}
