DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  qty REAL NOT NULL,
  cost_per_share REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'etf'
);
--> statement-breakpoint
CREATE UNIQUE INDEX holdings_symbol_unique ON holdings (symbol);
--> statement-breakpoint
CREATE TABLE quote_snapshots (
  symbol TEXT PRIMARY KEY,
  price REAL,
  change REAL,
  change_percent REAL,
  prev_close REAL,
  as_of TEXT,
  quote_date TEXT,
  source TEXT,
  fetched_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE account_state (
  id INTEGER PRIMARY KEY,
  cash_cny REAL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE market_snapshots (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  secid TEXT NOT NULL,
  price REAL,
  change REAL,
  change_percent REAL,
  as_of TEXT,
  peak3y_price REAL,
  peak3y_date TEXT,
  fetched_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE daily_snapshots (
  date TEXT PRIMARY KEY,
  account_value_cny REAL NOT NULL,
  securities_value_cny REAL NOT NULL,
  cash_cny REAL NOT NULL,
  total_pnl_cny REAL,
  day_change_cny REAL,
  day_change_pct REAL,
  csi300_price REAL,
  csi300_change_pct REAL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL,
  price_kind TEXT NOT NULL,
  source TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
