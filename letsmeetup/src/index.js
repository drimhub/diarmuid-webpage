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
import { deleteAccount } from './account.js';
import { handleEvents } from './events.js';
import { limited } from './ratelimit.js';
import { runRetention } from './retention.js';
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
        const tooMany = await limited(env, 'auth', request.headers.get('CF-Connecting-IP') || 'unknown');
        if (tooMany) return tooMany;
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

      if (pathname === '/api/me' && method === 'DELETE') {
        const user = await getSessionUser(request, env.DB, url);
        if (!user) return error('Please sign in', 401);
        const tooMany = await limited(env, 'deleteAccount', user.id);
        if (tooMany) return tooMany;
        await deleteAccount(env.DB, user.id);
        console.log(JSON.stringify({ event: 'account_deleted' }));
        return json({ ok: true }, 200, { 'Set-Cookie': await destroySession(request, env.DB, url) });
      }

      if (pathname === '/api/events' || pathname.startsWith('/api/events/')) {
        const user = await getSessionUser(request, env.DB, url);
        if (!user) return error('Please sign in', 401);
        return await handleEvents(request, env, url, user, ctx); // await: so errors reach the catch below
      }

      return error('Not found', 404);
    } catch (e) {
      // One structured line per failure (no cookies, bodies or tokens), readable with `wrangler tail`.
      console.error(JSON.stringify({ event: 'unhandled_error', method, path: pathname, error: e && e.name, message: e && String(e.message).slice(0, 300) }));
      return error('Server error', 500);
    }
  },

  // Daily clean-up (Cron Trigger in wrangler.toml).
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runRetention(env));
  },
};
