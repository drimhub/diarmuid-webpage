import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createSession } from '../src/auth.js';
import { RATE_RULES } from '../src/ratelimit.js';
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
    RATE_LIMITS_OFF: '1',
    TEST_PROVIDERS: { places: createFakePlaces(), routing: createFakeRouting() },
  };
});

const ctx = () => ({ waitUntil: (p) => pending.push(p) });
const settle = () => Promise.all(pending.splice(0));
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const sql = (q, ...a) => db.raw.prepare(q).get(...a);

async function makeUser(id) {
  db.raw.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.com`, `${id[0].toUpperCase()}${id.slice(1)} Smith`, new Date().toISOString());
  return { id, cookie: (await createSession(db, id, new URL(ORIGIN))).split(';')[0] };
}

async function call(user, method, path, body, extra = {}) {
  const headers = { 'X-Requested-With': 'letsmeetup', Origin: ORIGIN, ...extra };
  if (user) headers.Cookie = user.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx());
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text };
}

const guest = (over = {}) => ({ name: 'Maeve', areaId: 'peckham', mode: 'transit', ...over });

async function setup() {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const code = (await call(alice, 'POST', '/api/events', { title: 'Drinks', eventType: 'drinks', startAt: hoursFromNow(30), tags: [] })).data.code;
  await call(bob, 'POST', `/api/events/${code}/join`);
  return { alice, bob, code };
}

test('the organiser adds a friend without an account, and everyone in the event sees them', async () => {
  const { alice, bob, code } = await setup();
  const r = await call(alice, 'POST', `/api/events/${code}/guests`, guest({ maxMinutes: 40 }));
  assert.equal(r.status, 201);
  assert.ok(r.data.id);

  const row = sql('SELECT * FROM participants WHERE id = ?', r.data.id);
  assert.equal(row.user_id, null);
  assert.equal(row.display_name, 'Maeve');
  assert.equal(row.area_id, 'peckham');

  for (const viewer of [alice, bob]) {
    const view = await call(viewer, 'GET', `/api/events/${code}`);
    const g = view.data.participants.find((p) => p.name === 'Maeve');
    assert.equal(g.isGuest, true);
    assert.equal(g.areaName, 'Peckham');
    assert.equal(g.mode, 'transit');
    assert.equal(g.hasLocation, true);
    assert.equal(g.isOwner, false);
    assert.equal(g.isMe, false);
    assert.equal(view.data.participants.filter((p) => p.isGuest).length, 1);
    assert.equal(view.data.event.participantCount, 3);
  }
});

test("a guest's longest-journey limit is shown to the organiser who entered it, and to nobody else", async () => {
  const { alice, bob, code } = await setup();
  await call(alice, 'POST', `/api/events/${code}/guests`, guest({ maxMinutes: 40 }));
  const owner = (await call(alice, 'GET', `/api/events/${code}`)).data.participants.find((p) => p.isGuest);
  assert.equal(owner.maxMinutes, 40);
  const other = await call(bob, 'GET', `/api/events/${code}`);
  assert.equal(other.data.participants.find((p) => p.isGuest).maxMinutes, undefined);
  assert.doesNotMatch(other.text, /"maxMinutes":40/);
  // Signed-in people's limits are never shown in the list, to anyone.
  await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'brixton', mode: 'bike', maxMinutes: 25 });
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.participants.find((p) => p.name === 'Bob').maxMinutes, undefined);
});

test('only the organiser can add or edit guests', async () => {
  const { alice, bob, code } = await setup();
  const id = (await call(alice, 'POST', `/api/events/${code}/guests`, guest())).data.id;
  assert.equal((await call(bob, 'POST', `/api/events/${code}/guests`, guest())).status, 403);
  assert.equal((await call(bob, 'PUT', `/api/events/${code}/guests/${id}`, guest({ name: 'Hacked' }))).status, 403);
  const stranger = await makeUser('dave');
  assert.equal((await call(stranger, 'POST', `/api/events/${code}/guests`, guest())).status, 403);
  assert.equal((await call(null, 'POST', `/api/events/${code}/guests`, guest())).status, 401);
  assert.equal((await call(alice, 'POST', '/api/events/aaaaaaaaaa/guests', guest())).status, 404);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/guests`, guest(), { 'X-Requested-With': '' })).status, 403);
  assert.equal(sql("SELECT COUNT(*) AS n FROM participants WHERE display_name = 'Hacked'").n, 0);
});

test('guest details are validated like everyone else\'s, plus a name that is not an email', async () => {
  const { alice, code } = await setup();
  const bad = async (over, pattern) => {
    const r = await call(alice, 'POST', `/api/events/${code}/guests`, guest(over));
    assert.equal(r.status, 400, JSON.stringify(over));
    if (pattern) assert.match(r.data.error, pattern);
  };
  await bad({ name: '' }, /Name/);
  await bad({ name: '   ' }, /Name/);
  await bad({ name: 'x'.repeat(31) }, /Name/);
  await bad({ name: 42 }, /Name/);
  await bad({ name: 'maeve@example.com' }, /email/);
  await bad({ areaId: 'narnia' }, /neighbourhood/);
  await bad({ areaId: undefined, lat: 51.4, lng: -0.1 }, /neighbourhood/); // coordinates are not a way in
  await bad({ mode: 'teleport' }, /mode/);
  await bad({ maxMinutes: 5 }, /Max travel time/);
  await bad({ maxMinutes: 'soon' }, /Max travel time/);
  assert.equal(sql('SELECT COUNT(*) AS n FROM participants WHERE user_id IS NULL').n, 0);

  // Whitespace and control characters are tidied; extra fields (coordinates) are ignored, never stored.
  const ok = await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: '  Mary\u0000   Ann ', lat: 51.46, lng: -0.11, maxMinutes: '' }));
  assert.equal(ok.status, 201);
  assert.equal(sql('SELECT display_name, max_minutes FROM participants WHERE id = ?', ok.data.id).display_name, 'Mary Ann');
  assert.equal(sql('SELECT max_minutes FROM participants WHERE id = ?', ok.data.id).max_minutes, null);
});

test('hostile guest names are stored as text and returned as text', async () => {
  const { alice, code } = await setup();
  const evil = '<img src=x onerror=alert(1)>';
  assert.equal((await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: evil }))).status, 201);
  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.ok(view.data.participants.some((p) => p.name === evil)); // escaping is the UI's job (view tests cover it)
});

test('guests take places: the cap counts them, and joining or adding past it is refused', async () => {
  const { alice, code } = await setup();
  db.raw.prepare('UPDATE events SET max_participants = 4 WHERE join_code = ?').run(code);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'G1' }))).status, 201); // 3
  assert.equal((await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'G2' }))).status, 201); // 4
  const full = await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'G3' }));
  assert.equal(full.status, 409);
  assert.match(full.data.error, /full/);
  const carol = await makeUser('carol');
  assert.equal((await call(carol, 'POST', `/api/events/${code}/join`)).status, 409); // guests used the places
  assert.equal(sql('SELECT COUNT(*) AS n FROM participants').n, 4);
});

test('guests can only be added while the event is open', async () => {
  const { alice, code } = await setup();
  await call(alice, 'POST', `/api/events/${code}/lock`, { locked: true });
  const locked = await call(alice, 'POST', `/api/events/${code}/guests`, guest());
  assert.equal(locked.status, 409);
  assert.match(locked.data.error, /locked/);
  await call(alice, 'POST', `/api/events/${code}/lock`, { locked: false });
  db.raw.prepare("UPDATE events SET status = 'calculating' WHERE join_code = ?").run(code);
  const busy = await call(alice, 'POST', `/api/events/${code}/guests`, guest());
  assert.equal(busy.status, 409);
  assert.match(busy.data.error, /worked out/);
});

test('editing a guest changes only that guest, and never a signed-in person', async () => {
  const { alice, bob, code } = await setup();
  const id = (await call(alice, 'POST', `/api/events/${code}/guests`, guest())).data.id;
  const bobRow = (await call(alice, 'GET', `/api/events/${code}`)).data.participants.find((p) => p.name === 'Bob');

  const edit = await call(alice, 'PUT', `/api/events/${code}/guests/${id}`, guest({ name: 'Maeve O', areaId: 'hampstead', mode: 'walk', maxMinutes: 30 }));
  assert.equal(edit.status, 200);
  const row = sql('SELECT * FROM participants WHERE id = ?', id);
  assert.deepEqual([row.display_name, row.area_id, row.mode, row.max_minutes, row.user_id], ['Maeve O', 'hampstead', 'walk', 30, null]);

  // The guest route cannot be pointed at a real account, or at another event's guest.
  assert.equal((await call(alice, 'PUT', `/api/events/${code}/guests/${bobRow.id}`, guest({ name: 'Hijack' }))).status, 404);
  assert.equal(sql('SELECT display_name FROM participants WHERE id = ?', bobRow.id).display_name, 'Bob');
  const other = (await call(alice, 'POST', '/api/events', { title: 'Other', eventType: 'drinks', startAt: hoursFromNow(30), tags: [] })).data.code;
  assert.equal((await call(alice, 'PUT', `/api/events/${other}/guests/${id}`, guest())).status, 404);
  assert.equal((await call(alice, 'PUT', `/api/events/${code}/guests/${id}`, guest({ mode: 'teleport' }))).status, 400);
  assert.equal(sql('SELECT mode FROM participants WHERE id = ?', id).mode, 'walk'); // a rejected edit changes nothing
  assert.equal((await call(alice, 'PUT', `/api/events/${code}/guests/00000000-0000-0000-0000-000000000000`, guest())).status, 404);
  assert.equal((await call(alice, 'PUT', `/api/events/${code}/guests`, guest())).status, 405);
  void bob;
});

test('the organiser can remove a guest with the usual route, and removal erases earlier results', async () => {
  const { alice, bob, code } = await setup();
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit' });
  const id = (await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'Maeve' }))).data.id;
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.run.status, 'done');

  assert.equal((await call(bob, 'DELETE', `/api/events/${code}/participants/${id}`)).status, 403); // only the organiser
  assert.equal((await call(alice, 'DELETE', `/api/events/${code}/participants/${id}`)).status, 200);
  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.participants.some((p) => p.isGuest), false);
  assert.equal(view.data.run.status, 'expired');
  assert.doesNotMatch(view.text, /Maeve/);
});

test('an organiser and one added friend are enough to find a spot, with nobody else signing in', async () => {
  const alice = await makeUser('alice');
  const code = (await call(alice, 'POST', '/api/events', { title: 'Just us', eventType: 'drinks', startAt: hoursFromNow(30), tags: [] })).data.code;
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit' });

  let view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.calculation.locatedCount, 1);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 400); // one person: nothing to compromise on

  await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'Maeve', areaId: 'hampstead', mode: 'transit' }));
  view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.calculation.locatedCount, 2);

  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 202);
  await settle();
  view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.run.status, 'done');
  assert.equal(view.data.results.status, 'ok');
  assert.deepEqual(view.data.results.suggestions[0].travel.perPerson.map((p) => p.name), ['Alice', 'Maeve']);
  assert.equal(view.data.results.planned, 2);
});

test("a guest's own limit and mode are honoured by the calculation", async () => {
  const alice = await makeUser('alice');
  const code = (await call(alice, 'POST', '/api/events', { title: 'Limits', eventType: 'drinks', startAt: hoursFromNow(30), tags: [] })).data.code;
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit' });
  await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'Maeve', areaId: 'hampstead', mode: 'bike', maxMinutes: 10 }));
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  const ok = (await call(alice, 'GET', `/api/events/${code}`)).data.results;
  assert.equal(ok.status, 'ok');
  for (const s of ok.suggestions) {
    const maeve = s.travel.perPerson.find((p) => p.name === 'Maeve');
    assert.equal(maeve.mode, 'bike'); // the organiser's choice for her
    assert.ok(maeve.minutes <= 10, `Maeve was sent ${maeve.minutes} min`); // and her limit
  }

  // Two guests far apart who each insist on 10 minutes: no honest answer, and it says whose limits.
  await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'Cathal', areaId: 'peckham', mode: 'transit', maxMinutes: 10 }));
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  const none = (await call(alice, 'GET', `/api/events/${code}`)).data.results;
  assert.equal(none.status, 'no_results');
  assert.equal(none.reason, 'no_venue_within_limits');
  assert.ok(none.closestMisses[0].exceeds.some((x) => x.name === 'Cathal'));
  assert.doesNotMatch(JSON.stringify(none), /"limit"/);
});

test('adding or changing a guest after a run marks the results as out of date', async () => {
  const { alice, code } = await setup();
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit' });
  const id = (await call(alice, 'POST', `/api/events/${code}/guests`, guest({ areaId: 'hampstead' }))).data.id;
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.results.stale, false);
  await call(alice, 'PUT', `/api/events/${code}/guests/${id}`, guest({ areaId: 'peckham' }));
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.results.stale, true);
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.results.stale, false);
});

test('guests go when the event goes, and when the organiser deletes their data', async () => {
  const { alice, code } = await setup();
  await call(alice, 'POST', `/api/events/${code}/guests`, guest());
  await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'Cathal' }));
  assert.equal(sql('SELECT COUNT(*) AS n FROM participants WHERE user_id IS NULL').n, 2);
  assert.equal((await call(alice, 'DELETE', '/api/me')).status, 200);
  assert.equal(sql('SELECT COUNT(*) AS n FROM participants').n, 0); // the event cascaded, guests included

  const again = await setup2();
  await call(again.alice, 'POST', `/api/events/${again.code}/guests`, guest());
  assert.equal((await call(again.alice, 'DELETE', `/api/events/${again.code}`)).status, 200);
  assert.equal(sql('SELECT COUNT(*) AS n FROM participants WHERE user_id IS NULL').n, 0);
});

async function setup2() {
  const alice = await makeUser('alice2');
  const code = (await call(alice, 'POST', '/api/events', { title: 'Two', eventType: 'drinks', startAt: hoursFromNow(30), tags: [] })).data.code;
  return { alice, code };
}

test('a signed-in person leaving does not touch guests, and a stranger sees only the head-count', async () => {
  const { alice, bob, code } = await setup();
  await call(alice, 'POST', `/api/events/${code}/guests`, guest());
  assert.equal((await call(bob, 'DELETE', `/api/events/${code}/me`)).status, 200);
  assert.equal(sql('SELECT COUNT(*) AS n FROM participants WHERE user_id IS NULL').n, 1);
  const stranger = await makeUser('dave');
  const view = await call(stranger, 'GET', `/api/events/${code}`);
  assert.equal(view.data.event.participantCount, 2); // alice + the guest
  assert.equal(view.data.participants, undefined);
  assert.doesNotMatch(view.text, /Maeve|peckham/i);
});

test('the same name can be a guest and a real participant, and the list tells them apart', async () => {
  const { alice, code } = await setup();
  await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: 'Bob' }));
  const bobs = (await call(alice, 'GET', `/api/events/${code}`)).data.participants.filter((p) => p.name === 'Bob');
  assert.equal(bobs.length, 2);
  assert.deepEqual(bobs.map((b) => b.isGuest).sort(), [false, true]);
});

test('adding guests is rate limited per organiser', async () => {
  const { alice, code } = await setup();
  delete env.RATE_LIMITS_OFF;
  db.raw.prepare('UPDATE events SET max_participants = 500 WHERE join_code = ?').run(code);
  let refused = null;
  for (let i = 0; i <= RATE_RULES.addGuest.limit; i++) {
    const r = await call(alice, 'POST', `/api/events/${code}/guests`, guest({ name: `G${i}` }));
    if (r.status === 429) { refused = i; break; }
  }
  assert.ok(refused !== null && refused <= RATE_RULES.addGuest.limit, 'adding guests should be limited');
});
