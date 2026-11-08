CREATE TABLE daily_snapshots_new (
  account_id TEXT NOT NULL DEFAULT 'broker-a',
  date TEXT NOT NULL,
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
  created_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, date)
);
--> statement-breakpoint
INSERT INTO daily_snapshots_new (account_id, date, account_value_usd, securities_value_usd, cash_usd, total_pnl_usd, day_change_usd, day_change_pct, fx_rate, account_value_cny, spx_price, ndx_price, source, created_at)
SELECT 'broker-a', date, account_value_usd, securities_value_usd, cash_usd, total_pnl_usd, day_change_usd, day_change_pct, fx_rate, account_value_cny, spx_price, ndx_price, source, created_at FROM daily_snapshots;
--> statement-breakpoint
DROP TABLE daily_snapshots;
--> statement-breakpoint
ALTER TABLE daily_snapshots_new RENAME TO daily_snapshots;
