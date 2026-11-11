// Drizzle schema for the 事件日历 (event calendar) board.
//
// events: the single source of truth for calendar events (phase 1:
// holdings earnings + macro schedule). All dates/times are Beijing
// wall-clock values: `date` is YYYY-MM-DD, `timeText` is a display label
// such as 盘前 / 盘后 or an HH:MM Beijing time. `tickers` is a JSON array
// string of related holding tickers. Rows are maintained by the assistant
// through the upsertEvent / deleteEvent actions; the board itself never
// fetches external data.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  timeText: text("time_text"),
  kind: text("kind", { enum: ["earnings", "macro"] }).notNull(),
  title: text("title").notNull(),
  tickers: text("tickers").notNull().default("[]"),
  importance: text("importance", { enum: ["key", "normal"] })
    .notNull()
    .default("normal"),
  confirmed: integer("confirmed").notNull().default(1),
  note: text("note"),
  source: text("source"),
  sort: integer("sort").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
