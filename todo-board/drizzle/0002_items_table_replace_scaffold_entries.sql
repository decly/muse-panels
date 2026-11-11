DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX items_status_idx ON items (status);
