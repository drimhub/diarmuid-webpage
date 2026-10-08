// Small helpers shared by the API handlers.

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

export const error = (message, status, headers = {}) => json({ error: message }, status, headers);

// Reads a small JSON body. Returns null when it is missing, too large or not an object. The body is
// read in pieces and abandoned as soon as it passes the limit, whether or not Content-Length was honest.
export async function readJson(request, maxBytes = 10_000) {
  if (Number(request.headers.get('Content-Length')) > maxBytes) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
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
