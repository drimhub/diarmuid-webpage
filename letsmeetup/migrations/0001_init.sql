-- Users sign in with Google; id is the Google "sub" claim.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL
);

-- Session id is the SHA-256 (hex) of the random cookie token, so a DB leak can't be replayed.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  join_code TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL REFERENCES users (id),
  title TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('lunch', 'dinner', 'drinks')),
  start_at TEXT NOT NULL,                 -- ISO 8601 UTC; displayed as Europe/London
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'calculating', 'done', 'failed', 'closed')),
  max_participants INTEGER NOT NULL DEFAULT 12,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_owner ON events (owner_id);

-- Tag names are validated in code, not in a table.
CREATE TABLE IF NOT EXISTS event_tags (
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (event_id, tag)
);

-- Where someone travels from is only ever a neighbourhood (area_id from areas.json),
-- snapped on the device. Exact coordinates are never stored.
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users (id),     -- nullable so the owner can later add friends without accounts
  display_name TEXT NOT NULL,
  area_id TEXT,                           -- null until they've said where they're travelling from
  mode TEXT NOT NULL DEFAULT 'transit' CHECK (mode IN ('transit', 'bike', 'walk')),
  max_minutes INTEGER,                    -- optional personal travel-time limit
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_event ON participants (event_id);

CREATE TABLE IF NOT EXISTS calc_runs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  heuristics_version TEXT,
  input_snapshot TEXT,                    -- JSON: participants (area_id, mode, limits) at run time
  cost_counters TEXT,                     -- JSON: provider calls made, for cost tracking
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_calc_runs_event ON calc_runs (event_id);

-- Provider-neutral: provider + provider_place_id identify the venue, so the provider can change.
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES calc_runs (id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,
  source_heuristic TEXT,                  -- e.g. 'fastest_overall', 'fairest', 'best_rated'
  provider TEXT NOT NULL,
  provider_place_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  lat REAL,
  lng REAL,
  rating REAL,
  rating_count INTEGER,
  price_level INTEGER,
  maps_url TEXT,
  score REAL,
  score_breakdown TEXT                    -- JSON
);
CREATE INDEX IF NOT EXISTS idx_suggestions_run ON suggestions (run_id);

CREATE TABLE IF NOT EXISTS travel_times (
  suggestion_id TEXT NOT NULL REFERENCES suggestions (id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants (id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  distance_m INTEGER,
  route_summary TEXT,                     -- JSON, e.g. lines used
  depart_at TEXT,
  provider TEXT NOT NULL,
  PRIMARY KEY (suggestion_id, participant_id)
);
