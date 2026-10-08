// Small helpers shared by the API handlers.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

export const error = (message, status) => json({ error: message }, status);

// Reads a small JSON body. Returns null when it is missing, too large or not an object.
export async function readJson(request, maxBytes = 10_000) {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

// Unguessable share code: 10 chars x 5 bits = 50 bits.
export function randomCode(length = 10) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}

export const newId = () => crypto.randomUUID();
