import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createSession } from '../src/auth.js';
import { consumeDailyBudget, RUN_LIMITS } from '../src/calculation.js';
import { safeMapsUrl, openUntilText, inputsChanged } from '../src/results.js';
import { createTestDb } from '../testing/d1-shim.mjs';
import { createFakePlaces, createFakeRouting } from '../testing/fake-providers.mjs';

const ORIGIN = 'https://letsmeetup.test';
let db, env, pending;

beforeEach(() => {
  db = createTestDb();
  pending = [];
  env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    GOOGLE_CLIENT_ID: 'test-client',
    TURNSTILE_DISABLED: '1',
    TEST_PROVIDERS: { places: createFakePlaces(), routing: createFakeRouting() },
  };
});

const ctx = () => ({ waitUntil: (p) => pending.push(p) });
const settle = () => Promise.all(pending.splice(0));
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

async function makeUser(id) {
  db.raw.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.com`, `${id[0].toUpperCase()}${id.slice(1)} Smith`, new Date().toISOString());
  return { id, cookie: (await createSession(db, id, new URL(ORIGIN))).split(';')[0] };
}

async function call(user, method, path, body) {
  const headers = { 'X-Requested-With': 'letsmeetup', Origin: ORIGIN };
  if (user) headers.Cookie = user.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx());
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text };
}

// Holds the providers until release() is called, so a run can be inspected while it is in flight.
function gate() {
  let release;
  const open = new Promise((r) => { release = r; });
  const places = createFakePlaces();
  env.TEST_PROVIDERS = {
    places: { name: 'gated', findVenues: async (a) => { await open; return places.findVenues(a); } },
    routing: createFakeRouting(),
  };
  return release;
}

// An event with three people in different places, ready to calculate.
async function readyEvent(over = {}) {
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map(makeUser));
  const created = await call(alice, 'POST', '/api/events', { title: 'Drinks', eventType: 'drinks', startAt: hoursFromNow(30), tags: [], ...over });
  assert.equal(created.status, 201, created.text);
  const code = created.data.code;
  for (const [u, area, mode] of [[alice, 'stockwell', 'transit'], [bob, 'blackfriars', 'bike'], [carol, 'hampstead', 'transit']]) {
    if (u !== alice) await call(u, 'POST', `/api/events/${code}/join`);
    assert.equal((await call(u, 'PUT', `/api/events/${code}/me`, { areaId: area, mode })).status, 200);
  }
  return { alice, bob, carol, code };
}

test('only the organiser can start a calculation, and only with two located people', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const code = (await call(alice, 'POST', '/api/events', { title: 'Drinks', eventType: 'drinks', startAt: hoursFromNow(30) })).data.code;
  await call(bob, 'POST', `/api/events/${code}/join`);
  assert.equal((await call(bob, 'POST', `/api/events/${code}/calculate`)).status, 403);
  assert.equal((await call(alice, 'POST', '/api/events/aaaaaaaaaa/calculate')).status, 404);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 400); // nobody has set a location
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit' });
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 400); // only one
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM calc_runs').get().n, 0);
});

test('a calculation runs in the background and the results appear', async () => {
  const { alice, bob, carol, code } = await readyEvent();
  const release = gate();
  const started = await call(alice, 'POST', `/api/events/${code}/calculate`);
  assert.equal(started.status, 202);
  assert.ok(started.data.runId);

  // While it runs the event is claimed: no changes, no second run.
  let view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.event.status, 'calculating');
  assert.equal(view.data.run.status, 'running');
  assert.equal(view.data.results, null);
  assert.equal((await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'brixton', mode: 'bike' })).status, 409);
  assert.match((await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'brixton', mode: 'bike' })).data.error, /worked out/);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 409);
  assert.equal((await call(carol, 'DELETE', `/api/events/${code}/me`)).status, 409);

  release();
  await settle();

  view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.event.status, 'open'); // given back
  assert.equal(view.data.run.status, 'done');
  const r = view.data.results;
  assert.equal(r.status, 'ok');
  assert.ok(r.suggestions.length >= 3 && r.suggestions.length <= 5);
  assert.equal(r.stale, false);
  assert.equal(r.planned, 3);
  const s = r.suggestions[0];
  assert.deepEqual(s.travel.perPerson.map((p) => p.name), ['Alice', 'Bob', 'Carol']); // first names only
  assert.ok(s.travel.perPerson.every((p) => p.minutes > 0));
  assert.equal(typeof s.travel.furthest.name, 'string');
  assert.equal(view.data.calculation.runsUsed, 1);

  // Everyone in the event sees the same results; people with only the link do not.
  const bobView = await call(bob, 'GET', `/api/events/${code}`);
  assert.deepEqual(bobView.data.results, r);
  const stranger = await makeUser('dave');
  const strangerView = await call(stranger, 'GET', `/api/events/${code}`);
  assert.equal(strangerView.data.results, undefined);
  assert.equal(strangerView.data.run, undefined);
});

test('the results contain no personal locations and no internals', async () => {
  const { alice, code } = await readyEvent();
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  const { text } = await call(alice, 'GET', `/api/events/${code}`);
  assert.doesNotMatch(text, /"(lat|lng|latitude|longitude|providerPlaceId|cost|candidates|heuristics)/);
  assert.doesNotMatch(text, /@example\.com/);
});

test('a locked event stays locked after a calculation', async () => {
  const { alice, code } = await readyEvent();
  await call(alice, 'POST', `/api/events/${code}/lock`, { locked: true });
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 202);
  await settle();
  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.event.status, 'closed');
  assert.equal(view.data.run.status, 'done');
});

test('results are marked out of date when someone moves afterwards', async () => {
  const { alice, bob, code } = await readyEvent();
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.results.stale, false);
  await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'peckham', mode: 'bike' });
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.results.stale, true);
  // A second run uses the new place and is fresh again.
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 202);
  await settle();
  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.results.stale, false);
  assert.equal(view.data.calculation.runsUsed, 2);
});

test('a failed run reports a safe message, keeps the details out, and frees the event', async () => {
  const { alice, code } = await readyEvent();
  env.TEST_PROVIDERS = { places: createFakePlaces(), routing: { name: 'broken', getTravelTimes: async () => { throw new Error('secret-internal-detail key=SECRET-KEY'); } } };
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 202);
  await settle();
  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.run.status, 'failed');
  assert.equal(view.data.results, null);
  assert.equal(view.data.event.status, 'open');
  assert.doesNotMatch(view.text, /secret-internal-detail|SECRET-KEY/);
  assert.match(view.data.run.error, /try again/);
  assert.equal(view.data.calculation.runsUsed, 1); // failures still count: they spend API calls

  env.TEST_PROVIDERS = { places: createFakePlaces(), routing: createFakeRouting() };
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 202); // and it can be retried
  await settle();
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.run.status, 'done');
});

test('a run that never finishes is reaped and the event is freed', async () => {
  const { alice, code } = await readyEvent();
  await call(alice, 'POST', `/api/events/${code}/lock`, { locked: true });
  const eventId = db.raw.prepare('SELECT id FROM events WHERE join_code = ?').get(code).id;
  const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  db.raw.prepare("INSERT INTO calc_runs (id, event_id, status, started_at, prior_status, input_snapshot) VALUES ('r1', ?, 'running', ?, 'closed', '{}')").run(eventId, old);
  db.raw.prepare("UPDATE events SET status = 'calculating' WHERE id = ?").run(eventId);

  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.event.status, 'closed'); // restored to what it was before
  assert.equal(view.data.run.status, 'failed');
  assert.equal(db.raw.prepare("SELECT status FROM calc_runs WHERE id = 'r1'").get().status, 'failed');
});

test('a recent run is left alone', async () => {
  const { alice, code } = await readyEvent();
  const eventId = db.raw.prepare('SELECT id FROM events WHERE join_code = ?').get(code).id;
  db.raw.prepare("INSERT INTO calc_runs (id, event_id, status, started_at, prior_status, input_snapshot) VALUES ('r1', ?, 'running', ?, 'open', '{}')").run(eventId, new Date().toISOString());
  db.raw.prepare("UPDATE events SET status = 'calculating' WHERE id = ?").run(eventId);
  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.event.status, 'calculating');
  assert.equal(view.data.run.status, 'running');
});

test('each event has a cap on calculations', async () => {
  const { alice, code } = await readyEvent();
  for (let i = 0; i < RUN_LIMITS.runsPerEvent; i++) {
    assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 202, `run ${i + 1}`);
    await settle();
  }
  const over = await call(alice, 'POST', `/api/events/${code}/calculate`);
  assert.equal(over.status, 429);
  assert.match(over.data.error, /used all/);
});

test('the whole service has a daily budget, and refused runs change nothing', async () => {
  env.CALC_DAILY_LIMIT = '2';
  const a = await readyEvent();
  assert.equal((await call(a.alice, 'POST', `/api/events/${a.code}/calculate`)).status, 202);
  await settle();
  assert.equal((await call(a.alice, 'POST', `/api/events/${a.code}/calculate`)).status, 202);
  await settle();
  const refused = await call(a.alice, 'POST', `/api/events/${a.code}/calculate`);
  assert.equal(refused.status, 429);
  assert.match(refused.data.error, /paused for today/);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM calc_runs').get().n, 2);
  assert.equal(db.raw.prepare("SELECT status FROM events WHERE join_code = ?").get(a.code).status, 'open');
  assert.equal(db.raw.prepare('SELECT count FROM usage_counters').get().count, 2);
});

test('daily budget counter', async () => {
  assert.equal(await consumeDailyBudget(db, 2), true);
  assert.equal(await consumeDailyBudget(db, 2), true);
  assert.equal(await consumeDailyBudget(db, 2), false);
  assert.equal(await consumeDailyBudget(db, 2), false);
  assert.equal(db.raw.prepare('SELECT count FROM usage_counters').get().count, 2); // not incremented past the limit
  assert.equal(await consumeDailyBudget(db, 2, Date.now() + 86400 * 1000), true); // a new day starts fresh
});

test('no provider configured: a clear refusal, nothing recorded', async () => {
  const { alice, code } = await readyEvent();
  delete env.TEST_PROVIDERS;
  const r = await call(alice, 'POST', `/api/events/${code}/calculate`);
  assert.equal(r.status, 503);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM calc_runs').get().n, 0);
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.event.status, 'open');
});

test('an event that has already started cannot be calculated', async () => {
  const { alice, code } = await readyEvent();
  db.raw.prepare('UPDATE events SET start_at = ? WHERE join_code = ?').run(new Date(Date.now() - 3 * 3600 * 1000).toISOString(), code);
  const r = await call(alice, 'POST', `/api/events/${code}/calculate`);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /already started/);
});

test('impossible limits come back as an honest, explained result', async () => {
  const { alice, bob, code } = await readyEvent();
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit', maxMinutes: 10 });
  await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'blackfriars', mode: 'bike', maxMinutes: 10 });
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  const r = (await call(alice, 'GET', `/api/events/${code}`)).data.results;
  assert.equal(r.status, 'no_results');
  assert.equal(r.reason, 'no_venue_within_limits');
  assert.ok(r.closestMisses.length > 0);
  assert.ok(r.closestMisses[0].exceeds.every((x) => typeof x.name === 'string' && x.minutes > x.limit));
});

test('everyone in the event can watch a run in progress', async () => {
  const { alice, carol, code } = await readyEvent();
  const release = gate();
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  const during = await call(carol, 'GET', `/api/events/${code}`);
  assert.equal(during.data.run.status, 'running');
  assert.equal(during.data.results, null);
  release();
  await settle();
  assert.equal((await call(carol, 'GET', `/api/events/${code}`)).data.run.status, 'done');
});

// ---------- results helpers ----------

test('only plain Google Maps links are passed on', () => {
  assert.ok(safeMapsUrl('https://maps.google.com/?cid=123'));
  assert.ok(safeMapsUrl('https://www.google.com/maps/place/x'));
  for (const bad of ['javascript:alert(1)', 'http://maps.google.com/?cid=1', 'https://evil.example/maps', 'https://maps.google.com.evil.example/', 'https://www.google.com/search?q=x', '', null, undefined, 42, 'https://maps.google.com/' + 'a'.repeat(700)]) {
    assert.equal(safeMapsUrl(bad), null, String(bad));
  }
});

test('opening-hours text for the start time', () => {
  const thu = (open, close) => ({ periods: [{ open: { day: 4, minute: open * 60 }, close: { day: close < open ? 5 : 4, minute: (close % 24) * 60 } }] });
  const start = '2026-10-08T18:30:00.000Z'; // Thu 19:30 London
  assert.equal(openUntilText({ openingHours: thu(11, 23) }, start), 'Open until 23:00');
  assert.equal(openUntilText({ openingHours: thu(11, 2) }, start), 'Open until 02:00');
  assert.equal(openUntilText({ openingHours: { periods: [{ open: { day: 0, minute: 0 }, close: null }] } }, start), 'Open 24 hours');
  assert.equal(openUntilText({ openingHours: thu(11, 18) }, start), null);
  assert.equal(openUntilText({ openingHours: null }, start), null);
});

test('inputsChanged notices moves, joins and event edits', () => {
  const snap = { event: { eventType: 'drinks', startAt: 'T', tags: ['open_late'] }, participants: [{ id: 'a', areaId: 'x', mode: 'transit', maxMinutes: null }, { id: 'b', areaId: 'y', mode: 'bike', maxMinutes: 30 }] };
  const now = [{ id: 'b', areaId: 'y', mode: 'bike', maxMinutes: 30 }, { id: 'a', areaId: 'x', mode: 'transit', maxMinutes: null }];
  const ev = { eventType: 'drinks', startAt: 'T', tags: ['open_late'] };
  assert.equal(inputsChanged(snap, now, ev), false);
  assert.equal(inputsChanged(snap, [{ ...now[0], areaId: 'z' }, now[1]], ev), true);
  assert.equal(inputsChanged(snap, [...now, { id: 'c', areaId: 'q', mode: 'walk', maxMinutes: null }], ev), true);
  assert.equal(inputsChanged(snap, [...now, { id: 'c', areaId: null, mode: 'walk', maxMinutes: null }], ev), false); // a joiner with no location yet changes nothing
  assert.equal(inputsChanged(snap, now, { ...ev, startAt: 'T2' }), true);
  assert.equal(inputsChanged(snap, now, { ...ev, tags: [] }), true);
});
