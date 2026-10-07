// Google Sign-In verification and cookie sessions.
// Sessions are random tokens; only their SHA-256 is stored in D1, so they can be revoked
// and a database leak can't be replayed. The cookie is host-only (no Domain attribute).

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const SESSION_DAYS = 30;

let jwksCache = { keys: null, fetchedAt: 0 };

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseJson(bytes) {
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function getGoogleKeys(force = false) {
  const fresh = Date.now() - jwksCache.fetchedAt < 60 * 60 * 1000;
  if (jwksCache.keys && fresh && !force) return jwksCache.keys;
  const res = await fetch(GOOGLE_JWKS_URL);
  if (!res.ok) throw new Error('Could not fetch Google signing keys');
  const { keys } = await res.json();
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

// Verifies a Google ID token (RS256) and returns its claims, or throws.
export async function verifyGoogleIdToken(idToken, clientId) {
  if (typeof idToken !== 'string') throw new Error('Missing credential');
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, s] = parts;
  const header = parseJson(b64urlToBytes(h));
  if (header.alg !== 'RS256') throw new Error('Unexpected algorithm');

  let keys = await getGoogleKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getGoogleKeys(true); // keys may have rotated
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('Unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!ok) throw new Error('Bad signature');

  const claims = parseJson(b64urlToBytes(p));
  const now = Math.floor(Date.now() / 1000);
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new Error('Wrong issuer');
  if (claims.aud !== clientId) throw new Error('Wrong audience');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('Token expired');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('No subject');
  if (!claims.email || claims.email_verified !== true) throw new Error('Email not verified');
  return claims;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(byteLength = 32) {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

// `__Host-` needs HTTPS, so plain-http local dev falls back to an unprefixed name.
function cookieName(url) {
  return url.protocol === 'https:' ? '__Host-lm_session' : 'lm_session';
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function upsertUser(db, claims) {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name,
         avatar_url = excluded.avatar_url`,
    )
    .bind(claims.sub, claims.email, claims.name || claims.email, claims.picture || null, now)
    .run();
  return { id: claims.sub, email: claims.email, name: claims.name || claims.email };
}

// Creates a session and returns the Set-Cookie header value.
export async function createSession(db, userId, url) {
  const token = randomToken();
  const now = Date.now();
  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(
      await sha256Hex(token),
      userId,
      new Date(now).toISOString(),
      new Date(now + SESSION_DAYS * 86400 * 1000).toISOString(),
    )
    .run();
  // Opportunistic cleanup so the table doesn't grow forever.
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date(now).toISOString()).run();

  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(url)}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

// Returns { id, email, name, avatar_url } for the signed-in user, or null.
export async function getSessionUser(request, db, url) {
  const token = readCookie(request, cookieName(url));
  if (!token) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.name, u.avatar_url FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first();
  return row || null;
}

export async function destroySession(request, db, url) {
  const token = readCookie(request, cookieName(url));
  if (token) await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(url)}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}
