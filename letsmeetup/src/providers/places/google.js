// Google Places API (New) -> normalised Venues. Everything Google-specific about venues lives here.
// Billing note: Places bills per request at the highest SKU tier of any field requested, and one
// Nearby Search returns up to 20 places, so we ask for every field we use in a single request.
// Fields: rating/openingHours = Enterprise tier; outdoorSeating/servesBeer/... = Enterprise + Atmosphere.

import { googlePost, requireKey } from '../google-http.js';
import { EVENT_TYPES, ProviderError } from '../types.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';

const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.location', 'places.formattedAddress', 'places.primaryType',
  'places.googleMapsUri', 'places.rating', 'places.userRatingCount', 'places.priceLevel',
  'places.regularOpeningHours', 'places.outdoorSeating', 'places.servesBeer', 'places.servesWine',
  'places.goodForGroups', 'places.reservable',
].join(',');

const INCLUDED_TYPES = {
  drinks: ['bar', 'pub'],
  lunch: ['restaurant', 'cafe'],
  dinner: ['restaurant'],
};

const PRICE = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

const bool = (v) => (typeof v === 'boolean' ? v : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function normaliseHours(raw) {
  const periods = raw && Array.isArray(raw.periods) ? raw.periods : null;
  if (!periods || periods.length === 0) return null;
  const out = [];
  for (const p of periods) {
    if (!p || !p.open || typeof p.open.day !== 'number') continue;
    const open = { day: p.open.day, minute: (p.open.hour || 0) * 60 + (p.open.minute || 0) };
    const close = p.close && typeof p.close.day === 'number'
      ? { day: p.close.day, minute: (p.close.hour || 0) * 60 + (p.close.minute || 0) }
      : null; // Google omits `close` for places open 24 hours
    out.push({ open, close });
  }
  return out.length ? { periods: out } : null;
}

// Returns a Venue, or null if Google's record is unusable (no id or no location).
export function normalisePlace(p) {
  if (!p || typeof p.id !== 'string' || !p.location || !Number.isFinite(p.location.latitude) || !Number.isFinite(p.location.longitude)) return null;
  return {
    provider: 'google',
    providerPlaceId: p.id,
    name: (p.displayName && p.displayName.text) || 'Unnamed place',
    address: typeof p.formattedAddress === 'string' ? p.formattedAddress : null,
    lat: p.location.latitude,
    lng: p.location.longitude,
    rating: num(p.rating),
    ratingCount: num(p.userRatingCount),
    priceLevel: p.priceLevel in PRICE ? PRICE[p.priceLevel] : null,
    primaryType: typeof p.primaryType === 'string' ? p.primaryType : null,
    mapsUrl: typeof p.googleMapsUri === 'string' ? p.googleMapsUri : null,
    openingHours: normaliseHours(p.regularOpeningHours),
    attributes: {
      outdoorSeating: bool(p.outdoorSeating),
      servesBeer: bool(p.servesBeer),
      servesWine: bool(p.servesWine),
      goodForGroups: bool(p.goodForGroups),
      reservable: bool(p.reservable),
    },
  };
}

export function createGooglePlaces({ env, fetch: fetchImpl = fetch, sleep }) {
  const apiKey = requireKey(env);
  return {
    name: 'google',

    async findVenues({ center, radiusMeters = 500, eventType, maxResults = 20 }) {
      if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lng)) throw new TypeError('center must be {lat, lng}');
      if (!Number.isFinite(radiusMeters) || radiusMeters < 1 || radiusMeters > 5000) throw new RangeError('radiusMeters must be 1-5000');
      if (!EVENT_TYPES.includes(eventType)) throw new TypeError(`Unknown eventType: ${eventType}`);
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) throw new RangeError('maxResults must be 1-20');

      const { data, attempts } = await googlePost({
        fetch: fetchImpl, sleep, apiKey, url: ENDPOINT, fieldMask: FIELD_MASK,
        body: {
          includedTypes: INCLUDED_TYPES[eventType],
          maxResultCount: maxResults,
          rankPreference: 'POPULARITY',
          locationRestriction: { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: radiusMeters } },
        },
      });
      if (!data || typeof data !== 'object') throw new ProviderError('Unexpected Places response', { provider: 'google' });

      const venues = (Array.isArray(data.places) ? data.places : []).map(normalisePlace).filter(Boolean);
      return { venues, cost: { provider: 'google', requests: attempts, elements: 0 } };
    },
  };
}
