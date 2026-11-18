ALTER TABLE quote_snapshots ADD COLUMN after_price REAL;
--> statement-breakpoint
ALTER TABLE quote_snapshots ADD COLUMN after_change_percent REAL;
--> statement-breakpoint
ALTER TABLE quote_snapshots ADD COLUMN after_as_of TEXT;
--> statement-breakpoint
ALTER TABLE quote_snapshots ADD COLUMN source TEXT;
--> statement-breakpoint
CREATE TABLE fx_snapshots (
  pair TEXT PRIMARY KEY,
  rate REAL,
  source TEXT,
  as_of TEXT,
  fetched_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE account_balances (
  id INTEGER PRIMARY KEY,
  cash_usd REAL NOT NULL,
  snapshot_label TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO account_balances (id, cash_usd, snapshot_label, updated_at) VALUES (1, 800.00, 'demo cash balance', 1794062100000);
