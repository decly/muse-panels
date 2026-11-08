CREATE TABLE `accounts` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `sort` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `holdings_new` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` text NOT NULL DEFAULT 'broker-a',
  `symbol` text NOT NULL,
  `quote_symbol` text NOT NULL,
  `name` text NOT NULL,
  `qty` real NOT NULL,
  `cost_per_share` real NOT NULL,
  `kind` text NOT NULL,
  `theme` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `holdings_new` (`id`, `account_id`, `symbol`, `quote_symbol`, `name`, `qty`, `cost_per_share`, `kind`, `theme`)
SELECT `id`, 'broker-a', `symbol`, `quote_symbol`, `name`, `qty`, `cost_per_share`, `kind`, `theme` FROM `holdings`;
--> statement-breakpoint
DROP TABLE `holdings`;
--> statement-breakpoint
ALTER TABLE `holdings_new` RENAME TO `holdings`;
--> statement-breakpoint
CREATE UNIQUE INDEX `holdings_account_symbol_unique` ON `holdings` (`account_id`, `symbol`);
--> statement-breakpoint
CREATE TABLE `account_balances_new` (
  `account_id` text PRIMARY KEY NOT NULL,
  `cash_usd` real NOT NULL,
  `snapshot_label` text NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `account_balances_new` (`account_id`, `cash_usd`, `snapshot_label`, `updated_at`)
SELECT 'broker-a', `cash_usd`, `snapshot_label`, `updated_at` FROM `account_balances`;
--> statement-breakpoint
DROP TABLE `account_balances`;
--> statement-breakpoint
ALTER TABLE `account_balances_new` RENAME TO `account_balances`;
--> statement-breakpoint
CREATE TABLE `daily_snapshots_new` (
  `date` text NOT NULL,
  `account_id` text NOT NULL DEFAULT 'broker-a',
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
  `created_at` integer NOT NULL,
  PRIMARY KEY (`date`, `account_id`)
);
--> statement-breakpoint
INSERT INTO `daily_snapshots_new` (`date`, `account_id`, `account_value_usd`, `securities_value_usd`, `cash_usd`, `total_pnl_usd`, `day_change_usd`, `day_change_pct`, `fx_rate`, `account_value_cny`, `spx_price`, `ndx_price`, `source`, `created_at`)
SELECT `date`, 'broker-a', `account_value_usd`, `securities_value_usd`, `cash_usd`, `total_pnl_usd`, `day_change_usd`, `day_change_pct`, `fx_rate`, `account_value_cny`, `spx_price`, `ndx_price`, `source`, `created_at` FROM `daily_snapshots`;
--> statement-breakpoint
DROP TABLE `daily_snapshots`;
--> statement-breakpoint
ALTER TABLE `daily_snapshots_new` RENAME TO `daily_snapshots`;
