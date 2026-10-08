// /api/events/* handlers. The caller (index.js) has already authenticated `user`.
//
// Privacy rules enforced here:
//  - the server only ever receives an area id, never coordinates (see validate.js);
//  - someone who merely has the link sees the event basics and a head-count;
//  - participants see first names, areas and modes of the others, nothing else.

import { getArea } from './areas.js';
import { error, json, newId, randomCode, readJson } from './util.js';
import { verifyTurnstile } from './turnstile.js';
import { LIMITS, firstName, validateGuest, validateMe, validateNewEvent } from './validate.js';
import { RUN_LIMITS, executeRun, reapStaleRuns, startRun } from './calculation.js';
import { shapeRun } from './results.js';
import { limited } from './ratelimit.js';

const nowIso = () => new Date().toISOString();
const CODE = '([a-z2-7]{10})';
const UUID = '([0-9a-f-]{36})';

// Earlier suggestions mention the people who were in the event then (first names, journey times).
// When someone leaves or is removed those are erased; the run itself stays so it still counts
// towards the event's cap. The page shows them as expired and the organiser can run it again.
const clearStoredResults = (db, eventId) =>
  db.prepare("UPDATE calc_runs SET result_json = NULL, input_snapshot = NULL WHERE event_id = ? AND status != 'running'").bind(eventId);

const loadEvent = (db, code) => db.prepare('SELECT * FROM events WHERE join_code = ?').bind(code).first();
const loadMe = (db, eventId, userId) =>
  db.prepare('SELECT * FROM participants WHERE event_id = ? AND user_id = ?').bind(eventId, userId).first();

export async function handleEvents(request, env, url, user, ctx) {
  const { pathname } = url;
  const method = request.method;
  let m;

  if (method !== 'GET') {
    const tooMany = await limited(env, 'mutate', user.id);
    if (tooMany) return tooMany;
  }

  if (pathname === '/api/events') {
    if (method === 'GET') return listEvents(env, user);
    if (method === 'POST') return createEvent(request, env, user);
    return error('Method not allowed', 405);
  }
  if ((m = pathname.match(new RegExp(`^/api/events/${CODE}$`)))) {
    if (method === 'GET') return getEvent(env, user, m[1]);
    if (method === 'DELETE') return deleteEvent(env, user, m[1]);
    return error('Method not allowed', 405);
  }
  if ((m = pathname.match(new RegExp(`^/api/events/${CODE}/join$`)))) {
    return method === 'POST' ? joinEvent(env, user, m[1]) : error('Method not allowed', 405);
  }
  if ((m = pathname.match(new RegExp(`^/api/events/${CODE}/me$`)))) {
    if (method === 'PUT') return setMe(request, env, user, m[1]);
    if (method === 'DELETE') return leaveEvent(env, user, m[1]);
    return error('Method not allowed', 405);
  }
  if ((m = pathname.match(new RegExp(`^/api/events/${CODE}/calculate$`)))) {
    return method === 'POST' ? calculate(env, ctx, user, m[1]) : error('Method not allowed', 405);
  }
  if ((m = pathname.match(new RegExp(`^/api/events/${CODE}/guests$`)))) {
    return method === 'POST' ? addGuest(request, env, user, m[1]) : error('Method not allowed', 405);
  }
  if ((m = pathname.match(new RegExp(`^/api/events/${CODE}/guests/${UUID}$`)))) {
    return method === 'PUT' ? editGuest(request, env, user, m[1], m[2]) : error('Method not allowed', 405);
  }
  if ((m = pathname.match(new RegExp(`^/api/events/${CODE}/lock$`)))) {
    return method === 'POST' ? setLocked(request, env, user, m[1]) : error('Method not allowed', 405);
  }
  if ((m = pathname.match(new RegExp(`^/api/events/${CODE}/participants/${UUID}$`)))) {
    return method === 'DELETE' ? removeParticipant(env, user, m[1], m[2]) : error('Method not allowed', 405);
  }
  return error('Not found', 404);
}

async function createEvent(request, env, user) {
  const tooMany = await limited(env, 'createEvent', user.id);
  if (tooMany) return tooMany;
  const body = await readJson(request);
  if (!body) return error('Invalid request', 400);

  const human = await verifyTurnstile(body.turnstileToken, env, request.headers.get('CF-Connecting-IP'));
  if (!human) return error('Verification failed, please try again', 400);

  const parsed = validateNewEvent(body);
  if (parsed.error) return error(parsed.error, 400);
  const { title, eventType, startAt, tags } = parsed.value;

  const since = new Date(Date.now() - 86400 * 1000).toISOString();
  const { n } = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM events WHERE owner_id = ? AND created_at > ?')
    .bind(user.id, since)
    .first();
  if (n >= LIMITS.eventsPerUserPerDay) return error('You have created a lot of events today, try again tomorrow', 429);

  const now = nowIso();
  for (let attempt = 0; attempt < 3; attempt++) {
    const eventId = newId();
    const code = randomCode();
    try {
      await env.DB.batch([
        env.DB
          .prepare(
            `INSERT INTO events (id, join_code, owner_id, title, event_type, start_at, status, max_participants, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
          )
          .bind(eventId, code, user.id, title, eventType, startAt, LIMITS.maxParticipants, now),
        ...tags.map((tag) => env.DB.prepare('INSERT INTO event_tags (event_id, tag) VALUES (?, ?)').bind(eventId, tag)),
        env.DB
          .prepare(
            `INSERT INTO participants (id, event_id, user_id, display_name, mode, joined_at, updated_at)
             VALUES (?, ?, ?, ?, 'transit', ?, ?)`,
          )
          .bind(newId(), eventId, user.id, firstName(user.name), now, now),
      ]);
      return json({ code }, 201);
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message))) throw e; // share-code collision: try another code
    }
  }
  return error('Could not create the event, please try again', 500);
}

async function listEvents(env, user) {
  const { results } = await env.DB
    .prepare(
      `SELECT e.join_code, e.title, e.event_type, e.start_at, e.status, e.owner_id,
              (SELECT COUNT(*) FROM participants WHERE event_id = e.id) AS participant_count
       FROM events e JOIN participants p ON p.event_id = e.id AND p.user_id = ?
       ORDER BY e.start_at DESC LIMIT 50`,
    )
    .bind(user.id)
    .all();
  return json({
    events: results.map((r) => ({
      code: r.join_code,
      title: r.title,
      eventType: r.event_type,
      startAt: r.start_at,
      status: r.status,
      isOwner: r.owner_id === user.id,
      participantCount: r.participant_count,
    })),
  });
}

async function getEvent(env, user, code) {
  const ev = await loadEvent(env.DB, code);
  if (!ev) return error('Event not found', 404);

  const [me, tagRows, ownerRow, countRow] = await Promise.all([
    loadMe(env.DB, ev.id, user.id),
    env.DB.prepare('SELECT tag FROM event_tags WHERE event_id = ? ORDER BY tag').bind(ev.id).all(),
    env.DB.prepare('SELECT display_name FROM participants WHERE event_id = ? AND user_id = ?').bind(ev.id, ev.owner_id).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?').bind(ev.id).first(),
  ]);

  const event = {
    code: ev.join_code,
    title: ev.title,
    eventType: ev.event_type,
    startAt: ev.start_at,
    status: ev.status,
    maxParticipants: ev.max_participants,
    tags: tagRows.results.map((t) => t.tag),
    ownerName: ownerRow ? ownerRow.display_name : 'Someone',
    participantCount: countRow.n,
  };

  // Link holders who haven't joined only get the basics.
  if (!me) return json({ event, me: null });

  // A run that never finished (the Worker was cut off) must not leave the event stuck.
  if (await reapStaleRuns(env.DB, ev.id)) {
    event.status = (await env.DB.prepare('SELECT status FROM events WHERE id = ?').bind(ev.id).first()).status;
  }

  const { results } = await env.DB
    .prepare('SELECT id, user_id, display_name, area_id, mode, max_minutes FROM participants WHERE event_id = ? ORDER BY joined_at, id')
    .bind(ev.id)
    .all();

  const latest = await env.DB.prepare('SELECT * FROM calc_runs WHERE event_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').bind(ev.id).first();
  const runCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM calc_runs WHERE event_id = ?').bind(ev.id).first();
  const shaped = shapeRun(latest, {
    currentParticipants: results.map((p) => ({ id: p.id, areaId: p.area_id, mode: p.mode, maxMinutes: p.max_minutes })),
    event: { startAt: ev.start_at, eventType: ev.event_type, tags: event.tags },
  });

  return json({
    event,
    run: shaped.run,
    results: shaped.results,
    calculation: { runsUsed: runCount.n, runsMax: RUN_LIMITS.runsPerEvent, locatedCount: results.filter((p) => p.area_id).length, minLocated: RUN_LIMITS.minLocated },
    me: {
      participantId: me.id,
      isOwner: ev.owner_id === user.id,
      areaId: me.area_id,
      mode: me.mode,
      maxMinutes: me.max_minutes,
    },
    participants: results.map((p) => ({
      id: p.id,
      name: p.display_name,
      isOwner: p.user_id === ev.owner_id,
      isMe: p.user_id === user.id,
      areaId: p.area_id,
      areaName: p.area_id ? (getArea(p.area_id) || {}).name || null : null,
      mode: p.mode,
      hasLocation: !!p.area_id,
      isGuest: p.user_id === null,
      ...(p.user_id === null && ev.owner_id === user.id ? { maxMinutes: p.max_minutes } : {}),
    })),
  });
}

async function joinEvent(env, user, code) {
  const tooMany = await limited(env, 'join', user.id);
  if (tooMany) return tooMany;
  const ev = await loadEvent(env.DB, code);
  if (!ev) return error('Event not found', 404);

  const existing = await loadMe(env.DB, ev.id, user.id);
  if (existing) return json({ joined: true });
  if (ev.status !== 'open') return error('This event is not accepting new people', 409);

  const now = nowIso();
  // Conditional insert so two people racing for the last place can't exceed the cap.
  const res = await env.DB
    .prepare(
      `INSERT OR IGNORE INTO participants (id, event_id, user_id, display_name, mode, joined_at, updated_at)
       SELECT ?, ?, ?, ?, 'transit', ?, ?
       WHERE (SELECT COUNT(*) FROM participants WHERE event_id = ?) < ?`,
    )
    .bind(newId(), ev.id, user.id, firstName(user.name), now, now, ev.id, ev.max_participants)
    .run();
  if (!res.meta.changes) {
    return (await loadMe(env.DB, ev.id, user.id)) ? json({ joined: true }) : error('This event is full', 409);
  }
  return json({ joined: true }, 201);
}

async function setMe(request, env, user, code) {
  const ev = await loadEvent(env.DB, code);
  if (!ev) return error('Event not found', 404);
  const me = await loadMe(env.DB, ev.id, user.id);
  if (!me) return error('Join the event first', 403);
  if (ev.status === 'calculating') return error('Suggestions are being worked out, try again in a moment', 409);
  if (ev.status !== 'open') return error('This event is locked', 409);

  const body = await readJson(request);
  if (!body) return error('Invalid request', 400);
  const parsed = validateMe(body);
  if (parsed.error) return error(parsed.error, 400);
  const { areaId, mode, maxMinutes } = parsed.value;

  await env.DB
    .prepare('UPDATE participants SET area_id = ?, mode = ?, max_minutes = ?, updated_at = ? WHERE id = ?')
    .bind(areaId, mode, maxMinutes, nowIso(), me.id)
    .run();
  return json({ ok: true });
}

async function leaveEvent(env, user, code) {
  const ev = await loadEvent(env.DB, code);
  if (!ev) return error('Event not found', 404);
  if (ev.owner_id === user.id) return error('The organiser cannot leave; delete the event instead', 400);
  if (ev.status === 'calculating') return error('A calculation is running, try again in a moment', 409);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM participants WHERE event_id = ? AND user_id = ?').bind(ev.id, user.id),
    clearStoredResults(env.DB, ev.id),
  ]);
  return json({ ok: true });
}

async function setLocked(request, env, user, code) {
  const ev = await loadEvent(env.DB, code);
  if (!ev) return error('Event not found', 404);
  if (ev.owner_id !== user.id) return error('Only the organiser can do that', 403);

  const body = await readJson(request);
  if (!body || typeof body.locked !== 'boolean') return error('Invalid request', 400);
  if (ev.status !== 'open' && ev.status !== 'closed') return error('The event cannot be changed right now', 409);

  const status = body.locked ? 'closed' : 'open';
  await env.DB.prepare('UPDATE events SET status = ? WHERE id = ?').bind(status, ev.id).run();
  return json({ status });
}

async function removeParticipant(env, user, code, participantId) {
  const ev = await loadEvent(env.DB, code);
  if (!ev) return error('Event not found', 404);
  if (ev.owner_id !== user.id) return error('Only the organiser can do that', 403);
  if (ev.status === 'calculating') return error('A calculation is running, try again in a moment', 409);

  const target = await env.DB
    .prepare('SELECT id, user_id FROM participants WHERE id = ? AND event_id = ?')
    .bind(participantId, ev.id)
    .first();
  if (!target) return error('Not found', 404);
  if (target.user_id === ev.owner_id) return error('You cannot remove the organiser', 400);

  await env.DB.batch([
    env.DB.prepare('DELETE FROM participants WHERE id = ?').bind(target.id),
    clearStoredResults(env.DB, ev.id),
  ]);
  return json({ ok: true });
}

async function deleteEvent(env, user, code) {
  const ev = await loadEvent(env.DB, code);
  if (!ev) return error('Event not found', 404);
  if (ev.owner_id !== user.id) return error('Only the organiser can do that', 403);
  await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(ev.id).run(); // cascades to everything else
  return json({ ok: true });
}

async function calculate(env, ctx, user, code) {
  const ev = await loadEvent(env.DB, code);
  if (!ev) return error('Event not found', 404);
  if (ev.owner_id !== user.id) return error('Only the organiser can do that', 403);
  const tooMany = (await limited(env, 'calculate', user.id)) || (await limited(env, 'calculateDaily', user.id));
  if (tooMany) return tooMany;

  const { results } = await env.DB
    .prepare('SELECT id, display_name, area_id, mode, max_minutes FROM participants WHERE event_id = ?')
    .bind(ev.id)
    .all();
  const started = await startRun(env, ev, results);
  if (!started.ok) return error(started.error, started.status);

  // Answer straight away; the work carries on in the background and the page polls for it.
  const work = executeRun(env, started.runId);
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  else await work;
  return json({ runId: started.runId }, 202);
}

// ---- people the organiser adds without them signing in ----
// A "guest" is a participants row with no user. They never see the event; the organiser speaks for
// them. They count towards the cap and are planned for exactly like anyone else.

async function guestPreconditions(env, user, code) {
  const ev = await loadEvent(env.DB, code);
  if (!ev) return { response: error('Event not found', 404) };
  if (ev.owner_id !== user.id) return { response: error('Only the organiser can do that', 403) };
  if (ev.status === 'calculating') return { response: error('Suggestions are being worked out, try again in a moment', 409) };
  if (ev.status !== 'open') return { response: error('This event is locked', 409) };
  return { ev };
}

async function addGuest(request, env, user, code) {
  const tooMany = await limited(env, 'addGuest', user.id);
  if (tooMany) return tooMany;
  const pre = await guestPreconditions(env, user, code);
  if (pre.response) return pre.response;
  const { ev } = pre;

  const body = await readJson(request);
  if (!body) return error('Invalid request', 400);
  const parsed = validateGuest(body);
  if (parsed.error) return error(parsed.error, 400);
  const { name, areaId, mode, maxMinutes } = parsed.value;

  const id = newId();
  const now = nowIso();
  // Conditional insert so guests and sign-ins racing for the last place can't exceed the cap.
  const res = await env.DB
    .prepare(
      `INSERT INTO participants (id, event_id, user_id, display_name, area_id, mode, max_minutes, joined_at, updated_at)
       SELECT ?, ?, NULL, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM participants WHERE event_id = ?) < ?`,
    )
    .bind(id, ev.id, name, areaId, mode, maxMinutes, now, now, ev.id, ev.max_participants)
    .run();
  if (!res.meta.changes) return error('This event is full', 409);
  return json({ id }, 201);
}

async function editGuest(request, env, user, code, participantId) {
  const tooMany = await limited(env, 'addGuest', user.id);
  if (tooMany) return tooMany;
  const pre = await guestPreconditions(env, user, code);
  if (pre.response) return pre.response;
  const { ev } = pre;

  const body = await readJson(request);
  if (!body) return error('Invalid request', 400);
  const parsed = validateGuest(body);
  if (parsed.error) return error(parsed.error, 400);
  const { name, areaId, mode, maxMinutes } = parsed.value;

  // user_id IS NULL: this route can only ever change guests, never a signed-in person.
  const res = await env.DB
    .prepare('UPDATE participants SET display_name = ?, area_id = ?, mode = ?, max_minutes = ?, updated_at = ? WHERE id = ? AND event_id = ? AND user_id IS NULL')
    .bind(name, areaId, mode, maxMinutes, nowIso(), participantId, ev.id)
    .run();
  if (!res.meta.changes) return error('Guest not found', 404);
  return json({ ok: true });
}
