CREATE TABLE `trades` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `account_id` text NOT NULL DEFAULT 'broker-a',
  `date` text NOT NULL,
  `symbol` text NOT NULL,
  `side` text NOT NULL,
  `qty` real NOT NULL,
  `price` real,
  `price_kind` text NOT NULL,
  `source` text NOT NULL,
  `note` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
