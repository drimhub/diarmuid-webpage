// Google spike: makes a handful of real Places + Routes calls for a London test scenario,
// saves the raw responses to ../fixtures/ (git-ignored: Google content), and prints a summary.
// Purpose: (1) get real data to replay offline for heuristic tuning, (2) find out which SKUs the
// calls bill under (check Cloud Console -> Billing -> Reports, group by SKU, the next day),
// (3) answer open questions (does the matrix accept arrivalTime? how does bike/transit behave?).
//
// Usage (from letsmeetup/):   npm run spike:dry        PREVIEW: prints the requests, no network (use this first)
//                             npm run spike            REAL calls, ~6 requests, ~60 matrix elements (costs pennies)
//                             (npm can swallow `-- --dry` in PowerShell, so use the spike:dry script or SPIKE_DRY=1)
// Key: GOOGLE_MAPS_API_KEY in letsmeetup/.dev.vars (or the environment).
//
// Everything Google-specific lives in this file / future src/providers/*; see ../CLAUDE.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', 'fixtures');
const dry = process.argv.includes('--dry') || process.env.SPIKE_DRY === '1';

function loadKey() {
  if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;
  const file = join(here, '..', '.dev.vars');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*GOOGLE_MAPS_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/);
    if (m) return m[1];
  }
  return null;
}

// Test scenario: four friends, a venue search around roughly the middle of them.
const ORIGINS = [
  { name: 'Peckham', lat: 51.4699, lng: -0.0694, mode: 'TRANSIT' },
  { name: 'Hampstead', lat: 51.5565, lng: -0.1784, mode: 'TRANSIT' },
  { name: 'Canary Wharf', lat: 51.5054, lng: -0.0235, mode: 'TRANSIT' },
  { name: 'Brixton', lat: 51.4627, lng: -0.1145, mode: 'BICYCLE' },
];
const SEARCH_CENTRE = { latitude: 51.5045, longitude: -0.0865 }; // around London Bridge
const SEARCH_RADIUS_M = 500;
const MAX_DESTINATIONS = 5;

// Tomorrow 17:00 UTC (18:00 London while on BST), always in the future as the API requires.
const departure = new Date();
departure.setUTCDate(departure.getUTCDate() + 1);
departure.setUTCHours(17, 0, 0, 0);
const DEPARTURE_TIME = departure.toISOString();

const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';

// Pro-tier fields only vs the full set we'd want. Two calls so the billing report shows
// whether the field mask really changes the SKU.
const PLACES_MASK_PRO = ['places.id', 'places.displayName', 'places.location'];
const PLACES_MASK_FULL = [
  ...PLACES_MASK_PRO,
  'places.formattedAddress',
  'places.primaryType',
  'places.googleMapsUri',
  'places.rating',
  'places.userRatingCount',
  'places.priceLevel',
  'places.regularOpeningHours',
  'places.outdoorSeating',
  'places.servesBeer',
  'places.goodForGroups',
  'places.reservable',
];
const MATRIX_MASK = 'originIndex,destinationIndex,status,condition,duration,distanceMeters';

const ledger = []; // one entry per real request, for the cost summary

async function call(label, url, mask, body, key) {
  if (dry) {
    console.log(`\n[dry] ${label}\n  POST ${url}\n  X-Goog-FieldMask: ${mask}\n  ${JSON.stringify(body)}`);
    return null;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  ledger.push({ label, status: res.status });
  mkdirSync(FIXTURES, { recursive: true });
  const file = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.json';
  writeFileSync(join(FIXTURES, file), JSON.stringify({ request: body, status: res.status, response: data }, null, 2));
  if (!res.ok) console.log(`  ! ${label}: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  return { ok: res.ok, status: res.status, data };
}

const waypoint = (o) => ({ waypoint: { location: { latLng: { latitude: o.lat, longitude: o.lng } } } });

function nearbyBody() {
  return {
    includedTypes: ['bar', 'pub'],
    maxResultCount: 20,
    rankPreference: 'POPULARITY',
    locationRestriction: { circle: { center: SEARCH_CENTRE, radius: SEARCH_RADIUS_M } },
  };
}

function matrixBody(origins, destinations, travelMode, extra = {}) {
  return {
    origins: origins.map(waypoint),
    destinations: destinations.map(waypoint),
    travelMode,
    ...extra,
  };
}

const seconds = (d) => (d ? parseInt(String(d).replace('s', ''), 10) : null);
const mins = (s) => (s == null ? '  - ' : String(Math.round(s / 60)).padStart(3) + 'm');

async function main() {
  const key = loadKey();
  console.log(`Google key: ${key ? 'found' : 'NOT FOUND'}${dry ? ' (dry run)' : ''}`);
  if (!key && !dry) {
    console.log('Put GOOGLE_MAPS_API_KEY=... in letsmeetup/.dev.vars, then rerun.');
    process.exit(1);
  }
  console.log(`Departure time used for matrices: ${DEPARTURE_TIME}`);

  // 1+2. Nearby search, cheap fields then full fields.
  const nearbyPro = await call('nearby-pro-fields', NEARBY_URL, PLACES_MASK_PRO.join(','), nearbyBody(), key);
  const nearbyFull = await call('nearby-full-fields', NEARBY_URL, PLACES_MASK_FULL.join(','), nearbyBody(), key);

  let venues = (nearbyFull?.data?.places || []).slice(0, MAX_DESTINATIONS);
  if (dry) venues = Array.from({ length: MAX_DESTINATIONS }, (_, i) => ({ displayName: { text: `venue${i}` }, location: { latitude: 51.5, longitude: -0.09 } }));
  if (!venues.length) {
    console.log('No venues returned; stopping before the matrix calls.');
    process.exit(dry ? 0 : 1);
  }
  const dests = venues.map((v) => ({ lat: v.location.latitude, lng: v.location.longitude }));
  const destNames = venues.map((v) => v.displayName?.text || '?');
  console.log(`\nVenues (${nearbyFull?.data?.places?.length ?? '?'} found in ${SEARCH_RADIUS_M}m, using ${venues.length}):`);
  venues.forEach((v, i) =>
    console.log(
      `  ${i}. ${destNames[i]}  rating ${v.rating ?? '-'} (${v.userRatingCount ?? '-'})  ` +
        `outdoor=${v.outdoorSeating ?? '-'} beer=${v.servesBeer ?? '-'} hours=${v.regularOpeningHours ? 'yes' : 'no'}`,
    ),
  );

  // 3-5. One matrix per mode: everyone's travel time to each venue.
  const results = {};
  for (const mode of ['TRANSIT', 'BICYCLE', 'WALK']) {
    const extra = mode === 'TRANSIT' ? { departureTime: DEPARTURE_TIME } : {};
    const r = await call(`matrix-${mode.toLowerCase()}`, MATRIX_URL, MATRIX_MASK, matrixBody(ORIGINS, dests, mode, extra), key);
    results[mode] = r;
  }

  // 6. Probe: does the matrix accept arrivalTime (what we'd prefer for "be there at 7")?
  const arrival = new Date(departure.getTime() + 60 * 60 * 1000).toISOString();
  const probe = await call(
    'matrix-transit-arrivaltime-probe',
    MATRIX_URL,
    MATRIX_MASK,
    matrixBody(ORIGINS.slice(0, 1), dests.slice(0, 1), 'TRANSIT', { arrivalTime: arrival }),
    key,
  );

  if (dry) return;

  console.log('\nTravel times (rows = people, cols = venues). Every person is run through every mode here, to compare:');
  for (const mode of ['TRANSIT', 'BICYCLE', 'WALK']) {
    const r = results[mode];
    console.log(`\n  ${mode}${r?.ok ? '' : `  (failed, HTTP ${r?.status})`}`);
    if (!r?.ok || !Array.isArray(r.data)) continue;
    const grid = ORIGINS.map(() => dests.map(() => null));
    for (const el of r.data) {
      if (el.originIndex != null && el.destinationIndex != null) grid[el.originIndex][el.destinationIndex] = seconds(el.duration);
    }
    ORIGINS.forEach((o, i) => console.log(`    ${o.name.padEnd(13)} ${grid[i].map(mins).join(' ')}`));
  }

  console.log(`\narrivalTime on matrix: ${probe?.ok ? 'ACCEPTED' : `rejected (HTTP ${probe?.status}) ${JSON.stringify(probe?.data).slice(0, 200)}`}`);

  console.log(`\nRequests made: ${ledger.length} (${ledger.map((l) => `${l.label}=${l.status}`).join(', ')})`);
  console.log('Matrix elements billed (approx): ' + (ORIGINS.length * dests.length * 3 + 1));
  console.log('Raw responses saved in letsmeetup/fixtures/ (git-ignored).');
  console.log('Tomorrow: Cloud Console -> Billing -> Reports, group by SKU, to see which SKUs these hit.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
