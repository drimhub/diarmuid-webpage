import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/index.js';
import { createSession } from '../src/auth.js';
import { hit, RATE_RULES } from '../src/ratelimit.js';
import { runRetention, RETENTION } from '../src/retention.js';
import { createTestDb } from '../testing/d1-shim.mjs';
import { createFakePlaces, createFakeRouting } from '../testing/fake-providers.mjs';

const ORIGIN = 'https://letsmeetup.test';
const DAY = 86400 * 1000;
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
  }; // note: rate limits are ON here (the other API tests switch them off)
});

const ctx = () => ({ waitUntil: (p) => pending.push(p) });
const settle = () => Promise.all(pending.splice(0));
const iso = (ms) => new Date(ms).toISOString();
const hoursFromNow = (h) => iso(Date.now() + h * 3600 * 1000);

async function makeUser(id) {
  db.raw.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.com`, `${id[0].toUpperCase()}${id.slice(1)} Smith`, iso(Date.now()));
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
  return { status: res.status, data, text, headers: res.headers };
}

const newEvent = (over = {}) => ({ title: 'Drinks', eventType: 'drinks', startAt: hoursFromNow(30), tags: [], ...over });
const sql = (q, ...args) => db.raw.prepare(q).get(...args);
const count = (table) => sql(`SELECT COUNT(*) AS n FROM ${table}`).n;

// ---------- rate limits ----------

test('the counter allows the limit, refuses beyond it, and starts afresh next window', async () => {
  const t0 = Date.parse('2026-10-08T12:00:30Z');
  for (let i = 0; i < 3; i++) assert.deepEqual(await hit(db, 'k', 3, 600, t0), { ok: true });
  const refused = await hit(db, 'k', 3, 600, t0);
  assert.equal(refused.ok, false);
  assert.ok(refused.retryAfter >= 1 && refused.retryAfter <= 600);
  assert.equal(sql("SELECT count FROM rate_limits WHERE key = 'k'").count, 3); // refusals are not counted
  assert.deepEqual(await hit(db, 'other', 3, 600, t0), { ok: true }); // keys are independent
  assert.deepEqual(await hit(db, 'k', 3, 600, t0 + 601 * 1000), { ok: true }); // the next window
});

test('creating events is limited per person, with a Retry-After', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  for (let i = 0; i < RATE_RULES.createEvent.limit; i++) assert.equal((await call(alice, 'POST', '/api/events', newEvent())).status, 201, `event ${i + 1}`);
  const refused = await call(alice, 'POST', '/api/events', newEvent());
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('Retry-After')) >= 1);
  assert.match(refused.data.error, /slow down/);
  assert.equal((await call(bob, 'POST', '/api/events', newEvent())).status, 201); // someone else is unaffected
});

test('reads are never limited, even when writes are', async () => {
  const alice = await makeUser('alice');
  const code = (await call(alice, 'POST', '/api/events', newEvent())).data.code;
  let blocked = false;
  for (let i = 0; i < RATE_RULES.mutate.limit + 5; i++) {
    const r = await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'brixton', mode: 'bike' });
    if (r.status === 429) { blocked = true; break; }
  }
  assert.ok(blocked, 'repeated writes should eventually be refused');
  for (let i = 0; i < 20; i++) assert.equal((await call(alice, 'GET', `/api/events/${code}`)).status, 200);
});

test('sign-in attempts are limited per address', async () => {
  const attempt = (ip) => call(null, 'POST', '/api/auth/google', { credential: 'not.a.token' }, { 'CF-Connecting-IP': ip });
  for (let i = 0; i < RATE_RULES.auth.limit; i++) assert.equal((await attempt('203.0.113.7')).status, 401);
  assert.equal((await attempt('203.0.113.7')).status, 429);
  assert.equal((await attempt('203.0.113.8')).status, 401); // another address is fine
});

test('starting a calculation is limited per person', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  const code = (await call(alice, 'POST', '/api/events', newEvent())).data.code;
  await call(bob, 'POST', `/api/events/${code}/join`);
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit' });
  await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'hampstead', mode: 'transit' });
  for (let i = 0; i < RATE_RULES.calculate.limit; i++) {
    const r = await call(alice, 'POST', `/api/events/${code}/calculate`);
    assert.equal(r.status, 202, `run ${i + 1}`);
    await settle();
  }
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 429); // the event's own cap of 5 and this agree
});

// ---------- delete my data ----------

test('deleting my data removes me and what is mine, and nothing else', async () => {
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map(makeUser));
  env.RATE_LIMITS_OFF = '1';
  const e1 = (await call(alice, 'POST', '/api/events', newEvent({ title: 'Alice hosts' }))).data.code;
  const e2 = (await call(bob, 'POST', '/api/events', newEvent({ title: 'Bob hosts' }))).data.code;
  const e3 = (await call(carol, 'POST', '/api/events', newEvent({ title: 'Carol only' }))).data.code;
  await call(bob, 'POST', `/api/events/${e1}/join`);
  await call(alice, 'POST', `/api/events/${e2}/join`);
  await call(alice, 'PUT', `/api/events/${e2}/me`, { areaId: 'stockwell', mode: 'transit' });
  await call(bob, 'PUT', `/api/events/${e2}/me`, { areaId: 'hampstead', mode: 'transit' });
  await call(carol, 'PUT', `/api/events/${e3}/me`, { areaId: 'brixton', mode: 'bike' });
  await call(bob, 'POST', `/api/events/${e2}/calculate`);
  await settle();
  assert.equal(count('calc_runs'), 1);

  const res = await call(alice, 'DELETE', '/api/me');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Set-Cookie'), /Max-Age=0/);

  assert.equal(sql('SELECT COUNT(*) AS n FROM users WHERE id = ?', 'alice').n, 0);
  assert.equal(sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', 'alice').n, 0);
  assert.equal(sql("SELECT COUNT(*) AS n FROM events WHERE join_code = ?", e1).n, 0); // her event went
  assert.equal(sql('SELECT COUNT(*) AS n FROM participants WHERE user_id = ?', 'alice').n, 0);
  assert.equal((await call(bob, 'GET', `/api/events/${e1}`)).status, 404);

  // Bob's event survives, without Alice. The run that included her is kept (it still counts towards
  // the cap) but its stored results are erased, so no trace of her remains for Bob to see.
  const bobView = await call(bob, 'GET', `/api/events/${e2}`);
  assert.equal(bobView.status, 200);
  assert.deepEqual(bobView.data.participants.map((p) => p.name), ['Bob']);
  assert.equal(bobView.data.run.status, 'expired');
  assert.equal(bobView.data.results, null);
  assert.equal(count('calc_runs'), 1);
  assert.doesNotMatch(JSON.stringify(db.raw.prepare('SELECT * FROM calc_runs').all()), /Alice/);
  assert.doesNotMatch(bobView.text, /Alice/);

  // Carol is untouched.
  assert.equal((await call(carol, 'GET', `/api/events/${e3}`)).data.participants[0].areaId, 'brixton');
  assert.equal(sql('SELECT COUNT(*) AS n FROM users').n, 2);

  // Alice's old cookie no longer works.
  assert.equal((await call(alice, 'GET', '/api/events')).status, 401);
  assert.equal((await call(alice, 'DELETE', '/api/me')).status, 401);
});

test('deleting my data while someone else is mid-calculation does not leave their event stuck', async () => {
  const [alice, bob] = await Promise.all(['alice', 'bob'].map(makeUser));
  env.RATE_LIMITS_OFF = '1';
  const code = (await call(bob, 'POST', '/api/events', newEvent())).data.code;
  await call(alice, 'POST', `/api/events/${code}/join`);
  const eventId = sql('SELECT id FROM events WHERE join_code = ?', code).id;
  db.raw.prepare("INSERT INTO calc_runs (id, event_id, status, started_at, prior_status, input_snapshot) VALUES ('r', ?, 'running', ?, 'open', '{}')").run(eventId, iso(Date.now()));
  db.raw.prepare("UPDATE events SET status = 'calculating' WHERE id = ?").run(eventId);
  assert.equal((await call(alice, 'DELETE', '/api/me')).status, 200);
  assert.equal(sql('SELECT status FROM events WHERE id = ?', eventId).status, 'open');
});

test('deleting my data needs a session and the CSRF header, and is limited', async () => {
  assert.equal((await call(null, 'DELETE', '/api/me')).status, 401);
  const alice = await makeUser('alice');
  assert.equal((await call(alice, 'DELETE', '/api/me', undefined, { 'X-Requested-With': '' })).status, 403);
  assert.equal(sql('SELECT COUNT(*) AS n FROM users').n, 1);
});

// ---------- retention ----------

function seedEvent(code, ownerId, startAt) {
  const id = `ev-${code}`;
  db.raw.prepare("INSERT INTO events (id, join_code, owner_id, title, event_type, start_at, status, max_participants, created_at) VALUES (?, ?, ?, 'T', 'drinks', ?, 'open', 12, ?)").run(id, code, ownerId, startAt, iso(Date.now() - 60 * DAY));
  db.raw.prepare("INSERT INTO event_tags (event_id, tag) VALUES (?, 'open_late')").run(id);
  db.raw.prepare("INSERT INTO participants (id, event_id, user_id, display_name, mode, joined_at, updated_at) VALUES (?, ?, ?, 'X', 'transit', ?, ?)").run(`p-${code}`, id, ownerId, iso(Date.now()), iso(Date.now()));
  return id;
}

test('retention deletes old events with everything attached, and keeps current ones', async () => {
  await makeUser('alice');
  const old = seedEvent('olddddddd1', 'alice', iso(Date.now() - (RETENTION.eventDaysAfterStart + 1) * DAY));
  const recent = seedEvent('recenttttt', 'alice', iso(Date.now() - 5 * DAY));
  const future = seedEvent('futureeeee', 'alice', iso(Date.now() + 5 * DAY));
  db.raw.prepare("INSERT INTO calc_runs (id, event_id, status, started_at, finished_at, input_snapshot, result_json) VALUES ('run-old', ?, 'done', ?, ?, '{}', '{}')").run(old, iso(Date.now()), iso(Date.now()));
  const out = await runRetention(env);
  assert.equal(out.events, 1);
  assert.equal(sql('SELECT COUNT(*) AS n FROM events WHERE id = ?', old).n, 0);
  assert.equal(sql('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?', old).n, 0);
  assert.equal(sql('SELECT COUNT(*) AS n FROM event_tags WHERE event_id = ?', old).n, 0);
  assert.equal(sql('SELECT COUNT(*) AS n FROM calc_runs WHERE event_id = ?', old).n, 0);
  assert.equal(sql('SELECT COUNT(*) AS n FROM events WHERE id IN (?, ?)', recent, future).n, 2);
});

test('stored Google results are erased after 30 days even when the event is later, and the run shows as expired', async () => {
  const alice = await makeUser('alice');
  const bob = await makeUser('bob');
  env.RATE_LIMITS_OFF = '1';
  const code = (await call(alice, 'POST', '/api/events', newEvent({ startAt: hoursFromNow(24 * 80) }))).data.code;
  await call(bob, 'POST', `/api/events/${code}/join`);
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit' });
  await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'hampstead', mode: 'transit' });
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.run.status, 'done');

  const later = Date.now() + (RETENTION.resultDays + 1) * DAY;
  const out = await runRetention(env, later);
  assert.equal(out.results, 1);
  assert.equal(out.events, 0); // the event itself is still in the future
  assert.equal(sql('SELECT COUNT(*) AS n FROM calc_runs WHERE result_json IS NOT NULL').n, 0);

  // 31 days on, her old session has (rightly) expired too: she signs in again.
  alice.cookie = (await createSession(db, 'alice', new URL(ORIGIN))).split(';')[0];
  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.run.status, 'expired');
  assert.equal(view.data.results, null);
  assert.equal(view.data.calculation.runsUsed, 1); // the run still counts towards the cap
});

test('retention clears expired sessions, windows, counters and abandoned accounts, and only those', async () => {
  const live = await makeUser('live');           // has a live session
  db.raw.prepare("UPDATE users SET created_at = ? WHERE id = 'live'").run(iso(Date.now() - 200 * DAY));
  db.raw.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('stale', 's@example.com', 'Stale', ?)").run(iso(Date.now() - 200 * DAY));
  db.raw.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('fresh', 'f@example.com', 'Fresh', ?)").run(iso(Date.now() - 2 * DAY));
  db.raw.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('member', 'm@example.com', 'Member', ?)").run(iso(Date.now() - 200 * DAY));
  seedEvent('memberevnt', 'member', iso(Date.now() + 3 * DAY));

  db.raw.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('s-old', 'stale', ?, ?)").run(iso(Date.now() - 40 * DAY), iso(Date.now() - 10 * DAY));
  await hit(db, 'k', 5, 600, Date.now() - 3 * DAY);
  await hit(db, 'k', 5, 600);
  db.raw.prepare("INSERT INTO usage_counters (day, key, count) VALUES (?, 'calculations', 4), (?, 'calculations', 2)").run(iso(Date.now() - 60 * DAY).slice(0, 10), iso(Date.now()).slice(0, 10));

  const out = await runRetention(env);
  assert.equal(out.sessions, 1);
  assert.equal(out.rateLimits, 1);
  assert.equal(out.counters, 1);
  assert.equal(out.users, 1);
  const users = db.raw.prepare('SELECT id FROM users ORDER BY id').all().map((u) => u.id);
  assert.deepEqual(users, ['fresh', 'live', 'member']); // 'stale' alone was removed
  assert.equal(count('sessions'), 1); // the live one
  assert.equal(count('rate_limits'), 1);
  assert.equal(count('usage_counters'), 1);
  assert.ok(live.cookie);
});

test('the scheduled handler runs the clean-up', async () => {
  db.raw.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('u', 'u@example.com', 'U', ?)").run(iso(Date.now() - 300 * DAY));
  await worker.scheduled({ cron: '17 3 * * *' }, env, ctx());
  await settle();
  assert.equal(count('users'), 0);
});

// ---------- headers, inputs, and docs that must stay true ----------

test('API responses are not sniffable and a huge declared body is refused up front', async () => {
  const alice = await makeUser('alice');
  const r = await call(alice, 'GET', '/api/events');
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  const big = await call(alice, 'POST', '/api/events', newEvent(), { 'Content-Length': '50000000' });
  assert.equal(big.status, 400);
});

const publicDir = new URL('../public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, publicDir), 'utf8');

test('the CSP allows exactly what the pages use, and the pages use no inline script', () => {
  const headers = read('_headers');
  const line = headers.split('\n').find((l) => /Content-Security-Policy(-Report-Only)?:/.test(l));
  assert.ok(line, 'no CSP header');
  const policy = Object.fromEntries(line.replace(/^.*?Content-Security-Policy(-Report-Only)?:\s*/, '').split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));

  assert.deepEqual(policy['default-src'], ["'self'"]);
  assert.deepEqual(policy['object-src'], ["'none'"]);
  assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
  assert.deepEqual(policy['base-uri'], ["'none'"]);
  assert.ok(!policy['script-src'].includes("'unsafe-inline'") && !policy['script-src'].includes("'unsafe-eval'"));

  // Every external script the shell loads is allowed.
  const html = read('index.html');
  for (const src of [...html.matchAll(/<script[^>]+src="(https:\/\/[^"?]+)/g)].map((m) => m[1])) {
    assert.ok(policy['script-src'].some((a) => src.startsWith(a)), `${src} is not in script-src`);
  }
  assert.ok(policy['frame-src'].some((a) => a.includes('accounts.google.com')) && policy['frame-src'].some((a) => a.includes('challenges.cloudflare.com')));
  assert.ok(policy['connect-src'].includes('https://api.postcodes.io')); // snap.js calls it
  assert.match(read('snap.js'), /https:\/\/api\.postcodes\.io/);

  // No inline scripts or inline event handlers on any page.
  for (const file of readdirSync(publicDir).filter((f) => f.endsWith('.html'))) {
    const page = read(file);
    assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} has an inline script`);
    assert.doesNotMatch(page, /\son[a-z]+\s*=/i, `${file} has an inline event handler`);
  }
  // Nothing in the app writes markup from strings.
  for (const file of ['app.js', 'view.js', 'snap.js', 'time.js']) assert.doesNotMatch(read(file), /\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(/, `${file} builds HTML from strings`);
});

test('the other security headers are set', () => {
  const headers = read('_headers');
  for (const h of ['X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', 'Referrer-Policy:', 'Strict-Transport-Security:', 'Permissions-Policy: geolocation=(self)', 'Cross-Origin-Opener-Policy: same-origin-allow-popups']) {
    assert.ok(headers.includes(h), `missing ${h}`);
  }
});

test('the privacy page says what the code actually does', () => {
  const page = read('privacy.html');
  assert.match(page, new RegExp(`${RETENTION.eventDaysAfterStart} days after its start time`));
  assert.match(page, new RegExp(`${RETENTION.resultDays} days after they were worked out`));
  assert.match(page, new RegExp(`after ${RETENTION.inactiveUserDays} days`));
  assert.match(page, /Delete my data/);
  assert.match(read('index.html'), /href="\/privacy\.html"/);
  assert.doesNotMatch(page, /@[a-z0-9.-]+\.[a-z]{2,}/i); // no personal email published on the page
});

test('the cron trigger and logging are configured', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /\[triggers\]\s*\ncrons = \["[^"]+"\]/);
  assert.match(toml, /\[observability\]\s*\nenabled = true/);
  assert.match(toml, /^workers_dev = false/m); // only the custom domain, where zone rules apply
});

// ---------- fixes from the security review ----------

import { upsertUser, verifyGoogleIdToken } from '../src/auth.js';
import { firstName } from '../src/validate.js';
import { readJson } from '../src/util.js';
import { refundDailyBudget, consumeDailyBudget as consumeBudget } from '../src/calculation.js';

async function eventWithTwoLocated() {
  const [alice, bob, carol] = await Promise.all(['alice', 'bob', 'carol'].map(makeUser));
  env.RATE_LIMITS_OFF = '1';
  const code = (await call(alice, 'POST', '/api/events', newEvent())).data.code;
  for (const [u, area, mode] of [[alice, 'stockwell', 'transit'], [bob, 'blackfriars', 'bike'], [carol, 'hampstead', 'transit']]) {
    if (u !== alice) await call(u, 'POST', `/api/events/${code}/join`);
    await call(u, 'PUT', `/api/events/${code}/me`, { areaId: area, mode });
  }
  return { alice, bob, carol, code };
}

test('nobody can read another person\'s longest-journey limit from the results', async () => {
  const { alice, bob, code } = await eventWithTwoLocated();
  await call(bob, 'PUT', `/api/events/${code}/me`, { areaId: 'blackfriars', mode: 'bike', maxMinutes: 10 });
  await call(alice, 'PUT', `/api/events/${code}/me`, { areaId: 'stockwell', mode: 'transit', maxMinutes: 10 });
  await call(alice, 'POST', `/api/events/${code}/calculate`);
  await settle();
  for (const viewer of [alice, bob]) {
    const { text, data } = await call(viewer, 'GET', `/api/events/${code}`);
    assert.equal(data.results.reason, 'no_venue_within_limits');
    assert.doesNotMatch(text, /"limit"/);
  }
});

test('leaving or being removed erases earlier results that mention you, but the run still counts', async () => {
  for (const how of ['leave', 'removed']) {
    db = createTestDb(); // a clean database each round
    env.DB = db;
    const { alice, bob, code } = await eventWithTwoLocated();
    await call(alice, 'POST', `/api/events/${code}/calculate`);
    await settle();
    assert.equal((await call(alice, 'GET', `/api/events/${code}`)).data.run.status, 'done');
    if (how === 'leave') {
      assert.equal((await call(bob, 'DELETE', `/api/events/${code}/me`)).status, 200);
    } else {
      const id = (await call(alice, 'GET', `/api/events/${code}`)).data.participants.find((p) => p.name === 'Bob').id;
      assert.equal((await call(alice, 'DELETE', `/api/events/${code}/participants/${id}`)).status, 200);
    }
    const view = await call(alice, 'GET', `/api/events/${code}`);
    assert.equal(view.data.run.status, 'expired', how);
    assert.equal(view.data.results, null);
    assert.doesNotMatch(view.text, /Bob/);
    assert.equal(view.data.calculation.runsUsed, 1);
    assert.equal(sql("SELECT COUNT(*) AS n FROM calc_runs WHERE result_json IS NOT NULL OR input_snapshot IS NOT NULL").n, 0);
  }
});

test('two simultaneous "Find a spot" presses start one run and spend one unit of budget', async () => {
  const { alice, code } = await eventWithTwoLocated();
  // Hold the first run in flight, as a real one (several seconds of Google calls) would be.
  let release;
  const open = new Promise((r) => { release = r; });
  const places = createFakePlaces();
  env.TEST_PROVIDERS = { places: { name: 'gated', findVenues: async (x) => { await open; return places.findVenues(x); } }, routing: createFakeRouting() };
  const [a, b] = await Promise.all([call(alice, 'POST', `/api/events/${code}/calculate`), call(alice, 'POST', `/api/events/${code}/calculate`)]);
  assert.deepEqual([a.status, b.status].sort(), [202, 409]);
  release();
  await settle();
  assert.equal(count('calc_runs'), 1);
  assert.equal(sql("SELECT count FROM usage_counters WHERE key = 'calculations'").count, 1); // the loser's unit was refunded
  assert.equal(sql('SELECT status FROM events WHERE join_code = ?', code).status, 'open');
});

test('a failure while starting leaves nothing behind: no stuck event, no spent budget', async () => {
  const { alice, code } = await eventWithTwoLocated();
  const realPrepare = db.prepare;
  db.prepare = (q) => {
    if (/UPDATE events SET status = 'calculating'/.test(q)) throw new Error('simulated D1 failure while claiming');
    return realPrepare(q);
  };
  const r = await call(alice, 'POST', `/api/events/${code}/calculate`);
  db.prepare = realPrepare;
  assert.equal(r.status, 500);
  assert.equal(count('calc_runs'), 0);
  assert.equal(sql("SELECT count FROM usage_counters WHERE key = 'calculations'").count, 0);
  assert.equal(sql('SELECT status FROM events WHERE join_code = ?', code).status, 'open');
  assert.equal((await call(alice, 'POST', `/api/events/${code}/calculate`)).status, 202); // and it works afterwards
});

test('an event left "calculating" with no run is freed when it is next read', async () => {
  const { alice, code } = await eventWithTwoLocated();
  db.raw.prepare("UPDATE events SET status = 'calculating' WHERE join_code = ?").run(code);
  const view = await call(alice, 'GET', `/api/events/${code}`);
  assert.equal(view.data.event.status, 'open');
  assert.equal(sql('SELECT status FROM events WHERE join_code = ?', code).status, 'open');
});

test('one account cannot use more than its daily share of calculations', async () => {
  const { alice, code } = await eventWithTwoLocated();
  delete env.RATE_LIMITS_OFF;
  const window = Math.floor(Date.now() / 1000 / 86400);
  db.raw.prepare("INSERT INTO rate_limits (key, window, count, expires_at) VALUES ('calculateDaily:alice', ?, ?, ?)").run(window, RATE_RULES.calculateDaily.limit, (window + 1) * 86400);
  const r = await call(alice, 'POST', `/api/events/${code}/calculate`);
  assert.equal(r.status, 429);
  assert.equal(count('calc_runs'), 0);
});

test('the daily budget can be refunded but never below zero', async () => {
  assert.equal(await consumeBudget(db, 5), true);
  await refundDailyBudget(db);
  await refundDailyBudget(db);
  assert.equal(sql("SELECT count FROM usage_counters WHERE key = 'calculations'").count, 0);
});

test('a Google account with no name never shows its email as a display name', async () => {
  const user = await upsertUser(db, { sub: 'g1', email: 'private.person@example.com', email_verified: true });
  assert.equal(user.name, 'Friend');
  assert.equal((await upsertUser(db, { sub: 'g2', email: 'x@example.com', given_name: 'Sam' })).name, 'Sam');
  assert.equal((await upsertUser(db, { sub: 'g3', email: 'y@example.com', name: '   ' })).name, 'Friend');
  assert.equal(firstName('private.person@example.com'), 'Friend');
  assert.equal(firstName('Sam Jones'), 'Sam');
  assert.equal(firstName(''), 'Friend');
});

test('a body is abandoned as soon as it passes the limit, even with no Content-Length', async () => {
  const stream = (chunks) => new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(new TextEncoder().encode(x)); c.close(); } });
  const req = (body) => new Request(ORIGIN + '/x', { method: 'POST', body, duplex: 'half' });
  assert.deepEqual(await readJson(req(stream(['{"a":', '1}']))), { a: 1 });
  assert.equal(await readJson(req(stream(['{"a":"', 'x'.repeat(6000), 'x'.repeat(6000), '"}']))), null); // 12 KB streamed
  assert.equal(await readJson(req(stream(['[1,2]']))), null);
  assert.equal(await readJson(req(stream(['not json']))), null);
  assert.equal(await readJson(new Request(ORIGIN + '/x', { method: 'POST' })), null);
});

test('forged key ids cannot force a refetch of Google\'s keys every time', async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched++; return new Response(JSON.stringify({ keys: [] }), { status: 200 }); };
  try {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forged = `${b64({ alg: 'RS256', kid: 'forged' })}.${b64({ sub: 'x' })}.AAAA`;
    for (let i = 0; i < 5; i++) await assert.rejects(verifyGoogleIdToken(forged, 'test-client'));
    assert.ok(fetched <= 1, `fetched Google's keys ${fetched} times`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the privacy page does not overstate who can see limits', () => {
  const page = read('privacy.html');
  assert.doesNotMatch(page, /Only you see your own longest-journey setting/);
  assert.match(page, /never see the number you set/i);
});
