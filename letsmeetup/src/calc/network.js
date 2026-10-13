// Network knowledge for choosing where to look: a precomputed table of how long transit takes between
// every pair of neighbourhoods (see NETWORK-CANDIDATES.md). It is only a RANKER of areas to search:
// the numbers users see always come from the live routing call. This file only reads the table, so
// whatever built it (TfL today, anything later) can change without touching the heuristics.
//
// Table values are minutes of time on the network (end walks removed), 0-253, plus two sentinels.

import TABLE_JSON from '../data/transit-times.json' with { type: 'json' };

export const WALK_ONLY = 254;    // close enough to walk: no transit leg once the end walks are removed
export const UNREACHABLE = 255;  // no journey found
export const MAX_MINUTES = 253;

// Ties the table to the exact areas.json (ids and coordinates). Not a security hash: cyrb53 is plenty
// to notice that an anchor moved, and it works synchronously in the Worker and in Node.
export function anchorsHash(areas) {
  const text = [...areas].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((a) => `${a.id}|${a.lat}|${a.lng}`).join('\n');
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export function encodeMinutes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function decodeMinutes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Builds the JSON for a table. `bytes` is the n x n matrix, row = from, column = to, in `areas` order.
export function makeTable({ areas, bytes, source, basis, builtAt, attribution = 'Contains TfL Open Data. Powered by TfL Open Data.' }) {
  const n = areas.length;
  if (bytes.length !== n * n) throw new Error('matrix size does not match the areas');
  return { format: 1, source, basis, builtAt, anchorsHash: anchorsHash(areas), areas: areas.map((a) => a.id), minutes: encodeMinutes(bytes), attribution };
}

// Returns { source, basis, minutes(fromId, toId) } or null if the table is missing, stale or corrupt.
// minutes() gives 0-253, WALK_ONLY, UNREACHABLE, or null for an id the table doesn't know.
export function createNetwork(json, areas) {
  try {
    if (!json || json.format !== 1 || !Array.isArray(json.areas) || !json.areas.length) return null;
    if (json.anchorsHash !== anchorsHash(areas) || json.areas.length !== areas.length) return null;
    const bytes = decodeMinutes(json.minutes);
    const n = json.areas.length;
    if (bytes.length !== n * n) return null;
    const index = new Map(json.areas.map((id, i) => [id, i]));
    if (!areas.every((a) => index.has(a.id))) return null;
    return {
      source: json.source,
      basis: json.basis,
      minutes(fromId, toId) {
        const i = index.get(fromId), j = index.get(toId);
        return i === undefined || j === undefined ? null : bytes[i * n + j];
      },
    };
  } catch {
    return null;
  }
}

let cached = null;
// The bundled table, decoded once per isolate. null when it is absent or doesn't match `areas`:
// callers then fall back to geometry alone, never an error.
export function loadTransitTable(areas) {
  if (!cached || cached.areas !== areas) cached = { areas, network: createNetwork(TABLE_JSON, areas) };
  return cached.network;
}
