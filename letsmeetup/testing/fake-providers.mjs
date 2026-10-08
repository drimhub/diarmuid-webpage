// Deterministic, offline providers that implement the same interfaces as the real ones
// (src/providers/types.js). Free and instant, so heuristics can be developed and tested without
// network or cost. Travel times come from straight-line distance and a per-mode speed.

const SPEEDS_KMH = { transit: 18, bike: 14, walk: 4.8 };
const TRANSIT_WAIT_S = 8 * 60;
const DETOUR = 1.3;

export function haversineKm(a, b) {
  const R = 6371, t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function fakeTravel(origin, dest, mode) {
  const km = haversineKm(origin, dest) * DETOUR;
  const durationS = Math.round((km / SPEEDS_KMH[mode]) * 3600 + (mode === 'transit' ? TRANSIT_WAIT_S : 0));
  return { status: 'ok', durationS, distanceM: Math.round(km * 1000) };
}

const TYPE_BY_EVENT = { drinks: 'pub', lunch: 'restaurant', dinner: 'restaurant' };
const allWeek = () => ({ periods: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ open: { day, minute: 11 * 60 }, close: { day, minute: 23 * 60 } })) });

// Venues on a ring around the centre; same centre always gives the same venues.
export function fakeVenuesAround(center, { radiusMeters = 500, eventType = 'drinks', maxResults = 20 } = {}) {
  const out = [];
  for (let i = 0; i < maxResults; i++) {
    const angle = (i / maxResults) * 2 * Math.PI;
    const r = (radiusMeters * 0.6) / 111320;
    out.push({
      provider: 'fake',
      providerPlaceId: `fake-${center.lat.toFixed(4)}-${center.lng.toFixed(4)}-${i}`,
      name: `Fake ${TYPE_BY_EVENT[eventType]} ${i + 1}`,
      address: `${i + 1} Test Street, London`,
      lat: center.lat + r * Math.sin(angle),
      lng: center.lng + (r * Math.cos(angle)) / Math.cos((center.lat * Math.PI) / 180),
      rating: Math.round((3.4 + (i % 4) * 0.4) * 10) / 10,
      ratingCount: 100 + i * 50,
      priceLevel: (i % 4) + 1,
      primaryType: TYPE_BY_EVENT[eventType],
      mapsUrl: `https://example.test/place/${i}`,
      openingHours: i % 5 === 4 ? null : allWeek(),
      attributes: {
        outdoorSeating: i % 2 === 0,
        servesBeer: true,
        servesWine: i % 3 === 0 ? true : null,
        goodForGroups: i % 2 === 1 ? true : null,
        reservable: i % 4 === 0,
      },
    });
  }
  return out;
}

export function createFakePlaces() {
  return {
    name: 'fake',
    async findVenues({ center, radiusMeters, eventType, maxResults = 20 }) {
      return { venues: fakeVenuesAround(center, { radiusMeters, eventType, maxResults }), cost: { provider: 'fake', requests: 1, elements: 0 } };
    },
  };
}

export function createFakeRouting() {
  return {
    name: 'fake',
    async getTravelTimes({ origins, destinations }) {
      for (const o of origins) if (!SPEEDS_KMH[o.mode]) throw new TypeError('each origin needs lat, lng and a valid mode');
      const times = origins.map((o) => destinations.map((d) => fakeTravel(o, d, o.mode)));
      return { times, cost: { provider: 'fake', requests: 1, elements: origins.length * destinations.length }, warnings: [] };
    },
  };
}
