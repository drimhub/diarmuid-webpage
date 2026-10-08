// Shared HTTP plumbing for the Google providers: auth header, field mask, retries on transient
// errors, and errors that never contain the API key. Only Google provider code imports this.

import { ProviderError } from './types.js';

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [300, 900];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function requireKey(env) {
  if (!env || !env.GOOGLE_MAPS_API_KEY) throw new ProviderError('GOOGLE_MAPS_API_KEY is not set', { provider: 'google' });
  return env.GOOGLE_MAPS_API_KEY;
}

// POSTs JSON and returns the parsed response. `requests` counts every HTTP attempt (retries are
// billed too), so callers can report real usage.
export async function googlePost({ fetch: fetchImpl, sleep = defaultSleep, apiKey, url, fieldMask, body }) {
  let attempts = 0;
  for (;;) {
    attempts++;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e && e.noRetry) throw e;
      if (attempts <= BACKOFF_MS.length) { await sleep(BACKOFF_MS[attempts - 1]); continue; }
      throw new ProviderError(`Google request failed: ${e.message}`, { provider: 'google' });
    }

    if (res.ok) {
      let data;
      try {
        data = await res.json();
      } catch {
        throw new ProviderError('Google returned an unreadable response', { status: res.status, provider: 'google' });
      }
      return { data, attempts };
    }

    if (RETRY_STATUSES.has(res.status) && attempts <= BACKOFF_MS.length) {
      await sleep(BACKOFF_MS[attempts - 1]);
      continue;
    }

    let detail = '';
    try {
      const err = await res.json();
      detail = err && err.error && err.error.message ? `: ${String(err.error.message).slice(0, 200)}` : '';
    } catch { /* no body */ }
    throw new ProviderError(`Google responded ${res.status}${detail}`, { status: res.status, provider: 'google' });
  }
}
