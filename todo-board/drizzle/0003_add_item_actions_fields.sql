ALTER TABLE `items` ADD COLUMN `options` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `items` ADD COLUMN `user_decision` text;
--> statement-breakpoint
ALTER TABLE `items` ADD COLUMN `prioritized_at` text;
--> statement-breakpoint
ALTER TABLE `items` ADD COLUMN `snoozed_at` text;
--> statement-breakpoint
ALTER TABLE `items` ADD COLUMN `cancelled_at` text;
