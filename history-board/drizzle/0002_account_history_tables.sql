DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE daily_snapshots (
  date TEXT PRIMARY KEY,
  account_value_usd REAL NOT NULL,
  securities_value_usd REAL NOT NULL,
  cash_usd REAL NOT NULL,
  total_pnl_usd REAL,
  day_change_usd REAL,
  day_change_pct REAL,
  fx_rate REAL,
  account_value_cny REAL,
  spx_price REAL,
  ndx_price REAL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
