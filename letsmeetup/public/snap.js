// On-device neighbourhood snapping. Everything here runs in the browser: the user's exact
// location or postcode is turned into an area from areas.json, and ONLY the area id is ever sent
// to our server. Pure functions are exported so they can be tested in Node (npm test).

// Rough Greater London envelope, and how far from the nearest area anchor we still accept.
export const LONDON_BOUNDS = { south: 51.28, north: 51.70, west: -0.52, east: 0.34 };
export const MAX_SNAP_KM = 4;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, t = Math.PI / 180;
  const dLat = (lat2 - lat1) * t, dLng = (lng2 - lng1) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export function inLondon(lat, lng) {
  const b = LONDON_BOUNDS;
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east;
}

// Nearest area to a point, or null if it is outside London / too far from any area.
export function snapToArea(lat, lng, areas) {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat + lng)) return null;
  if (!inLondon(lat, lng)) return null;
  let best = null;
  let bestKm = Infinity;
  for (const a of areas) {
    const d = haversineKm(lat, lng, a.lat, a.lng);
    if (d < bestKm) { bestKm = d; best = a; }
  }
  return best && bestKm <= MAX_SNAP_KM ? { area: best, distanceKm: bestKm } : null;
}

const fold = (s) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

// Type-ahead over area names: prefix matches first, then word-prefix, then substring.
export function searchAreas(query, areas, limit = 6) {
  const q = fold(query || '');
  if (!q) return [];
  const scored = [];
  for (const a of areas) {
    const n = fold(a.name);
    let score = -1;
    if (n.startsWith(q)) score = 0;
    else if (n.split(' ').some((w) => w.startsWith(q))) score = 1;
    else if (n.includes(q)) score = 2;
    if (score >= 0) scored.push({ a, score });
  }
  scored.sort((x, y) => x.score - y.score || x.a.name.localeCompare(y.a.name));
  return scored.slice(0, limit).map((s) => s.a);
}

const POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2}$/i;
const OUTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?$/i;

export function looksLikePostcode(text) {
  const t = (text || '').trim();
  return POSTCODE_RE.test(t) || OUTCODE_RE.test(t);
}

// Postcode (or outcode like "E8") -> { lat, lng } via postcodes.io (free, no key, CORS-enabled).
// The postcode goes to postcodes.io, not to our server.
export async function lookupPostcode(text, fetchImpl = fetch) {
  const t = text.trim().toUpperCase().replace(/\s+/g, '');
  const path = POSTCODE_RE.test(text.trim()) ? 'postcodes' : 'outcodes';
  const res = await fetchImpl(`https://api.postcodes.io/${path}/${encodeURIComponent(t)}`);
  if (!res.ok) return null;
  const { result } = await res.json();
  return result && typeof result.latitude === 'number' ? { lat: result.latitude, lng: result.longitude } : null;
}

export function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Location is not available on this device'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => reject(new Error(e.code === 1 ? 'Location permission was denied' : 'Could not get your location')),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  });
}

export async function loadAreas(url = '/areas.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not load areas');
  return res.json();
}
