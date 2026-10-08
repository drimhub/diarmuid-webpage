// Google Routes API computeRouteMatrix -> normalised travel times. Everything Google-specific about
// routing lives here, including the request-size limits:
//   - TRANSIT: at most 100 elements (origins x destinations) per request
//   - other modes: at most 625
// Callers ask for the whole matrix; this module de-duplicates identical origins (people in the same
// neighbourhood cost nothing extra) and splits the rest into requests that respect the caps.
// Billing is per element, so de-duplication is also a cost saving.

import { googlePost, requireKey } from '../google-http.js';
import { ProviderError, TRAVEL_MODES } from '../types.js';

const ENDPOINT = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const FIELD_MASK = 'originIndex,destinationIndex,status,condition,duration,distanceMeters';

const GOOGLE_MODE = { transit: 'TRANSIT', bike: 'BICYCLE', walk: 'WALK' };
const MAX_ELEMENTS = { transit: 100, bike: 625, walk: 625 };

const waypoint = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
const errorCell = () => ({ status: 'error', durationS: null, distanceM: null });

// One element of Google's response -> TravelTime.
export function normaliseElement(el) {
  if (!el) return errorCell();
  if (el.status && Number(el.status.code) !== 0 && el.status.code !== undefined) return errorCell();
  if (el.condition === 'ROUTE_NOT_FOUND') return { status: 'no_route', durationS: null, distanceM: null };
  if (el.condition !== 'ROUTE_EXISTS') return errorCell();
  const durationS = typeof el.duration === 'string' ? parseInt(el.duration.replace(/s$/, ''), 10) : NaN;
  if (!Number.isFinite(durationS)) return errorCell();
  return { status: 'ok', durationS, distanceM: Number.isFinite(el.distanceMeters) ? el.distanceMeters : null };
}

// Splits origins x destinations into chunks of at most `cap` elements.
export function planChunks(originCount, destCount, cap) {
  const oSize = Math.min(originCount, cap);
  const dSize = Math.max(1, Math.floor(cap / oSize));
  const chunks = [];
  for (let o = 0; o < originCount; o += oSize) {
    for (let d = 0; d < destCount; d += dSize) {
      chunks.push({ o, d, oCount: Math.min(oSize, originCount - o), dCount: Math.min(dSize, destCount - d) });
    }
  }
  return chunks;
}

export function createGoogleRouting({ env, fetch: fetchImpl = fetch, sleep, now = () => Date.now() }) {
  const apiKey = requireKey(env);

  return {
    name: 'google',

    async getTravelTimes({ origins, destinations, arriveBy, departAt }) {
      if (!Array.isArray(origins) || !Array.isArray(destinations)) throw new TypeError('origins and destinations must be arrays');
      for (const o of origins) {
        if (!Number.isFinite(o.lat) || !Number.isFinite(o.lng) || !TRAVEL_MODES.includes(o.mode)) throw new TypeError('each origin needs lat, lng and a valid mode');
      }
      for (const d of destinations) if (!Number.isFinite(d.lat) || !Number.isFinite(d.lng)) throw new TypeError('each destination needs lat and lng');

      const cost = { provider: 'google', requests: 0, elements: 0 };
      const warnings = [];
      if (origins.length === 0 || destinations.length === 0) return { times: origins.map(() => destinations.map(errorCell)), cost, warnings };

      // Unique (mode, lat, lng) origins, remembering which input rows share each.
      const keyOf = (o) => `${o.mode}|${o.lat}|${o.lng}`;
      const unique = new Map(); // key -> { mode, lat, lng, row: TravelTime[] }
      for (const o of origins) {
        const k = keyOf(o);
        if (!unique.has(k)) unique.set(k, { mode: o.mode, lat: o.lat, lng: o.lng, row: destinations.map(errorCell) });
      }

      // Time handling: transit is the only mode that depends on the clock.
      let timeField = null;
      const wanted = arriveBy ? ['arrivalTime', arriveBy] : departAt ? ['departureTime', departAt] : null;
      if (wanted) {
        const ms = Date.parse(wanted[1]);
        if (!Number.isFinite(ms)) throw new TypeError('arriveBy/departAt must be an ISO time');
        if (ms > now()) timeField = { [wanted[0]]: new Date(ms).toISOString() };
        else warnings.push('The requested time is in the past, so transit times use current conditions.');
      }

      const requests = [];
      for (const mode of TRAVEL_MODES) {
        const group = [...unique.values()].filter((u) => u.mode === mode);
        if (!group.length) continue;
        for (const c of planChunks(group.length, destinations.length, MAX_ELEMENTS[mode])) {
          requests.push({ mode, group, chunk: c });
        }
      }

      await Promise.all(requests.map(async ({ mode, group, chunk }) => {
        const o = group.slice(chunk.o, chunk.o + chunk.oCount);
        const d = destinations.slice(chunk.d, chunk.d + chunk.dCount);
        const body = { origins: o.map(waypoint), destinations: d.map(waypoint), travelMode: GOOGLE_MODE[mode] };
        if (mode === 'transit' && timeField) Object.assign(body, timeField);

        const { data, attempts } = await googlePost({ fetch: fetchImpl, sleep, apiKey, url: ENDPOINT, fieldMask: FIELD_MASK, body });
        cost.requests += attempts;
        cost.elements += o.length * d.length;
        if (!Array.isArray(data)) throw new ProviderError('Unexpected Routes response', { provider: 'google' });

        // Elements arrive in no particular order; index them explicitly.
        for (const el of data) {
          if (!Number.isInteger(el.originIndex) || !Number.isInteger(el.destinationIndex)) continue;
          const row = o[el.originIndex];
          if (!row || el.destinationIndex >= d.length || el.destinationIndex < 0) continue;
          row.row[chunk.d + el.destinationIndex] = normaliseElement(el);
        }
      }));

      const failed = [...unique.values()].some((u) => u.row.some((c) => c.status === 'error'));
      if (failed) warnings.push('Some journeys could not be calculated.');

      return { times: origins.map((o) => unique.get(keyOf(o)).row.map((c) => ({ ...c }))), cost, warnings };
    },
  };
}
