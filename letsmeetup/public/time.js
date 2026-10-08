// Event times are London times, whatever timezone the browser is in. Pure functions, unit-tested.

const TZ = 'Europe/London';

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function londonParts(ms) {
  const p = {};
  for (const { type, value } of partsFormatter.formatToParts(new Date(ms))) p[type] = Number(value);
  return p;
}

// London's offset from UTC at an instant, in ms (BST = +1h, GMT = 0).
function londonOffsetMs(ms) {
  const p = londonParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// "2026-07-01T19:00" typed by a user (London wall-clock) -> "2026-07-01T18:00:00.000Z", or null.
export function londonLocalToUtcIso(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local || '');
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (!Number.isFinite(wall)) return null;
  let utc = wall - londonOffsetMs(wall);
  utc = wall - londonOffsetMs(utc); // settle across a clock change
  return new Date(utc).toISOString();
}

// e.g. "Thu 8 Oct, 19:00" in London time.
export function formatLondon(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `${date}, ${time}`;
}

// A sensible default for the create form: 19:00 London today, or tomorrow if it's already past 18:00.
export function defaultStartLocal(nowMs = Date.now()) {
  const p = londonParts(nowMs);
  const day = Date.UTC(p.year, p.month - 1, p.day + (p.hour >= 18 ? 1 : 0));
  const d = new Date(day);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T19:00`;
}
