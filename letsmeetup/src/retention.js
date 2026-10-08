// The daily clean-up (a Cron Trigger, see wrangler.toml). Keeps only what is still useful, and
// keeps Google place details no longer than Google's caching terms allow.

export const RETENTION = {
  eventDaysAfterStart: 30,   // an event and everything attached to it is deleted this long after it starts
  resultDays: 30,            // stored suggestions (Google place details) are erased this long after the run
  inactiveUserDays: 90,      // accounts with no events, no sessions and no participation
  counterDays: 35,           // daily usage counters
};

const DAY = 86400 * 1000;

export async function runRetention(env, nowMs = Date.now()) {
  const db = env.DB;
  const iso = (ms) => new Date(ms).toISOString();
  const changes = async (stmt) => (await stmt.run()).meta.changes;
  const out = {};

  // Events past their date (participants, tags and runs go with them via ON DELETE CASCADE).
  out.events = await changes(db.prepare('DELETE FROM events WHERE start_at < ?').bind(iso(nowMs - RETENTION.eventDaysAfterStart * DAY)));

  // Results older than the limit: erase the Google-derived content but keep the run's own record.
  out.results = await changes(db.prepare('UPDATE calc_runs SET result_json = NULL WHERE result_json IS NOT NULL AND finished_at < ?').bind(iso(nowMs - RETENTION.resultDays * DAY)));

  out.sessions = await changes(db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(iso(nowMs)));
  out.rateLimits = await changes(db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(Math.floor(nowMs / 1000)));
  out.counters = await changes(db.prepare('DELETE FROM usage_counters WHERE day < ?').bind(iso(nowMs - RETENTION.counterDays * DAY).slice(0, 10)));

  out.users = await changes(db.prepare(
    `DELETE FROM users WHERE created_at < ?
       AND NOT EXISTS (SELECT 1 FROM participants WHERE user_id = users.id)
       AND NOT EXISTS (SELECT 1 FROM events WHERE owner_id = users.id)
       AND NOT EXISTS (SELECT 1 FROM sessions WHERE user_id = users.id)`,
  ).bind(iso(nowMs - RETENTION.inactiveUserDays * DAY)));

  console.log(JSON.stringify({ event: 'retention', ...out }));
  return out;
}
