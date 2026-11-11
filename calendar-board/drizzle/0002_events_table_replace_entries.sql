DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time_text TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  tickers TEXT NOT NULL DEFAULT '[]',
  importance TEXT NOT NULL DEFAULT 'normal',
  confirmed INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  source TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
