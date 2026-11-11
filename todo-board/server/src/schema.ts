// Drizzle schema for the todo board.
//
// One table: `items`. Each row is one tracked matter maintained by the
// assistant through the addItem / updateItem actions. `status` groups the
// board: needs_decision（待你拍板）/ in_progress（进行中）/ done（已办）/
// cancelled（用户取消，归档，默认不返回）.
// Dates are stored as plain YYYY-MM-DD strings (event dates, no time
// component); completed_at is set when an item moves into done.
//
// User-action fields (written by actOnItem from the page):
//  - options: JSON array of decision choices for a needs_decision item,
//    authored by the assistant when the item is created.
//  - user_decision: JSON { choice, text, decidedAt } once the user picks an
//    option or submits a custom opinion; decidedAt is Beijing "YYYY-MM-DD
//    HH:mm". Its presence on an in_progress item means「已拍板 · 待执行」.
//  - prioritized_at / snoozed_at: Beijing dates the user flagged the item
//    prioritized / snoozed (snooze also clears due_date).
//  - cancelled_at: Beijing date the user cancelled the item.
//  - executed_at / execution_result: the assistant's execution trace for a
//    user decision or priority mark — executed_at is Beijing
//    "YYYY-MM-DD HH:mm" once the matter has actually been carried out,
//    execution_result is a one-line summary of what was done.
//  - cancelled_decision: JSON { choice, text, decidedAt, cancelledAt } —
//    the trace of a decision the user withdrew via「取消拍板」before it was
//    executed; the item returns to needs_decision and the trace renders as
//    a muted「曾拍板…已取消」line on its card.
//
// Board-level state lives in `board_meta` (key/value): currently just
// `execution_requested_at` — the Beijing "YYYY-MM-DD HH:mm" of the user's
// latest「完成，开始执行」dispatch press (null until first pressed). It is
// cleared whenever the pending-execution count returns to zero, so a stale
// dispatch time from a finished batch never leaks into the next one.
//
// `action_log` is an append-only audit trail of page-originated actions
// (actOnItem / requestExecution): one row per call with the Beijing
// timestamp (with seconds), the action, the target item, success/failure
// and a short detail (chosen option or error code). It exists so a tap
// that "did nothing" can be diagnosed after the fact instead of guessed
// at; rows are pruned to the most recent 200.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  status: text("status", {
    enum: ["needs_decision", "in_progress", "done", "cancelled"],
  }).notNull(),
  title: text("title").notNull(),
  note: text("note").notNull().default(""),
  source: text("source").notNull().default(""),
  dueDate: text("due_date"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
  options: text("options").notNull().default("[]"),
  userDecision: text("user_decision"),
  prioritizedAt: text("prioritized_at"),
  snoozedAt: text("snoozed_at"),
  cancelledAt: text("cancelled_at"),
  executedAt: text("executed_at"),
  executionResult: text("execution_result"),
  cancelledDecision: text("cancelled_decision"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const boardMeta = sqliteTable("board_meta", {
  key: text("key").primaryKey(),
  value: text("value"),
});

export const actionLog = sqliteTable("action_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Beijing "YYYY-MM-DD HH:mm:ss" of the call. */
  at: text("at").notNull(),
  /** e.g. "actOnItem:decide", "actOnItem:cancel_decision", "requestExecution". */
  action: text("action").notNull(),
  itemId: integer("item_id"),
  /** 1 = the action was applied, 0 = rejected / not found. */
  ok: integer("ok").notNull(),
  /** Chosen option / custom text, or the error code on failure. */
  detail: text("detail").notNull().default(""),
});
