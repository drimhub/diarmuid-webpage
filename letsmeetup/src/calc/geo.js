// Small geometry helpers for choosing where to look. At London scale (~50 km) a local flat
// projection is accurate to well under 1%, which is plenty for picking candidate areas.

export function haversineKm(a, b) {
  const R = 6371, t = Math.PI / 180;
  const dLat = (b.lat - a.lat) * t, dLng = (b.lng - a.lng) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Local projection around a reference point: x east, y north, both in km.
function projector(points) {
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng0 = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.57;
  return {
    to: (p) => ({ x: (p.lng - lng0) * kx, y: (p.lat - lat0) * ky }),
    from: (q) => ({ lat: lat0 + q.y / ky, lng: lng0 + q.x / kx }),
  };
}

export function centroid(points) {
  return { lat: points.reduce((s, p) => s + p.lat, 0) / points.length, lng: points.reduce((s, p) => s + p.lng, 0) / points.length };
}

// Weighted geometric median (Weiszfeld): the point minimising sum(w_i * distance_i).
export function geometricMedian(points, weights = points.map(() => 1)) {
  if (points.length === 1) return { ...points[0] };
  const proj = projector(points);
  const q = points.map(proj.to);
  let c = { x: 0, y: 0 };
  let wsum = weights.reduce((s, w) => s + w, 0);
  c = { x: q.reduce((s, p, i) => s + p.x * weights[i], 0) / wsum, y: q.reduce((s, p, i) => s + p.y * weights[i], 0) / wsum };
  for (let iter = 0; iter < 200; iter++) {
    let nx = 0, ny = 0, d = 0;
    for (let i = 0; i < q.length; i++) {
      const dist = Math.max(Math.hypot(q[i].x - c.x, q[i].y - c.y), 1e-9);
      const w = weights[i] / dist;
      nx += q[i].x * w; ny += q[i].y * w; d += w;
    }
    const next = { x: nx / d, y: ny / d };
    const moved = Math.hypot(next.x - c.x, next.y - c.y);
    c = next;
    if (moved < 1e-7) break;
  }
  return proj.from(c);
}

// Weighted minimax centre: the point minimising max(w_i * distance_i), by the Badoiu-Clarkson
// iteration (move a shrinking step towards whichever weighted distance is currently largest).
export function minimaxCentre(points, weights = points.map(() => 1)) {
  if (points.length === 1) return { ...points[0] };
  const proj = projector(points);
  const q = points.map(proj.to);
  let c = { x: q.reduce((s, p) => s + p.x, 0) / q.length, y: q.reduce((s, p) => s + p.y, 0) / q.length };
  for (let k = 1; k <= 1000; k++) {
    let far = 0, farD = -1;
    for (let i = 0; i < q.length; i++) {
      const d = weights[i] * Math.hypot(q[i].x - c.x, q[i].y - c.y);
      if (d > farD) { farD = d; far = i; }
    }
    // Step towards the farthest point, scaled so the weighted distances equalise.
    const step = 1 / (k + 1);
    c = { x: c.x + (q[far].x - c.x) * step, y: c.y + (q[far].y - c.y) * step };
  }
  return proj.from(c);
}

// The `k` areas whose anchors are nearest to a point, nearest first, with their distances in km.
export function nearestAreas(point, areas, k) {
  return areas
    .map((a) => ({ area: a, km: haversineKm(point, a) }))
    .sort((x, y) => x.km - y.km || x.area.id.localeCompare(y.area.id))
    .slice(0, k);
}
