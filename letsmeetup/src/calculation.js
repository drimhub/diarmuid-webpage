// Running the calculation for an event: guards, the run record, the background work, and cleanup.
// A run is one row in calc_runs; the event's status is 'calculating' while it runs and goes back to
// whatever it was (open or locked) when it ends, however it ends.

import { AREAS } from './areas.js';
import { computeSuggestions } from './calc/index.js';
import { HEURISTICS_VERSION } from './calc/config.js';
import { createProviders } from './providers/index.js';
import { newId } from './util.js';

export const RUN_LIMITS = {
  runsPerEvent: 5,          // every run counts, including failed ones (they spend API calls too)
  dailyCalculations: 30,    // whole service; overridable with the CALC_DAILY_LIMIT variable
  staleAfterMs: 5 * 60 * 1000,
  minLocated: 2,
  startGraceMs: 15 * 60 * 1000,
};

const now = () => new Date().toISOString();

// Marks runs that never finished as failed and gives the event its status back.
export async function reapStaleRuns(db, eventId, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - RUN_LIMITS.staleAfterMs).toISOString();
  const { results } = await db
    .prepare("SELECT id, prior_status FROM calc_runs WHERE event_id = ? AND status = 'running' AND started_at < ?")
    .bind(eventId, cutoff)
    .all();
  for (const run of results) await finishRun(db, run.id, eventId, run.prior_status, 'failed', { error: 'Timed out' });
  return results.length;
}

async function finishRun(db, runId, eventId, priorStatus, status, { result, error, cost } = {}) {
  const res = await db
    .prepare(
      `UPDATE calc_runs SET status = ?, finished_at = ?, heuristics_version = ?, cost_counters = ?, result_json = ?, error = ?
       WHERE id = ? AND status = 'running'`,
    )
    .bind(status, now(), HEURISTICS_VERSION, cost ? JSON.stringify(cost) : null, result ? JSON.stringify(result) : null, error || null, runId)
    .run();
  if (res.meta.changes) {
    await db.prepare("UPDATE events SET status = ? WHERE id = ? AND status = 'calculating'").bind(priorStatus === 'closed' ? 'closed' : 'open', eventId).run();
  }
}

// One calculation per UTC day budget for the whole service. Returns false when it is used up.
export async function consumeDailyBudget(db, limit, nowMs = Date.now()) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, key, count) VALUES (?, 'calculations', 1)
       ON CONFLICT (day, key) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(day, limit)
    .first();
  return !!row;
}

// Validates and starts a run. Returns { ok: true, runId } or { ok: false, status, error }.
export async function startRun(env, event, participants) {
  const db = env.DB;
  if (!env.TEST_PROVIDERS && !env.GOOGLE_MAPS_API_KEY) return { ok: false, status: 503, error: 'Suggestions are not available yet.' };

  await reapStaleRuns(db, event.id);
  const fresh = await db.prepare('SELECT status FROM events WHERE id = ?').bind(event.id).first();
  if (fresh.status === 'calculating') return { ok: false, status: 409, error: 'A calculation is already running.' };
  if (fresh.status !== 'open' && fresh.status !== 'closed') return { ok: false, status: 409, error: 'The event cannot be calculated right now.' };

  if (Date.parse(event.start_at) < Date.now() - RUN_LIMITS.startGraceMs) return { ok: false, status: 400, error: 'This event has already started.' };

  const located = participants.filter((p) => p.area_id);
  if (located.length < RUN_LIMITS.minLocated) return { ok: false, status: 400, error: 'At least two people need to say where they are travelling from.' };

  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM calc_runs WHERE event_id = ?').bind(event.id).first();
  if (n >= RUN_LIMITS.runsPerEvent) return { ok: false, status: 429, error: 'This event has used all of its calculations.' };

  const limit = Number(env.CALC_DAILY_LIMIT) || RUN_LIMITS.dailyCalculations;
  if (!(await consumeDailyBudget(db, limit))) return { ok: false, status: 429, error: 'Suggestions are paused for today. Please try again tomorrow.' };

  // Claim the event; if two requests race, only one gets past this.
  const claimed = await db.prepare("UPDATE events SET status = 'calculating' WHERE id = ? AND status IN ('open', 'closed')").bind(event.id).run();
  if (!claimed.meta.changes) return { ok: false, status: 409, error: 'A calculation is already running.' };

  const tags = (await db.prepare('SELECT tag FROM event_tags WHERE event_id = ? ORDER BY tag').bind(event.id).all()).results.map((t) => t.tag);
  const snapshot = {
    event: { eventType: event.event_type, startAt: event.start_at, tags },
    participants: located.map((p) => ({ id: p.id, name: p.display_name, areaId: p.area_id, mode: p.mode, maxMinutes: p.max_minutes })),
  };
  const runId = newId();
  try {
    await db
      .prepare("INSERT INTO calc_runs (id, event_id, status, started_at, prior_status, input_snapshot) VALUES (?, ?, 'running', ?, ?, ?)")
      .bind(runId, event.id, now(), fresh.status, JSON.stringify(snapshot))
      .run();
  } catch (e) {
    await db.prepare("UPDATE events SET status = ? WHERE id = ? AND status = 'calculating'").bind(fresh.status, event.id).run();
    throw e;
  }
  return { ok: true, runId };
}

// The background work. Never throws: any failure is recorded on the run.
export async function executeRun(env, runId) {
  const db = env.DB;
  const run = await db.prepare('SELECT * FROM calc_runs WHERE id = ?').bind(runId).first();
  if (!run || run.status !== 'running') return;
  try {
    const snap = JSON.parse(run.input_snapshot);
    const providers = env.TEST_PROVIDERS || createProviders(env);
    const result = await computeSuggestions({
      event: snap.event,
      participants: snap.participants.map((p) => ({ id: p.id, areaId: p.areaId, mode: p.mode, maxMinutes: p.maxMinutes })),
      areas: AREAS,
      providers,
    });
    await finishRun(db, runId, run.event_id, run.prior_status, 'done', { result, cost: result.cost });
  } catch (e) {
    console.error('calculation failed', runId, e && e.name, e && e.message); // details stay in the logs, never in the response
    await finishRun(db, runId, run.event_id, run.prior_status, 'failed', { error: String((e && e.name) || 'Error').slice(0, 80) });
  }
}
