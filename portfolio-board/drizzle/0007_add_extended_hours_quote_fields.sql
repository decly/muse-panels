ALTER TABLE `quote_snapshots` ADD COLUMN `ext_price` real;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `ext_change_percent` real;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `ext_as_of` text;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `ext_session` text;
