-- Step 7: running the calculation.

-- The event's status before a run started (open or closed), restored when the run ends.
ALTER TABLE calc_runs ADD COLUMN prior_status TEXT;

-- The whole result as JSON (suggestions, notes, reasons, costs). The suggestions and travel_times
-- tables from 0001 are not used yet; they are reserved for things like voting.
ALTER TABLE calc_runs ADD COLUMN result_json TEXT;

-- Per-day usage counters, used to cap how many calculations the whole service runs in a day
-- (a hard stop on Google API spend, whatever else goes wrong).
CREATE TABLE IF NOT EXISTS usage_counters (
  day TEXT NOT NULL,                       -- UTC date, YYYY-MM-DD
  key TEXT NOT NULL,                       -- e.g. 'calculations'
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, key)
);
