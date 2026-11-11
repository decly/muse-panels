// Drizzle schema for 看板 · 全天动态.
//
// events: agent-appended, verified market events (kept 7 days).
// strip_snapshots: server-fetched quote-strip snapshots (latest few kept).

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const CATEGORIES = [
  "stock",
  "earnings",
  "gold",
  "oil",
  "bonds",
  "usd",
  "macro",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  category: text("category", { enum: CATEGORIES }).notNull(),
  title: text("title").notNull(),
  // Free-form key figures, e.g. "现价 $182.40 ▲+5.2%" — null when not a price event.
  keyNumbers: text("key_numbers"),
  // One-line driver / source note.
  note: text("note").notNull(),
  // Optional one-line impact read, e.g. "利空黄金与成长股、利多美元".
  impact: text("impact"),
  // JSON array of ticker symbols involved, e.g. ["AAPL","MSFT"].
  tickers: text("tickers").notNull().default("[]"),
  // JSON array of per-stock mover rows: [{ ticker, price, changePct }].
  // price is a display string (may carry a session note, e.g. "$185.00 盘前");
  // changePct is the numeric move vs the regular close, e.g. -4.58.
  movers: text("movers").notNull().default("[]"),
  eventTime: integer("event_time", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const stripSnapshots = sqliteTable("strip_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // JSON array of { key, label, price, changePct, asOf }.
  items: text("items").notNull(),
  fetchedAt: integer("fetched_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const upcomingNodes = sqliteTable("upcoming_nodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // Event date, "YYYY-MM-DD" (Beijing calendar day).
  date: text("date").notNull(),
  // Beijing time "HH:MM", null when the event has no fixed time.
  time: text("time"),
  // Event description, e.g. "示例甲 财报（盘后）".
  event: text("event").notNull(),
  // JSON array of holding tickers involved, e.g. ["DEMO"].
  tickers: text("tickers").notNull().default("[]"),
});
