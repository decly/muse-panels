ALTER TABLE `quote_snapshots` ADD COLUMN `pre_price` real;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `pre_change_percent` real;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `pre_as_of` text;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `post_price` real;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `post_change_percent` real;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `post_as_of` text;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `overnight_price` real;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `overnight_change_percent` real;
--> statement-breakpoint
ALTER TABLE `quote_snapshots` ADD COLUMN `overnight_as_of` text;
--> statement-breakpoint
UPDATE `quote_snapshots` SET `post_price` = `after_price`, `post_change_percent` = `after_change_percent`, `post_as_of` = `after_as_of` WHERE `after_price` IS NOT NULL;
--> statement-breakpoint
UPDATE `quote_snapshots` SET `post_price` = `ext_price`, `post_change_percent` = `ext_change_percent`, `post_as_of` = `ext_as_of` WHERE `post_price` IS NULL AND `ext_session` = 'post' AND `ext_price` IS NOT NULL;
--> statement-breakpoint
UPDATE `quote_snapshots` SET `overnight_price` = `ext_price`, `overnight_change_percent` = `ext_change_percent`, `overnight_as_of` = `ext_as_of` WHERE `ext_session` = 'overnight' AND `ext_price` IS NOT NULL;
--> statement-breakpoint
UPDATE `quote_snapshots` SET `pre_price` = `ext_price`, `pre_change_percent` = `ext_change_percent`, `pre_as_of` = `ext_as_of` WHERE `ext_session` = 'pre' AND `ext_price` IS NOT NULL;
