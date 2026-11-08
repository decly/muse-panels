CREATE TABLE `daily_snapshots` (
  `date` text PRIMARY KEY NOT NULL,
  `account_value_usd` real NOT NULL,
  `securities_value_usd` real NOT NULL,
  `cash_usd` real NOT NULL,
  `total_pnl_usd` real,
  `day_change_usd` real,
  `day_change_pct` real,
  `fx_rate` real,
  `account_value_cny` real,
  `spx_price` real,
  `ndx_price` real,
  `source` text NOT NULL,
  `created_at` integer NOT NULL
);
