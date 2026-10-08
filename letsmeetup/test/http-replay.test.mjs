import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, ReplayMissError, recordingFetch, replayFetch, requestKey } from '../src/providers/http.js';
import { createProviders } from '../src/providers/index.js';
import { createGoogleStub } from '../testing/google-stub.mjs';
import { FileStore } from '../testing/file-store.mjs';

const env = { GOOGLE_MAPS_API_KEY: 'SECRET-KEY-123' };
const noSleep = async () => {};
const center = { lat: 51.5045, lng: -0.0865 };
const origins = [{ lat: 51.46, lng: -0.12, mode: 'transit' }, { lat: 51.51, lng: -0.1, mode: 'bike' }];

async function run(providers) {
  const { venues } = await providers.places.findVenues({ center, eventType: 'drinks', maxResults: 4 });
  const dests = venues.map((v) => ({ lat: v.lat, lng: v.lng }));
  const { times } = await providers.routing.getTravelTimes({ origins, destinations: dests, arriveBy: '2026-10-08T18:30:00Z' });
  return { venues, times };
}

test('what is recorded replays identically, with no network', async () => {
  const stub = createGoogleStub();
  const store = new MemoryStore();
  const live = await run(createProviders(env, { fetch: recordingFetch(stub.fetch, store), sleep: noSleep }));
  assert.equal(stub.calls.length, 3); // 1 places + 2 matrices
  assert.equal(store.size, 3);

  // Replay with a key-less env: the key is not part of the match.
  const replayed = await run(createProviders({ GOOGLE_MAPS_API_KEY: 'a-different-key' }, { fetch: replayFetch(store), sleep: noSleep }));
  assert.deepEqual(replayed, live);
  assert.equal(stub.calls.length, 3); // nothing new hit the stub
});

test('recordings never contain the API key', async () => {
  const store = new MemoryStore();
  await run(createProviders(env, { fetch: recordingFetch(createGoogleStub().fetch, store), sleep: noSleep }));
  assert.doesNotMatch(JSON.stringify(store.entries), /SECRET-KEY-123/);
});

test('a request that was never recorded fails loudly and says what was asked', async () => {
  const store = new MemoryStore();
  const providers = createProviders(env, { fetch: replayFetch(store), sleep: noSleep });
  await assert.rejects(providers.places.findVenues({ center, eventType: 'drinks' }), (e) => {
    assert.ok(e instanceof ReplayMissError);
    assert.match(e.message, /places\.googleapis\.com/);
    assert.match(e.message, /locationRestriction/);
    return true;
  });
});

test('matching ignores JSON key order but not content', async () => {
  const a = await requestKey('https://x.test/api', { method: 'POST', body: JSON.stringify({ a: 1, b: { c: 2, d: [1, 2] } }) });
  const b = await requestKey('https://x.test/api', { method: 'POST', body: JSON.stringify({ b: { d: [1, 2], c: 2 }, a: 1 }) });
  const c = await requestKey('https://x.test/api', { method: 'POST', body: JSON.stringify({ a: 1, b: { c: 3, d: [1, 2] } }) });
  const mask1 = await requestKey('https://x.test/api', { method: 'POST', headers: { 'X-Goog-FieldMask': 'a' }, body: '{}' });
  const mask2 = await requestKey('https://x.test/api', { method: 'POST', headers: { 'X-Goog-FieldMask': 'b' }, body: '{}' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(mask1, mask2);
});

test('error responses are recorded and replayed too', async () => {
  const store = new MemoryStore();
  const failing = createGoogleStub({ fail: [403, 403, 403, 403] });
  await assert.rejects(createProviders(env, { fetch: recordingFetch(failing.fetch, store), sleep: noSleep }).places.findVenues({ center, eventType: 'drinks' }));
  assert.ok(store.size >= 1);
});

test('FileStore round-trips through disk', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lm-')), 'nested', 'scenario.json');
  const store = new FileStore(path);
  const live = await run(createProviders(env, { fetch: recordingFetch(createGoogleStub().fetch, store), sleep: noSleep }));
  store.save();
  assert.equal(Object.keys(JSON.parse(readFileSync(path, 'utf8')).entries).length, 3);

  const reloaded = await run(createProviders(env, { fetch: replayFetch(new FileStore(path)), sleep: noSleep }));
  assert.deepEqual(reloaded, live);
});
