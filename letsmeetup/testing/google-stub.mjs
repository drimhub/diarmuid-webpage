// A fake Google: a fetch() that answers Places and Routes requests with synthetic, Google-shaped
// responses (not real Google data, so it is safe to commit). It enforces Google's element caps and
// returns matrix elements in reverse order, as the real API returns them unordered, so provider
// code that assumes ordering fails here.

import { fakeTravel, fakeVenuesAround } from './fake-providers.mjs';

const PRICE_NAME = ['PRICE_LEVEL_FREE', 'PRICE_LEVEL_INEXPENSIVE', 'PRICE_LEVEL_MODERATE', 'PRICE_LEVEL_EXPENSIVE', 'PRICE_LEVEL_VERY_EXPENSIVE'];
const MODE = { TRANSIT: 'transit', BICYCLE: 'bike', WALK: 'walk' };

function toGooglePlace(v) {
  const p = {
    id: v.providerPlaceId,
    displayName: { text: v.name, languageCode: 'en' },
    location: { latitude: v.lat, longitude: v.lng },
    formattedAddress: v.address,
    primaryType: v.primaryType,
    googleMapsUri: v.mapsUrl,
    rating: v.rating,
    userRatingCount: v.ratingCount,
    priceLevel: PRICE_NAME[v.priceLevel],
  };
  if (v.openingHours) {
    p.regularOpeningHours = {
      openNow: true,
      periods: v.openingHours.periods.map((x) => ({
        open: { day: x.open.day, hour: Math.floor(x.open.minute / 60), minute: x.open.minute % 60 },
        close: { day: x.close.day, hour: Math.floor(x.close.minute / 60), minute: x.close.minute % 60 },
      })),
    };
  }
  for (const [k, val] of Object.entries(v.attributes)) if (val !== null) p[k] = val; // Google omits unknowns
  return p;
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// `fail`: statuses to return, in order, before behaving normally (e.g. [429, 503]).
// `breakCells`: "originIdx:destIdx" cells to report as errors; `noRoute`: cells with ROUTE_NOT_FOUND.
export function createGoogleStub({ fail = [], breakCells = [], noRoute = [] } = {}) {
  const calls = [];
  const queue = [...fail];

  async function stubFetch(url, init = {}) {
    const body = JSON.parse(init.body || '{}');
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url: String(url), headers, body });

    if (queue.length) return json(queue.shift(), { error: { code: 0, message: 'stub failure' } });
    if (!headers['x-goog-api-key']) return json(403, { error: { message: 'API key missing' } });

    if (String(url).includes('places.googleapis.com')) {
      const c = body.locationRestriction.circle;
      const venues = fakeVenuesAround({ lat: c.center.latitude, lng: c.center.longitude }, {
        radiusMeters: c.radius,
        eventType: body.includedTypes.includes('bar') ? 'drinks' : 'lunch',
        maxResults: body.maxResultCount,
      });
      return json(200, { places: venues.map(toGooglePlace) });
    }

    if (String(url).includes('routes.googleapis.com')) {
      const mode = MODE[body.travelMode];
      const o = body.origins.map((x) => x.waypoint.location.latLng);
      const d = body.destinations.map((x) => x.waypoint.location.latLng);
      const cap = mode === 'transit' ? 100 : 625;
      if (o.length * d.length > cap) return json(400, { error: { message: `Too many elements for ${body.travelMode}` } });

      const elements = [];
      for (let i = 0; i < o.length; i++) {
        for (let j = 0; j < d.length; j++) {
          const base = { originIndex: i, destinationIndex: j, status: {} };
          if (breakCells.includes(`${i}:${j}`)) { elements.push({ ...base, status: { code: 13 } }); continue; }
          if (noRoute.includes(`${i}:${j}`)) { elements.push({ ...base, condition: 'ROUTE_NOT_FOUND' }); continue; }
          const t = fakeTravel({ lat: o[i].latitude, lng: o[i].longitude }, { lat: d[j].latitude, lng: d[j].longitude }, mode);
          elements.push({ ...base, distanceMeters: t.distanceM, duration: `${t.durationS}s`, condition: 'ROUTE_EXISTS' });
        }
      }
      return json(200, elements.reverse());
    }
    return json(404, { error: { message: 'unknown url' } });
  }

  return { fetch: stubFetch, calls };
}
