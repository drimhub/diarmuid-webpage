// letsmeetup.diarmu.id — Worker entry. Static files come from ./public via the ASSETS binding;
// only /api/* reaches this code (see wrangler.toml run_worker_first).
// Needs: D1 binding DB, var GOOGLE_CLIENT_ID. See README.md.

import {
  createSession,
  destroySession,
  getSessionUser,
  upsertUser,
  verifyGoogleIdToken,
} from './auth.js';

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

// Cookie-authenticated writes must come from our own pages: custom header (can't be set
// cross-site without a CORS preflight, which we never grant) plus a matching Origin.
function isSameSiteWrite(request, url) {
  if (request.headers.get('X-Requested-With') !== 'letsmeetup') return false;
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (!pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (method !== 'GET' && method !== 'HEAD' && !isSameSiteWrite(request, url)) {
      return json({ error: 'Forbidden' }, 403);
    }

    try {
      if (pathname === '/api/config' && method === 'GET') {
        return json({ googleClientId: env.GOOGLE_CLIENT_ID });
      }

      if (pathname === '/api/me' && method === 'GET') {
        const user = await getSessionUser(request, env.DB, url);
        return json({ user: user && { id: user.id, name: user.name, avatarUrl: user.avatar_url } });
      }

      if (pathname === '/api/auth/google' && method === 'POST') {
        let body;
        try {
          body = await request.json();
        } catch {
          return json({ error: 'Invalid JSON' }, 400);
        }
        let claims;
        try {
          claims = await verifyGoogleIdToken(body.credential, env.GOOGLE_CLIENT_ID);
        } catch (e) {
          return json({ error: 'Sign-in failed' }, 401);
        }
        const user = await upsertUser(env.DB, claims);
        const cookie = await createSession(env.DB, user.id, url);
        return json({ user: { id: user.id, name: user.name } }, 200, { 'Set-Cookie': cookie });
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        const cookie = await destroySession(request, env.DB, url);
        return json({ ok: true }, 200, { 'Set-Cookie': cookie });
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error('letsmeetup error', e);
      return json({ error: 'Server error' }, 500);
    }
  },
};
