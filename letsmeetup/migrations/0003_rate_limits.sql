-- Step 8: abuse limits. A fixed-window counter per (key, window); expires_at (epoch seconds) lets the
-- daily retention job clear old windows.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,                       -- e.g. 'createEvent:<user id>' or 'auth:<ip>'
  window INTEGER NOT NULL,                 -- floor(now / window length)
  count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (key, window)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires_at);
