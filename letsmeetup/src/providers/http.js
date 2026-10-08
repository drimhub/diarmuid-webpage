// Record/replay at the HTTP level, so the real provider code (request building, retries,
// normalisation) is exercised against real recorded traffic, for any provider that uses fetch.
//
//   record:  const f = recordingFetch(fetch, store)   // calls the real API and saves each response
//   replay:  const f = replayFetch(store)              // serves saved responses, never touches the network
//
// Pass `f` as the `fetch` option of createProviders(). Requests are matched on method + URL +
// field mask + body (key order ignored). The API key is never part of the match or the recording.
// A store is anything with get(key) / set(key, value); MemoryStore is the simplest.

const MATCH_HEADERS = ['x-goog-fieldmask'];

export class ReplayMissError extends Error {
  constructor(description) {
    super(`No recorded response for ${description}`);
    this.name = 'ReplayMissError';
    this.noRetry = true; // callers must surface this, not retry or wrap it
  }
}

export class MemoryStore {
  constructor(entries = {}) {
    this.entries = { ...entries };
  }
  get(key) {
    return this.entries[key];
  }
  set(key, value) {
    this.entries[key] = value;
  }
  get size() {
    return Object.keys(this.entries).length;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

function describe(url, init) {
  const method = ((init && init.method) || 'GET').toUpperCase();
  const headers = {};
  for (const [k, v] of Object.entries((init && init.headers) || {})) {
    if (MATCH_HEADERS.includes(k.toLowerCase())) headers[k.toLowerCase()] = v;
  }
  let body = null;
  if (init && typeof init.body === 'string') {
    try { body = canonical(JSON.parse(init.body)); } catch { body = init.body; }
  }
  return { method, url: String(url), headers, body };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function requestKey(url, init) {
  return sha256Hex(JSON.stringify(describe(url, init)));
}

export function recordingFetch(inner, store) {
  return async (url, init) => {
    const res = await inner(url, init);
    const text = await res.text();
    store.set(await requestKey(url, init), {
      request: describe(url, init), // for humans reading the fixture; contains no credentials
      status: res.status,
      contentType: res.headers.get('content-type') || 'application/json',
      body: text,
    });
    return new Response(text, { status: res.status, headers: { 'Content-Type': res.headers.get('content-type') || 'application/json' } });
  };
}

export function replayFetch(store) {
  return async (url, init) => {
    const entry = await store.get(await requestKey(url, init));
    if (!entry) {
      const d = describe(url, init);
      throw new ReplayMissError(`${d.method} ${d.url} ${JSON.stringify(d.body).slice(0, 300)}`);
    }
    return new Response(entry.body, { status: entry.status, headers: { 'Content-Type': entry.contentType } });
  };
}
