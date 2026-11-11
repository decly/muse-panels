CREATE TABLE `action_log` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `at` text NOT NULL,
  `action` text NOT NULL,
  `item_id` integer,
  `ok` integer NOT NULL,
  `detail` text DEFAULT '' NOT NULL
);
