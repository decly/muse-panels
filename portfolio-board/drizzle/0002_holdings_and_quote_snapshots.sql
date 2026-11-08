DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL UNIQUE,
  quote_symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  cost_per_share REAL NOT NULL,
  kind TEXT NOT NULL,
  theme TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE quote_snapshots (
  quote_symbol TEXT PRIMARY KEY,
  price REAL,
  change REAL,
  change_percent REAL,
  high REAL,
  low REAL,
  week_52_high REAL,
  week_52_low REAL,
  market_cap REAL,
  market_status TEXT,
  as_of TEXT,
  fetched_at INTEGER NOT NULL
);
