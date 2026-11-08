CREATE TABLE market_snapshots (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  price REAL,
  change REAL,
  change_percent REAL,
  as_of TEXT,
  source TEXT,
  note TEXT,
  fetched_at INTEGER NOT NULL
);
