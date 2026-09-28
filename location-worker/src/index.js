// Cloudflare Worker — GET/POST /api/location
// Requires a D1 database bound as LOCATION_DB, and a secret LOCATION_SECRET
// (see wrangler.toml + `wrangler secret put LOCATION_SECRET`).

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/location') {
      return new Response('Not found', { status: 404, headers: CORS_HEADERS });
    }

    if (request.method === 'POST') {
      const token = request.headers.get('X-Auth-Token');
      if (!env.LOCATION_SECRET || token !== env.LOCATION_SECRET) {
        return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return new Response('Invalid JSON', { status: 400, headers: CORS_HEADERS });
      }

      const { lat, long } = body;
      if (typeof lat !== 'number' || typeof long !== 'number') {
        return new Response('Expected JSON body { lat, long }', {
          status: 400,
          headers: CORS_HEADERS,
        });
      }

      const timestamp = new Date().toISOString();
      await env.LOCATION_DB
        .prepare('INSERT INTO locations (timestamp, lat, long) VALUES (?, ?, ?)')
        .bind(timestamp, lat, long)
        .run();
      return new Response('OK', { status: 200, headers: CORS_HEADERS });
    }

    if (request.method === 'GET') {
      const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 500, 2000);
      const { results } = await env.LOCATION_DB
        .prepare('SELECT timestamp, lat, long FROM locations ORDER BY timestamp DESC LIMIT ?')
        .bind(limit)
        .all();
      results.reverse();
      return new Response(JSON.stringify(results), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
  },
};
