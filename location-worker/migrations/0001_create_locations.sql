CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  lat REAL NOT NULL,
  long REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locations_timestamp ON locations (timestamp);
