// Opening-hours logic over the normalised OpeningHours shape (see providers/types.js).
// Times are evaluated in London local time, which is what providers report hours in.

const WEEK = 7 * 1440;
const dayFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Minutes since Sunday 00:00, London local time, for an instant.
export function londonWeekMinute(instant) {
  const d = typeof instant === 'number' ? new Date(instant) : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new RangeError('Invalid time');
  const p = {};
  for (const { type, value } of dayFormat.formatToParts(d)) p[type] = value;
  return WEEKDAYS[p.weekday] * 1440 + Number(p.hour) * 60 + Number(p.minute);
}

// [start, end) in week minutes; end may exceed WEEK when a period wraps past Saturday night.
function span(period) {
  const start = period.open.day * 1440 + period.open.minute;
  if (!period.close) return [0, WEEK]; // open 24 hours
  let end = period.close.day * 1440 + period.close.minute;
  if (end <= start) end += WEEK;
  return [start, end];
}

// Minutes until the venue closes if it is open at `instant`; Infinity if open round the clock;
// 0 if closed; null if the opening hours are unknown.
export function minutesOpenFrom(hours, instant) {
  if (!hours || !Array.isArray(hours.periods) || hours.periods.length === 0) return null;
  const t = londonWeekMinute(instant);
  let best = 0;
  for (const period of hours.periods) {
    const [start, end] = span(period);
    if (!period.close) return Infinity;
    for (const shift of [0, WEEK]) {
      const x = t + shift;
      if (x >= start && x < end) best = Math.max(best, end - x);
    }
  }
  return best;
}

// true / false, or null when hours are unknown.
export function isOpenAt(hours, instant) {
  const m = minutesOpenFrom(hours, instant);
  return m === null ? null : m > 0;
}
