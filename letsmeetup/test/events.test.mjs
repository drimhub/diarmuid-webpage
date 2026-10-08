import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createSession } from '../src/auth.js';
import { verifyTurnstile } from '../src/turnstile.js';
import { createTestDb } from '../testing/d1-shim.mjs';

const ORIGIN = 'https://letsmeetup.test';
let db, env;

beforeEach(() => {
  db = createTestDb();
  env = {
    DB: db,
    ASSETS: { fetch: async () => new Response('asset') },
    GOOGLE_CLIENT_ID: 'test-client',
    TURNSTILE_DISABLED: '1',
    RATE_LIMITS_OFF: '1',
  };
});

const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

async function makeUser(id, name = `${id[0].toUpperCase()}${id.slice(1)} Smith`) {
  db.raw.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.com`, name, new Date().toISOString());
  const setCookie = await createSession(db, id, new URL(ORIGIN));
  return { id, cookie: setCookie.split(';')[0] };
}

async function call(user, method, path, body, extraHeaders = {}) {
  const headers = { 'X-Requested-With': 'letsmeetup', Origin: ORIGIN, ...extraHeaders };
  if (user) headers.Cookie = user.cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(
    new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
  );
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text };
}

const newEvent = (over = {}) => ({ title: 'Drinks tonight', eventType: 'drinks', startAt: hoursFromNow(5), tags: ['outdoor_seating'], ...over });

async function createEvent(user, over) {
  const r = await call(user, 'POST', '/api/events', newEvent(over));
  assert.equal(r.status, 201, r.text);
  return r.data.code;
}

test('requires sign-in and the CSRF header', async () => {
  assert.equal((await call(null, 'GET', '/api/events')).status, 401);
  const alice = await makeUser('alice');
  assert.equal((await call(alice, 'POST', '/api/events', newEvent(), { 'X-Requested-With': '' })).status, 403);
  assert.equal((await call(alice, 'POST', '/api/events', newEvent(), { Origin: 'https://evil.example' })).status, 403);
});

test('creating an event validates input', async () => {
  const alice = await makeUser('alice');
  const bad = async (over) => assert.equal((await call(alice, 'POST', '/api/events', newEvent(over))).status, 400, JSON.stringify(over));
  await bad({ title: '' });
  await bad({ title: 'x'.repeat(81) });
  await bad({ title: 42 });
  await bad({ eventType: 'brunch' });
  await bad({ startAt: 'not a date' });
  await bad({ startAt: hoursFromNow(-3) });
  await bad({ startAt: hoursFromNow(24 * 91) });
  await bad({ tags: ['karaoke'] });
  await bad({ tags: 'outdoor_seating' });
});

test('creating an event stores it, its tags and the owner as first participant', async () => {
  const alice = await makeUser('alice', 'Alice Anderson');
  const code = await createEvent(alice, { title: '  Drinks   tonight ', tags: ['open_late', 'open_late', 'outdoor_seating'] });
  assert.match(code, /^[a-z2-7]{10}$/);

  const { data } = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(data.event.title, 'Drinks tonight');
  assert.deepEqual(data.event.tags, ['open_late', 'outdoor_seating']);
  assert.equal(data.event.status, 'open');
  assert.equal(data.me.isOwner, true);
  assert.equal(data.participants.length, 1);
  assert.equal(data.participants[0].name, 'Alice'); // first name only
  assert.equal(data.participants[0].hasLocation, false);
});

test('titles are stored as text, never interpreted (escaping is the UI job, but nothing is stripped silently)', async () => {
  const alice = await makeUser('alice');
  const code = await createEvent(alice, { title: '<img src=x onerror=alert(1)>' });
  const { data } = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(data.event.title, '<img src=x onerror=alert(1)>');
});

test('daily event cap', async () => {
  const alice = await makeUser('alice');
  for (let i = 0; i < 10; i++) await createEvent(alice);
  assert.equal((await call(alice, 'POST', '/api/events', newEvent())).status, 429);
});

test('Turnstile fails closed', async () => {
  const alice = await makeUser('alice');
  delete env.TURNSTILE_DISABLED;
  assert.equal((await call(alice, 'POST', '/api/events', newEvent())).status, 400); // no secret configured
  env.TURNSTILE_SECRET = 'secret';
  assert.equal((await call(alice, 'POST', '/api/events', newEvent({ turnstileToken: 'tok' }))).status, 400); // siteverify unreachable in tests

  const ok = async () => ({ json: async () => ({ success: true }) });
  const no = async () => ({ json: async () => ({ success: false }) });
  const boom = async () => { throw new Error('network'); };
  assert.equal(await verifyTurnstile('tok', env, '1.2.3.4', ok), true);
  assert.equal(await verifyTurnstile('tok', env, '1.2.3.4', no), false);
  assert.equal(await verifyTurnstile('tok', env, '1.2.3.4', boom), false);
  assert.equal(await verifyTurnstile('', env, '1.2.3.4', ok), false);
});

test('link holders see only the basics until they join', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const code = await createEvent(alice);

  const before = await call(bob, 'GET', `/api/events/${code}`);
  assert.equal(before.status, 200);
  assert.equal(before.data.me, null);
  assert.equal(before.data.participants, undefined);
  assert.equal(before.data.event.participantCount, 1);
  assert.equal(before.data.event.ownerName, 'Alice');

  assert.equal((await call(bob, 'POST', `/api/events/${code}/join`)).status, 201);
  assert.equal((await call(bob, 'POST', `/api/events/${code}/join`)).status, 200); // idempotent
  const after = await call(bob, 'GET', `/api/events/${code}`);
  assert.equal(after.data.participants.length, 2);
  assert.equal(after.data.participants.find((p) => p.isMe).name, 'Bob');
});

test('unknown or malformed codes are 404', async () => {
  const alice = await makeUser('alice');
  assert.equal((await call(alice, 'GET', '/api/events/aaaaaaaaaa')).status, 404);
  assert.equal((await call(alice, 'GET', '/api/events/short')).status, 404);
  assert.equal((await call(alice, 'POST', '/api/events/aaaaaaaaaa/join')).status, 404);
});

test('event capacity and locked events', async () => {
  const [alice, bob, carol, dave] = await Promise.all(['alice', 'bob', 'carol', 'dave'].map((n) => makeUser(n)));
  const code = await createEvent(alice);
  db.raw.prepare('UPDATE events SET max_participants = 2 WHERE join_code = ?').run(code);

  assert.equal((await call(bob, 'POST', `/api/events/${code}/join`)).status, 201);
  assert.equal((await call(carol, 'POST', `/api/events/${code}/join`)).status, 409); // full

  db.raw.prepare('UPDATE events SET max_participants = 12 WHERE join_code = ?').run(code);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/lock`, { locked: true })).data.status, 'closed');
  assert.equal((await call(dave, 'POST', `/api/events/${code}/join`)).status, 409); // locked
  assert.equal((await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'brixton', mode: 'bike' })).status, 409);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/lock`, { locked: false })).data.status, 'open');
  assert.equal((await call(dave, 'POST', `/api/events/${code}/join`)).status, 201);
});

test('setting your location takes an area id only', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const code = await createEvent(alice);
  await call(bob, 'POST', `/api/events/${code}/join`);

  const put = (u, body) => call(u, 'PUT', `/api/events/${code}/me`, body);
  assert.equal((await put(bob, { lat: 51.46, lng: -0.11, mode: 'bike' })).status, 400); // coordinates are not accepted
  assert.equal((await put(bob, { areaId: 'narnia', mode: 'bike' })).status, 400);
  assert.equal((await put(bob, { areaId: 'brixton', mode: 'teleport' })).status, 400);
  assert.equal((await put(bob, { areaId: 'brixton', mode: 'bike', maxMinutes: 5 })).status, 400);
  assert.equal((await put(bob, { areaId: 'brixton', mode: 'bike', maxMinutes: 'abc' })).status, 400);

  // Extra fields such as coordinates are ignored, never stored.
  assert.equal((await put(bob, { areaId: 'brixton', mode: 'bike', maxMinutes: 30, lat: 51.46, lng: -0.11 })).status, 200);

  const mine = await call(bob, 'GET', `/api/events/${code}`);
  assert.equal(mine.data.me.areaId, 'brixton');
  assert.equal(mine.data.me.maxMinutes, 30);
  const seenByAlice = await call(alice, 'GET', `/api/events/${code}`);
  const bobRow = seenByAlice.data.participants.find((p) => p.name === 'Bob');
  assert.equal(bobRow.areaName, 'Brixton');
  assert.equal(bobRow.mode, 'bike');
  assert.equal(bobRow.hasLocation, true);
  assert.equal(seenByAlice.data.me.maxMinutes, null); // Alice's own; Bob's limit isn't shared
  assert.doesNotMatch(seenByAlice.text, /maxMinutes":30/);
  assert.doesNotMatch(mine.text + seenByAlice.text, /"(lat|lng|lon|latitude|longitude)"/);

  const carol = await makeUser('carol');
  assert.equal((await put(carol, { areaId: 'brixton', mode: 'bike' })).status, 403); // not a participant
});

test('organiser controls', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const carol = await makeUser('carol');
  const code = await createEvent(alice);
  await call(bob, 'POST', `/api/events/${code}/join`);
  await call(carol, 'POST', `/api/events/${code}/join`);

  const view = await call(alice, 'GET', `/api/events/${code}`);
  const bobId = view.data.participants.find((p) => p.name === 'Bob').id;
  const aliceId = view.data.participants.find((p) => p.isOwner).id;

  assert.equal((await call(bob, 'POST', `/api/events/${code}/lock`, { locked: true })).status, 403);
  assert.equal((await call(bob, 'DELETE', `/api/events/${code}/participants/${bobId}`)).status, 403);
  assert.equal((await call(bob, 'DELETE', `/api/events/${code}`)).status, 403);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/lock`, { locked: 'yes' })).status, 400);

  assert.equal((await call(alice, 'DELETE', `/api/events/${code}/participants/${aliceId}`)).status, 400); // not the organiser
  assert.equal((await call(alice, 'DELETE', `/api/events/${code}/participants/${bobId}`)).status, 200);
  assert.equal((await call(bob, 'GET', `/api/events/${code}`)).data.me, null);

  assert.equal((await call(alice, 'DELETE', `/api/events/${code}/me`)).status, 400); // organiser can't leave
  assert.equal((await call(carol, 'DELETE', `/api/events/${code}/me`)).status, 200);

  db.raw.prepare("UPDATE events SET status = 'calculating' WHERE join_code = ?").run(code);
  assert.equal((await call(alice, 'POST', `/api/events/${code}/lock`, { locked: true })).status, 409);
});

test('deleting an event removes everything attached to it', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const code = await createEvent(alice);
  await call(bob, 'POST', `/api/events/${code}/join`);
  assert.equal((await call(alice, 'DELETE', `/api/events/${code}`)).status, 200);
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).status, 404);
  for (const t of ['events', 'participants', 'event_tags']) {
    assert.equal(db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
});

test('listing only shows my events', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const mine = await createEvent(alice, { title: 'Alice drinks' });
  await createEvent(bob, { title: 'Bob dinner', eventType: 'dinner' });
  const list = await call(alice, 'GET', '/api/events');
  assert.deepEqual(list.data.events.map((e) => e.title), ['Alice drinks']);
  assert.equal(list.data.events[0].isOwner, true);
  assert.equal(list.data.events[0].code, mine);
  await call(alice, 'POST', `/api/events/${(await call(bob, 'GET', '/api/events')).data.events[0].code}/join`);
  assert.equal((await call(alice, 'GET', '/api/events')).data.events.length, 2);
});
