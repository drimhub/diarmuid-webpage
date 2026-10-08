// Fixed-window rate limits kept in D1. These stop one account or address hammering the writes that
// cost money or create data; for volumetric abuse use Cloudflare's own rate-limiting rules too (see
// the launch checklist in the README). Reads (including the results poll) are not limited here.

import { error } from './util.js';

export const RATE_RULES = {
  auth:          { limit: 20, windowSeconds: 600 },   // per IP: Google sign-in attempts
  createEvent:   { limit: 6,  windowSeconds: 600 },   // per user
  join:          { limit: 30, windowSeconds: 600 },   // per user
  calculate:     { limit: 5,  windowSeconds: 600 },   // per user
  calculateDaily: { limit: 12, windowSeconds: 86400 }, // per user: one account can't use up the whole service's daily budget
  mutate:        { limit: 90, windowSeconds: 600 },   // per user: every non-GET request to /api/events
  deleteAccount: { limit: 3,  windowSeconds: 3600 },  // per user
};

// Counts one hit. Returns { ok: true } or { ok: false, retryAfter } once the window's limit is used.
export async function hit(db, key, limit, windowSeconds, nowMs = Date.now()) {
  const nowS = Math.floor(nowMs / 1000);
  const window = Math.floor(nowS / windowSeconds);
  const expiresAt = (window + 1) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window, count, expires_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (key, window) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(key, window, expiresAt, limit)
    .first();
  return row ? { ok: true } : { ok: false, retryAfter: Math.max(1, expiresAt - nowS) };
}

// Returns a 429 Response when the named rule is exhausted for `id`, otherwise null.
export async function limited(env, rule, id, nowMs) {
  if (env.RATE_LIMITS_OFF === '1') return null; // local development and tests only
  const { limit, windowSeconds } = RATE_RULES[rule];
  const r = await hit(env.DB, `${rule}:${id}`, limit, windowSeconds, nowMs);
  return r.ok ? null : error('Too many requests, please slow down and try again shortly.', 429, { 'Retry-After': String(r.retryAfter) });
}
