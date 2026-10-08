// letsmeetup.diarmu.id — Worker entry. Static files come from ./public via the ASSETS binding;
// only /api/* reaches this code (see wrangler.toml run_worker_first).
// Needs: D1 binding DB, vars GOOGLE_CLIENT_ID and TURNSTILE_SITE_KEY, secret TURNSTILE_SECRET.
// See README.md.

import {
  createSession,
  destroySession,
  getSessionUser,
  upsertUser,
  verifyGoogleIdToken,
} from './auth.js';
import { handleEvents } from './events.js';
import { error, json, readJson } from './util.js';

// Cookie-authenticated writes must come from our own pages: custom header (can't be set
// cross-site without a CORS preflight, which we never grant) plus a matching Origin.
function isSameSiteWrite(request, url) {
  if (request.headers.get('X-Requested-With') !== 'letsmeetup') return false;
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (method !== 'GET' && method !== 'HEAD' && !isSameSiteWrite(request, url)) {
      return error('Forbidden', 403);
    }

    try {
      if (pathname === '/api/config' && method === 'GET') {
        return json({ googleClientId: env.GOOGLE_CLIENT_ID, turnstileSiteKey: env.TURNSTILE_SITE_KEY });
      }

      if (pathname === '/api/me' && method === 'GET') {
        const user = await getSessionUser(request, env.DB, url);
        return json({ user: user && { id: user.id, name: user.name, avatarUrl: user.avatar_url } });
      }

      if (pathname === '/api/auth/google' && method === 'POST') {
        const body = await readJson(request);
        if (!body) return error('Invalid JSON', 400);
        let claims;
        try {
          claims = await verifyGoogleIdToken(body.credential, env.GOOGLE_CLIENT_ID);
        } catch {
          return error('Sign-in failed', 401);
        }
        const user = await upsertUser(env.DB, claims);
        const cookie = await createSession(env.DB, user.id, url);
        return json({ user: { id: user.id, name: user.name } }, 200, { 'Set-Cookie': cookie });
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        const cookie = await destroySession(request, env.DB, url);
        return json({ ok: true }, 200, { 'Set-Cookie': cookie });
      }

      if (pathname === '/api/events' || pathname.startsWith('/api/events/')) {
        const user = await getSessionUser(request, env.DB, url);
        if (!user) return error('Please sign in', 401);
        return handleEvents(request, env, url, user, ctx);
      }

      return error('Not found', 404);
    } catch (e) {
      console.error('letsmeetup error', e);
      return error('Server error', 500);
    }
  },
};
