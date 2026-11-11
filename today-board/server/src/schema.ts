// Drizzle schema for the 今日页 (daily today page).
//
// digest_sections: assistant-pushed digest content, one row per section key
// ("overview" | "accounts" | "movers" | "other_assets" | "tech_line"),
// value is a JSON string, updated_at is the push instant.
// events: the assistant-maintained event list (earnings, macro releases,
// ex-dividend dates), date/time_text are Beijing wall-clock strings.
// market_cache: market data this page pulls itself on refresh
// ("gold" | "indices"), payload is a JSON string.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const digestSections = sqliteTable("digest_sections", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  date: text("date").notNull(),
  timeText: text("time_text"),
  title: text("title").notNull(),
  kind: text("kind").notNull().default("其他"),
  note: text("note"),
  sort: integer("sort").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const marketCache = sqliteTable("market_cache", {
  key: text("key").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
});
