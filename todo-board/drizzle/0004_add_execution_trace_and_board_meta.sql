ALTER TABLE `items` ADD COLUMN `executed_at` text;
--> statement-breakpoint
ALTER TABLE `items` ADD COLUMN `execution_result` text;
--> statement-breakpoint
CREATE TABLE `board_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
