DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  key_numbers TEXT,
  note TEXT NOT NULL,
  tickers TEXT NOT NULL DEFAULT '[]',
  event_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE strip_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  items TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
