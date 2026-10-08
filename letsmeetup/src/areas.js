// Server-side view of the area list (same file the browser snaps against, bundled by Wrangler).
// Clients send only an area id; coordinates always come from here, never from the request.

import AREAS_JSON from '../public/areas.json' with { type: 'json' };

export const AREAS = AREAS_JSON;

const BY_ID = new Map(AREAS_JSON.map((a) => [a.id, a]));

export function getArea(id) {
  return typeof id === 'string' ? BY_ID.get(id) || null : null;
}
